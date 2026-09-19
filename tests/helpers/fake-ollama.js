'use strict';

/**
 * A real HTTP server that answers like Ollama's /api/generate.
 *
 * Ollama does not speak server-sent events: a streamed answer is a sequence of
 * complete JSON objects separated by newlines, and the client has to hold the
 * tail of a socket read until its newline turns up. That splitting is exactly
 * the part worth testing, so the fake writes the lines to a socket — and, when
 * a test asks for it, splits a line across two writes — instead of handing an
 * array to a stub.
 *
 * The script is the same idea as in fake-openai.js: pieces of the answer,
 * pieces of the model's thinking, whether it stopped on its own or on the
 * token limit, and how long each piece takes. Every request is recorded with
 * its body, so a test can say what `stream`, `think`, `options.num_predict`
 * and the prompt were, and every record knows whether the client hung up
 * before the answer was finished.
 *
 * Usage:
 *   const fake = await createFakeOllama({ chunks: [{ response: 'hi' }] });
 *   ollamaService.apiUrl = fake.url;
 *   ... await fake.close();
 */

const http = require('http');

/** The model name the fake reports when a script names none. */
const DEFAULT_MODEL = 'fake-ollama-model';

/**
 * @typedef {object} FakeOllamaChunk
 * @property {string} [response]  a piece of the answer
 * @property {string} [thinking]  a piece of the model's thinking
 * @property {number} [delayMs]   wait this long before sending it
 * @property {boolean} [split]    write this line in two socket writes
 */

/**
 * @typedef {object} FakeOllamaScript
 * @property {FakeOllamaChunk[]} [chunks]
 * @property {'stop'|'length'|null} [doneReason]  default 'stop'; null leaves
 *   the field out, the way an Ollama old enough not to send one does
 * @property {number|null} [evalCount]       completion tokens on the last line
 * @property {number|null} [promptEvalCount] prompt tokens on the last line
 * @property {number} [chunkDelayMs]
 * @property {string} [model]
 * @property {number} [status]  answer this status instead, with `error`
 * @property {object} [error]
 */

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function normalizeScript(script) {
  return {
    chunks: Array.isArray(script?.chunks) ? script.chunks : [],
    doneReason: script?.doneReason === undefined ? 'stop' : script.doneReason,
    evalCount: script?.evalCount === undefined ? null : script.evalCount,
    promptEvalCount:
      script?.promptEvalCount === undefined ? null : script.promptEvalCount,
    chunkDelayMs: Number(script?.chunkDelayMs) || 0,
    model: script?.model || DEFAULT_MODEL,
    status: Number(script?.status) || 200,
    error: script?.error || { error: 'fake failure' },
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
 * @param {FakeOllamaScript|FakeOllamaScript[]} [script]
 * @returns {Promise<object>} the handle; close() it in a finally
 */
async function createFakeOllama(script = {}) {
  let scripts = Array.isArray(script) ? script.slice() : [script];
  let served = 0;
  const requests = [];
  const sockets = new Set();

  const nextScript = () => {
    const chosen = scripts[Math.min(served, scripts.length - 1)] || {};
    served += 1;
    return normalizeScript(chosen);
  };

  const lastLine = (plan) => {
    const line = {
      model: plan.model,
      created_at: '2026-01-01T00:00:00Z',
      response: '',
      done: true,
    };
    if (plan.doneReason !== null) line.done_reason = plan.doneReason;
    if (plan.promptEvalCount !== null) {
      line.prompt_eval_count = plan.promptEvalCount;
    }
    if (plan.evalCount !== null) line.eval_count = plan.evalCount;
    return line;
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

    if (path === '/api/ps' || path === '/api/tags') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: DEFAULT_MODEL }] }));
      return;
    }

    if (path !== '/api/generate') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `no route ${path}` }));
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

    const answer = lastLine(plan);
    for (const chunk of plan.chunks) {
      if (typeof chunk?.response === 'string')
        answer.response += chunk.response;
      if (typeof chunk?.thinking === 'string') {
        answer.thinking = (answer.thinking || '') + chunk.thinking;
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(answer));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  /** Writes the script as newline-delimited JSON, one object per chunk. */
  async function writeStream(response, plan) {
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    });

    const send = (payload, split = false) => {
      if (response.writableEnded || response.destroyed) return false;
      const line = `${JSON.stringify(payload)}\n`;
      if (split && line.length > 4) {
        // The client has to keep the tail of a read until its newline
        // arrives; this is how that gets exercised.
        response.write(line.slice(0, 4));
        response.write(line.slice(4));
      } else {
        response.write(line);
      }
      return true;
    };

    for (const chunk of plan.chunks) {
      const delay = Number.isFinite(Number(chunk?.delayMs))
        ? Number(chunk.delayMs)
        : plan.chunkDelayMs;
      await sleep(delay);
      const line = {
        model: plan.model,
        created_at: '2026-01-01T00:00:00Z',
        response: typeof chunk?.response === 'string' ? chunk.response : '',
        done: false,
      };
      if (typeof chunk?.thinking === 'string') line.thinking = chunk.thinking;
      if (!send(line, chunk?.split === true)) return;
    }

    if (!send(lastLine(plan))) return;
    if (response.writableEnded || response.destroyed) return;
    response.end();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
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

module.exports = { createFakeOllama, DEFAULT_MODEL };
