/**
 * The OCR model dropdown must not be gated on the vision name heuristic.
 *
 * Vision support is guessed from the model name — the hint list knows llava,
 * pixtral, minicpm-v and a handful of others. Discovery used to return that
 * subset as soon as it was non-empty and only fell back to the full list when
 * it was empty, so on any endpoint serving a mixed catalogue every OCR-capable
 * model with an unremarkable name disappeared. gpt-4o is the reported case
 * (issue #308); mistral-ocr-latest was the same problem one issue earlier
 * (#236), which is why the Quickstart block in public/js/settings.js and
 * public/js/setup.js already refuses to filter on it.
 *
 * The heuristic still earns its keep as a ranking, so what it finds is
 * reported separately and the UI groups on it.
 *
 * The real function is required from services/connectionChecks.js and driven
 * with the setup and quickstart services stubbed, so this test cannot keep
 * passing after the real one changes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const setupService = require('../services/setupService');
const quickstartService = require('../services/quickstartService');
const { discoverOcrModelsForSetup } = require('../services/connectionChecks');

// The classification probe answers with a catalogue that mixes a
// vision-by-name model, a plain chat model that reads documents perfectly
// well, a dedicated OCR model whose name matches no vision hint, and an
// embedding model that could never do OCR.
const CATALOGUE = {
  models: [
    { id: 'gpt-4o', capabilities: ['text'] },
    { id: 'llava:13b', capabilities: ['text', 'vision'] },
    { id: 'mistral-ocr-latest', capabilities: ['text'] },
    { id: 'nomic-embed-text', capabilities: ['embedding'] },
  ],
  textModels: ['gpt-4o', 'llava:13b', 'mistral-ocr-latest'],
  visionModels: ['llava:13b'],
  embeddingModels: ['nomic-embed-text'],
  suggestedOcrModel: 'mistral-ocr-latest',
  resolvedOcrApiUrl: 'http://192.168.1.5:1234/v1',
};

// Stubs the two singletons the function talks to; call it right before the
// discovery it prepares, the stubs stay until the next call.
function buildDiscover({ classification, legacyModels = [] }) {
  setupService.withTemporaryValidationTimeout = async (_timeout, run) => run();
  setupService.detectOcrApiUrlForSetup = async ({ apiUrl }) => ({
    resolvedApiUrl: apiUrl,
  });
  setupService.discoverOcrModels = async () => legacyModels;
  quickstartService.detectAndClassify = async () => {
    if (classification instanceof Error) {
      throw classification;
    }
    return classification;
  };

  return discoverOcrModelsForSetup;
}

async function run() {
  const discover = buildDiscover({ classification: CATALOGUE });

  const result = await discover({
    provider: 'custom',
    apiUrl: 'http://192.168.1.5:1234',
    apiKey: '',
  });

  assert.strictEqual(result.success, true);

  // The whole point: a plain-named model must reach the dropdown.
  assert.ok(
    result.models.includes('gpt-4o'),
    'gpt-4o must be offered for OCR — it reads documents and only fails the name heuristic'
  );
  assert.ok(
    result.models.includes('mistral-ocr-latest'),
    'a dedicated OCR model must be offered even though its name matches no vision hint'
  );
  assert.ok(
    result.models.includes('llava:13b'),
    'vision models must remain in the list, not replace it'
  );

  // Embedding-only models still have no business here.
  assert.ok(
    !result.models.includes('nomic-embed-text'),
    'embedding-only models must stay out of the OCR dropdown — OCR with them cannot work'
  );
  assert.strictEqual(result.models.length, 3);

  // The heuristic survives as a recommendation.
  assert.deepStrictEqual(
    result.visionModels,
    ['llava:13b'],
    'the vision subset must be reported separately so the UI can group on it'
  );
  assert.strictEqual(result.suggestedModel, 'mistral-ocr-latest');
  assert.strictEqual(result.resolvedApiUrl, 'http://192.168.1.5:1234/v1');
  assert.ok(
    result.message.includes('3 OCR model(s)') &&
      result.message.includes('1 with detected vision support') &&
      result.message.includes('1 embedding-only model(s) excluded'),
    `message should account for the full list, the vision hits and the exclusions, got: ${result.message}`
  );

  // A catalogue without a single vision hit must not change what is offered.
  const noVision = await buildDiscover({
    classification: {
      ...CATALOGUE,
      models: CATALOGUE.models.slice(0, 1),
      textModels: ['gpt-4o'],
      visionModels: [],
      embeddingModels: [],
      suggestedOcrModel: null,
    },
  })({ provider: 'custom', apiUrl: 'http://host:1234', apiKey: '' });
  assert.deepStrictEqual(noVision.models, ['gpt-4o']);
  assert.deepStrictEqual(noVision.visionModels, []);
  assert.strictEqual(noVision.suggestedModel, null);
  assert.ok(
    !/vision/i.test(noVision.message),
    `a catalogue with no vision hits must not mention vision, got: ${noVision.message}`
  );

  // Nothing selectable at all is still reported as such.
  const empty = await buildDiscover({
    classification: {
      ...CATALOGUE,
      models: [{ id: 'nomic-embed-text', capabilities: ['embedding'] }],
      textModels: [],
      visionModels: [],
      embeddingModels: ['nomic-embed-text'],
      suggestedOcrModel: null,
    },
  })({ provider: 'ollama', apiUrl: 'http://host:11434', apiKey: '' });
  assert.deepStrictEqual(empty.models, []);
  assert.strictEqual(
    empty.message,
    'No OCR models discovered for this provider.'
  );

  // A failed probe still falls through to the legacy unfiltered discovery,
  // which reports no classification at all.
  const legacy = await buildDiscover({
    classification: new Error('probe failed'),
    legacyModels: ['some-model'],
  })({ provider: 'custom', apiUrl: 'http://host:1234', apiKey: '' });
  assert.deepStrictEqual(legacy.models, ['some-model']);
  assert.strictEqual(legacy.visionModels, undefined);

  // Providers outside the classification path (Mistral) are untouched.
  const mistral = await buildDiscover({
    classification: CATALOGUE,
    legacyModels: ['mistral-ocr-latest'],
  })({ provider: 'mistral', apiUrl: 'https://api.mistral.ai', apiKey: 'k' });
  assert.deepStrictEqual(mistral.models, ['mistral-ocr-latest']);

  // ── The dropdown groups on the hint instead of dropping the rest ──────────
  // The two page scripts each carry their own select helper; both must behave
  // the same, so both are read out of their file and driven against a stub DOM.

  const selectHelpers = [
    {
      file: path.join(__dirname, '..', 'public', 'js', 'settings.js'),
      from: 'const populateModelSelect = (',
      until: '\n  };',
      name: 'populateModelSelect',
      build: (body) =>
        new Function('document', `${body}\nreturn populateModelSelect;`),
    },
    {
      file: path.join(__dirname, '..', 'public', 'js', 'setup.js'),
      from: '  setModelSelectOptions(',
      until: '\n  }',
      name: 'setModelSelectOptions',
      // A class method needs an object to hang off before it can be called.
      build: (body) =>
        new Function(
          'document',
          `const holder = { ${body.trimStart()} };\nreturn holder.setModelSelectOptions.bind(holder);`
        ),
    },
  ];

  for (const helper of selectHelpers) {
    const helperSource = fs.readFileSync(helper.file, 'utf8');
    const helperStart = helperSource.indexOf(helper.from);
    assert.ok(
      helperStart !== -1,
      `Could not find ${helper.name} in ${path.basename(helper.file)} — did it move or get renamed?`
    );
    const helperEnd = helperSource.indexOf(helper.until, helperStart);
    assert.ok(helperEnd > helperStart, `Could not delimit ${helper.name}`);
    const body = helperSource.slice(
      helperStart,
      helperEnd + helper.until.length
    );

    const documentStub = {
      createElement: (tag) => ({
        tag,
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      }),
    };
    const setOptions = helper.build(body)(documentStub);

    const select = documentStub.createElement('select');
    setOptions(select, result.models, 'Select OCR model', {
      recommended: result.visionModels,
      recommendedLabel: 'Recommended (vision detected)',
      otherLabel: 'Other models',
      preferred: result.suggestedModel,
    });

    const groups = select.children.filter((node) => node.tag === 'optgroup');
    assert.strictEqual(
      groups.length,
      2,
      `${helper.name} should render a recommended group and an "other" group`
    );
    assert.strictEqual(groups[0].label, 'Recommended (vision detected)');
    assert.deepStrictEqual(
      groups[0].children.map((option) => option.value),
      ['llava:13b']
    );
    assert.strictEqual(groups[1].label, 'Other models');
    assert.deepStrictEqual(
      groups[1].children.map((option) => option.value),
      ['gpt-4o', 'mistral-ocr-latest'],
      `${helper.name} must keep the non-vision models selectable rather than dropping them`
    );
    assert.strictEqual(
      select.value,
      'mistral-ocr-latest',
      `${helper.name} should preselect the suggested model`
    );

    // Without grouping the select stays flat — every other caller relies on it.
    const flat = documentStub.createElement('select');
    setOptions(flat, ['a', 'b'], 'Select model');
    assert.strictEqual(
      flat.children.filter((node) => node.tag === 'optgroup').length,
      0,
      `${helper.name} must render flat when no grouping is passed`
    );
    assert.strictEqual(flat.value, 'a');
  }

  console.log('PASS test-ocr-model-discovery-unfiltered');
}

run().catch((error) => {
  console.error('FAIL test-ocr-model-discovery-unfiltered');
  console.error(error);
  process.exit(1);
});
