function resolveDashboardData() {
    if (window.dashboardData && typeof window.dashboardData === 'object') {
        return window.dashboardData;
    }

    const payloadElement = document.getElementById('dashboardDataPayload');
    if (!payloadElement) {
        return {
            documentCount: 0,
            processedCount: 0,
            ocrNeededCount: 0,
            failedCount: 0,
            queueBacklog: 0,
            processingEfficiencyRate: 0,
            failedRate: 0,
            processedToday: 0,
            tokenDistribution: [],
            documentTypes: [],
            tokenTrend: [],
            recentActivity: [],
            languageDistribution: []
        };
    }

    let parsedData = {};
    try {
        parsedData = JSON.parse(payloadElement.textContent || '{}');
    } catch (error) {
        console.error('Failed to parse dashboardDataPayload:', error);
    }

    const resolved = {
        documentCount: Number(parsedData.documentCount || 0),
        processedCount: Number(parsedData.processedDocumentCount || 0),
        ocrNeededCount: Number(parsedData.ocrNeededCount || 0),
        failedCount: Number(parsedData.failedCount || 0),
        queueBacklog: Number(parsedData.queueBacklog || 0),
        processingEfficiencyRate: Number(parsedData.processingEfficiencyRate || 0),
        failedRate: Number(parsedData.failedRate || 0),
        processedToday: Number(parsedData.processedToday || 0),
        tokenDistribution: Array.isArray(parsedData.tokenDistribution) ? parsedData.tokenDistribution : [],
        documentTypes: Array.isArray(parsedData.documentTypes) ? parsedData.documentTypes : [],
        tokenTrend: Array.isArray(parsedData.tokenTrend) ? parsedData.tokenTrend : [],
        recentActivity: Array.isArray(parsedData.recentActivity) ? parsedData.recentActivity : [],
        languageDistribution: Array.isArray(parsedData.languageDistribution) ? parsedData.languageDistribution : []
    };

    window.dashboardData = resolved;
    return resolved;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const dashboardPaperlessPublicUrl = (typeof window.paperlessPublicUrl === 'string' ? window.paperlessPublicUrl : '').replace(/\/$/, '');

// Chart Initialization
class ChartManager {
    constructor() {
        this.documentChart = null;
        this.initializeDocumentChart();
    }

    initializeDocumentChart() {
        const dashboardData = resolveDashboardData();
        const {
            documentCount,
            processedCount,
            ocrNeededCount = 0,
            failedCount = 0
        } = dashboardData;
        const remainingCount = Math.max(0, documentCount - processedCount - ocrNeededCount - failedCount);

        const chartElement = document.getElementById('documentChart');
        if (!chartElement || typeof Chart === 'undefined') {
            return;
        }

        const ctx = chartElement.getContext('2d');
        if (!ctx) {
            return;
        }

        this.documentChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['AI Processed', 'OCR Needed', 'Failed', 'Unprocessed'],
                datasets: [{
                    data: [processedCount, ocrNeededCount, failedCount, remainingCount],
                    backgroundColor: [
                        '#3b82f6',  // blue-500
                        '#f59e0b',  // amber-500
                        '#ef4444',  // red-500
                        '#e2e8f0'   // gray-200
                    ],
                    borderWidth: 0,
                    spacing: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const value = context.raw;
                                const total = context.dataset.data.reduce((sum, current) => sum + Number(current || 0), 0);
                                const percentage = ((value / total) * 100).toFixed(1);
                                return `${value} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    updateDocumentChart(documentCount, processedCount, ocrNeededCount = 0, failedCount = 0) {
        if (!this.documentChart) return;

        const safeProcessed = Math.min(processedCount, documentCount);
        const safeOcrNeeded = Math.max(0, ocrNeededCount);
        const safeFailed = Math.max(0, failedCount);
        const unprocessedCount = Math.max(0, documentCount - safeProcessed - safeOcrNeeded - safeFailed);

        this.documentChart.data.datasets[0].data = [safeProcessed, safeOcrNeeded, safeFailed, unprocessedCount];
        this.documentChart.update();
    }
}

class DashboardStatsLoader {
    constructor() {
        this.minimumLoadingTimeMs = 400;
        this.requestTimeoutMs = 15000;
        this.loadingBannerDelayMs = 1000;
        this.loadingBlock = document.getElementById('dashboardLoadingBlock');
        this.loadingProgress = document.getElementById('dashboardLoadingProgress');
        this.loadingPercent = document.getElementById('dashboardLoadingPercent');
        this.loadingMessage = document.getElementById('dashboardLoadingMessage');
        this.loadingSubtext = document.getElementById('dashboardLoadingSubtext');
        this.loadingBannerTimer = null;
        this.loadingBannerVisible = false;
    }

    setLoadingProgress(percent, message = '', subtext = '', options = {}) {
        const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
        const keepIndeterminate = Boolean(options.keepIndeterminate);

        if (this.loadingProgress) {
            if (keepIndeterminate) {
                this.loadingProgress.classList.add('is-indeterminate');
                this.loadingProgress.style.width = '38%';
            } else {
                this.loadingProgress.classList.remove('is-indeterminate');
                this.loadingProgress.style.width = `${safePercent}%`;
            }
        }

        if (this.loadingPercent) {
            this.loadingPercent.textContent = keepIndeterminate ? '...' : `${Math.round(safePercent)}%`;
        }

        if (this.loadingMessage && message) {
            this.loadingMessage.textContent = message;
        }

        if (this.loadingSubtext && subtext) {
            this.loadingSubtext.textContent = subtext;
        }
    }

    getFallbackStats() {
        const dashboardData = resolveDashboardData() || {};
        return {
            paperless_data: {
                documentCount: Number(dashboardData.documentCount || 0),
                processedDocumentCount: Number(dashboardData.processedCount || 0),
                ocrNeededCount: Number(dashboardData.ocrNeededCount || 0),
                failedCount: Number(dashboardData.failedCount || 0),
                queueBacklog: Number(dashboardData.queueBacklog || 0),
                processingEfficiencyRate: Number(dashboardData.processingEfficiencyRate || 0),
                failedRate: Number(dashboardData.failedRate || 0),
                processedToday: Number(dashboardData.processedToday || 0),
                tagCount: Number(dashboardData.tagCount || 0),
                correspondentCount: Number(dashboardData.correspondentCount || 0),
                tokenDistribution: Array.isArray(dashboardData.tokenDistribution) ? dashboardData.tokenDistribution : [],
                documentTypes: Array.isArray(dashboardData.documentTypes) ? dashboardData.documentTypes : [],
                tokenTrend: Array.isArray(dashboardData.tokenTrend) ? dashboardData.tokenTrend : [],
                recentActivity: Array.isArray(dashboardData.recentActivity) ? dashboardData.recentActivity : [],
                languageDistribution: Array.isArray(dashboardData.languageDistribution) ? dashboardData.languageDistribution : []
            },
            openai_data: {
                averagePromptTokens: Number(dashboardData.averagePromptTokens || 0),
                averageCompletionTokens: Number(dashboardData.averageCompletionTokens || 0),
                averageTotalTokens: Number(dashboardData.averageTotalTokens || 0),
                tokensOverall: Number(dashboardData.tokensOverall || 0)
            }
        };
    }

    setLoadingState(isLoading) {
        if (this.loadingBlock) {
            if (isLoading) {
                if (this.loadingBannerTimer) {
                    clearTimeout(this.loadingBannerTimer);
                    this.loadingBannerTimer = null;
                }

                if (!this.loadingBannerVisible) {
                    this.loadingBannerTimer = setTimeout(() => {
                        this.loadingBlock.classList.remove('hidden');
                        requestAnimationFrame(() => {
                            this.loadingBlock.classList.remove('opacity-0');
                            this.loadingBlock.classList.add('opacity-100');
                        });
                        this.loadingBannerVisible = true;
                        this.loadingBannerTimer = null;
                    }, this.loadingBannerDelayMs);
                }
            } else {
                if (this.loadingBannerTimer) {
                    clearTimeout(this.loadingBannerTimer);
                    this.loadingBannerTimer = null;
                }

                if (this.loadingBannerVisible) {
                    this.loadingBlock.classList.remove('opacity-100');
                    this.loadingBlock.classList.add('opacity-0');
                    setTimeout(() => {
                        this.loadingBlock.classList.add('hidden');
                        this.loadingBannerVisible = false;
                    }, 300);
                } else {
                    this.loadingBlock.classList.add('hidden');
                    this.loadingBlock.classList.remove('opacity-100');
                    this.loadingBlock.classList.add('opacity-0');
                }
            }
            this.loadingBlock.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        }

        const chartSkeletonElements = document.querySelectorAll('[data-dashboard-chart-skeleton]');
        chartSkeletonElements.forEach((skeletonElement) => {
            skeletonElement.classList.toggle('hidden', !isLoading);
            skeletonElement.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
            skeletonElement.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        });

        const valueElements = document.querySelectorAll('[data-dashboard-value]');
        valueElements.forEach((valueElement) => {
            valueElement.classList.toggle('hidden', isLoading);
            valueElement.setAttribute('aria-hidden', isLoading ? 'true' : 'false');

            const skeleton = document.getElementById(`${valueElement.id}Skeleton`);
            if (!skeleton) return;
            skeleton.classList.toggle('hidden', !isLoading);
            skeleton.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
            skeleton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        });

        const listSkeletonElements = document.querySelectorAll('[data-dashboard-list-skeleton]');
        listSkeletonElements.forEach((skeletonElement) => {
            skeletonElement.classList.toggle('hidden', !isLoading);
            skeletonElement.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
            skeletonElement.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        });

        const listContentElements = document.querySelectorAll('[data-dashboard-list-content]');
        listContentElements.forEach((contentElement) => {
            contentElement.classList.toggle('hidden', isLoading);
            contentElement.setAttribute('aria-hidden', isLoading ? 'true' : 'false');
        });
    }

    formatNumber(value, options = {}) {
        const numericValue = Number(value || 0);
        if (!Number.isFinite(numericValue)) {
            return '0';
        }

        if (!options.compact || Math.abs(numericValue) < 1000) {
            return numericValue.toLocaleString();
        }

        const absoluteValue = Math.abs(numericValue);
        const units = [
            { threshold: 1000000000, suffix: 'b' },
            { threshold: 1000000, suffix: 'm' },
            { threshold: 1000, suffix: 'k' }
        ];

        const unit = units.find((entry) => absoluteValue >= entry.threshold) || units[units.length - 1];
        const scaledValue = numericValue / unit.threshold;
        const rounded = Math.round(scaledValue * 10) / 10;
        const compactValue = Number.isInteger(rounded)
            ? String(rounded)
            : rounded.toFixed(1).replace(/\.0$/, '');

        return `${compactValue}${unit.suffix}`;
    }

    setText(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        element.textContent = value;
    }

    updateCharts(stats) {
        if (window.chartManager) {
            window.chartManager.updateDocumentChart(
                stats.paperless_data.documentCount,
                stats.paperless_data.processedDocumentCount,
                stats.paperless_data.ocrNeededCount,
                stats.paperless_data.failedCount
            );
        }

        const tokenChart = window.dashboardCharts?.tokenDistribution;
        if (tokenChart) {
            const distribution = Array.isArray(stats.paperless_data.tokenDistribution)
                ? stats.paperless_data.tokenDistribution
                : [];
            tokenChart.data.labels = distribution.map(dist => dist.range);
            tokenChart.data.datasets[0].data = distribution.map(dist => dist.count);
            tokenChart.update();
        }

        const typesChart = window.dashboardCharts?.documentTypes;
        if (typesChart) {
            const documentTypes = Array.isArray(stats.paperless_data.documentTypes)
                ? stats.paperless_data.documentTypes
                : [];
            typesChart.data.labels = documentTypes.map(type => type.type);
            typesChart.data.datasets[0].data = documentTypes.map(type => type.count);
            typesChart.update();
        }

        const trendChart = window.dashboardCharts?.tokenTrend;
        if (trendChart) {
            const trend = Array.isArray(stats.paperless_data.tokenTrend)
                ? stats.paperless_data.tokenTrend
                : [];
            trendChart.data.labels = trend.map(point => point.day);
            trendChart.data.datasets[0].data = trend.map(point => point.totalTokens);
            trendChart.update();
        }
    }

    renderRecentActivity(items) {
        const container = document.getElementById('recentActivityList');
        if (!container) return;

        const safeItems = Array.isArray(items) ? items : [];
        if (safeItems.length === 0) {
            container.innerHTML = '<div class="activity-item"><span class="activity-item-title">No recent processing activity available.</span></div>';
            return;
        }

        container.innerHTML = safeItems.map((item) => {
            const title = this.escapeHtml(item.title || 'Untitled document');
            const docId = Number(item.documentId || 0);
            const correspondent = this.escapeHtml(item.correspondent || 'Unknown correspondent');
            const datePill = this.escapeHtml(this.formatDateForPill(item.createdAt));
            const docUrl = this.getPaperlessDocumentUrl(docId);
            const idPill = docId > 0 ? `#${docId}` : '#n/a';
            const idPillHtml = docUrl
                ? `<a href="${this.escapeHtml(docUrl)}" target="_blank" class="manual-search-pill id dashboard-doc-link" title="Open in Paperless">${idPill}</a>`
                : `<span class="manual-search-pill id">${idPill}</span>`;
            return `
                <div class="activity-item">
                    <div>
                        <div class="activity-item-title">${title}</div>
                        <div class="manual-search-meta mt-2">
                            <span class="manual-search-pill correspondent">${correspondent}</span>
                            <span class="manual-search-pill date">${datePill}</span>
                            ${idPillHtml}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    getPaperlessDocumentUrl(documentId) {
        const docId = Number(documentId || 0);
        if (!Number.isInteger(docId) || docId <= 0 || !dashboardPaperlessPublicUrl) {
            return '';
        }

        return `${dashboardPaperlessPublicUrl}/documents/${docId}/details`;
    }

    formatDateForPill(inputDate) {
        if (!inputDate) {
            return 'Unknown date';
        }

        const normalizedDate = String(inputDate).includes(' ')
            ? String(inputDate).replace(' ', 'T')
            : String(inputDate);
        const parsed = new Date(normalizedDate);
        if (Number.isNaN(parsed.getTime())) {
            return 'Unknown date';
        }

        return parsed.toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    renderLanguageDistribution(items) {
        const container = document.getElementById('languageDistributionList');
        if (!container) return;

        const safeItems = Array.isArray(items) ? items : [];
        if (safeItems.length === 0) {
            container.innerHTML = '<div class="language-row"><div class="language-name">No language data available.</div></div>';
            return;
        }

        const maxCount = Math.max(...safeItems.map((item) => Number(item.count || 0)), 1);
        container.innerHTML = safeItems.map((item) => {
            const name = String(item.language || 'Unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const count = Number(item.count || 0);
            const width = Math.max(8, Math.round((count / maxCount) * 100));
            return `
                <div class="language-row">
                    <div class="language-head">
                        <span class="language-name">${name}</span>
                        <span class="language-count">${this.formatNumber(count)} docs</span>
                    </div>
                    <div class="language-track">
                        <div class="language-fill" style="width: ${width}%;"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    formatRelativeDate(inputDate) {
        if (!inputDate) {
            return 'Unknown time';
        }

        const normalizedDate = String(inputDate).includes(' ')
            ? String(inputDate).replace(' ', 'T')
            : String(inputDate);
        const parsed = new Date(normalizedDate);
        if (Number.isNaN(parsed.getTime())) {
            return 'Unknown time';
        }

        const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
        if (diffSeconds < 60) return 'just now';
        if (diffSeconds < 3600) {
            const minutes = Math.floor(diffSeconds / 60);
            return `${minutes}m ago`;
        }
        if (diffSeconds < 86400) {
            const hours = Math.floor(diffSeconds / 3600);
            return `${hours}h ago`;
        }
        const days = Math.floor(diffSeconds / 86400);
        return `${days}d ago`;
    }

    updateCards(stats) {
        const documentCount = stats.paperless_data.documentCount;
        const processedCount = Math.min(stats.paperless_data.processedDocumentCount, documentCount);
        const ocrNeededCount = Math.max(0, stats.paperless_data.ocrNeededCount || 0);
        const failedCount = Math.max(0, stats.paperless_data.failedCount || 0);
        const queueBacklog = Math.max(0, stats.paperless_data.queueBacklog || 0);
        const efficiencyRate = Math.max(0, Number(stats.paperless_data.processingEfficiencyRate || 0));
        const failedRate = Math.max(0, Number(stats.paperless_data.failedRate || 0));
        const processedToday = Math.max(0, Number(stats.paperless_data.processedToday || 0));
        const unprocessedCount = Math.max(0, documentCount - processedCount - ocrNeededCount - failedCount);

        this.setText('processedCountValue', this.formatNumber(processedCount));
        this.setText('ocrNeededCountValue', this.formatNumber(ocrNeededCount));
        this.setText('failedCountValue', this.formatNumber(failedCount));
        this.setText('unprocessedCountValue', this.formatNumber(unprocessedCount));
        this.setText('totalDocumentsValue', this.formatNumber(documentCount));

        this.setText('totalTagsValue', this.formatNumber(stats.paperless_data.tagCount));
        this.setText('totalCorrespondentsValue', this.formatNumber(stats.paperless_data.correspondentCount));

        this.setText('avgPromptTokensValue', this.formatNumber(stats.openai_data.averagePromptTokens, { compact: true }));
        this.setText('avgCompletionTokensValue', this.formatNumber(stats.openai_data.averageCompletionTokens, { compact: true }));
        this.setText('avgTotalTokensValue', this.formatNumber(stats.openai_data.averageTotalTokens, { compact: true }));
        this.setText('tokensOverallValue', this.formatNumber(stats.openai_data.tokensOverall, { compact: true }));
        this.setText('documentsProcessedValue', this.formatNumber(processedCount));

        this.setText('efficiencyRateValue', `${efficiencyRate}%`);
        this.setText('queueBacklogValue', this.formatNumber(queueBacklog));
        this.setText('failedRateValue', `${failedRate}%`);
        this.setText('processedTodayValue', this.formatNumber(processedToday));

        this.renderRecentActivity(stats.paperless_data.recentActivity);
        this.renderLanguageDistribution(stats.paperless_data.languageDistribution);
    }

    async load() {
        const loadingStartedAt = Date.now();
        this.setLoadingState(true);
        this.setLoadingProgress(15, 'Loading dashboard data...', 'Fetching latest statistics from API.', { keepIndeterminate: true });
        const fallbackStats = this.getFallbackStats();
        try {
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), this.requestTimeoutMs);

            const response = await fetch('/api/dashboard/stats', {
                signal: abortController.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('Failed to load dashboard stats');
            }

            const payload = await response.json();
            if (!payload?.success) {
                throw new Error(payload?.error || 'Invalid dashboard stats response');
            }

            this.setLoadingProgress(58, 'Applying statistics...', 'Updating cards and activity feeds.');

            window.dashboardData = {
                documentCount: payload.paperless_data.documentCount,
                processedCount: payload.paperless_data.processedDocumentCount,
                ocrNeededCount: payload.paperless_data.ocrNeededCount,
                failedCount: payload.paperless_data.failedCount,
                tokenDistribution: payload.paperless_data.tokenDistribution,
                documentTypes: payload.paperless_data.documentTypes,
                tokenTrend: payload.paperless_data.tokenTrend,
                recentActivity: payload.paperless_data.recentActivity,
                languageDistribution: payload.paperless_data.languageDistribution,
                queueBacklog: payload.paperless_data.queueBacklog,
                processingEfficiencyRate: payload.paperless_data.processingEfficiencyRate,
                failedRate: payload.paperless_data.failedRate,
                processedToday: payload.paperless_data.processedToday
            };

            this.updateCards(payload);
            this.setLoadingProgress(82, 'Rendering visualizations...', 'Drawing charts and trend graphs.');
            this.updateCharts(payload);
            this.setLoadingProgress(96, 'Finishing up...', 'Finalizing dashboard layout.');
        } catch (error) {
            console.error('Error loading dashboard stats:', error);

            this.setLoadingProgress(60, 'Using fallback data...', 'Dashboard remains usable while stats API is unavailable.');
            this.updateCards(fallbackStats);
            this.updateCharts(fallbackStats);
        } finally {
            const elapsedMs = Date.now() - loadingStartedAt;
            if (elapsedMs < this.minimumLoadingTimeMs) {
                await new Promise(resolve => setTimeout(resolve, this.minimumLoadingTimeMs - elapsedMs));
            }
            this.setLoadingProgress(100, 'Dashboard ready', 'Live updates will continue in the background.');
            this.setLoadingState(false);
        }
    }
}

// Modal Management
class ModalManager {
    constructor() {
        this.modal = document.getElementById('detailsModal');
        this.modalTitle = this.modal.querySelector('.modal-title');
        this.modalContent = this.modal.querySelector('.modal-data');
        this.modalLoader = this.modal.querySelector('.modal-loader');
        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // Close button click
        this.modal.querySelector('.modal-close').addEventListener('click', () => this.hideModal());
        
        // Overlay click
        this.modal.querySelector('.modal-overlay').addEventListener('click', () => this.hideModal());
        
        // Escape key press
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                this.hideModal();
            }
        });
    }

    showModal(title) {
        this.modalTitle.textContent = title;
        this.modalContent.innerHTML = '';
        this.modal.classList.remove('hidden'); // Fix: Remove 'hidden' class
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    hideModal() {
        this.modal.classList.remove('show');
        this.modal.classList.add('hidden'); // Fix: Add 'hidden' class back
        document.body.style.overflow = '';
    }

    showLoader() {
        this.modalLoader.classList.remove('hidden');
        this.modalContent.classList.add('hidden');
    }

    hideLoader() {
        this.modalLoader.classList.add('hidden');
        this.modalContent.classList.remove('hidden');
    }

    setContent(content) {
        this.modalContent.innerHTML = content;
    }
}

// Make showTagDetails and showCorrespondentDetails globally available
window.showTagDetails = async function() {
    window.modalManager.showModal('Tag Overview');
    window.modalManager.showLoader();

    try {
        const response = await fetch('/api/tagsCount');
        const tags = await response.json();

        let content = '<div class="detail-list">';
        tags.forEach(tag => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${escapeHtml(tag.name)}</span>
                    <span class="detail-item-info">${tag.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        window.modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading tags:', error);
        window.modalManager.setContent('<div class="text-red-500 p-4">Error loading tags. Please try again later.</div>');
    } finally {
        window.modalManager.hideLoader();
    }
}

window.showCorrespondentDetails = async function() {
    window.modalManager.showModal('Correspondent Overview');
    window.modalManager.showLoader();

    try {
        const response = await fetch('/api/correspondentsCount');
        const correspondents = await response.json();

        let content = '<div class="detail-list">';
        correspondents.forEach(correspondent => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${escapeHtml(correspondent.name)}</span>
                    <span class="detail-item-info">${correspondent.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        window.modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading correspondents:', error);
        window.modalManager.setContent('<div class="text-red-500 p-4">Error loading correspondents. Please try again later.</div>');
    } finally {
        window.modalManager.hideLoader();
    }
}

// Navigation Management
class NavigationManager {
    constructor() {
        this.sidebarLinks = document.querySelectorAll('.sidebar-link');
        this.initialize();
    }

    initialize() {
        this.sidebarLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                // Prevent default only for placeholder links.
                if (link.getAttribute('href') === '#') {
                    e.preventDefault();
                }
                this.setActiveLink(link);
            });
        });
    }

    setActiveLink(activeLink) {
        this.sidebarLinks.forEach(link => {
            link.classList.remove('active');
        });
        activeLink.classList.add('active');
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.navigationManager = new NavigationManager();

    if (document.getElementById('documentChart')) {
        window.chartManager = new ChartManager();
    }

    if (document.getElementById('detailsModal')) {
        window.modalManager = new ModalManager();
    }

    if (document.getElementById('dashboardDataPayload')) {
        window.dashboardStatsLoader = new DashboardStatsLoader();
        window.dashboardStatsLoader.load();
    }
});