/**
 * Modal dialogs on top of the native <dialog> element.
 *
 * Replaces SweetAlert2 (78 KB) with roughly 3 KB and the framework's own look.
 * Exposed as window.zrDialog / window.zrToast because the page scripts that use
 * it are classic scripts, not modules. window.zrToast is a thin adapter over
 * the kernel's toast; only the dialogs are implemented here.
 *
 * zrDialog({ title, text, html, icon, showCancelButton, confirmButtonText,
 *            cancelButtonText, input, inputPlaceholder })
 *   -> Promise<{ isConfirmed: boolean, isDismissed: boolean, value?: string }>
 */
(function () {
  'use strict';

  const ICONS = {
    success: 'i-check-circle',
    error: 'i-alert-circle',
    warning: 'i-alert',
    info: 'i-info',
    question: 'i-help',
  };

  const TONES = {
    success: 'ok',
    error: 'danger',
    warning: 'warn',
    info: 'info',
    question: 'info',
  };

  function iconMarkup(icon) {
    const symbol = ICONS[icon];
    if (!symbol) return '';
    return (
      `<span class="zr-badge zr-badge--${TONES[icon] || 'info'}">` +
      `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${symbol}"/></svg></span>`
    );
  }

  window.zrDialog = function zrDialog(options) {
    const opts = options || {};

    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'zr-dialog';

      const destructive = opts.icon === 'error' || opts.icon === 'warning';
      const confirmTone = destructive ? 'danger' : 'primary';

      dlg.innerHTML = `
        <form method="dialog">
          <div class="zr-dialog__head"></div>
          <div class="zr-dialog__body"></div>
          <div class="zr-dialog__foot"></div>
        </form>`;

      const head = dlg.querySelector('.zr-dialog__head');
      head.innerHTML = iconMarkup(opts.icon);
      const titleEl = document.createElement('span');
      titleEl.className = 'zr-grow';
      titleEl.textContent = opts.title || '';
      head.append(titleEl);

      const body = dlg.querySelector('.zr-dialog__body');
      if (opts.html) {
        body.innerHTML = opts.html;
      } else if (opts.text) {
        body.textContent = opts.text;
      }

      let inputEl = null;
      if (opts.input) {
        inputEl = document.createElement('input');
        inputEl.className = 'zr-input';
        inputEl.type = opts.input === 'password' ? 'password' : 'text';
        if (opts.inputPlaceholder) inputEl.placeholder = opts.inputPlaceholder;
        if (opts.inputValue) inputEl.value = opts.inputValue;
        // Enter in the field confirms. Left to the form, it would press the
        // first submit button, which is Cancel whenever there is one.
        inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          dlg.close('ok');
        });
        const wrap = document.createElement('div');
        wrap.style.marginTop = 'var(--zr-2)';
        wrap.append(inputEl);
        body.append(wrap);
      }

      const foot = dlg.querySelector('.zr-dialog__foot');
      if (opts.showCancelButton) {
        const cancel = document.createElement('button');
        cancel.type = 'submit';
        cancel.className = 'zr-btn';
        cancel.value = 'cancel';
        cancel.textContent = opts.cancelButtonText || 'Cancel';
        foot.append(cancel);
      }

      if (opts.showConfirmButton !== false) {
        const confirm = document.createElement('button');
        confirm.type = 'submit';
        confirm.className = `zr-btn zr-btn--${confirmTone}`;
        confirm.value = 'ok';
        confirm.textContent = opts.confirmButtonText || 'OK';
        foot.append(confirm);
      } else {
        foot.remove();
      }

      document.body.append(dlg);

      let timer = null;
      dlg.addEventListener('close', () => {
        if (timer) clearTimeout(timer);
        const isConfirmed = dlg.returnValue === 'ok';
        const value = inputEl ? inputEl.value : undefined;
        dlg.remove();
        resolve({ isConfirmed, isDismissed: !isConfirmed, value });
      });

      dlg.showModal();
      if (inputEl) inputEl.focus();

      // Lets a caller keep a progress dialog up to date, e.g. a restart countdown.
      if (typeof opts.onOpen === 'function') {
        opts.onOpen({
          dialog: dlg,
          setText(text) {
            body.textContent = text;
          },
          close() {
            if (dlg.open) dlg.close();
          },
        });
      }

      if (Number(opts.timer) > 0) {
        timer = setTimeout(() => {
          if (dlg.open) dlg.close();
        }, Number(opts.timer));
      }
    });
  };

  // The dialog vocabulary plus the kernel's own tone names, which callers of
  // this API have always been allowed to pass.
  const TOAST_TONES = {
    ...TONES,
    ok: 'ok',
    danger: 'danger',
    warn: 'warn',
  };

  // Adapter only: the toast DOM lives in the module kernel (public/js/zr.js).
  // This classic script runs before that module, so the lookup is deferred to
  // call time — toasts only fire on user interaction, never during load.
  window.zrToast = function zrToast(message, tone) {
    if (typeof window.__zrToast !== 'function') return null;
    return window.__zrToast(message, { tone: TOAST_TONES[tone] || 'info' });
  };
})();
