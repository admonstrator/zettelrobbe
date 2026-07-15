const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const setupRoutePath = path.join(process.cwd(), 'routes', 'setup.js');
  const source = fs.readFileSync(setupRoutePath, 'utf8');

  assert.ok(
    source.includes(
      "router.post(\n  '/api/settings/reset-local-overrides',\n  isAuthenticated,\n  cacheClearLimiter,\n  express.json(),\n  async (req, res) => {"
    ),
    'Expected reset-local-overrides endpoint to parse JSON request bodies'
  );

  assert.ok(
    source.includes('const username = getAuthenticatedSettingsUsername(req);'),
    'Expected reset-local-overrides endpoint to require interactive user sessions'
  );

  assert.ok(
    source.includes(
      "const currentPassword = String(req.body?.currentPassword || '').trim();"
    ),
    'Expected reset-local-overrides endpoint to read currentPassword from request body'
  );

  assert.ok(
    source.includes(
      'const validPassword = await bcrypt.compare(\n        currentPassword,\n        user.password\n      );'
    ),
    'Expected reset-local-overrides endpoint to validate current password'
  );

  assert.ok(
    source.includes("error: 'Current password is invalid.'"),
    'Expected reset-local-overrides endpoint to reject invalid passwords'
  );

  assert.ok(
    source.includes('restart: true,'),
    'Expected reset-local-overrides success response to include restart flag'
  );

  assert.ok(
    source.includes('setTimeout(() => {') &&
      source.includes('process.exit(0);'),
    'Expected reset-local-overrides endpoint to trigger process restart after response'
  );

  console.log(
    '[PASS] Reset local overrides endpoint enforces password confirmation in interactive sessions'
  );
}

try {
  main();
} catch (error) {
  console.error(
    '[FAIL] Reset local overrides password guard regression failed:',
    error.message
  );
  process.exitCode = 1;
}
