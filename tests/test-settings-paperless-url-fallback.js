const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const setupRoutePath = path.join(process.cwd(), 'routes', 'setup.js');
  const source = fs.readFileSync(setupRoutePath, 'utf8');

  assert.ok(
    source.includes('const hasPaperlessUrlInput = hasValue(paperlessUrl);'),
    'Expected POST /settings to detect whether paperlessUrl input is present'
  );

  assert.ok(
    source.includes(
      "const normalizedCurrentPaperlessUrl = (\n      currentConfig.PAPERLESS_API_URL || ''\n    ).replace(/\\/api$/, '');"
    ),
    'Expected POST /settings to normalize existing PAPERLESS_API_URL as fallback source'
  );

  assert.ok(
    source.includes(
      'const effectivePaperlessUrl = hasPaperlessUrlInput\n      ? paperlessUrl\n      : normalizedCurrentPaperlessUrl;'
    ),
    'Expected POST /settings to derive effectivePaperlessUrl fallback when URL input is missing'
  );

  assert.ok(
    source.includes(
      'await setupService.validatePaperlessConfig(\n        effectivePaperlessUrl,\n        effectivePaperlessToken\n      );'
    ),
    'Expected Paperless validation to run against effectivePaperlessUrl'
  );

  assert.ok(
    source.includes(
      'if (hasPaperlessUrlInput)\n      updatedConfig.PAPERLESS_API_URL = effectivePaperlessUrl;'
    ),
    'Expected POST /settings to persist PAPERLESS_API_URL only when user submitted a new URL'
  );

  console.log(
    '[PASS] POST /settings keeps effective Paperless URL fallback for managed/omitted paperlessUrl input'
  );
}

try {
  main();
} catch (error) {
  console.error(
    '[FAIL] Settings paperless URL fallback regression failed:',
    error.message
  );
  process.exitCode = 1;
}
