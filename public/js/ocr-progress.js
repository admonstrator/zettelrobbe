/**
 * The OCR run overlay: a progress bar and a live log fed by an SSE endpoint.
 *
 * A classic script publishing a global, because both of its callers cannot
 * share anything else — ocr.js is a classic script and history.js is an ES
 * module. The markup it drives is views/partials/ocr-progress-overlay.ejs, and
 * its styling lives in css/pages/queues.css; a page that wants this needs both.
 *
 *   window.zrOcrProgress.run({
 *     url: '/api/ocr/process/42',
 *     body: { autoAnalyze: true },
 *     title: 'OCR for document #42',
 *     onDone: (ok) => { ... },
 *   });
 */
(function () {
  'use strict';

  // download, ocr, writeback, ai — the four the endpoints report.
  const TOTAL_STEPS = 4;

  // Sprite symbols, not emoji: the rest of the app draws its icons from
  // /icons.svg, and emoji render in whatever the operating system ships,
  // which followed neither the type nor the theme of the dialog around them.
  // A step prefixed with item_ belongs to one document inside a bulk run and
  // is drawn indented; both spellings share an icon.
  const STEP_ICONS = {
    download: 'i-download',
    ocr: 'i-scan',
    writeback: 'i-save',
    unlock: 'i-key',
    ai: 'i-cpu',
    done: 'i-check-circle',
    error: 'i-alert-circle',
    start: 'i-play',
  };
  // No entry for 'progress': that step carries separators and the raw OCR text
  // dump behind "Show OCR output", where an icon per line would be noise.

  // Looked up per call rather than at load: the overlay markup sits at the end
  // of the page, and this script is free to be loaded before it.
  const el = (id) => document.getElementById(id);

  // .hidden is the framework's !important toggle; the dismiss controls used
  // style.display, which fought the class the moment anything else set one.
  const reveal = (id, shown) => {
    const node = el(id);
    if (node) node.classList.toggle('hidden', !shown);
  };

  function open(title) {
    const overlay = el('progressOverlay');
    const log = el('progressLog');
    const bar = el('progressBar');

    if (el('progressTitle')) el('progressTitle').textContent = title;
    if (log) log.innerHTML = '';
    if (bar) {
      bar.style.width = '5%';
      bar.classList.remove('zr-meter__fill--ok', 'zr-meter__fill--danger');
    }
    reveal('progressCloseBtn', false);
    reveal('progressFoot', false);
    // showModal() throws on an already-open dialog, and runAll() reopens the
    // same one between batches.
    if (overlay && !overlay.open) overlay.showModal();
  }

  function close() {
    const overlay = el('progressOverlay');
    if (overlay && overlay.open) overlay.close();
  }

  function finalize(isError) {
    const bar = el('progressBar');
    if (bar) {
      bar.style.width = '100%';
      // Assigning the whole className used to drop zr-meter__fill along with
      // the Tailwind classes it replaced, so the bar vanished at 100%.
      bar.classList.toggle('zr-meter__fill--danger', Boolean(isError));
      bar.classList.toggle('zr-meter__fill--ok', !isError);
    }
    reveal('progressCloseBtn', true);
    reveal('progressFoot', true);
  }

  function setProgress(pct) {
    const bar = el('progressBar');
    if (bar) bar.style.width = `${pct}%`;
  }

  function appendLog(step, message) {
    const log = el('progressLog');
    if (!log) return;

    // A per-document step inside a bulk run reduces to its plain name plus the
    // nesting modifier, so 'ai' and 'item_ai' share one rule. The slug guard
    // keeps a step name the server invents out of the class list.
    const nested = step.startsWith('item_');
    const base = (nested ? step.slice(5) : step).replace(/[^a-z0-9-]/gi, '-');
    const icon = STEP_ICONS[base];

    const line = document.createElement('div');
    line.className = `log-line log-${base}${nested ? ' log-line--nested' : ''}`;

    if (icon) {
      // innerHTML only ever receives a symbol id from the map above. The
      // message is appended as a text node, so an error string coming back
      // from a provider cannot bring markup into the dialog with it.
      const holder = document.createElement('span');
      holder.innerHTML = `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>`;
      line.appendChild(holder.firstChild);
    }

    // The message gets its own element so it can wrap and keep the newlines of
    // an OCR dump while the icon stays put at the start of the line.
    const text = document.createElement('span');
    text.className = 'log-line__text';
    text.textContent = message;
    line.appendChild(text);

    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Streams one SSE job into the overlay without opening or closing it.
   *
   * Split out of run() so several jobs can share one overlay: a per-job
   * finalize would paint the bar green after the first document of forty.
   *
   * The stream is read with fetch rather than EventSource because the endpoints
   * take a POST body (autoAnalyze), which EventSource cannot send.
   *
   * @param {string} url
   * @param {object} body
   * @param {function(boolean): void} onSettle
   */
  function runInto(url, body, onSettle) {
    let stepsDone = 0;
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      onSettle(ok);
    };

    const handleEvent = (event) => {
      const step = event.step || 'info';
      const message = event.message || '';

      appendLog(step, message);

      if (
        ['download', 'ocr', 'writeback', 'ai'].includes(step) &&
        message &&
        !message.startsWith('[OCR]')
      ) {
        // Count completions roughly: the "…" lines announce a step, the plain
        // ones report it finished.
        if (
          !message.includes('…') &&
          !message.includes('Sending') &&
          !message.includes('Writing') &&
          !message.includes('Starting')
        ) {
          stepsDone = Math.min(stepsDone + 1, TOTAL_STEPS);
          setProgress(Math.round((stepsDone / TOTAL_STEPS) * 90));
        }
      }

      if (step === 'done') {
        setProgress(100);
        settle(true);
      }
      if (step === 'error') {
        settle(false);
      }
    };

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = () => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                settle(true);
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop(); // keep the incomplete line

              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                try {
                  handleEvent(JSON.parse(line.slice(5).trim()));
                } catch {
                  // Ignore partial or malformed SSE frames.
                }
              }

              read();
            })
            .catch((error) => {
              appendLog('error', `Connection error: ${error.message}`);
              settle(false);
            });
        };

        read();
      })
      .catch((error) => {
        appendLog('error', error.message);
        settle(false);
      });
  }

  /** One job with its own overlay, from opening to the Close button. */
  function run({ url, body = {}, title = 'Processing…', onDone = null }) {
    open(title);
    runInto(url, body, (ok) => {
      finalize(!ok);
      if (onDone) onDone(ok);
    });
  }

  /**
   * Runs several jobs one after another into the same overlay.
   *
   * Sequential on purpose: each run is an OCR call and an AI call, and firing a
   * selection of forty at once would bury a local model and interleave the log
   * into something nobody can read. The overall bar tracks documents rather
   * than steps, so it still moves while an individual run reports its own.
   *
   * @param {Array<{url: string, body?: object, label: string}>} jobs
   * @param {{title?: string, onDone?: function}} [options]
   */
  async function runAll(jobs, { title = 'Processing…', onDone = null } = {}) {
    open(title);

    let failures = 0;

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      appendLog('start', `${job.label} (${index + 1}/${jobs.length})`);

      const ok = await new Promise((resolve) => {
        runInto(job.url, job.body || {}, resolve);
      });

      if (!ok) failures += 1;
      setProgress(Math.round(((index + 1) / jobs.length) * 100));
    }

    appendLog(
      failures ? 'error' : 'done',
      failures
        ? `Finished with ${failures} of ${jobs.length} failing.`
        : `Finished all ${jobs.length} document(s).`
    );
    finalize(failures > 0);
    if (onDone) onDone(failures === 0);
  }

  // The two dismiss buttons belong to the overlay, so they are wired here
  // rather than by every page that includes it.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('#progressCloseBtn, #progressDoneBtn');
    if (target) close();
  });

  window.zrOcrProgress = {
    run,
    runAll,
    open,
    close,
    appendLog,
    setProgress,
    finalize,
  };
})();
