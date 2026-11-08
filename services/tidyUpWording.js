'use strict';

/**
 * Every sentence the Tidy up page says, in one place.
 *
 * The page never shows a rule key, a percentage or a phase name; it shows
 * what a person would say. This module turns the machinery's vocabulary
 * (matcher reasons, verdicts, job phases, failure kinds, merge log rows)
 * into those sentences, so the wording can be read, reviewed and changed
 * without touching a service or a template.
 *
 * Pure module. Names are passed through unescaped: the template escapes.
 * Every function copes with missing counts: a sentence never says
 * "undefined", "NaN" or "0 pairs"; it leaves the number out instead.
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

/** A count, or 0 for anything that is not a non-negative number. */
function count(n) {
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** "1,234" */
function number(n) {
  return count(n).toLocaleString('en-US');
}

/** "12 pairs" / "1 pair" — the caller makes sure the count is not 0. */
function plural(n, one, many = `${one}s`) {
  return `${number(n)} ${count(n) === 1 ? one : many}`;
}

/** "12 documents" / "1 document" / "no documents" */
function documents(n) {
  if (count(n) === 0) return 'no documents';
  return plural(n, 'document');
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

/** First letter up, for a clause that starts a sentence. */
function capitalize(text) {
  const value = String(text ?? '');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** One sentence: trimmed, first letter up, exactly one full stop. */
function sentence(text) {
  const value = String(text ?? '')
    .trim()
    .replace(/[.\s]+$/, '');
  return value === '' ? '' : `${capitalize(value)}.`;
}

/** Sentences joined by one space, empty ones left out. */
function joinSentences(parts) {
  return parts.filter((part) => part && String(part).trim() !== '').join(' ');
}

/* ------------------------------------------------------------------ */
/* Why two names are the same: the matcher's reasons in words          */
/* ------------------------------------------------------------------ */

/**
 * One clause per matcher reason (services/entityNameMatcher.js, its tier
 * table), keyed by entity kind where the wording differs. Strongest reason
 * wins; the others are not listed. Legal forms are only ever dropped from
 * correspondents and plurals only ever folded on tags; the other kind's
 * clause exists so a reason never renders as nothing.
 */
const RULE_CLAUSES = Object.freeze({
  'exact-normalized': {
    tags: 'Same word, only the capitalisation or spacing differs.',
    correspondents: 'Same name, only the capitalisation or spacing differs.',
  },
  'umlaut-variant': {
    tags: 'Same word, written once with umlauts or accents and once without (ä as ae, ß as ss, é as e).',
    correspondents:
      'Same name, written once with umlauts or accents and once without (ä as ae, ß as ss, é as e).',
  },
  'legal-form': {
    tags: 'Same name, once with and once without an extra word such as an article.',
    correspondents:
      'Same name, once with and once without the legal form or an article (GmbH, AG, Ltd., The …).',
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
    tags: 'One name is the other with extra words at the start or the end.',
    correspondents:
      'One name is the other with extra words at the start or the end.',
  },
  fuzzy: {
    tags: 'The names are spelled almost alike, which is usually a typo or a variant — but not always.',
    correspondents:
      'The names are spelled almost alike, which is usually a typo or a variant — but not always.',
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
 * A pair whose request failed carries `failureKind`; its reason already is
 * the whole sentence (see unansweredReason()), and the model did not "tell"
 * anything.
 *
 * @param {{verdict?: string, reason?: string, confidence?: string, source?: string, failureKind?: string}|null} verdict
 */
function verdictClause(verdict) {
  if (!verdict || verdict.source === 'spelling-rule') return '';
  if (verdict.failureKind) {
    return sentence(verdict.reason) || unansweredReason(verdict.failureKind);
  }
  const why = sentence(verdict.reason);
  const tail = why ? ` ${why}` : '';
  switch (verdict.verdict) {
    case 'same':
      return verdict.confidence === 'high'
        ? `The model looked at how both are used and says they are the same.${tail}`
        : `The model looked at how both are used and leans towards the same, but is not certain.${tail}`;
    case 'different':
      return `The model looked at how both are used and thinks they are different.${tail}`;
    case 'unsure':
      return `The model could not tell from how they are used.${tail}`;
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
  if (!clause && !v && modelReason) parts.push(sentence(modelReason));
  const moved = (from || []).reduce((n, e) => n + count(e.documentCount), 0);
  if (to) {
    const has = count(to.documentCount) ? documents(to.documentCount) : 'none';
    parts.push(
      `${capitalize(documents(moved))} ${moved === 1 ? 'moves' : 'move'} to ${to.name}, which already has ${has}.`
    );
  }
  return joinSentences(parts);
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
      'The tag names a kind of document rather than a topic; as a document type it can be filtered and used in Paperless-ngx workflows.'
    );
  } else if (topicNames && topicNames.length) {
    parts.push(`The tag is another spelling of ${listNames(topicNames)}.`);
  }
  if (modelReason) parts.push(sentence(modelReason));
  const n = count(tag.documentCount);
  parts.push(
    n === 0
      ? 'No document carries the tag yet, so it is simply replaced.'
      : `${capitalize(documents(n))} ${n === 1 ? 'gets' : 'get'} the new names; the old tag is deleted once no document carries it.`
  );
  return joinSentences(parts);
}

function deleteHeadline({ from, entityKind }) {
  const list = from || [];
  if (list.length === 1)
    return `Delete the ${thing(entityKind)} ${list[0].name}`;
  if (list.length === 0) return `Delete the ${thing(entityKind)}s nobody uses`;
  return `Delete ${list.length} ${thing(entityKind)}s nobody uses`;
}

function deleteReason({ from, entityKind, modelReason }) {
  const list = from || [];
  const parts = [];
  if (modelReason) {
    parts.push(sentence(modelReason));
  } else if (list.length === 1) {
    parts.push(`No document carries this ${thing(entityKind)}.`);
  } else if (list.length > 1) {
    parts.push(
      `No document carries them: ${listNames(list.map((e) => e.name))}.`
    );
  } else {
    parts.push(`No document carries these ${thing(entityKind)}s.`);
  }
  if (entityKind === 'tags') {
    parts.push(
      'Your inbox tag and the tags Zettelrobbe is configured with are never on this list.'
    );
  }
  return joinSentences(parts);
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
 * The line next to a step, with the numbers that matter. A fragment, not a
 * sentence (no full stop); parts whose number is 0 or missing are left out,
 * and a step with nothing to say says ''.
 *
 * @param {string} key   a RUN_STEPS key
 * @param {{names?:number, sure?:number, open?:number, pairs?:number, requestsDone?:number, requestsPlanned?:number, pairsJudged?:number, model?:string, tags?:number, suggestions?:number, done?:boolean}} c
 */
function stepDetail(key, c = {}) {
  const parts = [];
  switch (key) {
    case 'compare':
      if (count(c.names)) parts.push(plural(c.names, 'name'));
      if (c.done) {
        if (count(c.sure))
          parts.push(plural(c.sure, 'sure match', 'sure matches'));
        if (count(c.open)) {
          parts.push(`${plural(c.open, 'pair')} spelling can't settle`);
        }
      }
      break;
    case 'evidence':
      if (count(c.pairs)) parts.push(plural(c.pairs, 'pair'));
      parts.push('from Paperless-ngx');
      break;
    case 'judge':
      if (count(c.requestsPlanned)) {
        parts.push(
          count(c.requestsDone)
            ? `request ${number(Math.min(count(c.requestsDone), count(c.requestsPlanned)))} of ${number(c.requestsPlanned)}`
            : `${plural(c.requestsPlanned, 'request')} planned`
        );
        if (count(c.pairs)) {
          parts.push(
            `${number(c.pairsJudged)} of ${plural(c.pairs, 'pair')} answered`
          );
        }
      } else if (c.model) {
        parts.push(`with ${c.model}`);
      }
      break;
    case 'split':
      if (count(c.tags)) parts.push(plural(c.tags, 'tag'));
      break;
    case 'sort':
      if (count(c.suggestions)) parts.push(plural(c.suggestions, 'suggestion'));
      break;
    default:
      break;
  }
  return parts.join(' · ');
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
 * What a pair (or tag) whose request failed says as its reason, by failure
 * kind (services/modelFailure.js). The judge writes it into the verdict in
 * place of the parser message, which travels in `usage.failures` only.
 */
const UNANSWERED_REASONS = Object.freeze({
  unreadable: "The model's answer could not be read; decide this one yourself.",
  thinking:
    'The model spent its answer on reasoning and gave no verdict; decide this one yourself.',
  unreachable: 'The model could not be reached; decide this one yourself.',
  rejected: 'The AI provider refused the request; decide this one yourself.',
  budget:
    'The token limit for this run was reached before this was asked; decide this one yourself.',
  stopped:
    'The run was stopped before this was asked; decide this one yourself.',
  unknown: 'The model gave no usable answer; decide this one yourself.',
});

/** @param {string} kind  a FAILURE_KINDS value */
function unansweredReason(kind) {
  return UNANSWERED_REASONS[kind] || UNANSWERED_REASONS.unknown;
}

/**
 * What the failed requests were about, as one sentence: the pairs marked
 * "needs a look", the tags left as they are, or both.
 */
function affectedSentence(c) {
  const pairs = count(c.pairsAffected);
  const tags = count(c.tagsAffected);
  const parts = [];
  if (pairs === 1) {
    parts.push(
      'The pair it was asked about is marked "needs a look", so you can decide it yourself.'
    );
  } else if (pairs > 1) {
    parts.push(
      `The ${number(pairs)} pairs it was asked about are marked "needs a look", so you can decide them yourself.`
    );
  }
  if (tags === 1) {
    parts.push('The tag it was asked about stays as it is.');
  } else if (tags > 1) {
    parts.push(`The ${number(tags)} tags it was asked about stay as they are.`);
  }
  if (parts.length === 0) {
    parts.push('What it was asked about is marked "needs a look".');
  }
  if (count(c.pairsFine)) {
    parts.push(
      count(c.pairsFine) === 1
        ? 'The other pair was answered fine.'
        : `The other ${number(c.pairsFine)} pairs were answered fine.`
    );
  }
  return joinSentences(parts);
}

/** "the AI provider refused …" with the status the provider gave. */
function rejectedTitle(who, status) {
  switch (Number(status)) {
    case 401:
    case 403:
      return `${who} did not accept the API key`;
    case 404:
      return `${who} does not know the model`;
    case 429:
      return `${who} says the quota or the rate limit is used up`;
    default:
      return `${who} refused the request`;
  }
}

/**
 * The notice for a failure kind (services/modelFailure.js). Every notice
 * answers the three questions; the technical line travels separately.
 *
 * Titles are headlines (no full stop); every sentence of a body ends with
 * one. Every context key is optional.
 *
 * @param {string} kind   a FAILURE_KINDS value
 * @param {{model?:string, endpoint?:string, provider?:string, status?:number,
 *   pairsAffected?:number, tagsAffected?:number, pairsFine?:number,
 *   budget?:number, pairs?:number, pairsJudged?:number, pairsLeft?:number,
 *   answerTokens?:number, thinkingOn?:boolean, stopReason?:string}} c
 * @returns {{title:string, body:string, actions:Array<{key:string,label:string}>, settingsHint:string|null}}
 */
function failureNotice(kind, c = {}) {
  // Names are never capitalised: a model is called qwen3:8b, not Qwen3:8b.
  const Model = c.model || 'The model';
  switch (kind) {
    case 'unreadable':
      return {
        title: `${Model} answered, but not in a form Zettelrobbe could read`,
        body: joinSentences([
          'This happens when a model writes an explanation instead of the list it was asked for, most often with small local models or with thinking switched on.',
          'Nothing was changed in Paperless-ngx.',
          affectedSentence(c),
        ]),
        actions: [
          {
            key: 'retry-affected',
            label: count(c.pairsAffected)
              ? count(c.pairsAffected) === 1
                ? 'Ask again for that pair'
                : `Ask again for those ${number(c.pairsAffected)}`
              : 'Ask again',
          },
          { key: 'decide-myself', label: 'Decide them myself' },
        ],
        settingsHint: 'Switch thinking off for this page',
      };
    case 'budget': {
      const judged = count(c.pairsJudged);
      const pairs = count(c.pairs);
      const left = count(c.pairsLeft);
      const parts = [];
      if (pairs) {
        parts.push(
          judged
            ? `${number(judged)} of ${plural(pairs, 'pair')} were judged and are below as suggestions.`
            : 'No pair was judged before the limit was reached.'
        );
      } else {
        parts.push('What was found before the limit is below.');
      }
      if (left) {
        parts.push(
          left === 1
            ? 'The remaining pair is marked "needs a look". A second run asks only about that one; the earlier answers are remembered.'
            : `The remaining ${number(left)} are marked "needs a look". A second run asks only about those ${number(left)}; the earlier answers are remembered.`
        );
      }
      return {
        title: count(c.budget)
          ? `Stopped after ${number(c.budget)} tokens, the limit you set for one run`
          : 'Stopped at the token limit you set for one run',
        body: joinSentences(parts),
        actions: [
          {
            key: 'continue',
            label: left ? `Continue with the ${number(left)}` : 'Run again',
          },
        ],
        settingsHint: 'Raise the limit',
      };
    }
    case 'unreachable':
      return {
        title: `${c.endpoint || Model} did not answer`,
        body: joinSentences([
          'The spelling comparison finished and its sure suggestions are below.',
          'What needed the model is marked "needs a look".',
          'Check that the AI provider is running and can be reached from the Zettelrobbe container, then run again.',
        ]),
        actions: [
          { key: 'retry', label: 'Try again' },
          { key: 'test-connection', label: 'Test the connection' },
        ],
        settingsHint: 'AI provider settings',
      };
    case 'rejected': {
      const who = c.provider || c.endpoint || 'The AI provider';
      const check =
        Number(c.status) === 404
          ? `Check the model name${c.model ? ` (${c.model})` : ''} in the AI provider settings, then run again.`
          : Number(c.status) === 429
            ? "Check the account's quota with the provider, or wait a while, then run again."
            : "Check the API key, the model name and the account's quota in the AI provider settings, then run again.";
      return {
        title: rejectedTitle(who, c.status),
        body: joinSentences([
          'Nothing was changed in Paperless-ngx, and the spelling suggestions are below.',
          check,
        ]),
        actions: [{ key: 'retry', label: 'Try again' }],
        settingsHint: 'AI provider settings',
      };
    }
    case 'thinking': {
      const tokens = count(c.answerTokens);
      return {
        title: tokens
          ? `${Model} used all ${number(tokens)} answer tokens on its reasoning and never reached the verdicts`
          : `${Model} spent its whole answer on reasoning and never reached the verdicts`,
        body: joinSentences([
          'Reasoning models write their thoughts before the answer.',
          c.thinkingOn
            ? 'Thinking is switched on for this page, and the answer length was not enough for both.'
            : 'Zettelrobbe asks the model not to think on this page; this model thought anyway.',
          'Two things help: a larger answer length, or a model without reasoning for this job.',
          affectedSentence(c),
        ]),
        actions: [
          {
            key: 'retry-larger',
            label: tokens
              ? `Try again with ${number(tokens * 4)} answer tokens`
              : 'Try again with a larger answer length',
          },
        ],
        settingsHint: 'Pick another model for this page',
      };
    }
    case 'paperless':
      return {
        title: 'Paperless-ngx could not be reached',
        body: 'Nothing was compared. Check the Paperless-ngx connection on the settings page, then run again.',
        actions: [{ key: 'retry', label: 'Try again' }],
        settingsHint: 'Paperless-ngx connection',
      };
    case 'stopped':
      return {
        title:
          c.stopReason === 'idle'
            ? 'Stopped because the page was closed'
            : 'Stopped before the end',
        body: joinSentences([
          c.stopReason === 'idle'
            ? 'Nobody was watching the run, so it stopped rather than spend tokens on its own.'
            : '',
          'What was found until then is below, and nothing was changed in Paperless-ngx.',
        ]),
        actions: [{ key: 'retry', label: 'Run again' }],
        settingsHint: null,
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

/* ------------------------------------------------------------------ */
/* Recent changes: one merge log row in a sentence                      */
/* ------------------------------------------------------------------ */

/**
 * One row of the merge log (EntityMergeLogEntry, models/document.js) as the
 * Recent changes list says it:
 *
 * - merge:  "Merged Invoices into invoice · 12 documents moved"
 * - delete: "Deleted 4 unused tags" / "Deleted the unused tag tmp"
 * - split:  "Split Rechnung Auto into Rechnung + Auto"
 * - rename: "Renamed Telekom to Deutsche Telekom" (a merge row without
 *   sources that renamed its target, or a row with action 'rename')
 *
 * followed by " · undone" or " · undo failed". `segments` is the same
 * sentence in pieces, with `name: true` on the names, so the page can set
 * them in bold without parsing anything.
 *
 * @param {object} entry  an EntityMergeLogEntry
 * @returns {{sentence:string, segments:Array<{text:string, name:boolean}>, status:'done'|'partial'|'failed'|'undone', canUndo:boolean}}
 */
function recentChangeSentence(entry) {
  const row = entry && typeof entry === 'object' ? entry : {};
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const sourceNames = sources
    .map((s) => String(s?.name ?? '').trim())
    .filter(Boolean);
  const noun = thing(row.kind);
  const target = String(row.targetName ?? '').trim();
  const moved = count(row.documentsMoved);
  const segments = [];
  const text = (value) => segments.push({ text: value, name: false });
  const name = (value) => segments.push({ text: value, name: true });
  const names = (list) =>
    list.forEach((value, index) => {
      if (index > 0) text(index === list.length - 1 ? ' and ' : ', ');
      name(value);
    });

  const action =
    row.action === 'merge' && sources.length === 0 && row.targetRenamedFrom
      ? 'rename'
      : row.action || 'merge';

  switch (action) {
    case 'delete':
      if (sourceNames.length === 1) {
        text(`Deleted the unused ${noun} `);
        name(sourceNames[0]);
      } else if (sourceNames.length > 1) {
        text(`Deleted ${sourceNames.length} unused ${noun}s`);
      } else {
        text(`Deleted unused ${noun}s`);
      }
      break;
    case 'split':
      text('Split ');
      name(sourceNames[0] || `a ${noun}`);
      if (target) {
        text(' into ');
        name(target);
      }
      break;
    case 'rename':
      text('Renamed ');
      name(String(row.targetRenamedFrom || sourceNames[0] || `a ${noun}`));
      text(' to ');
      name(target || '…');
      break;
    default:
      text('Merged ');
      if (sourceNames.length > 0) names(sourceNames);
      else text(`a ${noun}`);
      text(' into ');
      name(target || '…');
      if (row.targetRenamedFrom) {
        text(' (formerly ');
        name(String(row.targetRenamedFrom));
        text(')');
      }
      text(` · ${documents(moved)} moved`);
      break;
  }

  const undone = Boolean(row.undoneAt) || row.status === 'undone';
  let status = 'done';
  if (undone) {
    status = 'undone';
    text(' · undone');
  } else if (row.status === 'undo_failed') {
    status = 'failed';
    text(' · undo failed');
  } else if (row.status === 'partial') {
    status = 'partial';
    text(' · partly done');
  }
  return {
    sentence: segments.map((s) => s.text).join(''),
    segments,
    status,
    canUndo: !undone,
  };
}

module.exports = {
  CERTAINTY_LABELS,
  RULE_CLAUSES,
  RUN_STEPS,
  UNANSWERED_REASONS,
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
  unansweredReason,
  recentChangeSentence,
};
