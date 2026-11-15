/**
 * Test: the About page (GET /about in routes/system.js, views/about.ejs)
 *
 * Covers:
 * 1. The support facts name the active provider with its label and the model
 *    it is asked for (Azure: the deployment), and OCR as "Off" or by its
 *    provider
 * 2. Every supportInfo field the view and its script read is one the route
 *    provides
 * 3. The page loads no images from other hosts and shares the payment links
 *    with the welcome dialog
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-about-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // models/document.js opens data/documents.db relative to process.cwd() at
  // require time; the router pulls it in.
  process.chdir(tmpDir);

  const router = require(path.join(ROOT, 'routes', 'system'));
  const layer = router.stack.find(
    (l) => l.route?.path === '/about' && l.route.methods.get
  );
  assert.ok(layer, 'GET /about registered');
  const handle = layer.route.stack.at(-1).handle;

  const render = async (env) => {
    const saved = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, locals) {
        this.view = view;
        this.locals = locals;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };
    try {
      await handle({}, res);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.view, 'about');
    return res.locals.supportInfo;
  };

  await test('the active provider is named with its model', async () => {
    const anthropic = await render({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_MODEL: 'claude-test',
    });
    assert.strictEqual(anthropic.aiProviderLabel, 'Anthropic (Claude)');
    assert.strictEqual(anthropic.aiModel, 'claude-test');

    const azure = await render({
      AI_PROVIDER: 'azure',
      AZURE_DEPLOYMENT_NAME: 'doc-deploy',
    });
    assert.strictEqual(azure.aiProviderLabel, 'Azure OpenAI');
    assert.strictEqual(azure.aiModel, 'doc-deploy');
  });

  await test('OCR is Off, or named by its provider', async () => {
    const off = await render({ MISTRAL_OCR_ENABLED: 'no' });
    assert.strictEqual(off.ocrLabel, 'Off');

    const claude = await render({
      MISTRAL_OCR_ENABLED: 'yes',
      OCR_PROVIDER: 'anthropic',
    });
    assert.strictEqual(claude.ocrLabel, 'Claude OCR');
  });

  await test('the view reads only fields the route provides', async () => {
    const info = await render({});
    const sources = [
      path.join(ROOT, 'views', 'about.ejs'),
      path.join(ROOT, 'views', 'partials', 'scripts', 'about-scripts.ejs'),
    ].map((file) => fs.readFileSync(file, 'utf8'));
    const read = new Set();
    for (const source of sources) {
      for (const match of source.matchAll(/supportInfo\.(\w+)/g)) {
        read.add(match[1]);
      }
    }
    assert.ok(read.size > 10, 'the field scan found the reads');
    const missing = [...read].filter((field) => !(field in info));
    assert.deepStrictEqual(missing, [], `fields not provided: ${missing}`);
  });

  await test('no images from other hosts; payment links shared', async () => {
    const view = fs.readFileSync(path.join(ROOT, 'views', 'about.ejs'), 'utf8');
    assert.ok(
      !/<img[^>]+src="https?:/i.test(view),
      'the About page must not load images from other hosts'
    );
    assert.ok(
      view.includes("include('partials/pay-links')"),
      'the About page must use the shared payment links'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
