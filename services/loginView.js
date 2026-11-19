// @ts-check
'use strict';

/**
 * Renders the login page. Shared by the login routes and the login rate
 * limiter, whose refusal is the same page with an error on it.
 */

const oidcService = require('./oidcService');

/**
 * @typedef {object} LoginViewOptions
 * @property {string|null} [error] - message shown above the form
 * @property {boolean} [mfaRequired] - show the authentication code step
 * @property {string} [username] - prefill for the username field
 */

/**
 * @param {import('express').Response} res
 * @param {LoginViewOptions} [options]
 * @returns {void}
 */
function renderLoginView(res, options = {}) {
  return res.render('login', {
    error: options.error || null,
    mfaRequired: Boolean(options.mfaRequired),
    username: options.username || '',
    sso: oidcService.getLoginButton(),
  });
}

module.exports = { renderLoginView };
