const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  createRedirectGuard,
  stripTrailingSlashes,
} = require('../services/serviceUtils');

function expectBlocked(guard, target, expectedFragment) {
  assert.throws(
    () => guard({ href: target }),
    (error) => {
      assert.ok(
        error.message.includes(expectedFragment),
        `Expected "${error.message}" to mention "${expectedFragment}"`
      );
      return true;
    },
    `Redirect to ${target} should have been blocked`
  );
}

function testRedirectGuard() {
  const guard = createRedirectGuard(() => 'http://paperless.internal:8000');

  // Same host stays allowed: Paperless-ngx itself redirects between API paths.
  guard({ href: 'http://paperless.internal:8000/api/documents/' });

  // Reverse proxies in front of Paperless commonly upgrade http to https.
  guard({ href: 'https://paperless.internal:8000/api/documents/' });

  expectBlocked(guard, 'http://169.254.169.254/latest/meta-data/', 'metadata');
  expectBlocked(
    guard,
    'http://metadata.google.internal/computeMetadata/v1/',
    'metadata'
  );
  expectBlocked(guard, 'http://attacker.example.com/collect', 'does not match');
  expectBlocked(guard, 'http://127.0.0.1:9200/_search', 'does not match');
  expectBlocked(guard, 'file:///etc/passwd', 'protocol file:');

  // A guard built from an https base must not be downgraded to plain http.
  const httpsGuard = createRedirectGuard(() => 'https://paperless.internal');
  httpsGuard({ href: 'https://paperless.internal/api/' });
  expectBlocked(httpsGuard, 'http://paperless.internal/api/', 'downgrade');

  // Redirect targets are also accepted in axios' protocol/host/path form.
  guard({
    protocol: 'http:',
    host: 'paperless.internal:8000',
    path: '/api/tags/',
  });
  assert.throws(
    () => guard({ protocol: 'http:', host: 'attacker.example.com', path: '/' }),
    /does not match/,
    'Host mismatch should be detected without an href'
  );

  // Without a configured base URL there is nothing to compare against.
  const emptyGuard = createRedirectGuard(() => '');
  emptyGuard({ href: 'http://anywhere.example.com/' });
}

function testStripTrailingSlashes() {
  assert.strictEqual(
    stripTrailingSlashes('http://example.com/api///'),
    'http://example.com/api'
  );
  assert.strictEqual(
    stripTrailingSlashes('http://example.com/api'),
    'http://example.com/api'
  );
  assert.strictEqual(stripTrailingSlashes('///'), '');
  assert.strictEqual(stripTrailingSlashes(''), '');
  assert.strictEqual(stripTrailingSlashes(null), '');
  assert.strictEqual(stripTrailingSlashes(undefined), '');

  // A long run of slashes must stay linear rather than backtracking like /\/+$/.
  const pathological = '/'.repeat(200000) + 'x';
  const startedAt = process.hrtime.bigint();
  assert.strictEqual(stripTrailingSlashes(pathological), pathological);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(
    elapsedMs < 1000,
    `Normalization should stay linear, took ${elapsedMs.toFixed(1)}ms`
  );
}

// Server code trims URLs with stripTrailingSlashes(), never with the
// quadratic pattern: a settings save of a URL made of many slashes once held
// the event loop for minutes (CodeQL js/polynomial-redos).
function testNoQuadraticSlashPatternOnServer() {
  const root = path.join(__dirname, '..');
  const pattern = ['/\\', '/+$/'].join('');
  const offenders = [];
  const scan = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) return;
      if (code.includes(pattern)) {
        offenders.push(`${path.relative(root, file)}:${index + 1}`);
      }
    });
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) scan(full);
    }
  };
  ['config', 'middleware', 'models', 'routes', 'services'].forEach((dir) =>
    walk(path.join(root, dir))
  );
  scan(path.join(root, 'server.js'));
  assert.deepStrictEqual(
    offenders,
    [],
    `Use stripTrailingSlashes() in ${offenders.join(', ')}`
  );
}

function main() {
  testRedirectGuard();
  testStripTrailingSlashes();
  testNoQuadraticSlashPatternOnServer();
}

try {
  main();
  console.log(
    '[PASS] Redirect guard blocks off-host targets and URL normalization stays linear'
  );
} catch (error) {
  console.error('[FAIL] Redirect guard test failed:', error.message);
  process.exitCode = 1;
}
