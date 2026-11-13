// @ts-check
'use strict';

/**
 * The route layer that server.js mounts at / after routes/oidc.js and
 * routes/tidyUp.js.
 *
 * Two pathless guards run first, once, for every request that reaches this
 * router, including the server.js routes mounted after it (/styleguide, /):
 * remoteSetupGuard keeps /setup and /api/setup/* to local callers while setup
 * is open, and authGate sends a caller without a session to /login except on
 * the public paths (middleware/authGate.js). No feature router has a pathless
 * router.use of its own.
 *
 * The feature routers follow, each mounted at / and declaring full paths: a
 * mount path would strip req.path and break isPublicPath() and the other path
 * checks. Their order is the order of the route table (the former
 * routes/setup.js, top to bottom); tests/test-route-shadowing.js checks that
 * no parameter route of an earlier router matches a static path of a later
 * one.
 */

const express = require('express');
const { remoteSetupGuard, authGate } = require('../middleware/authGate');

const router = express.Router();

router.use(remoteSetupGuard);
router.use(authGate);

router.use(require('./login')); // login, logout
router.use(require('./documents')); // chat document search, thumbnails
router.use(require('./history')); // history page and API
router.use(require('./maintenance')); // caches, reconcile, resets
router.use(require('./settings')); // settings page and save
router.use(require('./scan')); // scan, status, webhook
router.use(require('./setupWizard')); // setup wizard
router.use(require('./setup')); // not split yet

// Carried over from routes/setup.js, which ran it once its modules had loaded:
// reads ../data/.env relative to the working directory, and never overwrites
// a variable that is already set.
require('dotenv').config({ path: '../data/.env' });

module.exports = router;
