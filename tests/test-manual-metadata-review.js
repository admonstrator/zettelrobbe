const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      textContent: '',
      value: '',
      children: [],
      disabled: false,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
    });
  }
  return elements.get(id);
}
const requests = [];
const context = vm.createContext({
  document: { getElementById: element, addEventListener() {} },
  console,
  fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({}) };
  },
});
const source = fs.readFileSync(
  path.join(__dirname, '../views/partials/scripts/manual-scripts.ejs'),
  'utf8'
);
vm.runInContext(
  source.replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, ''),
  context
);
const run = (code) => vm.runInContext(code, context);
run(
  "showMessage = () => {}; currentDocument = '1'; updateTitleDisplay('Original');"
);

(async () => {
  // Suggestions are independent of a correspondent and never overwrite the current title.
  element('contentPreview').textContent = 'Document content';
  const saveFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    json: async () => ({
      document: {
        title: '<b>Suggested</b>',
        document_type: 'Invoice',
        correspondent: null,
      },
    }),
  });
  await run('handleAnalysis()');
  context.fetch = saveFetch;
  assert.equal(element('suggestedTitle').textContent, '<b>Suggested</b>');
  assert.equal(element('titleName').textContent, 'Original');
  assert.equal(element('suggestedDocumentType').textContent, 'Invoice');
  await run('updateDocumentTags()');
  assert.equal(JSON.parse(requests.at(-1).options.body).title, 'Original');
  run('resolveTitleSuggestion(false)');
  await run('updateDocumentTags()');
  assert.equal(JSON.parse(requests.at(-1).options.body).title, 'Original');
  run(
    "updateMetadataSuggestions({ title: 'Accepted' }); resolveTitleSuggestion(true);"
  );
  await run('updateDocumentTags()');
  assert.equal(JSON.parse(requests.at(-1).options.body).title, 'Accepted');
  assert.equal(
    element('suggestedTitleInfo').classList.contains('hidden'),
    true
  );
  run('updateMetadataSuggestions()');
  assert.equal(element('suggestedDocumentType').textContent, '');
  assert.equal(
    element('suggestedDocumentTypeInfo').classList.contains('hidden'),
    true
  );

  // An analysis that finishes after a document change must not restore old suggestions.
  let finish;
  context.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  element('contentPreview').textContent = 'Document content';
  const pending = run('handleAnalysis()');
  await run("handleDocumentSelection('')");
  finish({
    ok: true,
    json: async () => ({
      document: { title: 'Stale', document_type: 'Stale' },
    }),
  });
  await pending;
  assert.equal(element('suggestedTitle').textContent, '');
  assert.equal(element('suggestedDocumentType').textContent, '');
  assert.equal(element('analyzeBtn').disabled, true);
  console.log('Manual metadata review tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
