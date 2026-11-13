/**
 * Regression coverage for issue #305: "Scan now" answered with an unlogged
 * HTTP 500.
 *
 * Two things went wrong together. POST /api/scan/now resolved the Paperless
 * user ID and refused to start the scan when that came back null — with no log
 * line at all, which is why the reporter saw a 500 and an empty log. And
 * getOwnUserID() came back null far too easily: it only ever matched
 * PAPERLESS_USERNAME against the usernames in /api/users/, so a display name, a
 * case difference, or a response the token user cannot fully see all ended in
 * the same silent null.
 *
 * The scan does not use the user ID at all, so neither the endpoint nor the
 * queue may gate on it — and since processDocument() never read the value it
 * was handed, the plumbing is gone rather than merely ungated. That leaves
 * getOwnUserID() with no caller in the processing path; it stays on the
 * service as a general Paperless helper, hardened, and is covered below so a
 * future caller inherits the fixed behaviour rather than the old one.
 *
 * The route file is read here rather than copied so the assertions cannot
 * drift away from it.
 */

const assert = require('assert');
const { readRouteSources } = require('./helpers/route-sources');

const routeSource = readRouteSources();

// ── The scan trigger must not depend on the user ID ──────────────────────────

const handlerStart = routeSource.indexOf(
  "router.post('/api/scan/now', isAuthenticated"
);
assert.ok(
  handlerStart !== -1,
  'Could not find the POST /api/scan/now handler in the route modules — did it move or get renamed?'
);
const handlerEnd = routeSource.indexOf('\n});', handlerStart);
assert.ok(handlerEnd > handlerStart, 'Could not delimit the handler body');
const handlerBody = routeSource.slice(handlerStart, handlerEnd);

assert.ok(
  !handlerBody.includes('getOwnUserID'),
  'POST /api/scan/now must not resolve the Paperless user ID: the scan never uses it, and an unresolvable ID used to fail the request with an unlogged 500'
);

// Every remaining early return in the handler has to be one the caller can act
// on, so no path may answer 500 without saying why in the log.
const silentFiveHundred =
  /return res\s*\.status\(500\)/.test(handlerBody) &&
  !/console\.error/.test(handlerBody);
assert.ok(
  !silentFiveHundred,
  'POST /api/scan/now must log before answering 500'
);

// ── The manual queue must not depend on it either ────────────────────────────

assert.ok(
  !routeSource.includes('Failed to get own user ID. Abort scanning.'),
  'Queue processing must not abort when the user ID cannot be resolved — the same dead guard stopped manual processing outright'
);

// The ID was resolved, passed to processDocument() and never read there, so
// the whole thread is gone: no request per queue run, and no warning logged
// about a value nothing consumes.
assert.ok(
  !routeSource.includes('ownUserId'),
  'routes/setup.js must not thread an own-user ID it never reads through processDocument()'
);
assert.ok(
  !routeSource.includes('getOwnUserID'),
  'No route may call getOwnUserID — nothing in the processing path uses the result'
);

// ── getOwnUserID() resolves the current user without a name match ────────────

async function run() {
  const paperlessService = require('../services/paperlessService');
  const originalClient = paperlessService.client;
  const originalUsername = process.env.PAPERLESS_USERNAME;
  const originalWarn = console.warn;
  const originalLog = console.log;

  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  console.log = () => {};

  const withUsers = (results) => {
    paperlessService.client = {
      get: async () => ({ data: { results } }),
    };
  };

  try {
    // The configured name still wins when it matches.
    process.env.PAPERLESS_USERNAME = 'zettelrobbe';
    withUsers([
      { id: 7, username: 'someone-else' },
      { id: 42, username: 'zettelrobbe' },
    ]);
    assert.strictEqual(
      await paperlessService.getOwnUserID(),
      42,
      'A matching PAPERLESS_USERNAME must still select that user'
    );

    // Case differences must not lose the match.
    process.env.PAPERLESS_USERNAME = '  ZettelRobbe ';
    assert.strictEqual(
      await paperlessService.getOwnUserID(),
      42,
      'The username match must ignore case and surrounding whitespace'
    );

    // current_user=true answers with one user: take it, whatever the
    // configured name says. This is the case that used to return null.
    process.env.PAPERLESS_USERNAME = 'a-display-name-that-matches-nothing';
    withUsers([{ id: 5, username: 'api-token-user' }]);
    assert.strictEqual(
      await paperlessService.getOwnUserID(),
      5,
      'A single returned user is the current user and must be used even when PAPERLESS_USERNAME does not match'
    );

    // No configured name at all is the common case in the wild.
    delete process.env.PAPERLESS_USERNAME;
    assert.strictEqual(
      await paperlessService.getOwnUserID(),
      5,
      'An unset PAPERLESS_USERNAME must not prevent resolving a single user'
    );

    // Genuinely ambiguous: null is correct, but it has to say so.
    warnings.length = 0;
    process.env.PAPERLESS_USERNAME = 'nobody';
    withUsers([
      { id: 1, username: 'alice' },
      { id: 2, username: 'bob' },
    ]);
    assert.strictEqual(
      await paperlessService.getOwnUserID(),
      null,
      'Several users and no match must stay unresolved'
    );
    assert.ok(
      warnings.some((line) => line.includes('nobody')),
      'An unresolved user ID must be logged with the configured username'
    );

    // An empty list is a dead end too, and equally must not be silent.
    warnings.length = 0;
    withUsers([]);
    assert.strictEqual(await paperlessService.getOwnUserID(), null);
    assert.strictEqual(
      warnings.length,
      1,
      'An empty user list must produce exactly one warning'
    );

    console.log = originalLog;
    console.log('PASS test-scan-now-user-id-independence');
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    paperlessService.client = originalClient;
    if (originalUsername === undefined) {
      delete process.env.PAPERLESS_USERNAME;
    } else {
      process.env.PAPERLESS_USERNAME = originalUsername;
    }
  }
}

run().catch((error) => {
  console.error('FAIL test-scan-now-user-id-independence');
  console.error(error);
  process.exit(1);
});
