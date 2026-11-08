'use strict';

/**
 * Every sentence the Tidy up page says, in one place.
 *
 * The page never shows a rule key, a percentage or a phase name; it shows
 * what a person would say. This module turns the machinery's vocabulary
 * (matcher reasons, verdicts, job phases, failure kinds) into those
 * sentences, so the wording can be read, reviewed and changed without
 * touching a service or a template.
 *
 * Pure module. Names are passed through unescaped: the template escapes.
 */

/* ------------------------------------------------------------------ */
/* Certainty                                                           */
/* ------------------------------------------------------------------ */

const CERTAINTY_LABELS = Object.freeze({
  sure: 'Sure',
  likely: 'Likely',
  unsure: 'Needs a look',
});

/** @param {'sure'|'likely'|'unsure'} certainty */
function certaintyLabel(certainty) {
  return CERTAINTY_LABELS[certainty] || CERTAINTY_LABELS.unsure;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** "12 documents" / "1 document" / "no documents" */
function documents(n) {
  const count = Number(n) || 0;
  if (count === 0) return 'no documents';
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'document' : 'documents'}`;
}

/** "a, b and c" */
function listNames(names) {
  const list = (names || []).map((n) => String(n));
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function thing(entityKind) {
  return entityKind === 'correspondents' ? 'correspondent' : 'tag';
}

/* ------------------------------------------------------------------ */
/* Why two names are the same: the matcher's reasons in words          */
/* ------------------------------------------------------------------ */

/**
 * One clause per matcher reason, keyed by entity kind where the wording
 * differs. Strongest reason wins; the others are not listed.
 */
const RULE_CLAUSES = Object.freeze({
  'exact-normalized': {
    tags: 'Same word, only the capitalisation or spacing differs.',
    correspondents: 'Same name, only the capitalisation or spacing differs.',
  },
  'umlaut-variant': {
    tags: 'Same word, once with umlauts and once written out (ae, oe, ue, ss).',
    correspondents:
      'Same name, once with umlauts and once written out (ae, oe, ue, ss).',
  },
  'legal-form': {
    tags: 'Same name, one carries a legal form or an article.',
    correspondents:
      'Same company, one name carries the legal form (GmbH, Ltd., AG …).',
  },
  plural: {
    tags: 'Same word in singular and plural.',
    correspondents: 'Same name in singular and plural.',
  },
  'token-order': {
    tags: 'The same words in a different order.',
    correspondents: 'The same words in a different order.',
  },
  prefix: {
    tags: 'One name is the beginning or the end of the other.',
    correspondents: 'One name is the beginning or the end of the other.',
  },
  fuzzy: {
    tags: 'The spelling differs in a letter or two, which is usually a typo — but not always.',
    correspondents:
      'The spelling differs in a letter or two, which is usually a typo — but not always.',
  },
  semantic: {
    tags: 'Spelled differently, but the model says they name the same thing (a synonym, a translation or an abbreviation).',
    correspondents:
      'Spelled differently, but the model says they name the same organisation.',
  },
});

/** The clause for the strongest reason, or '' when there is none. */
function ruleClause(rules, entityKind) {
  const first = Array.isArray(rules) ? rules[0] : null;
  const entry = first ? RULE_CLAUSES[first] : null;
  if (!entry) return '';
  return entry[entityKind] || entry.tags;
}

/**
 * The model's verdict in a sentence, or '' when the model was not asked.
 *
 * @param {{verdict?: string, reason?: string, confidence?: string, source?: string}|null} verdict
 */
function verdictClause(verdict) {
  if (!verdict || verdict.source === 'spelling-rule') return '';
  const why = String(verdict.reason || '').trim();
  const tail = why ? ` ${why.replace(/\.?$/, '.')}` : '';
  switch (verdict.verdict) {
    case 'same':
      return verdict.confidence === 'high'
        ? `The model read the documents and agrees they are the same.${tail}`
        : `The model read the documents and leans towards the same, but is not certain.${tail}`;
    case 'different':
      return `The model read the documents and thinks they are different.${tail}`;
    case 'unsure':
      return why
        ? `The model could not tell from the documents.${tail}`
        : 'The model could not tell from the documents.';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/* Headlines and reasons per suggestion kind                           */
/* ------------------------------------------------------------------ */

/**
 * "Merge Invoices into invoice" — or, for an unsure pair, a question:
 * "Are Kontoauszug and Kontoumzug the same thing?"
 */
function mergeHeadline({ from, to, certainty }) {
  const sources = listNames((from || []).map((e) => e.name));
  if (certainty === 'unsure' && (from || []).length === 1 && to) {
    return `Are ${from[0].name} and ${to.name} the same thing?`;
  }
  return `Merge ${sources} into ${to ? to.name : '…'}`;
}

/**
 * Why, and what moves: the rule clause, then the verdict, then the count.
 */
function mergeReason({ entityKind, rules, verdict, from, to, modelReason }) {
  const parts = [];
  const clause = ruleClause(rules, entityKind);
  if (clause) parts.push(clause);
  const v = verdictClause(verdict);
  if (v) parts.push(v);
  if (!clause && !v && modelReason) {
    parts.push(String(modelReason).replace(/\.?$/, '.'));
  }
  const moved = (from || []).reduce((n, e) => n + (e.documentCount || 0), 0);
  if (to) {
    parts.push(
      `${documents(moved).replace(/^./, (c) => c.toUpperCase())} move to ${to.name}, which already has ${documents(to.documentCount).replace(/^no documents$/, 'none')}.`
    );
  }
  return parts.join(' ');
}

function splitHeadline({ from, typeName, topicNames }) {
  const name = from && from[0] ? from[0].name : '…';
  const hasType = Boolean(typeName);
  const hasTopics = Array.isArray(topicNames) && topicNames.length > 0;
  if (hasType && hasTopics) {
    return `Split ${name} into a type and ${topicNames.length === 1 ? 'a topic' : 'topics'}`;
  }
  if (hasType) return `Turn ${name} into the document type ${typeName}`;
  if (hasTopics)
    return `Replace ${name} with the ${topicNames.length === 1 ? 'topic' : 'topics'} ${listNames(topicNames)}`;
  return `Split ${name}`;
}

function splitReason({ from, typeName, topicNames, modelReason }) {
  const tag = from && from[0] ? from[0] : { name: '…', documentCount: 0 };
  const parts = [];
  if (typeName && topicNames && topicNames.length) {
    parts.push(
      `The tag says what the document is (${typeName}) and what it is about (${listNames(topicNames)}). After the split you can filter by either on its own.`
    );
  } else if (typeName) {
    parts.push(
      `The tag names a kind of document rather than a topic; as a document type it can be filtered and used in Paperless-ngx workflows.`
    );
  } else if (topicNames && topicNames.length) {
    parts.push(`The tag is another spelling of ${listNames(topicNames)}.`);
  }
  if (modelReason) parts.push(String(modelReason).replace(/\.?$/, '.'));
  parts.push(
    `${documents(tag.documentCount).replace(/^./, (c) => c.toUpperCase())} get the new names; the old tag is deleted once no document carries it.`
  );
  return parts.join(' ');
}

function deleteHeadline({ from, entityKind }) {
  const list = from || [];
  if (list.length === 1)
    return `Delete the ${thing(entityKind)} ${list[0].name}`;
  return `Delete ${list.length} ${thing(entityKind)}s nobody uses`;
}

function deleteReason({ from, entityKind, modelReason }) {
  const list = from || [];
  const parts = [];
  if (modelReason) {
    parts.push(String(modelReason).replace(/\.?$/, '.'));
  } else {
    parts.push(
      list.length === 1
        ? `No document carries this ${thing(entityKind)}.`
        : `No document carries them: ${listNames(list.map((e) => e.name))}.`
    );
  }
  if (entityKind === 'tags') {
    parts.push(
      'Your inbox tag and the tags Zettelrobbe is configured with are never on this list.'
    );
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* The run: steps in sentences                                          */
/* ------------------------------------------------------------------ */

/**
 * The steps a run shows, in order. The run service maps its phases onto
 * these keys; the page draws a tick, a number or an empty circle.
 */
const RUN_STEPS = Object.freeze([
  { key: 'compare', label: 'Compare names by spelling' },
  {
    key: 'evidence',
    label: 'Read document titles for the pairs spelling cannot settle',
  },
  {
    key: 'judge',
    label: 'Ask the model whether each pair means the same thing',
  },
  {
    key: 'split',
    label: 'Ask the model which tags to split into a type and topics',
  },
  { key: 'sort', label: 'Sort everything into suggestions' },
]);

/**
 * The line next to a step, with the numbers that matter.
 *
 * @param {string} key   a RUN_STEPS key
 * @param {{names?:number, sure?:number, open?:number, pairs?:number, requestsDone?:number, requestsPlanned?:number, pairsJudged?:number, model?:string, tags?:number, done?:boolean}} c
 */
function stepDetail(key, c = {}) {
  switch (key) {
    case 'compare':
      return c.done
        ? `${c.names ?? 0} names · ${c.sure ?? 0} sure matches · ${c.open ?? 0} pairs spelling can't settle`
        : `${c.names ?? 0} names`;
    case 'evidence':
      return c.pairs
        ? `${c.pairs} pairs · from Paperless-ngx`
        : 'from Paperless-ngx';
    case 'judge':
      return c.requestsPlanned
        ? `request ${c.requestsDone ?? 0} of ${c.requestsPlanned} · ${c.pairsJudged ?? 0} of ${c.pairs ?? 0} pairs answered`
        : c.model
          ? `with ${c.model}`
          : '';
    case 'split':
      return c.tags ? `${c.tags} tags` : '';
    default:
      return '';
  }
}

/** The headline while a run is going, and when it has ended. */
function runHeadline(status) {
  switch (status) {
    case 'running':
      return 'Looking for suggestions…';
    case 'stopping':
      return 'Stopping…';
    case 'stopped':
      return 'Stopped — what was found so far is below';
    case 'failed':
      return 'The run could not finish';
    default:
      return 'Suggestions';
  }
}

/* ------------------------------------------------------------------ */
/* Failures: what happened, what it means, what to do                  */
/* ------------------------------------------------------------------ */

/**
 * The notice for a failure kind (services/modelFailure.js). Every notice
 * answers the three questions; the technical line travels separately.
 *
 * @param {string} kind   a FAILURE_KINDS value
 * @param {{model?:string, endpoint?:string, pairsAffected?:number, pairsFine?:number, budget?:number, pairsLeft?:number, answerTokens?:number}} c
 * @returns {{title:string, body:string, actions:Array<{key:string,label:string}>, settingsHint:string|null}}
 */
function failureNotice(kind, c = {}) {
  const model = c.model || 'the model';
  switch (kind) {
    case 'unreadable':
      return {
        title: `${model} answered, but not in a form Zettelrobbe could read`,
        body: `This happens when a model writes an explanation instead of the list it was asked for, most often with small local models or when thinking is switched on. Nothing was changed in Paperless-ngx. ${c.pairsAffected ? `The ${c.pairsAffected} pairs from this request are marked "needs a look", so you can decide them yourself` : 'The pairs it was asked about are marked "needs a look"'}${c.pairsFine ? `; the other ${c.pairsFine} pairs were answered fine.` : '.'}`,
        actions: [
          {
            key: 'retry-affected',
            label: c.pairsAffected
              ? `Ask again for those ${c.pairsAffected}`
              : 'Ask again',
          },
          { key: 'decide-myself', label: 'Decide them myself' },
        ],
        settingsHint: 'Switch thinking off for this page',
      };
    case 'budget':
      return {
        title: `Stopped after ${(c.budget || 0).toLocaleString('en-US')} tokens, the limit you set for one run`,
        body: `${c.pairsJudged ?? 0} of ${c.pairs ?? 0} pairs were judged and are below as suggestions. ${c.pairsLeft ? `The remaining ${c.pairsLeft} are marked "needs a look". A second run only asks about those ${c.pairsLeft}; the earlier answers are remembered.` : ''}`.trim(),
        actions: [
          {
            key: 'continue',
            label: c.pairsLeft
              ? `Continue with the ${c.pairsLeft}`
              : 'Run again',
          },
        ],
        settingsHint: 'Raise the limit',
      };
    case 'unreachable':
      return {
        title: `${c.endpoint || model} did not answer`,
        body: `The spelling comparison finished and its sure suggestions are below. The pairs that needed the model are marked "needs a look". Check that the AI provider is running and reachable from the Zettelrobbe container, then run again.`,
        actions: [
          { key: 'retry', label: 'Try again' },
          { key: 'test-connection', label: 'Test the connection' },
        ],
        settingsHint: null,
      };
    case 'thinking':
      return {
        title: `${model} used all ${(c.answerTokens || 0).toLocaleString('en-US')} answer tokens on its reasoning and never reached the verdicts`,
        body: 'Reasoning models write their thoughts before the answer. Zettelrobbe already asks the model not to think on this page; this model ignored that. Two things help: a larger answer length, or a model without reasoning for this job.',
        actions: [
          {
            key: 'retry-larger',
            label: `Try again with ${((c.answerTokens || 1000) * 4).toLocaleString('en-US')} answer tokens`,
          },
        ],
        settingsHint: 'Pick another model for this page',
      };
    case 'paperless':
      return {
        title: 'Paperless-ngx could not be reached',
        body: 'Nothing was compared. Check the Paperless-ngx connection on the settings page, then run again.',
        actions: [{ key: 'retry', label: 'Try again' }],
        settingsHint: 'Paperless-ngx connection',
      };
    default:
      return {
        title: 'The run could not finish',
        body: 'Nothing was changed in Paperless-ngx. The suggestions found before the error are below.',
        actions: [{ key: 'retry', label: 'Try again' }],
        settingsHint: null,
      };
  }
}

module.exports = {
  CERTAINTY_LABELS,
  RULE_CLAUSES,
  RUN_STEPS,
  certaintyLabel,
  documents,
  listNames,
  ruleClause,
  verdictClause,
  mergeHeadline,
  mergeReason,
  splitHeadline,
  splitReason,
  deleteHeadline,
  deleteReason,
  stepDetail,
  runHeadline,
  failureNotice,
};
