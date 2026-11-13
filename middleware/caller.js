// @ts-check
'use strict';

/**
 * Who is calling: the one place that reads the session token, compares the
 * API key and verifies the token. Every guard and helper (middleware/authGate.js)
 * and the caller-dependent parts of server.js (rate-limit key, CSRF session
 * identifier, CSRF skip) are built from what this module answers.
 *
 * A guard is resolveCaller() plus a declared policy (CallerPolicy): which
 * kinds of caller it accepts and how it answers a refusal. admit() applies a
 * policy to a request.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/config.js');
const {
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_TYPE,
  clearSessionCookie,
} = require('../services/sessionCookie.js');

/**
 * The result of resolveCaller():
 * - apiKey: the request carries the configured API key;
 * - session: a valid session token; `user` is its decoded payload;
 * - none: no token (and no API key that counts);
 * - invalid: a token that does not open a session (bad signature, expired,
 *   or minted for another purpose such as an MFA challenge);
 * - misconfigured: no JWT secret is configured, so no token can be checked.
 *
 * @typedef {{ kind: 'apiKey' }
 *   | { kind: 'session', user: Record<string, any> }
 *   | { kind: 'none' }
 *   | { kind: 'invalid' }
 *   | { kind: 'misconfigured' }} Caller
 */

/**
 * What a guard accepts and how it refuses.
 * - acceptApiKey: whether the API key counts at all. A guard that does not
 *   accept it looks at the session token only, even when a valid key is sent.
 * - refuse: 'redirect' sends a browser to /login (500 text when the JWT secret
 *   is missing); 'json' answers 401 / 403 / 500 with a JSON message.
 * - clearInvalidSession: whether a refused token also clears the session
 *   cookie.
 *
 * @typedef {{
 *   acceptApiKey: boolean,
 *   refuse: 'redirect' | 'json',
 *   clearInvalidSession: boolean,
 * }} CallerPolicy
 */

/** The refusal messages, shared by the text and the JSON answers. */
const MESSAGES = Object.freeze({
  misconfigured: 'Server misconfiguration: JWT secret missing',
  none: 'Authentication required',
  invalid: 'Invalid or expired token',
});

/**
 * Verifies a JWT and returns its payload only if it is a session token.
 *
 * The MFA login challenge and the MFA setup challenge are signed with the same
 * secret as a session, so a bare `jwt.verify()` cannot tell them apart from a
 * completed sign-in. A session therefore demands the explicit type claim, and
 * the challenge verifiers keep demanding their own claims in return.
 *
 * Returns null for an invalid signature, an expired token, and for any token
 * minted for a different purpose, so callers can treat all of those the same
 * way.
 *
 * @param {string} token - the raw JWT
 * @param {string} jwtSecret - the signing secret
 * @returns {Record<string, any>|null} the decoded payload, or null
 */
function verifySessionToken(token, jwtSecret) {
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded || decoded.typ !== SESSION_TOKEN_TYPE) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * The session token of the request: the session cookie, else the second word
 * of the Authorization header (the scheme is not checked).
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function readSessionToken(req) {
  return (
    req.cookies?.[SESSION_COOKIE_NAME] ||
    req.headers.authorization?.split(' ')[1]
  );
}

/**
 * Compares a presented API key with the configured one in constant time.
 * An empty configured key never matches; keys of different length are a plain
 * mismatch.
 *
 * @param {unknown} presented - the x-api-key header value
 * @param {string} configured - the configured API key
 * @returns {boolean}
 */
function apiKeyMatches(presented, configured) {
  if (!configured || typeof presented !== 'string' || !presented) {
    return false;
  }
  const given = Buffer.from(presented);
  const expected = Buffer.from(configured);
  return (
    given.length === expected.length && crypto.timingSafeEqual(given, expected)
  );
}

/**
 * True when the request carries the configured API key.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasValidApiKey(req) {
  return apiKeyMatches(req.headers['x-api-key'], config.getApiKey());
}

/**
 * Turns a request into one Caller. The API key is checked first (unless
 * `apiKey` is false), then whether a JWT secret exists, then the token.
 *
 * @param {import('express').Request} req
 * @param {{ apiKey?: boolean }} [options] - apiKey: false ignores the API key
 * @returns {Caller}
 */
function resolveCaller(req, { apiKey = true } = {}) {
  if (apiKey && hasValidApiKey(req)) {
    return { kind: 'apiKey' };
  }

  const jwtSecret = config.getJwtSecret();
  if (!jwtSecret) {
    return { kind: 'misconfigured' };
  }

  const token = readSessionToken(req);
  if (!token) {
    return { kind: 'none' };
  }

  const user = verifySessionToken(token, jwtSecret);
  return user ? { kind: 'session', user } : { kind: 'invalid' };
}

/**
 * Applies a policy to a request. An accepted caller is put on req.user
 * (`{ apiKey: true }` or the session payload) and true is returned; a refused
 * one has been answered and false is returned.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {CallerPolicy} policy
 * @returns {boolean}
 */
function admit(req, res, policy) {
  const caller = resolveCaller(req, { apiKey: policy.acceptApiKey });
  /** @type {any} */
  const request = req;

  switch (caller.kind) {
    case 'apiKey':
      request.user = { apiKey: true };
      return true;
    case 'session':
      request.user = caller.user;
      return true;
    case 'misconfigured':
      if (policy.refuse === 'json') {
        res.status(500).json({ message: MESSAGES.misconfigured });
      } else {
        res.status(500).send(MESSAGES.misconfigured);
      }
      return false;
    case 'none':
      if (policy.refuse === 'json') {
        res.status(401).json({ message: MESSAGES.none });
      } else {
        res.redirect('/login');
      }
      return false;
    case 'invalid':
      if (policy.clearInvalidSession) {
        clearSessionCookie(res);
      }
      if (policy.refuse === 'json') {
        res.status(403).json({ message: MESSAGES.invalid });
      } else {
        res.redirect('/login');
      }
      return false;
  }
}

/**
 * The rate-limit identity of a caller: `api-key:<key>` for the API key,
 * `user:<id>` for a session (id, else userId, username or sub), or null when
 * the limiter should fall back to the client IP.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function callerRateLimitKey(req) {
  const caller = resolveCaller(req);
  if (caller.kind === 'apiKey') {
    return `api-key:${req.headers['x-api-key']}`;
  }
  if (caller.kind === 'session') {
    const { user } = caller;
    const identifier = user.id || user.userId || user.username || user.sub;
    if (identifier) {
      return `user:${identifier}`;
    }
  }
  return null;
}

module.exports = {
  verifySessionToken,
  readSessionToken,
  apiKeyMatches,
  hasValidApiKey,
  resolveCaller,
  admit,
  callerRateLimitKey,
};
