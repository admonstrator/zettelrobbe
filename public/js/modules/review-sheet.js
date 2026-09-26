/**
 * The sheet a model-backed run opens before it starts.
 *
 * Both Duplicates and Simplify tags ask the same question before they spend
 * tokens, so the sheet is one module: a line of facts, one big number with
 * the time beside it, a bar that is the run's token limit with the estimate
 * as its fill, a picture of the requests side by side, the switches that
 * move the numbers, and one fact line. The dialog around it is the kernel's;
 * a page fills it with htmlSheet(), keeps it alive with updateSheet() when a
 * lever changes, and listens through bindSheet(). The switches are the
 * framework's .zr-toggle, so a lever is a checkbox and fires change.
 *
 * Pure where it can be. Nothing here fetches an estimate: the page owns the
 * numbers and hands them in as a model.
 *
 * @typedef {object} SheetSwitch
 * @property {string} id       what the page knows the lever as
 * @property {string} label    "Excerpts · 31 reads"
 * @property {string} price    "+12k", "−3 requests · −14k", or ''
 * @property {boolean} on
 *
 * @typedef {object} SheetModel
 * @property {string} sub                          the facts under the title, or ''
 * @property {number} requests
 * @property {{prompt:number, completion:number, thinking:number}} tokens
 * @property {number} limit                        the run's token ceiling; 0 for none
 * @property {number} seconds                      at the lanes given
 * @property {number} lanes
 * @property {number[]} [laneChoices]
 * @property {SheetSwitch[]} switches
 * @property {'run'|'model'|'guess'} basis
 * @property {string} [fact]                       defaults to "Nothing is written."
 */

import { escapeHtml as esc } from '/js/modules/text-utils.js';

/** The choices every page offers for requests in flight at once. */
export const LANE_CHOICES = [1, 3, 5, 8];

const FACT_DEFAULT = 'Nothing is written.';

const BASIS_TEXT = {
  run: 'Measured · last run',
  model: 'Measured · this model',
  guess: 'Estimate · not measured yet',
};

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/**
 * A token count the way the sheet says it: whole below a thousand, one
 * decimal below ten thousand, whole thousands above, millions past that.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
  const tokens = Math.max(0, Math.round(num(value)));
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) {
    const text = (tokens / 1000).toFixed(1);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}k`;
  }
  if (tokens < 1000000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1000000).toFixed(1)} M`;
}

/**
 * A length of time a person can feel. Half minutes only where they matter,
 * between one and three; above that whole minutes, above ninety hours.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function roughTime(seconds) {
  const total = Math.max(0, num(seconds));
  if (total < 45) return 'under a minute';
  const minutes = total / 60;
  if (minutes < 3) {
    const half = Math.max(1, Math.round(minutes * 2) / 2);
    return `~${half} min`;
  }
  if (minutes < 90) return `~${Math.round(minutes)} min`;
  return `~${Math.round(minutes / 6) / 10} h`;
}

/**
 * How the requests fall into lanes: the fullest rows first, so 12 on 8 lanes
 * reads 2, 2, 2, 2, 1, 1, 1, 1 and never a row of zero.
 *
 * @param {number} requests
 * @param {number} lanes
 * @returns {number[]} blocks per row, one row per lane in use
 */
export function laneRows(requests, lanes) {
  const total = Math.max(0, Math.round(num(requests)));
  const inFlight = Math.max(1, Math.round(num(lanes)) || 1);
  if (total === 0) return [];
  const rows = Math.min(inFlight, total);
  const base = Math.floor(total / rows);
  const extra = total % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The three widths of the bar as percentages of the limit. Without a limit
 * the estimate fills the track. Rounded once, so a bar never shows 101%.
 *
 * @param {{prompt:number, completion:number, thinking:number}} tokens
 * @param {number} limit
 * @returns {{prompt:number, answer:number, thinking:number, total:number}}
 */
export function shares(tokens, limit) {
  const prompt = Math.max(0, num(tokens && tokens.prompt));
  const answer = Math.max(0, num(tokens && tokens.completion));
  const thinking = Math.max(0, num(tokens && tokens.thinking));
  const total = prompt + answer + thinking;
  const scale = num(limit) > 0 ? Math.max(num(limit), total) : total;
  const pct = (value) =>
    scale <= 0 ? 0 : Math.min(100, Math.round((value / scale) * 1000) / 10);
  return {
    prompt: pct(prompt),
    answer: pct(answer),
    thinking: pct(thinking),
    total,
  };
}

/** The legend under the bar; a part that cost nothing is left out. */
function htmlLegend(tokens) {
  const keys = [
    { part: 'prompt', value: tokens.prompt, word: 'question' },
    { part: 'answer', value: tokens.completion, word: 'answer' },
    { part: 'thinking', value: tokens.thinking, word: 'thinking' },
  ];
  return keys
    .filter((key) => num(key.value) > 0)
    .map(
      (key) =>
        `<span class="zr-tokenbar__key"><span class="zr-tokenbar__dot zr-tokenbar__dot--${esc(key.part)}"></span>${esc(`${formatTokens(key.value)} ${key.word}`)}</span>`
    )
    .join('');
}

/** The lane picture: one row per lane, one block per request in it. */
function htmlRows(requests, lanes) {
  const rows = laneRows(requests, lanes);
  const scale = Math.max(1, ...rows, Math.round(num(requests)));
  return rows
    .map((blocks) => {
      const htmlBlocks = '<span class="zr-lanes__block"></span>'.repeat(blocks);
      const width = Math.round((blocks / scale) * 1000) / 10;
      return `<div class="zr-lanes__row" style="width: ${num(width)}%">${htmlBlocks}</div>`;
    })
    .join('');
}

function htmlLaneButtons(choices, lanes) {
  return choices
    .map((choice) => {
      const htmlSelected = num(choice) === num(lanes) ? 'true' : 'false';
      return `<button type="button" data-lanes="${num(choice)}" aria-selected="${htmlSelected}">${num(choice)}</button>`;
    })
    .join('');
}

function htmlSwitches(switches) {
  return (switches || [])
    .map((lever) => {
      const htmlChecked = lever.on === true ? ' checked' : '';
      const price = lever.price ? String(lever.price) : '';
      const htmlPrice =
        price === ''
          ? ''
          : `<span class="zr-sheet__leverprice">${esc(price)}</span>`;
      return `<label class="zr-sheet__lever"><span class="zr-sheet__leverlabel">${esc(lever.label)}</span>${htmlPrice}<input type="checkbox" class="zr-toggle" data-switch="${esc(lever.id)}"${htmlChecked}></label>`;
    })
    .join('');
}

function timeSub(lanes) {
  const inFlight = Math.max(1, num(lanes) || 1);
  return `${inFlight} at a time`;
}

function limitText(limit) {
  return num(limit) > 0 ? `${formatTokens(limit)} limit` : '';
}

/**
 * The whole body of the sheet. The title is the dialog's own.
 *
 * @param {SheetModel} model
 * @returns {string} markup
 */
export function htmlSheet(model) {
  const tokens = model.tokens || {};
  const split = shares(tokens, model.limit);
  const choices = model.laneChoices || LANE_CHOICES;
  const sub = model.sub ? String(model.sub) : '';
  const htmlSub =
    sub === ''
      ? ''
      : `<p class="zr-sheet__sub" data-sheet="sub">${esc(sub)}</p>`;
  const htmlLimitClass = num(model.limit) > 0 ? ' zr-tokenbar--limit' : '';
  const fact = model.fact ? String(model.fact) : FACT_DEFAULT;
  return `<div class="zr-sheet">
      ${htmlSub}
      <div class="zr-sheet__numbers">
        <span class="zr-sheet__big"><span class="zr-sheet__value" data-sheet="total">${esc(formatTokens(split.total))}</span><span class="zr-sheet__unit">tokens</span></span>
        <span class="zr-sheet__time"><span class="zr-sheet__value" data-sheet="time">${esc(roughTime(model.seconds))}</span><span class="zr-sheet__timesub" data-sheet="timesub">${esc(timeSub(model.lanes))}</span></span>
      </div>
      <div class="zr-tokenbar${htmlLimitClass}">
        <div class="zr-tokenbar__track">
          <span class="zr-tokenbar__seg zr-tokenbar__seg--prompt" data-sheet="seg-prompt" style="width: ${num(split.prompt)}%"></span>
          <span class="zr-tokenbar__seg zr-tokenbar__seg--answer" data-sheet="seg-answer" style="width: ${num(split.answer)}%"></span>
          <span class="zr-tokenbar__seg zr-tokenbar__seg--thinking" data-sheet="seg-thinking" style="width: ${num(split.thinking)}%"></span>
        </div>
        <div class="zr-tokenbar__foot">
          <div class="zr-tokenbar__legend" data-sheet="legend">${htmlLegend(tokens)}</div>
          <span class="zr-tokenbar__limit" data-sheet="limit">${esc(limitText(model.limit))}</span>
        </div>
      </div>
      <div class="zr-lanes">
        <div class="zr-lanes__head">
          <span class="zr-label">Requests at a time</span>
          <div class="zr-segment" role="group" aria-label="Requests at a time" data-sheet="lanes">${htmlLaneButtons(choices, model.lanes)}</div>
        </div>
        <div class="zr-lanes__rows" data-sheet="rows">${htmlRows(model.requests, model.lanes)}</div>
      </div>
      <div class="zr-sheet__levers" data-sheet="switches">${htmlSwitches(model.switches)}</div>
      <p class="zr-sheet__fact">
        <svg class="zr-icon zr-icon--sm zr-sheet__check" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>
        <span>${esc(fact)}</span>
        <span class="zr-sheet__basis" data-sheet="basis">${esc(BASIS_TEXT[model.basis] || BASIS_TEXT.guess)}</span>
      </p>
    </div>`;
}

/**
 * Moves the live parts of a rendered sheet to a new model without rebuilding
 * it, so the widths animate instead of jumping.
 *
 * @param {Element} root anything that contains the .zr-sheet
 * @param {SheetModel} model
 */
export function updateSheet(root, model) {
  if (!root) return;
  const at = (name) => root.querySelector(`[data-sheet="${name}"]`);
  const setText = (name, text) => {
    const node = at(name);
    if (node) node.textContent = text;
  };
  const tokens = model.tokens || {};
  const split = shares(tokens, model.limit);
  setText('sub', model.sub ? String(model.sub) : '');
  setText('total', formatTokens(split.total));
  setText('time', roughTime(model.seconds));
  setText('timesub', timeSub(model.lanes));
  setText('limit', limitText(model.limit));
  setText('basis', BASIS_TEXT[model.basis] || BASIS_TEXT.guess);
  const segs = {
    'seg-prompt': split.prompt,
    'seg-answer': split.answer,
    'seg-thinking': split.thinking,
  };
  for (const [name, width] of Object.entries(segs)) {
    const node = at(name);
    if (node) node.style.width = `${width}%`;
  }
  const legend = at('legend');
  if (legend) legend.innerHTML = htmlLegend(tokens);
  const rows = at('rows');
  if (rows) rows.innerHTML = htmlRows(model.requests, model.lanes);
  const lanes = at('lanes');
  if (lanes) {
    for (const button of lanes.querySelectorAll('[data-lanes]')) {
      button.setAttribute(
        'aria-selected',
        num(button.dataset.lanes) === num(model.lanes) ? 'true' : 'false'
      );
    }
  }
  // A lever's label and price follow the estimate too, so the levers are
  // drawn again rather than patched; a toggle keeps no state of its own.
  const switches = at('switches');
  if (switches) switches.innerHTML = htmlSwitches(model.switches);
}

/**
 * One delegated listener for the lanes and the switches. Delegated, so a
 * page that redraws the body keeps it.
 *
 * @param {Element} root the dialog, or anything above the sheet
 * @param {{onLanes?: function(number):void, onSwitch?: function(string, boolean):void}} handlers
 * @returns {function():void} removes the listener
 */
export function bindSheet(root, handlers) {
  const onClick = (event) => {
    const lanes = event.target.closest('[data-lanes]');
    if (!lanes || !root.contains(lanes)) return;
    event.preventDefault();
    if (handlers.onLanes) handlers.onLanes(num(lanes.dataset.lanes));
  };
  const onChange = (event) => {
    const lever = event.target.closest('[data-switch]');
    if (!lever || !root.contains(lever)) return;
    if (handlers.onSwitch)
      handlers.onSwitch(lever.dataset.switch, lever.checked === true);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
  };
}
