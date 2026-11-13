// @ts-check
'use strict';

/**
 * The session cookie: when it is marked Secure, and how it is issued and
 * cleared. The password sign-in, the MFA step and single sign-on all end in
 * the same cookie, so its name, flags, lifetime and payload are defined here
 * once.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/config.js');
const { SESSION_TOKEN_TYPE } = require('../routes/auth.js');

/** Name of the cookie that carries the session JWT. */
const SESSION_COOKIE_NAME = 'jwt';
/** Lifetime of a session, as the JWT expiry and as the cookie max-age. */
const SESSION_TTL = '24h';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True when cookies set on this response should carry the Secure flag.
 * COOKIE_SECURE_MODE=always|never forces it; auto (the default) follows the
 * request: a TLS connection or X-Forwarded-Proto: https from a proxy.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function shouldUseSecureCookies(req) {
  const mode = config.getCookieSecureMode();

  if (mode === 'always') {
    return true;
  }

  if (mode === 'never') {
    return false;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProto === 'https');
}

/**
 * Signs a session token for the user and sets it as the session cookie.
 *
 * @param {import('express').Request} req - decides the Secure flag
 * @param {import('express').Response} res
 * @param {{ id: unknown, username: string }} user - the account signing in
 * @param {string} jwtSecret - the signing secret
 * @returns {string} the token that was set
 */
function issueSessionCookie(req, res, user, jwtSecret) {
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      typ: SESSION_TOKEN_TYPE,
    },
    jwtSecret,
    { expiresIn: SESSION_TTL }
  );
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: shouldUseSecureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  return token;
}

/**
 * Removes the session cookie.
 *
 * @param {import('express').Response} res
 * @returns {void}
 */
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  shouldUseSecureCookies,
  issueSessionCookie,
  clearSessionCookie,
};
