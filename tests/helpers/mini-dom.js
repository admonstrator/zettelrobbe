'use strict';

/**
 * A DOM small enough to read in one sitting, real enough to run the page
 * scripts that build and edit lists (public/js/chip-list.js) under plain
 * Node: elements with attributes, dataset, classes, text, a tree with
 * siblings, events that bubble, focus, and the selectors those scripts use
 * (tag, #id, .class, [attr], [attr="value"], compounds of them, descendant
 * combinators and comma lists). No layout, no HTML parser: a test builds its
 * tree with el().
 *
 * Usage:
 *   const { createDocument } = require('./helpers/mini-dom');
 *   const { document, window, Event, el } = createDocument();
 *   const input = el('input', { id: 'tagInput', type: 'text' });
 *   document.body.appendChild(input);
 */

function camelToData(key) {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function dataToCamel(name) {
  return name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/* "div.zr-chip[data-x='1']" -> { tag, id, classes, attrs } */
function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const pattern =
    /^([a-zA-Z][\w-]*)|#([\w:-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)"|='([^']*)')?\]/g;
  let match;
  let consumed = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index !== consumed) break;
    consumed = pattern.lastIndex;
    if (match[1]) out.tag = match[1].toUpperCase();
    else if (match[2]) out.id = match[2];
    else if (match[3]) out.classes.push(match[3]);
    else if (match[4]) {
      const value = match[5] !== undefined ? match[5] : match[6];
      out.attrs.push({ name: match[4], value });
    }
  }
  if (consumed !== text.length) {
    throw new Error(`mini-dom cannot parse selector part "${text}"`);
  }
  return out;
}

class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stopped = true;
  }
}

class Element {
  constructor(document, tagName, namespace = null) {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.namespaceURI = namespace;
    this.children = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._text = '';
    this._listeners = {};
    this._value = null;
    this.selectionStart = null;
    this.selectionEnd = null;
    const self = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_t, key) =>
          typeof key === 'string'
            ? (self.getAttribute(camelToData(key)) ?? undefined)
            : undefined,
        set: (_t, key, value) => {
          self.setAttribute(camelToData(String(key)), String(value));
          return true;
        },
        deleteProperty: (_t, key) => {
          self.removeAttribute(camelToData(String(key)));
          return true;
        },
        has: (_t, key) => self.hasAttribute(camelToData(String(key))),
        ownKeys: () =>
          [...self._attrs.keys()]
            .filter((name) => name.startsWith('data-'))
            .map(dataToCamel),
        getOwnPropertyDescriptor: (_t, key) =>
          self.hasAttribute(camelToData(String(key)))
            ? { enumerable: true, configurable: true }
            : undefined,
      }
    );
  }

  /* --- attributes --- */
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get type() {
    return (
      this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : '')
    );
  }

  set type(value) {
    this.setAttribute('type', value);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    this.toggleAttribute('disabled', Boolean(value));
  }

  get value() {
    return this._value !== null
      ? this._value
      : this.getAttribute('value') || '';
  }

  set value(value) {
    this._value = String(value);
  }

  get name() {
    return this.getAttribute('name') || '';
  }

  /* --- tree --- */
  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get firstChild() {
    return this.firstElementChild;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.children.forEach((c) => {
      c.parentNode = null;
    });
    this.children = [];
    this._text = String(value);
  }

  /* --- selectors --- */
  _matchesCompound(compound) {
    if (compound.tag && this.tagName !== compound.tag) return false;
    if (compound.id && this.id !== compound.id) return false;
    const classes = this.className.split(/\s+/).filter(Boolean);
    if (!compound.classes.every((c) => classes.includes(c))) return false;
    return compound.attrs.every(({ name, value }) =>
      value === undefined
        ? this.hasAttribute(name)
        : this.getAttribute(name) === value
    );
  }

  _matchesChain(parts) {
    if (!this._matchesCompound(parts[parts.length - 1])) return false;
    let index = parts.length - 2;
    for (let n = this.parentNode; n && index >= 0; n = n.parentNode) {
      if (n._matchesCompound && n._matchesCompound(parts[index])) index -= 1;
    }
    return index < 0;
  }

  matches(selector) {
    return selector
      .split(',')
      .map((group) => group.trim().split(/\s+/).map(parseCompound))
      .some((parts) => this._matchesChain(parts));
  }

  closest(selector) {
    for (let n = this; n && n.matches; n = n.parentNode) {
      if (n.matches(selector)) return n;
    }
    return null;
  }

  _descendants() {
    return this.children.flatMap((c) => [c, ...c._descendants()]);
  }

  querySelectorAll(selector) {
    return this._descendants().filter((n) => n.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  /* --- events --- */
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }

  removeEventListener(type, handler) {
    this._listeners[type] = (this._listeners[type] || []).filter(
      (h) => h !== handler
    );
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    if (
      this.ownerDocument &&
      path[path.length - 1] === this.ownerDocument.documentElement
    ) {
      path.push(this.ownerDocument);
    }
    for (const node of event.bubbles ? path : [this]) {
      event.currentTarget = node;
      (node._listeners[event.type] || [])
        .slice()
        .forEach((h) => h.call(node, event));
      if (event._stopped) break;
    }
    return !event.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click', { bubbles: true }));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function createDocument() {
  const document = {
    _listeners: {},
    activeElement: null,
    createElement: (tag) => new Element(document, tag),
    createElementNS: (namespace, tag) => new Element(document, tag, namespace),
    getElementById: (id) =>
      document.documentElement._descendants().find((n) => n.id === id) || null,
    querySelectorAll: (selector) =>
      document.documentElement.querySelectorAll(selector),
    querySelector: (selector) =>
      document.documentElement.querySelector(selector),
    addEventListener(type, handler) {
      (this._listeners[type] = this._listeners[type] || []).push(handler);
    },
  };
  document.documentElement = new Element(document, 'html');
  document.body = document.documentElement.appendChild(
    new Element(document, 'body')
  );

  /** Builds an element: el('input', { id: 'x', class: 'zr-input', 'data-a': '1' }, children). */
  function el(tag, attrs = {}, children = []) {
    const node = new Element(document, tag);
    Object.entries(attrs).forEach(([name, value]) => {
      if (name === 'text') node.textContent = value;
      else if (name === 'value') node.value = value;
      else if (value === true) node.setAttribute(name, '');
      else if (value !== false && value !== undefined && value !== null) {
        node.setAttribute(name, value);
      }
    });
    children.forEach((child) => node.appendChild(child));
    return node;
  }

  /** An event with extra fields, e.g. event('keydown', { key: 'Enter' }). */
  function event(type, props = {}, init = { bubbles: true }) {
    return Object.assign(new Event(type, init), props);
  }

  const window = { document };
  return { document, window, Event, el, event };
}

module.exports = { createDocument };
