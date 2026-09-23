/**
 * The two modes of a review page.
 *
 * Simple is the default: one button, one list of what will happen, one
 * button to do it. Advanced is the whole toolset behind a deliberate
 * switch: press it, read three lines, switch. The choice is kept per page in
 * the browser, so a person who wants the tools keeps them.
 *
 * A view marks what belongs to which mode with `data-advanced` and
 * `data-simple` on the element; the stylesheet hides the other mode's parts
 * once the page root carries `data-mode`. The button lives in the top bar's
 * actions slot.
 */

import { confirmDialog } from '/js/zr.js';
import { escapeHtml as esc } from '/js/modules/text-utils.js';

export const MODES = ['simple', 'advanced'];

const KEY = (page) => `zr:mode:${page}`;

/**
 * @param {string} page 'duplicates' or 'simplify'
 * @returns {'simple'|'advanced'}
 */
export function readMode(page) {
  try {
    const stored = window.localStorage.getItem(KEY(page));
    return MODES.includes(stored) ? stored : 'simple';
  } catch {
    return 'simple';
  }
}

/**
 * @param {string} page
 * @param {'simple'|'advanced'} mode
 */
export function writeMode(page, mode) {
  try {
    window.localStorage.setItem(
      KEY(page),
      MODES.includes(mode) ? mode : 'simple'
    );
  } catch {
    // A browser that keeps nothing still gets the mode for this visit.
  }
}

/**
 * Stamps the mode on the page root so the stylesheet can show one mode's
 * parts and hide the other's.
 *
 * @param {Element} root the element that wraps both modes' modules
 * @param {'simple'|'advanced'} mode
 */
export function applyMode(root, mode) {
  if (root) root.dataset.mode = MODES.includes(mode) ? mode : 'simple';
}

/**
 * The text button for the top bar: what pressing it switches to.
 *
 * @param {'simple'|'advanced'} mode the mode the page is in now
 * @returns {string} markup
 */
export function htmlModeButton(mode) {
  const toAdvanced = mode !== 'advanced';
  const icon = toAdvanced ? 'i-sliders' : 'i-wand';
  const label = toAdvanced ? 'Advanced' : 'Simple';
  return `<button class="zr-btn zr-btn--ghost zr-modebtn" type="button" data-mode-switch="${esc(toAdvanced ? 'advanced' : 'simple')}"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${esc(icon)}"/></svg>${esc(label)}</button>`;
}

/**
 * What Advanced opens, in three lines. A page passes its own lines; the
 * markup and the two buttons are the same on both.
 *
 * @param {{icon:string, text:string}[]} lines
 * @returns {string} markup
 */
export function htmlGate(lines) {
  const htmlRows = (lines || [])
    .map(
      (line) =>
        `<li class="zr-gate__row"><svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${esc(line.icon)}"/></svg><span>${esc(line.text)}</span></li>`
    )
    .join('');
  return `<ul class="zr-gate">${htmlRows}</ul>`;
}

/**
 * Opens the gate and resolves to whether the person switched.
 *
 * @param {{icon:string, text:string}[]} lines
 * @returns {Promise<boolean>}
 */
export function askAdvanced(lines) {
  return confirmDialog({
    title: 'Advanced',
    html: htmlGate(lines),
    confirmLabel: 'Switch',
    cancelLabel: 'Cancel',
    className: 'zr-dialog--gate',
  });
}

/**
 * Puts the button in the slot, reads the stored mode, stamps it on the root
 * and keeps all three in step. Going to Advanced asks first; coming back
 * does not.
 *
 * @param {object} options
 * @param {string} options.page                    'duplicates' or 'simplify'
 * @param {Element} options.root                   the element that carries data-mode
 * @param {Element} options.slot                   where the button goes (the top bar's actions)
 * @param {{icon:string, text:string}[]} options.gate  the three lines of the gate
 * @param {function('simple'|'advanced'):void} [options.onChange]
 * @returns {'simple'|'advanced'} the mode the page starts in
 */
export function mountModeSwitch({ page, root, slot, gate, onChange }) {
  let mode = readMode(page);
  const draw = () => {
    applyMode(root, mode);
    if (slot) slot.innerHTML = htmlModeButton(mode);
  };
  const set = (next) => {
    mode = next;
    writeMode(page, mode);
    draw();
    if (onChange) onChange(mode);
  };
  if (slot) {
    slot.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-mode-switch]');
      if (!button) return;
      const next = button.dataset.modeSwitch;
      if (next === 'advanced') {
        if (await askAdvanced(gate)) set('advanced');
        return;
      }
      set('simple');
    });
  }
  draw();
  return mode;
}
