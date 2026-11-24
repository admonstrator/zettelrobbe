/**
 * Lists of values as removable pills: tags, title patterns, scopes, names.
 *
 * A classic script, like /js/dialogs.js and /js/date-format.js, because the
 * settings page and the setup wizard are classic scripts and cannot import an
 * ES module. Module land (Tidy up, the styleguide) reaches this same code
 * through /js/modules/tag-input.js instead of a second copy. A page that has a
 * list loads this script in its <head>.
 *
 *   window.zrChipList.attach(list, options) -> controller
 *   window.zrChipList.attachAll(root)       every [data-chip-list] below root
 *   window.zrChipList.commitAll(root)       text still typed becomes pills
 *   window.zrChipList.split(text, separator)
 *
 * `list` is the .zr-chips container. It names its parts by id in data
 * attributes (views/partials/chip-list.ejs renders them), or the caller hands
 * them over in `options`:
 *
 *   data-chip-input / options.input            the text field values are typed into
 *   data-chip-add / options.addButton          the Add button (optional)
 *   data-chip-value / options.valueInput       hidden input the form posts (optional)
 *   data-chip-separator / options.separator    ',' (default) or ' ' for a space-separated list
 *   options.values                             the values, where there is no hidden input
 *   options.onChange(values)                   called after every change
 *
 * One behaviour for every list:
 *   - Enter, a comma or the Add button turns the typed text into a pill; in a
 *     space-separated list a space does too.
 *   - Pasting "a, b, c" or several lines adds three pills.
 *   - A value already on the list, in any case, is not added again; its pill
 *     lights up instead.
 *   - Backspace in the empty field removes the last pill.
 *   - Every pill has a remove button named "Remove <value>".
 *   - A list whose container carries data-locked="true" (a value set by the
 *     environment) neither adds nor removes; badges.css hides the buttons.
 *   - commit() and commitAll() turn text left in the field into pills, so a
 *     save does not drop what was typed but not yet added.
 *
 * The stored format does not change: the hidden input receives the values
 * joined with the separator, followed by an input and a change event so the
 * settings page counts it as an unsaved change. A value therefore cannot hold
 * the separator: a comma always starts a new pill. Pills are built with
 * textContent; a value is never parsed as markup.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // How long a pill stays highlighted when its value is typed a second time.
  const FLASH_MS = 1200;
  /** @type {WeakMap<Element, object>} */
  const attached = new WeakMap();

  function normalizeSeparator(value) {
    return value === ' ' ? ' ' : ',';
  }

  /* Everything that ends a value. Line breaks and tabs only arrive by paste;
     a space only separates where the stored list is space-joined. */
  function splitPattern(separator) {
    return separator === ' ' ? /[\s,]+/ : /[,\r\n\t]+/;
  }

  /* What ends a value while it is typed: the comma, plus the space in a
     space-separated list. */
  function typedPattern(separator) {
    return separator === ' ' ? /[\s,]/ : /,/;
  }

  function split(text, separator) {
    return String(text == null ? '' : text)
      .split(splitPattern(normalizeSeparator(separator)))
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function sameValue(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  }

  function removeIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'zr-icon zr-icon--sm');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '/icons.svg#i-x');
    svg.appendChild(use);
    return svg;
  }

  function buildPill(value, locked) {
    const pill = document.createElement('span');
    pill.className = 'zr-chip';
    pill.setAttribute('role', 'listitem');
    const text = document.createElement('span');
    text.textContent = value;
    pill.appendChild(text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${value}`);
    remove.disabled = locked;
    remove.appendChild(removeIcon());
    pill.appendChild(remove);
    return pill;
  }

  function readPills(list) {
    return Array.from(list.querySelectorAll('.zr-chip'))
      .map((pill) => String(pill.firstElementChild?.textContent || '').trim())
      .filter(Boolean);
  }

  function attach(list, options) {
    if (!list) return null;
    if (attached.has(list)) return attached.get(list);
    const opts = options || {};
    const byId = (id) => (id ? document.getElementById(id) : null);
    const input = opts.input || byId(list.dataset.chipInput);
    const addButton = opts.addButton || byId(list.dataset.chipAdd);
    const valueInput = opts.valueInput || byId(list.dataset.chipValue);
    const separator = normalizeSeparator(
      opts.separator !== undefined ? opts.separator : list.dataset.chipSeparator
    );
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

    let values;
    if (Array.isArray(opts.values)) {
      values = opts.values.map((value) => String(value).trim()).filter(Boolean);
    } else if (valueInput) {
      values = split(valueInput.value, separator);
    } else {
      values = readPills(list);
    }

    // Spoken after an add or a remove; the field itself only empties.
    const status = document.createElement('span');
    status.className = 'zr-sr';
    status.setAttribute('role', 'status');
    if (list.parentNode) list.parentNode.insertBefore(status, list.nextSibling);

    const isLocked = () => list.dataset.locked === 'true';
    const canAdd = () => !isLocked() && !(input && input.disabled);

    function announce(text) {
      status.textContent = text;
    }

    function render() {
      list.textContent = '';
      const locked = isLocked();
      values.forEach((value) => list.appendChild(buildPill(value, locked)));
    }

    function changed() {
      if (valueInput) {
        valueInput.value = values.join(separator);
        valueInput.dispatchEvent(new Event('input', { bubbles: true }));
        valueInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (onChange) onChange(values.slice());
    }

    function flash(repeated) {
      const pills = list.querySelectorAll('.zr-chip');
      repeated.forEach((value) => {
        const index = values.findIndex((existing) =>
          sameValue(existing, value)
        );
        const pill = pills[index];
        if (!pill) return;
        pill.setAttribute('data-flash', '');
        setTimeout(() => pill.removeAttribute('data-flash'), FLASH_MS);
      });
    }

    function addValues(candidates) {
      if (!canAdd()) return [];
      const added = [];
      const repeated = [];
      candidates.forEach((value) => {
        const known = values.concat(added);
        if (known.some((existing) => sameValue(existing, value))) {
          if (!added.some((existing) => sameValue(existing, value))) {
            repeated.push(value);
          }
          return;
        }
        added.push(value);
      });
      if (added.length) {
        values = values.concat(added);
        render();
        changed();
      }
      if (repeated.length) flash(repeated);
      const spoken = [];
      if (added.length) spoken.push(`Added ${added.join(', ')}.`);
      if (repeated.length) {
        spoken.push(`Already on the list: ${repeated.join(', ')}.`);
      }
      if (spoken.length) announce(spoken.join(' '));
      return added;
    }

    // Text left in the field becomes pills. The field is emptied first, so an
    // onChange callback already sees it empty.
    function commit() {
      if (!input || !canAdd()) return [];
      const text = input.value;
      input.value = '';
      return addValues(split(text, separator));
    }

    function removeAt(index, moveFocus) {
      if (isLocked() || index < 0 || index >= values.length) return;
      const removed = values[index];
      values = values.slice(0, index).concat(values.slice(index + 1));
      render();
      changed();
      announce(`Removed ${removed}.`);
      if (moveFocus) {
        // The pill that took its place, else the one before it, else the field.
        const buttons = list.querySelectorAll('.zr-chip button');
        const next = buttons[Math.min(index, buttons.length - 1)] || input;
        if (next) next.focus();
      }
    }

    // While a value is typed, a separator ends it: what stands before the last
    // separator becomes pills, what follows stays in the field.
    function splitTyped() {
      if (!input || !canAdd()) return;
      const text = input.value;
      if (!typedPattern(separator).test(text)) return;
      const parts = text.split(splitPattern(separator));
      const rest = parts.pop() || '';
      input.value = rest.replace(/^\s+/, '');
      addValues(parts.map((value) => value.trim()).filter(Boolean));
    }

    list.setAttribute('data-chip-list', '');
    list.setAttribute('role', 'list');

    list.addEventListener('click', (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest('button') : null;
      if (!button || !list.contains(button)) return;
      const pill = button.closest('.zr-chip');
      removeAt(Array.prototype.indexOf.call(list.children, pill), true);
    });

    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
          // Never left to the form: Enter in a list field adds, it does not save.
          event.preventDefault();
          commit();
          return;
        }
        if (
          event.key === 'Backspace' &&
          !event.repeat &&
          input.value === '' &&
          values.length > 0 &&
          !input.disabled
        ) {
          event.preventDefault();
          removeAt(values.length - 1, false);
        }
      });
      input.addEventListener('input', (event) => {
        if (event.isComposing) return;
        splitTyped();
      });
      input.addEventListener('compositionend', splitTyped);
      // A text field drops the line breaks of pasted text, so a pasted list is
      // split here, before the browser flattens it into one value.
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData
          ? event.clipboardData.getData('text')
          : '';
        if (!text || !splitPattern(separator).test(text) || !canAdd()) return;
        event.preventDefault();
        const start =
          typeof input.selectionStart === 'number'
            ? input.selectionStart
            : input.value.length;
        const end =
          typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
        const combined =
          input.value.slice(0, start) + text + input.value.slice(end);
        input.value = '';
        addValues(split(combined, separator));
      });
    }

    if (addButton) {
      addButton.addEventListener('click', () => {
        commit();
        if (input && !input.disabled) input.focus();
      });
    }

    // Something else set the hidden input (the "Discard changes" button of
    // the settings page): the pills follow it.
    if (valueInput) {
      valueInput.addEventListener('change', () => {
        if (valueInput.value === values.join(separator)) return;
        values = split(valueInput.value, separator);
        render();
        if (onChange) onChange(values.slice());
      });
    }

    render();

    const controller = {
      values: () => values.slice(),
      add: (text) => addValues(split(text, separator)),
      remove: (value) =>
        removeAt(
          values.findIndex((existing) => sameValue(existing, String(value))),
          false
        ),
      commit,
      render,
      isLocked,
    };
    attached.set(list, controller);
    return controller;
  }

  function attachAll(root) {
    (root || document)
      .querySelectorAll('[data-chip-list]')
      .forEach((list) => attach(list));
  }

  function commitAll(root) {
    (root || document).querySelectorAll('[data-chip-list]').forEach((list) => {
      const controller = attached.get(list);
      if (controller) controller.commit();
    });
  }

  window.zrChipList = { attach, attachAll, commitAll, split };
})();
