/**
 * Tidy up › the suggestion cards.
 *
 * Pure markup builders: every function takes a suggestion (schemas.js
 * TidyUpSuggestion) plus the page's view state and returns an HTML string.
 * Nothing here fetches or listens; the page (tidy-up.js) owns the state and
 * the clicks, and finds its way back to a card through data-id and
 * data-act.
 *
 * The sentences come from the API (headline, reason, outcome) and are shown
 * as given. Only the names inside them are dressed as <code> chips, by
 * finding the names the suggestion carries in `from`, `to`, `typeName` and
 * `topicNames` — never by parsing the sentence.
 */

import { escapeHtml as esc } from './text-utils.js';

const CERTAINTY_LABELS = {
  sure: 'Sure',
  likely: 'Likely',
  unsure: 'Needs a look',
};
const STATUS_LABELS = {
  declined: 'Declined',
  later: 'Later',
  done: 'Done',
  failed: 'Failed',
};

const icon = (name, extra = '') =>
  `<svg class="zr-icon${extra}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

const plural = (n, one, many) => (Number(n) === 1 ? one : many);
const number = (n) => Number(n || 0).toLocaleString('en-US');
const thing = (entityKind) =>
  entityKind === 'correspondents' ? 'correspondent' : 'tag';

/** Every name a suggestion carries, for the chips. */
export function namesOf(s) {
  const names = [];
  for (const e of s.from || []) names.push(e.name);
  if (s.to) names.push(s.to.name);
  if (s.typeName) names.push(s.typeName);
  for (const t of s.topicNames || []) names.push(t);
  return names.filter((n) => typeof n === 'string' && n.trim() !== '');
}

/**
 * The sentence, escaped, with each of `names` wrapped in a chip where it
 * occurs. Longer names win over the shorter names they contain
 * ("Versicherungen" over "Versicherung"), and a chip is never nested.
 */
export function withChips(sentence, names) {
  const text = String(sentence ?? '');
  const sorted = [...new Set(names)].sort((a, b) => b.length - a.length);
  const taken = new Array(text.length).fill(false);
  const ranges = [];
  for (const name of sorted) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at < 0) break;
      from = at + name.length;
      let free = true;
      for (let i = at; i < at + name.length; i += 1) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let i = at; i < at + name.length; i += 1) taken[i] = true;
      ranges.push([at, at + name.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    out += esc(text.slice(pos, start));
    out += `<code class="tidy-name">${esc(text.slice(start, end))}</code>`;
    pos = end;
  }
  return out + esc(text.slice(pos));
}

function pill(certainty) {
  const c = CERTAINTY_LABELS[certainty] ? certainty : 'unsure';
  return `<span class="tidy-pill tidy-pill--${c}">${esc(CERTAINTY_LABELS[c])}</span>`;
}

function documentsOf(s) {
  const list = [...(s.from || []), ...(s.to ? [s.to] : [])];
  return list.reduce((n, e) => n + (Number(e.documentCount) || 0), 0);
}

function meta(s) {
  const n = documentsOf(s);
  return `${thing(s.entityKind)} · ${number(n)} ${plural(n, 'document', 'documents')}`;
}

/** The Details disclosure: the only place with rule names and a percentage. */
function details(s, open) {
  const d = s.details || {};
  const rules = Array.isArray(d.rules) ? d.rules : [];
  const warnings = Array.isArray(d.warnings) ? d.warnings : [];
  const hasConfidence =
    typeof d.confidence === 'number' && Number.isFinite(d.confidence);
  if (!rules.length && !hasConfidence && !d.verdict && !warnings.length)
    return '';
  const rows = [];
  if (rules.length) {
    rows.push(
      `<dt>Rules</dt><dd>${rules.map((r) => `<code>${esc(r)}</code>`).join(' ')}</dd>`
    );
  }
  if (hasConfidence) {
    rows.push(`<dt>Confidence</dt><dd>${Math.round(d.confidence * 100)}%</dd>`);
  }
  if (warnings.length) {
    rows.push(
      `<dt>Warnings</dt><dd>${warnings.map((w) => `<code>${esc(w)}</code>`).join(' ')}</dd>`
    );
  }
  if (d.source)
    rows.push(`<dt>Found by</dt><dd><code>${esc(d.source)}</code></dd>`);
  if (d.verdict) {
    rows.push(
      `<dt>Model</dt><dd><pre class="tidy-details__verdict">${esc(JSON.stringify(d.verdict, null, 2))}</pre></dd>`
    );
  }
  return `<details class="tidy-details" data-details="${esc(s.id)}"${open ? ' open' : ''}>
    <summary>Details</summary>
    <dl class="tidy-details__list">${rows.join('')}</dl>
  </details>`;
}

function head(s, headlineHtml, metaText) {
  return `<div class="tidy-card__head">
    ${pill(s.certainty)}
    <h3 class="tidy-card__headline">${headlineHtml}</h3>
    <span class="tidy-card__meta zr-sm zr-faint">${esc(metaText)}</span>
  </div>`;
}

function evidenceGrid(s) {
  const sides =
    s.evidence && Array.isArray(s.evidence.sides) ? s.evidence.sides : [];
  if (!sides.length) return '';
  const boxes = sides
    .map((side) => {
      const titles = (side.titles || []).slice(0, 3);
      const neighbours = side.neighbours || [];
      return `<div class="tidy-evidence__side">
        <div class="tidy-evidence__name"><code class="tidy-name">${esc(side.name)}</code>
          <span class="zr-sm zr-faint">${number(side.documentCount)} ${plural(side.documentCount, 'document', 'documents')}</span></div>
        ${titles.length ? `<ul class="tidy-evidence__titles">${titles.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${neighbours.length ? `<div class="zr-sm zr-muted">usually filed with: ${neighbours.map(esc).join(', ')}</div>` : ''}
      </div>`;
    })
    .join('');
  return `<div class="tidy-evidence">${boxes}</div>`;
}

/* --- per kind ------------------------------------------------------------ */

function mergeBody(s, view) {
  const edit = view.edits[s.id] || {};
  const parts = [];
  if (s.certainty === 'unsure') {
    parts.push(evidenceGrid(s));
    parts.push(`<div class="tidy-actions">
      <button type="button" class="zr-btn tidy-btn--outline" data-act="decline">Different, keep both</button>
      <button type="button" class="zr-btn" data-act="accept">Same, merge them</button>
      <button type="button" class="tidy-textbtn" data-act="later">Decide later</button>
    </div>`);
    return parts.join('');
  }
  const members = [...(s.to ? [s.to] : []), ...(s.from || [])];
  const keepId = Number.isInteger(edit.keepId)
    ? edit.keepId
    : s.to
      ? s.to.id
      : null;
  let keep = '';
  if (members.length > 2) {
    keep = `<fieldset class="tidy-keep">
      <legend class="zr-sm zr-muted">The name that stays</legend>
      ${members
        .map(
          (m) => `<label class="tidy-keep__option zr-sm">
          <input type="radio" class="tidy-radio" name="keep-${esc(s.id)}" value="${Number(m.id)}" data-act="keep"${Number(m.id) === keepId ? ' checked' : ''}>
          <code class="tidy-name">${esc(m.name)}</code></label>`
        )
        .join('')}
    </fieldset>`;
  } else if (members.length === 2 && s.to) {
    const other = keepId === s.to.id ? s.from[0] : s.to;
    keep = `<button type="button" class="tidy-textbtn" data-act="swap" data-keep="${Number(other.id)}">Keep ${esc(other.name)} instead</button>`;
  }
  const swapped =
    s.to && keepId !== s.to.id
      ? `<p class="zr-sm tidy-note">${icon('i-check', ' zr-icon--sm')} <code class="tidy-name">${esc(
          (members.find((m) => Number(m.id) === keepId) || {}).name || ''
        )}</code> stays instead; the other names move to it.</p>`
      : '';
  parts.push(swapped);
  parts.push(`<div class="tidy-actions">
    <button type="button" class="zr-btn zr-btn--primary" data-act="accept">Accept</button>
    <button type="button" class="zr-btn" data-act="decline">Not the same</button>
    ${members.length > 2 ? '' : keep}
  </div>`);
  if (members.length > 2) parts.splice(0, 0, keep);
  return parts.join('');
}

function splitBody(s, view) {
  const edit = view.edits[s.id] || {};
  const typeName =
    edit.typeName !== undefined ? edit.typeName : s.typeName || '';
  const topics =
    edit.topicNames !== undefined ? edit.topicNames : s.topicNames || [];
  const vocab = view.vocabulary;
  const existing = new Set((view.documentTypes || []).map((t) => t.name));
  const names = [];
  for (const t of vocab ? vocab.types : []) names.push(t.name);
  for (const t of view.documentTypes || [])
    if (!names.includes(t.name)) names.push(t.name);
  if (typeName && !names.includes(typeName)) names.unshift(typeName);
  const options = [
    `<option value=""${typeName ? '' : ' selected'}>No document type</option>`,
    ...names.map(
      (n) =>
        `<option value="${esc(n)}"${n === typeName ? ' selected' : ''}>${esc(n)}${existing.has(n) ? ' (exists in Paperless-ngx)' : ''}</option>`
    ),
  ].join('');
  const examples = (vocab ? vocab.types : []).slice(0, 3).map((t) => t.name);
  const splitCount = view.splitCount;
  return `<div class="tidy-split">
      <label class="tidy-split__field">
        <span class="zr-sm zr-muted">Document type</span>
        <select class="zr-select" data-act="type" aria-label="Document type for ${esc(s.from[0]?.name || '')}">${options}</select>
      </label>
      <label class="tidy-split__field">
        <span class="zr-sm zr-muted">Topic tags</span>
        <input type="text" class="zr-input" data-act="topics" value="${esc(topics.join(', '))}" placeholder="Comma separated" aria-label="Topic tags for ${esc(s.from[0]?.name || '')}">
      </label>
    </div>
    <p class="zr-sm zr-muted tidy-split__note">Type names come from a short list the model proposed for your archive${
      examples.length ? ` (${examples.map(esc).join(', ')}…)` : ''
    }. <button type="button" class="tidy-textbtn" data-act="edit-list">Edit the list</button> · the same words are used for all ${number(splitCount)} split ${plural(splitCount, 'suggestion', 'suggestions')}.</p>
    <div class="tidy-actions">
      <button type="button" class="zr-btn zr-btn--primary" data-act="accept">Accept</button>
      <button type="button" class="zr-btn" data-act="decline">Keep the tag as it is</button>
    </div>`;
}

function singleDeleteBody() {
  return `<div class="tidy-actions">
    <button type="button" class="zr-btn zr-btn--primary" data-act="accept">Delete</button>
    <button type="button" class="zr-btn" data-act="decline">Keep it</button>
  </div>`;
}

/** One open suggestion as a full card. */
export function cardHtml(s, view) {
  const body =
    s.kind === 'merge'
      ? mergeBody(s, view)
      : s.kind === 'split'
        ? splitBody(s, view)
        : singleDeleteBody();
  const metaText = s.kind === 'delete' ? thing(s.entityKind) : meta(s);
  return `<article class="tidy-card tidy-card--${esc(s.certainty)}" data-id="${esc(s.id)}" data-kind="${esc(
    s.kind
  )}" data-certainty="${esc(s.certainty)}" data-status="open">
    ${head(s, withChips(s.headline, namesOf(s)), metaText)}
    <p class="tidy-card__reason">${withChips(s.reason, namesOf(s))}</p>
    ${body}
    ${details(s, view.openDetails.has(s.id))}
  </article>`;
}

/**
 * Several single-name delete suggestions of one kind, as the one card
 * "Delete 4 tags nobody uses". Each stays its own suggestion; the buttons
 * send all of their ids, or the ticked ones.
 */
export function deleteGroupHtml(entityKind, list, view) {
  const key = `delete-group:${entityKind}`;
  const word = thing(entityKind);
  const picking = view.picking.has(key);
  const ticked = view.ticked;
  const names = list.map((s) => s.from[0]?.name).filter(Boolean);
  const chips = names
    .map((n) => `<code class="tidy-name">${esc(n)}</code>`)
    .join(', ');
  const certainty = list.every((s) => s.certainty === 'sure')
    ? 'sure'
    : list[0].certainty;
  const tickedCount = list.filter((s) => ticked.has(s.id)).length;
  const picker = picking
    ? `<fieldset class="tidy-pick">
        <legend class="zr-sr">Which ${word}s to delete</legend>
        ${list
          .map(
            (s) => `<label class="tidy-pick__option zr-sm">
            <input type="checkbox" class="zr-check" data-act="tick" value="${esc(s.id)}"${ticked.has(s.id) ? ' checked' : ''}>
            <code class="tidy-name">${esc(s.from[0]?.name || '')}</code></label>`
          )
          .join('')}
      </fieldset>`
    : '';
  const buttons = picking
    ? `<button type="button" class="zr-btn zr-btn--primary" data-act="delete-ticked"${tickedCount ? '' : ' disabled'}>Delete ${number(tickedCount)} ticked</button>
       <button type="button" class="tidy-textbtn" data-act="pick-cancel">Back</button>`
    : `<button type="button" class="zr-btn zr-btn--primary" data-act="delete-all">Delete all ${number(list.length)}</button>
       <button type="button" class="zr-btn" data-act="pick">Pick which</button>`;
  return `<article class="tidy-card tidy-card--${esc(certainty)}" data-group="${esc(key)}" data-ids="${esc(
    list.map((s) => s.id).join(' ')
  )}" data-kind="delete" data-certainty="${esc(certainty)}" data-status="open">
    <div class="tidy-card__head">
      ${pill(certainty)}
      <h3 class="tidy-card__headline">Delete ${number(list.length)} ${word}s nobody uses</h3>
      <span class="tidy-card__meta zr-sm zr-faint">${word}s</span>
    </div>
    <p class="tidy-card__reason">No document carries them: ${chips}.${
      entityKind === 'tags'
        ? ' Your inbox tag and the tags Zettelrobbe is configured with are never on this list.'
        : ''
    }</p>
    ${picker}
    <div class="tidy-actions">${buttons}</div>
  </article>`;
}

/** A decided suggestion as one line: done with Undo, failed with Retry. */
export function lineHtml(s) {
  const names = namesOf(s);
  const status = s.status;
  const mark =
    status === 'done'
      ? icon('i-check-circle', ' tidy-line__mark')
      : status === 'failed'
        ? icon('i-alert-circle', ' tidy-line__mark')
        : icon('i-minus', ' tidy-line__mark');
  const outcome = s.outcome
    ? ` <span class="tidy-line__outcome">· ${esc(s.outcome)}</span>`
    : '';
  let action = '';
  if (status === 'done' && (s.undoId || s.batchId)) {
    action = `<button type="button" class="zr-btn" data-act="undo">${icon('i-undo', ' zr-icon--sm')} Undo</button>`;
  } else if (status === 'failed') {
    action = `<button type="button" class="zr-btn" data-act="retry">${icon('i-refresh', ' zr-icon--sm')} Retry</button>`;
  } else if (status === 'declined' || status === 'later') {
    action = `<span class="zr-sm zr-faint">${esc(STATUS_LABELS[status])}</span>`;
  }
  return `<div class="tidy-line tidy-line--${esc(status)}" data-id="${esc(s.id)}" data-kind="${esc(
    s.kind
  )}" data-certainty="${esc(s.certainty)}" data-status="${esc(status)}">
    ${mark}
    <span class="tidy-line__text">${withChips(s.headline, names)}${outcome}</span>
    ${action}
  </div>`;
}

/* --- the counts, in sentences --------------------------------------------- */

/** The top card of the result: "14 suggestions" and what they are. */
export function summaryHtml(summary, run) {
  const open = Number(summary?.open) || 0;
  const sure = Number(summary?.sure) || 0;
  const likely = Number(summary?.likely) || 0;
  const unsure = Number(summary?.unsure) || 0;
  const sentences = [];
  if (open === 0) {
    sentences.push(
      Number(summary?.total)
        ? 'Everything is decided.'
        : 'Nothing to tidy up: every name looks fine.'
    );
  } else {
    if (sure)
      sentences.push(`${number(sure)} ${plural(sure, 'is', 'are')} sure.`);
    if (likely)
      sentences.push(
        `${number(likely)} ${plural(likely, 'is', 'are')} likely.`
      );
    if (unsure)
      sentences.push(
        `${number(unsure)} ${plural(unsure, 'needs', 'need')} a look from you.`
      );
    sentences.push('Nothing is changed until you accept.');
  }
  const stopped =
    run && run.status === 'stopped' && run.headline
      ? `<p class="zr-sm zr-muted">${esc(run.headline)}</p>`
      : '';
  return `<div class="zr-module__body tidy-summary__body">
    <div class="tidy-summary__text">
      ${stopped}
      <h2 class="tidy-title">${number(open)} ${plural(open, 'suggestion', 'suggestions')}</h2>
      <p class="zr-muted">${esc(sentences.join(' '))}</p>
    </div>
    <div class="tidy-actions">
      ${sure ? `<button type="button" class="zr-btn zr-btn--primary" data-act="accept-sure">Accept the ${number(sure)} sure ${plural(sure, 'one', 'ones')}</button>` : ''}
      <button type="button" class="zr-btn" data-act="run-again">${icon('i-refresh', ' zr-icon--sm')} Run again</button>
    </div>
  </div>`;
}

const FILTERS = [
  { key: 'all', label: 'All', count: (s) => s.open },
  { key: 'unsure', label: 'Needs a look', count: (s) => s.unsure },
  { key: 'merge', label: 'Merge', count: (s) => s.merge },
  { key: 'split', label: 'Split', count: (s) => s.split },
  { key: 'delete', label: 'Delete', count: (s) => s.delete },
];

/** The filter chips; a kind with nothing open is left out. */
export function filtersHtml(summary, filter, earlierCount, showEarlier) {
  const s = summary || {};
  const chips = FILTERS.filter(
    (f) => f.key === 'all' || f.key === filter || Number(f.count(s)) > 0
  )
    .map(
      (f) =>
        `<button type="button" class="tidy-chip" data-filter="${f.key}" aria-pressed="${f.key === filter ? 'true' : 'false'}">${esc(
          f.label
        )} · ${number(f.count(s))}</button>`
    )
    .join('');
  const earlier = earlierCount
    ? `<button type="button" class="tidy-textbtn tidy-filters__earlier" data-act="toggle-earlier" aria-pressed="${
        showEarlier ? 'true' : 'false'
      }">Decided earlier · ${number(earlierCount)}</button>`
    : '';
  return `<div class="tidy-chips" role="group" aria-label="Show">${chips}</div>${earlier}`;
}

/** Whether a suggestion passes the chosen chip. */
export function passes(s, filter) {
  if (filter === 'all') return true;
  if (filter === 'unsure') return s.certainty === 'unsure';
  return s.kind === filter;
}
