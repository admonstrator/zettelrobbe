'use strict';

/**
 * A minimal headless Chrome for the tests that have to measure a page:
 * launches Chrome with the DevTools protocol, opens one page and offers
 * navigate, evaluate and the viewport. No dependency: Node's own WebSocket
 * (Node 22+) and fetch.
 *
 * findChrome() names the browser: CHROME_PATH, else Google Chrome where
 * macOS installs it. Without one the test runner skips the test
 * (scripts/run-tests.js, getSkipReason).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAC_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @returns {string|null} */
function findChrome() {
  if (typeof WebSocket !== 'function') return null;
  const candidates = [process.env.CHROME_PATH, MAC_CHROME].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ port?: number }} [options]
 */
async function launchChrome({
  port = 9500 + Math.floor(Math.random() * 400),
} = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found (set CHROME_PATH)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 150 && !targets; i++) {
    try {
      targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
    } catch {
      await sleep(100);
    }
  }
  if (!targets) {
    proc.kill();
    throw new Error('Chrome did not open its DevTools port');
  }
  const page = targets.find((target) => target.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) {
      listeners.forEach((listener) => listener(message));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  // "Leave site?" on a page with unsaved changes: leave.
  listeners.add((message) => {
    if (message.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  let loads = 0;
  return {
    /** Script that runs in every page before its own scripts. */
    async beforeEachPage(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async viewport(width, height, { mobile = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: mobile,
        maxTouchPoints: mobile ? 5 : 1,
      });
    },
    /** A full load each time, also when only the hash differs. */
    async goto(url, settle = 800) {
      loads += 1;
      const target = url.replace(/(\?|#|$)/, (m) =>
        m === '?' ? `?load=${loads}&` : `?load=${loads}${m}`
      );
      const loaded = new Promise((resolve) => {
        const listener = (message) => {
          if (message.method === 'Page.loadEventFired') {
            listeners.delete(listener);
            resolve();
          }
        };
        listeners.add(listener);
      });
      await send('Page.navigate', { url: target });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(settle);
    },
    async evaluate(expression) {
      const result = await Promise.race([
        send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        }),
        sleep(30000).then(() => {
          throw new Error('evaluate timed out');
        }),
      ]);
      if (result.exceptionDetails) {
        throw new Error(
          (result.exceptionDetails.exception &&
            result.exceptionDetails.exception.description) ||
            result.exceptionDetails.text
        );
      }
      return result.result.value;
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {
        // already gone
      }
      ws.close();
      proc.kill();
      await sleep(300);
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Chrome still flushing its profile; the temp dir goes with the OS.
      }
    },
  };
}

module.exports = { findChrome, launchChrome };
