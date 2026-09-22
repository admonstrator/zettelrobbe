/**
 * Test: duplicates-assistant-ui
 *
 * The Duplicates page as an assistant: what a scan found read as baskets, one
 * pair at a time where it matters, and every button saying what it writes
 * before it is pressed.
 *
 * At contract level this checks the one thing that rots quietly: the
 * styleguide. /styleguide is where anyone looks before inventing a class, so
 * a kit component that never appears there does not exist in practice. The
 * page's own surfaces are checked below that as they are built.
 *
 * Covers:
 *  1. the styleguide has a section for the review kit and links to it
 *  2. every component of the kit is shown there at least once
 *  3. the examples are real controls, not divs with a click handler
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const ROOT = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const GUIDE = read('views', 'styleguide.ejs');

test('The styleguide has the section and a way to reach it', () => {
  assert.ok(
    GUIDE.includes('id="sg-review"'),
    'no review section in the styleguide'
  );
  assert.ok(
    GUIDE.includes('href="#sg-review"'),
    'the section is not in the styleguide navigation'
  );
  assert.ok(
    GUIDE.includes('css/review.css'),
    'the section does not say which file it documents'
  );
});

test('Every component of the kit is shown once', () => {
  [
    'zr-ledger',
    'zr-tokenbar__seg--prompt',
    'zr-tokenbar__seg--thinking',
    'zr-basket__mark--ok',
    'zr-basket--ask',
    'zr-basket__choices',
    'zr-decision__sides',
    'zr-decision__side--from',
    'zr-decision__note',
    'zr-decision__keys',
    'zr-consequence',
    'zr-consequence--free',
    'zr-runbar__fill',
    'zr-reqlog__row--live',
    'zr-reqlog__row--warn',
    'zr-btn--stacked',
    'zr-btn__sub',
  ].forEach((className) => {
    assert.ok(
      GUIDE.includes(className),
      `${className} is not shown in the styleguide`
    );
  });
});

test('The examples are real controls', () => {
  const section = GUIDE.slice(
    GUIDE.indexOf('id="sg-review"'),
    GUIDE.indexOf('id="sg-toasts"')
  );
  assert.ok(section.length > 500, 'the section is suspiciously short');
  const buttons = section.match(/<button[^>]*>/g) || [];
  assert.ok(
    buttons.length >= 8,
    `only ${buttons.length} buttons in the examples`
  );
  buttons.forEach((button) => {
    assert.ok(
      button.includes('type="button"'),
      `a button without a type submits something one day: ${button}`
    );
  });
  assert.ok(
    !/<div[^>]+onclick/i.test(section),
    'a div with a click handler is not reachable with a keyboard'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
