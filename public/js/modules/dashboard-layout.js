/**
 * Dashboard layout module.
 *
 * The dashboard is view-only until the user asks for it: "Edit dashboard" opens
 * a session, and only inside that session can a card be dragged by its head,
 * resized from its corner grip, or switched off from the tray above the grid.
 * Nothing is written while the session runs — Done sends the whole arrangement
 * in one request, Cancel puts the grid back exactly as it was found. A
 * dashboard that is only being read never writes anything, and a session the
 * user walks away from leaves no trace.
 *
 * Both axes snap — width to the 12 grid columns the cards already use via
 * data-span, height to whole tile rows — so a resized card lines up with its
 * neighbours instead of landing at an arbitrary pixel height. The result is
 * stored per user through /api/dashboard/layout, so it follows them to another
 * browser.
 *
 * A sized card is a tile, not a document: it shows what fits and never scrolls.
 * What did not fit fades out, and the card's own footer link is the way to the
 * full list. The content adapts to the tile through the height container
 * queries in pages/dashboard.css.
 *
 * The wire format is storage v1 (documented in routes/dashboard.js): named
 * dashboards, each holding its cards in display order. This module ships a
 * single board and only ever writes that one; it reads back whichever board the
 * stored config points at, so a later multi-board UI can grow around it without
 * changing what is on disk.
 *
 * Below 861px the grid is a single column and every card spans the full width,
 * so a session cannot be opened there rather than storing a layout nobody can
 * see. A viewport that shrinks mid-session ends it the way Cancel does.
 */

const LAYOUT_URL = '/api/dashboard/layout';
const GRID_COLUMNS = 12;
const MIN_SPAN = 3;
// Tile rows. Three rows still fit a card's head plus a line of content; more
// than 24 is taller than any viewport this grid is used on.
const MIN_ROWS = 3;
const MAX_ROWS = 24;
const DESKTOP_QUERY = '(min-width: 861px)';
// Below this, modules.css collapses the grid to two usable widths: spans 3, 4
// and 6 render as half, everything else as full. Snapping to the raw 1..12
// model there hands the user a card that jumps backwards under their own
// pointer and stores a width they never saw, so the snapping follows the
// stylesheet instead. Keep the two in step — see the media query in
// public/css/modules.css.
const WIDE_QUERY = '(min-width: 1181px)';
const HALF_SPAN = 6;
const REQUEST_TIMEOUT_MS = 15000;

/* The one board this module owns. The slug and the name are validated on the
   way in, so they are spelled the same way the server's own defaults are. */
const STORAGE_VERSION = 1;
const BOARD_SLUG = 'default';
const BOARD_NAME = 'Dashboard';

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export default function dashboardLayout(grid, { toast } = {}) {
  const cards = [...grid.querySelectorAll('[data-widget]')];
  if (cards.length === 0) return undefined;

  const desktop = window.matchMedia(DESKTOP_QUERY);
  // Editing is offered from 861px, but the grid only honours every span from
  // 1181px. Between the two, resizing has fewer widths to offer — see snapSpan.
  const wide = window.matchMedia(WIDE_QUERY);
  const cardsById = new Map(cards.map((card) => [card.dataset.widget, card]));
  // The order and spans the server rendered, every card showing. Reset means
  // going back to these, and they have to be captured before a stored layout is
  // applied over them.
  const defaults = cards.map((card) => ({
    card,
    span: Number(card.dataset.span) || GRID_COLUMNS,
  }));

  // Every listener put on something that outlives this module goes through this
  // signal, so destroy() is one abort() instead of a list to keep in sync.
  const listeners = new AbortController();
  const { signal } = listeners;

  // The tray is server-rendered (views/dashboard.ejs) and starts hidden. It is
  // the entire UI of the session, so without it the grid stays view-only.
  const editbar = document.getElementById('dashboardEditbar');
  const chips = new Map();

  let sortable = null;
  let layoutBar = null;
  let editButton = null;
  let editing = false;
  let saving = false;
  // Editing before the stored layout has landed would arrange cards that are
  // about to be rearranged by the answer, so the way in opens once it is here.
  let ready = false;
  // The grid as the session found it: what Cancel puts back.
  let snapshot = null;
  // "Give me the defaults back" is a different write from "store this": see
  // commitEdit().
  let resetRequested = false;

  /* --- reading and writing the grid -------------------------------------- */

  function currentLayout() {
    return {
      version: STORAGE_VERSION,
      active: BOARD_SLUG,
      dashboards: [
        {
          slug: BOARD_SLUG,
          name: BOARD_NAME,
          widgets: [...grid.querySelectorAll('[data-widget]')].map((card) => ({
            id: card.dataset.widget,
            span: Number(card.dataset.span) || GRID_COLUMNS,
            rows: Number(card.dataset.rows) || 0,
            hidden: card.classList.contains('is-hidden'),
          })),
        },
      ],
    };
  }

  function setSpan(card, span) {
    card.dataset.span = String(clamp(span, MIN_SPAN, GRID_COLUMNS));
  }

  /* Rows, not pixels: the stylesheet turns --zr-rows into a height, so the
     card can only ever be a whole number of tile rows tall. 0 hands the card
     back to its content. */
  function setRows(card, rows) {
    if (!rows) {
      delete card.dataset.rows;
      card.style.removeProperty('--zr-rows');
      markClipping();
      return;
    }
    const value = clamp(Math.round(rows), MIN_ROWS, MAX_ROWS);
    card.dataset.rows = String(value);
    card.style.setProperty('--zr-rows', String(value));
    markClipping();
  }

  /* Switched off is a class, never a removal: the card keeps its place in the
     DOM, so its own module keeps its instance and the dashboard's fetch goes on
     writing into it. Switching it back on costs nothing and shows live numbers
     rather than an empty card. The stylesheet decides what "off" looks like —
     gone while reading, faded but still draggable inside the session. */
  function setHidden(card, hidden) {
    card.classList.toggle('is-hidden', hidden);
    markClipping();
  }

  /* Only a child that really overflows gets the fade, so a card whose content
     happens to fit keeps its last line crisp. Batched through one frame: the
     measurement has to happen after the browser applied the new height, and
     the observer below can fire many times per update. */
  let clipFrame = 0;
  function markClipping() {
    if (clipFrame) return;
    clipFrame = requestAnimationFrame(() => {
      clipFrame = 0;
      cards.forEach((card) => {
        const sized = Boolean(card.dataset.rows);
        card.querySelectorAll(':scope > *').forEach((child) => {
          // Only the children the stylesheet actually clips can hide content;
          // a one-line footer reports a few pixels of scrollHeight from its
          // own padding and would otherwise fade for nothing.
          const clips = getComputedStyle(child).overflowY === 'hidden';
          child.classList.toggle(
            'is-clipped',
            sized && clips && child.scrollHeight > child.clientHeight + 1
          );
        });
      });
    });
  }

  /* The dashboard fills these cards from its own fetch, long after the layout
     was applied — what fits changes with the data. Attributes are left out on
     purpose: is-clipped is one, and observing it would feed itself. */
  const contentObserver = new MutationObserver(markClipping);
  contentObserver.observe(grid, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  function applyLayout(data) {
    const dashboards = Array.isArray(data?.dashboards) ? data.dashboards : [];
    // active is a pointer, and a stale one falls back to the first board rather
    // than to nothing — the same rule the server applies when it stores.
    const board =
      dashboards.find((entry) => entry?.slug === data?.active) || dashboards[0];
    const stored = Array.isArray(board?.widgets) ? board.widgets : [];

    // Nothing arranged — no config, no boards, or a board that only carries a
    // name — means the arrangement the server rendered.
    if (stored.length === 0) {
      applyDefaults();
      return;
    }

    const pending = new Map(cardsById);
    stored.forEach((entry) => {
      const card = pending.get(entry?.id);
      // A stored id the dashboard no longer ships is simply dropped.
      if (!card) return;
      setSpan(card, Number(entry.span));
      setRows(card, Number(entry.rows) || 0);
      setHidden(card, Boolean(entry.hidden));
      grid.appendChild(card);
      pending.delete(entry.id);
    });
    // A card the stored layout predates is new to this user: an update that
    // ships a widget has to surface it, so it lands at the end and shows.
    pending.forEach((card) => {
      setHidden(card, false);
      grid.appendChild(card);
    });

    syncChips();
  }

  function applyDefaults() {
    defaults.forEach(({ card, span }) => {
      setSpan(card, span);
      setRows(card, 0);
      setHidden(card, false);
      grid.appendChild(card);
    });
    syncChips();
  }

  /* --- the edit session -------------------------------------------------- */

  function takeSnapshot() {
    return [...grid.querySelectorAll('[data-widget]')].map((card) => ({
      card,
      span: Number(card.dataset.span) || GRID_COLUMNS,
      rows: Number(card.dataset.rows) || 0,
      hidden: card.classList.contains('is-hidden'),
    }));
  }

  /* Re-appending every card in the order it was captured in restores the order
     as a side effect, so one pass puts back all four properties. */
  function restoreSnapshot(entries) {
    (entries || []).forEach(({ card, span, rows, hidden }) => {
      setSpan(card, span);
      setRows(card, rows);
      setHidden(card, hidden);
      grid.appendChild(card);
    });
    syncChips();
  }

  /* Anything the user does after a reset means they are building on top of the
     defaults, so Done has to store that arrangement instead of clearing the
     row. Every interactive path calls this. */
  function markEdited() {
    resetRequested = false;
  }

  function enterEdit() {
    if (editing || saving || !ready || !editbar || !desktop.matches) return;
    snapshot = takeSnapshot();
    resetRequested = false;
    editing = true;
    grid.classList.add('is-editing');
    editbar.classList.remove('hidden');
    syncEditButton();
    enableSorting();
    markClipping();
    // The button that opened the session has just hidden itself, so the focus
    // it held would fall to the top of the document; the tray takes it over.
    editbar.focus();
  }

  function leaveEdit() {
    if (!editing) return;
    editing = false;
    snapshot = null;
    resetRequested = false;
    grid.classList.remove('is-editing');
    editbar.classList.add('hidden');
    disableSorting();
    syncEditButton();
    markClipping();
    // Focus goes back to the control that opened the session — unless the
    // viewport just took that control away, which is the mid-session shrink.
    if (editButton && !editButton.classList.contains('hidden')) {
      editButton.focus();
    }
  }

  function cancelEdit() {
    if (!editing) return;
    restoreSnapshot(snapshot);
    leaveEdit();
  }

  /* Reset inside the session only touches the grid. Nothing is written until
     Done, so a reset the user thinks better of is undone by Cancel like any
     other change. */
  function resetInSession() {
    if (!editing || saving) return;
    applyDefaults();
    // What Done will write, until the next edit clears it again.
    resetRequested = true;
  }

  function setBusy(busy) {
    saving = busy;
    editbar
      ?.querySelectorAll('.zr-editbar__actions button, .zr-editbar__chip')
      .forEach((button) => {
        button.disabled = busy;
      });
  }

  async function commitEdit() {
    if (!editing || saving) return;
    const wasReset = resetRequested;
    /* A reset the user confirms with Done clears the stored layout rather than
       storing a default-shaped one. That is the difference between "I like the
       current defaults" and "give me the defaults" — only the second keeps
       following them, so a release that changes a span or ships a new card
       reaches this user instead of being frozen out by their own copy of
       yesterday's defaults. An empty dashboards list is what the server reads
       as "nothing arranged"; if it ever stopped doing so the write would be
       rejected rather than silently stored wrong. */
    const payload = wasReset
      ? { version: STORAGE_VERSION, active: BOARD_SLUG, dashboards: [] }
      : currentLayout();

    setBusy(true);
    try {
      await fetchJson(LAYOUT_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      leaveEdit();
      toast?.(
        wasReset ? 'Dashboard layout reset.' : 'Dashboard layout saved.',
        {
          tone: 'ok',
        }
      );
    } catch (error) {
      // The session stays open on failure: the arrangement is still on screen,
      // and one more click on Done is a cheaper recovery than doing it again.
      console.error('[dashboard-layout] saving failed', error);
      toast?.('Could not save the dashboard layout.', { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  /* --- the tray ---------------------------------------------------------- */

  /* aria-pressed is the state: pressed means the card is on the dashboard. It
     is derived from the cards themselves rather than tracked alongside them, so
     the chips cannot drift from what is on screen. */
  function syncChips() {
    chips.forEach((chip, id) => {
      const card = cardsById.get(id);
      if (!card) return;
      chip.setAttribute(
        'aria-pressed',
        String(!card.classList.contains('is-hidden'))
      );
    });
  }

  function setupChips() {
    if (!editbar) return;
    editbar.querySelectorAll('[data-widget-toggle]').forEach((chip) => {
      const id = chip.dataset.widgetToggle;
      const card = cardsById.get(id);
      // A chip whose card is not on the page would toggle nothing, which is
      // worse than no chip at all.
      if (!card) {
        chip.remove();
        return;
      }
      // The label is filled from the card, not from the registry: the title is
      // already in the partial, and a second copy would drift from it.
      const label = chip.querySelector('span') || chip;
      label.textContent =
        card.querySelector('.zr-module__title')?.textContent?.trim() || id;
      chip.addEventListener(
        'click',
        () => {
          setHidden(card, !card.classList.contains('is-hidden'));
          syncChips();
          markEdited();
        },
        { signal }
      );
      chips.set(id, chip);
    });
    syncChips();
  }

  function wireEditbar() {
    if (!editbar) return;
    editbar
      .querySelector('#dashboardEditReset')
      ?.addEventListener('click', resetInSession, { signal });
    editbar
      .querySelector('#dashboardEditCancel')
      ?.addEventListener('click', cancelEdit, { signal });
    editbar
      .querySelector('#dashboardEditDone')
      ?.addEventListener('click', commitEdit, { signal });
  }

  /* --- the way in -------------------------------------------------------- */

  function syncEditButton() {
    if (!editButton) return;
    // One control at a time: the button opens the session, the tray runs it.
    editButton.classList.toggle(
      'hidden',
      editing || !ready || !desktop.matches
    );
  }

  function buildEditButton() {
    // Without a tray there is nothing to open, so the grid stays view-only.
    if (!editbar) return;
    layoutBar = document.createElement('div');
    layoutBar.className = 'zr-row zr-layoutbar';
    editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'zr-btn zr-btn--ghost hidden';
    editButton.innerHTML =
      '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-grip"/></svg><span>Edit dashboard</span>';
    editButton.addEventListener('click', enterEdit, { signal });
    layoutBar.appendChild(editButton);
    // Above the tray, which sits directly above the grid: the two are never
    // shown at the same time, and the tab order reads top to bottom either way.
    editbar.parentNode.insertBefore(layoutBar, editbar);
  }

  /* --- resizing ---------------------------------------------------------- */

  /* One cell plus one gap: how far the pointer travels per grid step. Read off
     the live grid rather than hardcoded, so a token change moves the snapping
     with it. */
  function gridMetrics() {
    const styles = getComputedStyle(grid);
    const gap = Number.parseFloat(styles.columnGap) || 0;
    const rowGap = Number.parseFloat(styles.rowGap) || gap;
    const rowHeight =
      Number.parseFloat(styles.getPropertyValue('--zr-tile-row')) || 40;
    return {
      column: (grid.getBoundingClientRect().width + gap) / GRID_COLUMNS,
      gap,
      row: rowHeight + rowGap,
      rowGap,
    };
  }

  /* Only the widths the current viewport can actually render. Wide viewports
     honour every span; narrower ones show half or full and nothing between, so
     that is what a resize there is allowed to produce. */
  function snapSpan(span) {
    const bounded = clamp(span, MIN_SPAN, GRID_COLUMNS);
    if (wide.matches) return bounded;
    // Nearest of the two, so the card follows the pointer to whichever width is
    // closer rather than flipping at the halfway point of the smaller one.
    return bounded < (HALF_SPAN + GRID_COLUMNS) / 2 ? HALF_SPAN : GRID_COLUMNS;
  }

  function spanForWidth(width) {
    const { column, gap } = gridMetrics();
    return snapSpan(Math.round((width + gap) / column));
  }

  /* One step in the direction asked for. Between 861 and 1180px there are only
     two widths, so a step is the jump between them rather than a column that
     would not change anything on screen. */
  function stepSpan(card, direction) {
    const current = Number(card.dataset.span) || GRID_COLUMNS;
    if (!wide.matches) {
      return direction > 0 ? GRID_COLUMNS : HALF_SPAN;
    }
    return snapSpan(current + direction);
  }

  function rowsForHeight(height) {
    const { row, rowGap } = gridMetrics();
    return clamp(Math.round((height + rowGap) / row), MIN_ROWS, MAX_ROWS);
  }

  function currentRows(card) {
    return Number(card.dataset.rows) || rowsForHeight(card.offsetHeight);
  }

  function startResize(card, event) {
    // The grip is only on screen inside a session; this is the belt to that
    // stylesheet brace.
    if (!editing) return;
    event.preventDefault();

    const grip = event.currentTarget;
    const rect = card.getBoundingClientRect();
    grip.setPointerCapture(event.pointerId);
    card.classList.add('is-resizing');

    const onMove = (moveEvent) => {
      setSpan(card, spanForWidth(moveEvent.clientX - rect.left));
      setRows(card, rowsForHeight(moveEvent.clientY - rect.top));
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      card.classList.remove('is-resizing');
      markEdited();
    };

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  }

  /* The grip is the keyboard path into everything the mouse can do: arrows
     resize, shift and arrows move the card, delete gives the height back. Like
     the mouse it only changes the grid — the session is what gets saved. */
  function onGripKey(card, event) {
    if (!editing) return;
    const moving = event.shiftKey;
    const ordered = [...grid.querySelectorAll('[data-widget]')];
    const index = ordered.indexOf(card);
    let handled = true;

    switch (event.key) {
      case 'ArrowRight': {
        const after = ordered[index + 1];
        if (moving) {
          if (after) grid.insertBefore(after, card);
        } else {
          setSpan(card, stepSpan(card, 1));
        }
        break;
      }
      case 'ArrowLeft': {
        const before = ordered[index - 1];
        if (moving) {
          if (before) grid.insertBefore(card, before);
        } else {
          setSpan(card, stepSpan(card, -1));
        }
        break;
      }
      case 'ArrowDown':
        setRows(card, currentRows(card) + 1);
        break;
      case 'ArrowUp':
        setRows(card, currentRows(card) - 1);
        break;
      case 'Backspace':
      case 'Delete':
        setRows(card, 0);
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    // Moving the card re-inserts it, which drops the focus — without this the
    // second arrow press would go nowhere.
    event.currentTarget.focus();
    markEdited();
  }

  function addGrip(card) {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'zr-module__grip';
    grip.setAttribute(
      'aria-label',
      `Resize ${card.querySelector('.zr-module__title')?.textContent?.trim() || 'widget'}: arrow keys resize, shift and arrow keys move, delete fits the card to its content`
    );
    grip.addEventListener('pointerdown', (event) => startResize(card, event), {
      signal,
    });
    // Double-click hands the card back to its content — the way out of a tile
    // size without hunting for the exact row count.
    grip.addEventListener(
      'dblclick',
      () => {
        if (!editing) return;
        setRows(card, 0);
        markEdited();
      },
      { signal }
    );
    grip.addEventListener('keydown', (event) => onGripKey(card, event), {
      signal,
    });
    card.appendChild(grip);
  }

  /* --- drag ordering ----------------------------------------------------- */

  function enableSorting() {
    if (sortable || !window.Sortable || !editing) return;
    sortable = window.Sortable.create(grid, {
      handle: '.zr-module__head',
      draggable: '[data-widget]',
      animation: 150,
      ghostClass: 'is-dragghost',
      chosenClass: 'is-dragging',
      // Buttons live in the head as well, so a click must not start a drag.
      filter: 'button, a, input, select',
      preventOnFilter: false,
      onEnd: markEdited,
    });
    // The narrower flag: the grab cursor only promises a drag once the vendor
    // script is really attached.
    grid.classList.add('is-sortable');
  }

  function disableSorting() {
    if (!sortable) return;
    sortable.destroy();
    sortable = null;
    grid.classList.remove('is-sortable');
  }

  function syncMode() {
    // Shrinking into the phone layout ends the session the way Cancel does: a
    // single column cannot show what was being arranged, and storing a layout
    // the user can no longer check is worse than dropping the edit.
    if (!desktop.matches && editing) {
      cancelEdit();
    }
    syncEditButton();
    markClipping();
  }

  /* --- start ------------------------------------------------------------- */

  setupChips();
  wireEditbar();
  buildEditButton();
  cards.forEach(addGrip);
  syncMode();
  desktop.addEventListener('change', syncMode, { signal });

  fetchJson(LAYOUT_URL)
    .then((result) => applyLayout(result?.data))
    .catch((error) => {
      // A dashboard that cannot read its layout still works — it just shows the
      // default arrangement. Editing stays open: the user can still arrange the
      // cards, and Done will say whether the write got through either.
      console.error('[dashboard-layout] loading failed', error);
    })
    .finally(() => {
      ready = true;
      syncEditButton();
    });

  return {
    destroy() {
      cancelAnimationFrame(clipFrame);
      contentObserver.disconnect();
      disableSorting();
      listeners.abort();
      editing = false;
      grid.classList.remove('is-editing');
      editbar?.classList.add('hidden');
      layoutBar?.remove();
      grid
        .querySelectorAll('.zr-module__grip')
        .forEach((grip) => grip.remove());
    },
  };
}
