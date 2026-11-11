'use strict';

/**
 * Claude as an OCR provider (OCR_PROVIDER=anthropic).
 *
 * The requests go through the real Anthropic SDK to a real HTTP server on an
 * ephemeral port that answers like the Messages API, streamed answers
 * included. The SDK parses the server-sent events, assembles the final
 * message and aborts the socket on a timeout; a stub that hands back a
 * finished object would pretend all of that away. The configuration is the
 * real config module, loaded from environment variables the way the app
 * loads it, so the MISTRAL_API_KEY fallback inside config.mistralOcr is the
 * real one too.
 *
 * Covers:
 *  1. provider selection: anthropic picks Claude and says "Claude OCR";
 *     ollama/custom stay local, everything else stays Mistral
 *  2. key: OCR_API_KEY first, then ANTHROPIC_API_KEY; a MISTRAL_API_KEY never
 *     reaches the Claude API; no key fails before any request
 *  3. model: the Mistral default is replaced by ANTHROPIC_MODEL, a Claude
 *     model in MISTRAL_OCR_MODEL is kept; URL: OCR_API_URL, else
 *     ANTHROPIC_API_URL
 *  4. PDF request: one streamed request, document block before the
 *     instruction, base64 application/pdf, max_tokens 64000, no sampling
 *     parameters, thinking off the way Claude Haiku 5.5 takes it
 *  5. PNG request: image block, image/png; thinking off for Sonnet 5.5 and
 *     Opus 5.5 as each accepts it
 *  6. the answer is read past a leading thinking block; "[no text]" is empty
 *  7. a cut-off answer fails the queue item: no write-back, queue 'failed',
 *     failure recorded as ocr_failed
 *  8. a refusal takes the same path
 *  9. a transcript that completes is written back as before
 * 10. TIFF, an image over 10 MB and a PDF over 32 MB without poppler fail
 *     with the limit named and no request sent
 * 11. a PDF over 32 MB with poppler is sent as rendered page images
 * 12. runAnthropicOcr uses its arguments, not the configuration
 * 13. an API error becomes one readable line
 * 14. a request that stops making progress ends as an OCR timeout
 * 15. ANTHROPIC_MAX_TOKENS above 64000 raises the OCR cap, up to 128000
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { anthropicThinkingParams } = require('../services/anthropicSupport');

const configModulePath = require.resolve('../config/config');
const ocrServiceModulePath = require.resolve('../services/mistralOcrService');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const popplerServiceModulePath = require.resolve('../services/popplerService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const documentProcessingServiceModulePath =
  require.resolve('../services/documentProcessingService');

const PDF_BASE64 = Buffer.from('%PDF-1.7 a scanned invoice').toString('base64');
// A 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PAGE_ONE_BASE64 = Buffer.from('rendered page one').toString('base64');
const PAGE_TWO_BASE64 = Buffer.from('rendered page two').toString('base64');

/** Every variable a case may set; each case starts from none of them. */
const MANAGED_ENV = [
  'OCR_PROVIDER',
  'MISTRAL_OCR_PROVIDER',
  'OCR_API_KEY',
  'MISTRAL_API_KEY',
  'OCR_API_URL',
  'MISTRAL_OCR_API_URL',
  'MISTRAL_OCR_MODEL',
  'MISTRAL_OCR_ENABLED',
  'OCR_PDF_RENDER_ENABLED',
  'OCR_PDF_RENDER_MAX_PAGES',
  'OCR_PDF_RENDER_DPI',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MAX_TOKENS',
  'OLLAMA_API_KEY',
  'SETUP_OCR_VALIDATION_TIMEOUT_MS',
  'SETUP_VALIDATION_TIMEOUT_MS',
];

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── A fake Messages API ──────────────────────────────────────────────────────

/**
 * @typedef {object} FakeClaudeScript
 * @property {Array<{type: 'text'|'thinking', text?: string}>} [blocks]
 * @property {string} [stopReason]   default 'end_turn'
 * @property {object} [stopDetails]  message_delta's stop_details
 * @property {number} [status]       answer this status with `error` instead
 * @property {object} [error]        the `error` object of the error body
 * @property {number} [headerDelayMs] wait before answering at all
 * @property {boolean} [stallAfterStart] send message_start, then nothing
 * @property {number} [eventDelayMs] wait this long before every later event
 */

function readJson(request) {
  return new Promise((resolve) => {
    const pieces = [];
    request.on('data', (piece) => pieces.push(piece));
    request.on('end', () => {
      const raw = Buffer.concat(pieces).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ unparsable: raw });
      }
    });
  });
}

/**
 * Starts the fake. `script` is one FakeClaudeScript or a function from the
 * request body to one, so a test can answer each page differently.
 */
async function createFakeClaude() {
  const requests = [];
  const sockets = new Set();
  let script = {};

  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({
      method: request.method,
      path: String(request.url || '').split('?')[0],
      headers: request.headers,
      body,
    });

    const current = typeof script === 'function' ? script(body) : script;
    if (current.headerDelayMs) await sleep(current.headerDelayMs);
    if (response.destroyed || response.writableEnded) return;

    if (current.status && current.status !== 200) {
      response.writeHead(current.status, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ type: 'error', error: current.error }));
      return;
    }

    const blocks = current.blocks || [{ type: 'text', text: 'transcript' }];
    const send = async (event, data) => {
      if (current.eventDelayMs && event !== 'message_start') {
        await sleep(current.eventDelayMs);
      }
      if (!response.destroyed) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    await send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 1 },
      },
    });
    if (current.stallAfterStart) return;

    for (const [index, block] of blocks.entries()) {
      if (block.type === 'thinking') {
        await send('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        await send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: 'sig-fake' },
        });
      } else {
        await send('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        await send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      }
      await send('content_block_stop', { type: 'content_block_stop', index });
    }
    await send('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: current.stopReason || 'end_turn',
        stop_sequence: null,
        ...(current.stopDetails ? { stop_details: current.stopDetails } : {}),
      },
      usage: { output_tokens: current.outputTokens || 42 },
    });
    await send('message_stop', { type: 'message_stop' });
    response.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests,
    script(next) {
      script = next;
    },
    reset() {
      requests.length = 0;
      script = {};
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── Loading the service with a given environment ─────────────────────────────

function injectModule(modulePath, exportsObject) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObject,
  };
}

/**
 * Loads config and mistralOcrService fresh for `env`. Paperless-ngx, the
 * database, poppler and the AI services are replaced; the Claude path, the
 * SDK and the configuration are real.
 */
function loadOcr(env = {}) {
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, env);

  delete require.cache[configModulePath];
  delete require.cache[ocrServiceModulePath];

  const state = {
    patchCalls: [],
    queueStatuses: [],
    failedRecords: [],
    removedFromQueue: [],
    progress: [],
    renderCalls: [],
    popplerAvailable: true,
    rendered: null,
  };

  injectModule(paperlessServiceModulePath, {
    initialize() {},
    client: {
      patch: async (url, payload) => {
        state.patchCalls.push({ url, payload });
        return { status: 200 };
      },
      get: async () => {
        throw new Error('network disabled in this test');
      },
    },
  });
  injectModule(documentModelModulePath, {
    getOcrQueueItem: async () => ({ document_id: 77, title: 'Scan 77' }),
    updateOcrQueueStatus: async (documentId, status, text, wroteBack) => {
      state.queueStatuses.push({ documentId, status, text, wroteBack });
      return true;
    },
    addFailedDocument: async (documentId, title, reason, source) => {
      state.failedRecords.push({ documentId, title, reason, source });
      return true;
    },
    resetFailedDocument: async () => true,
    removeFromOcrQueue: async (documentId) => {
      state.removedFromQueue.push(documentId);
      return true;
    },
  });
  injectModule(aiServiceFactoryModulePath, {
    getService: () => ({
      analyzeDocument: async () => {
        throw new Error('AI analysis must not run in this test');
      },
    }),
  });
  injectModule(documentProcessingServiceModulePath, {});
  injectModule(popplerServiceModulePath, {
    isAvailable: async () => state.popplerAvailable,
    renderPdfToImages: async (buffer, options) => {
      state.renderCalls.push({ bytes: buffer.length, options });
      return state.rendered;
    },
  });

  const config = require('../config/config');
  const service = require('../services/mistralOcrService');
  return { config, service, state };
}

/** The env for a configured Claude OCR pointed at the fake. */
function claudeEnv(fake, extra = {}) {
  return {
    MISTRAL_OCR_ENABLED: 'yes',
    OCR_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-ai',
    ANTHROPIC_API_URL: fake.baseURL,
    ...extra,
  };
}

async function rejection(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** Runs processQueueItem for document 77 and returns what happened. */
async function runQueueItem(service, state, download) {
  service.downloadDocumentAsBase64 = async () => download;
  let thrown = null;
  let result = null;
  try {
    result = await service.processQueueItem(77, {
      autoAnalyze: false,
      progressCallback: (step, message) =>
        state.progress.push({ step, message }),
    });
  } catch (error) {
    thrown = error;
  }
  return { thrown, result };
}

function assertFailedWithoutWriteBack(state, thrown, label) {
  assert.ok(thrown, `${label}: processQueueItem must fail`);
  assert.match(
    thrown.message,
    /^Claude OCR failed: /,
    `${label}: the error names the provider`
  );
  assert.strictEqual(
    state.patchCalls.length,
    0,
    `${label}: nothing may be written to Paperless-ngx`
  );
  assert.ok(
    state.queueStatuses.some((entry) => entry.status === 'failed'),
    `${label}: the queue item must end up 'failed'`
  );
  assert.ok(
    !state.queueStatuses.some((entry) => entry.status === 'done'),
    `${label}: the queue item must never be 'done'`
  );
  assert.deepStrictEqual(
    state.failedRecords.map((entry) => [entry.reason, entry.source]),
    [['ocr_failed', 'ocr']],
    `${label}: recorded as an OCR failure`
  );
}

// ── The cases ────────────────────────────────────────────────────────────────

async function main() {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-claude-ocr-'));
  // Config reads data/.env and data/runtime-overrides.json from the working
  // directory; an empty one keeps a developer's own settings out of the test.
  process.chdir(tempRoot);
  process.env.LOG_LEVEL = 'error';

  const fake = await createFakeClaude();
  const elsewhere = await createFakeClaude();

  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  const warnings = [];
  // The service logs token usage and timeouts; keep the output to results.
  const quiet = () => {
    console.log = (...args) => {
      if (/^(✅|❌)/.test(String(args[0]))) realLog(...args);
    };
    console.warn = (...args) => warnings.push(args.join(' '));
    console.error = (...args) => {
      if (/^ {4}|^❌/.test(String(args[0]))) realError(...args);
    };
  };
  quiet();

  const run = async (name, fn) => {
    fake.reset();
    elsewhere.reset();
    warnings.length = 0;
    await test(name, fn);
  };

  try {
    await run('1. OCR_PROVIDER=anthropic selects Claude OCR', async () => {
      const cases = [
        ['anthropic', 'anthropic', 'Claude OCR'],
        [' Anthropic ', 'anthropic', 'Claude OCR'],
        ['ollama', 'ollama', 'Local OCR'],
        ['custom', 'ollama', 'Local OCR'],
        ['mistral', 'mistral', 'Mistral OCR'],
        ['', 'mistral', 'Mistral OCR'],
        ['claude-but-not-really', 'mistral', 'Mistral OCR'],
      ];
      for (const [value, provider, label] of cases) {
        const { service } = loadOcr({ OCR_PROVIDER: value });
        assert.strictEqual(service.provider, provider, `OCR_PROVIDER=${value}`);
        assert.strictEqual(service.providerLabel, label, `label for ${value}`);
      }
    });

    await run('2a. OCR_API_KEY wins over ANTHROPIC_API_KEY', async () => {
      const { service } = loadOcr(
        claudeEnv(fake, {
          OCR_API_KEY: 'sk-ant-ocr',
          MISTRAL_API_KEY: 'mistral-key',
        })
      );
      await service.performOcr(PDF_BASE64, 'application/pdf', 77);
      assert.strictEqual(fake.requests.length, 1);
      assert.strictEqual(
        fake.requests[0].headers.authorization,
        'Bearer sk-ant-ocr'
      );
    });

    await run(
      '2b. without OCR_API_KEY the Anthropic key is used, never the Mistral key',
      async () => {
        const { service, config } = loadOcr(
          claudeEnv(fake, { MISTRAL_API_KEY: 'mistral-key' })
        );
        assert.strictEqual(
          config.mistralOcr.apiKey,
          'mistral-key',
          'precondition: config.mistralOcr.apiKey falls back to MISTRAL_API_KEY'
        );
        await service.performOcr(PDF_BASE64, 'application/pdf', 77);
        assert.strictEqual(
          fake.requests[0].headers.authorization,
          'Bearer sk-ant-ai'
        );
      }
    );

    await run('2c. no Claude key fails before any request', async () => {
      const { service } = loadOcr({
        MISTRAL_OCR_ENABLED: 'yes',
        OCR_PROVIDER: 'anthropic',
        ANTHROPIC_API_URL: fake.baseURL,
        MISTRAL_API_KEY: 'mistral-key',
      });
      const error = await rejection(() =>
        service.performOcr(PDF_BASE64, 'application/pdf', 77)
      );
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.match(error.message, /OCR_API_KEY/);
      assert.strictEqual(fake.requests.length, 0, 'no request may be sent');
    });

    await run(
      '3a. the Mistral default model is replaced by ANTHROPIC_MODEL',
      async () => {
        const { service, config } = loadOcr(
          claudeEnv(fake, { ANTHROPIC_MODEL: 'claude-sonnet-5-5' })
        );
        assert.strictEqual(config.mistralOcr.model, 'mistral-ocr-latest');
        assert.strictEqual(service.model, 'claude-sonnet-5-5');
        await service.performOcr(PDF_BASE64, 'application/pdf', 77);
        assert.strictEqual(fake.requests[0].body.model, 'claude-sonnet-5-5');

        const unset = loadOcr(claudeEnv(fake)).service;
        assert.strictEqual(unset.model, 'claude-haiku-5-5', 'default model');

        const local = loadOcr(
          claudeEnv(fake, { MISTRAL_OCR_MODEL: 'gemma3:12b' })
        ).service;
        assert.strictEqual(local.model, 'claude-haiku-5-5', 'a local model');
      }
    );

    await run('3b. a Claude model in MISTRAL_OCR_MODEL is kept', async () => {
      const { service } = loadOcr(
        claudeEnv(fake, {
          MISTRAL_OCR_MODEL: 'claude-opus-5-5',
          ANTHROPIC_MODEL: 'claude-haiku-5-5',
        })
      );
      assert.strictEqual(service.model, 'claude-opus-5-5');
      const proxied = loadOcr(
        claudeEnv(fake, { MISTRAL_OCR_MODEL: 'anthropic.claude-haiku-5-5' })
      ).service;
      assert.strictEqual(proxied.model, 'anthropic.claude-haiku-5-5');
    });

    await run('3c. OCR_API_URL when set, else ANTHROPIC_API_URL', async () => {
      const own = loadOcr(
        claudeEnv(elsewhere, { OCR_API_URL: `${fake.baseURL}/` })
      ).service;
      await own.performOcr(PDF_BASE64, 'application/pdf', 77);
      assert.strictEqual(fake.requests.length, 1, 'OCR_API_URL is used');
      assert.strictEqual(elsewhere.requests.length, 0);

      const shared = loadOcr(claudeEnv(fake)).service;
      assert.strictEqual(shared.apiBase, fake.baseURL);
    });

    await run(
      '4. a PDF goes out as one document block, streamed, without sampling parameters',
      async () => {
        const { service } = loadOcr(claudeEnv(fake));
        await service.performOcr(PDF_BASE64, 'application/pdf', 77);

        assert.strictEqual(fake.requests.length, 1, 'exactly one request');
        const [{ method, path: requestPath, body }] = fake.requests;
        assert.strictEqual(method, 'POST');
        assert.strictEqual(requestPath, '/v1/messages');
        assert.strictEqual(body.stream, true, 'the transcript is streamed');
        assert.strictEqual(body.model, 'claude-haiku-5-5');
        assert.strictEqual(body.max_tokens, 64000);
        for (const field of ['temperature', 'top_p', 'top_k']) {
          assert.ok(!(field in body), `${field} must not be sent`);
        }
        assert.deepStrictEqual(body.thinking, { type: 'disabled' });
        assert.deepStrictEqual(body.output_config, { effort: 'low' });

        assert.strictEqual(body.messages.length, 1);
        assert.strictEqual(body.messages[0].role, 'user');
        const [documentBlock, instruction, ...rest] = body.messages[0].content;
        assert.deepStrictEqual(documentBlock, {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: PDF_BASE64,
          },
        });
        assert.strictEqual(instruction.type, 'text', 'the instruction follows');
        assert.match(instruction.text, /reading order/);
        assert.match(instruction.text, /Markdown tables/);
        assert.match(instruction.text, /Do not translate/);
        assert.match(instruction.text, /summarize/);
        assert.match(instruction.text, /\[illegible\]/);
        assert.deepStrictEqual(rest, []);
      }
    );

    await run(
      '5. an image goes out as an image block; thinking off per model',
      async () => {
        const expectations = {
          'claude-haiku-5-5': {
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
          },
          'claude-sonnet-5-5': {
            thinking: { type: 'between_tools' },
            output_config: { effort: 'low' },
          },
          'claude-opus-5-5': { output_config: { effort: 'low' } },
        };

        for (const [model, expected] of Object.entries(expectations)) {
          fake.reset();
          const { service } = loadOcr(
            claudeEnv(fake, { ANTHROPIC_MODEL: model })
          );
          await service.performOcr(PNG_BASE64, 'image/png', 77);

          const { body } = fake.requests[0];
          assert.deepStrictEqual(
            body.messages[0].content[0],
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: PNG_BASE64,
              },
            },
            `${model}: image block`
          );
          assert.deepStrictEqual(
            { thinking: body.thinking, output_config: body.output_config },
            { thinking: undefined, ...expected },
            `${model}: thinking fields`
          );
          assert.deepStrictEqual(
            expected,
            anthropicThinkingParams(model, { reasoning: false }),
            `${model}: the request uses the shared helper`
          );
          assert.ok(!('temperature' in body), `${model}: no temperature`);
        }

        fake.reset();
        const jpeg = loadOcr(claudeEnv(fake)).service;
        await jpeg.performOcr(PNG_BASE64, 'image/jpg; charset=binary', 77);
        assert.strictEqual(
          fake.requests[0].body.messages[0].content[0].source.media_type,
          'image/jpeg',
          'parameters dropped, image/jpg spelled the way the API knows it'
        );
      }
    );

    await run(
      '6. the answer is read past a leading thinking block',
      async () => {
        const { service } = loadOcr(claudeEnv(fake));
        fake.script({
          blocks: [
            { type: 'thinking' },
            { type: 'text', text: 'Invoice 42\n\n| Item | Total |' },
          ],
        });
        const text = await service.performOcr(
          PDF_BASE64,
          'application/pdf',
          77
        );
        assert.strictEqual(text, 'Invoice 42\n\n| Item | Total |');

        fake.script({ blocks: [{ type: 'text', text: '[no text]' }] });
        assert.strictEqual(
          await service.performOcr(PNG_BASE64, 'image/png', 77),
          '',
          'a page without text is empty, not a sentence about it'
        );
      }
    );

    await run(
      '7. a cut-off transcript fails the OCR run and writes nothing back',
      async () => {
        const { service, state } = loadOcr(claudeEnv(fake));
        fake.script({
          blocks: [{ type: 'text', text: 'Page 1 of 300 …' }],
          stopReason: 'max_tokens',
          outputTokens: 64000,
        });

        const direct = await rejection(() =>
          service.performOcr(PDF_BASE64, 'application/pdf', 77)
        );
        assert.strictEqual(direct.code, 'ai_response_truncated');
        assert.match(direct.message, /64000 tokens/);
        assert.match(direct.message, /ANTHROPIC_MAX_TOKENS/);

        const { thrown } = await runQueueItem(service, state, {
          base64: PDF_BASE64,
          mimeType: 'application/pdf',
        });
        assertFailedWithoutWriteBack(state, thrown, 'max_tokens');
        assert.ok(
          state.progress.some(
            (entry) => entry.message === 'Sending document to Claude OCR…'
          ),
          'the progress names Claude OCR'
        );
      }
    );

    await run('8. a refusal fails the OCR run the same way', async () => {
      const { service, state } = loadOcr(claudeEnv(fake));
      fake.script({
        blocks: [],
        stopReason: 'refusal',
        stopDetails: { category: 'general_harms', explanation: null },
      });

      const direct = await rejection(() =>
        service.performOcr(PDF_BASE64, 'application/pdf', 77)
      );
      assert.strictEqual(direct.code, 'ai_refused');
      assert.match(direct.message, /general_harms/);

      const { thrown } = await runQueueItem(service, state, {
        base64: PDF_BASE64,
        mimeType: 'application/pdf',
      });
      assertFailedWithoutWriteBack(state, thrown, 'refusal');
    });

    await run(
      '9. a completed transcript is written back as before',
      async () => {
        const { service, state } = loadOcr(claudeEnv(fake));
        fake.script({
          blocks: [{ type: 'text', text: 'Invoice total 42.00 EUR' }],
        });

        const { thrown, result } = await runQueueItem(service, state, {
          base64: PDF_BASE64,
          mimeType: 'application/pdf',
        });
        assert.strictEqual(thrown, null);
        assert.strictEqual(result.ocrText, 'Invoice total 42.00 EUR');
        assert.strictEqual(state.patchCalls.length, 1);
        assert.strictEqual(
          state.patchCalls[0].payload.content,
          'Invoice total 42.00 EUR'
        );
        assert.ok(state.queueStatuses.some((entry) => entry.status === 'done'));
      }
    );

    await run(
      '10. unsupported types and oversized input fail with the limit named, unsent',
      async () => {
        const { service, state } = loadOcr(
          claudeEnv(fake, { OCR_PDF_RENDER_ENABLED: 'no' })
        );

        const tiff = await rejection(() =>
          service.performOcr(PNG_BASE64, 'image/tiff', 77)
        );
        assert.strictEqual(tiff.code, 'claude_ocr_unsupported_type');
        assert.match(tiff.message, /image\/tiff/);
        assert.match(tiff.message, /PDF, PNG, JPEG, GIF and WebP/);

        const docx = await rejection(() =>
          service.performOcr(
            PDF_BASE64,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            77
          )
        );
        assert.strictEqual(docx.code, 'claude_ocr_unsupported_type');

        const bigImage = await rejection(() =>
          service.performOcr('A'.repeat(10 * 1000 * 1000 + 4), 'image/png', 77)
        );
        assert.strictEqual(bigImage.code, 'claude_ocr_too_large');
        assert.match(bigImage.message, /at most 10\.0 MB per image/);

        const bigPdf = 'A'.repeat(32 * 1000 * 1000);
        const noRender = await rejection(() =>
          service.performOcr(bigPdf, 'application/pdf', 77)
        );
        assert.strictEqual(noRender.code, 'claude_ocr_too_large');
        assert.match(noRender.message, /at most 32\.0 MB per request/);
        assert.match(noRender.message, /OCR_PDF_RENDER_ENABLED/);

        const noPoppler = loadOcr(claudeEnv(fake));
        noPoppler.state.popplerAvailable = false;
        const missing = await rejection(() =>
          noPoppler.service.performOcr(bigPdf, 'application/pdf', 77)
        );
        assert.match(missing.message, /poppler-utils/);

        // The explicit entry point checks the same limit for the setup wizard.
        const direct = await rejection(() =>
          service.runAnthropicOcr({
            apiKey: 'sk-ant-explicit',
            apiUrl: fake.baseURL,
            model: 'claude-haiku-5-5',
            base64: bigPdf,
            mimeType: 'application/pdf',
          })
        );
        assert.strictEqual(direct.code, 'claude_ocr_too_large');

        assert.strictEqual(fake.requests.length, 0, 'no request may be sent');
        assert.strictEqual(state.renderCalls.length, 0);

        const { thrown } = await runQueueItem(service, state, {
          base64: PNG_BASE64,
          mimeType: 'image/tiff',
        });
        assertFailedWithoutWriteBack(state, thrown, 'tiff');
      }
    );

    await run(
      '11. a PDF over 32 MB is sent as rendered page images when poppler is there',
      async () => {
        const { service, state } = loadOcr(
          claudeEnv(fake, {
            OCR_PDF_RENDER_MAX_PAGES: '7',
            OCR_PDF_RENDER_DPI: '200',
          })
        );
        state.rendered = {
          pages: [
            { base64: PAGE_ONE_BASE64, mimeType: 'image/png', pageNumber: 1 },
            { base64: PAGE_TWO_BASE64, mimeType: 'image/png', pageNumber: 2 },
          ],
          totalPages: 2,
          truncated: false,
        };
        fake.script((body) => ({
          blocks: [
            {
              type: 'text',
              text:
                body.messages[0].content[0].source.data === PAGE_ONE_BASE64
                  ? 'Page one text'
                  : 'Page two text',
            },
          ],
        }));

        const progress = [];
        const text = await service.performOcr(
          'A'.repeat(32 * 1000 * 1000),
          'application/pdf',
          77,
          { onPageProgress: (page, count) => progress.push(`${page}/${count}`) }
        );

        assert.strictEqual(text, 'Page one text\n\nPage two text');
        assert.deepStrictEqual(state.renderCalls[0].options, {
          maxPages: 7,
          dpi: 200,
        });
        assert.deepStrictEqual(progress, ['1/2', '2/2']);
        assert.strictEqual(fake.requests.length, 2, 'one request per page');
        for (const request of fake.requests) {
          const block = request.body.messages[0].content[0];
          assert.strictEqual(block.type, 'image');
          assert.strictEqual(block.source.media_type, 'image/png');
        }
        assert.ok(
          warnings.some((line) => /32\.0 MB per request/.test(line)),
          'the switch to page images is logged with the limit'
        );
      }
    );

    await run(
      '12. runAnthropicOcr uses its arguments, not the configuration',
      async () => {
        const { service } = loadOcr({
          MISTRAL_OCR_ENABLED: 'yes',
          OCR_PROVIDER: 'mistral',
          MISTRAL_API_KEY: 'mistral-key',
          OCR_API_KEY: 'configured-ocr-key',
          ANTHROPIC_API_KEY: 'sk-ant-configured',
          ANTHROPIC_API_URL: elsewhere.baseURL,
          OCR_API_URL: elsewhere.baseURL,
          ANTHROPIC_MODEL: 'claude-sonnet-5-5',
          MISTRAL_OCR_MODEL: 'mistral-ocr-latest',
        });
        fake.script({ blocks: [{ type: 'text', text: 'OCR-TEST-1234' }] });

        const text = await service.runAnthropicOcr({
          apiKey: 'sk-ant-explicit',
          apiUrl: fake.baseURL,
          model: 'claude-opus-5-5',
          base64: `data:image/png;base64,${PNG_BASE64}`,
          timeoutMs: 5000,
        });

        assert.strictEqual(text, 'OCR-TEST-1234');
        assert.strictEqual(
          elsewhere.requests.length,
          0,
          'configured URL unused'
        );
        assert.strictEqual(fake.requests.length, 1);
        const [{ headers, body }] = fake.requests;
        assert.strictEqual(headers.authorization, 'Bearer sk-ant-explicit');
        assert.strictEqual(body.model, 'claude-opus-5-5');
        assert.strictEqual(body.max_tokens, 64000);
        assert.deepStrictEqual(body.messages[0].content[0].source, {
          type: 'base64',
          media_type: 'image/png',
          data: PNG_BASE64,
        });

        const noKey = await rejection(() =>
          service.runAnthropicOcr({
            apiKey: '',
            apiUrl: fake.baseURL,
            model: 'claude-haiku-5-5',
            base64: PNG_BASE64,
            mimeType: 'image/png',
          })
        );
        assert.match(noKey.message, /needs an API key/);
        assert.strictEqual(
          fake.requests.length,
          1,
          'no configured key stands in'
        );
      }
    );

    await run('13. an API error becomes one readable line', async () => {
      const { service } = loadOcr(claudeEnv(fake));
      fake.script({
        status: 401,
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
      const error = await rejection(() =>
        service.performOcr(PDF_BASE64, 'application/pdf', 77)
      );
      assert.strictEqual(
        error.message,
        'Claude API answered HTTP 401 (authentication_error): invalid x-api-key'
      );
      assert.strictEqual(error.cause?.status, 401, 'the SDK error is kept');
    });

    await run(
      '14. a request without progress ends as an OCR timeout',
      async () => {
        const { service } = loadOcr(claudeEnv(fake));
        const { isTimeoutError } = require('../services/serviceUtils');
        const request = {
          apiKey: 'sk-ant-explicit',
          apiUrl: fake.baseURL,
          model: 'claude-haiku-5-5',
          base64: PNG_BASE64,
          mimeType: 'image/png',
          timeoutMs: 300,
        };

        fake.script({ stallAfterStart: true });
        let started = Date.now();
        const stalled = await rejection(() => service.runAnthropicOcr(request));
        assert.ok(isTimeoutError(stalled), stalled.message);
        assert.match(
          stalled.message,
          /^OCR response timeout reached after 300ms/
        );
        assert.ok(Date.now() - started < 5000, 'the stall is cut short');

        fake.script({ headerDelayMs: 3000 });
        started = Date.now();
        const silent = await rejection(() => service.runAnthropicOcr(request));
        assert.ok(isTimeoutError(silent), silent.message);
        assert.ok(Date.now() - started < 2500, 'retries do not outlast it');

        // A long transcript that keeps arriving is not a stall: 18 events at
        // 100 ms each take six times the timeout and must still complete.
        fake.script({
          eventDelayMs: 100,
          blocks: ['one ', 'two ', 'three ', 'four ', 'five ', 'six'].map(
            (text) => ({ type: 'text', text })
          ),
        });
        started = Date.now();
        const text = await service.runAnthropicOcr(request);
        assert.strictEqual(text, 'one two three four five six');
        assert.ok(Date.now() - started > 1000, 'the stream took its time');
      }
    );

    await run(
      '15. ANTHROPIC_MAX_TOKENS above 64000 raises the OCR cap, up to 128000',
      async () => {
        const cases = [
          ['', 64000],
          ['16000', 64000],
          ['100000', 100000],
          ['500000', 128000],
        ];
        for (const [configured, expected] of cases) {
          fake.reset();
          const { service } = loadOcr(
            claudeEnv(fake, { ANTHROPIC_MAX_TOKENS: configured })
          );
          await service.performOcr(PDF_BASE64, 'application/pdf', 77);
          assert.strictEqual(
            fake.requests[0].body.max_tokens,
            expected,
            `ANTHROPIC_MAX_TOKENS=${configured}`
          );
        }
      }
    );
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
    await fake.close();
    await elsewhere.close();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌  ocr-provider-anthropic test crashed');
  console.error(error);
  process.exit(1);
});
