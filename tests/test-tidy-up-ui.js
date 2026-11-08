'use strict';

/**
 * The Tidy up page: its markup, its navigation entry, and — when a browser is
 * available — its four screens against the fixtures of
 * tests/helpers/fake-tidy-up-api.js.
 *
 *  1. GET /tidy-up renders through the real router (mount-router).
 *  2. The start screen for every combination of modelAvailable and
 *     splitsAvailable, and with the locals missing.
 *  3. The nav has one Tidy up entry; the stylesheet is linked and layered.
 *  4. In a browser: start → running (steps, meter, suggestions so far) →
 *     done (counts, chips, cards, Accept the sure ones, Undo all, evidence,
 *     the split form, Details) → the four failure notices; and no horizontal
 *     scroll at phone width.
 *
 * Set TIDY_UP_SHOTS=<dir> to write a screenshot of every screen at
 * 1280×900 and 390×844.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountRouter, REPO_ROOT } = require('./helpers/mount-router');
const { SHELL_LOCALS } = require('./helpers/fake-tidy-up-api');

const API_KEY = 'test-api-key';
const SHOTS = process.env.TIDY_UP_SHOTS || '';
const MACHINERY =
  /phase|warm|calibrat|sweep|vocabulary|threshold|sensitivity|token budget|%/i;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed++;
  }
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const read = (...parts) =>
  fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');

/** Visible text of an HTML fragment, roughly: tags and comments removed. */
function textOf(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function pageRegion(html) {
  const start = html.indexOf('data-tidy-page');
  assert.ok(start > 0, 'the page root is rendered');
  return html.slice(
    start,
    html.indexOf('</main>', start) > 0
      ? html.indexOf('</main>', start)
      : undefined
  );
}

(async () => {
  const harness = await mountRouter({});
  Object.assign(harness.app.locals, SHELL_LOCALS);
  const render = (locals) =>
    new Promise((resolve, reject) =>
      harness.app.render('tidy-up', locals, (err, html) =>
        err ? reject(err) : resolve(html)
      )
    );

  try {
    /* -- 1. the route ------------------------------------------------- */
    await test('GET /tidy-up renders the page through the router', async () => {
      const res = await fetch(harness.base + '/tidy-up', {
        headers: { 'x-api-key': API_KEY },
        redirect: 'manual',
      });
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.match(html, /data-tidy-page/);
      assert.match(html, /data-module="tidy-up"/);
      assert.match(html, /\/css\/pages\/tidy-up\.css/);
      assert.match(html, /<script src="\/js\/dialogs\.js"><\/script>/);
    });

    /* -- 2. the start screen per combination ---------------------------- */
    const combos = [
      { modelAvailable: true, splitsAvailable: true, ask: true, splits: true },
      {
        modelAvailable: true,
        splitsAvailable: false,
        ask: true,
        splits: false,
      },
      {
        modelAvailable: false,
        splitsAvailable: true,
        ask: false,
        splits: false,
      },
      {
        modelAvailable: false,
        splitsAvailable: false,
        ask: false,
        splits: false,
      },
    ];
    for (const c of combos) {
      await test(`start screen, model ${c.modelAvailable ? 'yes' : 'no'}, splits ${c.splitsAvailable ? 'yes' : 'no'}`, async () => {
        const html = pageRegion(
          await render({
            version: 'test',
            modelAvailable: c.modelAvailable,
            modelLabel: 'qwen3:8b',
            splitsAvailable: c.splitsAvailable,
            counts: { tags: 412, correspondents: 138 },
            lastRun: {
              when: new Date(Date.now() - 3 * 86400000).toISOString(),
              accepted: 11,
            },
          })
        );
        assert.match(html, /Tidy up tags and correspondents/);
        assert.match(html, /Two names, one thing/);
        assert.match(html, /One tag doing two jobs/);
        assert.match(html, /Names nobody uses/);
        assert.strictEqual(
          /data-tidy-option="askModel"[^>]*checked/.test(html),
          c.ask
        );
        assert.strictEqual(
          /data-tidy-option="suggestSplits"/.test(html),
          c.splits
        );
        if (c.splits) {
          assert.ok(
            !/data-tidy-option="suggestSplits"[^>]*checked/.test(html),
            'splits are off by default'
          );
        }
        assert.strictEqual(/data-tidy-no-model/.test(html), !c.modelAvailable);
        if (c.ask) assert.match(html, /qwen3:8b answers only the pairs/);
        assert.match(
          html,
          /<button type="button" class="zr-btn zr-btn--primary tidy-go__btn" data-tidy-find>/
        );
        assert.match(
          html,
          /412 tags · 138 correspondents · last run 3 days ago, 11 accepted/
        );
        assert.match(html, /<details class="tidy-advanced"/);
        assert.match(html, /href="\/settings#duplicates"/);
        assert.match(html, /data-tidy-recent-list/);
        const words = textOf(html).replace(/Model and budget settings/g, '');
        assert.ok(
          !MACHINERY.test(words),
          `no machinery words: ${words.match(MACHINERY)}`
        );
      });
    }

    await test('start screen without any of the route locals', async () => {
      const html = pageRegion(await render({}));
      assert.match(html, /data-model-available="no"/);
      assert.match(html, /data-tidy-no-model/);
      assert.ok(!/data-tidy-facts/.test(html), 'no counts line without counts');
      assert.match(html, /data-tidy-find/);
    });

    await test('the counts line leaves out what is missing', async () => {
      const html = pageRegion(
        await render({ counts: { tags: 5 }, lastRun: null })
      );
      assert.match(html, /data-tidy-facts>5 tags<\/span>/);
    });

    /* -- 3. nav and stylesheet ----------------------------------------- */
    await test('tidy-up.css is linked after simplify.css and sits in one pages layer', () => {
      const head = read('views', 'partials', 'shell', 'head-start.ejs');
      const a = head.indexOf('/css/pages/simplify.css');
      const b = head.indexOf('/css/pages/tidy-up.css');
      assert.ok(a > 0 && b > a);
      const css = read('public', 'css', 'pages', 'tidy-up.css');
      const body = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      assert.strictEqual((body.match(/@layer /g) || []).length, 1);
      assert.ok(
        body.startsWith('@layer pages {') && body.endsWith('}'),
        'every rule is inside @layer pages'
      );
      assert.ok(
        !/#[0-9a-f]{3,8}\b/i.test(body),
        'no literal colours, tokens only'
      );
    });
  } finally {
    await harness.close();
  }

  /* -- 4. in a browser ------------------------------------------------- */
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(
      'ℹ️  no browser available; the screens were checked as markup only'
    );
  } else {
    await browserTests(playwright);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function browserTests(playwright) {
  const { startFakeTidyUpApi } = require('./helpers/fake-tidy-up-api');
  const wording = require('../services/tidyUpWording');
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (error) {
    console.log(
      `ℹ️  the browser did not start (${error.message.split('\n')[0]}); markup checks only`
    );
    return;
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const fake = await startFakeTidyUpApi({ scenario: 'start' });

  const open = async (width = 1280, query = '') => {
    const page = await browser.newPage({
      viewport: { width, height: width < 600 ? 844 : 900 },
      deviceScaleFactor: 1,
    });
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(`${fake.base}/tidy-up${query}`);
    return page;
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    const width = page.viewportSize().width;
    await page.screenshot({
      path: path.join(SHOTS, `${name}-${width}.png`),
      fullPage: true,
    });
  };
  const noSideScroll = async (page) => {
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert.ok(scroll <= client, `no horizontal scroll (${scroll} > ${client})`);
  };
  const posts = (pathName) =>
    fake.state.requests.filter(
      (r) => r.method === 'POST' && r.path === pathName
    );

  try {
    for (const width of [1280, 390]) {
      await test(`[${width}] start → running → done`, async () => {
        fake.setScenario('start');
        fake.state.requests.length = 0;
        const page = await open(width);
        await page.waitForSelector('[data-tidy-start]:not(.hidden)');
        await page.waitForSelector('[data-tidy-recent-list] .tidy-recent__row');
        await page.waitForFunction(() =>
          /about 6 requests/.test(
            document.querySelector('[data-tidy-ask-hint]').textContent
          )
        );
        await noSideScroll(page);
        await shot(page, '1-start');
        if (width < 600) {
          const columns = await page.$eval(
            '.tidy-explainers',
            (n) => getComputedStyle(n).gridTemplateColumns.split(' ').length
          );
          assert.strictEqual(columns, 1, 'explainers stack');
        }

        // Advanced, opened, with the hidden pairs listed.
        await page.click('.tidy-advanced > summary');
        await page.click('[data-tidy-hidden-toggle]');
        await page.waitForSelector('.tidy-hidden__row');
        await shot(page, '1-start-advanced');
        await page.click('.tidy-advanced > summary');

        // 2 · running
        await page.click('[data-tidy-find]');
        await page.waitForSelector('[data-tidy-run]:not(.hidden) .tidy-steps');
        assert.deepStrictEqual(posts('/api/tidy-up/runs')[0].body, {
          askModel: true,
          suggestSplits: false,
          kind: 'all',
        });
        const steps = await page.$$eval('.tidy-step', (n) =>
          n.map((s) => s.dataset.state)
        );
        assert.deepStrictEqual(
          steps,
          ['done', 'done', 'now', 'next'],
          'the split step is not drawn'
        );
        assert.ok(await page.isHidden('[data-tidy-start]'));
        const fill = await page.$eval(
          '[data-meter-fill]',
          (n) => n.style.width
        );
        assert.strictEqual(fill, '58%');
        assert.strictEqual(
          await page.textContent('[data-eta]'),
          'About a minute left'
        );
        assert.strictEqual(
          await page.textContent('[data-cost]'),
          'Cost so far: 38,400 tokens of your 200,000 budget'
        );
        await page.waitForSelector('[data-tidy-sofar]:not(.hidden)');
        assert.match(
          await page.textContent('[data-tidy-sofar]'),
          /Suggestions so far · 9/
        );
        assert.strictEqual(
          await page.locator('.tidy-card').count(),
          6,
          '5 merges and one delete card'
        );
        await noSideScroll(page);
        await shot(page, '2-running');

        // 3 · done, without a reload
        fake.setScenario('done');
        await page.waitForSelector('[data-tidy-summary]:not(.hidden)');
        assert.ok(await page.isHidden('[data-tidy-run]'));
        assert.match(
          await page.textContent('[data-tidy-summary] .tidy-title'),
          /^14 suggestions$/
        );
        assert.match(
          await page.textContent('[data-tidy-summary]'),
          /9 are sure\. 2 are likely\. 3 need a look from you\. Nothing is changed until you accept\./
        );
        const chips = await page.$$eval('.tidy-chip', (n) =>
          n.map((c) => `${c.textContent}|${c.getAttribute('aria-pressed')}`)
        );
        assert.deepStrictEqual(chips, [
          'All · 14|true',
          'Needs a look · 3|false',
          'Merge · 8|false',
          'Split · 2|false',
          'Delete · 4|false',
        ]);
        assert.match(
          await page.textContent('.tidy-filters__earlier'),
          /Decided earlier · 3/
        );
        assert.strictEqual(
          await page.locator('.tidy-card').count(),
          11,
          '8 merges, 2 splits, 1 delete card'
        );

        const unsure = page.locator('.tidy-card[data-id="merge:tags:31-32"]');
        assert.strictEqual(
          await unsure.locator('.tidy-evidence__side').count(),
          2
        );
        assert.match(
          await unsure.locator('.tidy-card__headline').textContent(),
          /Are Kontoumzug and Kontoauszug the same thing\?/
        );
        assert.strictEqual(
          await unsure.locator('.tidy-card__headline code').count(),
          2,
          'the names are chips'
        );
        assert.deepStrictEqual(
          await unsure.locator('.tidy-actions button').allTextContents(),
          ['Different, keep both', 'Same, merge them', 'Decide later']
        );

        const split = page.locator('.tidy-card[data-id="split:tags:41"]');
        await split
          .locator('select[data-act="type"] option')
          .first()
          .waitFor({ state: 'attached' });
        await page.waitForFunction(() =>
          /exists in Paperless-ngx/.test(
            document.querySelector('[data-id="split:tags:41"] select')
              .textContent
          )
        );
        assert.strictEqual(
          await split.locator('select[data-act="type"]').inputValue(),
          'Invoice'
        );
        assert.strictEqual(
          await split.locator('input[data-act="topics"]').inputValue(),
          'Car'
        );

        // Details is closed, and is the only place with a percentage.
        assert.strictEqual(
          await page.locator('details.tidy-details[open]').count(),
          0
        );
        const closedText = await page.evaluate(
          () => document.querySelector('[data-tidy-page]').innerText
        );
        const words = closedText.replace(/Model and budget settings/g, '');
        assert.ok(
          !MACHINERY.test(words),
          `no machinery words: ${words.match(MACHINERY)}`
        );
        await unsure.locator('details.tidy-details > summary').click();
        assert.match(
          await unsure.locator('details.tidy-details').innerText(),
          /Confidence\s+88%/
        );
        await noSideScroll(page);
        await shot(page, '3-suggestions');

        // The filter chips are buttons.
        await page.click('.tidy-chip[data-filter="unsure"]');
        assert.strictEqual(await page.locator('.tidy-card').count(), 3);
        await page.click('.tidy-chip[data-filter="all"]');

        // Accept the 9 sure ones: one call, a banner, one Undo.
        await page.click('[data-act="accept-sure"]');
        await page.waitForSelector('[data-tidy-banner]:not(.hidden)');
        const decide = posts('/api/tidy-up/suggestions/decide').pop().body;
        assert.strictEqual(decide.decision, 'accept');
        assert.strictEqual(decide.ids.length, 9);
        assert.match(
          await page.textContent('[data-tidy-banner]'),
          /9 changes made\s*Undo all/
        );
        assert.strictEqual(await page.locator('.tidy-line--done').count(), 9);
        assert.match(
          await page.textContent('[data-tidy-summary] .tidy-title'),
          /^5 suggestions$/
        );
        await shot(page, '3-accepted');
        await page.click('[data-act="undo-batch"]');
        await page.waitForSelector('[data-tidy-banner].hidden', {
          state: 'attached',
        });
        const undone = posts('/api/tidy-up/suggestions/undo').pop().body
          .batchId;
        assert.match(undone, /^batch-\d+$/);
        assert.ok(
          !fake.state.batches.has(undone),
          'the batch the banner named was undone'
        );
        assert.match(
          await page.textContent('[data-tidy-summary] .tidy-title'),
          /^14 suggestions$/
        );

        // Keep X instead swaps the survivor in the edits.
        await page.click('[data-id="merge:tags:11-12"] [data-act="swap"]');
        assert.match(
          await page.textContent('[data-id="merge:tags:11-12"]'),
          /Invoices stays instead/
        );
        await page.click('[data-id="merge:tags:11-12"] [data-act="accept"]');
        await page.waitForSelector('.tidy-line[data-id="merge:tags:11-12"]');
        assert.deepStrictEqual(
          posts('/api/tidy-up/suggestions/decide').pop().body.edits,
          {
            'merge:tags:11-12': { keepId: 12 },
          }
        );

        // A refused accept shows the outcome in red with Retry.
        await page.click(
          '[data-id="merge:correspondents:33-34"] [data-act="accept"]'
        );
        await page.waitForSelector('.tidy-line--failed [data-act="retry"]');
        await shot(page, '3-decided');
        assert.deepStrictEqual(page.errors, []);
        await page.close();
      });

      const FAILURES = [
        [
          'failed-unreadable',
          'unreadable',
          'warn',
          { model: 'qwen3:8b', pairsAffected: 4, pairsFine: 19 },
        ],
        [
          'failed-budget',
          'budget',
          'info',
          { budget: 200000, pairsJudged: 15, pairs: 23, pairsLeft: 8 },
        ],
        [
          'failed-unreachable',
          'unreachable',
          'danger',
          { model: 'qwen3:8b', endpoint: 'Ollama at http://ollama:11434' },
        ],
        [
          'failed-thinking',
          'thinking',
          'warn',
          { model: 'qwen3:8b', answerTokens: 1000 },
        ],
      ];
      for (const [scenario, kind, tone, ctx] of FAILURES) {
        await test(`[${width}] the ${kind} notice`, async () => {
          fake.setScenario(scenario);
          fake.state.requests.length = 0;
          const page = await open(width);
          const notice = page.locator(
            `.tidy-notice[data-failure-kind="${kind}"]`
          );
          await notice.waitFor();
          assert.match(
            await notice.getAttribute('class'),
            new RegExp(`tidy-notice--${tone}`)
          );
          const expected = wording.failureNotice(kind, ctx);
          assert.strictEqual(
            await notice.locator('.tidy-notice__title').textContent(),
            expected.title
          );
          const labels = await notice
            .locator('[data-act="failure-action"]')
            .allTextContents();
          assert.deepStrictEqual(
            labels,
            expected.actions.map((a) => a.label)
          );
          assert.match(
            await notice
              .locator('[data-act="failure-action"]')
              .first()
              .getAttribute('class'),
            /zr-btn--primary/
          );
          if (expected.settingsHint) {
            assert.strictEqual(
              await notice.locator('.tidy-notice__hint').textContent(),
              expected.settingsHint
            );
          }
          assert.strictEqual(
            await notice.locator('details').getAttribute('open'),
            null
          );
          // Whatever was found is below the notice.
          await page.waitForSelector('.tidy-card');
          if (kind === 'unreadable') {
            assert.ok(
              await page.isHidden('[data-tidy-run]'),
              'a partial failure leaves the run card away'
            );
            assert.ok(await page.isVisible('[data-tidy-notices]'));
          } else {
            assert.ok(
              await page.isVisible('[data-tidy-run] .tidy-notice'),
              'the notice stands in place of the run card'
            );
          }
          await noSideScroll(page);
          await shot(page, `4-${kind}`);
          await notice.locator('details > summary').click();
          assert.match(
            await notice.locator('.tidy-notice__technical').textContent(),
            /\S/
          );

          const first = expected.actions[0].key;
          if (
            first === 'retry-affected' ||
            first === 'continue' ||
            first === 'retry' ||
            first === 'retry-larger'
          ) {
            await notice.locator('[data-act="failure-action"]').first().click();
            await page.waitForSelector('[data-tidy-run] .tidy-steps');
            assert.strictEqual(
              posts('/api/tidy-up/runs').pop().body.action,
              first
            );
          }
          assert.deepStrictEqual(page.errors, []);
          await page.close();
        });
      }
    }

    await test('test the connection toasts what the server says', async () => {
      fake.setScenario('failed-unreachable');
      const page = await open(1280);
      await page.click('[data-key="test-connection"]');
      await page.waitForSelector('.zr-toast--danger');
      assert.match(await page.textContent('.zr-toast'), /did not answer/);
      await page.close();
    });

    await test('decide myself scrolls to the first card that needs a look', async () => {
      fake.setScenario('failed-unreadable');
      const page = await open(1280);
      await page.click('[data-key="decide-myself"]');
      assert.strictEqual(
        await page.getAttribute(
          '.tidy-chip[data-filter="unsure"]',
          'aria-pressed'
        ),
        'true'
      );
      assert.ok(await page.isVisible('.tidy-card[data-certainty="unsure"]'));
      await page.close();
    });

    await test('pick which deletes only the ticked names', async () => {
      fake.setScenario('done');
      fake.state.requests.length = 0;
      const page = await open(1280);
      await page.click('[data-group="delete-group:tags"] [data-act="pick"]');
      await page.uncheck('[data-act="tick"][value="delete:tags:52"]');
      await page.click('[data-act="delete-ticked"]');
      await page.waitForSelector('.tidy-line[data-id="delete:tags:51"]');
      assert.deepStrictEqual(
        posts('/api/tidy-up/suggestions/decide').pop().body.ids,
        ['delete:tags:51', 'delete:tags:53', 'delete:tags:54']
      );
      await page.close();
    });

    await test('without a model: no checkboxes, one grey line', async () => {
      fake.setScenario('start');
      for (const width of [1280, 390]) {
        const page = await open(width, '?model=no');
        await page.waitForSelector('[data-tidy-no-model]');
        assert.strictEqual(await page.locator('[data-tidy-option]').count(), 0);
        await shot(page, '1-start-no-model');
        await page.close();
      }
    });
  } finally {
    await browser.close();
    await fake.close();
  }
}
