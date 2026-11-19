/**
 * Settings: the unsaved changes and the save bar.
 *
 * Tracks every setting of the form against the value it had when the page
 * loaded (or was last saved), marks the changed rows, and shows the save bar
 * while anything differs: how many settings changed, which ones by their
 * labels, whether saving restarts Zettelrobbe, and Discard and Save settings.
 *
 * The bar is a row of the page layout under the region that scrolls
 * (pages/settings.css), so it never lies over the form. Showing it takes
 * height from the bottom of the region and leaves the rest where it was;
 * hiding it gives the height back without letting the region snap back.
 *
 * Saving itself stays in settings.js, which owns the submit handler and the
 * restart flow: this module reports state and resets it after a save.
 */

/** The rows a setting is drawn in, nearest first. */
const ROW_SELECTOR = '.zr-switchrow, .zr-checktile, .zr-field';
/** What is not part of a label's text: badges, help buttons, controls. */
const NOT_LABEL_TEXT =
  '.zr-badge, .zr-sr, button, input, select, textarea, svg';

const norm = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @typedef {object} ChangedField
 * @property {*} [row]        what one setting is told apart by (its row);
 *                            fields sharing a row are one setting
 * @property {string} label   the setting's label as its row shows it
 * @property {string} [topic] the topic it sits in
 * @property {boolean} [restart] whether saving it restarts Zettelrobbe
 */

/**
 * @typedef {object} ChangeSummary
 * @property {number} count     how many settings changed
 * @property {string} title     "1 unsaved change", "3 unsaved changes"
 * @property {string[]} labels  one per setting, in page order
 * @property {string} text      the labels as one line; the bar cuts it in CSS
 * @property {boolean} restart  whether saving restarts Zettelrobbe
 */

/**
 * What the save bar says about a set of changed fields, given in page order.
 *
 * A setting is counted and named once however many of its fields changed: a
 * list of pills has its text field and the hidden value it posts, a switch
 * its visible checkbox and a hidden yes/no. Quick start never shows up
 * here: its controls only mirror real fields, and the real field is what
 * changed. Two settings with the same label ("Model", "Tags") are told apart
 * by their topic. Cutting a long line is left to CSS, so the text always
 * holds every name.
 *
 * @param {ChangedField[]} fields
 * @returns {ChangeSummary}
 */
export function describeChanges(fields) {
  /** @type {Map<*, { label: string, topic: string, restart: boolean }>} */
  const settings = new Map();
  (fields || []).forEach((field) => {
    const key = field.row == null ? field : field.row;
    const known = settings.get(key);
    if (known) {
      known.restart = known.restart || Boolean(field.restart);
      return;
    }
    settings.set(key, {
      label: norm(field.label) || norm(field.topic) || 'A setting',
      topic: norm(field.topic),
      restart: Boolean(field.restart),
    });
  });

  const list = [...settings.values()];
  const uses = new Map();
  list.forEach(({ label }) => uses.set(label, (uses.get(label) || 0) + 1));
  const labels = list.map(({ label, topic }) =>
    uses.get(label) > 1 && topic ? `${label} (${topic})` : label
  );
  const count = list.length;
  return {
    count,
    title:
      count === 0
        ? 'No unsaved changes'
        : `${count} unsaved change${count === 1 ? '' : 's'}`,
    labels,
    text: labels.join(', '),
    restart: list.some((setting) => setting.restart),
  };
}

/**
 * Whether the on-screen keyboard of a touch device is open: a text field
 * has the focus and the visible part of the window is clearly shorter than
 * the layout. Without the Visual Viewport API, a focused text field on a
 * touch device counts as open.
 *
 * @param {{ coarse: boolean, typing: boolean, layoutHeight: number, visualHeight: number|null }} state
 * @returns {boolean}
 */
export function keyboardOpen({ coarse, typing, layoutHeight, visualHeight }) {
  if (!coarse || !typing) return false;
  if (visualHeight == null) return true;
  return layoutHeight - visualHeight > 120;
}

/**
 * Whether a control of the form is a setting the save sends (or, for the
 * text field of a list of pills, feeds into one).
 *
 * Left out: Quick start (data-mirror-scope, its controls mirror real
 * fields), tools that are not settings (data-not-a-setting: Detect models,
 * two-factor sign-in, the custom-field add row, the .env output) and hidden
 * inputs, except the value of a list of pills and a hidden value that names
 * its setting (data-setting-label, the custom fields). A switch's hidden
 * yes/no follows its visible checkbox, which counts instead.
 *
 * @param {Element & { type?: string, id: string }} field
 * @param {Set<string>} listValueIds ids of the hidden inputs lists post through
 * @returns {boolean}
 */
export function countsAsSetting(field, listValueIds) {
  if (field.closest('[data-mirror-scope], [data-not-a-setting]')) return false;
  if (field.type !== 'hidden') return true;
  return listValueIds.has(field.id) || field.hasAttribute('data-setting-label');
}

const TEXT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'password',
  'number',
  'tel',
]);

/** @param {Element|null} element */
function isTyping(element) {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  return TEXT_TYPES.has(/** @type {HTMLInputElement} */ (element).type);
}

export default function settingsForm(root, { confirmDialog }) {
  const form = root.querySelector('#setupForm');
  const bar = root.querySelector('[data-el="actionbar"]');
  if (!form || !bar) return;

  const status = bar.querySelector('[data-el="status"]');
  const list = bar.querySelector('[data-el="changes"]');
  const saveBtn = bar.querySelector('[data-el="save"]');
  const resetBtn = bar.querySelector('[data-el="reset"]');
  const restartNote = bar.querySelector('[data-el="restart"]');
  const scroller = root.querySelector('[data-el="scroller"]');
  const reserve = root.querySelector('[data-el="reserve"]');
  const doc = root.ownerDocument || document;

  const listValues = new Set(
    [...form.querySelectorAll('[data-chip-list][data-chip-value]')].map(
      (chips) => chips.dataset.chipValue
    )
  );
  const fields = [...form.querySelectorAll('input, select, textarea')].filter(
    (field) => countsAsSetting(field, listValues)
  );
  const valueOf = (field) =>
    field.type === 'checkbox' ? field.checked : field.value;
  const initial = new Map(fields.map((field) => [field, valueOf(field)]));

  function dirtyFields() {
    return fields.filter((field) => initial.get(field) !== valueOf(field));
  }

  // The keys whose change ends in a restart, rendered from
  // config/restartRequiredKeys.js: the same list the save route decides by.
  // A field knows its key through data-env-key (annotateEnvKeys in
  // settings.js), which is set by the time anything is edited.
  let restartKeys = new Set();
  try {
    const parsed = JSON.parse(form.dataset.restartKeys || '[]');
    restartKeys = new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    restartKeys = new Set();
  }

  /** The label of the row a field sits in, as the page shows it. */
  function labelOf(field) {
    if (field.dataset.settingLabel) return field.dataset.settingLabel;
    const row = field.closest(ROW_SELECTOR);
    const labelEl =
      row &&
      (row.matches('.zr-checktile')
        ? row
        : row.querySelector('label, .zr-field__name'));
    if (labelEl) {
      return norm(
        [...labelEl.childNodes]
          .filter(
            (node) =>
              node.nodeType === Node.TEXT_NODE ||
              !(/** @type {Element} */ (node).matches?.(NOT_LABEL_TEXT))
          )
          .map((node) => node.textContent)
          .join(' ')
      );
    }
    const section = field.closest('.zr-settings-section');
    return norm(
      section?.querySelector('.zr-settings-section__title')?.textContent
    );
  }

  function describe(dirty) {
    return describeChanges(
      dirty.map((field) => ({
        row: field.closest(ROW_SELECTOR) || field,
        label: labelOf(field),
        topic: field.closest('.zr-settings-entry')?.getAttribute('data-title'),
        restart: restartKeys.has(field.dataset.envKey),
      }))
    );
  }

  /* --- the bar in the layout --------------------------------------------- */

  // The bar's height, for what has to keep clear of it (the toasts).
  function publishHeight() {
    if (bar.hidden) return;
    doc.documentElement.style.setProperty(
      '--zr-actionbar-h',
      `${bar.offsetHeight}px`
    );
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(publishHeight).observe(bar);
  }

  function setReserve(px) {
    if (!reserve) return;
    reserve.style.setProperty('--zr-settings-reserve', `${Math.max(0, px)}px`);
  }
  const reserveOf = () => (reserve ? reserve.offsetHeight : 0);

  /**
   * The row being worked on, if it is on screen: the focused control's row,
   * or the row of the field that just changed (a click on a switch does not
   * focus it in every browser).
   */
  function rowOnScreen(field) {
    if (!scroller) return null;
    const active = doc.activeElement;
    const target =
      active && active !== doc.body && scroller.contains(active)
        ? active
        : field;
    if (!target || !scroller.contains(target)) return null;
    if (!target.getClientRects().length) return null;
    const row = target.closest(`${ROW_SELECTOR}, .zr-qs__field`) || target;
    const box = row.getBoundingClientRect();
    const region = scroller.getBoundingClientRect();
    return box.top < region.bottom && box.bottom > region.top ? row : null;
  }

  /**
   * Keeps that row in view when the bar takes the bottom of the region:
   * usually nothing moves, but a row in the strip the bar now takes moves
   * up just far enough to stay visible.
   */
  function keepInView(row) {
    if (!row || !scroller) return;
    const below =
      row.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().bottom;
    if (below > 0) scroller.scrollTop += Math.ceil(below);
  }

  let keyboard = false;
  let dirtyNow = [];

  function placeBar(changed) {
    const show = dirtyNow.length > 0 && !keyboard;
    if (show === !bar.hidden) return;
    const top = scroller ? scroller.scrollTop : 0;
    const focusInBar = bar.contains(doc.activeElement);
    const working = show ? rowOnScreen(changed) : null;
    bar.hidden = !show;
    publishHeight();
    if (!scroller) return;
    if (show) {
      // The region ends higher now; scrolled to its end, the reserve left
      // from an earlier exit of the bar is no longer needed.
      setReserve(0);
      scroller.scrollTop = top;
      keepInView(working);
      return;
    }
    // The region got its height back. Scrolled to its end, it would snap
    // back by up to the bar's height under the pointer; the reserve at the
    // end of the region (its last child) keeps it scrollable to where it
    // was, also when the topic is shorter than the region now is.
    if (reserve && top > 0) {
      const needed = scroller.clientHeight + top - reserve.offsetTop;
      if (needed > reserveOf()) setReserve(needed);
      scroller.scrollTop = top;
    }
    // Discard or Save had the focus; it goes to the title of the open topic
    // rather than to nowhere.
    if (focusInBar) {
      root
        .querySelector(
          '.zr-settings-entry:not(.hidden) .zr-settings-entry__title'
        )
        ?.focus({ preventScroll: true });
    }
  }

  function sync(event) {
    const dirty = dirtyFields();
    dirtyNow = dirty;
    const summary = describe(dirty);
    bar.dataset.dirty = dirty.length ? 'true' : 'false';
    saveBtn.disabled = dirty.length === 0;
    resetBtn.disabled = dirty.length === 0;
    // Without changes the bar is on its way out: its text stays as it was,
    // so its height does not change under the region while it goes.
    if (dirty.length) {
      status.textContent = summary.title;
      if (list) {
        list.textContent = summary.text;
        list.title = summary.text;
      }
      restartNote.classList.toggle('hidden', !summary.restart);
    }
    placeBar(event && event.target);

    // A row can hold several fields (a list's text field and its hidden
    // value): it is marked when any of them changed. A switch marks its own
    // row, not the field block it may sit in (ROW_SELECTOR, nearest first).
    const dirtyRows = new Set(
      dirty.map((field) => field.closest(ROW_SELECTOR))
    );
    fields.forEach((field) => {
      const row = field.closest(ROW_SELECTOR);
      if (row) row.toggleAttribute('data-dirty', dirtyRows.has(row));
    });

    // The topic list marks the topics holding these, since only one topic is
    // visible at a time (modules/settings-nav.js).
    doc.dispatchEvent(
      new CustomEvent('zr:settings-dirty', { detail: { fields: dirty } })
    );
  }

  form.addEventListener('input', sync);
  form.addEventListener('change', sync);

  // A new topic starts at its top; the room kept for the last one goes.
  doc.addEventListener('zr:settings-topic', () => setReserve(0));

  // The on-screen keyboard of a phone: the bar steps aside while it is open,
  // so the little room above it belongs to the field being typed in.
  const coarse = window.matchMedia?.('(pointer: coarse)');
  const syncKeyboard = () => {
    const viewport = window.visualViewport;
    const open = keyboardOpen({
      coarse: Boolean(coarse && coarse.matches),
      typing: isTyping(doc.activeElement),
      layoutHeight: doc.documentElement.clientHeight,
      visualHeight: viewport ? viewport.height * viewport.scale : null,
    });
    if (open === keyboard) return;
    keyboard = open;
    bar.toggleAttribute('data-keyboard', open);
    placeBar(null);
  };
  window.visualViewport?.addEventListener('resize', syncKeyboard);
  doc.addEventListener('focusin', syncKeyboard);
  doc.addEventListener('focusout', () => setTimeout(syncKeyboard, 0));

  resetBtn.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Discard changes?',
      body: 'Every unsaved change on this page goes back to the value in use.',
      confirmLabel: 'Discard',
      tone: 'danger',
    });
    if (!confirmed) return;

    fields.forEach((field) => {
      if (field.type === 'checkbox') field.checked = initial.get(field);
      else field.value = initial.get(field);
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    sync();
  });

  // settings.js handles the request and announces a successful save; only then
  // do the current values become the new baseline. A failed save keeps them
  // counted as unsaved.
  form.addEventListener('zr:settings-saved', () => {
    fields.forEach((field) => initial.set(field, valueOf(field)));
    sync();
  });

  // Edits in any topic, visible or not, would be lost by leaving the page.
  const warnOnLeave = (event) => {
    if (!dirtyFields().length) return;
    event.preventDefault();
    // Older browsers only show the prompt when returnValue is set.
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', warnOnLeave);

  sync();
}
