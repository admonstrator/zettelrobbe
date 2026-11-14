// @ts-check
'use strict';

/**
 * Where routes and server.js import the route guard from. The code lives in
 * middleware/authGate.js (the guards and their policies) and
 * middleware/caller.js (who is calling); this module only re-exports it.
 */

const { isAuthenticated } = require('../middleware/authGate');
const { verifySessionToken } = require('../middleware/caller');
const { SESSION_TOKEN_TYPE } = require('../services/sessionCookie');

module.exports = {
  isAuthenticated,
  verifySessionToken,
  SESSION_TOKEN_TYPE,
};
