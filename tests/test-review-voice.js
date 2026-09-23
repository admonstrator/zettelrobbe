/**
 * Test: review-voice
 *
 * The two review pages speak like software. Every string a person can read
 * on them is held to eight rules; this test enforces the ones a regex can:
 *
 *  - no first person ("I", "I'd", "I'll"), and nobody addressed as "you"
 *  - no reassurance ("by itself", "on its own", "either way", "nothing here
 *    runs")
 *  - no "AI"; the thing is "the model"
 *  - no dash, neither the short one nor the long one
 *  - none of the retired labels ("Not now", "Walk me through", "agreed now")
 *
 * What is scanned: the text of a view with its comments and template code
 * taken out, and the string literals and template literals of a page
 * script with its comments taken out. Identifiers and CSS are not scanned.
 *
 * FILES lists what the rules hold for. A page joins the list when it has
 * been brought to the voice; a page that is not listed is not checked.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

const FILES = [
  'public/js/modules/review-sheet.js',
  'public/js/modules/review-mode.js',
  'views/duplicates.ejs',
  'public/js/duplicates.js',
  'views/simplify.ejs',
  'public/js/simplify.js',
];

const RULES = [
  { name: 'a dash', re: /[—–]/ },
  { name: 'the first person', re: /\bI\b|\bI'(d|ll|ve|m)\b/ },
  { name: 'the reader addressed', re: /\b(you|your|yours)\b/i },
  { name: '"AI"', re: /\bAI\b/ },
  {
    name: 'reassurance',
    re: /by itself|on its own|either way|nothing here runs|nothing runs/i,
  },
  {
    name: 'a retired label',
    re: /\bNot now\b|Walk me through|agreed now|rough guess/,
  },
];

/** A view's readable text: comments and template code removed. */
function viewText(source) {
  return source.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<%[\s\S]*?%>/g, ' ');
}

/** A script's readable text: its string and template literals, comments removed. */
function scriptStrings(source) {
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const literals =
    noComments.match(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || [];
  return literals;
}

function offenders(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const pieces = file.endsWith('.ejs')
    ? [viewText(source)]
    : scriptStrings(source);
  const found = [];
  for (const piece of pieces) {
    for (const rule of RULES) {
      const match = piece.match(rule.re);
      if (match) {
        const at = Math.max(0, match.index - 40);
        found.push(
          `${rule.name}: …${piece.slice(at, match.index + 40).replace(/\s+/g, ' ')}…`
        );
      }
    }
  }
  return found;
}

console.log('\nreview-voice');

test('The scanner reads views and scripts the way it says it does', () => {
  assert.deepStrictEqual(
    scriptStrings(
      "const a = 'x'; // I would\nconst b = `y ${z}`; /* on its own */"
    ),
    ["'x'", '`y ${z}`']
  );
  assert.strictEqual(
    viewText('<!-- I said --><p>Hi</p><% if (you) { %>').replace(/\s+/g, ''),
    '<p>Hi</p>'
  );
  const hits = offenders('tests/test-review-voice.js');
  assert.ok(
    hits.length > 0,
    'this file names the forbidden words in its own strings'
  );
});

for (const file of FILES) {
  test(`${file} speaks like software`, () => {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', file)),
      `${file} exists`
    );
    const hits = offenders(file);
    assert.deepStrictEqual(hits, [], `\n       ${hits.join('\n       ')}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
