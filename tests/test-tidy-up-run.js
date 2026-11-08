'use strict';

/**
 * Test: tidy-up-run
 *
 * The run behind the Tidy up page (services/tidyUpRunService.js), driven for
 * real: the matcher, the judge, the order and the merge service against a
 * fake Paperless-ngx and a fake OpenAI-compatible model
 * (tests/helpers/tidy-up-archive.js).
 *
 * Covers:
 *  1. a run with the model: the suggestions (kinds, certainties, headlines),
 *     evidence on the pair that needs a look, nothing for a declined pair,
 *     the steps and the percent at the end, the summary
 *  2. a run without the model: the judge step is skipped, nothing is asked,
 *     the evidence is read anyway
 *  3. the run speaks while it works: suggestions before the judge is done,
 *     a percent that never goes back, at most four snapshots a second
 *  4. a stop keeps what the comparison found
 *  5. a request that answers nothing usable does not fail the run: its
 *     pairs need a look and a notice says so
 *  6. accepting carries it out (merge, split with an edit, delete), one
 *     batch undoes it all and the suggestions are open again
 *  7. declining a merge keeps the pair out of the next run; later hides it
 *  8. a second writer is refused with 409
 *  9. a decide and an undo say what they are doing while they write
 *     (activity), and a second decide meanwhile is refused with it
 */

const assert = require('assert');
const {
  mountArchive,
  TAGS,
  CORRESPONDENTS,
} = require('./helpers/tidy-up-archive');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

const byId = (run, id) => run.suggestions.find((s) => s.id === id);
const pairId = (kind, a, b) =>
  `merge:${kind}:${Math.min(a, b)}-${Math.max(a, b)}`;

async function main() {
  const archive = await mountArchive();
  const { runs, jobs, merges, simplify } = archive.services;

  /** Starts a run and waits for its end. */
  const runToEnd = async (body) => {
    const run = runs.start(body);
    await jobs.wait(run.id);
    return run;
  };

  try {
    await test('A run with the model turns the archive into suggestions', async () => {
      await archive.reset();
      await merges.dismiss({
        kind: 'tags',
        ids: [TAGS.bank, TAGS.banks],
        names: {},
      });
      await simplify.saveVocabulary({ types: ['Rechnung'], topics: ['Strom'] });

      const run = await runToEnd({ askModel: true, suggestSplits: true });
      const json = runs.toJSON(run);
      assert.strictEqual(json.status, 'done', run.job.error || '');
      assert.ok(archive.fakeOpenAI.requests.length > 0, 'the model was asked');

      const invoice = byId(run, pairId('tags', TAGS.invoice, TAGS.invoices));
      assert.ok(invoice, 'the plural pair is a suggestion');
      assert.strictEqual(invoice.certainty, 'sure');
      assert.strictEqual(invoice.headline, 'Merge Invoices into invoice');
      assert.strictEqual(invoice.evidence, null, 'a sure merge needs none');

      const acme = byId(
        run,
        pairId('correspondents', CORRESPONDENTS.acmeGmbh, CORRESPONDENTS.acme)
      );
      assert.ok(acme, 'the legal-form pair is a suggestion');
      assert.strictEqual(acme.certainty, 'sure');
      assert.strictEqual(acme.headline, 'Merge ACME into ACME GmbH');

      const tax = byId(
        run,
        pairId('tags', TAGS.steuerberater, TAGS.steuerberatr)
      );
      assert.ok(tax, 'the typo pair is a suggestion');
      assert.strictEqual(tax.certainty, 'unsure');
      assert.strictEqual(
        tax.headline,
        'Are Steuerberatr and Steuerberater the same thing?'
      );
      assert.strictEqual(tax.details.verdict.verdict, 'unsure');
      assert.ok(tax.evidence, 'a pair that needs a look carries evidence');
      assert.deepStrictEqual(
        tax.evidence.sides.map((side) => side.name),
        ['Steuerberater', 'Steuerberatr']
      );
      assert.deepStrictEqual(tax.evidence.sides[0].titles.sort(), [
        'Tax advice fee',
        'Tax return 2025',
      ]);
      assert.deepStrictEqual(tax.evidence.sides[1].titles, [
        'Tax advisor letter',
      ]);
      const konto = byId(
        run,
        pairId('tags', TAGS.kontoauszug, TAGS.kontoumzug)
      );
      assert.ok(konto, 'the pair the model thinks different still asks');
      assert.strictEqual(konto.certainty, 'unsure');

      assert.ok(
        !run.suggestions.some((s) =>
          [TAGS.bank, TAGS.banks].some(
            (id) => s.from.some((e) => e.id === id) || (s.to && s.to.id === id)
          )
        ),
        'a declined pair never becomes a suggestion, from the scan or the order'
      );

      const split = byId(run, `split:tags:${TAGS.stromrechnung}`);
      assert.ok(split, 'the compound tag is split');
      assert.strictEqual(split.typeName, 'Rechnung');
      assert.deepStrictEqual(split.topicNames, ['Strom']);

      const unused = byId(run, `delete:tags:${TAGS.oldStuff}`);
      assert.ok(unused, 'the unused tag is offered for deletion');
      assert.strictEqual(unused.headline, 'Delete the tag Old stuff');
      assert.ok(
        !byId(run, `delete:tags:${TAGS.inbox}`),
        'the inbox tag is never on the list'
      );

      assert.deepStrictEqual(
        json.steps.map((step) => [step.key, step.state]),
        [
          ['compare', 'done'],
          ['evidence', 'done'],
          ['judge', 'done'],
          ['split', 'done'],
          ['sort', 'done'],
        ]
      );
      assert.match(
        json.steps[0].detail,
        /^13 names · \d+ sure matches · \d+ pairs/
      );
      assert.match(
        json.steps[2].detail,
        /^request \d+ of \d+ · \d+ of \d+ pairs answered$/
      );
      assert.strictEqual(json.steps[3].detail, '11 tags');
      assert.strictEqual(json.progress.percent, 100);
      assert.match(
        json.progress.costText,
        /^[\d,]+ tokens of your 200,000 budget$/
      );
      assert.strictEqual(json.model, 'fake-model');
      assert.strictEqual(json.headline, 'Suggestions');
      assert.strictEqual(json.failure, null);
      assert.deepStrictEqual(json.partialFailures, []);

      assert.strictEqual(json.summary.total, run.suggestions.length);
      assert.strictEqual(json.summary.open, run.suggestions.length);
      assert.strictEqual(json.summary.split, 1);
      assert.strictEqual(json.summary.delete, 1);
      assert.strictEqual(
        json.summary.sure + json.summary.likely + json.summary.unsure,
        json.summary.open
      );
      assert.ok(json.summary.unsure >= 2);
    });

    await test('Without the model the judge is skipped and nothing is asked', async () => {
      await archive.reset();
      const run = await runToEnd({ askModel: false });
      const json = runs.toJSON(run);
      assert.strictEqual(json.status, 'done');
      assert.strictEqual(archive.fakeOpenAI.requests.length, 0);
      assert.strictEqual(json.options.askModel, false);
      const states = Object.fromEntries(
        json.steps.map((step) => [step.key, step.state])
      );
      assert.deepStrictEqual(states, {
        compare: 'done',
        evidence: 'done',
        judge: 'skipped',
        split: 'skipped',
        sort: 'done',
      });
      const tax = byId(
        run,
        pairId('tags', TAGS.steuerberater, TAGS.steuerberatr)
      );
      assert.strictEqual(tax.certainty, 'unsure', 'a typo alone is not likely');
      assert.strictEqual(tax.details.verdict, null);
      assert.deepStrictEqual(tax.evidence.sides[1].titles, [
        'Tax advisor letter',
      ]);
      assert.strictEqual(
        byId(run, pairId('tags', TAGS.invoice, TAGS.invoices)).certainty,
        'sure',
        'a plural is sure by spelling alone'
      );
      assert.strictEqual(json.progress.costText, null);
    });

    await test('The run shows suggestions while the model works', async () => {
      await archive.reset();
      archive.fakeOpenAI.setScript({
        chunks: [
          { content: require('./helpers/tidy-up-archive').modelAnswer() },
        ],
        chunkDelayMs: 400,
      });
      const run = runs.start({ askModel: true });
      const snapshots = [];
      await new Promise((resolve) => {
        runs.follow(run.id, (snapshot, final) => {
          snapshots.push({ at: Date.now(), snapshot, final });
          if (final) resolve();
        });
      });
      const final = snapshots[snapshots.length - 1];
      assert.strictEqual(final.final, true);
      assert.strictEqual(final.snapshot.status, 'done');
      const early = snapshots.find(
        (entry) =>
          entry.snapshot.status === 'running' &&
          entry.snapshot.summary.total > 0
      );
      assert.ok(early, 'suggestions are there before the run is over');
      const percents = snapshots.map(
        (entry) => entry.snapshot.progress.percent
      );
      for (let i = 1; i < percents.length; i += 1) {
        assert.ok(
          percents[i] >= percents[i - 1],
          `percent went back: ${percents}`
        );
      }
      const running = snapshots.filter((entry) => !entry.final);
      for (let i = 1; i < running.length; i += 1) {
        assert.ok(
          running[i].at - running[i - 1].at >= 200,
          'more than four snapshots a second'
        );
      }
    });

    await test('A stop keeps what the comparison found', async () => {
      await archive.reset();
      archive.fakeOpenAI.setScript({
        chunks: [
          { content: require('./helpers/tidy-up-archive').modelAnswer() },
        ],
        chunkDelayMs: 2000,
      });
      const run = runs.start({ askModel: true });
      for (let i = 0; i < 100 && run.stage !== 'review'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      runs.stop(run.id);
      await jobs.wait(run.id);
      const json = runs.toJSON(run);
      assert.strictEqual(json.status, 'stopped');
      assert.strictEqual(json.failure, null, 'a stop is not a failure');
      assert.ok(json.summary.total > 0, 'the suggestions found so far stay');
      assert.ok(byId(run, pairId('tags', TAGS.invoice, TAGS.invoices)));
      assert.strictEqual(runs.suggestionsOf().runId, run.id);
    });

    await test('An unreadable answer marks its pairs and says so', async () => {
      await archive.reset();
      archive.fakeOpenAI.setScript({
        chunks: [{ content: 'They are probably the same, I think.' }],
      });
      const run = await runToEnd({ askModel: true });
      const json = runs.toJSON(run);
      assert.strictEqual(
        json.status,
        'done',
        'one request does not fail a run'
      );
      assert.strictEqual(json.failure, null);
      assert.strictEqual(json.partialFailures.length, 1);
      const notice = json.partialFailures[0];
      for (const key of [
        'kind',
        'title',
        'body',
        'actions',
        'settingsHint',
        'technical',
        'pairsAffected',
      ]) {
        assert.ok(key in notice, `the notice lacks ${key}`);
      }
      assert.ok(notice.pairsAffected > 0);
      assert.ok(
        byId(
          run,
          pairId('correspondents', CORRESPONDENTS.acmeGmbh, CORRESPONDENTS.acme)
        ).certainty === 'sure',
        'what spelling settled stays sure'
      );

      // "Ask again for those": a new run that asks only about the groups
      // still marked "needs a look"; the rest is carried over.
      archive.fakeOpenAI.setScript({
        chunks: [
          { content: require('./helpers/tidy-up-archive').modelAnswer() },
        ],
      });
      const again = runs.start({ askModel: true, action: 'retry-affected' });
      assert.ok(again.groupIds.length > 0, 'the affected groups are named');
      assert.strictEqual(again.options.action, 'retry-affected');
      await jobs.wait(again.id);
      const retried = runs.toJSON(again);
      assert.strictEqual(retried.status, 'done');
      assert.deepStrictEqual(retried.partialFailures, []);
      const tax = byId(
        again,
        pairId('tags', TAGS.steuerberater, TAGS.steuerberatr)
      );
      assert.match(tax.reason, /the titles do not settle it/i);
      assert.strictEqual(
        byId(again, pairId('tags', TAGS.invoice, TAGS.invoices)).certainty,
        'sure',
        'the pair the failed request covered is answered now'
      );
    });

    await test('Accepting carries it out and one batch undoes it', async () => {
      await archive.reset();
      await simplify.saveVocabulary({ types: ['Rechnung'], topics: ['Strom'] });
      await runToEnd({ askModel: false, suggestSplits: true });
      const invoiceId = pairId('tags', TAGS.invoice, TAGS.invoices);
      const splitId = `split:tags:${TAGS.stromrechnung}`;
      const deleteId = `delete:tags:${TAGS.oldStuff}`;

      const answer = await runs.decide(
        {
          ids: [invoiceId, splitId, deleteId],
          decision: 'accept',
          edits: { [splitId]: { topicNames: ['Electricity'] } },
        },
        { username: 'tester' }
      );
      assert.ok(answer.batchId, 'an accept is a batch');
      const invoice = answer.suggestions.find((s) => s.id === invoiceId);
      assert.strictEqual(invoice.status, 'done', invoice.outcome);
      assert.strictEqual(invoice.outcome, '1 document moved');
      assert.ok(invoice.undoId);
      const split = answer.suggestions.find((s) => s.id === splitId);
      assert.strictEqual(split.status, 'done', split.outcome);
      assert.deepStrictEqual(split.topicNames, ['Electricity']);
      assert.ok(split.undoId);
      const removed = answer.suggestions.find((s) => s.id === deleteId);
      assert.strictEqual(removed.status, 'done', removed.outcome);
      assert.strictEqual(answer.summary.done, 3);

      const tags = await merges.listEntities('tags');
      const names = tags.map((tag) => tag.name);
      assert.ok(!names.includes('Invoices'), 'the source is gone');
      assert.ok(!names.includes('Stromrechnung'), 'the compound is gone');
      assert.ok(names.includes('Electricity'), 'the edited topic exists');
      assert.ok(!names.includes('Old stuff'), 'the unused tag is gone');
      const invoiceTag = tags.find((tag) => tag.name === 'invoice');
      assert.strictEqual(invoiceTag.documentCount, 3);

      const undone = await runs.undo({ batchId: answer.batchId });
      assert.strictEqual(
        undone.failed.length,
        0,
        JSON.stringify(undone.failed)
      );
      assert.strictEqual(undone.undone.length, 3);
      for (const id of [invoiceId, splitId, deleteId]) {
        const s = undone.suggestions.find((entry) => entry.id === id);
        assert.strictEqual(s.status, 'open', `${id} is open again`);
        assert.strictEqual(s.undoId, null);
      }
      const back = (await merges.listEntities('tags')).map((tag) => tag.name);
      for (const name of ['Invoices', 'Stromrechnung', 'Old stuff']) {
        assert.ok(back.includes(name), `${name} is back`);
      }
      const reopened = undone.suggestions.find((s) => s.id === invoiceId);
      const restored = (await merges.listEntities('tags')).find(
        (tag) => tag.name === 'Invoices'
      );
      assert.strictEqual(
        reopened.from[0].id,
        Number(restored.id),
        'the suggestion follows the re-created id'
      );
      await assert.rejects(
        runs.undo({ batchId: answer.batchId }),
        (error) => error.status === 404,
        'a batch is undone once'
      );
    });

    await test('Declining keeps the pair out of the next run; later hides it', async () => {
      await archive.reset();
      await runToEnd({ askModel: false });
      const taxId = pairId('tags', TAGS.steuerberater, TAGS.steuerberatr);
      const kontoId = pairId('tags', TAGS.kontoauszug, TAGS.kontoumzug);
      const declined = await runs.decide({ ids: [taxId], decision: 'decline' });
      assert.strictEqual(declined.batchId, null);
      assert.strictEqual(
        declined.suggestions.find((s) => s.id === taxId).status,
        'declined'
      );
      const later = await runs.decide({ ids: [kontoId], decision: 'later' });
      assert.strictEqual(
        later.suggestions.find((s) => s.id === kontoId).status,
        'later'
      );
      assert.strictEqual(later.summary.declined, 1);
      assert.strictEqual(later.summary.later, 1);

      const run = await runToEnd({ askModel: false });
      assert.ok(!byId(run, taxId), 'a declined pair does not come back');
      assert.strictEqual(
        byId(run, kontoId).status,
        'open',
        'later is for one run only'
      );
    });

    await test('A second writer is refused', async () => {
      await archive.reset();
      await runToEnd({ askModel: false });
      merges.writesInFlight += 1;
      try {
        await assert.rejects(
          runs.decide({
            ids: [pairId('tags', TAGS.invoice, TAGS.invoices)],
            decision: 'accept',
          }),
          (error) =>
            error.status === 409 &&
            /another request/.test(error.message) &&
            /Try again/.test(error.message) &&
            error.data &&
            error.data.activity === null
        );
      } finally {
        merges.writesInFlight -= 1;
      }
    });

    await test('A batch says what it is doing while it writes, and so does its undo', async () => {
      await archive.reset();
      await simplify.saveVocabulary({ types: ['Rechnung'], topics: ['Strom'] });
      await runToEnd({ askModel: false, suggestSplits: true });
      const invoiceId = pairId('tags', TAGS.invoice, TAGS.invoices);
      const splitId = `split:tags:${TAGS.stromrechnung}`;
      const deleteId = `delete:tags:${TAGS.oldStuff}`;
      assert.strictEqual(runs.suggestionsOf().activity, null, 'idle');
      assert.strictEqual(runs.toJSON(runs.run).activity, null);

      /** Samples the activity every few ms until the call settles. */
      const watch = async (pending) => {
        const seen = [];
        let settled = false;
        const done = pending.finally(() => {
          settled = true;
        });
        while (!settled) {
          const activity = runs.suggestionsOf().activity;
          if (activity) seen.push(activity);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { seen, answer: await done };
      };

      archive.store.writeDelayMs = 40;
      const pending = runs.decide(
        { ids: [invoiceId, splitId, deleteId], decision: 'accept' },
        { username: 'tester' }
      );
      // A second decide meanwhile is refused with what is going on.
      await assert.rejects(
        runs.decide({ ids: [invoiceId], decision: 'decline' }),
        (error) =>
          error.status === 409 &&
          error.data.activity.kind === 'accept' &&
          error.data.activity.total === 3
      );
      const { seen, answer } = await watch(pending);
      assert.ok(seen.length > 0, 'the activity was seen');
      for (const activity of seen) {
        assert.deepStrictEqual(Object.keys(activity).sort(), [
          'batchId',
          'current',
          'done',
          'kind',
          'sentence',
          'startedAt',
          'total',
        ]);
        assert.strictEqual(activity.kind, 'accept');
        assert.strictEqual(activity.total, 3);
        assert.strictEqual(activity.batchId, answer.batchId);
        assert.ok(!Number.isNaN(Date.parse(activity.startedAt)));
      }
      const first = seen.find((a) => a.current && a.current.id === invoiceId);
      assert.ok(first, 'the merge was named while it ran');
      assert.strictEqual(first.done, 0);
      assert.strictEqual(first.current.headline, 'Merge Invoices into invoice');
      assert.deepStrictEqual(first.current.ids, [invoiceId]);
      assert.strictEqual(
        first.sentence,
        'Merging Invoices into invoice… 1 of 3'
      );
      const later = seen.find((a) => a.current && a.current.id === deleteId);
      assert.ok(later, 'the delete was named while it ran');
      assert.strictEqual(later.done, 2);
      assert.strictEqual(later.sentence, 'Deleting the tag Old stuff… 3 of 3');
      const dones = seen.map((a) => a.done);
      for (let i = 1; i < dones.length; i += 1) {
        assert.ok(dones[i] >= dones[i - 1], `done went back: ${dones}`);
      }
      assert.strictEqual(answer.summary.done, 3);
      assert.strictEqual(runs.suggestionsOf().activity, null, 'idle again');

      const undoing = await watch(runs.undo({ batchId: answer.batchId }));
      assert.ok(undoing.seen.length > 0, 'the undo was seen');
      for (const activity of undoing.seen) {
        assert.strictEqual(activity.kind, 'undo');
        assert.strictEqual(activity.batchId, answer.batchId);
        assert.strictEqual(activity.total, 3);
        assert.match(activity.sentence, /^Undoing 3 changes… [123] of 3$/);
      }
      assert.strictEqual(undoing.answer.failed.length, 0);
      assert.strictEqual(runs.suggestionsOf().activity, null);
    });
  } finally {
    await archive.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('[FAIL] tidy-up-run');
    process.exit(1);
  }
  console.log('[PASS] tidy-up-run');
  process.exit(0);
}

main().catch((error) => {
  console.error('[FAIL] tidy-up-run', error);
  process.exit(1);
});
