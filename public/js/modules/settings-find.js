/**
 * Settings › "Find a setting": the matching, without the DOM.
 *
 * modules/settings-nav.js reads the page into plain objects and renders what
 * findSettings() returns: which topics hold a match, how many rows each one
 * marks, and the sentence under the field. Pure functions only, so
 * tests/test-settings-find.js runs the shipped matching directly.
 *
 * A setting is found by the text a person sees on its row (the label and the
 * hint), by the choices of its list, and by the environment variable it
 * writes, with or without underscores: "scan interval" finds SCAN_INTERVAL.
 * Every word of the query has to occur somewhere in that text.
 */

/**
 * @typedef {object} FindTopic
 * @property {string} id      the entry id (the URL hash)
 * @property {string} title   the topic as the list names it
 * @property {string} [group] the group it is listed under
 */

/**
 * @typedef {object} FindItem
 * @property {string} topic      id of the topic the row sits in
 * @property {string} label      the row's label
 * @property {string} [hint]     the hint under it, as shown
 * @property {string[]} [envKeys]  the variables the row writes
 * @property {string[]} [choices]  the options of its list
 * @property {*} [mark]          what gets marked for it; several items that
 *                               mark the same row count once
 */

/**
 * The words of a query: lower case, split on whitespace.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryWords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The one string a setting is found by.
 *
 * @param {FindItem} item
 * @returns {string}
 */
export function searchText(item) {
  const keys = (item.envKeys || []).join(' ');
  return [
    item.label,
    item.hint,
    (item.choices || []).join(' '),
    keys,
    keys.replace(/_/g, ' '),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * @param {string} text  already lower case
 * @param {string[]} words
 * @returns {boolean}
 */
export function hasEveryWord(text, words) {
  return words.length > 0 && words.every((word) => text.includes(word));
}

/**
 * Which topics hold a match and how many rows each one marks. A topic whose
 * own name matches is listed too, with a count of 0 when none of its rows
 * does. Topics keep the order they are given in.
 *
 * @param {string} query
 * @param {FindTopic[]} topics
 * @param {FindItem[]} items
 * @returns {{ active: boolean, topics: { id: string, count: number }[], items: FindItem[], total: number }}
 *   active is false for a blank query; total counts the marked rows.
 */
export function findSettings(query, topics, items) {
  const words = queryWords(query);
  if (!words.length) {
    return { active: false, topics: [], items: [], total: 0 };
  }
  const hits = items.filter((item) => hasEveryWord(searchText(item), words));

  /** @type {Map<string, Set<*>>} */
  const marks = new Map();
  hits.forEach((item) => {
    if (!marks.has(item.topic)) marks.set(item.topic, new Set());
    marks.get(item.topic)?.add(item.mark === undefined ? item : item.mark);
  });

  const listed = topics
    .filter(
      (topic) =>
        marks.has(topic.id) ||
        hasEveryWord(`${topic.title} ${topic.group || ''}`.toLowerCase(), words)
    )
    .map((topic) => ({ id: topic.id, count: marks.get(topic.id)?.size || 0 }));

  return {
    active: true,
    topics: listed,
    items: hits,
    total: listed.reduce((sum, topic) => sum + topic.count, 0),
  };
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function counted(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The sentence under the field, empty while nothing is typed.
 *
 * @param {{ active: boolean, topics: { id: string, count: number }[], total: number }} result
 * @param {string} query
 * @returns {string}
 */
export function describeResult(result, query) {
  if (!result.active) return '';
  const typed = String(query || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!result.topics.length) {
    return `No setting matches “${typed}”.`;
  }
  if (!result.total) {
    return result.topics.length === 1
      ? `No setting matches. One topic has “${typed}” in its name.`
      : `No setting matches. ${result.topics.length} topics have “${typed}” in their name.`;
  }
  const withRows = result.topics.filter((topic) => topic.count > 0).length;
  return `${counted(result.total, 'setting', 'settings')} in ${counted(withRows, 'topic', 'topics')}.`;
}
