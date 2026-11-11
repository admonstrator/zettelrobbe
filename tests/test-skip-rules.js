const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const repoRoot = path.join(__dirname, '..');
const LONG_TERMS = 'General terms and conditions of the bank. '.repeat(20);

async function run() {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-skip-rules-'));

  try {
    process.chdir(tempRoot);

    const documentModel = require('../models/document');
    const paperlessService = require('../services/paperlessService');
    const skipRuleService = require('../services/skipRuleService');

    // Fingerprint: case and whitespace do not count, short texts never match.
    assert.strictEqual(
      skipRuleService.fingerprint(LONG_TERMS),
      skipRuleService.fingerprint(`  ${LONG_TERMS.toUpperCase()}\n\n`),
      'case and line breaks should not change the fingerprint'
    );
    assert.strictEqual(skipRuleService.fingerprint('Receipt 12.50'), null);
    assert.strictEqual(skipRuleService.fingerprint(''), null);

    // Nothing configured: nothing is skipped.
    delete process.env.MAX_PAGE_COUNT;
    delete process.env.IGNORE_TITLE_PATTERNS;
    delete process.env.IGNORE_REPEATED_CONTENT;
    assert.strictEqual(
      await skipRuleService.evaluate({ id: 1, title: 'AGB', page_count: 500 }),
      null,
      'no rule should match while no rule is configured'
    );

    // Page limit.
    process.env.MAX_PAGE_COUNT = '30';
    const pageMatch = await skipRuleService.apply(
      { id: 10, title: 'Revolut terms', page_count: 112 },
      LONG_TERMS
    );
    assert.ok(pageMatch, 'a document over the page limit should be skipped');
    assert.strictEqual(pageMatch.reason, 'Page limit: 112 pages (max 30)');
    assert.strictEqual(await documentModel.isDocumentIgnored(10), true);
    assert.strictEqual(
      await skipRuleService.evaluate({
        id: 11,
        title: 'Letter',
        page_count: 30,
      }),
      null,
      'a document at the limit should pass'
    );
    assert.strictEqual(
      await skipRuleService.evaluate({ id: 12, title: 'Letter' }),
      null,
      'an unknown page count should pass'
    );
    process.env.MAX_PAGE_COUNT = '0';
    assert.strictEqual(
      await skipRuleService.evaluate({ id: 13, title: 'Big', page_count: 900 }),
      null,
      '0 should mean no limit'
    );

    // Title patterns, in the title or the original file name.
    process.env.IGNORE_TITLE_PATTERNS = 'AGB, Terms of Service';
    const titleMatch = await skipRuleService.evaluate({
      id: 20,
      title: 'Revolut agb 2026',
    });
    assert.strictEqual(titleMatch?.reason, 'Title matches "AGB"');
    const fileMatch = await skipRuleService.evaluate({
      id: 21,
      title: 'Scan 0042',
      original_file_name: 'revolut terms of service.pdf',
    });
    assert.strictEqual(fileMatch?.reason, 'Title matches "Terms of Service"');
    assert.strictEqual(
      await skipRuleService.evaluate({ id: 22, title: 'Invoice 7' }),
      null
    );
    process.env.IGNORE_TITLE_PATTERNS = '';

    // Same text as an ignored document. #10 was stored with its fingerprint.
    const copyMatch = await skipRuleService.evaluate(
      { id: 30, title: 'Mail attachment' },
      LONG_TERMS.replace(/ /g, '  ')
    );
    assert.strictEqual(copyMatch?.reason, 'Same text as #10');
    assert.strictEqual(
      await skipRuleService.evaluate(
        { id: 10, title: 'Revolut terms' },
        LONG_TERMS
      ),
      null,
      'a document should not match its own fingerprint'
    );
    process.env.IGNORE_REPEATED_CONTENT = 'no';
    assert.strictEqual(
      await skipRuleService.evaluate(
        { id: 30, title: 'Mail attachment' },
        LONG_TERMS
      ),
      null,
      'the text rule should be switchable off'
    );
    process.env.IGNORE_REPEATED_CONTENT = 'yes';

    // A document ignored by hand gets its fingerprint fetched afterwards.
    const otherTerms = 'Privacy notice of the insurer. '.repeat(20);
    paperlessService.getDocumentContent = async (documentId) => {
      if (documentId === 40) return otherTerms;
      throw new Error('not reachable');
    };
    await documentModel.addIgnoredDocument(40, 'Privacy notice', 'manual');
    await skipRuleService.rememberFingerprints([40, 41]);
    const manualCopy = await skipRuleService.evaluate(
      { id: 42, title: 'x' },
      otherTerms
    );
    assert.strictEqual(manualCopy?.reason, 'Same text as #40');

    // Taken off the list by hand: the rules leave the document alone.
    process.env.MAX_PAGE_COUNT = '30';
    await documentModel.removeIgnoredDocument(10);
    assert.strictEqual(await documentModel.isSkipRuleExempt(10), true);
    assert.strictEqual(
      await skipRuleService.apply(
        { id: 10, title: 'Revolut terms', page_count: 112 },
        LONG_TERMS
      ),
      null,
      'a document released by hand should not be skipped again'
    );
    // Ignored again by hand: the exemption ends.
    await documentModel.addIgnoredDocument(10, 'Revolut terms', 'manual');
    assert.strictEqual(await documentModel.isSkipRuleExempt(10), false);

    // Clearing the whole list releases every document on it.
    await documentModel.clearAllIgnoredDocuments();
    assert.strictEqual(await documentModel.isSkipRuleExempt(40), true);
    assert.strictEqual(await documentModel.isSkipRuleExempt(10), true);

    // Skipping by hand: proposals built from one document.
    const { suggestTitleParts, suggestPageLimit } = skipRuleService;
    assert.deepStrictEqual(
      suggestTitleParts(
        'Revolut Bank UAB – Terms and Conditions 2026-10-01',
        'revolut_terms_2026-10.pdf',
        'Revolut Bank UAB'
      ),
      [
        'Terms and Conditions',
        'Revolut Bank UAB – Terms and Conditions',
        'revolut_terms',
        'Revolut Bank UAB',
      ],
      'title parts without dates, the correspondent alone last'
    );
    assert.deepStrictEqual(suggestTitleParts('', '', ''), []);
    assert.strictEqual(suggestPageLimit(112), 100);
    assert.strictEqual(suggestPageLimit(31), 30);
    assert.strictEqual(suggestPageLimit(8), null);
    assert.strictEqual(suggestPageLimit(null), null);

    await documentModel.addToHistory(
      500,
      [],
      'Revolut Terms and Conditions 2025',
      'Revolut'
    );
    await documentModel.addToHistory(501, [], 'Invoice 4711', 'Revolut');
    assert.strictEqual(
      await documentModel.countHistoryTitlesContaining(
        'terms and conditions',
        900
      ),
      1
    );
    assert.strictEqual(
      await documentModel.countHistoryTitlesContaining('100%_off', 900),
      0,
      'LIKE wildcards in a title part are taken literally'
    );

    process.env.MAX_PAGE_COUNT = '0';
    process.env.IGNORE_TITLE_PATTERNS = 'AGB';
    paperlessService.getDocument = async (documentId) =>
      documentId === 900
        ? {
            id: 900,
            title: 'Revolut Bank UAB – Terms and Conditions',
            original_file_name: 'revolut_terms_2026-10.pdf',
            page_count: 112,
            correspondent: 7,
            content: LONG_TERMS,
          }
        : null;
    paperlessService.getCorrespondentNameById = async () => ({
      id: 7,
      name: 'Revolut Bank UAB',
    });

    const proposal = await skipRuleService.suggest(900);
    assert.strictEqual(proposal.document.pageCount, 112);
    assert.strictEqual(proposal.document.correspondent, 'Revolut Bank UAB');
    assert.strictEqual(proposal.sameText.available, true);
    assert.strictEqual(
      proposal.title.suggestions[0].pattern,
      'Terms and Conditions'
    );
    assert.strictEqual(proposal.title.suggestions[0].historyMatches, 1);
    assert.deepStrictEqual(proposal.title.existing, ['AGB']);
    assert.strictEqual(proposal.pageLimit.suggested, 100);
    assert.strictEqual(await skipRuleService.suggest(901), null);

    const skipped = await skipRuleService.skipDocument(900, {
      sameText: true,
      titlePattern: 'Terms and Conditions',
      pageLimit: 100,
    });
    assert.deepStrictEqual(skipped.notSaved, []);
    assert.strictEqual(await documentModel.isDocumentIgnored(900), true);
    assert.strictEqual(
      process.env.IGNORE_TITLE_PATTERNS,
      'AGB,Terms and Conditions'
    );
    assert.strictEqual(process.env.MAX_PAGE_COUNT, '100');
    const overrides = JSON.parse(
      await fs.readFile(
        path.join(tempRoot, 'data', 'runtime-overrides.json'),
        'utf8'
      )
    );
    assert.strictEqual(
      overrides.IGNORE_TITLE_PATTERNS,
      'AGB,Terms and Conditions'
    );
    assert.strictEqual(overrides.MAX_PAGE_COUNT, '100');
    const nextCopy = await skipRuleService.evaluate(
      { id: 902, title: 'Mail attachment' },
      LONG_TERMS
    );
    assert.strictEqual(nextCopy?.reason, 'Same text as #900');

    // Without the text rule no fingerprint is kept, and a pattern on the list
    // is not added twice.
    paperlessService.getDocument = async (documentId) => ({
      id: documentId,
      title: 'Privacy notice',
      content: otherTerms.toUpperCase() + ' extra',
    });
    await skipRuleService.skipDocument(903, {
      sameText: false,
      titlePattern: 'terms and conditions',
    });
    assert.strictEqual(
      process.env.IGNORE_TITLE_PATTERNS,
      'AGB,Terms and Conditions'
    );
    assert.strictEqual(
      await documentModel.findIgnoredByContentHash(
        skipRuleService.fingerprint(otherTerms.toUpperCase() + ' extra')
      ),
      null
    );

    // Wiring: the scan checks the rules before the OCR fallback, the webhook
    // applies them and a rescan by hand does not.
    const server = await fs.readFile(path.join(repoRoot, 'server.js'), 'utf8');
    const ruleAt = server.indexOf('skipRuleService.apply(');
    const ocrAt = server.indexOf('content.length < MIN_CONTENT_LENGTH');
    assert.ok(
      ruleAt > 0 && ruleAt < ocrAt,
      'scan should apply skip rules before the OCR fallback'
    );

    const setup = await fs.readFile(
      path.join(repoRoot, 'routes', 'setup.js'),
      'utf8'
    );
    assert.ok(
      setup.includes('documentQueue.push({ document, applySkipRules: true })'),
      'webhook documents should go through the skip rules'
    );
    assert.ok(
      setup.includes(
        'documentQueue.push({ document: entry.document, applySkipRules: false })'
      ),
      'a rescan by hand should bypass the skip rules'
    );

    const historyJs = await fs.readFile(
      path.join(repoRoot, 'public', 'js', 'history.js'),
      'utf8'
    );
    assert.ok(historyJs.includes('/api/ignored/suggest/'));
    assert.ok(historyJs.includes("'/api/ignored/skip'"));
    const historyView = await fs.readFile(
      path.join(repoRoot, 'views', 'history.ejs'),
      'utf8'
    );
    for (const id of [
      'skipDialog',
      'skipRuleText',
      'skipTitlePattern',
      'skipPageLimit',
      'skipDialogConfirm',
    ]) {
      assert.ok(
        historyView.includes(`id="${id}"`),
        `history view should render #${id}`
      );
    }

    console.log('PASS test-skip-rules');
  } finally {
    process.chdir(originalCwd);
    process.env = originalEnv;

    try {
      const documentModel = require('../models/document');
      await documentModel.closeDatabase();
    } catch {
      // Ignore close failures from partially initialized test state.
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('FAIL test-skip-rules');
  console.error(error);
  process.exit(1);
});
