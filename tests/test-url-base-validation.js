const assert = require('assert');

const { validateUrlAgainstBase } = require('../services/serviceUtils');

function main() {
  const sameHostDifferentPort = validateUrlAgainstBase(
    'http://192.168.188.65/api/tags/?page=2',
    'http://192.168.188.65:8001/api'
  );
  assert.strictEqual(sameHostDifferentPort.valid, true, 'Same host/protocol should be accepted even with port differences');
  assert.strictEqual(sameHostDifferentPort.relativePath, '/tags/?page=2', 'Relative path extraction should strip base path');

  const sameOrigin = validateUrlAgainstBase(
    'https://paperless.example.com/api/documents/?page=3',
    'https://paperless.example.com/api'
  );
  assert.strictEqual(sameOrigin.valid, true, 'Matching protocol + host should remain valid');
  assert.strictEqual(sameOrigin.relativePath, '/documents/?page=3');

  const differentHost = validateUrlAgainstBase(
    'http://evil.example.com/api/documents/?page=2',
    'http://paperless.example.com/api'
  );
  assert.strictEqual(differentHost.valid, false, 'Different host must be rejected');

  const differentProtocol = validateUrlAgainstBase(
    'https://paperless.example.com/api/documents/?page=2',
    'http://paperless.example.com/api'
  );
  assert.strictEqual(differentProtocol.valid, false, 'Different protocol must be rejected');
}

try {
  main();
  console.log('[PASS] Base URL pagination validation handles host/protocol matching correctly');
} catch (error) {
  console.error('[FAIL] Base URL pagination validation test failed:', error.message);
  process.exitCode = 1;
}
