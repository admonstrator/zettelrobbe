const assert = require('assert');
const { readRouteSources } = require('./helpers/route-sources');

function main() {
  const source = readRouteSources();

  assert.ok(
    source.includes(
      "router.post('/api/key-regenerate', isAuthenticated, async (req, res) => {"
    ),
    'Expected /api/key-regenerate to require isAuthenticated middleware'
  );

  assert.ok(
    source.includes(
      "router.post('/api/webhook/document', isAuthenticated, async (req, res) => {"
    ),
    'Expected /api/webhook/document to require isAuthenticated middleware'
  );

  console.log('[PASS] Setup route auth middleware guards are enforced');
}

try {
  main();
} catch (error) {
  console.error(
    '[FAIL] Setup route auth middleware guard regression failed:',
    error.message
  );
  process.exitCode = 1;
}
