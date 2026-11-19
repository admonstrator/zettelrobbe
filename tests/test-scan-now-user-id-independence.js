/**
 * Regression coverage for issue #305: "Scan now" answered with an unlogged
 * HTTP 500.
 *
 * Two things went wrong together. POST /api/scan/now resolved the Paperless
 * user ID and refused to start the scan when that came back null — with no log
 * line at all, which is why the reporter saw a 500 and an empty log. And
 * getOwnUserID() came back null far too easily: it only ever matched the
 * configured user name against the usernames in /api/users/, so a display
 * name, a case difference, or a response the token user cannot fully see all
 * ended in the same silent null.
 *
 * The scan does not use the user ID at all, so neither the endpoint nor the
 * queue may gate on it — and since processDocument() never read the value it
 * was handed, the plumbing is gone rather than merely ungated. getOwnUserID()
 * then had no caller; it went with the PAPERLESS_USERNAME setting it read
 * (tests/test-paperless-username.js). What stays pinned here is that the scan
 * routes resolve no user ID.
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
  'the route modules must not thread an own-user ID they never read through processDocument()'
);
assert.ok(
  !routeSource.includes('getOwnUserID'),
  'No route may call getOwnUserID — nothing in the processing path uses the result'
);

// ── Nothing left to call ─────────────────────────────────────────────────────

const paperlessService = require('../services/paperlessService');
assert.strictEqual(
  paperlessService.getOwnUserID,
  undefined,
  'getOwnUserID() had no caller and went with PAPERLESS_USERNAME'
);

console.log('PASS test-scan-now-user-id-independence');
