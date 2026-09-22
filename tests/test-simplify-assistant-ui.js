/**
 * Test: simplify-assistant-ui
 *
 * The Simplify tags page as an assistant rather than a control panel: the
 * proposal read as baskets, one decision at a time where the model was unsure,
 * and the cost of a run said out loud before, during and after it.
 *
 * What is checked here at contract level is the ground both page scripts
 * stand on — the shared stylesheet is linked, layered and complete. The page's
 * own surfaces are checked below that as they are built.
 *
 * Covers:
 *  1. the shell links css/review.css, and the kit is one @layer components
 *     block that paints with tokens rather than hex codes
 *  2. the classes both pages agree on exist
 *  3. the kit works at phone width
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

const HEAD = read('views', 'partials', 'shell', 'head-start.ejs');
const CSS = read('public', 'css', 'review.css');

test('The shell links the review kit', () => {
  assert.ok(
    HEAD.includes('href="/css/review.css"'),
    'head-start.ejs does not link css/review.css'
  );
  assert.ok(
    HEAD.indexOf('href="/css/tokens.css"') <
      HEAD.indexOf('href="/css/review.css"'),
    'tokens.css declares the layer order and has to come first'
  );
});

test('The kit is one layered block and paints with tokens', () => {
  assert.strictEqual(
    (CSS.match(/@layer [a-z]+ \{/g) || []).length,
    1,
    'stylelint scopes its duplicate checks per layer block, so keep one'
  );
  assert.ok(
    CSS.includes('@layer components {'),
    'the kit belongs in components, under the page stylesheets'
  );
  const hex = CSS.match(/:\s*#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepStrictEqual(
    hex,
    [],
    `the kit has to use tokens so both themes follow: ${hex.join(', ')}`
  );
});

test('The classes both pages build on are there', () => {
  [
    '.zr-ledger',
    '.zr-ledger__value',
    '.zr-tokenbar__track',
    '.zr-tokenbar__seg--prompt',
    '.zr-tokenbar__seg--answer',
    '.zr-tokenbar__seg--thinking',
    '.zr-basket',
    '.zr-basket--ask',
    '.zr-basket__line',
    '.zr-basket__sentence',
    '.zr-decision',
    '.zr-decision__sides',
    '.zr-decision__side--from',
    '.zr-decision__note',
    '.zr-decision__actions',
    '.zr-consequence',
    '.zr-consequence--free',
    '.zr-runbar__fill',
    '.zr-reqlog__row--warn',
    '.zr-btn--stacked',
    '.zr-btn__sub',
  ].forEach((selector) => {
    assert.ok(
      CSS.includes(`${selector} {`) || CSS.includes(`${selector},`),
      `${selector} has no rule of its own`
    );
  });
});

test('A decision card works at phone width', () => {
  assert.match(
    CSS,
    /@media \(max-width: 720px\) \{[\s\S]*\.zr-decision__sides \{\s+flex-direction: column;/,
    'the two sides of a decision have to stack on a phone'
  );
  assert.match(
    CSS,
    /\.zr-decision__keys \{\s+display: none;/,
    'keyboard hints on a phone are a lie'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
