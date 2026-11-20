/**
 * Settings: Quick start.
 *
 * The first topic of the settings page: the six decisions Zettelrobbe needs,
 * each one row that says in words what is set and opens in place with the few
 * controls that decide it.
 *
 * The real fields stay the single source. A control here carries no name and a
 * data-mirror="<id of the real field>": it shows the real field's value, writes
 * every edit into it and fires the input/change event the page listens to on
 * the real field. Dirty tracking, the unsaved dots, the restart note, the
 * provider switch and the environment locks therefore behave as if the real
 * field had been edited, and the save sends the real fields only. The mirror's
 * own event stops at the mirror, and modules/settings-form.js leaves everything
 * inside [data-mirror-scope] out of its count, so one edit counts once.
 *
 * A mirror follows its real field in three more ways: disabled with it (and
 * with the "Set by the environment" note of a pinned field), hidden while the
 * real field sits in a hidden block of its topic (another provider's fields),
 * and refilled when the real select gets new options (Fetch models).
 *
 * The summaries are pure functions of plain values, tested against this file
 * by tests/test-settings-quick-start.js; the module reads the real fields,
 * hands them in and writes the words.
 */

import { describeSchedule } from './scan-schedule.js';

/** The six steps, in the order the page shows them. */
export const QUICK_START_STEPS = Object.freeze([
  'paperless',
  'ai',
  'fill',
  'prompt',
  'ocr',
  'run',
]);

/**
 * What each AI provider needs before it can analyse a document, named by the
 * id of the real field: a server address, an API key, a model. The custom
 * provider's key is optional (a local server needs none), so it is not listed.
 */
export const PROVIDER_NEEDS = Object.freeze({
  openai: Object.freeze({ key: 'openaiKey', model: 'openaiModel' }),
  ollama: Object.freeze({ url: 'ollamaUrl', model: 'ollamaModel' }),
  custom: Object.freeze({ url: 'customBaseUrl', model: 'customModel' }),
  azure: Object.freeze({
    url: 'azureEndpoint',
    key: 'azureApiKey',
    model: 'azureDeploymentName',
  }),
  anthropic: Object.freeze({ key: 'anthropicApiKey', model: 'anthropicModel' }),
});

/** The fields the AI may fill in, by the id of their switch, in page order. */
export const FILL_FIELDS = Object.freeze([
  Object.freeze({ id: 'activateTitle', name: 'title' }),
  Object.freeze({ id: 'activateTagging', name: 'tags' }),
  Object.freeze({ id: 'activateCorrespondents', name: 'correspondent' }),
  Object.freeze({ id: 'activateDocumentType', name: 'document type' }),
  Object.freeze({ id: 'activateCustomFields', name: 'custom fields' }),
]);

/** The schedules offered by name; anything else is an own cron expression. */
export const SCHEDULE_PRESETS = Object.freeze([
  '*/5 * * * *',
  '*/15 * * * *',
  '*/30 * * * *',
  '0 * * * *',
  '0 */6 * * *',
]);

/**
 * When OCR reads its queue, as one answer: the two switches OCR_RUN_RIGHT_AWAY
 * (`rightAway`) and OCR_AUTO_PROCESS_ENABLED (`schedule`) in one picker. The
 * first is the one to recommend: a document gets OCR and its analysis without
 * waiting for a schedule.
 */
export const OCR_TIMINGS = Object.freeze([
  Object.freeze({
    value: 'right-away',
    rightAway: true,
    schedule: false,
    label: 'Right after the scan (recommended)',
    words: 'read right away',
    hint: 'A document that needs OCR is read as soon as the scan, webhook or rescan that found it has finished, and analysed right after. Nothing waits for a schedule.',
  }),
  Object.freeze({
    value: 'schedule',
    rightAway: false,
    schedule: true,
    label: 'On its own schedule',
    words: 'read on a schedule',
    hint: 'OCR reads the queue on a schedule of its own, every 15 minutes unless you change it below. A document can wait for the scan and then for the OCR schedule.',
  }),
  Object.freeze({
    value: 'both',
    rightAway: true,
    schedule: true,
    label: 'Right after the scan, and on a schedule',
    words: 'read right away and on a schedule',
    hint: 'OCR reads a document right after the scan that found it, and the schedule reads whatever is still waiting, for example after a restart.',
  }),
  Object.freeze({
    value: 'manual',
    rightAway: false,
    schedule: false,
    label: 'Only when I start it',
    words: 'read when started by hand',
    hint: 'Documents wait in the OCR queue until someone presses "Process All Pending" on the OCR page.',
  }),
]);

/**
 * The answer the two switches give.
 *
 * @param {{rightAway: boolean, schedule: boolean}} input
 * @returns {string} a value of OCR_TIMINGS
 */
export function ocrTiming({ rightAway, schedule }) {
  const match = OCR_TIMINGS.find(
    (timing) =>
      timing.rightAway === Boolean(rightAway) &&
      timing.schedule === Boolean(schedule)
  );
  return match ? match.value : 'manual';
}

/**
 * The AI providers whose model OCR can use as well, and where the OCR fields
 * take it from, by the id of the real field. Claude OCR falls back to the key
 * and address of the AI provider when its own are empty, so only the model is
 * copied; a local server gets its address and model. A custom server with an
 * API key is left out: its key never reaches the page, so it cannot be copied.
 * OpenAI and Azure have no OCR provider of their own.
 */
export const SAME_MODEL_SOURCES = Object.freeze({
  anthropic: Object.freeze({
    ocrProvider: 'anthropic',
    url: '',
    model: 'anthropicModel',
  }),
  ollama: Object.freeze({
    ocrProvider: 'custom',
    url: 'ollamaUrl',
    model: 'ollamaModel',
  }),
  custom: Object.freeze({
    ocrProvider: 'custom',
    url: 'customBaseUrl',
    model: 'customModel',
    keyless: true,
  }),
});

/**
 * An address as compared for "same server": no case, no trailing slash, no
 * API path (/v1, /api) the OCR side may have appended.
 *
 * @param {string} url
 * @returns {string}
 */
export function serverAddress(url) {
  return clean(url)
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\/(v1|api)$/, '')
    .replace(/\/+$/, '');
}

/**
 * What the OCR fields hold when OCR uses the analysis model, or null when the
 * AI provider cannot lend its model to OCR.
 *
 * @param {{aiProvider: string, values?: Record<string, string>, customKeyPresent?: boolean}} input
 *   `values` by the ids named in SAME_MODEL_SOURCES
 * @returns {{ocrProvider: string, url: string, model: string}|null}
 */
export function sameModelPlan({
  aiProvider,
  values = {},
  customKeyPresent = false,
}) {
  const id = clean(aiProvider).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SAME_MODEL_SOURCES, id)) {
    return null;
  }
  const source =
    /** @type {{ocrProvider: string, url: string, model: string, keyless?: boolean}} */ (
      SAME_MODEL_SOURCES[/** @type {keyof typeof SAME_MODEL_SOURCES} */ (id)]
    );
  if (source.keyless && customKeyPresent) return null;
  return {
    ocrProvider: source.ocrProvider,
    url: source.url ? clean(values[source.url]) : '',
    model: clean(values[source.model]),
  };
}

/**
 * Whether the OCR fields hold what the plan says. A stored "ollama" provider
 * is the local server the page calls "custom"; an empty local OCR address
 * falls back to the Ollama address (services/mistralOcrService.js).
 *
 * @param {{ocrProvider: string, url: string, model: string}|null} plan
 * @param {{ocrProvider: string, ocrUrl?: string, ocrModel: string, ollamaUrl?: string}} ocr
 * @returns {boolean}
 */
export function usesSameModel(
  plan,
  { ocrProvider, ocrUrl = '', ocrModel, ollamaUrl = '' }
) {
  if (!plan || !plan.model) return false;
  const provider =
    clean(ocrProvider).toLowerCase() === 'ollama'
      ? 'custom'
      : clean(ocrProvider).toLowerCase();
  if (provider !== plan.ocrProvider || clean(ocrModel) !== plan.model)
    return false;
  if (plan.ocrProvider === 'anthropic') return !clean(ocrUrl);
  const address = serverAddress(ocrUrl || ollamaUrl);
  return Boolean(address) && address === serverAddress(plan.url);
}

/** Read out with the row, since the mark in front of it is a picture. */
export const STATE_WORDS = Object.freeze({
  done: 'Done.',
  open: 'Still open.',
  problem: 'Needs attention.',
  skipped: 'Optional, not in use.',
});

const clean = (value) => String(value ?? '').trim();

/**
 * @typedef {'done'|'open'|'problem'|'skipped'} StepState
 * @typedef {{state: StepState, text: string}} StepSummary
 */

/**
 * An address as the summary shows it: without user name and password, should
 * someone have written them into it.
 *
 * @param {string} url
 * @returns {string}
 */
export function withoutCredentials(url) {
  return clean(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/**
 * The names of a comma-joined list, as the chip fields store it.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function listFromCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * What the dashboard's connectivity probe says about Paperless-ngx, or null
 * when it says nothing yet.
 *
 * @param {{usable?: boolean|null, reachable?: boolean|null, authorized?: boolean|null}|null|undefined} paperless
 *   the `paperless` block of /api/processing-status
 * @returns {'ok'|'rejected'|'unreachable'|null}
 */
export function connectionState(paperless) {
  if (!paperless || typeof paperless !== 'object') return null;
  if (paperless.usable === true) return 'ok';
  if (paperless.reachable === true && paperless.authorized === false) {
    return 'rejected';
  }
  if (paperless.reachable === false) return 'unreachable';
  return null;
}

/**
 * Step 1: how Zettelrobbe reaches Paperless-ngx. The token is never shown,
 * only whether there is one. `connection` is the probe's word on the stored
 * configuration, so the caller passes null once the address or the token is
 * edited. Address and token finish the step: Zettelrobbe signs in with the
 * token alone.
 *
 * @param {{url: string, tokenPresent: boolean, connection?: 'ok'|'rejected'|'unreachable'|null}} input
 * @returns {StepSummary}
 */
export function summarizePaperless({ url, tokenPresent, connection = null }) {
  const address = withoutCredentials(url);
  if (!address) return { state: 'open', text: 'No address yet' };
  if (!tokenPresent) {
    return { state: 'open', text: `${address} · no API token yet` };
  }
  if (connection === 'rejected') {
    return {
      state: 'problem',
      text: `${address} · Paperless-ngx rejects the API token`,
    };
  }
  if (connection === 'unreachable') {
    return { state: 'problem', text: `${address} · not reachable` };
  }
  const text = connection === 'ok' ? `${address} · connected` : address;
  return { state: 'done', text };
}

/**
 * Step 2: the provider and its model. `values` holds the real fields named in
 * PROVIDER_NEEDS; `stored` says which keys are stored on the server, so an
 * empty key field still counts when a key is kept. The key itself is never
 * part of the text.
 *
 * @param {{provider: string, providerLabel?: string, values?: Record<string, string>, stored?: Record<string, boolean>}} input
 * @returns {StepSummary}
 */
export function summarizeAi({
  provider,
  providerLabel = '',
  values = {},
  stored = {},
}) {
  const id = clean(provider).toLowerCase();
  const needs = Object.prototype.hasOwnProperty.call(PROVIDER_NEEDS, id)
    ? PROVIDER_NEEDS[/** @type {keyof typeof PROVIDER_NEEDS} */ (id)]
    : null;
  if (!needs) return { state: 'open', text: 'No provider chosen yet' };

  const label = clean(providerLabel) || id;
  const value = (/** @type {string|undefined} */ field) =>
    field ? clean(values[field]) : '';

  if ('url' in needs && !value(needs.url)) {
    return { state: 'open', text: `${label} · no server address yet` };
  }
  if ('key' in needs && !value(needs.key) && !stored[needs.key]) {
    return { state: 'open', text: `${label} · no API key yet` };
  }
  const model = value(needs.model);
  if (!model) {
    return {
      state: 'open',
      text: `${label} · ${id === 'azure' ? 'no deployment yet' : 'no model chosen yet'}`,
    };
  }
  return { state: 'done', text: `${label} · ${model}` };
}

/**
 * Step 3: which fields of a document the AI fills in.
 *
 * @param {{on: Record<string, boolean>, customFieldCount?: number}} input
 *   `on` by the switch ids of FILL_FIELDS
 * @returns {StepSummary}
 */
export function summarizeFill({ on, customFieldCount = 0 }) {
  const names = FILL_FIELDS.filter((field) => on[field.id]).map((field) =>
    field.id === 'activateCustomFields' && !customFieldCount
      ? 'custom fields (none set up)'
      : field.name
  );
  if (!names.length) return { state: 'open', text: 'Nothing switched on' };
  const text = names.join(', ');
  return { state: 'done', text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * The start of an own prompt, as the row quotes it.
 *
 * @param {string} prompt
 * @param {number} [max]
 * @returns {string}
 */
export function promptExcerpt(prompt, max = 48) {
  const line =
    String(prompt ?? '')
      .split(/\r?\n|\\n/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Step 4: what the model is told. With prompt tags on the model only matches
 * those tags and the prompt text is not sent (services/analysisPrompt.js).
 *
 * @param {{usePromptTags: boolean, promptTags?: string[], systemPrompt?: string}} input
 * @returns {StepSummary}
 */
export function summarizePrompt({
  usePromptTags,
  promptTags = [],
  systemPrompt = '',
}) {
  if (usePromptTags) {
    return promptTags.length
      ? { state: 'done', text: `Prompt tags only: ${promptTags.join(', ')}` }
      : { state: 'open', text: 'Prompt tags are on, but no tag is listed' };
  }
  const excerpt = promptExcerpt(systemPrompt);
  return excerpt
    ? { state: 'done', text: `Your own prompt: “${excerpt}”` }
    : { state: 'done', text: 'No prompt of your own' };
}

/**
 * Step 5: OCR, which is optional. Off it is not counted as done, and not as
 * missing either. `mode` is OCR_BEFORE_AI (off, tagged, all); an unknown value
 * reads as off, as config/config.js reads it. `timing` is a value of
 * OCR_TIMINGS: a complete summary ends with its words. Without it, `rightAway`
 * (OCR_RUN_RIGHT_AWAY) alone adds "read right away". `undecided` is set while
 * OCR was just switched on and nobody has said yet when it runs.
 *
 * @param {{enabled: boolean, mode?: string, tag?: string, providerLabel?: string, needsKey?: boolean, rightAway?: boolean, timing?: string, undecided?: boolean}} input
 * @returns {StepSummary}
 */
export function summarizeOcr({
  enabled,
  mode = 'off',
  tag = '',
  providerLabel = '',
  needsKey = false,
  rightAway = false,
  timing = '',
  undecided = false,
}) {
  if (!enabled) return { state: 'skipped', text: 'Off' };
  const label = clean(providerLabel) || 'OCR';
  if (needsKey) return { state: 'open', text: `${label} · no API key yet` };
  if (undecided) {
    return { state: 'open', text: `${label} · choose when OCR runs` };
  }
  const chosen = OCR_TIMINGS.find((item) => item.value === timing);
  const tail = chosen
    ? ` · ${chosen.words}`
    : rightAway
      ? ' · read right away'
      : '';
  const done = (when) => ({
    state: 'done',
    text: `${label} · ${when}${tail}`,
  });
  const when = clean(mode).toLowerCase();
  if (when === 'tagged') {
    const name = clean(tag);
    return name
      ? done(`before the analysis of documents tagged ${name}`)
      : { state: 'open', text: `${label} · no OCR tag yet` };
  }
  if (when === 'all') {
    return done('before the analysis of every new document');
  }
  return done('when the text is too short or the analysis fails');
}

/**
 * A scan schedule in words, or the expression itself when it has none.
 *
 * @param {string} expression
 * @returns {string}
 */
export function scheduleWords(expression) {
  const raw = clean(expression).replace(/\s+/g, ' ');
  if (!raw) return '';
  const words = describeSchedule(raw);
  return words && words !== raw ? words : `Cron ${raw}`;
}

/**
 * Step 6: when Zettelrobbe looks for documents, and which ones it takes. With
 * "only documents with certain tags" and no tag, a scan finds nothing
 * (services/paperlessService.js), so that is still open.
 *
 * @param {{automatic: boolean, scanInterval: string, onlyTagged: boolean, tags?: string[]}} input
 * @returns {StepSummary}
 */
export function summarizeRun({
  automatic,
  scanInterval,
  onlyTagged,
  tags = [],
}) {
  if (!automatic) return { state: 'done', text: 'Automatic scans are stopped' };
  const when = scheduleWords(scanInterval);
  if (!when) return { state: 'open', text: 'No schedule yet' };
  if (onlyTagged) {
    return tags.length
      ? {
          state: 'done',
          text: `${when} · only documents tagged ${tags.join(', ')}`,
        }
      : { state: 'open', text: `${when} · only tagged documents, no tag yet` };
  }
  return { state: 'done', text: `${when} · every document not analysed yet` };
}

/**
 * How many steps are done.
 *
 * @param {Record<string, StepSummary>} summaries
 * @returns {number}
 */
export function countDone(summaries) {
  return QUICK_START_STEPS.filter(
    (id) => summaries[id] && summaries[id].state === 'done'
  ).length;
}

/**
 * The words the counter shows.
 *
 * @param {number} done
 * @param {number} [total]
 * @returns {string}
 */
export function progressText(done, total = QUICK_START_STEPS.length) {
  return `${done} of ${total} done`;
}

/* --- mirrors -------------------------------------------------------------- */

/**
 * The real field a mirror stands for. A switch row keeps its yes/no value in a
 * hidden input that a visible switch drives (partials/settings-switch.ejs);
 * the person flips the switch, so a mirror of the hidden input binds to it.
 *
 * @param {string} id
 * @param {Document} [doc]
 * @returns {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null}
 */
export function resolveMirrorTarget(id, doc = document) {
  const field = /** @type {any} */ (doc.getElementById(id));
  if (!field) return null;
  if (field.type === 'hidden') {
    return /** @type {any} */ (
      doc.querySelector(`[data-switch-target="${id}"]`)
    );
  }
  return field;
}

/**
 * Whether the real field is offered at the moment: not inside a block its
 * topic hides (another provider's fields, the OCR options while OCR is off).
 * The topic itself is hidden whenever another one is shown, which does not
 * count.
 *
 * @param {Element} real
 * @returns {boolean}
 */
export function isAvailable(real) {
  const hidden = real.closest('.hidden');
  if (!hidden) return true;
  const entry = real.closest('.zr-settings-entry');
  return !entry || hidden === entry || !entry.contains(hidden);
}

/**
 * The sentence a pinned real field carries (settings.js lockEnvField), or ''
 * when the field is free. A field disabled for another reason (the prompt
 * while prompt tags are on) has none.
 *
 * @param {any} real
 * @param {Set<string>} [lockedKeys] keys from #setupForm[data-locked-env-keys]
 * @returns {string}
 */
export function lockNote(real, lockedKeys = new Set()) {
  if (!real || !real.disabled) return '';
  const tile = real.closest('.zr-checktile');
  if (tile && /^Set by the environment/.test(tile.title || '')) {
    return tile.title;
  }
  const container = real.closest('.zr-field, .zr-switchrow');
  const sentence = container && container.querySelector('.zr-field__locked');
  if (sentence) {
    return clean(sentence.textContent).replace(/^·\s*/, '');
  }
  const key = real.dataset && real.dataset.envKey;
  return key && lockedKeys.has(key) ? `Set by the environment (${key}).` : '';
}

function kindOf(control) {
  if (control.type === 'checkbox') return 'checkbox';
  if (control.tagName === 'SELECT') return 'select';
  return 'text';
}

function optionSignature(select) {
  return Array.from(select.options || [], (option) => {
    const parent = option.parentElement;
    const group = parent && parent.tagName === 'OPTGROUP' ? parent.label : '';
    return `${group}\u0001${option.value}\u0001${option.text}`;
  }).join('\u0002');
}

/**
 * Binds one control to the real field it mirrors, both ways.
 *
 * Real to mirror: on the real field's input and change events, and whenever
 * pull() is called (the module calls it after anything on the page changed).
 * Nothing is dispatched on the mirror, so there is no loop.
 *
 * Mirror to real: an input or change event of the mirror writes the value into
 * the real field and fires that same event on it, once, bubbling, as a person's
 * edit would; the mirror's own event stops there. A disabled real field (pinned
 * by the environment) is never written.
 *
 * @param {any} control the mirror: input, select or textarea, no name
 * @param {any} real the real field of the form
 * @returns {{control: any, real: any, pull: () => void, destroy: () => void}}
 */
export function bindMirror(control, real) {
  const kind = kindOf(control);
  let optionsSeen = null;

  function pull() {
    if (kind === 'select') {
      const signature = optionSignature(real);
      if (signature !== optionsSeen) {
        control.replaceChildren(
          ...Array.from(real.children, (node) => node.cloneNode(true))
        );
        optionsSeen = signature;
      }
      if (control.selectedIndex !== real.selectedIndex) {
        control.selectedIndex = real.selectedIndex;
      }
    } else if (kind === 'checkbox') {
      if (control.checked !== real.checked) control.checked = real.checked;
    } else {
      if (control.value !== real.value) control.value = real.value;
      if (
        typeof real.placeholder === 'string' &&
        control.placeholder !== real.placeholder
      ) {
        control.placeholder = real.placeholder;
      }
    }
    if (control.disabled !== real.disabled) control.disabled = real.disabled;
  }

  function push(event) {
    event.stopPropagation();
    if (real.disabled) {
      pull();
      return;
    }
    if (kind === 'select') real.selectedIndex = control.selectedIndex;
    else if (kind === 'checkbox') real.checked = control.checked;
    else real.value = control.value;
    real.dispatchEvent(new Event(event.type, { bubbles: true }));
    // A listener on the real field may have changed it again.
    pull();
  }

  control.addEventListener('input', push);
  control.addEventListener('change', push);
  real.addEventListener('input', pull);
  real.addEventListener('change', pull);
  pull();

  return {
    control,
    real,
    pull,
    destroy() {
      control.removeEventListener('input', push);
      control.removeEventListener('change', push);
      real.removeEventListener('input', pull);
      real.removeEventListener('change', pull);
    },
  };
}

/* --- the topic ------------------------------------------------------------ */

function readJson(text, fallback) {
  try {
    const parsed = JSON.parse(text || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const sameText = (element, text) => element && element.textContent === text;

function setText(element, text) {
  if (element && !sameText(element, text)) element.textContent = text;
}

export default function settingsQuickStart(root) {
  const doc = root.ownerDocument || document;
  const form = root.closest('form');
  const entry = root.closest('.zr-settings-entry');
  const stored = { ...readJson(root.dataset.storedSecrets, {}) };
  const locked = readJson(form && form.dataset.lockedEnvKeys, []);
  const lockedKeys = new Set(Array.isArray(locked) ? locked.map(String) : []);

  const field = (id) => /** @type {any} */ (doc.getElementById(id));
  const valueOf = (id) => {
    const element = field(id);
    return element ? String(element.value ?? '') : '';
  };
  const isOn = (id) => {
    const element = field(id);
    if (!element) return false;
    return element.type === 'checkbox'
      ? element.checked
      : clean(element.value).toLowerCase() === 'yes';
  };
  const selectedLabel = (id) => {
    const element = field(id);
    const option = element && element.selectedOptions?.[0];
    return option ? clean(option.textContent) : '';
  };
  const secretPresent = (id) => Boolean(clean(valueOf(id)) || stored[id]);

  /* steps ------------------------------------------------------------------ */

  const steps = new Map();
  root.querySelectorAll('[data-qs-step]').forEach((element) => {
    const toggle = element.querySelector('[data-qs-toggle]');
    const body =
      toggle && doc.getElementById(toggle.getAttribute('aria-controls'));
    if (!toggle || !body) return;
    steps.set(element.dataset.qsStep, {
      element,
      toggle,
      body,
      summary: element.querySelector('[data-qs-summary]'),
      stateWord: element.querySelector('[data-qs-state]'),
      action: element.querySelector('[data-qs-action]'),
      reals: new Set(),
    });
  });

  let openId = null;
  let summaries = {};

  function actionWord(id) {
    if (id === openId) return 'Close';
    const state = summaries[id] && summaries[id].state;
    return state === 'open' ? 'Set up' : 'Change';
  }

  function setOpen(id) {
    openId = steps.has(id) ? id : null;
    steps.forEach((step, key) => {
      const open = key === openId;
      step.toggle.setAttribute('aria-expanded', String(open));
      step.body.classList.toggle('hidden', !open);
      step.element.classList.toggle('zr-qs__step--open', open);
    });
    refresh();
  }

  steps.forEach((step, id) => {
    step.toggle.addEventListener('click', () =>
      setOpen(openId === id ? null : id)
    );
  });

  /* mirrors ---------------------------------------------------------------- */

  const mirrors = [];
  root.querySelectorAll('[data-mirror]').forEach((control) => {
    const row = control.closest('[data-qs-field]');
    const real = resolveMirrorTarget(control.dataset.mirror, doc);
    if (!real) {
      // A field this page does not render: the row would edit nothing.
      if (row) row.classList.add('hidden');
      return;
    }
    mirrors.push({
      ...bindMirror(control, real),
      row,
      note: row && row.querySelector('[data-qs-note]'),
    });
    const step = steps.get(control.closest('[data-qs-step]')?.dataset.qsStep);
    if (step) step.reals.add(real);
  });

  function refreshMirrors() {
    mirrors.forEach((mirror) => {
      mirror.pull();
      if (mirror.row) {
        mirror.row.classList.toggle('hidden', !isAvailable(mirror.real));
      }
      if (mirror.note) {
        const note = lockNote(mirror.real, lockedKeys);
        setText(mirror.note, note);
        mirror.note.classList.toggle('hidden', !note);
      }
    });
  }

  /* the schedule picker ------------------------------------------------------ */

  const schedulePicker = root.querySelector('[data-qs-schedule]');
  const cronMirror = root.querySelector('[data-mirror="scanInterval"]');
  const cronRow = root.querySelector('[data-qs-cron]');
  const cronWords = root.querySelector('[data-qs-cron-words]');
  let ownSchedule = false;
  const normalizeCron = (value) => clean(value).replace(/\s+/g, ' ');

  if (schedulePicker && cronMirror) {
    schedulePicker.replaceChildren(
      ...SCHEDULE_PRESETS.map(
        (cron) => new Option(describeSchedule(cron), cron)
      ),
      new Option('Own schedule (cron)', '')
    );
    schedulePicker.addEventListener('input', (event) =>
      event.stopPropagation()
    );
    schedulePicker.addEventListener('change', (event) => {
      event.stopPropagation();
      ownSchedule = !schedulePicker.value;
      if (ownSchedule) {
        refresh();
        cronMirror.focus();
        return;
      }
      // Written through the cron mirror, which carries it into the real field.
      cronMirror.value = schedulePicker.value;
      cronMirror.dispatchEvent(new Event('input', { bubbles: true }));
      cronMirror.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function refreshSchedule() {
    if (!schedulePicker || !cronMirror) return;
    const cron = normalizeCron(valueOf('scanInterval'));
    const preset = SCHEDULE_PRESETS.includes(cron);
    const value = ownSchedule || !preset ? '' : cron;
    if (schedulePicker.value !== value) schedulePicker.value = value;
    if (schedulePicker.disabled !== cronMirror.disabled) {
      schedulePicker.disabled = cronMirror.disabled;
    }
    // A pinned schedule stays in view, with the note that says why.
    if (cronRow) {
      cronRow.classList.toggle(
        'hidden',
        !(ownSchedule || !preset || cronMirror.disabled)
      );
    }
    setText(cronWords, cron ? scheduleWords(cron) : '');
  }

  /* when OCR runs ------------------------------------------------------------ */

  // One question for two switches of the OCR topic. Switched on here or in its
  // own topic, OCR asks it at once when neither switch is on yet: the picker
  // then shows no answer and the step stays open until one is chosen.
  const timingRow = root.querySelector('[data-qs-ocr-timing]');
  const timingPicker = root.querySelector('[data-qs-ocr-timing-picker]');
  const timingHint = root.querySelector('[data-qs-ocr-timing-hint]');
  const timingNote = root.querySelector('[data-qs-ocr-timing-note]');
  const ocrCronWords = root.querySelector('[data-qs-ocr-cron-words]');
  const timingReals = () => ({
    rightAway: resolveMirrorTarget('ocrRunRightAway', doc),
    schedule: resolveMirrorTarget('ocrAutoProcessEnabled', doc),
  });
  const placeholder = new Option('Choose when OCR runs', '');
  placeholder.disabled = true;
  let ocrWasOn = null;
  let timingUndecided = false;

  const currentTiming = () =>
    ocrTiming({
      rightAway: isOn('ocrRunRightAway'),
      schedule: isOn('ocrAutoProcessEnabled'),
    });

  if (timingPicker) {
    timingPicker.replaceChildren(
      placeholder,
      ...OCR_TIMINGS.map((timing) => new Option(timing.label, timing.value))
    );
    timingPicker.addEventListener('input', (event) => event.stopPropagation());
    timingPicker.addEventListener('change', (event) => {
      event.stopPropagation();
      const chosen = OCR_TIMINGS.find(
        (timing) => timing.value === timingPicker.value
      );
      if (!chosen) return;
      timingUndecided = false;
      const reals = timingReals();
      [
        [reals.rightAway, chosen.rightAway],
        [reals.schedule, chosen.schedule],
      ].forEach(([real, wanted]) => {
        if (!real || real.disabled || real.checked === wanted) return;
        real.checked = wanted;
        real.dispatchEvent(new Event('change', { bubbles: true }));
      });
      refresh();
    });
  }

  function refreshTiming() {
    const ocrOn = isOn('mistralOcrEnabled');
    // Switched on during this visit with neither switch on: ask.
    if (ocrWasOn === false && ocrOn && currentTiming() === 'manual') {
      timingUndecided = true;
    }
    if (!ocrOn) timingUndecided = false;
    ocrWasOn = ocrOn;
    if (!timingRow || !timingPicker) return;

    const reals = timingReals();
    const offered =
      ocrOn && Boolean(reals.rightAway) && isAvailable(reals.rightAway);
    timingRow.classList.toggle('hidden', !offered);
    const value = timingUndecided ? '' : currentTiming();
    if (timingPicker.value !== value) timingPicker.value = value;
    timingPicker.toggleAttribute('aria-invalid', timingUndecided);

    const chosen = OCR_TIMINGS.find((timing) => timing.value === value);
    setText(
      timingHint,
      chosen
        ? chosen.hint
        : 'Right after the scan gives a document OCR and its analysis without waiting.'
    );
    const note =
      lockNote(reals.rightAway, lockedKeys) ||
      lockNote(reals.schedule, lockedKeys);
    timingPicker.disabled = Boolean(note);
    setText(timingNote, note);
    if (timingNote) timingNote.classList.toggle('hidden', !note);
    setText(ocrCronWords, scheduleWords(valueOf('ocrAutoProcessInterval')));
  }

  /* the OCR model -------------------------------------------------------------- */

  // "Same model as the analysis" is not a setting: it copies provider, address
  // and model of step 2 into the OCR fields and is on while they match. While
  // it is on, an edit of the analysis model is copied along. Off, the OCR
  // provider and model show here to be chosen on their own.
  const sameRow = root.querySelector('[data-qs-same-model]');
  const sameSwitch = /** @type {any} */ (
    root.querySelector('[data-qs-same-model-switch]')
  );
  const sameHint = root.querySelector('[data-qs-same-model-hint]');
  const ownOcr = root.querySelector('[data-qs-ocr-own]');
  const ocrKeyRow = root
    .querySelector('[data-mirror="ocrApiKey"]')
    ?.closest('[data-qs-field]');
  const AI_MODEL_FIELDS = new Set([
    'aiProvider',
    'anthropicModel',
    'ollamaUrl',
    'ollamaModel',
    'customBaseUrl',
    'customModel',
    'customApiKey',
  ]);
  let sameChosenOff = false;
  let ocrSame = false;
  let sameBefore = false;

  const currentPlan = () => {
    const provider = clean(valueOf('aiProvider')).toLowerCase();
    const values = {};
    [
      'anthropicModel',
      'ollamaUrl',
      'ollamaModel',
      'customBaseUrl',
      'customModel',
    ].forEach((id) => {
      values[id] = valueOf(id);
    });
    return sameModelPlan({
      aiProvider: provider,
      values,
      customKeyPresent: secretPresent('customApiKey'),
    });
  };
  const ocrMatchesPlan = (plan) =>
    usesSameModel(plan, {
      ocrProvider: valueOf('ocrProvider'),
      ocrUrl: valueOf('ocrApiUrl'),
      ocrModel: valueOf('mistralOcrModel'),
      ollamaUrl: valueOf('ollamaUrl'),
    });

  function writeReal(id, value) {
    const real = field(id);
    if (!real || real.disabled) return;
    if (real.tagName === 'SELECT' && value) {
      const known = Array.from(real.options).some(
        (option) => option.value === value
      );
      if (!known) real.appendChild(new Option(value, value));
    }
    if (real.value === value) return;
    real.value = value;
    real.dispatchEvent(new Event('input', { bubbles: true }));
    real.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // The provider first: its change listener refills the model list.
  function copyPlan(plan) {
    if (!plan || !plan.model) return;
    writeReal('ocrProvider', plan.ocrProvider);
    writeReal('ocrApiUrl', plan.url);
    writeReal('mistralOcrModel', plan.model);
  }

  if (sameSwitch) {
    sameSwitch.addEventListener('input', (event) => event.stopPropagation());
    sameSwitch.addEventListener('change', (event) => {
      event.stopPropagation();
      sameChosenOff = !sameSwitch.checked;
      if (sameSwitch.checked) copyPlan(currentPlan());
      refresh();
    });
  }

  // Runs before refresh() on every edit: an edit of the analysis model while
  // OCR used it is copied along.
  const followAnalysisModel = (event) => {
    const id = event.target && event.target.id;
    if (!AI_MODEL_FIELDS.has(id) || !sameBefore || sameChosenOff) return;
    const plan = currentPlan();
    if (plan && !ocrMatchesPlan(plan)) copyPlan(plan);
  };
  if (form) {
    form.addEventListener('input', followAnalysisModel);
    form.addEventListener('change', followAnalysisModel);
  }

  /** @returns {boolean} whether OCR uses the analysis model */
  function refreshOcrModel() {
    const plan = currentPlan();
    const same = Boolean(plan) && !sameChosenOff && ocrMatchesPlan(plan);
    sameBefore = same;
    const offerSame = Boolean(plan && plan.model) && isOn('mistralOcrEnabled');
    if (sameRow) sameRow.classList.toggle('hidden', !offerSame);
    if (sameSwitch) {
      if (sameSwitch.checked !== same) sameSwitch.checked = same;
      const locked = ['ocrProvider', 'ocrApiUrl', 'mistralOcrModel'].some(
        (id) => field(id) && field(id).disabled
      );
      sameSwitch.disabled = locked;
    }
    if (sameHint && plan) {
      const name = `${selectedLabel('aiProvider') || valueOf('aiProvider')} · ${plan.model}`;
      setText(
        sameHint,
        plan.ocrProvider === 'anthropic'
          ? `OCR reads with ${name} from step 2, with its key. Claude reads PDFs and images.`
          : `OCR reads with ${name} from step 2. Only a model that reads images can do OCR, such as qwen2.5vl, llava or gemma3. With a text-only model, every OCR run fails.`
      );
    }
    if (ownOcr) ownOcr.classList.toggle('hidden', same && offerSame);
    // Mistral needs a key; Claude and a local server fall back or need none.
    if (ocrKeyRow && clean(valueOf('ocrProvider') || 'mistral') !== 'mistral') {
      ocrKeyRow.classList.add('hidden');
    }
    return same && offerSame;
  }

  /* Paperless-ngx connection ------------------------------------------------- */

  // The probe checks the stored configuration; once the address or the token
  // is edited, its word no longer applies.
  let connection = null;
  const connectionFields = ['paperlessUrl', 'paperlessToken'];
  let connectionBaseline = connectionFields.map((id) => {
    const element = field(id);
    return element ? String(element.defaultValue ?? '') : '';
  });
  const connectionUnchanged = () =>
    connectionFields.every(
      (id, index) => valueOf(id) === connectionBaseline[index]
    );

  if (typeof fetch === 'function') {
    fetch('/api/processing-status', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        connection = connectionState(data && data.paperless);
        refresh();
      })
      .catch(() => {});
  }

  /* summaries ---------------------------------------------------------------- */

  function customFieldCount() {
    const parsed = readJson(valueOf('customFieldsJson'), null);
    return parsed && Array.isArray(parsed.custom_fields)
      ? parsed.custom_fields.length
      : 0;
  }

  function summarize() {
    const provider = clean(valueOf('aiProvider')).toLowerCase();
    const needs = Object.prototype.hasOwnProperty.call(PROVIDER_NEEDS, provider)
      ? PROVIDER_NEEDS[provider]
      : {};
    const values = {};
    Object.values(needs).forEach((id) => {
      values[id] = valueOf(id);
    });
    return {
      paperless: summarizePaperless({
        url: valueOf('paperlessUrl'),
        tokenPresent: secretPresent('paperlessToken'),
        connection: connectionUnchanged() ? connection : null,
      }),
      ai: summarizeAi({
        provider,
        providerLabel: selectedLabel('aiProvider'),
        values,
        stored,
      }),
      fill: summarizeFill({
        on: Object.fromEntries(FILL_FIELDS.map(({ id }) => [id, isOn(id)])),
        customFieldCount: customFieldCount(),
      }),
      prompt: summarizePrompt({
        usePromptTags: isOn('usePromptTags'),
        promptTags: listFromCsv(valueOf('promptTags')),
        systemPrompt: valueOf('systemPrompt'),
      }),
      ocr: summarizeOcr({
        enabled: isOn('mistralOcrEnabled'),
        mode: valueOf('ocrBeforeAi'),
        tag: valueOf('ocrBeforeAiTag'),
        providerLabel: ocrSame
          ? `Same model as the analysis (${clean(valueOf('mistralOcrModel'))})`
          : [selectedLabel('ocrProvider'), clean(valueOf('mistralOcrModel'))]
              .filter(Boolean)
              .join(' · '),
        needsKey:
          clean(valueOf('ocrProvider') || 'mistral') === 'mistral' &&
          !secretPresent('ocrApiKey'),
        timing: currentTiming(),
        undecided: timingUndecided,
      }),
      run: summarizeRun({
        automatic: !isOn('disableAutomaticProcessing'),
        scanInterval: valueOf('scanInterval'),
        onlyTagged: isOn('showTags'),
        tags: listFromCsv(valueOf('tags')),
      }),
    };
  }

  // The progress sits next to the topic title, outside this block.
  const countEl =
    root.querySelector('[data-qs-count]') ||
    (entry && entry.querySelector('[data-qs-count]'));
  const promptTagsNote = root.querySelector('[data-qs-prompt-tags]');
  const runTags = root.querySelector('[data-qs-run-tags]');
  const runTagList = root.querySelector('[data-qs-run-tag-list]');

  function renderNavCount(text) {
    const id = entry && entry.dataset.entry;
    const link = id && doc.querySelector(`[data-entry-link="${id}"]`);
    if (!link) return;
    let badge = link.querySelector('[data-quick-start-count]');
    if (!badge) {
      badge = doc.createElement('span');
      badge.className = 'zr-badge';
      badge.dataset.quickStartCount = '';
      link.insertBefore(badge, link.querySelector('[data-entry-dirty]'));
    }
    setText(badge, text);
  }

  function refresh() {
    refreshMirrors();
    refreshSchedule();
    refreshTiming();
    ocrSame = refreshOcrModel();
    summaries = summarize();

    steps.forEach((step, id) => {
      const summary = summaries[id];
      if (!summary) return;
      if (step.element.dataset.state !== summary.state) {
        step.element.dataset.state = summary.state;
      }
      setText(step.summary, summary.text);
      setText(step.stateWord, STATE_WORDS[summary.state] || '');
      setText(step.action, actionWord(id));
    });

    const done = countDone(summaries);
    setText(countEl, progressText(done));
    renderNavCount(`${done} of ${QUICK_START_STEPS.length}`);

    if (promptTagsNote) {
      promptTagsNote.classList.toggle('hidden', !isOn('usePromptTags'));
    }
    if (runTags) {
      const tags = listFromCsv(valueOf('tags'));
      setText(
        runTagList,
        tags.length ? `Tags: ${tags.join(', ')}.` : 'No tag chosen yet.'
      );
      runTags.classList.toggle('hidden', !isOn('showTags'));
    }
  }

  /* keeping up with the page -------------------------------------------------- */

  // Every edit of a real field, here or in its own topic, bubbles to the form.
  if (form) {
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('zr:settings-saved', () => {
      Object.keys(stored).forEach((id) => {
        if (clean(valueOf(id))) stored[id] = true;
      });
      connectionBaseline = connectionFields.map((id) => valueOf(id));
      connection = null;
      refresh();
    });
  }

  // What changes without an event: a provider block shown or hidden, a field
  // locked, a select refilled by Fetch models, a chip added, this topic shown
  // again. Changes inside this topic are its own and are left out.
  let observer = null;
  if (form && typeof MutationObserver === 'function') {
    observer = new MutationObserver((records) => {
      if (records.some((record) => !root.contains(record.target))) refresh();
    });
    observer.observe(form, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'disabled'],
    });
  }

  // The unsaved-change marks (modules/settings-form.js) for the fields a step
  // edits, so the row says so as well as the topic it belongs to.
  const onDirty = (event) => {
    const dirty = new Set((event.detail && event.detail.fields) || []);
    steps.forEach((step) => {
      step.element.toggleAttribute(
        'data-dirty',
        [...step.reals].some((real) => dirty.has(real))
      );
    });
  };
  doc.addEventListener('zr:settings-dirty', onDirty);

  // settings.js locks pinned fields and settles its own state on
  // DOMContentLoaded; the first summary waits for it. A step that still needs
  // a decision then opens by itself.
  const start = () => {
    refresh();
    const first = QUICK_START_STEPS.find((id) =>
      ['open', 'problem'].includes(summaries[id] && summaries[id].state)
    );
    if (first && openId === null) setOpen(first);
  };
  refresh();
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  return {
    destroy() {
      mirrors.forEach((mirror) => mirror.destroy());
      if (observer) observer.disconnect();
      doc.removeEventListener('zr:settings-dirty', onDirty);
      if (form) {
        form.removeEventListener('input', refresh);
        form.removeEventListener('change', refresh);
      }
    },
  };
}
