/**
 * Zettelrobbe UI kernel.
 *
 * Everything page-specific is a module: an ES module under /js/modules/<name>.js
 * exporting `default (el, ctx) => void | { destroy() }`. The kernel scans the DOM
 * for [data-module] and imports only what the current page actually contains, so
 * a page costs its own modules and nothing else.
 *
 * The shell behaviour below (theme, drawer, rail, active nav) is the only code
 * that runs unconditionally.
 */

const registry = new Map();
const instances = new WeakMap();

/* --- theme ---------------------------------------------------------------
   The actual write happens in the inline head script (see theme-init-head.ejs)
   so that the cookie the server reads and the class the browser paints never
   drift apart. */
export const theme = {
  get() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light';
  },
  set(value) {
    const resolved = window.zrTheme
      ? window.zrTheme.apply(value)
      : applyThemeFallback(value);
    syncThemeIcon(resolved);
    document.dispatchEvent(
      new CustomEvent('zr:theme', { detail: { theme: resolved } })
    );
    return resolved;
  },
  toggle() {
    return this.set(this.get() === 'dark' ? 'light' : 'dark');
  },
};

/* Only reached when the head script is absent: it otherwise owns the attribute,
   localStorage and cookie writes. */
function applyThemeFallback(value) {
  const resolved = value === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

function syncThemeIcon(current) {
  document.querySelectorAll('[data-action="theme"] use').forEach((use) => {
    use.setAttribute(
      'href',
      current === 'dark' ? '/icons.svg#i-sun' : '/icons.svg#i-moon'
    );
  });
}

/* --- toast --------------------------------------------------------------- */
const TOAST_ICONS = {
  ok: 'i-check-circle',
  danger: 'i-alert-circle',
  warn: 'i-alert',
  info: 'i-info',
};

export function toast(message, { tone = 'info', timeout = 4200 } = {}) {
  let host = document.querySelector('.zr-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'zr-toasts';
    document.body.append(host);
  }

  const el = document.createElement('div');
  el.className = `zr-toast zr-toast--${tone}`;
  el.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  el.innerHTML =
    `<svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#${TOAST_ICONS[tone] || TOAST_ICONS.info}"/></svg>` +
    '<div class="zr-grow"></div>';
  el.lastElementChild.textContent = message;
  host.append(el);

  const remove = () => el.remove();
  el.addEventListener('click', remove);
  if (timeout) {
    setTimeout(remove, timeout);
  }
  return el;
}

// Classic scripts cannot import this module, so the one implementation is
// published for them; dialogs.js adapts its own tone vocabulary onto it.
window.__zrToast = toast;

/* --- dialogs (native <dialog>) ------------------------------------------- */

/**
 * Replacement for the SweetAlert2 confirm flow.
 * Resolves to true when the confirm button was used, false otherwise.
 */
export function confirmDialog({
  title,
  body = '',
  html = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  className = '',
} = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    // A variant class for a dialog whose shape is its own, like the sheet
    // before a run; the base class stays so every rule still applies.
    dlg.className = className ? `zr-dialog ${className}` : 'zr-dialog';
    dlg.innerHTML = `
      <form method="dialog">
        <div class="zr-dialog__head"></div>
        <div class="zr-dialog__body"></div>
        <div class="zr-dialog__foot">
          <button type="submit" class="zr-btn" value="cancel"></button>
          <button type="submit" class="zr-btn zr-btn--${tone === 'danger' ? 'danger' : 'primary'}" value="ok"></button>
        </div>
      </form>`;

    dlg.querySelector('.zr-dialog__head').textContent = title || '';
    const bodyEl = dlg.querySelector('.zr-dialog__body');
    if (html) {
      bodyEl.innerHTML = html;
    } else {
      bodyEl.textContent = body;
    }
    dlg.querySelector('[value="cancel"]').textContent = cancelLabel;
    dlg.querySelector('[value="ok"]').textContent = confirmLabel;

    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    dlg.showModal();
  });
}

/** Informational dialog with a single dismiss button. */
export function alertDialog({
  title,
  body = '',
  html = '',
  confirmLabel = 'OK',
  tone = 'primary',
} = {}) {
  return confirmDialog({
    title,
    body,
    html,
    confirmLabel,
    cancelLabel: '',
    tone,
  }).then(() => undefined);
}

/* --- module loader ------------------------------------------------------- */
export function define(name, factory) {
  registry.set(name, factory);
}

async function mount(el) {
  if (instances.has(el)) return;
  const name = el.dataset.module;
  if (!name) return;

  try {
    if (!registry.has(name)) {
      const mod = await import(`/js/modules/${name}.js`);
      registry.set(name, mod.default);
    }
    instances.set(
      el,
      registry.get(name)(el, { theme, toast, confirmDialog, alertDialog }) ||
        true
    );
  } catch (error) {
    el.dataset.state = 'error';
    console.error(`[zr] module "${name}" failed to mount`, error);
  }
}

/** Mounts every [data-module] below `root` that is not mounted yet. */
export function scan(root = document) {
  root.querySelectorAll('[data-module]').forEach(mount);
}

/* --- shell --------------------------------------------------------------- */
const RAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/* A collapsed rail hides the labels, and since the icon is aria-hidden that
   also leaves every nav link without an accessible name. The title restores
   both the name and a hover hint. Expanded it would only repeat what is already
   on screen, so it is removed again. */
function syncRailTooltips(root) {
  const collapsed = Boolean(root) && root.dataset.rail === 'collapsed';
  document.querySelectorAll('.zr-navitem').forEach((item) => {
    const label = item.querySelector('.zr-navitem__label');
    if (!label) return;
    if (collapsed) item.setAttribute('title', label.textContent.trim());
    else item.removeAttribute('title');
  });
}

function shell() {
  const root = document.querySelector('.zr-shell');
  syncThemeIcon(theme.get());
  syncRailTooltips(root);

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case 'theme':
        theme.toggle();
        break;
      case 'drawer-open':
        if (root) root.dataset.drawer = 'open';
        break;
      case 'drawer-close':
        if (root) delete root.dataset.drawer;
        break;
      case 'rail-toggle': {
        if (!root) break;
        const collapsed = root.dataset.rail === 'collapsed';
        root.dataset.rail = collapsed ? 'expanded' : 'collapsed';
        syncRailTooltips(root);
        try {
          let cookie = `railState=${root.dataset.rail}; Path=/; Max-Age=${RAIL_COOKIE_MAX_AGE}; SameSite=Lax`;
          if (window.location.protocol === 'https:') {
            cookie += '; Secure';
          }
          document.cookie = cookie;
        } catch {
          // Ignore cookie write failures; the state stays for this page view.
        }
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root) delete root.dataset.drawer;
  });

  // Mark the nav entry for the current page and close the drawer on navigation.
  const path = window.location.pathname;
  document
    .querySelectorAll('.zr-navitem[href], .zr-tab[href]')
    .forEach((link) => {
      if (link.getAttribute('href') === path) {
        link.setAttribute('aria-current', 'page');
      }
      link.addEventListener('click', () => {
        if (root) delete root.dataset.drawer;
      });
    });
}

shell();
scan();

// Pages that inject markup can ask the kernel to pick up new modules.
document.addEventListener('zr:refresh', (event) => {
  scan(event.target instanceof Element ? event.target : document);
});
