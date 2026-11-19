/**
 * Test: what the environment decides (Settings › System › Set by the
 * environment)
 *
 * services/environmentOverview.js builds three lists from the catalogue, the
 * environment the process started with, the values in effect, the stored
 * settings and the removed settings: the settings the environment sets, the
 * removed variables still set, and the values Zettelrobbe could not change.
 * It also decides what "Take over" stores for a setting.
 *
 * Covers:
 * 1. The lists: a setting without, with an equal and with a different stored
 *    copy; secrets never in the output; the Dockerfile's own defaults and
 *    variables outside the catalogue not listed; removed keys from either
 *    source; the OCR timeout of 30000; nothing to show; the startup line
 * 2. What Take over stores: the field's normalisation (a list), switches and
 *    free text as written, the field's own checks (cron, range, a parse
 *    error, an unknown provider), empty values, a setting without a field;
 *    the plans of both actions refuse keys the environment does not set
 * 3. The page: the topic renders its rows and its count, every link of a row
 *    lands on a field of the page, no row is a setting row "Find a setting"
 *    would index, nothing has a name; the lock note of a pinned field links
 *    to the topic and keeps its sentence word for word; the module names a
 *    row the way the field's label does
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const catalog = require('../services/settingsCatalog');
const overviewService = require('../services/environmentOverview');
const { renderSettingsPage, root } = require('./helpers/render-settings');

const {
  buildEnvironmentOverview,
  storableValue,
  planTakeOver,
  planRemoveCopy,
  startupLine,
  BLOCKED_CHANGES,
  ENVIRONMENT_TOPIC,
} = overviewService;

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

const BAKED = [
  'NODE_ENV',
  'LOG_LEVEL',
  'ANONYMIZED_TELEMETRY',
  'PAPERLESS_AI_COMMIT_SHA',
];
const SECRET = 'sk-the-secret-value-0123';
const OTHER_SECRET = 'sk-an-older-secret-9876';

/** Inputs as a container start would give them, with overrides. */
function inputs({ environment = {}, stored = {}, effective } = {}) {
  return {
    catalog: catalog.getCatalog(),
    environment,
    effective: effective || environment,
    stored,
    removed: catalog.REMOVED_SETTINGS,
    bakedKeys: BAKED,
  };
}

const rowOf = (overview, key) =>
  overview.settings.find((row) => row.key === key);
const entry = (key) => catalog.getEntry(key);

(async () => {
  // ── 1. The lists ─────────────────────────────────────────────────────────

  await test('a setting the environment sets is listed with its value in effect', () => {
    const overview = buildEnvironmentOverview(
      inputs({ environment: { SCAN_INTERVAL: '*/5 * * * *' } })
    );
    assert.deepStrictEqual(overview.settings, [
      {
        key: 'SCAN_INTERVAL',
        anchor: 'scanInterval',
        secret: false,
        value: '*/5 * * * *',
        stored: 'none',
        storedValue: null,
        canTakeOver: true,
        reason: null,
        canRemoveCopy: false,
      },
    ]);
    assert.strictEqual(overview.count, 1);
  });

  await test('a different stored copy is shown, an equal one counts as stored', () => {
    const overview = buildEnvironmentOverview(
      inputs({
        environment: { SCAN_INTERVAL: '*/5 * * * *', TAGS: 'inbox, todo' },
        // The list is stored the way a save writes it: another spelling of
        // the same value.
        stored: { SCAN_INTERVAL: '0 * * * *', TAGS: 'inbox,todo' },
      })
    );
    const scan = rowOf(overview, 'SCAN_INTERVAL');
    assert.strictEqual(scan.stored, 'different');
    assert.strictEqual(scan.storedValue, '0 * * * *');
    assert.strictEqual(scan.canTakeOver, true, 'take over replaces it');
    assert.strictEqual(scan.canRemoveCopy, false, 'it is not a copy');
    const tags = rowOf(overview, 'TAGS');
    assert.strictEqual(tags.stored, 'same');
    assert.strictEqual(tags.storedValue, null);
    assert.strictEqual(tags.canTakeOver, false, 'already stored');
    assert.strictEqual(tags.canRemoveCopy, true);
  });

  await test('an empty stored value is no copy: the start skips it', () => {
    const overview = buildEnvironmentOverview(
      inputs({
        environment: { SCAN_INTERVAL: '*/5 * * * *' },
        stored: { SCAN_INTERVAL: '  ' },
      })
    );
    assert.strictEqual(rowOf(overview, 'SCAN_INTERVAL').stored, 'none');
  });

  await test('a secret is never in the output, in effect or stored', () => {
    for (const stored of [
      {},
      { OPENAI_API_KEY: SECRET },
      { OPENAI_API_KEY: OTHER_SECRET },
    ]) {
      const overview = buildEnvironmentOverview(
        inputs({ environment: { OPENAI_API_KEY: SECRET }, stored })
      );
      const text = JSON.stringify(overview);
      assert.ok(!text.includes(SECRET), 'the value in effect');
      assert.ok(!text.includes(OTHER_SECRET), 'the stored value');
      const row = rowOf(overview, 'OPENAI_API_KEY');
      assert.strictEqual(row.secret, true);
      assert.strictEqual(row.value, null);
      assert.strictEqual(row.storedValue, null);
    }
    const different = buildEnvironmentOverview(
      inputs({
        environment: { OPENAI_API_KEY: SECRET },
        stored: { OPENAI_API_KEY: OTHER_SECRET },
      })
    );
    assert.strictEqual(rowOf(different, 'OPENAI_API_KEY').stored, 'different');
    const plan = planTakeOver(
      inputs({
        environment: { OPENAI_API_KEY: SECRET, PDF_PASSWORDS: '["a","a","b"]' },
      }),
      'all'
    );
    assert.ok(!('error' in plan));
    assert.deepStrictEqual(plan.refused, []);
    assert.strictEqual(
      plan.values.OPENAI_API_KEY,
      SECRET,
      'the plan carries it to the store'
    );
    assert.strictEqual(
      plan.values.PDF_PASSWORDS,
      '["a","b"]',
      'as a save would store it'
    );
  });

  await test('the Dockerfile defaults and variables outside the catalogue are not listed', () => {
    const overview = buildEnvironmentOverview(
      inputs({
        environment: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'debug',
          ANONYMIZED_TELEMETRY: 'yes',
          PAPERLESS_AI_COMMIT_SHA: 'abc',
          PATH: '/usr/bin',
          PUID: '1000',
          ALLOW_REMOTE_SETUP: 'yes',
          JWT_SECRET: 'x',
          PAPERLESS_AI_TYPO_KEY: 'x',
        },
      })
    );
    assert.deepStrictEqual(overview, {
      settings: [],
      unused: [],
      blocked: [],
      count: 0,
    });
  });

  await test('a removed setting is listed from the environment, the stored settings or both', () => {
    const overview = buildEnvironmentOverview(
      inputs({
        environment: { PAPERLESS_USERNAME: 'archivist' },
        stored: {
          PAPERLESS_USERNAME: 'archivist',
          AI_TEMPERATURE_GENERATION: '1.3',
        },
      })
    );
    assert.deepStrictEqual(overview.unused, [
      {
        key: 'AI_TEMPERATURE_GENERATION',
        removedIn: 'v2026.11.04',
        inEnvironment: false,
        inStored: true,
      },
      {
        key: 'PAPERLESS_USERNAME',
        removedIn: 'v2026.11.04',
        inEnvironment: true,
        inStored: true,
      },
    ]);
    assert.deepStrictEqual(overview.settings, [], 'not as a setting');
    assert.strictEqual(overview.count, 2);
  });

  await test('the removed list carries the version that removed each key', () => {
    assert.ok(catalog.REMOVED_SETTINGS.length >= 2);
    catalog.REMOVED_SETTINGS.forEach((setting) => {
      assert.strictEqual(catalog.getEntry(setting.key), undefined, setting.key);
      assert.match(setting.removedIn, /^v\d{4}\.\d{2}\.\d{2}$/);
      assert.match(setting.field, /^[a-z][A-Za-z]+$/);
    });
  });

  await test('an OCR timeout of 30000 the environment sets is a value Zettelrobbe could not change', () => {
    const pinned = buildEnvironmentOverview(
      inputs({ environment: { SETUP_OCR_VALIDATION_TIMEOUT_MS: '30000' } })
    );
    assert.strictEqual(pinned.blocked.length, 1);
    assert.strictEqual(
      pinned.blocked[0].key,
      'SETUP_OCR_VALIDATION_TIMEOUT_MS'
    );
    assert.strictEqual(pinned.blocked[0].anchor, 'ocrValidationTimeout');
    assert.match(pinned.blocked[0].text, /30 seconds/);
    assert.match(pinned.blocked[0].text, /120 seconds/);
    assert.match(pinned.blocked[0].text, /Delete the line from docker-compose/);
    assert.strictEqual(
      pinned.count,
      1,
      'the row and the case are one variable'
    );
    assert.ok(rowOf(pinned, 'SETUP_OCR_VALIDATION_TIMEOUT_MS').canTakeOver);

    const other = buildEnvironmentOverview(
      inputs({ environment: { SETUP_OCR_VALIDATION_TIMEOUT_MS: '120000' } })
    );
    assert.deepStrictEqual(other.blocked, []);
    const storedOnly = buildEnvironmentOverview(
      inputs({ stored: { SETUP_OCR_VALIDATION_TIMEOUT_MS: '30000' } })
    );
    assert.deepStrictEqual(
      storedOnly.blocked,
      [],
      'the migration raises that one'
    );
  });

  await test('the next such case is one entry', () => {
    const overview = buildEnvironmentOverview({
      ...inputs({ environment: { TOKEN_LIMIT: '4096' } }),
      blockedChanges: [
        ...BLOCKED_CHANGES,
        {
          key: 'TOKEN_LIMIT',
          applies: (value) => value === '4096',
          title: 'A small context',
          text: 'Something to do.',
        },
      ],
    });
    assert.deepStrictEqual(overview.blocked, [
      {
        key: 'TOKEN_LIMIT',
        anchor: 'tokenLimit',
        title: 'A small context',
        text: 'Something to do.',
      },
    ]);
  });

  await test('nothing to show: three empty lists and no startup line', () => {
    const overview = buildEnvironmentOverview(inputs());
    assert.deepStrictEqual(overview, {
      settings: [],
      unused: [],
      blocked: [],
      count: 0,
    });
    assert.strictEqual(startupLine(overview), '');
  });

  await test('the startup line counts the settings and says where they are listed', () => {
    const one = buildEnvironmentOverview(
      inputs({ environment: { SCAN_INTERVAL: '*/5 * * * *' } })
    );
    assert.strictEqual(
      startupLine(one),
      '[INFO] 1 setting is set by the environment. Settings, Set by the environment, lists them.'
    );
    const two = buildEnvironmentOverview(
      inputs({
        environment: {
          SCAN_INTERVAL: '*/5 * * * *',
          PAPERLESS_USERNAME: 'x',
          TAGS: 'a',
        },
      })
    );
    assert.strictEqual(
      startupLine(two),
      '[INFO] 2 settings are set by the environment. Settings, Set by the environment, lists them.'
    );
  });

  // ── 2. What Take over stores ─────────────────────────────────────────────

  await test('a list is stored the way a save of its field stores it', () => {
    assert.deepStrictEqual(storableValue(entry('TAGS'), ' inbox, , todo '), {
      ok: true,
      value: 'inbox,todo',
    });
    assert.deepStrictEqual(storableValue(entry('DATE_FORMAT'), 'yyyy-mm-dd'), {
      ok: true,
      value: 'YYYY-MM-DD',
    });
    assert.deepStrictEqual(storableValue(entry('TOKEN_LIMIT'), '064000'), {
      ok: true,
      value: '64000',
    });
    assert.deepStrictEqual(storableValue(entry('AI_PROVIDER'), ' Ollama '), {
      ok: true,
      value: 'ollama',
    });
  });

  await test('switches and free text are stored as written', () => {
    // The checkbox parser would make "no" a yes, and "true" is not read as
    // "yes" by every switch.
    assert.deepStrictEqual(storableValue(entry('ACTIVATE_TAGGING'), 'no'), {
      ok: true,
      value: 'no',
    });
    assert.deepStrictEqual(storableValue(entry('OLLAMA_THINK'), 'true'), {
      ok: true,
      value: 'true',
    });
    const prompt = 'Write key=value pairs.\nOne per line.';
    assert.deepStrictEqual(storableValue(entry('SYSTEM_PROMPT'), prompt), {
      ok: true,
      value: prompt,
    });
  });

  await test('a value the field would refuse or change is not stored, and the row says why', () => {
    const cron = storableValue(entry('RECONCILIATION_INTERVAL'), 'every hour');
    assert.strictEqual(cron.ok, false);
    assert.match(cron.reason, /not a valid cron schedule/);
    const range = storableValue(
      entry('DUPLICATES_AI_REVIEW_BATCH_SIZE'),
      '500'
    );
    assert.strictEqual(range.ok, false);
    assert.match(range.reason, /turns 500 into 100/);
    const fallback = storableValue(entry('OCR_PDF_RENDER_DPI'), '1000');
    assert.strictEqual(fallback.ok, false);
    assert.match(fallback.reason, /turns 1000 into 150/);
    const parsed = storableValue(entry('TOKEN_LIMIT'), '128k');
    assert.strictEqual(parsed.ok, false);
    assert.match(parsed.reason, /not a whole number/);
    const provider = storableValue(entry('AI_PROVIDER'), 'gemini');
    assert.strictEqual(provider.ok, false);
    assert.match(provider.reason, /openai, ollama, custom, azure, anthropic/);
    const json = storableValue(entry('CUSTOM_FIELDS'), '{custom');
    assert.strictEqual(json.ok, false);
    assert.match(json.reason, /not valid JSON/);
    const mode = storableValue(entry('COOKIE_SECURE_MODE'), 'sometimes');
    assert.strictEqual(mode.ok, false);
    assert.match(mode.reason, /Invalid Cookie Secure Mode/);
    [cron, range, parsed, provider, json, mode].forEach((result) => {
      if (!result.ok)
        assert.match(result.reason, /Correct the line in docker-compose/);
    });
  });

  await test('an empty value is not stored', () => {
    const plain = storableValue(entry('SCAN_INTERVAL'), '');
    assert.strictEqual(plain.ok, false);
    assert.match(plain.reason, /means the default/);
    const kept = storableValue(entry('AI_PROCESSED_TAG_NAME'), '');
    assert.strictEqual(kept.ok, false);
    assert.match(kept.reason, /cannot store an empty value/);
  });

  await test('a setting without a field on the page is listed and not taken over', () => {
    const overview = buildEnvironmentOverview(
      inputs({
        environment: {
          PAPERLESS_PROBE_INTERVAL_SECONDS: '30',
          CONFIG_SOURCE_MODE: 'legacy',
        },
      })
    );
    ['PAPERLESS_PROBE_INTERVAL_SECONDS', 'CONFIG_SOURCE_MODE'].forEach(
      (key) => {
        const row = rowOf(overview, key);
        assert.strictEqual(row.anchor, null);
        assert.strictEqual(row.canTakeOver, false);
        assert.match(row.reason, /no field on the settings page/);
      }
    );
  });

  await test('Take over plans: all, a list, and the refusals', () => {
    const environment = {
      SCAN_INTERVAL: '*/5 * * * *',
      TAGS: 'a, b',
      RECONCILIATION_INTERVAL: 'bad',
      PAPERLESS_PROBE_INTERVAL_SECONDS: '30',
    };
    const all = planTakeOver(inputs({ environment }), 'all');
    assert.deepStrictEqual(all, {
      values: { SCAN_INTERVAL: '*/5 * * * *', TAGS: 'a,b' },
      refused: [],
    });
    const listed = planTakeOver(inputs({ environment }), [
      'TAGS',
      'RECONCILIATION_INTERVAL',
      'PAPERLESS_PROBE_INTERVAL_SECONDS',
    ]);
    assert.ok(!('error' in listed));
    assert.deepStrictEqual(Object.keys(listed.values), ['TAGS']);
    assert.deepStrictEqual(
      listed.refused.map((refusal) => refusal.key),
      ['RECONCILIATION_INTERVAL', 'PAPERLESS_PROBE_INTERVAL_SECONDS']
    );
    for (const keys of [['NOT_A_SETTING'], ['TOKEN_LIMIT'], ['PATH']]) {
      const refused = planTakeOver(inputs({ environment }), keys);
      assert.match(refused.error, /Not a setting the environment sets/);
    }
    for (const body of [undefined, [], 'ALL', [1], {}]) {
      assert.match(
        planTakeOver(inputs({ environment }), body).error,
        /Send keys/
      );
    }
  });

  await test('Remove the stored copy plans only a copy of the value in effect', () => {
    const plan = planRemoveCopy(
      inputs({
        environment: {
          SCAN_INTERVAL: '*/5 * * * *',
          TAGS: 'a, b',
          TRUST_PROXY: '1',
        },
        stored: { SCAN_INTERVAL: '0 * * * *', TAGS: 'a,b' },
      }),
      ['TAGS', 'SCAN_INTERVAL', 'TRUST_PROXY']
    );
    assert.deepStrictEqual(plan.keys, ['TAGS']);
    assert.deepStrictEqual(
      plan.refused.map((refusal) => refusal.key),
      ['SCAN_INTERVAL', 'TRUST_PROXY']
    );
    assert.match(plan.refused[0].reason, /not the one in effect/);
    assert.match(plan.refused[1].reason, /Nothing is stored/);
    assert.match(planRemoveCopy(inputs(), 'all').error, /Send keys/);
    assert.match(
      planRemoveCopy(inputs(), ['TAGS']).error,
      /Not a setting the environment sets/
    );
  });

  // ── 3. The page ──────────────────────────────────────────────────────────

  const everyField = Object.fromEntries(
    catalog
      .getCatalog()
      .filter((setting) => setting.field)
      .map((setting) => [setting.key, setting.secret ? SECRET : 'x'])
  );
  const full = buildEnvironmentOverview(
    inputs({
      environment: {
        ...everyField,
        PAPERLESS_USERNAME: 'archivist',
        SETUP_OCR_VALIDATION_TIMEOUT_MS: '30000',
      },
      stored: { SCAN_INTERVAL: '0 * * * *', OPENAI_API_KEY: OTHER_SECRET },
    })
  );
  const html = await renderSettingsPage({ environmentOverview: full });
  const start = html.indexOf(`id="entry-${ENVIRONMENT_TOPIC}"`);
  const topicHtml = html.slice(
    start,
    html.indexOf('<section class="zr-settings-entry', start + 10)
  );

  await test('the topic sits in System before Export and lists every row', () => {
    assert.ok(start > 0, 'the topic is rendered');
    assert.ok(
      html.indexOf('data-entry-link="quickstart"') <
        html.indexOf(`data-entry-link="${ENVIRONMENT_TOPIC}"`) &&
        html.indexOf(`data-entry-link="${ENVIRONMENT_TOPIC}"`) <
          html.indexOf('data-entry-link="environment"'),
      'between Detect models and Export'
    );
    assert.match(
      html,
      /data-entry="set-by-environment" data-group="System" data-title="Set by the environment"/
    );
    full.settings.forEach((row) => {
      assert.ok(topicHtml.includes(`data-env-row="${row.key}"`), row.key);
    });
    assert.ok(topicHtml.includes('data-env-unused="PAPERLESS_USERNAME"'));
    assert.ok(
      topicHtml.includes('data-env-blocked="SETUP_OCR_VALIDATION_TIMEOUT_MS"')
    );
    assert.ok(topicHtml.includes('The stored settings hold another value'));
    assert.ok(
      topicHtml.includes('<code class="zr-envlist__value">0 * * * *</code>')
    );
    assert.ok(!html.includes(SECRET), 'no secret on the page');
    assert.ok(!html.includes(OTHER_SECRET), 'no stored secret on the page');
    assert.ok(
      topicHtml.includes('stored in <code>data/</code>'),
      'the secrets sentence'
    );
    assert.ok(topicHtml.includes('data-env-take-all'));
  });

  await test('the topic link counts the variables, and nothing without a count', async () => {
    const link = html.slice(
      html.indexOf(`data-entry-link="${ENVIRONMENT_TOPIC}"`),
      html.indexOf(
        '</a>',
        html.indexOf(`data-entry-link="${ENVIRONMENT_TOPIC}"`)
      )
    );
    assert.match(
      link,
      new RegExp(
        `data-entry-listed="set-by-environment">${full.count}<span class="zr-sr"> variables listed</span>`
      )
    );
    assert.match(
      html,
      new RegExp(`System › Set by the environment \\(${full.count}\\)</option>`)
    );
    const empty = await renderSettingsPage();
    assert.ok(!empty.includes('data-entry-listed'), 'no count without rows');
    assert.ok(
      empty.includes('Zettelrobbe could not read what the environment sets.')
    );
    const none = await renderSettingsPage({
      environmentOverview: buildEnvironmentOverview(inputs()),
    });
    assert.ok(
      none.includes("The environment sets none of Zettelrobbe's settings")
    );
    assert.ok(!none.includes('id="sec-env-settings"'));
  });

  await test('every link of the topic lands on an element of the page', () => {
    const anchors = [...topicHtml.matchAll(/href="#([^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.ok(anchors.length > 50, `only ${anchors.length} links`);
    const missing = [...new Set(anchors)].filter(
      (anchor) =>
        !html.includes(` id="${anchor}"`) &&
        !html.includes(`id="entry-${anchor}"`)
    );
    assert.deepStrictEqual(missing, []);
  });

  await test('"Find a setting" does not index the rows, and the save does not send them', () => {
    assert.ok(
      !/class="[^"]*\bzr-(field|switchrow|checktile)\b/.test(topicHtml),
      'a setting row class'
    );
    assert.ok(!/\sname="/.test(topicHtml), 'a named control');
    const buttons = [...topicHtml.matchAll(/<button\b[^>]*>/g)].map(
      (m) => m[0]
    );
    assert.ok(buttons.length > 0);
    buttons.forEach((button) => assert.match(button, /type="button"/));
  });

  await test('the lock note links to the topic and keeps its sentence', () => {
    const source = fs.readFileSync(
      path.join(root, 'public', 'js', 'settings.js'),
      'utf8'
    );
    const start = source.indexOf('function lockEnvField(');
    const end = source.indexOf(
      'function initializeRuntimeOverridePills(',
      start
    );
    const lockCode = source.slice(start, end);
    assert.ok(lockCode.includes("link.href = '#set-by-environment';"));
    assert.ok(lockCode.includes("link.textContent = 'What this means';"));
    assert.ok(
      lockCode.includes('hint.append(sentence, link);'),
      'a sibling of the sentence'
    );
    assert.ok(
      lockCode.includes('.zr-field__locked, .zr-field__locked-link'),
      'removed with the lock'
    );
    assert.ok(
      source.includes('Set by the environment (${envKey}).'),
      'the sentence'
    );
  });

  // ── The module ──────────────────────────────────────────────────────────

  const env = await import(
    pathToFileURL(
      path.join(root, 'public', 'js', 'modules', 'settings-environment.js')
    ).href
  );

  /** A stub element: classes, attributes, a parent chain and children. */
  class Stub {
    constructor(classes = [], props = {}) {
      this.classes = classes;
      this.attributes = props.attributes || {};
      this.children = [];
      this.parent = null;
      this.nodeType = props.text !== undefined ? 3 : 1;
      this.text = props.text;
      this.tag = props.tag || 'div';
    }
    append(...children) {
      children.forEach((child) => {
        child.parent = this;
        this.children.push(child);
      });
      return this;
    }
    matches(selector) {
      return selector.split(',').some((part) => {
        const one = part.trim();
        if (one.startsWith('.')) return this.classes.includes(one.slice(1));
        return one === this.tag;
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (node.nodeType === 1 && node.matches(selector)) return node;
      }
      return null;
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.nodeType === 1 && child.matches(selector)) return child;
        const deeper =
          child.nodeType === 1 ? child.querySelector(selector) : null;
        if (deeper) return deeper;
      }
      return null;
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    get childNodes() {
      return this.children;
    }
    get textContent() {
      return this.nodeType === 3
        ? this.text
        : this.children.map((child) => child.textContent).join('');
    }
  }
  const text = (value) => new Stub([], { text: value });

  await test('a row is named the way its field is labelled, in its topic', () => {
    const entryEl = new Stub(['zr-settings-entry'], {
      attributes: { 'data-title': 'Schedule and tag filters' },
    });
    const row = new Stub(['zr-field']);
    const label = new Stub([], { tag: 'label' }).append(
      text('Scan schedule (cron) '),
      new Stub(['zr-btn'], { tag: 'button' }).append(text('Help')),
      new Stub(['zr-badge']).append(text('New'))
    );
    const input = new Stub([], { tag: 'input' });
    entryEl.append(row.append(label, input));
    assert.deepStrictEqual(env.describeField(input), {
      label: 'Scan schedule (cron)',
      topic: 'Schedule and tag filters',
    });

    const tile = new Stub(['zr-checktile'], { tag: 'label' });
    const box = new Stub([], { tag: 'input' });
    tile.append(box, new Stub([], { tag: 'span' }).append(text('Tags')));
    new Stub(['zr-settings-entry'], {
      attributes: { 'data-title': 'What the AI fills in' },
    }).append(tile);
    assert.deepStrictEqual(env.describeField(box), {
      label: 'Tags',
      topic: 'What the AI fills in',
    });

    const loose = new Stub([], { tag: 'input' });
    assert.deepStrictEqual(env.describeField(loose), { label: '', topic: '' });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
