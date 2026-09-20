/**
 * A search field with a dropdown of matching records underneath it.
 *
 * Grown on the Duplicates page, where a merge by hand picks a tag out of a
 * thousand, and moved here when the Simplify tags page needed the same field
 * for the document types Paperless-ngx already has.
 *
 * The module knows nothing about either page: it is handed the two elements,
 * a `choices()` that says what may be offered right now and an `onPick()`.
 * No ids, no fetches, no state of its own beyond the rows it is showing.
 *
 * Escaping rule, as on the pages: everything interpolated into markup is
 * esc(), num() or a local whose name starts with "html".
 */

import { escapeHtml as esc } from '/js/modules/text-utils.js';

/** Rows the dropdown shows before it starts counting the rest. */
export const PICKER_ROWS = 12;

/** What an empty result says when the caller names nothing else. */
const EMPTY_TEXT = 'No entry matches.';

/** The badge tones a row may ask for; anything else is rendered plain. */
const BADGE_TONES = ['ok', 'info', 'warn', 'danger', 'brand'];

/** Anything that reaches an attribute or a cell as a number, never as text. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The lock a row wears when the API token may not change that object. */
const htmlLockIcon =
  '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-shield"/></svg>';

/**
 * One row of the dropdown. Pure on purpose, so a page's test can render it.
 *
 * `record.badge` is the one thing a page may add: `{ text, tone }` (or a bare
 * string), which the Simplify page uses to mark a type it already has.
 *
 * @param {object} record  an EntityRecord: name, documentCount, …
 * @param {number} index   its position among the shown rows
 * @param {string} prefix  id prefix, so aria-activedescendant can name it
 * @returns {string} markup
 */
export function htmlPickerRow(record, index, prefix) {
  const name = String(record.name == null ? '' : record.name);
  const htmlInbox = record.isInboxTag
    ? '<span class="zr-badge zr-badge--info">inbox</span>'
    : '';
  const badge =
    typeof record.badge === 'string' ? { text: record.badge } : record.badge;
  const badgeText = badge && badge.text ? String(badge.text) : '';
  const badgeTone =
    badge && BADGE_TONES.includes(String(badge.tone))
      ? ` zr-badge--${String(badge.tone)}`
      : '';
  const htmlBadge = badgeText
    ? `<span class="zr-badge${esc(badgeTone)}">${esc(badgeText)}</span>`
    : '';
  const htmlLock =
    record.userCanChange === false
      ? `<span class="zr-picker__lock" title="The API token may not change this object">${htmlLockIcon}</span>`
      : '';
  return `<div class="zr-picker__row" role="option" aria-selected="false" id="${esc(prefix)}${num(index)}" data-index="${num(index)}">
    <span class="zr-truncate zr-picker__name" title="${esc(name)}">${esc(name)}</span>${htmlInbox}${htmlBadge}${htmlLock}
    <span class="zr-sm zr-faint zr-mono zr-picker__count">${num(record.documentCount)}</span>
  </div>`;
}

/**
 * Wires one input and one list element into a picker.
 *
 * The dropdown is rebuilt on every keystroke rather than filtered in place: a
 * few hundred names are nothing to rebuild, and it keeps the active row, the
 * truncation line and the aria wiring in one place.
 *
 * @param {object} config
 * @param {HTMLInputElement} config.input
 * @param {HTMLElement} config.list        must sit inside a .zr-picker
 * @param {string} config.prefix           id prefix for the option rows
 * @param {() => object[]} config.choices  what may be offered right now
 * @param {(record: object) => void} config.onPick
 * @param {string} [config.emptyText]      what an empty result says
 * @returns {{open: () => void, close: () => void}}
 */
export function createPicker({
  input,
  list,
  prefix,
  choices,
  onPick,
  emptyText,
}) {
  /** The rows the dropdown currently shows, in the order it shows them. */
  let shown = [];
  let active = -1;

  function isOpen() {
    return !list.classList.contains('hidden');
  }

  function close() {
    list.classList.add('hidden');
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    shown = [];
    active = -1;
  }

  function markActive() {
    const rows = list.querySelectorAll('.zr-picker__row');
    rows.forEach((row, index) => {
      const on = index === active;
      row.classList.toggle('zr-picker__row--active', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const row = rows[active];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function open() {
    if (input.disabled) return;
    const query = input.value.trim().toLowerCase();
    const nameOf = (record) =>
      String(record.name == null ? '' : record.name).toLowerCase();
    let matches = choices();
    if (query !== '') {
      matches = matches.filter((record) => nameOf(record).includes(query));
      // A name that begins with what was typed is what was meant; everything
      // else that contains it follows in the order the server sent.
      matches = [
        ...matches.filter((record) => nameOf(record).startsWith(query)),
        ...matches.filter((record) => !nameOf(record).startsWith(query)),
      ];
    }

    shown = matches.slice(0, PICKER_ROWS);
    const rest = matches.length - shown.length;
    const htmlRows = shown
      .map((record, index) => htmlPickerRow(record, index, prefix))
      .join('');
    const htmlMore =
      rest > 0 ? `<div class="zr-picker__more">… ${num(rest)} more</div>` : '';
    const htmlEmpty = `<div class="zr-picker__more">${esc(emptyText || EMPTY_TEXT)}</div>`;
    list.innerHTML = shown.length === 0 ? htmlEmpty : htmlRows + htmlMore;

    list.classList.toggle('zr-picker__list--empty', shown.length === 0);
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    active = shown.length > 0 ? 0 : -1;
    markActive();
  }

  function pick(record) {
    if (!record) return;
    close();
    onPick(record);
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen()) {
        open();
        return;
      }
      if (shown.length === 0) return;
      active =
        event.key === 'ArrowDown'
          ? (active + 1) % shown.length
          : (active - 1 + shown.length) % shown.length;
      markActive();
      return;
    }
    if (event.key === 'Enter' && isOpen() && active >= 0) {
      // preventDefault() is also how a second Enter listener on the same
      // input — the Simplify page adds one for "a name nothing matches" —
      // tells that the row was already picked.
      event.preventDefault();
      pick(shown[active]);
      return;
    }
    if (event.key === 'Escape' && isOpen()) {
      // Without this the dialog-less page would hand Escape on to the browser,
      // which on a phone closes the keyboard instead of the list.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  // mousedown rather than click: the row must be picked before the field loses
  // the focus, or the outside-click handler below has already closed the list.
  list.addEventListener('mousedown', (event) => {
    const row = event.target.closest('.zr-picker__row');
    if (!row) return;
    event.preventDefault();
    pick(shown[num(row.dataset.index)]);
  });

  document.addEventListener('click', (event) => {
    if (isOpen() && event.target.closest('.zr-picker') !== list.parentElement) {
      close();
    }
  });

  return { open, close };
}
