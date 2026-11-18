// Tests for the Mailrobbe-style welcome/support & changelog modal:
// 1. Markup in views/partials/changelog-modal.ejs includes the two-column story
//    (with the contact block at its end), energy drink tiers, payment links and
//    the changelog list, and opens with the focus on the title.
// 2. public/js/changelog-modal.js opens the modal when /api/changelog/status
//    returns show=true, does NOT call /api/changelog/mark-seen when dismissed via
//    "Remind me later" / Escape / backdrop, and DOES call /api/changelog/mark-seen
//    when confirmed via "Let's go".
// 3. public/css/dialogs.css provides the .zr-welcome layout rules.
// 4. After an update (GET /api/changelog/status answers updated: true) the
//    dialog opens with the update notice: the markup carries it hidden above
//    the title, the script fills and shows it and hands it the focus and the
//    dialog's name; otherwise the dialog stays as it was. The route answers
//    updated/previousVersion for no stored, an older and the same version.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

  // The payment links live in a partial the About page shares.
  assert.ok(
    ejs.includes("include('pay-links')"),
    'welcome modal must include the shared payment links'
  );
  const payLinks = fs.readFileSync(
    path.join(ROOT, 'views', 'partials', 'pay-links.ejs'),
    'utf8'
  );
  for (const href of [
    'https://github.com/sponsors/admonstrator',
    'https://buymeacoffee.com/admon',
    'https://paypal.me/aaronviehl',
    'https://ko-fi.com/admon',
  ]) {
    assert.ok(
      payLinks.includes(`href="${href}"`),
      `payment links must include ${href}`
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

  // The contact closes the story column, which leaves the main column short
  // enough to fit a laptop screen without scrolling; the changelog sits in the
  // main column above the footer.
  const storyIdx = ejs.indexOf('class="zr-welcome__story"');
  const contactIdx = ejs.indexOf('class="zr-welcome__contact"');
  const mainIdx = ejs.indexOf('class="zr-welcome__main"');
  const changelogIdx = ejs.indexOf('id="changelogModalEntries"');
  const footIdx = ejs.indexOf('zr-welcome__foot');
  assert.ok(
    storyIdx < contactIdx && contactIdx < mainIdx,
    'contact block must sit in the story column'
  );
  assert.ok(
    changelogIdx > mainIdx && footIdx > changelogIdx,
    'changelog entries list must sit in the main column above the footer'
  );

  // Opening the dialog focuses the title, not the first link: on a phone the
  // first link sits below the fold and the dialog would open scrolled to it.
  assert.match(
    ejs,
    /<h2 id="changelogModalTitle"[^>]*\btabindex="-1"[^>]*\bautofocus\b/,
    'the dialog title must take the focus when the dialog opens'
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

function testUpdateNoticeMarkup() {
  const ejs = fs.readFileSync(
    path.join(ROOT, 'views', 'partials', 'changelog-modal.ejs'),
    'utf8'
  );

  // The notice is the first thing in the main column, above the title, and
  // hidden until the script learns that an update happened.
  const mainIdx = ejs.indexOf('class="zr-welcome__main"');
  const noticeMatch = ejs.match(/<div id="changelogModalUpdate"[^>]*>/);
  assert.ok(noticeMatch, 'the update notice must be in the markup');
  const noticeIdx = ejs.indexOf(noticeMatch[0]);
  const titleIdx = ejs.indexOf('id="changelogModalTitle"');
  assert.ok(
    mainIdx < noticeIdx && noticeIdx < titleIdx,
    'the update notice must open the main column, above the title'
  );
  assert.ok(
    !/<[a-z]/.test(
      ejs
        .slice(mainIdx + 'class="zr-welcome__main">'.length, noticeIdx)
        .replace(/<!--[\s\S]*?-->/g, '')
    ),
    'nothing may sit in the main column before the update notice'
  );
  assert.match(
    noticeMatch[0],
    /class="zr-welcome__update hidden"/,
    'the update notice must start hidden'
  );
  assert.match(
    noticeMatch[0],
    /tabindex="-1"/,
    'the update notice must be able to take the focus'
  );
  assert.ok(
    !/\bautofocus\b/.test(noticeMatch[0]),
    'the update notice must not carry autofocus in the markup'
  );
  assert.strictEqual(
    (ejs.match(/\sautofocus\b/g) || []).length,
    1,
    'exactly one element (the title) may carry autofocus in the markup'
  );
  assert.match(
    ejs,
    /<dialog id="changelogModal"[^>]*aria-labelledby="changelogModalTitle"/,
    'the title names the dialog until an update hands that to the notice'
  );

  for (const id of [
    'changelogModalUpdateTitle',
    'changelogModalUpdateVersion',
    'changelogModalUpdateFromLine',
    'changelogModalUpdateFrom',
  ]) {
    assert.ok(ejs.includes(`id="${id}"`), `the notice must contain #${id}`);
  }
  assert.match(
    ejs,
    /id="changelogModalUpdateTitle"[^>]*>\s*Hooray, Zettelrobbe was updated to <span id="changelogModalUpdateVersion"><\/span>/,
    'the notice line must cheer and name the new version'
  );
  assert.match(
    ejs,
    /id="changelogModalUpdateFromLine"[^>]*>\s*You were on <span id="changelogModalUpdateFrom"><\/span> before\./,
    'the notice must name the version the user came from'
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
    '.zr-welcome__update',
    '.zr-welcome__update-from',
    '.zr-welcome__tiles',
    '.zr-pay',
    '.zr-welcome__contact',
    '.zr-welcome__changelog',
    '.zr-welcome__foot',
  ]) {
    assert.ok(css.includes(selector), `dialogs.css must define ${selector}`);
  }
}

// A stand-in for a DOM element with the parts the script touches: text,
// classes and attributes. Initial classes and attributes mirror the markup.
function makeElement(classes = [], attributes = {}) {
  const classSet = new Set(classes);
  const attrs = new Map(Object.entries(attributes));
  return {
    textContent: '',
    classList: {
      add: (name) => classSet.add(name),
      remove: (name) => classSet.delete(name),
      contains: (name) => classSet.has(name),
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
  };
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

  const title = makeElement(['zr-welcome__title'], {
    tabindex: '-1',
    autofocus: '',
  });
  const notice = makeElement(['zr-welcome__update', 'hidden'], {
    tabindex: '-1',
  });
  const noticeTitle = makeElement(['zr-welcome__update-title']);
  const noticeVersion = makeElement();
  const noticeFromLine = makeElement(['zr-welcome__update-from']);
  const noticeFrom = makeElement();
  const focusable = {
    changelogModalTitle: title,
    changelogModalUpdate: notice,
  };

  const modal = Object.assign(
    makeElement(['zr-dialog', 'zr-welcome'], {
      'aria-labelledby': 'changelogModalTitle',
    }),
    {
      open: false,
      showModalCalls: 0,
      // What the browser would see when it opens the dialog: the element it
      // focuses (the one autofocus) and the dialog's name.
      atOpen: null,
      addEventListener(type, fn) {
        modalListeners[type] = modalListeners[type] || [];
        modalListeners[type].push(fn);
      },
      showModal() {
        this.open = true;
        this.showModalCalls += 1;
        this.atOpen = {
          autofocus: Object.keys(focusable).filter((id) =>
            focusable[id].hasAttribute('autofocus')
          ),
          labelledBy: this.getAttribute('aria-labelledby'),
        };
      },
      close() {
        this.open = false;
        (modalListeners.close || []).forEach((fn) => fn());
      },
    }
  );

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
    changelogModalTitle: title,
    changelogModalUpdate: notice,
    changelogModalUpdateTitle: noticeTitle,
    changelogModalUpdateVersion: noticeVersion,
    changelogModalUpdateFromLine: noticeFromLine,
    changelogModalUpdateFrom: noticeFrom,
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
    title,
    notice,
    noticeVersion,
    noticeFromLine,
    noticeFrom,
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

async function testUpdateNoticeShownAfterUpdate() {
  const harness = createHarness({
    show: true,
    version: 'v2026.11.04',
    entries: ['New: First feature'],
    updated: true,
    previousVersion: 'v2026.11.03',
  });

  await harness.triggerDOMContentLoaded();

  assert.strictEqual(harness.modal.open, true, 'modal must open');
  assert.strictEqual(
    harness.notice.classList.contains('hidden'),
    false,
    'the update notice must show after an update'
  );
  assert.strictEqual(harness.noticeVersion.textContent, 'v2026.11.04');
  assert.strictEqual(harness.noticeFrom.textContent, 'v2026.11.03');
  assert.strictEqual(
    harness.noticeFromLine.classList.contains('hidden'),
    false,
    'the version the user came from must show'
  );
  // The swap happens before the dialog opens, so the browser focuses the
  // notice and announces it as the dialog's name; one autofocus at a time.
  assert.deepStrictEqual(
    harness.modal.atOpen,
    {
      autofocus: ['changelogModalUpdate'],
      labelledBy: 'changelogModalUpdateTitle',
    },
    'the notice must take the focus and name the dialog when it opens'
  );
}

async function testUpdateNoticeWithoutPreviousVersion() {
  const harness = createHarness({
    show: true,
    version: 'v2026.11.04',
    entries: [],
    updated: true,
    previousVersion: null,
  });

  await harness.triggerDOMContentLoaded();

  assert.strictEqual(harness.notice.classList.contains('hidden'), false);
  assert.strictEqual(
    harness.noticeFromLine.classList.contains('hidden'),
    true,
    'without a previous version the "You were on" line must stay hidden'
  );
}

async function testUpdateNoticeHiddenOtherwise() {
  for (const extra of [
    { updated: false, previousVersion: null },
    // A server from before the notice existed answers neither field.
    {},
  ]) {
    const harness = createHarness({
      show: true,
      version: 'v2026.11.04',
      entries: ['New: First feature'],
      ...extra,
    });

    await harness.triggerDOMContentLoaded();

    assert.strictEqual(harness.modal.open, true, 'modal must open');
    assert.strictEqual(
      harness.notice.classList.contains('hidden'),
      true,
      `the update notice must stay hidden for ${JSON.stringify(extra)}`
    );
    assert.strictEqual(harness.noticeVersion.textContent, '');
    assert.deepStrictEqual(
      harness.modal.atOpen,
      { autofocus: ['changelogModalTitle'], labelledBy: 'changelogModalTitle' },
      'without an update the title keeps the focus and names the dialog'
    );
  }
}

async function testDeferredUpdateNoticeReturns() {
  const status = {
    show: true,
    version: 'v2026.11.04',
    entries: ['New: First feature'],
    updated: true,
    previousVersion: 'v2026.11.03',
  };
  const harness = createHarness(status);
  await harness.triggerDOMContentLoaded();
  harness.closeBtn.click();
  assert.strictEqual(
    harness.fetchCalls.some((c) => c.url === '/api/changelog/mark-seen'),
    false,
    '"Remind me later" must not store the version, so the server keeps answering updated'
  );

  // A new tab session starts with empty sessionStorage.
  const nextSession = createHarness(status);
  await nextSession.triggerDOMContentLoaded();
  assert.strictEqual(nextSession.modal.open, true);
  assert.strictEqual(
    nextSession.notice.classList.contains('hidden'),
    false,
    'a deferred dialog that returns in a new tab session still shows the notice'
  );
}

// GET /api/changelog/status against a real users table in a temp directory.
async function testStatusRouteUpdatedFlag() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-welcome-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time; the router pulls it in.
  process.chdir(tmpDir);

  const documentModel = require(path.join(ROOT, 'models', 'document.js'));
  const changelog = require(path.join(ROOT, 'config', 'changelog.js'));
  const router = require(path.join(ROOT, 'routes', 'system'));
  const layer = router.stack.find(
    (l) => l.route?.path === '/api/changelog/status' && l.route.methods.get
  );
  assert.ok(layer, 'GET /api/changelog/status registered');
  const handle = layer.route.stack.at(-1).handle;

  const call = async (user) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    await handle({ user }, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
  };

  try {
    // A fresh installation: the account exists, no version stored yet.
    assert.ok(await documentModel.addUser('alice', 'hash'));
    const fresh = await call({ username: 'alice' });
    assert.strictEqual(fresh.show, true);
    assert.strictEqual(fresh.version, changelog.version);
    assert.deepStrictEqual(fresh.entries, changelog.entries);
    assert.strictEqual(fresh.updated, false, 'no stored version: no update');
    assert.strictEqual(fresh.previousVersion, null);

    // A user unknown to the table reads like a new account.
    const unknown = await call({ username: 'nobody' });
    assert.strictEqual(unknown.show, true);
    assert.strictEqual(unknown.updated, false);
    assert.strictEqual(unknown.previousVersion, null);

    // An older stored version: the update brought the dialog back.
    await documentModel.setLastSeenChangelogVersion('alice', 'v2000.01.01');
    const older = await call({ username: 'alice' });
    assert.strictEqual(older.show, true);
    assert.strictEqual(
      older.updated,
      true,
      'an older stored version is an update'
    );
    assert.strictEqual(older.previousVersion, 'v2000.01.01');
    assert.strictEqual(older.version, changelog.version);

    // The same version: the dialog was confirmed, nothing to show.
    await documentModel.setLastSeenChangelogVersion('alice', changelog.version);
    const same = await call({ username: 'alice' });
    assert.deepStrictEqual(same, {
      show: false,
      version: changelog.version,
      entries: [],
      updated: false,
      previousVersion: null,
    });

    // The short cuts keep their answer.
    assert.deepStrictEqual(await call({ apiKey: true }), { show: false });
    assert.deepStrictEqual(await call({}), { show: false });
  } finally {
    process.chdir(ROOT);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function run() {
  testModalMarkup();
  testUpdateNoticeMarkup();
  testDialogStyles();
  await testRemindLaterDoesNotMarkSeenInDb();
  await testLetsGoMarksSeenInDb();
  await testUpdateNoticeShownAfterUpdate();
  await testUpdateNoticeWithoutPreviousVersion();
  await testUpdateNoticeHiddenOtherwise();
  await testDeferredUpdateNoticeReturns();
  await testStatusRouteUpdatedFlag();

  console.log('PASS test-welcome-changelog-modal');
  // The router pulls in services that may keep timers alive.
  process.exit(0);
}

run().catch((error) => {
  console.error('FAIL test-welcome-changelog-modal');
  console.error(error);
  process.exit(1);
});
