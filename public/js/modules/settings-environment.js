/**
 * Settings › Set by the environment.
 *
 * The rows come from the server (views/partials/settings-environment.ejs),
 * one per setting the environment sets. This module adds what only the page
 * knows, and runs the two actions:
 *
 * - each row gets the label its field carries on the page and the title of
 *   the topic the field sits in, read from the field itself (data-anchor is
 *   its id), so the list says what the page says
 * - Take over (one row, or Take over all) asks the server to store the value
 *   in effect; Remove the stored copy undoes it. The answer names the keys,
 *   never a value, and the rows switch to the state it reports. Nothing
 *   restarts and no field unlocks: the environment keeps deciding while its
 *   line is there.
 */

const TAKE_OVER_URL = '/api/settings/environment/take-over';
const REMOVE_COPY_URL = '/api/settings/environment/remove-copy';

const ROW_SELECTOR = '.zr-field, .zr-switchrow, .zr-checktile';
const NOT_LABEL_TEXT =
  '.zr-badge, .zr-sr, button, input, select, textarea, svg';

const norm = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The label a field carries on the settings page: the text of its row's
 * label, without the badges, help buttons and controls in it.
 *
 * @param {Element} field
 * @returns {string}
 */
export function fieldLabel(field) {
  const row = field.closest(ROW_SELECTOR);
  if (!row) return '';
  const label = row.matches('.zr-checktile')
    ? row
    : row.querySelector('label, .zr-field__name');
  if (!label) return '';
  return norm(
    Array.from(label.childNodes)
      .filter(
        (node) =>
          node.nodeType === 3 || !(node.matches && node.matches(NOT_LABEL_TEXT))
      )
      .map((node) => node.textContent)
      .join(' ')
  );
}

/**
 * What a row says about a setting: its label and the topic it sits in.
 *
 * @param {Element} field
 * @returns {{ label: string, topic: string }}
 */
export function describeField(field) {
  const entry = field.closest('.zr-settings-entry');
  return {
    label: fieldLabel(field),
    topic: norm(entry && entry.getAttribute('data-title')),
  };
}

async function postKeys(url, keys) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ keys }),
  });
  // An answer that is not JSON (a proxy's error page) counts as one without
  // a message.
  const body = await response.json().catch(() => null);
  return { ok: response.ok, body: body || {} };
}

export default function settingsEnvironment(root, { toast } = {}) {
  const doc = root.ownerDocument || document;
  const rows = new Map(
    Array.from(root.querySelectorAll('[data-env-row]'), (row) => [
      row.dataset.envRow,
      row,
    ])
  );
  const takeAll = root.querySelector('[data-env-take-all]');
  const listTitle = doc.getElementById('envSettingsTitle');
  const say = (message, tone) => {
    if (message && toast) toast(message, { tone });
  };

  rows.forEach((row) => {
    const field = row.dataset.anchor && doc.getElementById(row.dataset.anchor);
    if (!field) return;
    const { label, topic } = describeField(field);
    const labelEl = row.querySelector('[data-env-label]');
    if (label && labelEl) {
      labelEl.textContent = label;
      labelEl.classList.remove('hidden');
    }
    const topicLink = row.querySelector('[data-env-topic]');
    if (topic && topicLink) topicLink.textContent = topic;
  });

  const takeButton = (row) => row.querySelector('[data-env-take]');
  const removeButton = (row) => row.querySelector('[data-env-remove]');

  /** Shows the row as `state`: 'none' (nothing stored) or 'same'. */
  function setState(row, state) {
    row.dataset.stored = state;
    row.querySelectorAll('[data-env-state]').forEach((line) => {
      line.classList.toggle('hidden', line.dataset.envState !== state);
    });
    takeButton(row)?.classList.toggle('hidden', state === 'same');
    removeButton(row)?.classList.toggle('hidden', state !== 'same');
  }

  function syncTakeAll() {
    if (!takeAll) return;
    takeAll.disabled = !Array.from(rows.values()).some((row) => {
      const button = takeButton(row);
      return button && !button.disabled && !button.classList.contains('hidden');
    });
  }

  function reportRefused(refused) {
    (refused || []).forEach(({ key, reason }) =>
      say(`${key}: ${reason}`, 'warn')
    );
  }

  async function takeOver(keys, trigger) {
    trigger.disabled = true;
    let stored = [];
    try {
      const { ok, body } = await postKeys(TAKE_OVER_URL, keys);
      stored = (body.data && body.data.stored) || [];
      stored.forEach((key) => rows.has(key) && setState(rows.get(key), 'same'));
      if (ok) say(body.message, 'ok');
      else
        say(body.error || 'Zettelrobbe could not store the values.', 'danger');
      reportRefused(ok && body.data ? body.data.refused : []);
    } catch (error) {
      console.error('[settings-environment] take over failed', error);
      say('Zettelrobbe could not store the values.', 'danger');
    } finally {
      trigger.disabled = false;
      syncTakeAll();
    }
    return stored;
  }

  async function removeCopy(key, trigger) {
    trigger.disabled = true;
    try {
      const { ok, body } = await postKeys(REMOVE_COPY_URL, [key]);
      if (ok && rows.has(key)) setState(rows.get(key), 'none');
      if (ok) say(body.message, 'ok');
      else
        say(body.error || 'Zettelrobbe could not remove the copy.', 'danger');
      return ok;
    } catch (error) {
      console.error('[settings-environment] remove failed', error);
      say('Zettelrobbe could not remove the copy.', 'danger');
      return false;
    } finally {
      trigger.disabled = false;
      syncTakeAll();
    }
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button) || button.disabled) return;

    if (button.hasAttribute('data-env-take-all')) {
      await takeOver('all', button);
      // Nothing left to take over: the button is disabled and would drop the
      // focus, so it goes to the list it acted on.
      if (button.disabled && listTitle) listTitle.focus();
      return;
    }

    const takeKey = button.getAttribute('data-env-take');
    if (takeKey) {
      const stored = await takeOver([takeKey], button);
      const row = rows.get(takeKey);
      // The button is hidden now; the one that undoes it takes the focus.
      if (stored.includes(takeKey) && row) removeButton(row)?.focus();
      return;
    }

    const removeKey = button.getAttribute('data-env-remove');
    if (removeKey) {
      const removed = await removeCopy(removeKey, button);
      const row = rows.get(removeKey);
      if (removed && row) takeButton(row)?.focus();
    }
  });

  syncTakeAll();
  return undefined;
}
