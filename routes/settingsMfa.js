'use strict';

/**
 * Two-factor authentication (TOTP) of the signed-in user: status, setup,
 * enable, verify, disable.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /api/settings/mfa/status    Get MFA status for current user
 *   POST  /api/settings/mfa/setup     Start MFA setup and return provisioning data
 *   POST  /api/settings/mfa/enable    Enable MFA after validating TOTP code
 *   POST  /api/settings/mfa/verify    Verify a TOTP code for an already enabled MFA setup
 *   POST  /api/settings/mfa/disable   Disable MFA for current user
 */

const express = require('express');
const documentModel = require('../models/document.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { isAuthenticated } = require('./auth.js');
const { getAuthenticatedSettingsUsername } = require('../middleware/authGate');
const {
  MFA_SETUP_COOKIE,
  generateBase32Secret,
  buildOtpAuthUri,
  verifyTotpToken,
  consumeTotpToken,
  isMfaEnabledForUser,
} = require('../services/mfaService');
const { shouldUseSecureCookies } = require('../services/sessionCookie');
const config = require('../config/config.js');
const router = express.Router();

/**
 * @swagger
 * /api/settings/mfa/status:
 *   get:
 *     summary: Get MFA status for current user
 *     description: Returns whether TOTP MFA is enabled for the authenticated settings user.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA status loaded successfully
 *       403:
 *         description: Forbidden - unsupported authentication context
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/api/settings/mfa/status', isAuthenticated, async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({
        success: false,
        error: 'MFA settings require a signed-in user session.',
      });
    }

    const user = await documentModel.getUser(username);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.json({
      success: true,
      enabled: isMfaEnabledForUser(user),
      username: user.username,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/mfa/status:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load MFA status.' });
  }
});

/**
 * @swagger
 * /api/settings/mfa/setup:
 *   post:
 *     summary: Start MFA setup and return provisioning data
 *     description: Validates current password and creates a temporary TOTP setup challenge including local QR image data.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA setup challenge created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid current password
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/setup',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      if (!currentPassword) {
        return res
          .status(400)
          .json({ success: false, error: 'Current password is required.' });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      const jwtSecret = config.getJwtSecret();
      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'Server misconfiguration: JWT secret missing.',
        });
      }

      const secret = generateBase32Secret(32);
      const setupToken = jwt.sign(
        {
          username: user.username,
          secret,
          setupType: 'mfa-setup',
        },
        jwtSecret,
        { expiresIn: '10m' }
      );

      res.cookie(MFA_SETUP_COOKIE, setupToken, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax',
        path: '/',
      });

      return res.json({
        success: true,
        secret,
        otpauthUri: buildOtpAuthUri(secret, user.username),
        qrDataUrl: await QRCode.toDataURL(
          buildOtpAuthUri(secret, user.username),
          {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220,
            color: {
              dark: '#0f172a',
              light: '#ffffff',
            },
          }
        ),
        expiresInSeconds: 600,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/setup:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to start MFA setup.' });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/enable:
 *   post:
 *     summary: Enable MFA after validating TOTP code
 *     description: Validates current password and setup token, verifies TOTP code, then enables MFA.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA enabled successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid credentials or token
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/enable',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      const token = String(req.body?.token || '').trim();
      if (!currentPassword || !token) {
        return res.status(400).json({
          success: false,
          error: 'Current password and authentication code are required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      const setupToken = req.cookies[MFA_SETUP_COOKIE];
      if (!setupToken) {
        return res.status(401).json({
          success: false,
          error: 'No active MFA setup challenge found. Start setup again.',
        });
      }

      const jwtSecret = config.getJwtSecret();
      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'Server misconfiguration: JWT secret missing.',
        });
      }

      let payload;
      try {
        payload = jwt.verify(setupToken, jwtSecret);
        if (
          payload.setupType !== 'mfa-setup' ||
          payload.username !== username
        ) {
          throw new Error('Invalid setup payload');
        }
      } catch {
        res.clearCookie(MFA_SETUP_COOKIE);
        return res.status(401).json({
          success: false,
          error: 'MFA setup session expired. Start setup again.',
        });
      }

      if (!consumeTotpToken(username, payload.secret, token)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      const updated = await documentModel.setUserMfaSettings(
        username,
        true,
        payload.secret
      );
      if (!updated) {
        return res
          .status(500)
          .json({ success: false, error: 'Failed to enable MFA for user.' });
      }

      res.clearCookie(MFA_SETUP_COOKIE);
      return res.json({ success: true, message: 'MFA has been enabled.' });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/enable:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to enable MFA.' });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/verify:
 *   post:
 *     summary: Verify a TOTP code for an already enabled MFA setup
 *     description: Validates an entered TOTP code against the stored user MFA secret.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: TOTP code validated successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/verify',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const token = String(req.body?.token || '').trim();
      if (!token) {
        return res
          .status(400)
          .json({ success: false, error: 'Authentication code is required.' });
      }

      const user = await documentModel.getUser(username);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
        return res
          .status(400)
          .json({ success: false, error: 'MFA is not enabled for this user.' });
      }

      const validCode = verifyTotpToken(user.mfa_secret, token);
      if (!validCode) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      return res.json({
        success: true,
        message: 'Authentication code is valid.',
      });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/verify:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify authentication code.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/mfa/disable:
 *   post:
 *     summary: Disable MFA for current user
 *     description: Validates current password and a valid TOTP code, then disables MFA for the user.
 *     tags:
 *       - Settings
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: MFA disabled successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post(
  '/api/settings/mfa/disable',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'MFA settings require a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      const token = String(req.body?.token || '').trim();
      if (!currentPassword || !token) {
        return res.status(400).json({
          success: false,
          error: 'Current password and authentication code are required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res
          .status(404)
          .json({ success: false, error: 'User not found.' });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res
          .status(401)
          .json({ success: false, error: 'Current password is invalid.' });
      }

      if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
        return res
          .status(400)
          .json({ success: false, error: 'MFA is not enabled for this user.' });
      }

      if (!consumeTotpToken(username, user.mfa_secret, token)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid authentication code.' });
      }

      const updated = await documentModel.setUserMfaSettings(
        username,
        false,
        null
      );
      if (!updated) {
        return res
          .status(500)
          .json({ success: false, error: 'Failed to disable MFA for user.' });
      }

      res.clearCookie(MFA_SETUP_COOKIE);
      return res.json({ success: true, message: 'MFA has been disabled.' });
    } catch (error) {
      console.error('[ERROR] POST /api/settings/mfa/disable:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to disable MFA.' });
    }
  }
);

module.exports = router;
