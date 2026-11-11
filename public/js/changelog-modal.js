// public/js/changelog-modal.js
//
// The welcome & "What's new" dialog: fetches the release status from the DB,
// fills the dialog that views/partials/changelog-modal.ejs renders, and marks
// the release as seen in the database when the user clicks "Let's go".
// "Remind me later", Escape and clicking the backdrop close it for the current
// tab session without writing to the database, so it returns on the next start.

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

  modal.addEventListener('click', function (event) {
    if (event.target === modal && modal.open) {
      modal.close();
    }
  });

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
