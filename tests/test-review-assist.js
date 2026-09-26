/**
 * The assistant of a review page (public/js/modules/review-assist.js) and
 * the guide it speaks from (public/js/modules/review-guide.js).
 *
 *  1. stepStates reads the phase into done, now and next
 *  2. htmlSteps draws the strip and escapes what it prints
 *  3. htmlSentence joins what and why, and says nothing for nothing
 *  4. htmlAssistStart and htmlAssistDone carry what a page hands in
 *  5. setWorkspaceWaiting dims the tools under the assistant and wakes them
 *  6. both guides are complete: every phase of the job service has a sentence
 *  7. every sentence of both guides keeps the voice
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
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function loadModule(file, names, globals = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  const keys = Object.keys(globals);
  return new Function(
    'esc',
    ...keys,
    `${source}\nreturn { ${names.join(', ')} };`
  )(esc, ...keys.map((key) => globals[key]));
}

/** The smallest element a test needs: classes, children, a query by class. */
function fakeElement(className = '') {
  const node = {
    className,
    innerHTML: '',
    children: [],
    nextSibling: null,
    classList: {
      toggle(name, on) {
        const has = node.className.split(' ').includes(name);
        if (on === true && !has)
          node.className = `${node.className} ${name}`.trim();
        if (on === false && has)
          node.className = node.className
            .split(' ')
            .filter((one) => one !== name)
            .join(' ');
        return node.className.split(' ').includes(name);
      },
      contains: (name) => node.className.split(' ').includes(name),
    },
    querySelector(selector) {
      const wanted = selector
        .replace(/^:scope > /, '')
        .split(',')[0]
        .trim();
      const byClass = wanted.startsWith('.') ? wanted.slice(1) : null;
      return (
        node.children.find((child) =>
          byClass
            ? child.className.split(' ').includes(byClass)
            : child.dataset && wanted === '[data-assist]'
        ) || null
      );
    },
    insertBefore(child, before) {
      const at = node.children.indexOf(before);
      node.children.splice(at < 0 ? node.children.length : at, 0, child);
      child.remove = () =>
        node.children.splice(node.children.indexOf(child), 1);
    },
    prepend(child) {
      node.children.unshift(child);
      child.remove = () =>
        node.children.splice(node.children.indexOf(child), 1);
    },
  };
  return node;
}

const fakeDocument = {
  createElement: (tag) => Object.assign(fakeElement(), { tag }),
};

const assist = loadModule(
  'public/js/modules/review-assist.js',
  [
    'stepStates',
    'htmlSteps',
    'htmlSentence',
    'htmlAssistStart',
    'htmlAssistDone',
    'htmlCaption',
    'setWorkspaceWaiting',
  ],
  { document: fakeDocument }
);
const guide = loadModule('public/js/modules/review-guide.js', [
  'DUPLICATES_GUIDE',
  'SIMPLIFY_GUIDE',
]);
const PHASES = require('../services/duplicateReviewJobService').PHASES;

const STEPS = [
  { key: 'scanning', label: 'Compare names' },
  { key: 'judging', label: 'Judge pairs', sub: 'request 5 of 11' },
  { key: 'finishing', label: 'Result' },
];

test('stepStates reads the phase into done, now and next', () => {
  assert.deepStrictEqual(
    assist.stepStates(STEPS, 'judging').map((step) => step.state),
    ['done', 'now', 'next']
  );
  assert.deepStrictEqual(
    assist.stepStates(STEPS, 'starting').map((step) => step.state),
    ['next', 'next', 'next'],
    'a phase before the first step leaves every step ahead'
  );
  assert.deepStrictEqual(
    assist.stepStates(STEPS, 'applying').map((step) => step.state),
    ['done', 'done', 'done'],
    'the apply comes after every step of a run'
  );
  assert.deepStrictEqual(
    assist.stepStates(STEPS, 'finishing').map((step) => step.state),
    ['done', 'done', 'now']
  );
  assert.strictEqual(
    assist.stepStates(STEPS, 'judging')[1].sub,
    'request 5 of 11'
  );
  assert.deepStrictEqual(assist.stepStates(null, 'judging'), []);
});

test('htmlSteps draws the strip and escapes what it prints', () => {
  const html = assist.htmlSteps(
    assist.stepStates(
      [
        { key: 'a', label: 'A <b>' },
        { key: 'b', label: 'B', sub: '2 & 3' },
      ],
      'b'
    )
  );
  assert.ok(html.startsWith('<ol class="zr-steps">'));
  assert.ok(html.includes('zr-steps__step--done'));
  assert.ok(html.includes('zr-steps__step--now'));
  assert.ok(html.includes('#i-check'), 'a done step is ticked');
  assert.ok(
    html.includes('<span class="zr-steps__mark">2</span>'),
    'the current step is numbered'
  );
  assert.ok(html.includes('A &lt;b&gt;') && html.includes('2 &amp; 3'));
  assert.strictEqual(assist.htmlSteps([]), '');
});

test('htmlSentence joins what and why, and says nothing for nothing', () => {
  assert.strictEqual(
    assist.htmlSentence(
      { what: 'The model reads pairs.', why: 'Spelling is not enough.' },
      '7 so far.'
    ),
    '<p class="zr-runmeter__sentence">The model reads pairs. Spelling is not enough. 7 so far.</p>'
  );
  assert.strictEqual(
    assist.htmlSentence({ what: 'Only this.', why: '' }),
    '<p class="zr-runmeter__sentence">Only this.</p>'
  );
  assert.strictEqual(assist.htmlSentence(null), '');
  assert.strictEqual(assist.htmlSentence({ what: '', why: '' }, ''), '');
});

test('htmlAssistStart and htmlAssistDone carry what a page hands in', () => {
  const start = assist.htmlAssistStart({
    icon: 'i-wand',
    title: 'Merge <things>',
    what: 'One line.',
    htmlButton: '<button id="x">Go</button>',
    factsId: 'facts',
    facts: '',
  });
  assert.ok(start.startsWith('<div class="zr-assist zr-assist--start">'));
  assert.ok(
    start.includes('#i-wand') && start.includes('Merge &lt;things&gt;')
  );
  assert.ok(
    start.includes('<p class="zr-assist__facts hidden" id="facts"></p>'),
    'an empty facts line is hidden'
  );
  assert.ok(start.includes('<button id="x">Go</button>'));
  const withFacts = assist.htmlAssistStart({
    icon: 'i-split',
    title: 't',
    what: 'w',
    htmlButton: '',
    facts: 'Last run',
  });
  assert.ok(withFacts.includes('<p class="zr-assist__facts">Last run</p>'));

  const done = assist.htmlAssistDone({
    headline: '54 scanned · 13 merges proposed',
    htmlCost: '<span>7 requests</span>',
    next: ['Tick & untick.', 'Press Merge.'],
    htmlActions: '<button>Merge 13</button>',
  });
  assert.ok(done.startsWith('<div class="zr-assist zr-assist--done">'));
  assert.ok(
    done.includes(
      '<p class="zr-assist__headline">54 scanned · 13 merges proposed</p>'
    )
  );
  assert.ok(
    done.includes('<p class="zr-assist__cost"><span>7 requests</span></p>')
  );
  assert.ok(
    done.includes(
      '<ul class="zr-assist__next"><li>Tick &amp; untick.</li><li>Press Merge.</li></ul>'
    )
  );
  assert.ok(
    done.includes(
      '<div class="zr-assist__actions"><button>Merge 13</button></div>'
    )
  );
  const bare = assist.htmlAssistDone({ headline: 'x' });
  assert.ok(
    !bare.includes('zr-assist__cost') && !bare.includes('zr-assist__next')
  );
  assert.strictEqual(
    assist.htmlCaption(' Pair any two names. '),
    '<p class="zr-module__caption">Pair any two names.</p>'
  );
  assert.strictEqual(assist.htmlCaption(''), '');
});

test('setWorkspaceWaiting dims the tools under the assistant and wakes them', () => {
  const root = fakeElement('dup-page');
  const top = fakeElement('zr-assist');
  const tool = fakeElement('zr-module');
  root.children.push(top, tool);
  top.nextSibling = tool;
  assist.setWorkspaceWaiting(root, true);
  assert.ok(root.classList.contains('zr-workspace--waiting'));
  assert.strictEqual(
    root.children[1].className,
    'zr-workspace__note',
    'the line sits right under the assistant'
  );
  assert.ok(
    root.children[1].innerHTML.includes(
      'The tools below wake up with the result.'
    )
  );
  assist.setWorkspaceWaiting(root, true, 'Scanning first.');
  assert.strictEqual(
    root.children.length,
    3,
    'one line, however often it is set'
  );
  assert.ok(root.children[1].innerHTML.includes('Scanning first.'));
  assist.setWorkspaceWaiting(root, false);
  assert.ok(!root.classList.contains('zr-workspace--waiting'));
  assert.strictEqual(root.children.length, 2, 'the line goes with the wait');
  assist.setWorkspaceWaiting(null, true);
});

test('both guides are complete: every phase of the job service has a sentence', () => {
  const shared = ['starting', 'warming-up', 'finishing', 'applying'];
  const review = ['scanning', 'evidence', 'sweeping', 'judging', 'escalating'];
  const simplify = ['vocabulary', 'splitting', 'ordering'];
  const all = Object.values(PHASES);
  assert.deepStrictEqual(
    [...shared, ...review, ...simplify].sort(),
    [...all].sort(),
    'the job service grew a phase the guides do not know'
  );
  for (const key of [...shared, ...review]) {
    assert.ok(
      guide.DUPLICATES_GUIDE.phases[key],
      `Duplicates has no sentence for ${key}`
    );
    assert.ok(guide.DUPLICATES_GUIDE.phases[key].what.trim() !== '');
  }
  for (const key of [...shared, ...simplify]) {
    assert.ok(
      guide.SIMPLIFY_GUIDE.phases[key],
      `Simplify has no sentence for ${key}`
    );
    assert.ok(guide.SIMPLIFY_GUIDE.phases[key].what.trim() !== '');
  }
  for (const one of [guide.DUPLICATES_GUIDE, guide.SIMPLIFY_GUIDE]) {
    assert.ok(
      one.start.title &&
        one.start.what &&
        one.start.whatWithoutModel &&
        one.start.button
    );
    assert.ok(
      one.steps.length >= 4 && one.steps.every((step) => step.key && step.label)
    );
    assert.ok(
      one.steps.every((step) => one.phases[step.key]),
      'every step is a phase with a sentence'
    );
    assert.ok(one.done.next.length >= 3);
    assert.ok(Object.keys(one.sections).length >= 3);
    assert.ok(Object.isFrozen(one));
  }
});

test('every sentence of both guides keeps the voice', () => {
  const RULES = [
    { name: 'a dash', re: /[—–]/ },
    { name: 'the first person', re: /\bI\b|\bI'(d|ll|ve|m)\b/ },
    { name: 'the reader addressed', re: /\b(you|your|yours)\b/i },
    { name: '"AI"', re: /\bAI\b/ },
    {
      name: 'reassurance',
      re: /by itself|on its own|either way|nothing here runs|nothing runs/i,
    },
    { name: 'an exclamation', re: /!/ },
  ];
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(walk);
  };
  walk(guide.DUPLICATES_GUIDE);
  walk(guide.SIMPLIFY_GUIDE);
  assert.ok(strings.length > 60);
  for (const text of strings) {
    for (const rule of RULES) {
      assert.ok(!rule.re.test(text), `${rule.name} in: ${text}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
