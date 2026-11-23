// @ts-check
'use strict';

/**
 * What the environment decides: the settings topic "Set by the environment"
 * and its "Take over" action.
 *
 * Zettelrobbe takes a setting from its stored settings (data/runtime-overrides.json,
 * in legacy mode data/.env as well) or from the environment the process started
 * with, usually the lines under `environment:` in docker-compose. A key present in
 * that environment wins whatever is stored (config/config.js), and its field on
 * the settings page is locked. This module says which keys that are, one row
 * each, and what a person can do about them:
 *
 *   settings  every catalogue setting the environment sets: the value in effect
 *             (never for a secret), whether a copy is stored and whether that
 *             copy equals the value in effect, and whether "Take over" can store
 *             one (a field on the page keeps it, the value passes the field's
 *             own check, and it is not a blocked change)
 *   unused    removed settings (settingsCatalog.REMOVED_SETTINGS) that are still
 *             set, in the environment or in the stored settings
 *   blocked   values Zettelrobbe would have changed and could not, because the
 *             environment sets them (BLOCKED_CHANGES)
 *
 * Taking over changes nothing about which side wins: the copy is stored next to
 * the environment's value and applies once the line is gone and the process has
 * started again. setupService keeps such copies across every save
 * (environmentCopies).
 *
 * buildEnvironmentOverview(), planTakeOver() and planRemoveCopy() are pure
 * functions of their inputs; readEnvironmentInputs() gathers the inputs for the
 * routes and the startup line.
 */

const {
  isOldFormOcrTimeout,
  OLD_FORM_OCR_TIMEOUT_MS,
  DEFAULT_OCR_TIMEOUT_MS,
} = require('./ocrTimeout');

/**
 * @typedef {import('./settingsCatalog').SettingEntry} SettingEntry
 * @typedef {import('./settingsCatalog').RemovedSetting} RemovedSetting
 * @typedef {NodeJS.ProcessEnv|Record<string, string|undefined>} Env
 */

/**
 * A value Zettelrobbe would have changed (a startup migration, a new default)
 * and cannot, because the environment sets the key. The next such case is one
 * more entry in BLOCKED_CHANGES.
 *
 * @typedef {object} BlockedChange
 * @property {string} key environment variable
 * @property {(value: string) => boolean} applies whether the value in effect is the case
 * @property {string} title what it is, in a few words
 * @property {string} text what it means and what to do
 * @property {string} reason why its row cannot be taken over: a copy would
 *   keep the value Zettelrobbe means to change once the line is gone
 */

/**
 * @typedef {{ ok: true, value: string } | { ok: false, reason: string }} Storable
 */

/**
 * @typedef {object} SettingRow
 * @property {string} key
 * @property {string|null} anchor id of the field on the settings page; null when it has none
 * @property {boolean} secret
 * @property {string|null} value the value in effect; null for a secret
 * @property {'none'|'same'|'different'} stored what Zettelrobbe's own settings hold for the key
 * @property {string|null} storedValue the stored value when it differs; null for a secret
 * @property {boolean} canTakeOver
 * @property {string|null} reason why the value cannot be taken over
 * @property {boolean} canRemoveCopy the stored copy equals the value in effect
 */

/**
 * @typedef {object} UnusedRow
 * @property {string} key
 * @property {string} removedIn
 * @property {boolean} inEnvironment
 * @property {boolean} inStored
 */

/**
 * @typedef {object} BlockedRow
 * @property {string} key
 * @property {string|null} anchor
 * @property {string} title
 * @property {string} text
 */

/**
 * @typedef {object} EnvironmentOverview
 * @property {SettingRow[]} settings
 * @property {UnusedRow[]} unused
 * @property {BlockedRow[]} blocked
 * @property {number} count how many variables the three lists name
 */

/**
 * @typedef {object} OverviewInputs
 * @property {ReadonlyArray<SettingEntry>} catalog
 * @property {Env} environment the environment the process started with
 * @property {Env} effective the values in effect (process.env)
 * @property {Record<string, unknown>} stored Zettelrobbe's own stored values
 * @property {ReadonlyArray<RemovedSetting>} removed
 * @property {ReadonlyArray<string>} [bakedKeys] the Dockerfile's own defaults, never counted as set
 * @property {ReadonlyArray<BlockedChange>} [blockedChanges]
 */

/** The id of the topic on the settings page (its URL hash). */
const ENVIRONMENT_TOPIC = 'set-by-environment';

/** @param {number} ms */
const seconds = (ms) => Math.round(ms / 1000);

/** @type {ReadonlyArray<BlockedChange>} */
const BLOCKED_CHANGES = Object.freeze([
  // CFG-OCR-TIMEOUT-001 (services/startupMigrations.js) raises a stored
  // 30000 once and leaves a value the environment sets alone.
  Object.freeze({
    key: 'SETUP_OCR_VALIDATION_TIMEOUT_MS',
    applies: isOldFormOcrTimeout,
    title: `OCR timeout of ${seconds(OLD_FORM_OCR_TIMEOUT_MS)} seconds`,
    text:
      `The environment sets ${OLD_FORM_OCR_TIMEOUT_MS}, the old default of the settings form, so OCR gives up on a request after ${seconds(OLD_FORM_OCR_TIMEOUT_MS)} seconds. ` +
      `Delete the line from docker-compose without taking it over, and OCR waits the default ${seconds(DEFAULT_OCR_TIMEOUT_MS)} seconds.`,
    reason: `${OLD_FORM_OCR_TIMEOUT_MS} is the old default of the settings form, so delete the line instead of taking it over.`,
  }),
]);

/**
 * Fields whose element id on the settings page is not the form field name.
 * tests/test-environment-overview.js checks every anchor against the page.
 *
 * @type {Readonly<Record<string, string>>}
 */
const FIELD_ANCHORS = Object.freeze({
  CUSTOM_FIELDS: 'customFieldsJson',
  // One field on the page writes the OCR key to both variables.
  MISTRAL_API_KEY: 'ocrApiKey',
});

const CORRECT_FIRST =
  'Correct the line in docker-compose before you take it over.';

const REASONS = Object.freeze({
  noField:
    'This setting has no field on the settings page, so Zettelrobbe does not store it. Keep the line.',
  emptyMeansDefault:
    'The environment sets an empty value, which means the default. Deleting the line changes nothing.',
  emptyKept:
    'The environment sets an empty value, and Zettelrobbe cannot store an empty value for this setting yet. Keep the line.',
  cron: `This is not a valid cron schedule. ${CORRECT_FIRST}`,
  json: `This is not valid JSON. ${CORRECT_FIRST}`,
  integer: `This is not a whole number. ${CORRECT_FIRST}`,
  number: `This is not a number. ${CORRECT_FIRST}`,
});

/**
 * @param {Record<string, unknown>|Env} values
 * @param {string} key
 */
const has = (values, key) => Object.prototype.hasOwnProperty.call(values, key);

/**
 * A parsed form value as it is stored: a list as comma-separated text, the
 * way setupService.normalizeEnvironmentValue() writes it.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asStored(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join(',');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * @param {string} pattern
 * @returns {boolean}
 */
function isValidCron(pattern) {
  return require('node-cron').validate(pattern);
}

/**
 * The value "Take over" stores for a setting, or why it stores none.
 *
 * The value is the one in effect, normalised the way a save of the field
 * normalises it (the catalogue's `parse`): a list as comma-separated text, a
 * date format in capitals, a number without leading zeros. A value the
 * field's own check refuses, or that a save would turn into another value (a
 * number outside the field's range, an unknown OCR mode), is not stored.
 *
 * Two kinds are stored as they are written, because the copy has to mean
 * what the environment's line means once the line is gone. Switches: the form
 * parsers expect a checkbox, and some switches are read as written ("true" is
 * not "yes" everywhere), so a rewritten copy could flip one. Free text: the
 * prompt field's parser drops = signs and rewrites line breaks for the form,
 * and the model is sent the text as it is. A secret without a parser is
 * stored as it is, like a typed one.
 *
 * @param {SettingEntry} entry
 * @param {unknown} raw the value in effect
 * @returns {Storable}
 */
function storableValue(entry, raw) {
  const value = raw == null ? '' : String(raw);
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: entry.keepEmpty ? REASONS.emptyKept : REASONS.emptyMeansDefault,
    };
  }
  if (entry.type === 'boolean') return { ok: true, value };
  if (entry.type === 'secret' && !entry.parse) return { ok: true, value };

  if (entry.type === 'cron' && !isValidCron(trimmed)) {
    return { ok: false, reason: REASONS.cron };
  }
  if (entry.type === 'json') {
    try {
      JSON.parse(value);
    } catch {
      return { ok: false, reason: REASONS.json };
    }
  }
  if (entry.type === 'integer' && !/^\d+$/.test(trimmed)) {
    return { ok: false, reason: REASONS.integer };
  }
  if (entry.type === 'number' && !Number.isFinite(Number(trimmed))) {
    return { ok: false, reason: REASONS.number };
  }

  if (!entry.parse) {
    if (entry.values) {
      const choice = trimmed.toLowerCase();
      const known = entry.values.map((known) => known.toLowerCase());
      if (!known.includes(choice)) {
        return {
          ok: false,
          reason: `Zettelrobbe knows only ${entry.values.join(', ')}. ${CORRECT_FIRST}`,
        };
      }
      return { ok: true, value: choice };
    }
    return { ok: true, value };
  }

  const result = entry.parse(value, value);
  if (result.error) {
    return { ok: false, reason: `${result.error} ${CORRECT_FIRST}` };
  }
  if (!('value' in result) || entry.type === 'string') {
    return { ok: true, value };
  }
  const parsed = asStored(result.value);
  const numeric = entry.type === 'integer' || entry.type === 'number';
  if (result.warning || (numeric && Number(parsed) !== Number(trimmed))) {
    return {
      ok: false,
      reason: entry.secret
        ? `A save of this field would change the value. ${CORRECT_FIRST}`
        : `A save of this field turns ${trimmed} into ${parsed}. ${CORRECT_FIRST}`,
    };
  }
  return { ok: true, value: parsed };
}

/**
 * What "Take over" stores for a setting: storableValue(), for a setting a
 * field on the settings page keeps. A setting without one would be dropped
 * again by the next settings save once its line is gone.
 *
 * @param {SettingEntry} entry
 * @param {unknown} value the value in effect
 * @returns {Storable}
 */
function takeOverValue(entry, value) {
  if (!entry.field) return { ok: false, reason: REASONS.noField };
  return storableValue(entry, value);
}

/**
 * The blocked change a value in effect is, if any: the environment sets the
 * key to a value Zettelrobbe would have changed (BLOCKED_CHANGES).
 *
 * @param {OverviewInputs} inputs
 * @param {string} key
 * @param {unknown} value the value in effect
 * @returns {BlockedChange|undefined}
 */
function blockedChangeOf(inputs, key, value) {
  const raw = value == null ? '' : String(value);
  return (inputs.blockedChanges || BLOCKED_CHANGES).find(
    (change) => change.key === key && change.applies(raw)
  );
}

/**
 * What "Take over" stores for a setting the environment sets: nothing for a
 * blocked change, whose copy would keep the value for good once the line is
 * gone (the migration that would have changed it leaves a value the
 * environment sets alone), else takeOverValue().
 *
 * @param {OverviewInputs} inputs
 * @param {SettingEntry} entry
 * @param {unknown} value the value in effect
 * @returns {Storable}
 */
function takeOverTarget(inputs, entry, value) {
  const blocked = blockedChangeOf(inputs, entry.key, value);
  if (blocked) return { ok: false, reason: blocked.reason };
  return takeOverValue(entry, value);
}

/**
 * Whether two values of a setting are the same once stored: equal as written,
 * or equal after the normalisation of storableValue().
 *
 * @param {SettingEntry} entry
 * @param {string} a
 * @param {string} b
 */
function sameValue(entry, a, b) {
  if (a === b) return true;
  const left = storableValue(entry, a);
  const right = storableValue(entry, b);
  return left.ok && right.ok && left.value === right.value;
}

/**
 * Where a link to the setting's field points: its element id on the page.
 *
 * @param {SettingEntry|undefined} entry
 * @returns {string|null}
 */
function anchorOf(entry) {
  if (!entry || !entry.field) return null;
  return FIELD_ANCHORS[entry.key] || entry.field;
}

/**
 * @param {OverviewInputs} inputs
 * @returns {(key: string) => boolean}
 */
function environmentSets(inputs) {
  const baked = new Set(inputs.bakedKeys || []);
  return (key) => !baked.has(key) && has(inputs.environment, key);
}

/**
 * A stored value counts when it is not empty: config/config.js skips an empty
 * one when it applies the stored settings.
 *
 * @param {Record<string, unknown>} stored
 * @param {string} key
 * @returns {string|null}
 */
function storedValueOf(stored, key) {
  if (!has(stored, key) || stored[key] == null) return null;
  const value = String(stored[key]);
  return value.trim() ? value : null;
}

/**
 * The three lists of the topic "Set by the environment".
 *
 * @param {OverviewInputs} inputs
 * @returns {EnvironmentOverview}
 */
function buildEnvironmentOverview(inputs) {
  const sets = environmentSets(inputs);
  const stored = inputs.stored || {};

  /** @type {SettingRow[]} */
  const settings = [];
  for (const entry of inputs.catalog) {
    if (!sets(entry.key)) continue;
    const value = String(
      inputs.effective[entry.key] ?? inputs.environment[entry.key] ?? ''
    );
    const copy = storedValueOf(stored, entry.key);
    /** @type {'none'|'same'|'different'} */
    let state = 'none';
    if (copy !== null) {
      state = sameValue(entry, copy, value) ? 'same' : 'different';
    }
    const target = takeOverTarget(inputs, entry, value);
    settings.push({
      key: entry.key,
      anchor: anchorOf(entry),
      secret: entry.secret,
      value: entry.secret ? null : value,
      stored: state,
      storedValue: state === 'different' && !entry.secret ? copy : null,
      canTakeOver: target.ok && state !== 'same',
      reason: target.ok ? null : target.reason,
      canRemoveCopy: state === 'same',
    });
  }

  /** @type {UnusedRow[]} */
  const unused = [];
  for (const setting of inputs.removed) {
    const inEnvironment = sets(setting.key);
    const inStored = has(stored, setting.key);
    if (inEnvironment || inStored) {
      unused.push({
        key: setting.key,
        removedIn: setting.removedIn,
        inEnvironment,
        inStored,
      });
    }
  }

  /** @type {BlockedRow[]} */
  const blocked = [];
  for (const change of inputs.blockedChanges || BLOCKED_CHANGES) {
    if (!sets(change.key)) continue;
    if (!change.applies(String(inputs.effective[change.key] ?? ''))) continue;
    blocked.push({
      key: change.key,
      anchor: anchorOf(
        inputs.catalog.find((entry) => entry.key === change.key)
      ),
      title: change.title,
      text: change.text,
    });
  }

  const count = new Set(
    [...settings, ...unused, ...blocked].map((row) => row.key)
  ).size;
  return { settings, unused, blocked, count };
}

/**
 * The keys of a request: a list of setting names, or "all" where allowed.
 *
 * @param {unknown} requested
 * @param {boolean} allowAll
 * @returns {string[]|'all'|null} null when the request is not one of them
 */
function requestedKeys(requested, allowAll) {
  if (allowAll && requested === 'all') return 'all';
  if (!Array.isArray(requested) || requested.length === 0) return null;
  if (!requested.every((key) => typeof key === 'string' && key)) return null;
  return [...new Set(requested)];
}

/**
 * @typedef {{ key: string, reason: string }} Refusal
 */

/**
 * What "Take over" stores: for each requested key the value storableValue()
 * gives, or why it stores none (a blocked change stores none either). A key
 * that is not a catalogue setting the environment sets refuses the whole
 * request.
 *
 * @param {OverviewInputs} inputs
 * @param {unknown} requested a list of keys, or "all": every row that can be taken over
 * @returns {{ error: string } | { values: Record<string, string>, refused: Refusal[] }}
 */
function planTakeOver(inputs, requested) {
  const keys = requestedKeys(requested, true);
  if (keys === null) {
    return { error: 'Send keys: a list of setting names, or "all".' };
  }
  const overview = buildEnvironmentOverview(inputs);
  const rows = new Map(overview.settings.map((row) => [row.key, row]));
  const wanted =
    keys === 'all'
      ? overview.settings.filter((row) => row.canTakeOver).map((row) => row.key)
      : keys;
  const unknown = wanted.filter((key) => !rows.has(key));
  if (unknown.length > 0) {
    return {
      error: `Not a setting the environment sets: ${unknown.join(', ')}.`,
    };
  }

  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Refusal[]} */
  const refused = [];
  for (const key of wanted) {
    const entry = /** @type {SettingEntry} */ (
      inputs.catalog.find((item) => item.key === key)
    );
    const target = takeOverTarget(inputs, entry, inputs.effective[key]);
    if (target.ok) values[key] = target.value;
    else refused.push({ key, reason: target.reason });
  }
  return { values, refused };
}

/**
 * What "Remove the stored copy" removes: the stored copy of each requested
 * key, but only a copy that equals the value in effect, so that a value
 * someone stored on purpose is not deleted by accident.
 *
 * @param {OverviewInputs} inputs
 * @param {unknown} requested a list of keys
 * @returns {{ error: string } | { keys: string[], refused: Refusal[] }}
 */
function planRemoveCopy(inputs, requested) {
  const keys = requestedKeys(requested, false);
  if (keys === null || keys === 'all') {
    return { error: 'Send keys: a list of setting names.' };
  }
  const rows = new Map(
    buildEnvironmentOverview(inputs).settings.map((row) => [row.key, row])
  );
  const unknown = keys.filter((key) => !rows.has(key));
  if (unknown.length > 0) {
    return {
      error: `Not a setting the environment sets: ${unknown.join(', ')}.`,
    };
  }

  /** @type {string[]} */
  const removable = [];
  /** @type {Refusal[]} */
  const refused = [];
  for (const key of keys) {
    const row = /** @type {SettingRow} */ (rows.get(key));
    if (row.canRemoveCopy) removable.push(key);
    else {
      refused.push({
        key,
        reason:
          row.stored === 'none'
            ? 'Nothing is stored for this setting.'
            : 'The stored value is not the one in effect. Zettelrobbe removes only a copy of the value in effect.',
      });
    }
  }
  return { keys: removable, refused };
}

/**
 * The line the server logs at every start when the environment sets
 * settings; empty when it sets none.
 *
 * @param {EnvironmentOverview} overview
 * @returns {string}
 */
function startupLine(overview) {
  const count = overview.settings.length;
  if (count === 0) return '';
  const settings =
    count === 1
      ? '1 setting is set by the environment.'
      : `${count} settings are set by the environment.`;
  return `[INFO] ${settings} Settings, Set by the environment, lists them.`;
}

/**
 * The inputs as the running process sees them: the catalogue, the environment
 * it started with, process.env and the stored settings.
 *
 * @returns {Promise<OverviewInputs>}
 */
async function readEnvironmentInputs() {
  const config = require('../config/config');
  const setupService = require('./setupService');
  const settingsCatalog = require('./settingsCatalog');
  return {
    catalog: settingsCatalog.getCatalog(),
    environment: config.getStartupEnvironment(),
    effective: process.env,
    stored: await setupService.loadStoredValues(),
    removed: settingsCatalog.REMOVED_SETTINGS,
    bakedKeys: config.dockerfileBakedKeys,
  };
}

module.exports = {
  ENVIRONMENT_TOPIC,
  BLOCKED_CHANGES,
  FIELD_ANCHORS,
  storableValue,
  buildEnvironmentOverview,
  planTakeOver,
  planRemoveCopy,
  startupLine,
  readEnvironmentInputs,
};
