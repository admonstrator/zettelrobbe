'use strict';

/**
 * Test: Paperless-ngx 3.5+ refusing the host name Zettelrobbe uses
 *
 * Since Paperless-ngx 3.5.0 (#14735) PAPERLESS_URL or PAPERLESS_ALLOWED_HOSTS
 * limit the host names Django accepts. Reached as `paperless:8000`, a
 * Paperless-ngx that lists only its public name answers every request with
 * Django's DisallowedHost page, HTTP 400. The person used to read "Check the
 * address and token".
 *
 * Covers:
 *  1. services/paperlessHostCheck.js: Django's 400 page (production and
 *     PAPERLESS_DEBUG) is recognised; a JSON 400, a proxy's own 400 page, a
 *     400 on a write, 401, 403 and a refused connection are not
 *  2. The setup wizard's POST /api/setup/paperless/test against a real HTTP
 *     server answering like Django: stage host_not_allowed, the host in the
 *     message; a rejected token keeps the old answer
 *  3. POST /settings with a new address says the same
 *  4. paperlessService.checkConnection() reports it, the health snapshot
 *     carries it and the dashboard banner shows it instead of "rejected the
 *     API token"
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

/** Django's bad_request() page, verbatim (django/views/defaults.py). */
const DJANGO_400_PAGE = `
<!doctype html>
<html lang="en">
<head>
  <title>Bad Request (400)</title>
</head>
<body>
  <h1>Bad Request (400)</h1><p></p>
</body>
</html>
`;

/** The start of the technical page PAPERLESS_DEBUG renders as plain text. */
const DJANGO_DEBUG_400_TEXT =
  "DisallowedHost at /api/documents/\nInvalid HTTP_HOST header: 'paperless:8000'. " +
  "You may need to add 'paperless' to ALLOWED_HOSTS.";

const NGINX_400_PAGE =
  '<html>\r\n<head><title>400 Bad Request</title></head>\r\n<body>\r\n' +
  '<center><h1>400 Bad Request</h1></center>\r\n<hr><center>nginx</center>\r\n' +
  '</body>\r\n</html>\r\n';

/** An axios-shaped error as the client throws it. */
function axiosError({ status, contentType, data, method = 'get', url }) {
  const error = new Error(`Request failed with status code ${status}`);
  error.isAxiosError = true;
  error.config = {
    method,
    baseURL: 'http://paperless:8000/api',
    url: url || '/documents/',
  };
  error.response = {
    status,
    data,
    headers: contentType ? { 'content-type': contentType } : {},
  };
  return error;
}

/**
 * A stand-in for Paperless-ngx that answers every request with `reply`.
 *
 * @param {(req: http.IncomingMessage) => {status: number, type: string, body: string}} reply
 */
async function startPaperless(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host });
    const { status, type, body } = reply(req);
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const refusesHost = () => ({
  status: 400,
  type: 'text/html; charset=utf-8',
  body: DJANGO_400_PAGE,
});
const rejectsToken = () => ({
  status: 401,
  type: 'application/json',
  body: JSON.stringify({ detail: 'Invalid token.' }),
});

(async () => {
  const harness = await mountRouter({
    user: { username: 'admin' },
    env: { PAPERLESS_AI_SETUP_ALLOW_LOCALHOST: 'yes' },
    stub: ({ documentModel, paperlessService }) => {
      // The wizard is open while no account exists.
      documentModel.getUsers = async () => [];
      paperlessService.findCustomFieldTypeConflicts = async () => [];
    },
  });

  const {
    isDisallowedHostResponse,
    refusedHostFromError,
    hostNotAllowedMessage,
  } = require('../services/paperlessHostCheck');

  try {
    // ── 1. The helper ────────────────────────────────────────────────────
    await test("Django's 400 page is a refused host name, named with its port", () => {
      const refused = refusedHostFromError(
        axiosError({
          status: 400,
          contentType: 'text/html; charset=utf-8',
          data: DJANGO_400_PAGE,
        })
      );
      assert.deepStrictEqual(refused, {
        host: 'paperless:8000',
        hostname: 'paperless',
      });
    });

    await test('The PAPERLESS_DEBUG page is recognised too', () => {
      assert.ok(
        refusedHostFromError(
          axiosError({
            status: 400,
            contentType: 'text/plain; charset=utf-8',
            data: DJANGO_DEBUG_400_TEXT,
          })
        )
      );
    });

    await test('A JSON 400 (a validation error) is not', () => {
      assert.strictEqual(
        refusedHostFromError(
          axiosError({
            status: 400,
            contentType: 'application/json',
            data: { name: ['This field is required.'] },
          })
        ),
        null
      );
      // Even with Django's words in it: JSON is never the host page.
      assert.strictEqual(
        isDisallowedHostResponse({
          status: 400,
          contentType: 'application/json',
          body: '{"detail":"Bad Request (400)"}',
        }),
        false
      );
    });

    await test("A proxy's own 400 page is not", () => {
      assert.strictEqual(
        refusedHostFromError(
          axiosError({
            status: 400,
            contentType: 'text/html',
            data: NGINX_400_PAGE,
          })
        ),
        null
      );
    });

    await test('A 400 on a write is not (it can be a validation error)', () => {
      assert.strictEqual(
        refusedHostFromError(
          axiosError({
            status: 400,
            contentType: 'text/html',
            data: DJANGO_400_PAGE,
            method: 'post',
          })
        ),
        null
      );
    });

    await test('401, 403 and a refused connection are not', () => {
      for (const status of [401, 403]) {
        assert.strictEqual(
          refusedHostFromError(
            axiosError({
              status,
              contentType: 'text/html',
              data: DJANGO_400_PAGE,
            })
          ),
          null,
          `status ${status}`
        );
      }
      const refusedConnection = Object.assign(
        new Error('connect ECONNREFUSED 172.18.0.2:8000'),
        { code: 'ECONNREFUSED', config: { method: 'get' } }
      );
      assert.strictEqual(refusedHostFromError(refusedConnection), null);
      assert.strictEqual(refusedHostFromError(null), null);
    });

    await test('Without a request config the given URL names the host', () => {
      const error = axiosError({
        status: 400,
        contentType: 'text/html',
        data: DJANGO_400_PAGE,
      });
      delete error.config;
      assert.deepStrictEqual(
        refusedHostFromError(error, 'http://[fd00::5]:8000/api/'),
        { host: '[fd00::5]:8000', hostname: '[fd00::5]' }
      );
    });

    await test('The message names the host and the Paperless-ngx setting', () => {
      const message = hostNotAllowedMessage({
        host: 'paperless:8000',
        hostname: 'paperless',
      });
      assert.match(message, /refused requests for paperless:8000/);
      assert.match(message, /add paperless to PAPERLESS_ALLOWED_HOSTS/);
      assert.match(message, /3\.5/);
      assert.doesNotMatch(message, /token/i);
    });

    // ── 2. The setup wizard ──────────────────────────────────────────────
    const postWizardTest = async (paperlessUrl) => {
      const response = await fetch(harness.base + '/api/setup/paperless/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperlessUrl, paperlessToken: 'some-token' }),
      });
      return { status: response.status, body: await response.json() };
    };

    await test('The wizard test says the host name was refused', async () => {
      const paperless = await startPaperless(refusesHost);
      try {
        const { status, body } = await postWizardTest(paperless.url);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.stage, 'host_not_allowed');
        assert.ok(
          body.message.includes(`refused requests for ${paperless.host}`),
          body.message
        );
        assert.match(
          body.message,
          /add 127\.0\.0\.1 to PAPERLESS_ALLOWED_HOSTS/
        );
        assert.ok(
          paperless.requests.some((r) => r.url === '/api/documents/'),
          'the test asked Paperless-ngx'
        );
      } finally {
        await paperless.close();
      }
    });

    await test('A rejected token keeps the old wizard answer', async () => {
      const paperless = await startPaperless(rejectsToken);
      try {
        const { body } = await postWizardTest(paperless.url);
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.stage, 'reachability');
        assert.strictEqual(
          body.message,
          'Could not reach Paperless-ngx with this URL and token.'
        );
      } finally {
        await paperless.close();
      }
    });

    await test('An unreachable host keeps the old wizard answer', async () => {
      const paperless = await startPaperless(refusesHost);
      const url = paperless.url;
      await paperless.close();
      const { body } = await postWizardTest(url);
      assert.strictEqual(body.stage, 'reachability');
    });

    await test('The wizard page script titles the refusal by its stage', () => {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, 'public', 'js', 'setup.js'),
        'utf8'
      );
      assert.match(source, /result\.stage === 'host_not_allowed'/);
    });

    // ── 3. Saving the settings ───────────────────────────────────────────
    await test('Saving a new address says the host name was refused', async () => {
      const paperless = await startPaperless(refusesHost);
      try {
        const response = await fetch(harness.base + '/settings', {
          method: 'POST',
          headers: harness.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            paperlessUrl: paperless.url,
            paperlessToken: 'new-token',
          }),
        });
        const body = await response.json();
        assert.strictEqual(response.status, 400, JSON.stringify(body));
        assert.ok(
          body.error.includes(`refused requests for ${paperless.host}`),
          body.error
        );
        assert.doesNotMatch(body.error, /Check the address and token/);
      } finally {
        await paperless.close();
      }
    });

    await test('Saving with a rejected token keeps the old answer', async () => {
      const paperless = await startPaperless(rejectsToken);
      try {
        const response = await fetch(harness.base + '/settings', {
          method: 'POST',
          headers: harness.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            paperlessUrl: paperless.url,
            paperlessToken: 'new-token',
          }),
        });
        const body = await response.json();
        assert.strictEqual(response.status, 400);
        assert.strictEqual(
          body.error,
          'Paperless-ngx connection failed. Check the address and token.'
        );
      } finally {
        await paperless.close();
      }
    });

    // ── 4. The running app: probe, snapshot, banner ──────────────────────
    // The harness stubs checkConnection(); the real one runs here on an
    // object that carries a real client.
    const axios = require(path.join(REPO_ROOT, 'node_modules', 'axios'));
    const realCheckConnection = Object.getPrototypeOf(
      harness.paperlessService
    ).checkConnection;
    const probeAgainst = (url) =>
      realCheckConnection.call({
        initialize() {},
        client: axios.create({
          baseURL: `${url}/api`,
          headers: { Authorization: 'Token t' },
        }),
      });

    let refusedProbe = null;
    await test('checkConnection() reports the refused host name', async () => {
      const paperless = await startPaperless(refusesHost);
      try {
        refusedProbe = await probeAgainst(paperless.url);
        assert.strictEqual(refusedProbe.reachable, true);
        assert.strictEqual(
          refusedProbe.authorized,
          false,
          'nothing gets through, so the scan must not run'
        );
        assert.strictEqual(refusedProbe.status, 400);
        assert.deepStrictEqual(refusedProbe.hostNotAllowed, {
          host: paperless.host,
          hostname: '127.0.0.1',
        });
        assert.match(refusedProbe.error, /PAPERLESS_ALLOWED_HOSTS/);
      } finally {
        await paperless.close();
      }
    });

    await test('checkConnection() still calls a 401 a token problem', async () => {
      const paperless = await startPaperless(rejectsToken);
      try {
        const probe = await probeAgainst(paperless.url);
        assert.strictEqual(probe.reachable, true);
        assert.strictEqual(probe.authorized, false);
        assert.strictEqual(probe.hostNotAllowed, undefined);
      } finally {
        await paperless.close();
      }
    });

    await test('The health snapshot carries the refused host name', () => {
      const scanHealthService = require('../services/scanHealthService');
      const {
        buildScannerHealthSnapshot,
      } = require('../services/scannerHealthSnapshot');
      const before = scanHealthService.getState().paperless;
      try {
        scanHealthService.recordConnectivity(refusedProbe);
        const snapshot = buildScannerHealthSnapshot();
        assert.strictEqual(snapshot.paperless.usable, false);
        assert.deepStrictEqual(
          snapshot.paperless.hostNotAllowed,
          refusedProbe.hostNotAllowed
        );
        assert.strictEqual(snapshot.paperless.error, refusedProbe.error);
      } finally {
        scanHealthService.state.paperless = before;
      }
    });

    await test('The banner shows the fix, not "rejected the API token"', () => {
      const source = fs
        .readFileSync(
          path.join(REPO_ROOT, 'public', 'js', 'modules', 'scanner-health.js'),
          'utf8'
        )
        .replace(/^export /gm, '');
      const sandbox = {};
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox);
      const message = sandbox.describePaperlessProblem({
        reachable: true,
        authorized: false,
        usable: false,
        status: 400,
        error: refusedProbe.error,
        hostNotAllowed: refusedProbe.hostNotAllowed,
        lastCheckedAt: null,
      });
      assert.strictEqual(message, refusedProbe.error);
      assert.doesNotMatch(message, /rejected the API token/);
    });
  } finally {
    await harness.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
