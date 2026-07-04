// public/js/sidebar-badges.js

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
            ocrBadge.style.cursor = 'pointer';
            ocrBadge.title = 'Open OCR queue (pending only)';
            ocrBadge.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                window.location.href = '/ocr?status=pending';
            });
        }

        if (failedBadge) {
            failedBadge.style.cursor = 'pointer';
            failedBadge.title = 'Open permanently failed documents';
            failedBadge.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                window.location.href = '/failed';
            });
        }

        if (ignoredBadge) {
            ignoredBadge.style.cursor = 'pointer';
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
        } catch (_) {
            // Silently ignore badge fetch errors to avoid impacting page UX
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        wireBadgeNavigation();
        loadSidebarBadges();
    });
})();
