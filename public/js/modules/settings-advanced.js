/**
 * Settings › the "Advanced options" disclosures of the AI sections.
 *
 * Every such disclosure carries data-module="settings-advanced". They are one
 * switch of mind, not one per section: opening one opens all of them, and the
 * choice is remembered per browser under STORAGE_KEY ('1' open, '0' closed).
 * The page renders them closed; a remembered '1' opens them on load.
 *
 * Only a person's own click on a summary changes the remembered choice. The
 * settings search and the browser's form validation open a disclosure to show
 * a field, and that says nothing about what the person prefers.
 */

export const STORAGE_KEY = 'zr.settings.advanced';
const SELECTOR = 'details[data-advanced]';

export function readPreference(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePreference(storage, open) {
  try {
    storage?.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Storage refused (private mode, quota): the choice lasts for this page.
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function setAll(open) {
  document.querySelectorAll(SELECTOR).forEach((details) => {
    if (details.open !== open) details.open = open;
  });
}

let invalidListener = false;

export default function settingsAdvanced(root) {
  if (!(root instanceof HTMLDetailsElement)) return;

  if (readPreference(storage())) root.open = true;

  const summary = root.querySelector(':scope > summary');
  let byPerson = false;
  summary?.addEventListener('click', () => {
    byPerson = true;
  });
  root.addEventListener('toggle', () => {
    if (!byPerson) return;
    byPerson = false;
    writePreference(storage(), root.open);
    setAll(root.open);
  });

  // A field the browser refuses to submit must be visible, or the save
  // silently does nothing. One listener serves every disclosure.
  if (!invalidListener) {
    invalidListener = true;
    document.addEventListener(
      'invalid',
      (event) => {
        const details = event.target?.closest?.(SELECTOR);
        if (details && !details.open) details.open = true;
      },
      true
    );
  }
}
