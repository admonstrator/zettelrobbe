'use strict';

/**
 * Sign-in and sign-out.
 *
 * Moved verbatim from routes/setup.js; routes/index.js mounts this router at
 * / behind remoteSetupGuard and authGate, and every route keeps its own
 * guard.
 *
 *   GET   /login    Render login page or redirect to setup if no users exist
 *   POST  /login    Authenticate user with username and password
 *   GET   /logout   Log out user and clear JWT cookie
 */

const express = require('express');
const documentModel = require('../models/document.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { loginLimiter } = require('../middleware/rateLimiters');
const {
  MFA_CHALLENGE_COOKIE,
  MFA_SETUP_COOKIE,
  consumeTotpToken,
  isMfaEnabledForUser,
  spendPasswordCheckTime,
} = require('../services/mfaService');
const {
  shouldUseSecureCookies,
  issueSessionCookie,
  clearSessionCookie,
} = require('../services/sessionCookie');
const { renderLoginView } = require('../services/loginView');
const config = require('../config/config.js');
const router = express.Router();

/**
 * @swagger
 * /login:
 *   get:
 *     summary: Render login page or redirect to setup if no users exist
 *     description: |
 *       Serves the login page for user authentication to the Zettelrobbe application.
 *       If no users exist in the database, the endpoint automatically redirects to the setup page
 *       to complete the initial application configuration.
 *
 *       This endpoint handles both new user sessions and returning users whose
 *       sessions have expired.
 *     tags:
 *       - Authentication
 *       - Navigation
 *     responses:
 *       200:
 *         description: Login page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the login page
 *       302:
 *         description: Redirect to setup page if no users exist, or to dashboard if already authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/setup"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/login', (req, res) => {
  //check if a user exists beforehand
  documentModel.getUsers().then((users) => {
    if (users.length === 0) {
      res.redirect('setup');
    } else {
      renderLoginView(res);
    }
  });
});

// Login page route
/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate user with username and password
 *     description: |
 *       Authenticates a user using their username and password credentials.
 *       The endpoint supports a preparation flow for MFA:
 *       first step validates credentials and starts an MFA challenge,
 *       second step accepts a TOTP authentication code and completes sign-in.
 *       If authentication is successful, a JWT token is generated and stored in a secure HTTP-only
 *       cookie for subsequent requests.
 *
 *       Failed login attempts are logged for security purposes, and multiple failures
 *       may result in temporary account lockout depending on configuration.
 *     tags:
 *       - Authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: User's login name
 *                 example: "admin"
 *               password:
 *                 type: string
 *                 description: User's password
 *                 example: "securepassword"
 *               mfaStep:
 *                 type: string
 *                 description: Set to '1' when submitting the MFA step
 *                 example: "0"
 *               mfaToken:
 *                 type: string
 *                 description: One-time code entered in the MFA verification step
 *                 example: "123456"
 *     responses:
 *       302:
 *         description: Authentication successful and redirected to dashboard
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               description: HTTP-only cookie containing JWT token
 *       200:
 *         description: Login page rendered again for invalid credentials, pending MFA verification, or invalid MFA code
 *       429:
 *         description: Too many login attempts; login temporarily rate-limited
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, mfaStep, mfaToken } = req.body;
  const submittingMfaStep = mfaStep === '1' || Boolean(mfaToken);

  try {
    const jwtSecret = config.getJwtSecret();
    if (!jwtSecret) {
      return res.status(500).render('login', {
        error: 'Server misconfiguration: JWT secret missing',
      });
    }

    if (submittingMfaStep) {
      if (!mfaToken || !String(mfaToken).trim()) {
        return renderLoginView(res, {
          error: 'Authentication code is required.',
          mfaRequired: true,
          username,
        });
      }

      const mfaChallengeToken = req.cookies[MFA_CHALLENGE_COOKIE];
      if (!mfaChallengeToken) {
        return renderLoginView(res, {
          error: 'Your verification session expired. Please sign in again.',
        });
      }

      let challengePayload;
      try {
        challengePayload = jwt.verify(mfaChallengeToken, jwtSecret);
        if (challengePayload.challengeType !== 'mfa-login') {
          throw new Error('Invalid challenge type');
        }
      } catch {
        res.clearCookie(MFA_CHALLENGE_COOKIE);
        return renderLoginView(res, {
          error: 'Your verification session expired. Please sign in again.',
        });
      }

      const user = await documentModel.getUser(challengePayload.username);
      const mfaSecret = user?.mfa_secret;

      if (!user || !isMfaEnabledForUser(user) || !mfaSecret) {
        res.clearCookie(MFA_CHALLENGE_COOKIE);
        return renderLoginView(res, {
          error: 'MFA is not configured for this user. Please sign in again.',
        });
      }

      if (!consumeTotpToken(user.username, mfaSecret, mfaToken)) {
        return renderLoginView(res, {
          error: 'Invalid authentication code. Please try again.',
          mfaRequired: true,
          username: challengePayload.username,
        });
      }

      issueSessionCookie(req, res, user, jwtSecret);
      res.clearCookie(MFA_CHALLENGE_COOKIE);
      return res.redirect('/dashboard');
    }

    console.log('Login attempt for user:', username);
    const user = await documentModel.getUser(username);

    if (!user || !user.password) {
      await spendPasswordCheckTime(password);
      console.log('[FAILED LOGIN] User not found or invalid data:', username);
      return renderLoginView(res, { error: 'Invalid credentials', username });
    }

    // Compare passwords
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (isValidPassword) {
      if (isMfaEnabledForUser(user)) {
        const challengeToken = jwt.sign(
          {
            id: user.id,
            username: user.username,
            challengeType: 'mfa-login',
          },
          jwtSecret,
          { expiresIn: '5m' }
        );
        res.cookie(MFA_CHALLENGE_COOKIE, challengeToken, {
          httpOnly: true,
          secure: shouldUseSecureCookies(req),
          sameSite: 'lax',
          path: '/',
        });

        return renderLoginView(res, {
          mfaRequired: true,
          username: user.username,
        });
      }

      issueSessionCookie(req, res, user, jwtSecret);

      return res.redirect('/dashboard');
    } else {
      return renderLoginView(res, { error: 'Invalid credentials', username });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.clearCookie(MFA_CHALLENGE_COOKIE);
    renderLoginView(res, { error: 'An error occurred during login', username });
  }
});

// Logout route
/**
 * @swagger
 * /logout:
 *   get:
 *     summary: Log out user and clear JWT cookie
 *     description: |
 *       Terminates the current user session by invalidating and clearing the JWT authentication
 *       cookie. After logging out, the user is redirected to the login page.
 *
 *       This endpoint also clears any session-related data stored on the server side
 *       for the current user.
 *     tags:
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       302:
 *         description: Logout successful, redirected to login page
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               description: HTTP-only cookie with cleared JWT token and immediate expiration
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/logout', (req, res) => {
  clearSessionCookie(res);
  res.clearCookie(MFA_CHALLENGE_COOKIE);
  res.clearCookie(MFA_SETUP_COOKIE);
  res.redirect('/login');
});

module.exports = router;
