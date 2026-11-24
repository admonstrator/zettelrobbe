// public/js/sidebar-badges.js
//
// Badges in the app shell: the queue counters in the sidebar and the update
// notification in the top bar. Both are shell chrome and live on every page,
// which is why they are here rather than in a page module.

(function () {
  'use strict';

  function updateBadge(el, value) {
    if (!el) return;

    const count = Number.isFinite(Number(value)) ? Number(value) : 0;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.remove('hidden');
    } else {
      el.textContent = '0';
      el.classList.add('hidden');
    }
  }

  function wireBadgeNavigation() {
    const ocrBadge = document.getElementById('sidebarOcrBadge');
    const failedBadge = document.getElementById('sidebarFailedBadge');
    const ignoredBadge = document.getElementById('sidebarIgnoredBadge');

    if (ocrBadge) {
      ocrBadge.title = 'Open OCR queue (pending only)';
      ocrBadge.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.location.href = '/ocr?status=pending';
      });
    }

    if (failedBadge) {
      failedBadge.title = 'Open failed documents';
      failedBadge.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.location.href = '/failed';
      });
    }

    if (ignoredBadge) {
      ignoredBadge.title = 'Open ignored documents';
      ignoredBadge.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.location.href = '/ignored';
      });
    }
  }

  async function loadSidebarBadges() {
    try {
      const response = await fetch('/api/ocr/stats');
      const data = await response.json();
      if (!data.success || !data.stats) return;

      const ocrBadge = document.getElementById('sidebarOcrBadge');
      const failedBadge = document.getElementById('sidebarFailedBadge');
      const ignoredBadge = document.getElementById('sidebarIgnoredBadge');

      updateBadge(ocrBadge, data.stats.pending);
      updateBadge(failedBadge, data.stats.permanentlyFailed);
      updateBadge(ignoredBadge, data.stats.ignored);

      // The mobile tab bar has no room for numbers, so it only shows a dot.
      const queueDot = document.getElementById('tabbarQueueDot');
      if (queueDot) {
        const pending = Number(data.stats.pending) || 0;
        const failed = Number(data.stats.permanentlyFailed) || 0;
        queueDot.classList.toggle('hidden', pending + failed === 0);
      }
    } catch {
      // Silently ignore badge fetch errors to avoid impacting page UX
    }
  }

  // The release lookup itself runs on the server and is cached there for a day,
  // so this only reads a local endpoint. The browser never talks to GitHub.
  async function loadUpdateNotification() {
    const badge = document.getElementById('updateNotification');
    const label = document.getElementById('latestVersion');
    if (!badge || !label) return;

    try {
      const response = await fetch('/api/update-check');
      if (!response.ok) return;

      const payload = await response.json();
      const data = payload && payload.data;
      if (!data || !data.updateAvailable || !data.latestVersion) return;

      label.textContent = data.latestVersion;
      badge.title = `Version ${data.latestVersion} is available — you are running ${data.currentVersion}`;
      badge.classList.remove('hidden');
    } catch {
      // Not knowing about an update is not worth bothering the user with.
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    wireBadgeNavigation();
    loadSidebarBadges();
    loadUpdateNotification();
  });
})();
