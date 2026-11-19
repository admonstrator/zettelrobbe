/**
 * Test: the settings page keeps to the writing rules
 *
 * Every text of the settings page was rewritten so that it says what a
 * setting does to a document, in plain sentences. This test keeps the next
 * option from arriving in the old voice: the phrases the rules remove may
 * not appear in what a person reads on /settings, in the AI option catalogue
 * the page renders its AI fields from, or in the strings the page's scripts
 * show (toasts, dialogs, status lines).
 *
 * Covers:
 * 1. The rendered page: visible text plus placeholders, titles, aria-labels
 *    and alt texts, from the topic list to the save bar and the overlays;
 *    the partials as written (Quick start, Set by the environment, the
 *    switch row, the list of pills), including what only some installs see
 * 2. AI_OPTIONS: every label and help
 * 3. String literals of public/js/settings.js, the settings-* modules (Quick
 *    start, Set by the environment, the save bar among them),
 *    public/js/chip-list.js, the API key script partial and the sentences
 *    services/environmentOverview.js writes for the page
 * 4. Labels, section titles and topic names are in sentence case
 * 5. The glossary: "AI" only in "AI provider" and "What the AI fills in";
 *    an address is an address, "URL" only in the single sign-on terms;
 *    every reveal button has a name
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderSettingsPage, root } = require('./helpers/render-settings');
const { AI_OPTIONS } = require('../services/aiProviderRules');

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

/** The phrases the writing rules remove, each with the reason. */
const FORBIDDEN = [
  [/\ballows? you to\b/i, 'text about the text'],
  [/\bif enabled\b/i, 'say what the setting does instead'],
  [/\bplease note\b/i, 'opening ritual'],
  [/\bthis option\b/i, 'text about the text'],
  [/\bhere you can\b/i, 'opening ritual'],
  [/\bsimply\b/i, 'filler'],
  [/\bsuccessfully\b/i, '"Saved." is enough'],
  [/\p{L}\s*—\s*\p{L}/u, 'em dash as sentence punctuation'],
  [/\p{L} – \p{L}/u, 'en dash as sentence punctuation'],
  [/!/, 'no exclamation marks'],
  [/\bjust\b/i, 'filler'],
  [/\bensure\b/i, 'brochure word'],
  [/;\s+[a-z]/, 'two thoughts make two sentences'],
];

/** The offending phrases in `text`, as "reason: …context…". */
function offences(text) {
  const found = [];
  FORBIDDEN.forEach(([pattern, reason]) => {
    const match = pattern.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 40);
      found.push(
        `${reason}: …${text.slice(start, match.index + match[0].length + 40)}…`
      );
    }
  });
  return found;
}

const decode = (text) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** What a person reads in a piece of markup: text and readable attributes. */
function readable(markup) {
  const withoutCode = markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const attributes = [
    ...withoutCode.matchAll(
      /\s(?:placeholder|title|aria-label|alt|data-placeholder-[a-z]+)="([^"]*)"/g
    ),
  ].map((m) => m[1]);
  const text = withoutCode.replace(/<[^>]+>/g, ' ');
  return decode([text, ...attributes].join(' \n ')).replace(/[ \t]+/g, ' ');
}

/** Single-line string literals of a script, comments left out. */
function stringLiterals(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
  return [...code.matchAll(/'([^'\n\\]|\\.)*'|"([^"\n\\]|\\.)*"|`[^`\n]*`/g)]
    .map((m) => m[0].slice(1, -1))
    .filter((literal) => /[a-z] [a-z]/i.test(literal));
}

(async () => {
  const html = await renderSettingsPage();
  // From the topic list to the save bar and the overlays after it.
  const page = html.slice(
    html.indexOf('<div class="zr-settings-page"'),
    html.indexOf('window.__SETTINGS_BOOTSTRAP__')
  );
  assert.ok(page.length > 10000, 'the settings block was not found');

  // ── 1. The page ──────────────────────────────────────────────────────────

  await test('the page says none of the phrases the writing rules remove', () => {
    assert.deepStrictEqual(offences(readable(page)), []);
  });

  await test('the overlays and partials of the page say none of them either', () => {
    [
      'restart-overlay.ejs',
      'model-test-overlay.ejs',
      'settings-quick-start.ejs',
      'settings-environment.ejs',
      'settings-switch.ejs',
      'chip-list.ejs',
    ].forEach((name) => {
      // The markup as written; EJS code is not text (the strings it renders
      // are read on the page above).
      const source = fs
        .readFileSync(path.join(root, 'views', 'partials', name), 'utf8')
        .replace(/<%[\s\S]*?%>/g, ' ');
      assert.deepStrictEqual(offences(readable(source)), [], name);
    });
  });

  // ── 2. The AI option catalogue ───────────────────────────────────────────

  await test('every AI option label and help keeps to the rules', () => {
    const found = AI_OPTIONS.flatMap((option) =>
      offences(`${option.label}\n${option.help}`).map(
        (offence) => `${option.key}: ${offence}`
      )
    );
    assert.deepStrictEqual(found, []);
  });

  await test('every AI option help is made of full sentences', () => {
    AI_OPTIONS.forEach((option) => {
      assert.match(option.help, /\.$/, `${option.key}: no full stop`);
      assert.match(option.help, /^[A-Z0-9]/, `${option.key}: no capital`);
    });
  });

  // ── 3. The scripts ───────────────────────────────────────────────────────

  await test("the strings the page's scripts show keep to the rules", () => {
    const modules = fs
      .readdirSync(path.join(root, 'public', 'js', 'modules'))
      .filter((name) => /^settings-.*\.js$/.test(name))
      .map((name) => path.join('public', 'js', 'modules', name));
    const files = [
      path.join('public', 'js', 'settings.js'),
      path.join('public', 'js', 'chip-list.js'),
      path.join('views', 'partials', 'scripts', 'settings-scripts.ejs'),
      path.join('services', 'environmentOverview.js'),
      ...modules,
    ];
    const literals = files.flatMap((file) =>
      stringLiterals(fs.readFileSync(path.join(root, file), 'utf8')).map(
        (literal) => ({ file, literal })
      )
    );
    assert.ok(literals.length > 200, `only ${literals.length} strings read`);
    const found = literals.flatMap(({ file, literal }) =>
      offences(literal).map((offence) => `${file}: ${offence}`)
    );
    assert.deepStrictEqual(found, []);
    // The patterns catch the old voice they were written against.
    [
      'If enabled, scans are not processed by AI automatically',
      'Tag cache has been cleared successfully.',
      'OCR fallback disabled — test skipped.',
      'This option allows you to pick a model.',
    ].forEach((old) => assert.ok(offences(old).length, old));
  });

  // ── 4. Sentence case ─────────────────────────────────────────────────────

  await test('labels, section titles and topic names are in sentence case', () => {
    // Words that keep their capitals wherever they stand.
    const proper =
      /^(AI|API|OCR|PDF|DPI|MFA|URI|URL|ID|OpenID|Connect|JSON|HTTP|TOTP|SSO|OIDC|E-mail|Paperless-ngx|Zettelrobbe|OpenAI|OpenAI-compatible|Ollama|Azure|Anthropic|Claude|Mistral|LM|Studio|Tidy|QR|REST|S256|PKCE|\(DPI\)|\(MFA\)|\(JSON\)|\(cron\)|\(ms\)|\(seconds\)|\(optional\))$/;
    // A section title heads its block of the topic card, a section that
    // folds (Advanced options) included.
    const sectionTitles = [
      ...page.matchAll(/class="zr-settings-section__title"[^>]*>([^<]+)</g),
    ];
    assert.ok(
      sectionTitles.length >= 25,
      `only ${sectionTitles.length} section titles found`
    );
    const names = [
      ...page.matchAll(
        /class="(?:zr-field__name|zr-module__title|zr-settings-entry__title|zr-settings-section__title)"[^>]*>([^<]+)</g
      ),
      ...sectionTitles,
      ...page.matchAll(/class="zr-checktile">[\s\S]*?<span>([^<]+)<\/span>/g),
    ]
      .map((m) => decode(m[1]).trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    assert.ok(names.length > 60, `only ${names.length} labels found`);
    const shouting = names.filter((name) =>
      name
        .split(' ')
        .slice(1)
        .some((word) => /^[A-Z]/.test(word) && !proper.test(word))
    );
    assert.deepStrictEqual(shouting, []);
  });

  // ── 5. The glossary ──────────────────────────────────────────────────────

  await test('the page keeps the words of its glossary', () => {
    const text = readable(page).replace(/OIDC_[A-Z_]+ · [^\n]*/g, ' ');
    const ai = [...text.matchAll(/.{0,30}\bAI\b.{0,30}/g)]
      .map((m) => m[0])
      .filter((s) => !/\bAI provider\b|\bWhat the AI fills in\b/.test(s));
    assert.deepStrictEqual(ai, [], '"AI" outside "AI provider"');
    // URL only in the single sign-on terms (Issuer URL, Redirect URI) and
    // their hints, which carry the variable name and are taken out above.
    const url = [...text.matchAll(/.{0,30}\bURL\b.{0,30}/g)]
      .map((m) => m[0])
      .filter((s) => !/Issuer URL/.test(s));
    assert.deepStrictEqual(url, [], '"URL" where the page says address');
    const reveal = [...page.matchAll(/<button[^>]*zr-input__reveal[^>]*>/g)];
    assert.ok(reveal.length >= 5);
    reveal.forEach(([tag]) =>
      assert.match(tag, /aria-label="Show the [^"]+"/, tag)
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
