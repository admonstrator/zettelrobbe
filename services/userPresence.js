// @ts-check
'use strict';

/**
 * Whether the instance has an administrator account yet.
 *
 * The authentication gate asks on every request and the setup wizard asks
 * before every step, so the answer lives here once: a second copy of the
 * cache would let the two disagree about whether the wizard is still open.
 */

const documentModel = require('../models/document.js');

/* The answer only ever flips once, from "no users" to "users exist": the setup
   wizard is the only thing that creates the first account, and addUser() never
   leaves the table empty. Caching the positive answer keeps the global guard,
   which asks on every single request, from hitting SQLite each time. The
   negative answer is not cached, so a fresh instance still notices the moment
   the wizard finishes. */
let cachedUsersExist = false;

/**
 * True once at least one user account exists.
 *
 * @returns {Promise<boolean>}
 */
async function hasAnyUser() {
  if (cachedUsersExist) {
    return true;
  }

  const users = await documentModel.getUsers();
  cachedUsersExist = Array.isArray(users) && users.length > 0;
  return cachedUsersExist;
}

/**
 * True only while the instance has no administrator account.
 *
 * Deliberately independent of setupService.isConfigured(): an incomplete
 * configuration used to reopen the wizard on an instance that already had an
 * admin, and an unauthenticated POST /api/setup/complete then replaced that
 * admin (addUser() runs DELETE FROM users first) and repointed the
 * Paperless-ngx connection. Missing configuration is now an administration
 * job, handled in /settings by a signed-in user.
 *
 * @returns {Promise<boolean>}
 */
async function isInitialSetupOpen() {
  return !(await hasAnyUser());
}

module.exports = { hasAnyUser, isInitialSetupOpen };
