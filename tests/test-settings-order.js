/**
 * Test: the settings of a topic stand in the order of their importance
 *
 * Inside a topic: first the switch that turns the feature on, then what it
 * needs to work at all (service, address, key, model, its connection test),
 * then when and for which documents it runs, then how it behaves in detail.
 * A setting that only matters while another one is on comes right after
 * that one. This test pins the order where it was changed, so a later edit
 * cannot undo it without saying so here.
 *
 * Covers:
 * 1. OCR: three sections. The main switch with the service and the
 *    connection test; "When OCR runs" with OCR before the first analysis,
 *    the minimum text length and the switches that read the queue; "How OCR
 *    reads a document" with the prompt, the PDF pages, the timeout and the
 *    passwords. The OCR-only blocks of the two later sections name the
 *    switch they follow (data-shown-by) and are hidden while OCR is off.
 * 2. External data: the address and whether it may be a local one first,
 *    then the request; the timeout and the transform path in a section of
 *    their own that follows the switch.
 * 3. Paperless-ngx connection: the token right after the address.
 * 4. Server: network, then limits, then logging, as its title says.
 * 5. Tidy up: the model right after the switch that asks it.
 * 6. In a browser (skipped without Chrome): the blocks follow their switch,
 *    and "Find a setting" marks the switch for a match hidden behind it.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { renderSettingsPage } = require('./helpers/render-settings');
const cdp = require('./helpers/cdp');

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

/** The markup of one topic, from its card to the next one. */
function topic(html, id) {
  const start = html.indexOf(`id="entry-${id}"`);
  assert.ok(start > 0, `topic ${id} is rendered`);
  const end = html.indexOf('<section class="zr-settings-entry', start);
  return html.slice(start, end === -1 ? undefined : end);
}

/** The markup of one section of a topic, up to its closing tag. */
function section(markup, id) {
  const start = markup.indexOf(`id="${id}"`);
  assert.ok(start > 0, `section ${id} is rendered`);
  return markup.slice(start, markup.indexOf('</section>', start));
}

/** Asserts that the elements with these ids stand in this order. */
function inOrder(markup, ids, where) {
  const positions = ids.map((id) => {
    const at = markup.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `${where}: ${id} is there`);
    return at;
  });
  positions.forEach((at, index) => {
    if (index > 0) {
      assert.ok(
        positions[index - 1] < at,
        `${where}: ${ids[index - 1]} comes before ${ids[index]}`
      );
    }
  });
}

/** The opening tag of the element with this id. */
function tagOf(markup, id) {
  const match = markup.match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`));
  assert.ok(match, `${id} is rendered`);
  return match[0];
}

const isHidden = (tag) => /class="[^"]*\bhidden\b/.test(tag);

const OCR_SERVICE = [
  'mistralOcrEnabled',
  'ocrProvider',
  'ocrApiUrl',
  'ocrApiKey',
  'mistralOcrModel',
  'testOcrBtn',
];
const OCR_WHEN = [
  'ocrBeforeAi',
  'ocrBeforeAiTag',
  'ocrBeforeAiQueueNote',
  'minContentLength',
  'ocrRunRightAway',
  'ocrAutoProcessEnabled',
  'ocrAutoProcessInterval',
  'ocrAutoProcessBatchSize',
  'ocrAutoAnalyze',
];
const OCR_READING = [
  'ocrPrompt',
  'ocrPdfRenderEnabled',
  'ocrPdfRenderMaxPages',
  'ocrPdfRenderDpi',
  'ocrValidationTimeout',
  'pdfPasswords',
];

(async () => {
  const catalog = require('../services/settingsCatalog');
  const defaults = catalog.defaultsFromEnv({}, 'page');
  const off = await renderSettingsPage();
  const on = await renderSettingsPage({
    config: {
      ...defaults,
      MISTRAL_OCR_ENABLED: 'yes',
      EXTERNAL_API_ENABLED: 'yes',
    },
  });

  // ── 1. OCR ───────────────────────────────────────────────────────────────

  await test('OCR: the main switch first, then the service and its connection test', () => {
    const ocr = topic(on, 'ocr');
    inOrder(
      ocr,
      ['sec-ocr-fallback', 'sec-ocr-when', 'sec-ocr-reading'],
      'OCR'
    );
    inOrder(section(ocr, 'sec-ocr-fallback'), OCR_SERVICE, 'Reading with OCR');
    assert.ok(
      ocr.indexOf('id="mistralOcrEnabled"') <
        ocr.indexOf('<div id="ocrFieldsContainer"'),
      'the switch stands above everything it shows'
    );
  });

  await test('OCR: "When OCR runs" holds the triggers and the switches that read the queue', () => {
    const ocr = topic(on, 'ocr');
    const when = section(ocr, 'sec-ocr-when');
    assert.match(when, />When OCR runs</);
    inOrder(when, OCR_WHEN, 'When OCR runs');
    // The schedule and the batch size only matter with the cron on.
    inOrder(
      when,
      [
        'ocrAutoProcessEnabled',
        'ocrAutoProcessOptionsContainer',
        'ocrAutoProcessInterval',
      ],
      'the cron options'
    );
  });

  await test('OCR: the details come last, after every "when" switch', () => {
    const ocr = topic(on, 'ocr');
    const reading = section(ocr, 'sec-ocr-reading');
    assert.match(reading, />How OCR reads a document</);
    inOrder(reading, OCR_READING, 'How OCR reads a document');
    inOrder(
      ocr,
      [...OCR_SERVICE, ...OCR_WHEN, ...OCR_READING],
      'the whole OCR topic'
    );
  });

  await test('OCR: the OCR-only blocks of the later sections follow the Use OCR switch', () => {
    [
      'ocrBeforeAiContainer',
      'ocrAutoProcessContainer',
      'sec-ocr-reading',
    ].forEach((id) => {
      assert.match(
        tagOf(off, id),
        /data-shown-by="mistralOcrEnabled"/,
        `${id} names its switch`
      );
      assert.ok(isHidden(tagOf(off, id)), `${id} is hidden with OCR off`);
      assert.ok(!isHidden(tagOf(on, id)), `${id} shows with OCR on`);
    });
    // The minimum text length decides the failed list while OCR is off.
    const minimum = section(topic(off, 'ocr'), 'sec-ocr-when');
    assert.ok(minimum.includes('id="minContentLength"'));
    assert.ok(
      !isHidden(tagOf(off, 'sec-ocr-when')),
      'the section stays for the minimum text length'
    );
    // An old link to the OCR section still lands on its first block.
    assert.match(tagOf(off, 'sec-ocr-fallback'), /class="zr-settings-section"/);
  });

  // ── 2. External data ─────────────────────────────────────────────────────

  await test('External data: the address and the local network switch, then the request', () => {
    const external = topic(on, 'external-data');
    inOrder(
      section(external, 'sec-external-api'),
      [
        'externalApiEnabled',
        'externalApiUrl',
        'externalApiAllowPrivateIps',
        'externalApiMethod',
        'externalApiHeaders',
        'externalApiBody',
      ],
      'External API'
    );
    const answer = section(external, 'sec-external-api-answer');
    assert.match(answer, />The answer</);
    inOrder(
      answer,
      ['externalApiTimeout', 'externalApiTransform'],
      'The answer'
    );
    const tag = tagOf(off, 'sec-external-api-answer');
    assert.match(tag, /data-shown-by="externalApiEnabled"/);
    assert.ok(isHidden(tag), 'hidden while the external API is off');
    assert.ok(!isHidden(tagOf(on, 'sec-external-api-answer')));
  });

  // ── 3. Paperless-ngx connection ──────────────────────────────────────────

  await test('Paperless-ngx connection: address and token, then the addresses for links', () => {
    inOrder(
      topic(off, 'connection'),
      [
        'paperlessUrl',
        'paperlessToken',
        'paperlessDetectedUrlValue',
        'paperlessPublicUrl',
      ],
      'Connection'
    );
  });

  // ── 4. Server ────────────────────────────────────────────────────────────

  await test('Server: network, limits, logging', () => {
    inOrder(
      topic(off, 'runtime'),
      [
        'paperlessAiPort',
        'trustProxy',
        'cookieSecureMode',
        'globalRateLimitWindowMs',
        'globalRateLimitMax',
        'logLevel',
      ],
      'Server'
    );
  });

  // ── 5. Tidy up ───────────────────────────────────────────────────────────

  await test('Tidy up: the model right after the switch that asks it', () => {
    const tidy = section(topic(off, 'tidy-up'), 'sec-tidy-up');
    inOrder(
      tidy,
      ['duplicatesAiReview', 'duplicatesAiModel', 'duplicatesGuardNewNames'],
      'Tidy up'
    );
  });

  // ── 6. In a browser ──────────────────────────────────────────────────────

  if (!cdp.findChrome()) {
    console.log(
      'ℹ️  Browser checks skipped: Chrome not found (set CHROME_PATH).'
    );
  } else {
    const { mountRouter } = require('./helpers/mount-router');
    const harness = await mountRouter({
      user: { username: 'admin' },
      env: {
        PAPERLESS_API_URL: 'http://paperless.test:8000/api',
        PAPERLESS_API_TOKEN: 'token',
        AI_PROVIDER: 'ollama',
        OLLAMA_API_URL: 'http://ollama.test:11434',
        OLLAMA_MODEL: 'qwen3:8b',
        // OCR and the external API stay at their default, off: a key set
        // here counts as set by the environment and locks its switch.
        OCR_PROVIDER: 'custom',
      },
    });
    const express = require(
      path.join(__dirname, '..', 'node_modules', 'express')
    );
    harness.app.use(express.static(path.join(__dirname, '..', 'public')));
    const browser = await cdp.launchChrome();
    await browser.beforeEachPage(`(() => {
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        if (this.id === 'changelogModal') return undefined;
        return show.call(this);
      };
    })();`);
    // In the page: what is hidden, and which rows a search marks.
    const STATE = String.raw`(async (query) => {
      // Hidden inside its topic; a topic that is not open does not count.
      const hidden = (id) => {
        const by = document.getElementById(id).closest('.hidden');
        return by !== null && !by.classList.contains('zr-settings-entry');
      };
      const search = document.getElementById('settingsSearch');
      search.value = query;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const marked = [...document.querySelectorAll('.zr-settings-match')].map(
        (row) => (row.querySelector('input[id], select[id], textarea[id]') || row).id
      );
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        hidden: Object.fromEntries(
          ['ocrBeforeAi', 'minContentLength', 'ocrRunRightAway', 'ocrPdfRenderDpi', 'pdfPasswords', 'externalApiTimeout', 'externalApiUrl']
            .map((id) => [id, hidden(id)])
        ),
        marked,
      };
    })`;
    try {
      await browser.viewport(1280, 900);
      await browser.goto(`${harness.base}/settings#ocr`);
      const before = await browser.evaluate(`${STATE}('dpi')`);
      await test('browser, OCR off: the later OCR blocks are hidden, a match marks Use OCR', () => {
        assert.deepStrictEqual(before.hidden, {
          ocrBeforeAi: true,
          minContentLength: false,
          ocrRunRightAway: true,
          ocrPdfRenderDpi: true,
          pdfPasswords: true,
          externalApiTimeout: true,
          externalApiUrl: true,
        });
        assert.deepStrictEqual(before.marked, ['mistralOcrEnabledSwitch']);
      });

      const after = await browser.evaluate(`(async () => {
        document.getElementById('mistralOcrEnabledSwitch').click();
        document.getElementById('externalApiEnabled').click();
        await new Promise((r) => setTimeout(r, 100));
        return ${STATE}('dpi');
      })()`);
      await test('browser, switched on: the blocks show, a match marks its own row', () => {
        assert.deepStrictEqual(after.hidden, {
          ocrBeforeAi: false,
          minContentLength: false,
          ocrRunRightAway: false,
          ocrPdfRenderDpi: false,
          pdfPasswords: false,
          externalApiTimeout: false,
          externalApiUrl: false,
        });
        assert.deepStrictEqual(after.marked, ['ocrPdfRenderDpi']);
      });

      await browser.goto(`${harness.base}/settings#external-data`);
      const external = await browser.evaluate(`${STATE}('transform path')`);
      await test('browser, external API off: a match in the answer section marks its switch', () => {
        assert.strictEqual(external.hidden.externalApiTimeout, true);
        assert.deepStrictEqual(external.marked, ['externalApiEnabled']);
      });
    } finally {
      await browser.close();
      await harness.close();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
