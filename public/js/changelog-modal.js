// public/js/changelog-modal.js
//
// The welcome & "What's new" dialog: fetches the release status from the DB,
// fills the dialog that views/partials/changelog-modal.ejs renders, and marks
// the release as seen in the database when the user clicks "Let's go".
// "Remind me later", Escape and clicking the backdrop close it for the current
// tab session without writing to the database, so it returns on the next start.
// Following a link in the entries counts as "Remind me later" as well.
// After an update the dialog opens with a notice that names the new version.

(function () {
  'use strict';

  const DEFERRED_KEY = 'zr.welcomeDeferredVersion';
  const modal = document.getElementById('changelogModal');
  if (!modal) {
    return;
  }

  let currentVersion = '';
  let confirmed = false;

  function isDeferredInSession(version) {
    if (!version) return false;
    try {
      return window.sessionStorage.getItem(DEFERRED_KEY) === version;
    } catch {
      return false;
    }
  }

  function deferInSession(version) {
    if (!version) return;
    try {
      window.sessionStorage.setItem(DEFERRED_KEY, version);
    } catch {
      // sessionStorage unavailable
    }
  }

  function clearDeferredInSession() {
    try {
      window.sessionStorage.removeItem(DEFERRED_KEY);
    } catch {
      // sessionStorage unavailable
    }
  }

  modal.addEventListener('close', function () {
    if (!confirmed) {
      deferInSession(currentVersion);
    }
  });

  // A link in the entries (e.g. to Settings -> Changelog) leaves the page
  // without closing the dialog; count it as "Remind me later" so the dialog
  // does not open again on the page the link leads to.
  modal.addEventListener('click', function (event) {
    if (
      event.target.closest &&
      event.target.closest('#changelogModalEntries a')
    ) {
      deferInSession(currentVersion);
    }
  });

  modal.addEventListener('click', function (event) {
    if (event.target === modal && modal.open) {
      modal.close();
    }
  });

  // After an update (the status answers updated: true) the notice at the top
  // of the main column says so: the new version, and quieter, the one the user
  // came from. It then takes over the title's two jobs, the initial focus
  // (one autofocus at a time) and the dialog's name, so a screen reader hears
  // it first. Otherwise it stays hidden and the dialog is unchanged.
  function showUpdateNotice(data) {
    const notice = document.getElementById('changelogModalUpdate');
    const title = document.getElementById('changelogModalTitle');
    const versionEl = document.getElementById('changelogModalUpdateVersion');
    if (!notice || !title || !versionEl) return;
    if (data.updated !== true || !data.version) return;

    versionEl.textContent = data.version;
    const fromLine = document.getElementById('changelogModalUpdateFromLine');
    const fromEl = document.getElementById('changelogModalUpdateFrom');
    if (fromLine && fromEl) {
      if (data.previousVersion) {
        fromEl.textContent = data.previousVersion;
        fromLine.classList.remove('hidden');
      } else {
        fromLine.classList.add('hidden');
      }
    }

    notice.classList.remove('hidden');
    title.removeAttribute('autofocus');
    notice.setAttribute('autofocus', '');
    modal.setAttribute('aria-labelledby', 'changelogModalUpdateTitle');
  }

  function remindLater() {
    if (modal.open) {
      modal.close();
    }
  }

  function markSeenAndClose() {
    confirmed = true;
    clearDeferredInSession();
    fetch('/api/changelog/mark-seen', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(function () {});
    if (modal.open) {
      modal.close();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch('/api/changelog/status', { credentials: 'same-origin' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data || !data.show) return;

        currentVersion = data.version || '';
        if (isDeferredInSession(currentVersion)) return;

        const versionEl = document.getElementById('changelogModalVersion');
        const listEl = document.getElementById('changelogModalEntries');
        if (!listEl) return;

        if (versionEl && data.version) {
          versionEl.textContent = data.version;
        }

        listEl.innerHTML = '';
        if (Array.isArray(data.entries)) {
          data.entries.forEach(function (entry) {
            const li = document.createElement('li');
            li.innerHTML =
              '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>' +
              '<span></span>';
            // Entries are release notes rendered server-side, never user input.
            li.lastElementChild.innerHTML = entry;
            listEl.appendChild(li);
          });
        }

        showUpdateNotice(data);
        modal.showModal();
      })
      .catch(function () {});

    document
      .getElementById('changelogModalClose')
      ?.addEventListener('click', remindLater);
    document
      .getElementById('changelogModalDismiss')
      ?.addEventListener('click', markSeenAndClose);
  });
})();
