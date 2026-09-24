/**
 * The assistant of a review page: the zone at the top that says what the
 * page does before a run, what happens during one, and how the tools under
 * it are used after. Pure markup helpers over the guide of the page
 * (review-guide.js); the page owns the state and calls them.
 *
 * The workspace under the assistant is the whole toolset of the page. It is
 * drawn from the first second and waits, dimmed, until a result exists:
 * `setWorkspaceWaiting` is the one switch for that.
 */

import { escapeHtml as esc } from '/js/modules/text-utils.js';

const ICON_DONE =
  '<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-check"/></svg>';

/**
 * The state of every step of a run, from the phase the run is in. A phase
 * before the first step leaves every step ahead; a phase after the last
 * (applying) leaves every step done.
 *
 * @param {{key:string,label:string,sub?:string}[]} steps  the steps a run has, in order
 * @param {string} phase  the phase the run is in
 * @returns {{key:string,label:string,sub:string,state:'done'|'now'|'next'}[]}
 */
export function stepStates(steps, phase) {
  const list = Array.isArray(steps) ? steps : [];
  const at = list.findIndex((step) => step.key === phase);
  const past = at < 0 && phase === 'applying';
  return list.map((step, index) => {
    let state = 'next';
    if (past || index < at) state = 'done';
    else if (index === at) state = 'now';
    return {
      key: step.key,
      label: step.label,
      sub: step.sub == null ? '' : String(step.sub),
      state,
    };
  });
}

/**
 * The strip of steps: done ones ticked, the current one numbered, the ones
 * ahead empty.
 *
 * @param {ReturnType<typeof stepStates>} states
 * @returns {string} markup
 */
export function htmlSteps(states) {
  const list = Array.isArray(states) ? states : [];
  if (list.length === 0) return '';
  const htmlItems = list
    .map((step, index) => {
      const mark =
        step.state === 'done'
          ? ICON_DONE
          : step.state === 'now'
            ? esc(String(index + 1))
            : '';
      const htmlSub =
        step.sub === ''
          ? ''
          : `<span class="zr-steps__sub">· ${esc(step.sub)}</span>`;
      return `<li class="zr-steps__step zr-steps__step--${esc(step.state)}"><span class="zr-steps__mark">${mark}</span>${esc(step.label)}${htmlSub}</li>`;
    })
    .join('');
  return `<ol class="zr-steps">${htmlItems}</ol>`;
}

/**
 * The sentence under the headline of a running assistant: what happens now,
 * then why. Either part may be empty.
 *
 * @param {{what?:string, why?:string}|null} phase  an entry of guide.phases
 * @param {string} [tail]  a fact the page adds, say "7 of 11 pairs so far were the same."
 * @returns {string} markup, '' when there is nothing to say
 */
export function htmlSentence(phase, tail = '') {
  const parts = [phase?.what, phase?.why, tail]
    .map((part) => String(part == null ? '' : part).trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return '';
  return `<p class="zr-runmeter__sentence">${esc(parts.join(' '))}</p>`;
}

/**
 * The assistant before a run: icon, the sentence of the page as its title,
 * one line of what a run does, the button, and a facts line the page fills.
 *
 * @param {object} options
 * @param {string} options.icon      an icon name of icons.svg, say "i-wand"
 * @param {string} options.title
 * @param {string} options.what
 * @param {string} options.htmlButton  the page's button, markup
 * @param {string} [options.factsId]   id of the facts line, for the page to fill
 * @param {string} [options.facts]     its text, '' hides it
 * @returns {string} markup
 */
export function htmlAssistStart(options) {
  const facts = String(options.facts == null ? '' : options.facts);
  const htmlFactsId = options.factsId
    ? ` id="${esc(String(options.factsId))}"`
    : '';
  const htmlFacts = `<p class="zr-assist__facts${facts === '' ? ' hidden' : ''}"${htmlFactsId}>${esc(facts)}</p>`;
  return `<div class="zr-assist zr-assist--start">
    <span class="zr-assist__icon"><svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#${esc(String(options.icon))}"/></svg></span>
    <div class="zr-assist__text">
      <h2 class="zr-assist__title">${esc(String(options.title))}</h2>
      <p class="zr-assist__line">${esc(String(options.what))}</p>
      ${htmlFacts}
    </div>
    ${options.htmlButton}
  </div>`;
}

/**
 * The assistant after a run: the headline of numbers, what the run cost,
 * the lines that say how the tools below are used, and the buttons.
 *
 * @param {object} options
 * @param {string} options.headline    "54 scanned · 13 merges proposed · 4 unsure"
 * @param {string} [options.htmlCost]  the cost line, markup (mini bar and text)
 * @param {string[]} [options.next]    guide.done.next
 * @param {string} [options.htmlActions]  the buttons, markup
 * @returns {string} markup
 */
export function htmlAssistDone(options) {
  const next = Array.isArray(options.next) ? options.next : [];
  const htmlNext =
    next.length === 0
      ? ''
      : `<ul class="zr-assist__next">${next.map((line) => `<li>${esc(String(line))}</li>`).join('')}</ul>`;
  const htmlCost = options.htmlCost
    ? `<p class="zr-assist__cost">${options.htmlCost}</p>`
    : '';
  return `<div class="zr-assist zr-assist--done">
    <span class="zr-assist__icon"><svg class="zr-icon" aria-hidden="true"><use href="/icons.svg#i-check"/></svg></span>
    <div class="zr-assist__text">
      <p class="zr-assist__headline">${esc(String(options.headline))}</p>
      ${htmlCost}
      ${htmlNext}
    </div>
    <div class="zr-assist__actions">${options.htmlActions || ''}</div>
  </div>`;
}

/** The one line under the head of a tool, from guide.sections. */
export function htmlCaption(text) {
  const line = String(text == null ? '' : text).trim();
  return line === '' ? '' : `<p class="zr-module__caption">${esc(line)}</p>`;
}

/**
 * Dims the workspace under the assistant while no result exists, with one
 * line that says so, and wakes it up again.
 *
 * @param {Element|null} root   the page root; the assistant is its first child
 * @param {boolean} waiting
 * @param {string} [note]  the line, default "The tools below wake up with the result."
 */
export function setWorkspaceWaiting(
  root,
  waiting,
  note = 'The tools below wake up with the result.'
) {
  if (!root) return;
  root.classList.toggle('zr-workspace--waiting', waiting === true);
  let line = root.querySelector(':scope > .zr-workspace__note');
  if (waiting !== true) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('p');
    line.className = 'zr-workspace__note';
    const assist = root.querySelector(
      ':scope > .zr-assist, :scope > [data-assist]'
    );
    if (assist && assist.nextSibling)
      root.insertBefore(line, assist.nextSibling);
    else root.prepend(line);
  }
  line.innerHTML = `<svg class="zr-icon zr-icon--sm" aria-hidden="true"><use href="/icons.svg#i-clock"/></svg><span>${esc(note)}</span>`;
}
