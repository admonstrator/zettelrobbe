/**
 * Test: every settings topic holds what its title says, and every address
 * that worked lands on the topic that holds the thing now
 *
 * The switches that decide what the AI fills in sat under "Restrictions and
 * limits", the prompt sat under "What the AI fills in", and the topic that
 * detects the models on an AI server was called "Quickstart auto-detect", one
 * letter away from Quick start. The topics were cut again: whole sections
 * moved, every field id, name and section id stayed. An address is resolved
 * the way modules/settings-nav.js resolves it: a topic id or an alias from
 * ENTRY_ALIASES first, otherwise the topic that contains the element with
 * that id.
 *
 * Covers:
 * 1. Titles and groups of the topics that were cut or renamed
 * 2. What each of those topics holds, and what it no longer holds
 * 3. Topic hashes, old hashes, section hashes and field ids land on the
 *    topic that holds them now
 * 4. Every link inside the settings form lands on a topic, and the Quick
 *    start steps 3 and 4 link to What the AI fills in and Prompt
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { renderSettingsPage, root } = require('./helpers/render-settings');

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

const unescape = (text) =>
  String(text)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

(async () => {
  const nav = await import(
    pathToFileURL(path.join(root, 'public', 'js', 'modules', 'settings-nav.js'))
      .href
  );
  const html = await renderSettingsPage();

  // The topics in page order, with where each one starts and ends.
  const topics = [
    ...html.matchAll(
      /<section class="zr-settings-entry[^"]*" id="entry-([a-z-]+)" data-entry="\1" data-group="([^"]*)" data-title="([^"]*)"/g
    ),
  ].map((match) => ({
    id: match[1],
    group: unescape(match[2]),
    title: unescape(match[3]),
    start: match.index,
  }));
  topics.forEach((topic, index) => {
    const next = topics[index + 1];
    topic.end = next ? next.start : html.indexOf('</form>', topic.start);
  });
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const isEntry = (id) => byId.has(id);
  const topicAt = (index) =>
    topics.find((topic) => index >= topic.start && index < topic.end) || null;
  const markupOf = (id) => html.slice(byId.get(id).start, byId.get(id).end);

  /** Where an address lands, as settings-nav.js resolves it. */
  const land = (hash) => {
    const named = nav.entryForHash(hash, isEntry);
    if (named) return named;
    const at = html.indexOf(` id="${hash}"`);
    const topic = at === -1 ? null : topicAt(at);
    return topic ? topic.id : null;
  };

  // The topic list in the side navigation, in its order.
  const navStart = html.indexOf('<nav class="zr-sectionnav zr-settings-nav"');
  const navBlock = html.slice(navStart, html.indexOf('</nav>', navStart));
  const navGroups = navBlock
    .split('<div class="zr-settings-nav__group')
    .slice(1)
    .map((block) => ({
      label: (block.match(/data-group="([^"]*)"/) || [])[1] || '',
      links: [...block.matchAll(/data-entry-link="([a-z-]+)"/g)].map(
        (m) => m[1]
      ),
    }));

  // ── 1. Titles and groups ─────────────────────────────────────────────────

  await test('the cut and renamed topics carry their new titles and groups', () => {
    const expected = {
      'ai-behavior': ['Document analysis', 'What the AI fills in'],
      prompt: ['Document analysis', 'Prompt'],
      restrictions: ['Document analysis', 'Existing names only'],
      ocr: ['Document analysis', 'OCR'],
      runtime: ['System', 'Server'],
      quickstart: ['System', 'Detect models'],
    };
    Object.entries(expected).forEach(([id, [group, title]]) => {
      const topic = byId.get(id);
      assert.ok(topic, `the page has no topic ${id}`);
      assert.strictEqual(topic.title, title, `title of #${id}`);
      assert.strictEqual(topic.group, group, `group of #${id}`);
    });
  });

  await test('no topic is called anything like "Quickstart" next to Quick start', () => {
    const titles = topics.map((topic) => topic.title);
    assert.ok(titles.includes('Quick start'));
    assert.deepStrictEqual(
      titles.filter((title) => /quick\s*start/i.test(title)),
      ['Quick start']
    );
  });

  await test('Document analysis lists the prompt right after what the AI fills in', () => {
    const analysis = navGroups.find(
      (group) => group.label === 'Document analysis'
    );
    assert.ok(analysis, 'no Document analysis group in the topic list');
    assert.deepStrictEqual(analysis.links, [
      'ai-provider',
      'ai-behavior',
      'prompt',
      'restrictions',
      'custom-fields',
      'external-data',
      'ocr',
    ]);
    const system = navGroups.find((group) => group.label === 'System');
    assert.ok(system.links.includes('runtime'), 'Server is listed in System');
    const processing = navGroups.find((group) => group.label === 'Processing');
    assert.ok(!processing.links.includes('runtime'));
  });

  // ── 2. What each topic holds ─────────────────────────────────────────────

  const namesIn = (id) =>
    [...markupOf(id).matchAll(/\sname="([A-Za-z]+)"/g)].map((m) => m[1]);
  const FILL = [
    'activateTitle',
    'activateTagging',
    'activateCorrespondents',
    'activateDocumentType',
    'activateCustomFields',
  ];
  const RESTRICT = [
    'restrictToExistingTags',
    'restrictToExistingCorrespondents',
    'restrictToExistingDocumentTypes',
  ];
  const PROMPT = [
    'systemPrompt',
    'useExistingData',
    'usePromptTags',
    'promptTags',
  ];

  await test('What the AI fills in holds the five switches and the tags written after the analysis', () => {
    const names = namesIn('ai-behavior');
    FILL.concat([
      'aiProcessedTag',
      'aiTagName',
      'removeInboxTagsAfterProcessing',
      'removeTags',
    ]).forEach((name) => assert.ok(names.includes(name), `${name} is missing`));
    PROMPT.concat(RESTRICT).forEach((name) =>
      assert.ok(!names.includes(name), `${name} does not belong here`)
    );
    const markup = markupOf('ai-behavior');
    assert.ok(
      markup.indexOf('id="sec-ai-function-limits"') <
        markup.indexOf('id="sec-analysis-tags"'),
      'the switches come first'
    );
  });

  await test('Prompt holds the prompt, the prompt tags and the existing names sent with it', () => {
    const names = namesIn('prompt');
    PROMPT.forEach((name) =>
      assert.ok(names.includes(name), `${name} is missing`)
    );
    FILL.concat(RESTRICT).forEach((name) =>
      assert.ok(!names.includes(name), `${name} does not belong here`)
    );
    assert.ok(markupOf('prompt').includes('id="sec-ai-behavior"'));
    assert.ok(markupOf('prompt').includes('id="systemPromptBtn"'));
  });

  await test('Existing names only holds the three restrictions and nothing else', () => {
    assert.deepStrictEqual(
      namesIn('restrictions').sort(),
      RESTRICT.slice().sort()
    );
  });

  await test('Schedule and tag filters and Server hold no document field that moved', () => {
    const schedule = namesIn('schedule');
    ['useExistingData', 'removeInboxTagsAfterProcessing', 'removeTags'].forEach(
      (name) => assert.ok(!schedule.includes(name), `${name} is still here`)
    );
    ['scanInterval', 'showTags', 'tags', 'ignoreTags'].forEach((name) =>
      assert.ok(schedule.includes(name), `${name} is missing`)
    );
    assert.ok(!namesIn('runtime').includes('minContentLength'));
    assert.ok(namesIn('ocr').includes('minContentLength'));
  });

  await test('the form posts the same fields, each once', () => {
    const names = [
      ...html
        .slice(html.indexOf('<form id="setupForm"'), html.indexOf('</form>'))
        .matchAll(/\sname="([A-Za-z]+)"/g),
    ].map((m) => m[1]);
    const repeated = names.filter(
      (name, index) => names.indexOf(name) !== index
    );
    assert.deepStrictEqual(repeated, [], 'a field name is used twice');
    FILL.concat(RESTRICT, PROMPT, ['minContentLength', 'removeTags']).forEach(
      (name) => assert.ok(names.includes(name), `${name} left the form`)
    );
  });

  // ── 3. Addresses ─────────────────────────────────────────────────────────

  await test('every address that worked lands on the topic that holds the thing now', () => {
    const LANDS = {
      // Topic hashes.
      'quick-start': 'quick-start',
      'ai-behavior': 'ai-behavior',
      prompt: 'prompt',
      restrictions: 'restrictions',
      runtime: 'runtime',
      quickstart: 'quickstart',
      ocr: 'ocr',
      schedule: 'schedule',
      // Hashes from before the regrouping.
      'ai-tab': 'ai-provider',
      'system-tab': 'connection',
      'ocr-tab': 'ocr',
      'troubleshooting-tab': 'caching',
      // Sections, moved or not.
      'sec-ai-function-limits': 'ai-behavior',
      'sec-analysis-tags': 'ai-behavior',
      'sec-ai-behavior': 'prompt',
      'sec-restrictions': 'restrictions',
      'sec-processing': 'schedule',
      'sec-tag-filters': 'schedule',
      'sec-runtime-controls': 'runtime',
      'sec-ocr-fallback': 'ocr',
      'sec-quickstart-auto-detect': 'quickstart',
      // Fields, by the id a link names.
      activateTagging: 'ai-behavior',
      activateTitle: 'ai-behavior',
      aiProcessedTag: 'ai-behavior',
      aiTagName: 'ai-behavior',
      removeInboxTagsAfterProcessing: 'ai-behavior',
      removeTags: 'ai-behavior',
      systemPrompt: 'prompt',
      usePromptTags: 'prompt',
      promptTags: 'prompt',
      useExistingData: 'prompt',
      restrictToExistingTags: 'restrictions',
      minContentLength: 'ocr',
      scanInterval: 'schedule',
      ignoreTags: 'schedule',
      settingsQuickstartUrl: 'quickstart',
    };
    Object.entries(LANDS).forEach(([hash, expected]) => {
      assert.strictEqual(land(hash), expected, `#${hash}`);
    });
  });

  await test('every alias names a topic that exists', () => {
    Object.entries(nav.ENTRY_ALIASES).forEach(([alias, target]) => {
      assert.ok(
        isEntry(target),
        `#${alias} points at ${target}, which is gone`
      );
    });
  });

  // ── 4. Links ─────────────────────────────────────────────────────────────

  const form = html.slice(
    html.indexOf('<form id="setupForm"'),
    html.indexOf('</form>')
  );
  const links = [...form.matchAll(/href="#([^"]+)"[^>]*>([^<]*)</g)].map(
    (m) => ({ hash: m[1], text: m[2].trim() })
  );

  await test('every link inside the settings form lands on a topic', () => {
    assert.ok(links.length > 5, 'no links found');
    const dead = links.filter((link) => !land(link.hash));
    assert.deepStrictEqual(dead, []);
  });

  await test('Quick start steps 3 and 4 link to What the AI fills in and Prompt', () => {
    const step = (name) => {
      const at = form.indexOf(`data-qs-step="${name}"`);
      const next = form.indexOf('data-qs-step="', at + 20);
      return form.slice(at, next === -1 ? undefined : next);
    };
    const fill = step('fill');
    assert.match(
      fill,
      /href="#ai-behavior">All options in What the AI fills in</
    );
    assert.ok(!fill.includes('href="#restrictions"'));
    const prompt = step('prompt');
    assert.match(prompt, /href="#prompt">[^<]*Prompt</);
    assert.ok(!prompt.includes('href="#ai-behavior"'));
    assert.match(prompt, /href="#usePromptTags"/);
    assert.strictEqual(land('usePromptTags'), 'prompt');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
