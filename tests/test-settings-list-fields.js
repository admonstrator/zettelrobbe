'use strict';

/**
 * Every field that holds several values is a list of pills, never a text
 * field that wants "a, b, c" or one value per line.
 *
 * Pinned through the real router:
 *
 *   - Each list setting of the catalogue (type 'list') that the settings page
 *     shows, and the single sign-on scopes (a space-separated list stored as
 *     a string), renders as views/partials/chip-list.ejs renders it: a
 *     .zr-chips list that names its text field, Add button and hidden input,
 *     the values as pills, and the hidden input the form posts under the
 *     catalogue's field name with the value joined as before. No text field
 *     and no textarea carries that name.
 *   - A value with markup in it is escaped in the pill, in the remove
 *     button's name and in the hidden value.
 *   - A list the environment pins renders locked: field and buttons disabled.
 *   - The setup wizard's two tag lists are the same component.
 *   - No view or page script asks for a list as text any more: the phrases
 *     that did ("Comma separated", "One name per line") are gone. The PDF
 *     passwords are the one exception: a secret, written and never read back,
 *     so they stay a write-only text area.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');

const API_KEY = 'test-api-key';

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

/** The element markup around `id="<id>"`: from its "<" to its ">". */
function tagWithId(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at === -1) return null;
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('>', at);
  return html.slice(start, end + 1);
}

function listFor(html, valueId) {
  const match = html.match(
    new RegExp(
      `<div id="([^"]+)" class="zr-chips"[^>]*data-chip-value="${valueId}"[^>]*>(.*?)</div>`
    )
  );
  return match ? { open: match[0], id: match[1], pills: match[2] } : null;
}

const realExit = process.exit.bind(process);
// A successful POST /settings may schedule process.exit(); none is sent here,
// but the harness is shared with tests that do.
process.exit = () => {};

(async () => {
  // A key in the environment the process started with is pinned; the other
  // lists get their values from a save, as on a real instance.
  const harness = await mountRouter({
    env: { IGNORE_TAGS: 'pinned-one,pinned-two' },
    stub: ({ setupService }) => {
      setupService.saveConfig = async (config) => {
        Object.entries(config).forEach(([key, value]) => {
          process.env[key] = Array.isArray(value)
            ? value.join(',')
            : String(value);
        });
      };
    },
  });
  const catalog = require('../services/settingsCatalog');

  const getPage = async (url) => {
    const response = await fetch(harness.base + url, {
      redirect: 'manual',
      headers: { 'x-api-key': API_KEY },
    });
    return { status: response.status, html: await response.text() };
  };

  try {
    const saved = await fetch(harness.base + '/settings', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        showTags: 'yes',
        tags: 'inbox,<b>bold</b>',
        removeTags: 'todo',
        ignoreTitlePatterns: 'Scan_,Kontoauszug',
        usePromptTags: 'yes',
        promptTags: 'Invoice,Contract',
        oidcScopes: 'openid profile email groups',
      }),
    });
    assert.strictEqual(saved.status, 200, await saved.text());
    const { status, html } = await getPage('/settings');
    assert.strictEqual(status, 200, 'GET /settings renders');

    const listEntries = catalog
      .getCatalog()
      .filter((entry) => entry.type === 'list' && entry.page && entry.field);

    await test('the catalogue has the list settings this test expects', () => {
      assert.deepStrictEqual(
        listEntries.map((entry) => entry.key).sort(),
        [
          'IGNORE_TAGS',
          'IGNORE_TITLE_PATTERNS',
          'PROMPT_TAGS',
          'REMOVE_TAGS_AFTER_PROCESSING',
          'TAGS',
        ],
        'a new list setting is covered below without changes; update this list when one is added'
      );
    });

    const fields = [
      ...listEntries.map((entry) => ({
        key: entry.key,
        field: entry.field,
        separator: ',',
      })),
      { key: 'OIDC_SCOPES', field: 'oidcScopes', separator: ' ' },
    ];

    for (const { key, field, separator } of fields) {
      await test(`${key} is a list of pills posting "${field}"`, () => {
        const hidden = html.match(
          new RegExp(
            `<input type="hidden" id="([^"]+)" name="${field}" value="([^"]*)">`
          )
        );
        assert.ok(hidden, `a hidden input posts ${field}`);
        const list = listFor(html, hidden[1]);
        assert.ok(list, `a .zr-chips list names the hidden input ${hidden[1]}`);
        const input = list.open.match(/data-chip-input="([^"]+)"/)[1];
        const add = list.open.match(/data-chip-add="([^"]+)"/)[1];
        assert.match(
          tagWithId(html, input),
          /^<input type="text"/,
          'the list names its text field'
        );
        assert.match(
          tagWithId(html, add),
          /^<button type="button"/,
          'and its Add button'
        );
        assert.ok(
          !/name=/.test(tagWithId(html, input)),
          'the text field itself posts nothing'
        );
        if (separator === ' ') {
          assert.match(list.open, /data-chip-separator=" "/);
        } else {
          assert.ok(!/data-chip-separator/.test(list.open));
        }

        const typed = new RegExp(
          `<(?:input(?![^>]*type="hidden")|textarea)[^>]*name="${field}"`
        );
        assert.ok(
          !typed.test(html),
          `no text field or textarea carries name="${field}"`
        );

        const pills = [
          ...list.pills.matchAll(
            /<span class="zr-chip" role="listitem"><span>(.*?)<\/span>/g
          ),
        ].map((m) => m[1]);
        assert.strictEqual(
          pills.join(separator),
          hidden[2],
          'the pills are the posted value'
        );
      });
    }

    await test('the stored values arrive as pills and joined as before', () => {
      assert.ok(
        html.includes(
          '<input type="hidden" id="tags" name="tags" value="inbox,&lt;b&gt;bold&lt;/b&gt;">'
        )
      );
      assert.ok(
        html.includes(
          '<input type="hidden" id="oidcScopes" name="oidcScopes" value="openid profile email groups">'
        )
      );
      assert.ok(
        html.includes(
          '<input type="hidden" id="ignoreTitlePatterns" name="ignoreTitlePatterns" value="Scan_,Kontoauszug">'
        )
      );
    });

    await test('markup in a value is escaped in the pill and in its remove button', () => {
      const list = listFor(html, 'tags');
      assert.ok(list.pills.includes('<span>&lt;b&gt;bold&lt;/b&gt;</span>'));
      assert.ok(
        list.pills.includes('aria-label="Remove &lt;b&gt;bold&lt;/b&gt;"')
      );
      assert.ok(!list.pills.includes('<b>'), 'no tag is parsed from a value');
    });

    await test('every pill has a remove button named after its value', () => {
      const list = listFor(html, 'removeTags');
      assert.ok(
        list.pills.includes(
          '<span>todo</span><button type="button" aria-label="Remove todo">'
        )
      );
    });

    await test('a list the environment pins renders locked', () => {
      const list = listFor(html, 'ignoreTags');
      assert.match(list.open, /data-locked="true"/);
      assert.match(tagWithId(html, 'ignoreTagInput'), / disabled/);
      assert.match(tagWithId(html, 'ignoreTagAddButton'), / disabled/);
      assert.ok(
        [...list.pills.matchAll(/<button[^>]*>/g)].every((m) =>
          / disabled/.test(m[0])
        ),
        'its remove buttons are disabled'
      );
      const free = listFor(html, 'removeTags');
      assert.ok(
        !free.open.includes('data-locked'),
        'a list saved on the page stays free'
      );
      assert.ok(!/ disabled/.test(tagWithId(html, 'removeTagInput')));
    });

    await test('the page loads the shared script before its own', () => {
      const shared = html.indexOf('<script src="/js/chip-list.js"></script>');
      const own = html.indexOf('<script src="/js/settings.js');
      assert.ok(shared !== -1 && shared < own);
    });

    await test('the setup wizard lists its tags with the same component', async () => {
      const view = fs.readFileSync(
        path.join(REPO_ROOT, 'views', 'setup.ejs'),
        'utf8'
      );
      assert.ok(view.includes('<script src="/js/chip-list.js"></script>'));
      for (const [input, list] of [
        ['includeTag', 'includeTagsContainer'],
        ['excludeTagInput', 'excludeTagsContainer'],
      ]) {
        assert.match(
          view,
          new RegExp(
            `include\\('partials/chip-list', \\{\\s*id: '${input}', addId: '[^']+', listId: '${list}'`
          ),
          `${input} is a chip list`
        );
      }
      const script = fs.readFileSync(
        path.join(REPO_ROOT, 'public', 'js', 'setup.js'),
        'utf8'
      );
      assert.ok(
        !/createTagChip|renderIncludeTags|renderExcludeTags/.test(script),
        'no second chip implementation'
      );
      assert.match(
        script,
        /window\.zrChipList\.attach\(this\.includeTagsContainer/
      );
      assert.match(
        script,
        /window\.zrChipList\.attach\(this\.excludeTagsContainer/
      );
    });

    await test('no field asks for a list as text', () => {
      const files = [
        ...fs
          .readdirSync(path.join(REPO_ROOT, 'views'), { recursive: true })
          .filter((file) => String(file).endsWith('.ejs'))
          .map((file) => path.join('views', String(file))),
        ...fs
          .readdirSync(path.join(REPO_ROOT, 'public', 'js'), {
            recursive: true,
          })
          .filter((file) => String(file).endsWith('.js'))
          .map((file) => path.join('public', 'js', String(file))),
      ];
      const offending = [];
      for (const file of files) {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        // What a person reads: a placeholder, or the text of a paragraph.
        const asked =
          /(?:placeholder=["'][^"']*|<p[^>]*>[^<]*)(?:comma[- ]separated|one (?:name|tag|value|pattern|entry) per line)/i;
        text.split('\n').forEach((line, index) => {
          if (/pdfPassword|One password per line/.test(line)) return;
          if (asked.test(line)) offending.push(`${file}:${index + 1}`);
        });
      }
      assert.deepStrictEqual(offending, []);
    });

    await test('the PDF passwords stay a write-only text area', () => {
      const tag = tagWithId(html, 'pdfPasswords');
      assert.match(tag, /^<textarea/);
      assert.ok(!html.includes('data-chip-value="pdfPasswords"'));
    });
  } finally {
    await harness.close();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit = realExit;
    realExit(failed > 0 ? 1 : 0);
  }
})().catch((error) => {
  console.error('[FATAL]', error);
  process.exit = realExit;
  realExit(1);
});
