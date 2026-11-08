/**
 * Settings: one topic per view.
 *
 * Every entry (.zr-settings-entry) stays inside the one settings form; this
 * module only decides which of them is visible. Hidden entries keep their
 * inputs, so saving still sends every field. The current entry lives in the
 * URL hash (#sso, #ai-provider), which makes reload and Back work, and the
 * hashes the page used before the regrouping still land on the right entry.
 *
 * It also owns the settings search, the unsaved-change dots in the topic list
 * (fed by modules/settings-form.js) and switching to the entry of a field the
 * save names in an error or the browser refuses as invalid.
 */

// Hashes of entries and sections that were renamed or merged. Section ids
// (#sec-...) still on the page need no line here: any element id inside an
// entry resolves to that entry. The ones below name something that is gone.
export const ENTRY_ALIASES = Object.freeze({
  // Before the regrouping into one topic per view.
  'system-tab': 'connection',
  'mfa-tab': 'account',
  'ai-tab': 'ai-provider',
  'duplicates-tab': 'tidy-up',
  'simplify-tab': 'tidy-up',
  'ocr-tab': 'ocr',
  'troubleshooting-tab': 'caching',
  'env-tab': 'environment',
  'changelog-tab': 'changelog',
  // Duplicates and Simplify tags became one page, Tidy up, and one section.
  duplicates: 'tidy-up',
  simplify: 'tidy-up',
  'sec-duplicates': 'tidy-up',
  'sec-duplicates-advanced': 'tidy-up',
  'sec-simplify': 'tidy-up',
});

/**
 * The entry a hash names directly or through an alias, or null when it names
 * neither (then it may still be an element inside an entry).
 *
 * @param {string} key  the hash without its "#"
 * @param {(id: string) => boolean} isEntry
 * @returns {string|null}
 */
export function entryForHash(key, isEntry) {
  if (!key) return null;
  if (isEntry(key)) return key;
  const alias = Object.prototype.hasOwnProperty.call(ENTRY_ALIASES, key)
    ? ENTRY_ALIASES[key]
    : null;
  return alias && isEntry(alias) ? alias : null;
}

const MAX_RESULTS = 12;
const ROW_SELECTOR = '.zr-field, .zr-switchrow, .zr-checktile';
const CONTROL_SELECTOR =
  'input:not([type="hidden"]), select, textarea, button, [tabindex]';

const norm = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

export default function settingsNav(root) {
  const entries = [...root.querySelectorAll('.zr-settings-entry')];
  if (!entries.length) return undefined;

  const byId = new Map(entries.map((entry) => [entry.dataset.entry, entry]));
  const links = [...root.querySelectorAll('[data-entry-link]')];
  const select = root.querySelector('[data-el="select"]');
  const search = root.querySelector('[data-el="search"]');
  const results = root.querySelector('[data-el="results"]');
  const form = root.querySelector('#setupForm');
  const firstId = entries[0].dataset.entry;
  let current = null;

  /* --- navigation -------------------------------------------------------- */

  /**
   * Maps a hash onto an entry and, for a hash that named something inside
   * one (a section id from an old link), the element to scroll to.
   */
  function resolve(hash) {
    const key = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!key) return { id: firstId, target: null };
    const named = entryForHash(key, (id) => byId.has(id));
    if (named) return { id: named, target: null };
    const element = document.getElementById(key);
    const entry = element && element.closest('.zr-settings-entry');
    if (entry) {
      return {
        id: entry.dataset.entry,
        target: element === entry ? null : element,
      };
    }
    return { id: firstId, target: null };
  }

  function show(id, { scroll = true } = {}) {
    const entry = byId.get(id) || byId.get(firstId);
    const changed = entry !== current;
    entries.forEach((item) => item.classList.toggle('hidden', item !== entry));
    links.forEach((link) =>
      link.setAttribute(
        'aria-current',
        link.dataset.entryLink === entry.dataset.entry ? 'page' : 'false'
      )
    );
    if (select && select.value !== entry.dataset.entry) {
      select.value = entry.dataset.entry;
    }
    current = entry;
    if (changed && scroll) {
      // A new topic starts at its top, not at the scroll position the last one
      // was left at.
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    return entry;
  }

  function hashFor(id) {
    return id === firstId && !location.hash ? '' : `#${id}`;
  }

  /** Navigates like a link would: one history step per topic. */
  function go(id) {
    if (!byId.has(id)) return;
    if (location.hash !== `#${id}`) {
      history.pushState(null, '', `#${id}`);
    }
    show(id);
  }

  function syncFromLocation() {
    const { id, target } = resolve(location.hash);
    show(id, { scroll: !target });
    // An old hash is rewritten to the new one, so the address bar and any
    // bookmark made from it name the topic as the list does.
    const key = location.hash.replace(/^#/, '');
    if (key && key !== id && !target) {
      history.replaceState(null, '', hashFor(id) || location.pathname);
    }
    if (target) reveal(target, { focus: false });
  }

  window.addEventListener('hashchange', syncFromLocation);
  window.addEventListener('popstate', syncFromLocation);

  if (select) {
    select.addEventListener('change', () => go(select.value));
  }

  /**
   * Opens the entry an element sits in and brings the element into view.
   * Optional sub-blocks the element sits in (a provider's fields while another
   * provider is selected) are not forced open: the nearest visible ancestor is
   * shown instead.
   */
  function reveal(element, { focus = true } = {}) {
    const entry = element.closest('.zr-settings-entry');
    if (!entry) return;
    if (entry !== current) {
      if (location.hash !== `#${entry.dataset.entry}`) {
        history.pushState(null, '', `#${entry.dataset.entry}`);
      }
      show(entry.dataset.entry, { scroll: false });
    }
    const advanced = element.closest('details');
    if (advanced) advanced.open = true;

    let visible = element;
    while (visible && visible !== entry && visible.closest('.hidden')) {
      visible = visible.parentElement;
    }
    const row = (visible || entry).closest(ROW_SELECTOR) || visible || entry;
    row.scrollIntoView({ block: 'center', behavior: 'auto' });
    flash(row);

    if (focus) {
      const control = controlOf(element);
      if (control && !control.closest('.hidden') && !control.disabled) {
        control.focus({ preventScroll: true });
      }
    }
  }

  function flash(row) {
    row.classList.remove('zr-settings-flash');
    // Restart the animation when the same row is picked twice.
    void row.offsetWidth;
    row.classList.add('zr-settings-flash');
    setTimeout(() => row.classList.remove('zr-settings-flash'), 1600);
  }

  /** The control a person can actually focus for a field or a row. */
  function controlOf(element) {
    if (element.matches('input[type="hidden"]')) {
      return root.querySelector(`[data-switch-target="${element.id}"]`) || null;
    }
    if (element.matches(CONTROL_SELECTOR)) return element;
    return element.querySelector(CONTROL_SELECTOR);
  }

  /* --- unsaved-change dots ------------------------------------------------ */

  document.addEventListener('zr:settings-dirty', (event) => {
    const fields = (event.detail && event.detail.fields) || [];
    const dirtyEntries = new Set(
      fields
        .map((field) => field.closest('.zr-settings-entry'))
        .filter(Boolean)
        .map((entry) => entry.dataset.entry)
    );
    root.querySelectorAll('[data-entry-dirty]').forEach((dot) => {
      dot.classList.toggle('hidden', !dirtyEntries.has(dot.dataset.entryDirty));
    });
  });

  /* --- fields the save or the browser refuses ------------------------------ */

  if (form) {
    // A required field in a hidden entry cannot show the browser's message,
    // and the submit would fail without a word. Opening its entry first lets
    // the browser point at it.
    form.addEventListener(
      'invalid',
      (event) => {
        const field = event.target;
        if (field && field.closest('.zr-settings-entry') !== current) {
          reveal(field, { focus: false });
        }
      },
      true
    );
  }

  document.addEventListener('zr:settings-save-error', (event) => {
    const message = String((event.detail && event.detail.message) || '');
    const field = fieldNamedIn(message);
    if (field) reveal(field);
  });

  /**
   * The field an error message names: by its env key (OIDC_ISSUER_URL), by
   * the body key the form sends (oidcIssuerUrl), or by its label.
   */
  function fieldNamedIn(message) {
    if (!message || !form) return null;
    const text = message.toLowerCase();
    const named = [...form.querySelectorAll('[name], [data-env-key]')];

    const byEnvKey = named
      .filter((field) => field.dataset.envKey)
      .sort((a, b) => b.dataset.envKey.length - a.dataset.envKey.length)
      .find((field) =>
        new RegExp(`\\b${field.dataset.envKey}\\b`).test(message)
      );
    if (byEnvKey) return byEnvKey;

    const byName = named.find(
      (field) => field.name && new RegExp(`\\b${field.name}\\b`).test(message)
    );
    if (byName) return byName;

    let best = null;
    let bestLength = 0;
    indexRows().forEach((item) => {
      const label = item.label.toLowerCase();
      if (
        label.length >= 6 &&
        label.length > bestLength &&
        text.includes(label)
      ) {
        best = item.row;
        bestLength = label.length;
      }
    });
    return best;
  }

  /* --- search ------------------------------------------------------------- */

  /**
   * Every searchable row, built on demand: settings.js adds the env keys after
   * this module mounts, and rows can appear later (custom fields).
   */
  function indexRows() {
    const items = [];
    entries.forEach((entry) => {
      entry.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        // A field that wraps other fields (the OCR block) is a container, not
        // a setting of its own.
        if (row.matches('.zr-field') && row.querySelector(ROW_SELECTOR)) return;
        const labelEl = row.querySelector('label, .zr-field__name') || row;
        const label = norm(
          [...labelEl.childNodes]
            .filter(
              (node) =>
                node.nodeType === Node.TEXT_NODE ||
                !node.matches?.('.zr-badge, button')
            )
            .map((node) => node.textContent)
            .join(' ')
        );
        if (!label) return;
        const hint = norm(
          [...row.querySelectorAll('.zr-field__hint')]
            .map((p) => p.textContent)
            .join(' ')
        );
        const envKeys = [
          ...new Set(
            [...row.querySelectorAll('[data-env-key]')]
              .map((field) => field.dataset.envKey)
              .concat(hint.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [])
          ),
        ];
        items.push({ entry, row, label, hint, envKeys });
      });
    });
    return items;
  }

  function matches(query) {
    const words = norm(query).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) return [];
    const scored = [];

    entries.forEach((entry) => {
      const title =
        `${entry.dataset.title} ${entry.dataset.group}`.toLowerCase();
      if (words.every((word) => title.includes(word))) {
        scored.push({ kind: 'entry', entry, score: 3 });
      }
    });

    indexRows().forEach((item) => {
      const label = item.label.toLowerCase();
      const keys = item.envKeys.join(' ').toLowerCase();
      // SCAN_INTERVAL is found by "scan interval" as well as by its own name.
      const keysSpaced = keys.replace(/_/g, ' ');
      const haystack = `${label} ${item.hint.toLowerCase()} ${keys} ${keysSpaced}`;
      if (!words.every((word) => haystack.includes(word))) return;
      const inLabel = words.every((word) => label.includes(word));
      const inKey = words.every(
        (word) => keys.includes(word) || keysSpaced.includes(word)
      );
      scored.push({
        kind: 'field',
        ...item,
        score: inLabel ? 2 : inKey ? 1.5 : 1,
      });
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  }

  let active = -1;
  let shown = [];

  function closeResults() {
    if (!results) return;
    results.classList.add('hidden');
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function renderResults() {
    const query = search.value;
    shown = matches(query);
    filterNav(query);
    results.replaceChildren();
    if (!norm(query)) {
      closeResults();
      return;
    }

    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'zr-settings-search__empty zr-sm zr-muted';
      empty.textContent =
        'No setting matches. Try a word from its label or its environment variable.';
      results.append(empty);
    }

    shown.forEach((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'zr-settings-search__item';
      option.id = `settingsSearchOption${index}`;
      option.setAttribute('role', 'option');
      option.dataset.index = String(index);

      const name = document.createElement('span');
      name.className = 'zr-settings-search__name';
      name.textContent =
        item.kind === 'entry' ? item.entry.dataset.title : item.label;
      const path = document.createElement('span');
      path.className = 'zr-settings-search__path';
      path.textContent =
        item.kind === 'entry'
          ? item.entry.dataset.group
          : `${item.entry.dataset.group} › ${item.entry.dataset.title}`;
      option.append(name, path);

      if (item.kind === 'field' && item.envKeys.length) {
        const key = document.createElement('code');
        key.className = 'zr-settings-search__key';
        key.textContent = item.envKeys[0];
        option.append(key);
      }
      results.append(option);
    });

    results.classList.remove('hidden');
    search.setAttribute('aria-expanded', 'true');
    setActive(shown.length ? 0 : -1);
  }

  function setActive(index) {
    active = index;
    [...results.querySelectorAll('[role="option"]')].forEach((option, i) =>
      option.setAttribute('aria-selected', i === index ? 'true' : 'false')
    );
    if (index >= 0) {
      search.setAttribute(
        'aria-activedescendant',
        `settingsSearchOption${index}`
      );
      results
        .querySelector(`#settingsSearchOption${index}`)
        ?.scrollIntoView({ block: 'nearest' });
    } else {
      search.removeAttribute('aria-activedescendant');
    }
  }

  function pick(index) {
    const item = shown[index];
    if (!item) return;
    closeResults();
    if (item.kind === 'entry') {
      go(item.entry.dataset.entry);
      return;
    }
    reveal(item.row);
  }

  /** Dims the topics that hold nothing matching the query. */
  function filterNav(query) {
    const hasQuery = Boolean(norm(query));
    const hit = new Set(shown.map((item) => item.entry.dataset.entry));
    links.forEach((link) =>
      link.classList.toggle(
        'zr-settings-nav__miss',
        hasQuery && !hit.has(link.dataset.entryLink)
      )
    );
  }

  if (search && results) {
    search.addEventListener('input', renderResults);
    search.addEventListener('focus', () => {
      if (norm(search.value)) renderResults();
    });
    search.addEventListener('keydown', (event) => {
      const count = shown.length;
      if (event.key === 'ArrowDown' && count) {
        event.preventDefault();
        if (results.classList.contains('hidden')) renderResults();
        setActive((active + 1) % count);
      } else if (event.key === 'ArrowUp' && count) {
        event.preventDefault();
        setActive((active - 1 + count) % count);
      } else if (event.key === 'Enter') {
        // Enter in the search field must never submit anything.
        event.preventDefault();
        if (active >= 0) pick(active);
      } else if (event.key === 'Escape') {
        if (!results.classList.contains('hidden')) {
          event.preventDefault();
          closeResults();
        } else if (search.value) {
          search.value = '';
          renderResults();
        }
      }
    });
    results.addEventListener('mousedown', (event) => {
      // Keeps the focus in the field until the click has picked something.
      event.preventDefault();
    });
    results.addEventListener('click', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) pick(Number(option.dataset.index));
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.zr-settings-search')) closeResults();
    });
  }

  syncFromLocation();

  return {
    destroy() {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    },
  };
}
