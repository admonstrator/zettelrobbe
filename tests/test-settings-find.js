/**
 * Test: "Find a setting" in the topic list of the settings page
 *
 * The settings page has some twenty topics and more than a hundred settings.
 * "Find a setting" sits at the top of the topic list: typing narrows the list
 * to the topics with a match and says how many settings each one holds,
 * choosing a topic marks its matches, and clearing the field restores the
 * list. The matching is pure (public/js/modules/settings-find.js), so this
 * test runs the shipped code; modules/settings-nav.js reads the page into it.
 *
 * Covers:
 * 1. Words: every word of the query has to occur, in any case and any order
 * 2. What a setting is found by: label, hint, the choices of its list, and
 *    the environment variable with or without underscores
 * 3. Counting: per topic, rows that mark the same element count once; a topic
 *    whose own name matches is listed with a count of 0
 * 4. The sentence under the field
 * 5. The page: the field, its status line and the count of every link in the
 *    navigation block; the old search box is gone; settings-nav.js uses the
 *    module and clears on Escape
 * 6. A featured entry (`featured: true`) is listed above the groups, set
 *    apart, with "All options" after it, and first in the phone picker
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const TOPICS = [
  { id: 'quick-start', title: 'Quick start', group: 'Quick start' },
  { id: 'ai-provider', title: 'AI provider', group: 'Document analysis' },
  { id: 'ocr', title: 'OCR fallback', group: 'Document analysis' },
  { id: 'schedule', title: 'Schedule and tag filters', group: 'Processing' },
  { id: 'changelog', title: 'Changelog', group: 'System' },
];

const ITEMS = [
  {
    topic: 'ai-provider',
    label: 'Document length limit',
    hint: 'How much of a document is sent to the model, in tokens.',
    envKeys: ['TOKEN_LIMIT'],
    mark: 'row-token-limit',
  },
  {
    topic: 'ai-provider',
    label: 'Answer length',
    hint: 'The longest answer the model may write, in tokens.',
    envKeys: ['RESPONSE_TOKENS'],
    mark: 'row-answer',
  },
  {
    topic: 'ai-provider',
    label: 'AI provider',
    hint: 'The service that reads your documents.',
    choices: ['OpenAI', 'Ollama', 'Anthropic'],
    mark: 'row-provider',
  },
  // Two hidden OCR fields that both mark the switch that shows them.
  {
    topic: 'ocr',
    label: 'OCR Model',
    hint: 'Grouped by vision support.',
    envKeys: ['MISTRAL_OCR_MODEL'],
    mark: 'row-enable-ocr',
  },
  {
    topic: 'ocr',
    label: 'OCR Prompt',
    hint: 'Sent to the vision model with every document.',
    envKeys: ['OCR_PROMPT'],
    mark: 'row-enable-ocr',
  },
  {
    topic: 'schedule',
    label: 'Scan Interval (Cron Format)',
    hint: '',
    envKeys: ['SCAN_INTERVAL'],
    mark: 'row-scan-interval',
  },
  {
    topic: 'quick-start',
    label: 'When it runs',
    hint: 'Every 30 minutes',
    envKeys: ['SCAN_INTERVAL'],
    mark: 'row-quick-schedule',
  },
];

(async () => {
  const find = await import(
    path.join(root, 'public', 'js', 'modules', 'settings-find.js')
  );
  const { queryWords, searchText, findSettings, describeResult } = find;
  const run = (query) => findSettings(query, TOPICS, ITEMS);
  const listed = (result) =>
    Object.fromEntries(result.topics.map((topic) => [topic.id, topic.count]));

  // ── 1. Words ──────────────────────────────────────────────────────────────

  await test('a query is its words, lower case, without empty ones', () => {
    assert.deepStrictEqual(queryWords('  Token   LIMIT '), ['token', 'limit']);
    assert.deepStrictEqual(queryWords(''), []);
    assert.deepStrictEqual(queryWords(null), []);
  });

  await test('a blank query finds nothing and is not a search', () => {
    ['', '   ', null].forEach((query) => {
      const result = run(query);
      assert.strictEqual(result.active, false);
      assert.deepStrictEqual(result.topics, []);
      assert.strictEqual(result.total, 0);
      assert.strictEqual(describeResult(result, query), '');
    });
  });

  await test('every word has to occur, in any order and any case', () => {
    assert.deepStrictEqual(listed(run('LIMIT document')), { 'ai-provider': 1 });
    assert.deepStrictEqual(listed(run('limit nothing-like-this')), {});
  });

  // ── 2. What a setting is found by ─────────────────────────────────────────

  await test('label and hint are what a person sees and what is searched', () => {
    assert.deepStrictEqual(listed(run('tokens')), { 'ai-provider': 2 });
    assert.deepStrictEqual(listed(run('vision')), { ocr: 1 });
  });

  await test('the choices of a list find it ("ollama" finds the provider list)', () => {
    const result = run('ollama');
    assert.deepStrictEqual(listed(result), { 'ai-provider': 1 });
    assert.strictEqual(result.items[0].mark, 'row-provider');
  });

  await test('an environment variable is found with and without underscores', () => {
    assert.ok(searchText(ITEMS[5]).includes('scan_interval'));
    assert.ok(searchText(ITEMS[5]).includes('scan interval'));
    assert.deepStrictEqual(listed(run('SCAN_INTERVAL')), {
      'quick-start': 1,
      schedule: 1,
    });
    assert.deepStrictEqual(listed(run('scan interval')), {
      'quick-start': 1,
      schedule: 1,
    });
  });

  // ── 3. Counting ───────────────────────────────────────────────────────────

  await test('rows that mark the same element count once', () => {
    const result = run('ocr');
    assert.deepStrictEqual(listed(result), { ocr: 1 });
    assert.strictEqual(result.items.length, 2, 'both settings matched');
    assert.strictEqual(result.total, 1, 'one row is marked');
  });

  await test('a topic whose name matches is listed even without a matching row', () => {
    const result = run('changelog');
    assert.deepStrictEqual(listed(result), { changelog: 0 });
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(listed(run('document analysis')), {
      'ai-provider': 0,
      ocr: 0,
    });
  });

  await test('topics keep the order of the list', () => {
    const result = run('model');
    assert.deepStrictEqual(
      result.topics.map((topic) => topic.id),
      ['ai-provider', 'ocr']
    );
  });

  // ── 4. The sentence ───────────────────────────────────────────────────────

  await test('the sentence under the field says what was found', () => {
    assert.strictEqual(
      describeResult(run('tokens'), 'tokens'),
      '2 settings in 1 topic.'
    );
    assert.strictEqual(
      describeResult(run('scan interval'), 'scan  interval '),
      '2 settings in 2 topics.'
    );
    assert.strictEqual(
      describeResult(run('vision'), 'vision'),
      '1 setting in 1 topic.'
    );
    assert.strictEqual(
      describeResult(run('cronjob'), ' cronjob '),
      'No setting matches “cronjob”.'
    );
    assert.strictEqual(
      describeResult(run('changelog'), 'changelog'),
      'No setting matches. One topic has “changelog” in its name.'
    );
    assert.strictEqual(
      describeResult(run('document analysis'), 'document analysis'),
      'No setting matches. 2 topics have “document analysis” in their name.'
    );
  });

  await test('the sentences keep to the writing rules', () => {
    ['tokens', 'cronjob', 'changelog', 'document analysis'].forEach((query) => {
      const sentence = describeResult(run(query), query);
      assert.ok(
        !/[!—–]/.test(sentence),
        `no exclamation mark or dash: ${sentence}`
      );
      assert.ok(/\.$/.test(sentence), `a full stop: ${sentence}`);
    });
  });

  // ── 5. The page ───────────────────────────────────────────────────────────

  const view = read('views', 'settings.ejs');
  const navJs = read('public', 'js', 'modules', 'settings-nav.js');
  const navBlock = view.slice(
    view.indexOf('<div class="zr-settings-page"'),
    view.indexOf('<div class="zr-col zr-col--loose zr-settings__main">')
  );

  await test('the field sits above the topic list, labelled "Find a setting"', () => {
    assert.ok(
      navBlock.includes('<div class="zr-settings-find" role="search">')
    );
    assert.ok(
      navBlock.includes(
        '<label for="settingsSearch" class="zr-settings-find__label">Find a setting</label>'
      )
    );
    assert.match(
      navBlock,
      /<input type="search" class="zr-input" data-el="search" id="settingsSearch"/
    );
    assert.ok(navBlock.includes('aria-describedby="settingsSearchStatus"'));
    assert.match(
      navBlock,
      /<p class="zr-settings-find__status" id="settingsSearchStatus" data-el="search-status" role="status" aria-live="polite"><\/p>/
    );
    assert.ok(
      navBlock.indexOf('zr-settings-find') <
        navBlock.indexOf('<nav class="zr-sectionnav zr-settings-nav"'),
      'the field comes before the list'
    );
  });

  await test('every topic link carries a count the search fills in', () => {
    const link = navBlock.slice(
      navBlock.indexOf('<a href="#<%= entry.id %>"'),
      navBlock.indexOf('</a>')
    );
    assert.ok(
      link.includes(
        '<span class="zr-settings-nav__count hidden" data-entry-count="<%= entry.id %>"></span>'
      )
    );
    assert.ok(link.includes('data-entry-dirty="<%= entry.id %>"'));
  });

  await test('the old search box with its result list is gone', () => {
    assert.ok(!view.includes('settingsSearchResults'));
    assert.ok(!view.includes('zr-settings-search'));
    assert.ok(!navJs.includes('settingsSearchOption'));
  });

  await test('settings-nav.js matches through the shared module and clears on Escape', () => {
    assert.ok(
      navJs.includes(
        "import { describeResult, findSettings } from './settings-find.js';"
      )
    );
    assert.match(navJs, /event\.key === 'Escape' && search\.value/);
    assert.match(navJs, /root\.toggleAttribute\('data-searching', searching\)/);
    assert.match(
      navJs,
      /details\.open = true;/,
      'a closed disclosure is opened'
    );
    assert.match(
      navJs,
      /scrollIntoView/,
      'the first match is brought into view'
    );
  });

  // ── 6. A featured entry ───────────────────────────────────────────────────

  await test('a featured entry is listed above the groups, then "All options"', async () => {
    const { mountRouter } = require('./helpers/mount-router');
    const ejs = require('ejs');
    const harness = await mountRouter({ user: { username: 'admin' } });
    try {
      // The locals GET /settings renders with, to render the view once more
      // with one entry flagged the way the Quick start topic will be.
      let captured = null;
      const original = harness.app.render.bind(harness.app);
      harness.app.render = (name, options, callback) => {
        if (name === 'settings') captured = options;
        return original(name, options, callback);
      };
      const response = await fetch(`${harness.base}/settings`, {
        headers: harness.authHeaders(),
      });
      assert.strictEqual(response.status, 200);
      const plain = await response.text();
      assert.ok(captured, 'GET /settings rendered the view');
      assert.ok(!plain.includes('zr-settings-nav__featured'));
      assert.ok(
        !plain.includes('All options'),
        'no caption without a featured entry'
      );

      const viewPath = path.join(root, 'views', 'settings.ejs');
      const source = fs
        .readFileSync(viewPath, 'utf8')
        .replace(
          "{ id: 'display', title: 'Display' }",
          "{ id: 'display', title: 'Display', featured: true }"
        );
      assert.ok(source.includes("title: 'Display', featured: true"));
      // What Express hands the view: the app's locals, the response's
      // (theme and the rest of the shell) and the route's own.
      const locals = {
        ...harness.app.locals,
        ...(captured._locals || {}),
        ...captured,
      };
      const html = ejs.render(source, locals, { filename: viewPath });

      const nav = html.slice(
        html.indexOf('<nav class="zr-sectionnav zr-settings-nav"'),
        html.indexOf(
          '</nav>',
          html.indexOf('<nav class="zr-sectionnav zr-settings-nav"')
        )
      );
      const featured = nav.indexOf(
        '<a href="#display" class="zr-settings-nav__featured" data-entry-link="display"'
      );
      assert.ok(featured !== -1, 'the featured link has its class');
      assert.ok(
        featured < nav.indexOf('All options') &&
          nav.indexOf('All options') < nav.indexOf('Basics'),
        'featured entry, then the caption, then the groups'
      );
      assert.strictEqual(
        (nav.match(/data-entry-link="display"/g) || []).length,
        1,
        'listed once, not again under its group'
      );
      assert.ok(
        nav.includes('data-entry-link="connection"'),
        'Basics keeps its other entry'
      );

      const picker = html.slice(
        html.indexOf('<select id="settingsEntrySelect"'),
        html.indexOf(
          '</select>',
          html.indexOf('<select id="settingsEntrySelect"')
        )
      );
      const options = [
        ...picker.matchAll(/<option value="([a-z-]+)"[^>]*>([^<]*)</g),
      ];
      assert.strictEqual(options[0][1], 'display', 'first in the phone picker');
      assert.strictEqual(options[0][2], 'Display', 'by its title alone');
      assert.ok(picker.includes('>Basics › Paperless-ngx connection<'));
    } finally {
      await harness.close();
    }
  });

  await test('the stylesheet sets the featured entry apart, open or not', () => {
    const css = read('public', 'css', 'pages', 'settings.css').replace(
      /\s+/g,
      ' '
    );
    assert.match(css, /\.zr-settings-nav__featured \{[^}]*border: 1px solid/);
    assert.match(
      css,
      /\.zr-settings-nav__featured\[aria-current='page'\] \{[^}]*background: var\(--zr-brand\)/
    );
    assert.match(css, /\.zr-settings-nav__caption \{/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
