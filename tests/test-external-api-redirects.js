'use strict';

/**
 * Every redirect of the external API call passes the same SSRF rule as the
 * address the user entered (EXTERNAL_API_URL).
 *
 * fetchData() checked the entered address only. axios then followed up to 21
 * redirects without looking at them, so a public endpoint could send the
 * request on to a private address, localhost or the cloud metadata service,
 * and a custom header such as X-Api-Key went along to whatever host a
 * redirect named.
 *
 * Runs offline against a real HTTP server on 127.0.0.1. Two halves of DNS are
 * faked, as tests/test-external-api-ssrf-block.js does for the first one:
 * dns.promises.resolve4/resolve6, which the SSRF rule asks what a name stands
 * for, and dns.lookup, which the connection uses. Every *.test name connects
 * to the fake server; what the rule sees is the address in NAMES. That the
 * two can disagree is a gap of the rule itself, for the entered address as
 * for every redirect: it checks what DNS answers, and the connection asks
 * again. The https cases use a fake axios, because the server has no
 * certificate.
 *
 * Cases:
 *   1. a redirect to another public host is followed
 *   2. a redirect to a private address is refused with the switch off, with
 *      one log line and no stack trace, and followed with the switch on
 *   3. a chain whose last hop only is private is refused before that hop
 *   4. localhost, a name that resolves to loopback and the metadata address
 *      are refused even with the switch on
 *   5. a scheme other than http and https is refused
 *   6. a loop ends after five redirects
 *   7. the configured headers go to the entered origin only
 *   8. POST and the body follow the HTTP rules for 303 and 307; a hop that
 *      would carry the body to another host is refused, one without the body
 *      is followed without the headers
 *   9. one timeout covers the whole chain
 *  10. https never continues over http; http may continue over https, and on
 *      the same host name with the default ports the headers and the body go
 *      along; axios is never left to follow a redirect itself
 */

const assert = require('assert');
const dns = require('dns');
const http = require('http');

const dnsPromises = dns.promises;
const axiosModulePath = require.resolve('axios');
const serviceModulePath = require.resolve('../services/externalApiService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${error.message}`);
  }
}

// ── DNS, faked ──────────────────────────────────────────────────────────────

/** What the SSRF rule is told each name resolves to. */
const NAMES = {
  'api.public.test': ['93.184.216.34'],
  'other.public.test': ['203.0.113.10'],
  'third.public.test': ['203.0.113.11'],
  'intranet.test': ['10.0.0.5'],
  'loopback.test': ['127.0.0.1'],
  'metadata.test': ['169.254.169.254'],
};

const realResolve4 = dnsPromises.resolve4;
const realResolve6 = dnsPromises.resolve6;
const realLookup = dns.lookup;

function notFound(code) {
  const error = new Error(`DNS lookup failed (${code})`);
  error.code = code;
  return error;
}

function fakeDns() {
  dnsPromises.resolve4 = async (hostname) => {
    if (NAMES[hostname]) return NAMES[hostname];
    throw notFound('ENOTFOUND');
  };
  dnsPromises.resolve6 = async () => {
    throw notFound('ENODATA');
  };
  // The connection: every *.test name reaches the fake server.
  dns.lookup = function lookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (String(hostname).endsWith('.test')) {
      if (opts.all) {
        process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
      } else {
        process.nextTick(done, null, '127.0.0.1', 4);
      }
      return;
    }
    realLookup.call(dns, hostname, options, callback);
  };
}

function realDns() {
  dnsPromises.resolve4 = realResolve4;
  dnsPromises.resolve6 = realResolve6;
  dns.lookup = realLookup;
}

// ── The endpoint ────────────────────────────────────────────────────────────

/**
 * One server for every *.test host. ROUTES maps "host path" to a redirect
 * target; "{port}" stands for the server's port. Everything else answers
 * with JSON naming the host and path it was asked for.
 */
const ROUTES = {
  'api.public.test /to-public': 'http://other.public.test:{port}/data',
  'api.public.test /to-intranet': 'http://intranet.test:{port}/data',
  'api.public.test /chain': 'http://other.public.test:{port}/chain-2',
  'other.public.test /chain-2': 'http://third.public.test:{port}/chain-3',
  'third.public.test /chain-3': 'http://intranet.test:{port}/data',
  'api.public.test /to-localhost': 'http://127.0.0.1:{port}/data',
  'api.public.test /to-loopback-name': 'http://loopback.test:{port}/data',
  'api.public.test /to-metadata-name': 'http://metadata.test:{port}/data',
  'api.public.test /to-metadata-ip': 'http://169.254.169.254/latest/meta-data/',
  'api.public.test /to-metadata-host':
    'http://metadata.google.internal/computeMetadata/v1/',
  'api.public.test /to-file': 'file:///etc/passwd',
  'api.public.test /to-ftp': 'ftp://other.public.test/data',
  'api.public.test /to-same': '/data',
  'api.public.test /to-slow': '/slow',
};

async function createEndpoint() {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const host = String(request.headers.host || '').split(':')[0];
    const route = String(request.url || '').split('?')[0];
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      hits.push({
        host,
        route,
        method: request.method,
        body,
        headers: request.headers,
      });

      const { port } = server.address();
      if (ROUTES[`${host} ${route}`]) {
        response.writeHead(302, {
          Location: ROUTES[`${host} ${route}`].replace('{port}', port),
        });
        response.end();
        return;
      }
      if (route === '/loop') {
        response.writeHead(302, { Location: '/loop' });
        response.end();
        return;
      }
      // A redirect with the status in its name to another host.
      const away = /^\/(30[1278])-away$/.exec(route);
      if (away) {
        response.writeHead(Number(away[1]), {
          Location: `http://other.public.test:${port}/echo`,
        });
        response.end();
        return;
      }
      if (route === '/post-303' || route === '/post-307') {
        response.writeHead(route === '/post-303' ? 303 : 307, {
          Location: '/echo',
        });
        response.end();
        return;
      }
      if (route === '/slow') {
        // Never answers; the timeout has to end it.
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ host, route, method: request.method, body })
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: (host, route) => `http://${host}:${port}${route}`,
    hits,
    hostsHit: () => hits.map((hit) => `${hit.host} ${hit.route}`),
    reset: () => {
      hits.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── Running fetchData() ─────────────────────────────────────────────────────

/** Runs a body and keeps every console line it writes. */
async function captured(fn) {
  const real = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const lines = [];
  for (const method of Object.keys(real)) {
    console[method] = (...args) =>
      lines.push(
        args
          .map((arg) =>
            arg instanceof Error
              ? arg.stack
              : typeof arg === 'string'
                ? arg
                : JSON.stringify(arg)
          )
          .join(' ')
      );
  }
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    Object.assign(console, real);
  }
}

function setExternalApi(values) {
  Object.assign(process.env, {
    EXTERNAL_API_ENABLED: 'yes',
    EXTERNAL_API_METHOD: 'GET',
    EXTERNAL_API_HEADERS: '{}',
    EXTERNAL_API_BODY: '{}',
    EXTERNAL_API_TIMEOUT: '2000',
    EXTERNAL_API_TRANSFORM: '',
    EXTERNAL_API_ALLOW_PRIVATE_IPS: 'no',
    ...values,
  });
}

/** Loads the service fresh, with a fake axios when one is given. */
function loadService(axiosFake) {
  delete require.cache[serviceModulePath];
  const realAxios = require.cache[axiosModulePath];
  if (axiosFake) {
    require.cache[axiosModulePath] = {
      id: axiosModulePath,
      filename: axiosModulePath,
      loaded: true,
      exports: axiosFake,
    };
  }
  try {
    return require('../services/externalApiService');
  } finally {
    if (axiosFake) {
      if (realAxios) {
        require.cache[axiosModulePath] = realAxios;
      } else {
        delete require.cache[axiosModulePath];
      }
    }
  }
}

/** The lines that report a refused redirect. */
function refusals(lines) {
  return lines.filter(
    (line) => /redirect/i.test(line) && /refused/i.test(line)
  );
}

function assertOneRefusal(lines, address, reason) {
  const found = refusals(lines);
  assert.strictEqual(
    found.length,
    1,
    `one line reports the refusal, got: ${lines.join(' | ')}`
  );
  assert.ok(
    found[0].includes(address),
    `the line names ${address}: ${found[0]}`
  );
  assert.ok(
    found[0].toLowerCase().includes(reason.toLowerCase()),
    `the line says why (${reason}): ${found[0]}`
  );
  assert.ok(
    !lines.some((line) => /\n\s+at /.test(line)),
    `no stack trace: ${lines.join(' | ')}`
  );
}

async function main() {
  const keys = [
    'EXTERNAL_API_ENABLED',
    'EXTERNAL_API_URL',
    'EXTERNAL_API_METHOD',
    'EXTERNAL_API_HEADERS',
    'EXTERNAL_API_BODY',
    'EXTERNAL_API_TIMEOUT',
    'EXTERNAL_API_TRANSFORM',
    'EXTERNAL_API_ALLOW_PRIVATE_IPS',
  ];
  const savedEnv = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );

  fakeDns();
  const endpoint = await createEndpoint();
  const service = loadService();

  /** fetchData() against a route of the fake server. */
  const fetchFrom = async (host, route, values = {}) => {
    endpoint.reset();
    setExternalApi({ EXTERNAL_API_URL: endpoint.url(host, route), ...values });
    return captured(() => service.fetchData());
  };

  try {
    console.log('\n=== External API redirects ===');

    // ── 1. public to public ───────────────────────────────────────────────

    await test('a redirect to another public host is followed', async () => {
      const { value } = await fetchFrom('api.public.test', '/to-public');
      assert.deepStrictEqual(value, {
        host: 'other.public.test',
        route: '/data',
        method: 'GET',
        body: '',
      });
      assert.deepStrictEqual(endpoint.hostsHit(), [
        'api.public.test /to-public',
        'other.public.test /data',
      ]);
    });

    // ── 2. public to private ──────────────────────────────────────────────

    await test('a redirect to a private address is refused with the switch off, one log line, no request to it', async () => {
      const { value, lines } = await fetchFrom(
        'api.public.test',
        '/to-intranet'
      );
      assert.strictEqual(value, null);
      assert.deepStrictEqual(endpoint.hostsHit(), [
        'api.public.test /to-intranet',
      ]);
      assertOneRefusal(
        lines,
        `http://intranet.test:${endpoint.port}/data`,
        'Private IP addresses are not allowed'
      );
    });

    await test('a redirect to a private address is followed with the switch on', async () => {
      const { value } = await fetchFrom('api.public.test', '/to-intranet', {
        EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
      });
      assert.strictEqual(value.host, 'intranet.test');
      assert.deepStrictEqual(endpoint.hostsHit(), [
        'api.public.test /to-intranet',
        'intranet.test /data',
      ]);
    });

    // ── 3. only the last hop is private ───────────────────────────────────

    await test('a chain whose last hop only is private stops before that hop', async () => {
      const { value, lines } = await fetchFrom('api.public.test', '/chain');
      assert.strictEqual(value, null);
      assert.deepStrictEqual(endpoint.hostsHit(), [
        'api.public.test /chain',
        'other.public.test /chain-2',
        'third.public.test /chain-3',
      ]);
      assertOneRefusal(
        lines,
        `http://intranet.test:${endpoint.port}/data`,
        'Private IP addresses are not allowed'
      );

      const allowed = await fetchFrom('api.public.test', '/chain', {
        EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
      });
      assert.strictEqual(allowed.value.host, 'intranet.test');
    });

    // ── 4. never allowed ──────────────────────────────────────────────────

    await test('localhost, a name for loopback and the metadata address are refused with the switch on too', async () => {
      const cases = [
        [
          '/to-localhost',
          `http://127.0.0.1:${endpoint.port}/data`,
          'Localhost',
        ],
        [
          '/to-loopback-name',
          `http://loopback.test:${endpoint.port}/data`,
          'Localhost',
        ],
        [
          '/to-metadata-name',
          `http://metadata.test:${endpoint.port}/data`,
          'metadata',
        ],
        [
          '/to-metadata-ip',
          'http://169.254.169.254/latest/meta-data/',
          'metadata',
        ],
        [
          '/to-metadata-host',
          'http://metadata.google.internal/computeMetadata/v1/',
          'metadata',
        ],
      ];
      for (const allow of ['no', 'yes']) {
        for (const [route, address, reason] of cases) {
          const { value, lines } = await fetchFrom('api.public.test', route, {
            EXTERNAL_API_ALLOW_PRIVATE_IPS: allow,
          });
          assert.strictEqual(value, null, `${route} with the switch ${allow}`);
          assert.deepStrictEqual(
            endpoint.hostsHit(),
            [`api.public.test ${route}`],
            `${route} with the switch ${allow}: nothing after the redirect`
          );
          assertOneRefusal(lines, address, reason);
        }
      }
    });

    // ── 5. other schemes ──────────────────────────────────────────────────

    await test('a redirect to file: or ftp: is refused', async () => {
      for (const [route, address] of [
        ['/to-file', 'file:///etc/passwd'],
        ['/to-ftp', 'ftp://other.public.test/data'],
      ]) {
        const { value, lines } = await fetchFrom('api.public.test', route, {
          EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
        });
        assert.strictEqual(value, null, route);
        assert.deepStrictEqual(endpoint.hostsHit(), [
          `api.public.test ${route}`,
        ]);
        assertOneRefusal(lines, address, 'is not allowed');
      }
    });

    // ── 6. bounded ────────────────────────────────────────────────────────

    await test('a redirect loop ends after five redirects', async () => {
      const { value, lines } = await fetchFrom('api.public.test', '/loop');
      assert.strictEqual(value, null);
      assert.strictEqual(
        endpoint.hits.length,
        6,
        'the first request and five redirects'
      );
      assertOneRefusal(
        lines,
        `http://api.public.test:${endpoint.port}/loop`,
        'more than 5 redirects'
      );
    });

    // ── 7. the configured headers ─────────────────────────────────────────

    const HEADERS = JSON.stringify({
      Authorization: 'Bearer secret-token',
      'X-Api-Key': 'secret-key',
    });

    await test('the configured headers go along on a redirect within the entered origin', async () => {
      const { value } = await fetchFrom('api.public.test', '/to-same', {
        EXTERNAL_API_HEADERS: HEADERS,
      });
      assert.strictEqual(value.route, '/data');
      for (const hit of endpoint.hits) {
        assert.strictEqual(
          hit.headers.authorization,
          'Bearer secret-token',
          hit.route
        );
        assert.strictEqual(hit.headers['x-api-key'], 'secret-key', hit.route);
      }
    });

    await test('the configured headers stay behind on a redirect to another host', async () => {
      const { value } = await fetchFrom('api.public.test', '/to-public', {
        EXTERNAL_API_HEADERS: HEADERS,
      });
      assert.strictEqual(value.host, 'other.public.test');
      const [first, second] = endpoint.hits;
      assert.strictEqual(first.headers['x-api-key'], 'secret-key');
      assert.strictEqual(first.headers.authorization, 'Bearer secret-token');
      assert.strictEqual(second.host, 'other.public.test');
      assert.strictEqual(second.headers['x-api-key'], undefined, 'X-Api-Key');
      assert.strictEqual(
        second.headers.authorization,
        undefined,
        'Authorization'
      );
    });

    // ── 8. method and body ────────────────────────────────────────────────

    await test('POST: a 303 continues as GET without the body, a 307 as POST with it', async () => {
      const after303 = await fetchFrom('api.public.test', '/post-303', {
        EXTERNAL_API_METHOD: 'POST',
        EXTERNAL_API_BODY: '{"q":"rates"}',
      });
      assert.strictEqual(after303.value.method, 'GET');
      assert.strictEqual(after303.value.body, '');

      const after307 = await fetchFrom('api.public.test', '/post-307', {
        EXTERNAL_API_METHOD: 'POST',
        EXTERNAL_API_BODY: '{"q":"rates"}',
      });
      assert.strictEqual(after307.value.method, 'POST');
      assert.deepStrictEqual(JSON.parse(after307.value.body), { q: 'rates' });
    });

    await test('a redirect that would carry the body to another host is refused', async () => {
      for (const [method, route] of [
        ['POST', '/307-away'],
        ['POST', '/308-away'],
        ['PUT', '/301-away'],
        ['PUT', '/302-away'],
        ['PUT', '/307-away'],
      ]) {
        const { value, lines } = await fetchFrom('api.public.test', route, {
          EXTERNAL_API_METHOD: method,
          EXTERNAL_API_BODY: '{"token":"secret-in-body"}',
          EXTERNAL_API_HEADERS: HEADERS,
        });
        assert.strictEqual(value, null, `${method} ${route}`);
        assert.deepStrictEqual(
          endpoint.hostsHit(),
          [`api.public.test ${route}`],
          `${method} ${route}: no request to the other host`
        );
        assertOneRefusal(
          lines,
          `http://other.public.test:${endpoint.port}/echo`,
          'The request body goes only to the address you entered'
        );
      }
    });

    await test('a redirect to another host that leaves the body behind is followed without the headers', async () => {
      for (const [method, route, expected] of [
        ['POST', '/301-away', 'GET'],
        ['POST', '/302-away', 'GET'],
        ['GET', '/307-away', 'GET'],
      ]) {
        const { value } = await fetchFrom('api.public.test', route, {
          EXTERNAL_API_METHOD: method,
          EXTERNAL_API_BODY: '{"token":"secret-in-body"}',
          EXTERNAL_API_HEADERS: HEADERS,
        });
        assert.deepStrictEqual(
          value,
          {
            host: 'other.public.test',
            route: '/echo',
            method: expected,
            body: '',
          },
          `${method} ${route}`
        );
        const second = endpoint.hits[1];
        assert.strictEqual(second.headers['x-api-key'], undefined, route);
        assert.strictEqual(second.headers.authorization, undefined, route);
      }
    });

    // ── 9. one timeout ────────────────────────────────────────────────────

    await test('one timeout covers the whole chain', async () => {
      const started = Date.now();
      const { value } = await fetchFrom('api.public.test', '/to-slow', {
        EXTERNAL_API_TIMEOUT: '300',
      });
      assert.strictEqual(value, null);
      assert.ok(Date.now() - started < 1500, 'the timeout ended the call');
      assert.deepStrictEqual(endpoint.hostsHit(), [
        'api.public.test /to-slow',
        'api.public.test /slow',
      ]);
    });

    // ── 10. https, with a fake axios ──────────────────────────────────────

    /** A fake axios: answers by URL, records every call. */
    const fakeAxios = (answers) => {
      const calls = [];
      const fake = async (options) => {
        calls.push(options);
        const answer = answers[options.url];
        if (!answer) throw new Error(`unexpected request to ${options.url}`);
        // What axios does when it is left to follow on its own.
        if (
          answer.status >= 300 &&
          answer.status < 400 &&
          options.maxRedirects !== 0
        ) {
          return fake({ ...options, url: answer.headers.location });
        }
        return answer;
      };
      return { fake, calls };
    };
    const redirectTo = (location, status = 302) => ({
      status,
      headers: { location },
      data: '',
    });
    const ok = (data) => ({ status: 200, headers: {}, data });

    await test('a redirect from https to http is refused', async () => {
      const { fake, calls } = fakeAxios({
        'https://api.public.test/secure': redirectTo(
          'http://api.public.test/data'
        ),
        'http://api.public.test/data': ok({ leaked: true }),
      });
      const httpsService = loadService(fake);
      setExternalApi({
        EXTERNAL_API_URL: 'https://api.public.test/secure',
        EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
      });
      const { value, lines } = await captured(() => httpsService.fetchData());
      assert.strictEqual(value, null);
      assert.deepStrictEqual(
        calls.map((call) => call.url),
        ['https://api.public.test/secure']
      );
      assertOneRefusal(lines, 'http://api.public.test/data', 'https');
    });

    await test('a downgrade later in the chain is refused too', async () => {
      const { fake, calls } = fakeAxios({
        'http://api.public.test/start': redirectTo(
          'https://other.public.test/next'
        ),
        'https://other.public.test/next': redirectTo(
          'http://other.public.test/data'
        ),
        'http://other.public.test/data': ok({ leaked: true }),
      });
      const httpsService = loadService(fake);
      setExternalApi({ EXTERNAL_API_URL: 'http://api.public.test/start' });
      const { value, lines } = await captured(() => httpsService.fetchData());
      assert.strictEqual(value, null);
      assert.deepStrictEqual(
        calls.map((call) => call.url),
        ['http://api.public.test/start', 'https://other.public.test/next']
      );
      assertOneRefusal(lines, 'http://other.public.test/data', 'https');
    });

    await test('http may continue over https on the same host with the headers; axios never follows on its own', async () => {
      for (const [entered, upgraded] of [
        ['http://api.public.test/up', 'https://api.public.test/data'],
        ['http://api.public.test:80/up', 'https://api.public.test:443/data'],
      ]) {
        const { fake, calls } = fakeAxios({
          [entered]: redirectTo(upgraded, 301),
          [new URL(upgraded).href]: redirectTo('/more', 302),
          'https://api.public.test/more': ok({ secure: true }),
        });
        const httpsService = loadService(fake);
        setExternalApi({
          EXTERNAL_API_URL: entered,
          EXTERNAL_API_HEADERS: HEADERS,
        });
        const { value } = await captured(() => httpsService.fetchData());
        assert.deepStrictEqual(value, { secure: true }, entered);
        assert.deepStrictEqual(
          calls.map((call) => new URL(call.url).href),
          [
            'http://api.public.test/up',
            'https://api.public.test/data',
            'https://api.public.test/more',
          ]
        );
        assert.ok(
          calls.every((call) => call.maxRedirects === 0),
          'every request tells axios not to follow redirects itself'
        );
        for (const call of calls) {
          assert.strictEqual(call.headers['X-Api-Key'], 'secret-key', call.url);
          assert.strictEqual(
            call.headers.Authorization,
            'Bearer secret-token',
            call.url
          );
        }
      }
    });

    await test('the body goes along when http continues over https on the same host', async () => {
      const { fake, calls } = fakeAxios({
        'http://api.public.test/up': redirectTo(
          'https://api.public.test/data',
          307
        ),
        'https://api.public.test/data': ok({ secure: true }),
      });
      const httpsService = loadService(fake);
      setExternalApi({
        EXTERNAL_API_URL: 'http://api.public.test/up',
        EXTERNAL_API_METHOD: 'POST',
        EXTERNAL_API_BODY: '{"token":"secret-in-body"}',
        EXTERNAL_API_HEADERS: HEADERS,
      });
      const { value } = await captured(() => httpsService.fetchData());
      assert.deepStrictEqual(value, { secure: true });
      assert.strictEqual(calls[1].method, 'POST');
      assert.deepStrictEqual(calls[1].data, { token: 'secret-in-body' });
      assert.strictEqual(calls[1].headers['X-Api-Key'], 'secret-key');
    });

    await test('an upgrade to https on another port or host is another address', async () => {
      for (const [entered, target] of [
        ['http://api.public.test:8080/up', 'https://api.public.test:8443/data'],
        ['http://api.public.test/up', 'https://api.public.test:8443/data'],
        ['http://api.public.test:8080/up', 'https://api.public.test/data'],
        ['http://api.public.test/up', 'https://other.public.test/data'],
      ]) {
        const { fake, calls } = fakeAxios({
          [entered]: redirectTo(target, 302),
          [target]: ok({ secure: true }),
        });
        const httpsService = loadService(fake);
        setExternalApi({
          EXTERNAL_API_URL: entered,
          EXTERNAL_API_HEADERS: HEADERS,
          EXTERNAL_API_ALLOW_PRIVATE_IPS: 'yes',
        });
        const { value } = await captured(() => httpsService.fetchData());
        assert.deepStrictEqual(value, { secure: true }, target);
        assert.strictEqual(calls[0].headers['X-Api-Key'], 'secret-key');
        assert.deepStrictEqual(calls[1].headers, {}, `${entered} to ${target}`);
      }
    });
  } finally {
    realDns();
    await endpoint.close();
    delete require.cache[serviceModulePath];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[FAIL] External API redirect test crashed:', error);
  process.exitCode = 1;
});
