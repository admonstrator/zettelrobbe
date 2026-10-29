'use strict';

/**
 * A real HTTP server that answers like the Claude Messages API.
 *
 * anthropicService talks to the Claude API through the Anthropic SDK, and the
 * SDK is the part a stub could not be trusted to imitate: it parses the
 * server-sent events off a socket, accumulates them into the final message,
 * maps error statuses onto its error classes and aborts the socket when the
 * caller stops caring. So the tests point ANTHROPIC_API_URL at this server
 * on an ephemeral port, and what it answers is a script the test writes:
 *
 *   text and thinking chunks (consecutive chunks of one kind form one content
 *   block, so a thinking block followed by a text block is two entries), a
 *   stop reason (end_turn, max_tokens, refusal) with stop details, the usage
 *   with cache counts, a delay before each chunk so a test can stop a request
 *   in the middle, or an error status with an Anthropic error body.
 *
 * `POST /v1/messages` answers JSON or, for `stream: true`, the SSE event
 * sequence message_start, content_block_start/delta/stop per block,
 * message_delta (stop reason, output tokens), message_stop.
 * `GET /v1/models/:id` knows the models in `models` and answers 404 for any
 * other. With `apiKey` set, a request with any other Bearer key gets 401.
 *
 * Every request is recorded with its body and headers, and every record knows
 * whether the client hung up before the answer was finished.
 *
 * Usage:
 *   const fake = await createFakeAnthropic({ chunks: [{ text: 'hi' }] });
 *   process.env.ANTHROPIC_API_URL = fake.url;
 *   ... await fake.close();
 */

const http = require('http');

/** The models GET /v1/models/:id knows when the test names none. */
const DEFAULT_MODELS = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
];

/**
 * @typedef {object} FakeAnthropicChunk
 * @property {string} [text]      a piece of the answer
 * @property {string} [thinking]  a piece of a thinking block ('' for a block
 *   whose text is omitted, as the API sends it by default)
 * @property {number} [delayMs]   wait this long before sending it
 */

/**
 * @typedef {object} FakeAnthropicScript
 * @property {FakeAnthropicChunk[]} [chunks]
 * @property {'end_turn'|'max_tokens'|'refusal'} [stopReason] default end_turn
 * @property {object|null} [stopDetails]  e.g. { category: 'cyber' }
 * @property {object} [usage]  input_tokens, output_tokens,
 *   cache_read_input_tokens, cache_creation_input_tokens
 * @property {number} [chunkDelayMs]  default delay before every chunk
 * @property {number} [responseDelayMs]  wait this long before answering at
 *   all, headers included, so a client timeout fires
 * @property {number} [status]  answer this status instead, with `error`
 * @property {object} [error]   the error body for a non-200 status
 */

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  500: 'api_error',
};

function errorBody(status, message) {
  return {
    type: 'error',
    error: { type: ERROR_TYPES[status] || 'api_error', message },
  };
}

function normalizeScript(script) {
  const status = Number(script?.status) || 200;
  return {
    chunks: Array.isArray(script?.chunks) ? script.chunks : [],
    stopReason: script?.stopReason || 'end_turn',
    stopDetails: script?.stopDetails ?? null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...(script?.usage || {}),
    },
    chunkDelayMs: Number(script?.chunkDelayMs) || 0,
    responseDelayMs: Number(script?.responseDelayMs) || 0,
    status,
    error: script?.error || errorBody(status, 'fake failure'),
  };
}

/**
 * The script's chunks as content blocks: a change between text and thinking
 * starts a new block.
 *
 * @returns {Array<{type: string, pieces: FakeAnthropicChunk[]}>}
 */
function groupBlocks(chunks) {
  const blocks = [];
  for (const chunk of chunks) {
    const type = typeof chunk?.thinking === 'string' ? 'thinking' : 'text';
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) {
      last.pieces.push(chunk);
    } else {
      blocks.push({ type, pieces: [chunk] });
    }
  }
  return blocks;
}

/** A content block as the non-streaming answer carries it. */
function wholeBlock(block) {
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block.pieces.map((piece) => piece.thinking).join(''),
      signature: 'fake-signature',
    };
  }
  return {
    type: 'text',
    text: block.pieces.map((piece) => piece.text || '').join(''),
  };
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
 * @param {FakeAnthropicScript|FakeAnthropicScript[]} [script] - one script
 *   for every request, or a list answering one request each (the last one
 *   repeats)
 * @param {{models?: string[], apiKey?: string}} [options]
 * @returns {Promise<object>} the handle; close() it in a finally
 */
async function createFakeAnthropic(script = {}, options = {}) {
  let scripts = Array.isArray(script) ? script.slice() : [script];
  let served = 0;
  const models = new Set(options.models || DEFAULT_MODELS);
  let expectedKey = options.apiKey || null;
  const requests = [];
  const sockets = new Set();

  const nextScript = () => {
    const chosen = scripts[Math.min(served, scripts.length - 1)] || {};
    served += 1;
    return normalizeScript(chosen);
  };

  const sendJson = (response, status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  const server = http.createServer(async (request, response) => {
    const path = String(request.url || '').split('?')[0];
    const body = await readBody(request);

    const record = {
      method: request.method,
      path,
      body,
      headers: request.headers,
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

    if (
      expectedKey &&
      request.headers.authorization !== `Bearer ${expectedKey}`
    ) {
      sendJson(response, 401, errorBody(401, 'invalid x-api-key'));
      return;
    }

    const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && modelMatch) {
      const id = decodeURIComponent(modelMatch[1]);
      if (!models.has(id)) {
        sendJson(response, 404, errorBody(404, `model: ${id}`));
        return;
      }
      sendJson(response, 200, {
        type: 'model',
        id,
        display_name: id,
        created_at: '2026-01-01T00:00:00Z',
      });
      return;
    }

    if (request.method !== 'POST' || path !== '/v1/messages') {
      sendJson(response, 404, errorBody(404, `no route ${path}`));
      return;
    }

    const plan = nextScript();
    await sleep(plan.responseDelayMs);
    if (response.destroyed) return;
    if (plan.status !== 200) {
      sendJson(response, plan.status, plan.error);
      return;
    }

    if (body?.stream === true) {
      await writeStream(response, plan, body);
      return;
    }

    sendJson(response, 200, {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: body?.model || 'claude-haiku-5-5',
      content: groupBlocks(plan.chunks).map(wholeBlock),
      stop_reason: plan.stopReason,
      stop_sequence: null,
      stop_details: plan.stopDetails,
      usage: plan.usage,
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  /** Writes the script as the Messages API's server-sent events. */
  async function writeStream(response, plan, body) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (type, payload) => {
      if (response.writableEnded || response.destroyed) return false;
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
      );
      return true;
    };

    const started = send('message_start', {
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: body?.model || 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: plan.usage.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: plan.usage.cache_creation_input_tokens,
          cache_read_input_tokens: plan.usage.cache_read_input_tokens,
        },
      },
    });
    if (!started) return;

    const blocks = groupBlocks(plan.chunks);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const opening =
        block.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' };
      if (!send('content_block_start', { index, content_block: opening })) {
        return;
      }
      for (const piece of block.pieces) {
        const delay = Number.isFinite(Number(piece?.delayMs))
          ? Number(piece.delayMs)
          : plan.chunkDelayMs;
        await sleep(delay);
        let delta;
        if (block.type === 'thinking') {
          if (piece.thinking === '') continue;
          delta = { type: 'thinking_delta', thinking: piece.thinking };
        } else {
          delta = { type: 'text_delta', text: piece.text || '' };
        }
        if (!send('content_block_delta', { index, delta })) return;
      }
      if (block.type === 'thinking') {
        const signature = {
          type: 'signature_delta',
          signature: 'fake-signature',
        };
        if (!send('content_block_delta', { index, delta: signature })) return;
      }
      if (!send('content_block_stop', { index })) return;
    }

    const delta = {
      stop_reason: plan.stopReason,
      stop_sequence: null,
      stop_details: plan.stopDetails,
    };
    if (
      !send('message_delta', {
        delta,
        usage: { output_tokens: plan.usage.output_tokens },
      })
    ) {
      return;
    }
    if (!send('message_stop', {})) return;
    if (!response.writableEnded && !response.destroyed) response.end();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** The request that came in last, or undefined before the first one. */
    last: () => requests[requests.length - 1],
    /** The message requests only, oldest first. */
    messageRequests: () =>
      requests.filter((record) => record.path === '/v1/messages'),
    /** Replaces the script; a list answers one request each. */
    setScript(next) {
      scripts = Array.isArray(next) ? next.slice() : [next];
      served = 0;
    },
    /** Requires this Bearer API key from now on; null accepts any. */
    setApiKey(key) {
      expectedKey = key || null;
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

module.exports = { createFakeAnthropic, DEFAULT_MODELS };
