'use strict';

/**
 * A real HTTP server that answers like an OpenAI-compatible chat endpoint.
 *
 * The provider services stream through the OpenAI SDK, and the SDK does the
 * one thing a hand-written stub cannot be trusted to imitate: it parses
 * server-sent events off a socket, it aborts that socket when the caller
 * stops caring, and it hands the chunks over one at a time. A stub that
 * returns an array pretends all of that away and would keep passing while the
 * real thing breaks. So the tests talk to a server on an ephemeral port, and
 * what that server says is a script the test writes:
 *
 *   content chunks, reasoning_content chunks, a <think> block inside the
 *   content, a finish_reason of stop or length, a usage chunk or none, and a
 *   delay before each chunk so a test can stop a request in the middle of one.
 *
 * The same script answers a non-streaming request as one whole completion, so
 * "the streamed answer is the answer" can be asserted against one fixture.
 *
 * Every request is recorded with its body, so a test can say what `stream`,
 * `stream_options`, `chat_template_kwargs`, `max_tokens` and the messages
 * were, and every record knows whether the client hung up before the answer
 * was finished.
 *
 * Usage:
 *   const fake = await createFakeOpenAI({ chunks: [{ content: 'hi' }] });
 *   service.client = new OpenAI({ apiKey: 'test', baseURL: fake.baseURL });
 *   ... await fake.close();
 */

const http = require('http');

/** The model name the fake reports when a script names none. */
const DEFAULT_MODEL = 'fake-model';

/**
 * @typedef {object} FakeOpenAIChunk
 * @property {string} [content]    a piece of the answer
 * @property {string} [reasoning]  a piece the API delivers as reasoning_content
 * @property {number} [delayMs]    wait this long before sending it
 */

/**
 * @typedef {object} FakeOpenAIScript
 * @property {FakeOpenAIChunk[]} [chunks]
 * @property {'stop'|'length'} [finishReason]  default 'stop'
 * @property {object|null} [usage]   the usage chunk, or null for none
 * @property {number} [chunkDelayMs] default delay before every chunk
 * @property {string} [model]
 * @property {number} [status]       answer this status instead, with `error`
 * @property {object} [error]        the error body for a non-200 status
 */

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function normalizeScript(script) {
  return {
    chunks: Array.isArray(script?.chunks) ? script.chunks : [],
    finishReason: script?.finishReason || 'stop',
    usage: script?.usage === undefined ? null : script.usage,
    chunkDelayMs: Number(script?.chunkDelayMs) || 0,
    model: script?.model || DEFAULT_MODEL,
    status: Number(script?.status) || 200,
    error: script?.error || { error: { message: 'fake failure' } },
  };
}

/** The whole answer a script describes, as content and reasoning. */
function assemble(script) {
  let content = '';
  let reasoning = '';
  for (const chunk of script.chunks) {
    if (typeof chunk?.content === 'string') content += chunk.content;
    if (typeof chunk?.reasoning === 'string') reasoning += chunk.reasoning;
  }
  return { content, reasoning };
}

function readBody(request) {
  return new Promise((resolve) => {
    const pieces = [];
    request.on('data', (piece) => pieces.push(piece));
    request.on('end', () => {
      const raw = Buffer.concat(pieces).toString('utf8');
      try {
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        resolve({ unparsable: raw });
      }
    });
  });
}

/**
 * Starts the fake and listens on an ephemeral port.
 *
 * @param {FakeOpenAIScript|FakeOpenAIScript[]} [script] - one script for every
 *   request, or a list answering one request each (the last one repeats)
 * @returns {Promise<object>} the handle; close() it in a finally
 */
async function createFakeOpenAI(script = {}) {
  let scripts = Array.isArray(script) ? script.slice() : [script];
  let served = 0;
  const requests = [];
  const sockets = new Set();

  const nextScript = () => {
    const chosen = scripts[Math.min(served, scripts.length - 1)] || {};
    served += 1;
    return normalizeScript(chosen);
  };

  const server = http.createServer(async (request, response) => {
    const path = String(request.url || '').split('?')[0];
    const body = await readBody(request);

    const record = {
      method: request.method,
      path,
      body,
      /** The client hung up before the answer was finished. */
      aborted: false,
      /** Resolves when the connection is gone, either way. */
      whenClosed: null,
    };
    record.whenClosed = new Promise((resolve) => {
      response.on('close', () => {
        record.aborted = !response.writableFinished;
        resolve(record);
      });
    });
    requests.push(record);

    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: DEFAULT_MODEL, object: 'model' }],
        })
      );
      return;
    }

    if (!path.endsWith('/chat/completions')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no route ${path}` } }));
      return;
    }

    const plan = nextScript();
    if (plan.status !== 200) {
      response.writeHead(plan.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(plan.error));
      return;
    }

    if (body?.stream === true) {
      await writeStream(response, plan);
      return;
    }

    const { content, reasoning } = assemble(plan);
    const message = { role: 'assistant', content };
    if (reasoning !== '') message.reasoning_content = reasoning;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'fake-completion',
        object: 'chat.completion',
        created: 1,
        model: plan.model,
        choices: [{ index: 0, message, finish_reason: plan.finishReason }],
        usage: plan.usage || undefined,
      })
    );
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  /** Writes the script as server-sent events, one chunk per event. */
  async function writeStream(response, plan) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (payload) => {
      if (response.writableEnded || response.destroyed) return false;
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    };

    const frame = (delta, finishReason = null) => ({
      id: 'fake-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: plan.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    if (!send(frame({ role: 'assistant' }))) return;

    for (const chunk of plan.chunks) {
      const delay = Number.isFinite(Number(chunk?.delayMs))
        ? Number(chunk.delayMs)
        : plan.chunkDelayMs;
      await sleep(delay);
      const delta = {};
      if (typeof chunk?.content === 'string') delta.content = chunk.content;
      if (typeof chunk?.reasoning === 'string') {
        delta.reasoning_content = chunk.reasoning;
      }
      if (!send(frame(delta))) return;
    }

    if (!send(frame({}, plan.finishReason))) return;

    if (plan.usage) {
      const usageChunk = frame({}, null);
      usageChunk.choices = [];
      usageChunk.usage = plan.usage;
      if (!send(usageChunk)) return;
    }

    if (response.writableEnded || response.destroyed) return;
    response.write('data: [DONE]\n\n');
    response.end();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    /** The request that came in last, or undefined before the first one. */
    last: () => requests[requests.length - 1],
    /** Replaces the script; a list answers one request each. */
    setScript(next) {
      scripts = Array.isArray(next) ? next.slice() : [next];
      served = 0;
    },
    /** Forgets every recorded request. */
    reset() {
      requests.length = 0;
      served = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeOpenAI, DEFAULT_MODEL };
