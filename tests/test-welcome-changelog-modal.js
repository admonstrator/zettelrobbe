// Tests for the Mailrobbe-style welcome/support & changelog modal:
// 1. Markup in views/partials/changelog-modal.ejs includes the two-column story,
//    energy drink tiers, payment links, contact block, and changelog list below.
// 2. public/js/changelog-modal.js opens the modal when /api/changelog/status
//    returns show=true, does NOT call /api/changelog/mark-seen when dismissed via
//    "Remind me later" / Escape / backdrop, and DOES call /api/changelog/mark-seen
//    when confirmed via "Let's go".
// 3. public/css/dialogs.css provides the .zr-welcome layout rules.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function testModalMarkup() {
  const ejs = fs.readFileSync(
    path.join(ROOT, 'views', 'partials', 'changelog-modal.ejs'),
    'utf8'
  );

  assert.match(
    ejs,
    /id="changelogModal"[^>]*class="[^"]*\bzr-welcome\b/,
    'changelogModal must carry the .zr-welcome class'
  );
  assert.match(
    ejs,
    /class="zr-welcome__story"/,
    'left story column must exist'
  );
  assert.match(ejs, /class="zr-welcome__main"/, 'right main column must exist');
  assert.match(
    ejs,
    /Free to use\. You name the price\./,
    'main title must state the name-your-own-price message'
  );

  for (const tier of ['3 cans', '33 cans', '200 cans']) {
    assert.ok(
      ejs.includes(tier),
      `welcome modal must include energy drink tier "${tier}"`
    );
  }

  for (const href of [
    'https://github.com/sponsors/admonstrator',
    'https://buymeacoffee.com/admon',
    'https://paypal.me/aaronviehl',
    'https://ko-fi.com/admon',
  ]) {
    assert.ok(
      ejs.includes(`href="${href}"`),
      `welcome modal must include support link ${href}`
    );
  }

  assert.ok(
    ejs.includes('href="mailto:hey@admon.me"'),
    'welcome modal must include contact email link'
  );
  assert.ok(
    ejs.includes(
      'href="https://github.com/admonstrator/Admonstrator/blob/main/pgp/hey@admon.me.asc"'
    ),
    'welcome modal must include PGP key link'
  );

  // Changelog section must sit inside the main column above the footer
  const contactIdx = ejs.indexOf('zr-welcome__contact');
  const changelogIdx = ejs.indexOf('id="changelogModalEntries"');
  const footIdx = ejs.indexOf('zr-welcome__foot');
  assert.ok(
    contactIdx !== -1 && changelogIdx > contactIdx && footIdx > changelogIdx,
    'changelog entries list must appear underneath the support/contact block and above the footer'
  );

  assert.match(
    ejs,
    /id="changelogModalClose"[\s\S]*?Remind me later/,
    'secondary button must allow deferring ("Remind me later")'
  );
  assert.match(
    ejs,
    /id="changelogModalDismiss"[\s\S]*?Let's go/,
    'primary button must confirm ("Let\'s go")'
  );
}

function testDialogStyles() {
  const css = fs.readFileSync(
    path.join(ROOT, 'public', 'css', 'dialogs.css'),
    'utf8'
  );

  for (const selector of [
    '.zr-welcome',
    '.zr-welcome[open]',
    '.zr-welcome__story',
    '.zr-welcome__main',
    '.zr-welcome__tiles',
    '.zr-welcome__pay',
    '.zr-welcome__contact',
    '.zr-welcome__changelog',
    '.zr-welcome__foot',
  ]) {
    assert.ok(css.includes(selector), `dialogs.css must define ${selector}`);
  }
}

function createHarness(statusResponse, initialDeferredVersion = null) {
  const scriptSource = fs.readFileSync(
    path.join(ROOT, 'public', 'js', 'changelog-modal.js'),
    'utf8'
  );

  const storage = new Map();
  if (initialDeferredVersion) {
    storage.set('zr.welcomeDeferredVersion', initialDeferredVersion);
  }

  const fetchCalls = [];
  const docListeners = {};
  const modalListeners = {};
  const closeBtnListeners = {};
  const dismissBtnListeners = {};

  const versionEl = { textContent: '' };
  const listEl = {
    innerHTML: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
  };

  const modal = {
    open: false,
    showModalCalls: 0,
    addEventListener(type, fn) {
      modalListeners[type] = modalListeners[type] || [];
      modalListeners[type].push(fn);
    },
    showModal() {
      this.open = true;
      this.showModalCalls += 1;
    },
    close() {
      this.open = false;
      (modalListeners.close || []).forEach((fn) => fn());
    },
  };

  const closeBtn = {
    addEventListener(type, fn) {
      closeBtnListeners[type] = closeBtnListeners[type] || [];
      closeBtnListeners[type].push(fn);
    },
    click() {
      (closeBtnListeners.click || []).forEach((fn) => fn());
    },
  };

  const dismissBtn = {
    addEventListener(type, fn) {
      dismissBtnListeners[type] = dismissBtnListeners[type] || [];
      dismissBtnListeners[type].push(fn);
    },
    click() {
      (dismissBtnListeners.click || []).forEach((fn) => fn());
    },
  };

  const elements = {
    changelogModal: modal,
    changelogModalVersion: versionEl,
    changelogModalEntries: listEl,
    changelogModalClose: closeBtn,
    changelogModalDismiss: dismissBtn,
  };

  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
    addEventListener(type, fn) {
      docListeners[type] = docListeners[type] || [];
      docListeners[type].push(fn);
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        _html: '',
        lastElementChild: { innerHTML: '' },
        set innerHTML(val) {
          this._html = val;
          this.lastElementChild = { innerHTML: '' };
        },
        get innerHTML() {
          return this._html;
        },
      };
    },
  };

  const sessionStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, val) {
      storage.set(key, String(val));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  function fetch(url, options) {
    fetchCalls.push({ url, options });
    if (url === '/api/changelog/status') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(statusResponse),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  }

  const context = vm.createContext({
    window: { sessionStorage },
    document,
    fetch,
    Promise,
  });

  vm.runInContext(scriptSource, context);

  async function triggerDOMContentLoaded() {
    (docListeners.DOMContentLoaded || []).forEach((fn) => fn());
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    modal,
    versionEl,
    listEl,
    closeBtn,
    dismissBtn,
    fetchCalls,
    sessionStorage,
    triggerDOMContentLoaded,
  };
}

async function testRemindLaterDoesNotMarkSeenInDb() {
  const harness = createHarness({
    show: true,
    version: 'v2026.10.02',
    entries: ['New: First feature', 'Fix: Second fix'],
  });

  await harness.triggerDOMContentLoaded();

  assert.strictEqual(
    harness.modal.open,
    true,
    'modal must open when show=true'
  );
  assert.strictEqual(harness.versionEl.textContent, 'v2026.10.02');
  assert.strictEqual(harness.listEl.children.length, 2);
  assert.strictEqual(
    harness.listEl.children[0].lastElementChild.innerHTML,
    'New: First feature'
  );

  // Click "Remind me later"
  harness.closeBtn.click();

  assert.strictEqual(harness.modal.open, false, 'modal must close');
  assert.strictEqual(
    harness.fetchCalls.some((c) => c.url === '/api/changelog/mark-seen'),
    false,
    '"Remind me later" must NOT call /api/changelog/mark-seen'
  );
  assert.strictEqual(
    harness.sessionStorage.getItem('zr.welcomeDeferredVersion'),
    'v2026.10.02',
    'deferring must store version in sessionStorage for current tab navigation'
  );

  // Navigating within the same tab session suppresses re-opening
  const sameTabHarness = createHarness(
    {
      show: true,
      version: 'v2026.10.02',
      entries: ['New: First feature'],
    },
    'v2026.10.02'
  );
  await sameTabHarness.triggerDOMContentLoaded();
  assert.strictEqual(
    sameTabHarness.modal.open,
    false,
    'modal must stay closed during the same tab session after "Remind me later"'
  );
}

async function testLetsGoMarksSeenInDb() {
  const harness = createHarness({
    show: true,
    version: 'v2026.10.02',
    entries: ['New: First feature'],
  });

  await harness.triggerDOMContentLoaded();
  assert.strictEqual(harness.modal.open, true);

  // Click "Let's go"
  harness.dismissBtn.click();

  assert.strictEqual(harness.modal.open, false, 'modal must close');
  const markSeenCall = harness.fetchCalls.find(
    (c) => c.url === '/api/changelog/mark-seen'
  );
  assert.ok(
    markSeenCall && markSeenCall.options.method === 'POST',
    '"Let\'s go" must POST to /api/changelog/mark-seen to persist in DB'
  );
  assert.strictEqual(
    harness.sessionStorage.getItem('zr.welcomeDeferredVersion'),
    null,
    'confirming must not leave a deferred session flag behind'
  );
}

async function run() {
  testModalMarkup();
  testDialogStyles();
  await testRemindLaterDoesNotMarkSeenInDb();
  await testLetsGoMarksSeenInDb();

  console.log('PASS test-welcome-changelog-modal');
}

run().catch((error) => {
  console.error('FAIL test-welcome-changelog-modal');
  console.error(error);
  process.exit(1);
});
