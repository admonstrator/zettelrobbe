const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const settingsTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    'utf8'
  );

  assert(
    settingsTemplate.includes('<option value="longtext">Long Text</option>'),
    'Expected the custom field type selector to include Long Text'
  );
}

try {
  main();
  console.log('[PASS] Long Text custom field option is available in settings');
} catch (error) {
  console.error('[FAIL] Long Text custom field UI test failed:', error.message);
  process.exitCode = 1;
}
