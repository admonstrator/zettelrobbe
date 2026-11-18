// public/js/changelog-modal.js
//
// The welcome & "What's new" dialog: fetches the release status from the DB,
// fills the dialog that views/partials/changelog-modal.ejs renders, and marks
// the release as seen in the database when the user clicks "Let's go".
// "Remind me later", Escape and clicking the backdrop close it for the current
// tab session without writing to the database, so it returns on the next start.
// Following a link in the entries counts as "Remind me later" as well.
// After an update the dialog opens with a notice that names the new version.
// Any element with data-open-welcome (the version badge on the About page)
// opens it again on request: the same dialog, without "Remind me later".

(function () {
  'use strict';

  const DEFERRED_KEY = 'zr.welcomeDeferredVersion';
  const modal = document.getElementById('changelogModal');
  if (!modal) {
    return;
  }

  let currentVersion = '';
  let confirmed = false;
  // True while the dialog is open because the user asked for it. Closing it
  // then is not "Remind me later": nothing is deferred for the tab session.
  let onRequest = false;

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
    if (!confirmed && !onRequest) {
      deferInSession(currentVersion);
    }
    onRequest = false;
  });

  // A link in the entries (e.g. to Settings -> Changelog) leaves the page
  // without closing the dialog; count it as "Remind me later" so the dialog
  // does not open again on the page the link leads to.
  modal.addEventListener('click', function (event) {
    if (
      !onRequest &&
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
    if (data.updated !== true || !data.version) {
      // The dialog can open more than once per page (on request), so a notice
      // from an earlier opening must not outlive the update it announced.
      notice.classList.add('hidden');
      notice.removeAttribute('autofocus');
      title.setAttribute('autofocus', '');
      modal.setAttribute('aria-labelledby', 'changelogModalTitle');
      return;
    }

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

  // Fills the dialog from a status answer and opens it. Returns false when the
  // page has no entries list to fill.
  function fillAndOpen(data, requested) {
    const versionEl = document.getElementById('changelogModalVersion');
    const listEl = document.getElementById('changelogModalEntries');
    if (!listEl) return false;

    currentVersion = data.version || '';
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

    // Asked for, there is nothing to be reminded of later: one button closes.
    const laterBtn = document.getElementById('changelogModalClose');
    if (laterBtn && laterBtn.classList) {
      laterBtn.classList[requested ? 'add' : 'remove']('hidden');
    }

    onRequest = requested;
    confirmed = false;
    showUpdateNotice(data);
    modal.showModal();
    return true;
  }

  function fetchStatus() {
    return fetch('/api/changelog/status', { credentials: 'same-origin' }).then(
      function (res) {
        return res.ok ? res.json() : null;
      }
    );
  }

  function openOnRequest() {
    if (modal.open) return;
    fetchStatus()
      .then(function (data) {
        if (!data || !data.version) return;
        fillAndOpen(data, true);
      })
      .catch(function () {});
  }

  document.addEventListener('click', function (event) {
    if (
      event.target &&
      event.target.closest &&
      event.target.closest('[data-open-welcome]')
    ) {
      openOnRequest();
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    fetchStatus()
      .then(function (data) {
        if (!data || !data.show) return;
        if (isDeferredInSession(data.version || '')) return;
        fillAndOpen(data, false);
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
