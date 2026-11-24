/**
 * Settings: one topic per view.
 *
 * Every entry (.zr-settings-entry) stays inside the one settings form; this
 * module only decides which of them is visible. Hidden entries keep their
 * inputs, so saving still sends every field. The current entry lives in the
 * URL hash (#sso, #ai-provider), which makes reload and Back work, and the
 * hashes the page used before the regrouping still land on the right entry.
 *
 * It also owns "Find a setting" above the topic list (the matching itself is
 * in modules/settings-find.js), the groups of the topic list that fold in
 * and out, the unsaved-change dots in the topic list (fed by
 * modules/settings-form.js) and switching to the entry of a field the save
 * names in an error or the browser refuses as invalid.
 *
 * The page scrolls in a region of its own (data-el="scroller", see
 * pages/settings.css), not in the window: a new topic starts at the top of
 * that region, and the scroll keys work there from the first moment.
 */

import { describeResult, findSettings } from './settings-find.js';

/** Where a browser session remembers the groups a person opened. */
export const GROUPS_KEY = 'zr.settings.groups';

/**
 * Which groups of the topic list are open.
 *
 * Without a query: the group of the open topic, unless the person closed it
 * since that topic opened, and every group the person opened. While a query
 * stands: the groups that hold a match, unless the person closed one of them
 * during this query.
 *
 * @param {{ groups: string[], current: string|null, opened: Set<string>, closedCurrent: boolean, matched?: Set<string>|null, closedInSearch?: Set<string> }} state
 * @returns {Set<string>}
 */
export function openGroups({
  groups,
  current,
  opened,
  closedCurrent,
  matched = null,
  closedInSearch = new Set(),
}) {
  if (matched) {
    return new Set(
      groups.filter((key) => matched.has(key) && !closedInSearch.has(key))
    );
  }
  return new Set(
    groups.filter(
      (key) => opened.has(key) || (key === current && !closedCurrent)
    )
  );
}

/**
 * How far a key scrolls the region when nothing on the page has the focus,
 * or null for a key that does not scroll. Mirrors what the browser does for
 * the window.
 *
 * @param {{ key: string, shiftKey?: boolean }} event
 * @param {number} height the visible height of the region
 * @returns {number|'start'|'end'|null}
 */
export function scrollStep({ key, shiftKey = false }, height) {
  const page = Math.max(40, Math.round(height * 0.875));
  switch (key) {
    case 'PageDown':
      return page;
    case 'PageUp':
      return -page;
    case ' ':
      return shiftKey ? -page : page;
    case 'ArrowDown':
      return 40;
    case 'ArrowUp':
      return -40;
    case 'Home':
      return 'start';
    case 'End':
      return 'end';
    default:
      return null;
  }
}

// Hashes of entries and sections that were renamed or merged. Section ids
// (#sec-...) still on the page need no line here: any element id inside an
// entry resolves to that entry, also after its section moved to another
// topic (#sec-ai-function-limits opens What the AI fills in, #sec-ai-behavior
// opens Prompt). The ones below name something that is gone.
// tests/test-settings-topics.js pins where every old address lands.
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

/**
 * The key a location hash holds: without its "#", percent-decoded. A hash
 * that is not valid percent-encoding (#100%, #%E0%A4) is taken as written
 * rather than stopping the page.
 *
 * @param {string} hash
 * @returns {string}
 */
export function hashKey(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const ROW_SELECTOR = '.zr-field, .zr-switchrow, .zr-checktile';
const MATCH_CLASS = 'zr-settings-match';
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
  const searchStatus = root.querySelector('[data-el="search-status"]');
  const nav = root.querySelector('[data-el="nav"]');
  const form = root.querySelector('#setupForm');
  const scroller = root.querySelector('[data-el="scroller"]');
  const firstId = entries[0].dataset.entry;
  let current = null;

  /* --- the groups of the topic list ----------------------------------------- */

  const toggles = new Map(
    [...root.querySelectorAll('[data-nav-toggle]')].map((button) => [
      button.dataset.navToggle,
      button,
    ])
  );
  const groupKeys = [...toggles.keys()];
  const groupOfEntry = new Map(
    links.map((link) => [
      link.dataset.entryLink,
      link.closest('[data-nav-group]')?.dataset.navGroup || null,
    ])
  );
  const session = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();
  /** Groups the person opened, for this browser session. */
  const opened = new Set();
  try {
    const stored = JSON.parse(session?.getItem(GROUPS_KEY) || '[]');
    if (Array.isArray(stored)) {
      stored
        .filter((key) => toggles.has(key))
        .forEach((key) => opened.add(key));
    }
  } catch {
    // Nothing remembered, or storage refused: the defaults apply.
  }
  let closedCurrent = false;
  /** Groups with a match while a query stands, null without a query. */
  let matchedGroups = null;
  const closedInSearch = new Set();

  function remember() {
    try {
      session?.setItem(GROUPS_KEY, JSON.stringify([...opened]));
    } catch {
      // Storage refused (private mode, quota): the choice lasts for this page.
    }
  }

  function renderGroups() {
    const open = openGroups({
      groups: groupKeys,
      current: current ? groupOfEntry.get(current.dataset.entry) : null,
      opened,
      closedCurrent,
      matched: matchedGroups,
      closedInSearch,
    });
    toggles.forEach((button, key) => {
      const isOpen = open.has(key);
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      const items = root.querySelector(
        `#${button.getAttribute('aria-controls')}`
      );
      if (items) items.hidden = !isOpen;
    });
  }

  toggles.forEach((button, key) => {
    button.addEventListener('click', () => {
      const isOpen = button.getAttribute('aria-expanded') === 'true';
      const currentGroup = current
        ? groupOfEntry.get(current.dataset.entry)
        : null;
      if (matchedGroups) {
        if (isOpen) closedInSearch.add(key);
        else {
          closedInSearch.delete(key);
          matchedGroups.add(key);
        }
      } else if (isOpen) {
        opened.delete(key);
        if (key === currentGroup) closedCurrent = true;
      } else {
        opened.add(key);
        if (key === currentGroup) closedCurrent = false;
      }
      if (!matchedGroups) remember();
      renderGroups();
    });
  });

  /* --- the region that scrolls ------------------------------------------- */

  function scrollToTop() {
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // The window does not scroll on this page, and a browser sends the scroll
  // keys to the window while nothing has the focus: on a fresh page Page
  // Down would do nothing. With the focus on nothing, the keys scroll the
  // region instead; once something inside has the focus, the browser does.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const onScrollKey = (event) => {
    if (!scroller || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      return;
    }
    if (document.querySelector('dialog[open], .zr-fullscreen:not(.hidden)')) {
      return;
    }
    const step = scrollStep(event, scroller.clientHeight);
    if (step === null) return;
    event.preventDefault();
    const behavior = reduceMotion && reduceMotion.matches ? 'auto' : 'smooth';
    if (step === 'start') scroller.scrollTo({ top: 0, behavior });
    else if (step === 'end') {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    } else scroller.scrollBy({ top: step, behavior });
  };
  document.addEventListener('keydown', onScrollKey);

  /* --- navigation -------------------------------------------------------- */

  /**
   * Maps a hash onto an entry and, for a hash that named something inside
   * one (a section id from an old link), the element to scroll to.
   */
  function resolve(hash) {
    const key = hashKey(hash);
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
    if (changed) {
      // The group of a topic opened from elsewhere (a link, a hash, a
      // search) opens with it.
      closedCurrent = false;
      renderGroups();
      document.dispatchEvent(
        new CustomEvent('zr:settings-topic', {
          detail: { id: entry.dataset.entry },
        })
      );
    }
    if (changed && scroll) {
      // A new topic starts at its top, not at the scroll position the last one
      // was left at.
      scrollToTop();
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
    revealMatches(show(id));
  }

  function syncFromLocation() {
    const { id, target } = resolve(location.hash);
    const entry = show(id, { scroll: !target });
    // An old hash is rewritten to the new one, so the address bar and any
    // bookmark made from it name the topic as the list does.
    const key = location.hash.replace(/^#/, '');
    if (key && key !== id && !target) {
      history.replaceState(null, '', hashFor(id) || location.pathname);
    }
    if (target) reveal(target, { focus: false });
    else revealMatches(entry);
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
    // A row comes to rest in the middle of the region; a whole section or
    // disclosure (an old #sec-... link) with its title at the top.
    row.scrollIntoView({
      block: row.matches(ROW_SELECTOR) ? 'center' : 'start',
      behavior: 'auto',
    });
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
    // A closed group shows the dot of its topics on its heading.
    const dirtyGroups = new Set(
      [...dirtyEntries].map((id) => groupOfEntry.get(id)).filter(Boolean)
    );
    root.querySelectorAll('[data-group-dirty]').forEach((dot) => {
      dot.classList.toggle('hidden', !dirtyGroups.has(dot.dataset.groupDirty));
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

  /* --- find a setting ----------------------------------------------------- */

  /** The text of a row's own label, without the badges or buttons in it. */
  function labelOf(row) {
    const labelEl = row.querySelector('label, .zr-field__name') || row;
    return norm(
      [...labelEl.childNodes]
        .filter(
          (node) =>
            node.nodeType === Node.TEXT_NODE ||
            !node.matches?.('.zr-badge, button')
        )
        .map((node) => node.textContent)
        .join(' ')
    );
  }

  /**
   * The hints a person sees on a row. Hints that take turns (the OCR key says
   * one thing for Claude and another for the rest) are left out while their
   * turn has not come.
   */
  function hintsOf(row) {
    return [...row.querySelectorAll('.zr-field__hint')].filter((hint) => {
      const hidden = hint.closest('.hidden');
      return !hidden || hidden === row || !row.contains(hidden);
    });
  }

  /**
   * The row of the card a row belongs to: an AI option and the automatic
   * processing switch are wrapped one row to a box, and the box is what the
   * card lays out as its row.
   */
  function cardRowOf(row) {
    const parent = row.parentElement;
    if (
      parent &&
      parent.matches('.zr-field, .zr-settings-option') &&
      parent.querySelectorAll(ROW_SELECTOR).length === 1
    ) {
      return parent;
    }
    return row;
  }

  /**
   * What a match marks. A row on screen (a closed disclosure counts, it is
   * opened) marks itself. A row a switch hides, such as the OCR fields while
   * OCR is off, marks that switch: the block a switch shows sits right after
   * it, or names the switch in data-shown-by when it stands in a section of
   * its own. A row hidden for another reason (the fields and options of a
   * provider that is not selected) marks nothing and is not counted.
   */
  function markFor(row, entry) {
    let hidden = null;
    for (let node = row; node && node !== entry; node = node.parentElement) {
      if (node.classList.contains('hidden')) hidden = node;
    }
    if (!hidden) return cardRowOf(row);
    if (hidden.matches('[data-providers]')) return null;
    if (hidden.dataset.shownBy) {
      const switchRow = entry
        .querySelector(`#${hidden.dataset.shownBy}`)
        ?.closest('.zr-switchrow');
      return switchRow ? cardRowOf(switchRow) : null;
    }
    let gate = hidden.previousElementSibling;
    while (gate && gate.classList.contains('hidden')) {
      gate = gate.previousElementSibling;
    }
    if (!gate) return null;
    const gateRow = gate.matches('.zr-switchrow')
      ? gate
      : gate.querySelector(':scope > .zr-switchrow');
    return gateRow ? cardRowOf(gateRow) : null;
  }

  /**
   * Every setting row of every topic, read from the page each time: switches
   * show and hide rows, settings.js adds the env keys after this module
   * mounts, and rows can appear later (custom fields).
   */
  function indexRows() {
    const items = [];
    entries.forEach((entry) => {
      entry.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        // A field that wraps other fields (the OCR block) is a container, not
        // a setting of its own.
        if (row.matches('.zr-field') && row.querySelector(ROW_SELECTOR)) return;
        const label = labelOf(row);
        if (!label) return;
        const hint = norm(
          hintsOf(row)
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
        const choices = [...row.querySelectorAll('select option')].map(
          (option) => norm(option.textContent)
        );
        items.push({
          entry,
          row,
          topic: entry.dataset.entry,
          label,
          hint,
          envKeys,
          choices,
          mark: markFor(row, entry),
        });
      });
    });
    return items;
  }

  const topics = entries.map((entry) => ({
    id: entry.dataset.entry,
    title: entry.dataset.title || '',
    group: entry.dataset.group || '',
  }));
  let searching = false;
  // Disclosures opened to show a match; closed again when the field is
  // cleared, so the page looks as it did before the search.
  const openedBySearch = new Set();

  let lastQuery = '';

  function runSearch() {
    if (!search) return;
    const query = search.value;
    const result = findSettings(
      query,
      topics,
      indexRows().filter((item) => item.mark)
    );
    searching = result.active;
    root.toggleAttribute('data-searching', searching);
    // A new query opens every group with a match again.
    if (query.trim() !== lastQuery) closedInSearch.clear();
    lastQuery = query.trim();

    root
      .querySelectorAll(`.${MATCH_CLASS}`)
      .forEach((row) => row.classList.remove(MATCH_CLASS));
    result.items.forEach((item) => item.mark.classList.add(MATCH_CLASS));

    const counts = new Map(
      result.topics.map((topic) => [topic.id, topic.count])
    );
    links.forEach((link) => {
      const id = link.dataset.entryLink;
      link.classList.toggle('hidden', searching && !counts.has(id));
      const badge = link.querySelector('[data-entry-count]');
      if (!badge) return;
      const count = searching ? counts.get(id) || 0 : 0;
      badge.classList.toggle('hidden', count === 0);
      if (count === 0) {
        badge.replaceChildren();
        return;
      }
      // The number for the eye, the words for a screen reader.
      const words = document.createElement('span');
      words.className = 'zr-sr';
      words.textContent =
        count === 1 ? ' matching setting' : ' matching settings';
      badge.replaceChildren(String(count), words);
    });
    nav?.querySelectorAll('[data-nav-group]').forEach((group) => {
      group.classList.toggle(
        'hidden',
        searching && !group.querySelector('[data-entry-link]:not(.hidden)')
      );
    });
    // A group with a match opens; closed by hand, its heading carries the
    // count of its topics.
    matchedGroups = searching
      ? new Set(
          result.topics
            .map((topic) => groupOfEntry.get(topic.id))
            .filter(Boolean)
        )
      : null;
    root.querySelectorAll('[data-group-count]').forEach((badge) => {
      const key = badge.dataset.groupCount;
      const count = searching
        ? result.topics
            .filter((topic) => groupOfEntry.get(topic.id) === key)
            .reduce((sum, topic) => sum + topic.count, 0)
        : 0;
      badge.classList.toggle('hidden', count === 0);
      const words = document.createElement('span');
      words.className = 'zr-sr';
      words.textContent =
        count === 1 ? ' matching setting' : ' matching settings';
      if (count) badge.replaceChildren(String(count), words);
      else badge.replaceChildren();
    });
    renderGroups();
    if (searchStatus) searchStatus.textContent = describeResult(result, query);

    if (!searching) closeOpenedDisclosures();
  }

  /**
   * Shows the matches of the topic just opened: closed disclosures holding
   * one are opened, and the first match is scrolled into view.
   */
  function revealMatches(entry) {
    if (!searching || !entry) return;
    const marked = [...entry.querySelectorAll(`.${MATCH_CLASS}`)];
    if (!marked.length) return;
    marked.forEach((row) => {
      const details = row.closest('details');
      if (details && !details.open) {
        details.open = true;
        openedBySearch.add(details);
      }
    });
    marked[0].scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  function closeOpenedDisclosures() {
    openedBySearch.forEach((details) => {
      details.open = false;
    });
    openedBySearch.clear();
  }

  function clearSearch() {
    search.value = '';
    runSearch();
  }

  /** The topics the list shows, in its order. */
  function listedLinks() {
    return links.filter(
      (link) =>
        !link.classList.contains('hidden') && !link.closest('.hidden, [hidden]')
    );
  }

  if (search) {
    search.addEventListener('input', runSearch);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && search.value) {
        event.preventDefault();
        clearSearch();
      } else if (event.key === 'Enter') {
        // Enter in the field opens the first topic listed and never submits
        // the settings form.
        event.preventDefault();
        const first = listedLinks()[0];
        if (first) go(first.dataset.entryLink);
      } else if (event.key === 'ArrowDown') {
        const first = listedLinks()[0];
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    // A browser that restores the field on Back finds the list as it was.
    if (search.value) runSearch();
  }

  if (nav) {
    nav.addEventListener('click', (event) => {
      const link = event.target.closest('[data-entry-link]');
      // The topic already open: no hash change follows, so its matches are
      // shown from here.
      if (link && searching && byId.get(link.dataset.entryLink) === current) {
        event.preventDefault();
        revealMatches(current);
      }
    });
  }

  syncFromLocation();

  return {
    destroy() {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
      document.removeEventListener('keydown', onScrollKey);
    },
  };
}
