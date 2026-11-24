/**
 * The "AI analysis after OCR" toggle on the OCR queue page forgot its state
 * (issue #300): switch it off, go to the dashboard, come back, and it was on
 * again.
 *
 * public/js/ocr.js had no change handler for it at all. The checkbox was
 * rendered from OCR_AUTO_ANALYZE on every request and only ever read when a run
 * was started, so flipping it changed nothing that outlived the page view.
 *
 * It is deliberately not written back to OCR_AUTO_ANALYZE. That setting is read
 * once at startup (config/config.js builds config.mistralOcr, and
 * ocrAutoProcessService.autoAnalyze reads it from there), which is why Settings
 * marks it "Restart required" — writing it from the queue page would leave the
 * scheduled drain on the old value while manual runs already followed the new
 * one. So the toggle governs the runs started on this page and is remembered
 * per browser, the same way the theme is.
 *
 * The handlers are read out of public/js/ocr.js rather than copied, so this
 * test cannot keep passing after the real ones change.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const OCR_JS = path.join(__dirname, '..', 'public', 'js', 'ocr.js');
const OCR_EJS = path.join(__dirname, '..', 'views', 'ocr.ejs');
const source = fs.readFileSync(OCR_JS, 'utf8');
const view = fs.readFileSync(OCR_EJS, 'utf8');

/* Loads the toggle's two helpers with a stubbed checkbox and localStorage.
   `storage: null` stands for a browser that throws on access — a private
   window, or site data blocked — which must not take the page down. */
function loadToggle({ checked, stored, storage = 'ok' }) {
  const start = source.indexOf('const AUTO_ANALYZE_STORAGE_KEY');
  assert.ok(
    start !== -1,
    'Could not find the auto-analyze toggle helpers in public/js/ocr.js — did they move or get renamed?'
  );
  const end = source.indexOf('\n  // ── Init', start);
  assert.ok(end > start, 'Could not delimit the toggle helpers');

  const listeners = {};
  const autoAnalyze = {
    checked,
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
  };

  const writes = [];
  const store = new Map();
  if (stored !== undefined) store.set('zr.ocr.autoAnalyze', stored);

  const windowStub = {
    localStorage: {
      getItem: (key) => {
        if (storage !== 'ok') throw new Error('storage unavailable');
        return store.has(key) ? store.get(key) : null;
      },
      setItem: (key, value) => {
        if (storage !== 'ok') throw new Error('storage unavailable');
        writes.push([key, value]);
        store.set(key, value);
      },
    },
  };

  const initialize = new Function(
    'autoAnalyze',
    'window',
    `${source.slice(start, end)}\nreturn initializeAutoAnalyzeToggle;`
  )(autoAnalyze, windowStub);

  initialize();
  return {
    autoAnalyze,
    writes,
    change: () => listeners.change?.call(autoAnalyze),
  };
}

// ── A stored choice wins over the server-rendered default ────────────────────

const off = loadToggle({ checked: true, stored: 'no' });
assert.strictEqual(
  off.autoAnalyze.checked,
  false,
  'a stored "off" must survive the page render — this is the reported bug'
);

const on = loadToggle({ checked: false, stored: 'yes' });
assert.strictEqual(
  on.autoAnalyze.checked,
  true,
  'a stored "on" must survive a server default of off'
);

// ── With nothing stored, the configured default stands ───────────────────────

const fresh = loadToggle({ checked: true });
assert.strictEqual(
  fresh.autoAnalyze.checked,
  true,
  'without a stored choice the OCR_AUTO_ANALYZE default must stand'
);

const freshOff = loadToggle({ checked: false });
assert.strictEqual(freshOff.autoAnalyze.checked, false);

// A value that is neither yes nor no is not a choice.
const garbage = loadToggle({ checked: true, stored: 'maybe' });
assert.strictEqual(
  garbage.autoAnalyze.checked,
  true,
  'an unrecognised stored value must fall back to the rendered default'
);

// ── Flipping it records the choice ───────────────────────────────────────────

const flip = loadToggle({ checked: true });
flip.autoAnalyze.checked = false;
flip.change();
assert.deepStrictEqual(
  flip.writes,
  [['zr.ocr.autoAnalyze', 'no']],
  'switching the toggle off must be remembered'
);

flip.autoAnalyze.checked = true;
flip.change();
assert.deepStrictEqual(flip.writes[1], ['zr.ocr.autoAnalyze', 'yes']);

// ── Unavailable storage must not break the page ──────────────────────────────

const blocked = loadToggle({ checked: true, stored: 'no', storage: 'blocked' });
assert.strictEqual(
  blocked.autoAnalyze.checked,
  true,
  'when storage cannot be read the rendered default must stand rather than throw'
);
assert.doesNotThrow(() => {
  blocked.autoAnalyze.checked = false;
  blocked.change();
}, 'a write to unavailable storage must not throw — the toggle still governs the run being started');

// ── The run still carries the current state ──────────────────────────────────

assert.ok(
  /body: \{ autoAnalyze: autoAnalyze \? autoAnalyze\.checked : false \}/.test(
    source
  ),
  'each run must keep sending the toggle it was started with — the stored value is a UI memory, not the request'
);

// ── The page says what the toggle governs ────────────────────────────────────

assert.ok(
  /Applies to the runs you start on this page/.test(view),
  'the toggle must say it applies to runs started here, not to the scheduled drain'
);
assert.ok(
  /Settings .* OCR .* Analyse right after OCR/.test(view),
  'the toggle must point at the setting that owns the default'
);

console.log('PASS test-ocr-auto-analyze-toggle');
