/**
 * Lists of values as removable pills, for module land.
 *
 * The implementation lives in the classic script /js/chip-list.js: the
 * settings page and the setup wizard are classic scripts and cannot import an
 * ES module, and one implementation beats two. This adapter lets a module name
 * the dependency in its import list (as modules/date-format.js does for the
 * date formatter). A page that uses it loads /js/chip-list.js in its <head>,
 * so the script has run before any module does.
 *
 * As a data-module ("tag-input") it turns every list rendered by
 * views/partials/chip-list.ejs inside the element into pills.
 */

/** Attaches the pill behaviour to one .zr-chips list; null without the script. */
export function attachChipList(list, options) {
  return window.zrChipList ? window.zrChipList.attach(list, options) : null;
}

/** Turns text still typed in the lists below `root` into pills. */
export function commitChipLists(root) {
  if (window.zrChipList) window.zrChipList.commitAll(root);
}

/** Splits typed or pasted text into values the way the lists do. */
export function splitValues(text, separator) {
  return window.zrChipList
    ? window.zrChipList.split(text, separator)
    : String(text || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

export default function tagInput(el) {
  if (window.zrChipList) window.zrChipList.attachAll(el);
}
