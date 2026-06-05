const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const openaiService = require('../services/openaiService.js');
const ollamaService = require('../services/ollamaService.js');
const azureService = require('../services/azureService.js');
const documentModel = require('../models/document.js');
const AIServiceFactory = require('../services/aiServiceFactory');
const configFile = require('../config/config.js');
const documentsService = require('../services/documentsService.js');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { validateApiUrl, validateCustomFieldValue, shouldQueueForOcrOnAiError, classifyOcrQueueReasonFromAiError } = require('../services/serviceUtils');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const { authenticateJWT, isAuthenticated } = require('./auth.js');
const customService = require('../services/customService.js');
const mistralOcrService = require('../services/mistralOcrService');
const reconciliationService = require('../services/reconciliationService');
const { THUMBNAIL_CACHE_DIR, getThumbnailCachePath } = require('../services/thumbnailCachePaths');
const config = require('../config/config.js');
require('dotenv').config({ path: '../data/.env' });


function getCookieSecureMode() {
  return typeof config.getCookieSecureMode === 'function'
    ? config.getCookieSecureMode()
    : String(process.env.COOKIE_SECURE_MODE || 'auto').trim().toLowerCase();
}

function shouldUseSecureCookies(req) {
  const mode = getCookieSecureMode();

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

const SETTINGS_SECRET_FIELDS = [
  'PAPERLESS_API_TOKEN',
  'OPENAI_API_KEY',
  'CUSTOM_API_KEY',
  'AZURE_API_KEY',
  'OCR_API_KEY',
  'MISTRAL_API_KEY',
  'API_KEY'
];

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes === 0) {
    return '0 B';
  }

  const unitIndex = Math.min(Math.floor(Math.log(safeBytes) / Math.log(1024)), units.length - 1);
  const value = safeBytes / (1024 ** unitIndex);
  const decimals = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

async function getThumbnailCacheStats() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, { withFileTypes: true });
    let fileCount = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!/^\d+\.png$/i.test(entry.name)) {
        continue;
      }

      const filePath = path.join(THUMBNAIL_CACHE_DIR, entry.name);
      try {
        const stat = await fs.stat(filePath);
        totalBytes += stat.size;
        fileCount += 1;
      } catch (statError) {
        console.warn(`[WARN] Failed to read thumbnail cache file stats for ${filePath}:`, statError.message);
      }
    }

    return {
      fileCount,
      totalBytes,
      totalSizeHuman: formatBytes(totalBytes)
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        fileCount: 0,
        totalBytes: 0,
        totalSizeHuman: '0 B'
      };
    }
    throw error;
  }
}

async function clearThumbnailCache() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, { withFileTypes: true });
    let removedFiles = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+\.png$/i.test(entry.name)) {
        continue;
      }

      const filePath = path.join(THUMBNAIL_CACHE_DIR, entry.name);
      let fileSize = 0;

      try {
        const stat = await fs.stat(filePath);
        fileSize = stat.size;
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          console.warn(`[WARN] Failed to stat thumbnail file before delete ${filePath}:`, statError.message);
        }
      }

      try {
        await fs.unlink(filePath);
        removedFiles += 1;
        freedBytes += fileSize;
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          console.warn(`[WARN] Failed to delete thumbnail cache file ${filePath}:`, unlinkError.message);
        }
      }
    }

    return {
      removedFiles,
      freedBytes,
      freedSizeHuman: formatBytes(freedBytes)
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        removedFiles: 0,
        freedBytes: 0,
        freedSizeHuman: '0 B'
      };
    }
    throw error;
  }
}

async function removeThumbnailCacheForDocumentIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { removedFiles: 0, removedIds: [] };
  }

  const normalizedIds = ids
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id));

  if (normalizedIds.length === 0) {
    return { removedFiles: 0, removedIds: [] };
  }

  let removedFiles = 0;
  const removedIds = [];

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });

  for (const id of normalizedIds) {
    const thumbnailPath = path.join(THUMBNAIL_CACHE_DIR, `${id}.png`);
    try {
      await fs.unlink(thumbnailPath);
      removedFiles += 1;
      removedIds.push(id);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[WARN] Failed to delete cached thumbnail ${thumbnailPath}:`, error.message);
      }
    }
  }

  return { removedFiles, removedIds };
}

/**
 * Rate limiter for cache clearing operations
 * Prevents abuse of cache invalidation endpoints by limiting requests to 10 per 15 minutes per IP
 * 
 * @see https://github.com/admonstrator/paperless-ai-next/security/code-scanning/143
 */
const cacheClearLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    error: 'Too many cache clear requests. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  // Skip rate limiting for API key authenticated requests (trusted clients)
  skip: (req) => {
    const apiKey = req.headers['x-api-key'];
    const currentApiKey = config.getApiKey();
    return currentApiKey && apiKey && apiKey === currentApiKey;
  }
});


const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return renderLoginView(res, {
      error: 'Too many login attempts. Please wait a few minutes and try again.'
    });
  }
});

/**
 * @swagger
 * tags:
 *   - name: Authentication
 *     description: User authentication and authorization endpoints, including login, logout, and token management
 *   - name: Documents
 *     description: Document management and processing endpoints for interacting with Paperless-ngx documents
 *   - name: History
 *     description: Document processing history and tracking of AI-generated metadata
 *   - name: Navigation
 *     description: General navigation endpoints for the web interface
 *   - name: System
 *     description: System configuration, health checks, and administrative functions
 *   - name: Setup
 *     description: Application setup and configuration endpoints
 *   - name: Metadata
 *     description: Endpoints for managing document metadata like tags, correspondents, and document types
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: Error resetting documents
 *     User:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: User's username
 *         password:
 *           type: string
 *           format: password
 *           description: User's password (will be hashed)
 *     Document:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Document ID
 *           example: 123
 *         title:
 *           type: string
 *           description: Document title
 *           example: Invoice #12345
 *         tags:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of tag IDs
 *           example: [1, 4, 7]
 *         correspondent:
 *           type: integer
 *           description: Correspondent ID
 *           example: 5
 *     HistoryItem:
 *       type: object
 *       properties:
 *         document_id:
 *           type: integer
 *           description: Document ID
 *           example: 123
 *         title:
 *           type: string
 *           description: Document title
 *           example: Invoice #12345
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Date and time when the processing occurred
 *         tags:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Tag'
 *         correspondent:
 *           type: string
 *           description: Document correspondent name
 *           example: Acme Corp
 *         link:
 *           type: string
 *           description: Link to the document in Paperless-ngx
 *     Tag:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Tag ID
 *           example: 5
 *         name:
 *           type: string
 *           description: Tag name
 *           example: Invoice
 *         color:
 *           type: string
 *           description: Tag color (hex code)
 *           example: "#FF5733"
 */

// API endpoints that should not redirect
const API_ENDPOINTS = ['/health'];
// Routes that don't require authentication
let PUBLIC_ROUTES = [
  '/health',
  '/login',
  '/logout',
  '/setup',
  '/api/setup'
];

/**
 * Returns true if the incoming request originates from localhost.
 * Uses req.socket.remoteAddress (direct TCP connection IP) rather than
 * req.ip to remain resistant to X-Forwarded-For spoofing even when
 * trust proxy is enabled.
 */
function isLocalRequest(req) {
  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr) {
    return false;
  }

  return (
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr === '::ffff:127.0.0.1'
  );
}

/**
 * SECURITY GUARD: Blocks remote access to setup endpoints while the
 * initial setup is still pending (CWE-306 / GHSA-v4jq-65q5-wgjp).
 *
 * Rules (evaluated in order):
 *  1. Non-setup paths pass through unconditionally.
 *  2. Once setup is complete, the guard is lifted unconditionally.
 *  3. ALLOW_REMOTE_SETUP=yes grants explicit opt-in for remote access.
 *  4. Requests from localhost are always allowed.
 *  5. All other remote requests receive HTTP 403.
 */
router.use(async (req, res, next) => {
  const isSetupPath =
    req.path === '/setup' ||
    req.path.startsWith('/setup/') ||
    req.path.startsWith('/api/setup');

  if (!isSetupPath) {
    return next();
  }

  try {
    const setupOpen = await isInitialSetupOpen();
    if (!setupOpen) {
      // Setup already complete — no restriction needed
      return next();
    }
  } catch {
    // Fail-open here: let the next middleware handle setup-state errors
    return next();
  }

  if (process.env.ALLOW_REMOTE_SETUP === 'yes') {
    return next();
  }

  if (isLocalRequest(req)) {
    return next();
  }

  // Remote client on an open fresh instance — block
  const isApiPath = req.path.startsWith('/api/setup');
  if (isApiPath) {
    return res.status(403).json({
      success: false,
      error:
        'Remote access to the setup API is disabled. ' +
        'Set ALLOW_REMOTE_SETUP=yes to enable it, or complete setup from localhost.'
    });
  }

  return res
    .status(403)
    .type('text/html')
    .send(
      '<html><head><title>Setup Restricted</title></head><body>' +
        '<h1>403 – Remote Setup Access Denied</h1>' +
        '<p>Initial setup is only accessible from localhost by default.</p>' +
        '<p>Set <code>ALLOW_REMOTE_SETUP=yes</code> to enable remote access, ' +
        'or connect from the machine running paperless-ai-next.</p>' +
        '</body></html>'
    );
});

// Combined middleware to check authentication and setup
router.use(async (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];
  const currentApiKey = config.getApiKey();
  const jwtSecret = config.getJwtSecret();

  // Public route check
  if (PUBLIC_ROUTES.some(route => req.path.startsWith(route))) {
    return next();
  }

  // API key authentication
  if (currentApiKey && apiKey && apiKey === currentApiKey) {
    req.user = { apiKey: true };
  } else {
    // Fallback to JWT authentication
    if (!jwtSecret) {
      return res.status(500).send('Server misconfiguration: JWT secret missing');
    }

    if (!token) {
      return res.redirect('/login');
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
    } catch (error) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
  }

  // Setup check
  try {
    const isConfigured = await setupService.isConfigured();
 
    if (!isConfigured && (!process.env.PAPERLESS_AI_INITIAL_SETUP || process.env.PAPERLESS_AI_INITIAL_SETUP === 'no') && !req.path.startsWith('/setup')) {
      return res.redirect('/setup');
    } else if (!isConfigured && process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes' && !req.path.startsWith('/settings')) {
      return res.redirect('/settings');
    }
  } catch (error) {
    console.error('Error checking setup configuration:', error);
    return res.status(500).send('Internal Server Error');
  }
  
  next();
});

// Protected route middleware for API endpoints
const protectApiRoute = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const jwtSecret = config.getJwtSecret();

  if (!jwtSecret) {
    return res.status(500).json({ message: 'Server misconfiguration: JWT secret missing' });
  }
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

/**
 * @swagger
 * /login:
 *   get:
 *     summary: Render login page or redirect to setup if no users exist
 *     description: |
 *       Serves the login page for user authentication to the Paperless-AI next application.
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
const MFA_CHALLENGE_COOKIE = 'mfa_challenge';
const MFA_SETUP_COOKIE = 'mfa_setup';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

function decodeBase32Secret(secret) {
  const normalized = String(secret || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

  if (!normalized) {
    return null;
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';

  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      return null;
    }
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

function generateTotpToken(secret, unixTimeSeconds) {
  const key = decodeBase32Secret(secret);
  if (!key) {
    return null;
  }

  const counter = Math.floor(unixTimeSeconds / TOTP_STEP_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function generateBase32Secret(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  let output = '';

  for (let i = 0; i < length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }

  return output;
}

function buildOtpAuthUri(secret, username) {
  const issuer = 'Paperless-AI next';
  const accountLabel = `${issuer}:${username}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });

  return `otpauth://totp/${encodeURIComponent(accountLabel)}?${params.toString()}`;
}

function getAuthenticatedSettingsUsername(req) {
  if (!req.user || req.user.apiKey) {
    return null;
  }

  if (typeof req.user.username === 'string' && req.user.username.trim()) {
    return req.user.username.trim();
  }

  return null;
}

function verifyTotpToken(secret, inputToken) {
  const normalizedInput = String(inputToken || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(normalizedInput)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const expected = generateTotpToken(secret, now + offset * TOTP_STEP_SECONDS);
    if (!expected || expected.length !== normalizedInput.length) {
      continue;
    }

    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalizedInput))) {
      return true;
    }
  }

  return false;
}

function renderLoginView(res, options = {}) {
  return res.render('login', {
    error: options.error || null,
    mfaRequired: Boolean(options.mfaRequired),
    username: options.username || ''
  });
}

function isMfaEnabledForUser(user) {
  return Boolean(user && (user.mfa_enabled || user.mfaEnabled));
}

router.get('/login', (req, res) => {
  //check if a user exists beforehand
  documentModel.getUsers().then((users) => {
    if(users.length === 0) {
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
      return res.status(500).render('login', { error: 'Server misconfiguration: JWT secret missing' });
    }

    if (submittingMfaStep) {
      if (!mfaToken || !String(mfaToken).trim()) {
        return renderLoginView(res, {
          error: 'Authentication code is required.',
          mfaRequired: true,
          username
        });
      }

      const mfaChallengeToken = req.cookies[MFA_CHALLENGE_COOKIE];
      if (!mfaChallengeToken) {
        return renderLoginView(res, {
          error: 'Your verification session expired. Please sign in again.'
        });
      }

      let challengePayload;
      try {
        challengePayload = jwt.verify(mfaChallengeToken, jwtSecret);
        if (challengePayload.challengeType !== 'mfa-login') {
          throw new Error('Invalid challenge type');
        }
      } catch (challengeError) {
        res.clearCookie(MFA_CHALLENGE_COOKIE);
        return renderLoginView(res, {
          error: 'Your verification session expired. Please sign in again.'
        });
      }

      const user = await documentModel.getUser(challengePayload.username);
      const mfaSecret = user?.mfa_secret;

      if (!user || !isMfaEnabledForUser(user) || !mfaSecret) {
        res.clearCookie(MFA_CHALLENGE_COOKIE);
        return renderLoginView(res, {
          error: 'MFA is not configured for this user. Please sign in again.'
        });
      }

      if (!verifyTotpToken(mfaSecret, mfaToken)) {
        return renderLoginView(res, {
          error: 'Invalid authentication code. Please try again.',
          mfaRequired: true,
          username: challengePayload.username
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username
        },
        jwtSecret,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000
      });
      res.clearCookie(MFA_CHALLENGE_COOKIE);
      return res.redirect('/dashboard');
    }

    console.log('Login attempt for user:', username);
    const user = await documentModel.getUser(username);

    if (!user || !user.password) {
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
            challengeType: 'mfa-login'
          },
          jwtSecret,
          { expiresIn: '5m' }
        );
        res.cookie(MFA_CHALLENGE_COOKIE, challengeToken, {
          httpOnly: true,
          secure: shouldUseSecureCookies(req),
          sameSite: 'lax',
          path: '/'
        });

        return renderLoginView(res, {
          mfaRequired: true,
          username: user.username
        });
      }

      const token = jwt.sign(
        { 
          id: user.id, 
          username: user.username 
        },
        jwtSecret,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax', 
        path: '/',
        maxAge: 24 * 60 * 60 * 1000 
      });

      return res.redirect('/dashboard');
    }else{
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
  res.clearCookie('jwt');
  res.clearCookie(MFA_CHALLENGE_COOKIE);
  res.clearCookie(MFA_SETUP_COOKIE);
  res.redirect('/login');
});

/**
 * @swagger
 * /sampleData/{id}:
 *   get:
 *     summary: Get sample data for a document
 *     description: |
 *       Retrieves sample data extracted from a document, including processed text content
 *       and any metadata that has been extracted or processed by the AI.
 *       
 *       This endpoint is commonly used for previewing document data in the UI before
 *       completing document processing or updating metadata.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Document ID to retrieve sample data for
 *         example: 123
 *     responses:
 *       200:
 *         description: Document sample data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: Extracted text content from the document
 *                   example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *                 metadata:
 *                   type: object
 *                   description: Any metadata that has been extracted from the document
 *                   properties:
 *                     title:
 *                       type: string
 *                       example: "Acme Corp Invoice - August 2023"
 *                     tags:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["Invoice", "Finance"]
 *                     correspondent:
 *                       type: string
 *                       example: "Acme Corp"
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Document not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/sampleData/:id', async (req, res) => {
  try {
    //get all correspondents from one document by id
    const document = await paperlessService.getDocument(req.params.id);
    const correspondents = await paperlessService.getCorrespondentsFromDocument(document.id);

  } catch (error) {
    console.error('[ERRO] loading sample data:', error);
    res.status(500).json({ error: 'Error loading sample data' });
  }
});

// Documents view route
/**
 * @swagger
 * /playground:
 *   get:
 *     summary: AI playground testing environment
 *     description: |
 *       Renders the AI playground page for experimenting with document analysis.
 *       
 *       This interactive environment allows users to test different AI providers and prompts
 *       on document content without affecting the actual document processing workflow.
 *       Users can paste document text, customize prompts, and see raw AI responses
 *       to better understand how the AI models analyze document content.
 *       
 *       The playground is useful for fine-tuning prompts and testing AI capabilities
 *       before applying them to actual document processing.
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Playground page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the AI playground interface
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/playground', protectApiRoute, async (req, res) => {
  try {
    res.render('playground', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
    });
  } catch (error) {
    console.error('[ERROR] loading documents view:', error);
    res.status(500).send('Error loading documents');
  }
});

router.get('/api/playground/bootstrap', protectApiRoute, async (req, res) => {
  try {
    const {
      documents,
      tagNames,
      correspondentNames
    } = await documentsService.getDocumentsWithMetadata();

    res.json({
      success: true,
      documents,
      tagNames,
      correspondentNames
    });
  } catch (error) {
    console.error('[ERROR] loading playground bootstrap data:', error);
    res.status(500).json({
      success: false,
      error: 'Error loading playground data'
    });
  }
});

// Compatibility endpoint for omnibox document search used by Manual/OCR views.
/**
 * @swagger
 * /api/chat/documents:
 *   get:
 *     summary: Search recent documents for omnibox selectors
 *     description: Returns recent documents filtered by query for Manual/OCR document selectors.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Free-text query matched against document id, title, and correspondent name.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 100
 *         description: Maximum number of documents returned.
 *     responses:
 *       200:
 *         description: Matching documents loaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     documents:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           title:
 *                             type: string
 *                           created:
 *                             type: string
 *                             nullable: true
 *                           correspondent:
 *                             type: string
 *       500:
 *         description: Server error
 */
router.get('/api/chat/documents', isAuthenticated, async (req, res) => {
  try {
    const query = String(req.query?.q || '').trim().toLowerCase();
    const requestedLimit = Number.parseInt(String(req.query?.limit || '100'), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;

    const {
      documents,
      correspondentNames
    } = await documentsService.getDocumentsWithMetadata(limit);

    const normalizedDocuments = (Array.isArray(documents) ? documents : []).map((doc) => {
      const correspondentId = Number(doc?.correspondent);
      const correspondentName = Number.isInteger(correspondentId)
        ? (correspondentNames?.[correspondentId] || '')
        : '';

      return {
        id: doc?.id,
        title: doc?.title || '',
        created: doc?.created || doc?.created_date || doc?.added || null,
        correspondent: correspondentName
      };
    });

    const filteredDocuments = query
      ? normalizedDocuments.filter((doc) => {
        const idMatches = String(doc.id || '').includes(query);
        const titleMatches = String(doc.title || '').toLowerCase().includes(query);
        const correspondentMatches = String(doc.correspondent || '').toLowerCase().includes(query);
        return idMatches || titleMatches || correspondentMatches;
      })
      : normalizedDocuments;

    return res.json({
      success: true,
      data: {
        documents: filteredDocuments.slice(0, limit)
      }
    });
  } catch (error) {
    console.error('[ERROR] GET /api/chat/documents:', error);
    return res.status(500).json({
      success: false,
      error: 'Error loading chat documents'
    });
  }
});

/**
 * @swagger
 * /api/playground/bootstrap:
 *   get:
 *     summary: Get playground bootstrap data
 *     description: Returns documents and metadata required to initialize the AI playground UI.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Playground bootstrap data loaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 documents:
 *                   type: array
 *                   items:
 *                     type: object
 *                 tagNames:
 *                   type: array
 *                   items:
 *                     type: string
 *                 correspondentNames:
 *                   type: array
 *                   items:
 *                     type: string
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /thumb/{documentId}:
 *   get:
 *     summary: Get document thumbnail
 *     description: |
 *       Retrieves the thumbnail image for a specific document from the Paperless-ngx system.
 *       This endpoint proxies the request to the Paperless-ngx API and returns the thumbnail
 *       image for display in the UI.
 *       
 *       The thumbnail is returned as an image file in the format provided by Paperless-ngx,
 *       typically JPEG or PNG.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the document to retrieve thumbnail for
 *         example: 123
 *     responses:
 *       200:
 *         description: Thumbnail retrieved successfully
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Document or thumbnail not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Thumbnail not found"
 *       500:
 *         description: Server error or Paperless-ngx connection failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/thumb/:documentId', isAuthenticated, async (req, res) => {
  const documentId = req.params.documentId;

  // Validate documentId to prevent path traversal
  if (!/^\d+$/.test(documentId)) {
    return res.status(400).send('Invalid document ID');
  }

  const cachePath = getThumbnailCachePath(documentId);

  try {
    try {
      await fs.access(cachePath);
      console.log('Serving cached thumbnail');

      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(cachePath);
    } catch (cacheError) {
      if (cacheError.code !== 'ENOENT') {
        console.warn(`[WARN] Failed to access thumbnail cache file ${cachePath}:`, cacheError.message);
      }

      console.log('Thumbnail not cached, fetching from Paperless');

      const thumbnailData = await paperlessService.getThumbnailImage(req.params.documentId);

      if (!thumbnailData) {
        return res.status(404).send('Thumbnail not found');
      }

      await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
      await fs.writeFile(cachePath, thumbnailData);

      res.setHeader('Content-Type', 'image/png');
      return res.send(thumbnailData);
    }
  } catch (error) {
    console.error('[ERROR] while fetching thumbnail:', error);
    return res.status(500).send('Failed to load thumbnail');
  }
});


/**
 * @swagger
 * /history:
 *   get:
 *     summary: Document history page
 *     description: |
 *       Renders the document history page with filtering options.
 *       This page displays a list of all documents that have been processed by Paperless-AI,
 *       showing the changes made to the documents through AI processing.
 *       
 *       The page includes filtering capabilities by correspondent, tag, and free text search,
 *       allowing users to easily find specific documents or categories of processed documents.
 *       Each entry includes links to the original document in Paperless-ngx.
 *     tags:
 *       - History
 *       - Navigation
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: History page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the history page with filtering controls and document list
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/history', async (req, res) => {
  try {
    // Don't preload data - let the frontend load it with progress tracking
    // This allows the page to render immediately
    res.render('history', {
      version: configFile.PAPERLESS_AI_VERSION,
      filters: {
        allTags: [],  // Will be loaded by JavaScript via /api/history/load-progress
        allCorrespondents: []  // Will be populated when DataTable loads
      }
    });
  } catch (error) {
    console.error('[ERROR] loading history page:', error);
    res.status(500).send('Error loading history page');
  }
});

/**
 * @swagger
 * /api/history:
 *   get:
 *     summary: Get processed document history
 *     description: |
 *       Returns a paginated list of documents that have been processed by Paperless-AI.
 *       Supports filtering by tag, correspondent, and search term.
 *       Designed for integration with DataTables jQuery plugin.
 *       
 *       This endpoint provides comprehensive information about each processed document,
 *       including its metadata before and after AI processing, allowing users to track
 *       changes made by the system.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: draw
 *         schema:
 *           type: integer
 *         description: Draw counter for DataTables (prevents XSS)
 *         example: 1
 *       - in: query
 *         name: start
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Starting record index for pagination
 *         example: 0
 *       - in: query
 *         name: length
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of records to return per page
 *         example: 10
 *       - in: query
 *         name: search[value]
 *         schema:
 *           type: string
 *         description: Global search term (searches title, correspondent and tags)
 *         example: "invoice"
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *         description: Filter by tag ID
 *         example: "5"
 *       - in: query
 *         name: correspondent
 *         schema:
 *           type: string
 *         description: Filter by correspondent name
 *         example: "Acme Corp"
 *       - in: query
 *         name: order[0][column]
 *         schema:
 *           type: integer
 *         description: Index of column to sort by (0=document_id, 1=title, etc.)
 *         example: 1
 *       - in: query
 *         name: order[0][dir]
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort direction (ascending or descending)
 *         example: "desc"
 *     responses:
 *       200:
 *         description: Document history returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 draw:
 *                   type: integer
 *                   description: Echo of the draw parameter
 *                   example: 1
 *                 recordsTotal:
 *                   type: integer
 *                   description: Total number of records in the database
 *                   example: 100
 *                 recordsFiltered:
 *                   type: integer
 *                   description: Number of records after filtering
 *                   example: 20
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       document_id:
 *                         type: integer
 *                         description: Document ID
 *                         example: 123
 *                       title:
 *                         type: string
 *                         description: Document title
 *                         example: "Invoice #12345"
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date and time when the processing occurred
 *                         example: "2023-07-15T14:30:45Z"
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                               example: 5
 *                             name:
 *                               type: string
 *                               example: "Invoice"
 *                             color:
 *                               type: string
 *                               example: "#FF5733"
 *                       correspondent:
 *                         type: string
 *                         description: Document correspondent name
 *                         example: "Acme Corp"
 *                       link:
 *                         type: string
 *                         description: Link to the document in Paperless-ngx
 *                         example: "http://paperless.example.com/documents/123/"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error loading history data"
 */
/**
 * @swagger
 * /api/history/load-progress:
 *   get:
 *     summary: Load history data with progress updates (Server-Sent Events)
 *     description: |
 *       Preloads history and tag data with real-time progress updates via SSE.
 *       This endpoint should be called before displaying the history table to warm up the cache.
 *       Requires authentication via JWT token or API key.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Loading in progress (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"progress","percentage":10,"message":"Loading history entries..."}
 *                 
 *                 data: {"type":"complete","message":"Loaded 150 documents with 25 tags","count":150}
 *       401:
 *         description: Unauthorized - authentication required
 */
router.get('/api/history/load-progress', isAuthenticated, async (req, res) => {
  try {
    // Check if force reload is requested (bypass cache)
    const forceReload = req.query.force === 'true';
    
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Helper function to send and flush immediately
    const sendProgress = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush(); // Force immediate send
    };

    // Step 1: Start
    sendProgress({ 
      type: 'progress', 
      percentage: 0, 
      step: 1,
      totalSteps: 3,
      message: forceReload ? 'Force reloading filters...' : 'Connecting to database...' 
    });
    
    // Small delay to ensure first message is received
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Step 2: Load filter data only (not all documents)
    sendProgress({ 
      type: 'progress', 
      percentage: 10, 
      step: 1,
      totalSteps: 2,
      message: forceReload ? 'Force loading tags from Paperless...' : 'Loading tags from Paperless...' 
    });
    
    // Load tags from centralized cache
    const allTags = await paperlessService.getTags();
    
    sendProgress({ 
      type: 'progress', 
      percentage: 50, 
      step: 1,
      totalSteps: 2,
      message: `Loaded ${allTags.length} tags`,
      details: { tags: allTags.length }
    });
    
    // Step 3: Load correspondents from DB (fast query)
    sendProgress({ 
      type: 'progress', 
      percentage: 70, 
      step: 2,
      totalSteps: 2,
      message: 'Loading correspondents...' 
    });
    
    const allCorrespondents = await documentModel.getDistinctCorrespondents();
    const docCount = await documentModel.getHistoryDocumentsCount();
    
    // Step 4: Complete with filter data
    sendProgress({ 
      type: 'complete', 
      message: `Ready: ${docCount} documents with ${allTags.length} tags`,
      count: docCount,
      details: { documents: docCount, tags: allTags.length },
      filters: {
        tags: allTags,
        correspondents: allCorrespondents
      }
    });
    
    res.end();
  } catch (error) {
    console.error('[ERROR] loading history with progress:', error);
    if (res.headersSent) {
      const errorData = `data: ${JSON.stringify({ type: 'error', message: 'Error loading history' })}\n\n`;
      res.write(errorData);
      if (res.flush) res.flush();
    } else {
      res.status(500).json({ error: 'Error loading history' });
    }
    res.end();
  }
});

// No local tag cache needed - using centralized cache in paperlessService

router.get('/api/history', isAuthenticated, async (req, res) => {
  try {
    const draw = parseInt(req.query.draw);
    const start = parseInt(req.query.start) || 0;
    const length = parseInt(req.query.length) || 10;
    const search = req.query.search?.value || '';
    const tagFilter = req.query.tag || '';
    const correspondentFilter = req.query.correspondent || '';

    // Get sort parameters
    let sortColumn = 'created_at';
    let sortDir = 'desc';
    if (req.query.order && req.query.order[0]) {
      const order = req.query.order[0];
      sortColumn = req.query.columns[order.column].data;
      sortDir = order.dir;
    }

    // Use SQL-based pagination with filtering
    const docs = await documentModel.getHistoryPaginated({
      search,
      tagFilter,
      correspondentFilter,
      sortColumn,
      sortDir,
      limit: length,
      offset: start
    });

    // Get total counts
    const totalCount = await documentModel.getHistoryDocumentsCount();
    const filteredCount = await documentModel.getHistoryCountFiltered({
      search,
      tagFilter,
      correspondentFilter
    });

    // Get tags from centralized cache
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));
    // Format documents with tag resolution
    const formattedDocs = docs.map(doc => {
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds.map(id => tagMap.get(parseInt(id))).filter(Boolean);
      resolvedTags.sort((a, b) => a.name.localeCompare(b.name));

      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags,
        correspondent: doc.correspondent || 'Not assigned',
        link: `/dashboard/doc/${doc.document_id}`
      };
    });

    res.json({
      draw: draw,
      recordsTotal: totalCount,
      recordsFiltered: filteredCount,
      data: formattedDocs
    });
  } catch (error) {
    console.error('[ERROR] loading history data:', error);
    res.status(500).json({ error: 'Error loading history data' });
  }
});

/**
 * @swagger
 * /api/reset-all-documents:
 *   post:
 *     summary: Reset all processed documents
 *     description: |
 *       Deletes all processing records from the database, allowing documents to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Paperless-AI.
 *       
 *       This operation can be useful when changing AI models or prompts, as it allows reprocessing
 *       all documents with the updated configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: All documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error resetting documents"
 */
/**
 * @swagger
 * /api/history/clear-cache:
 *   post:
 *     summary: Clear tag cache
 *     description: Forces cache invalidation to load fresh filter data on next request
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Cache cleared successfully"
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error
 *       429:
 *         description: Too many requests - rate limit exceeded
 */
router.post('/api/history/clear-cache', isAuthenticated, cacheClearLimiter, async (req, res) => {
  try {
    // Clear centralized tag cache
    paperlessService.clearTagCache();
    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('[ERROR] clearing cache:', error);
    res.status(500).json({ error: 'Error clearing cache' });
  }
});

/**
 * @swagger
 * /api/history/{id}/detail:
 *   get:
 *     summary: Get detailed history entry data
 *     description: Returns full stored AI output details and a live diff view against current Paperless metadata.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Detailed history data returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: No history entry found
 *       500:
 *         description: Server error
 */
router.get('/api/history/:id/detail', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }

    const [history, metrics, allTags] = await Promise.all([
      documentModel.getHistoryByDocumentId(documentId),
      documentModel.getMetricsByDocumentId(documentId),
      paperlessService.getTags()
    ]);

    if (!history) {
      return res.status(404).json({ success: false, error: 'No history entry found for this document' });
    }

    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));
    const historyTagIds = JSON.parse(history.tags || '[]').map(id => parseInt(id));

    // Try to fetch live document for tag diff
    let liveTagIds = null;
    try {
      const liveDoc = await paperlessService.getDocument(documentId);
      liveTagIds = (liveDoc.tags || []).map(id => parseInt(id));
    } catch (e) {
      console.warn(`[WARN] Could not fetch live document ${documentId} for diff:`, e.message);
    }

    // Build AI-set tag list with live diff status
    const aiTags = historyTagIds.map(id => {
      const tag = tagMap.get(id);
      if (!tag) return { id, name: `Tag #${id}`, color: '#999999', status: 'unknown' };
      const status = liveTagIds === null ? 'unknown'
        : liveTagIds.includes(id) ? 'active' : 'removed';
      return { id: tag.id, name: tag.name, color: tag.color, status };
    });

    // Tags in Paperless that were NOT set by AI (added externally)
    const externalTags = liveTagIds
      ? liveTagIds
          .filter(id => !historyTagIds.includes(id))
          .map(id => {
            const tag = tagMap.get(id);
            return tag ? { id: tag.id, name: tag.name, color: tag.color, status: 'added_externally' } : null;
          })
          .filter(Boolean)
      : [];

    // Parse custom_fields safely
    let customFields = [];
    try {
      customFields = JSON.parse(history.custom_fields || '[]');
    } catch (e) {
      customFields = []; 
    }

    // Load original data for Restore feature
    const originalRow = await documentModel.getOriginalData(documentId);
    let originalData = null;
    if (originalRow) {
      originalData = {
        title:         originalRow.title,
        correspondent: originalRow.correspondent,
        tags:          JSON.parse(originalRow.tags || '[]'),
        documentType:  originalRow.document_type ?? null,
        language:      originalRow.language ?? null
      };
    }

    res.json({
      success: true,
      document_id: documentId,
      history: {
        title:              history.title,
        correspondent:      history.correspondent,
        custom_fields:      customFields,
        document_type_name: history.document_type_name ?? null,
        language:           history.language ?? null,
        created_at:         history.created_at
      },
      tags: {
        aiSet:         aiTags,
        external:      externalTags,
        liveAvailable: liveTagIds !== null
      },
      metrics: metrics ? {
        promptTokens:     metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        totalTokens:      metrics.totalTokens
      } : null,
      original: originalData,
      link: `/dashboard/doc/${documentId}`
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/detail:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/{id}/restore:
 *   post:
 *     summary: Restore document to pre-AI state
 *     description: Restores title, tags, correspondent and related metadata from saved original values.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Document restored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: Original data not found
 *       500:
 *         description: Server error
 */
router.post('/api/history/:id/restore', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }

    const originalRow = await documentModel.getOriginalData(documentId);
    if (!originalRow) {
      return res.status(404).json({ success: false, error: 'No original data found for this document' });
    }

    // Parse and sanitise — SQLite stores IDs as TEXT which can come back
    // as float-strings (e.g. '593.0') if they were originally stored as
    // a JS number that went through JSON serialisation. Paperless-ngx
    // requires proper integers; parseInt handles both '593', '593.0' and 593.
    const rawCorrespondent = originalRow.correspondent;
    const rawDocType       = originalRow.document_type;

    const original = {
      tags:          JSON.parse(originalRow.tags || '[]').map(id => parseInt(id, 10)).filter(id => !isNaN(id)),
      title:         originalRow.title,
      correspondent: rawCorrespondent != null ? parseInt(rawCorrespondent, 10) || null : null,
      documentType:  rawDocType       != null ? parseInt(rawDocType,       10) || null : null,
      language:      originalRow.language ?? null
    };

    const result = await paperlessService.restoreDocument(documentId, original);
    if (!result) {
      return res.status(500).json({ success: false, error: 'Failed to restore document in Paperless-ngx' });
    }

    res.json({ success: true, message: 'Document restored to its original state.' });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/restore:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/{id}/rescan:
 *   post:
 *     summary: Reset one document for reprocessing
 *     description: Removes all tracking records for a document so it is processed again in a subsequent scan.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Document reset for rescanning
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid document ID
 *       500:
 *         description: Server error
 */
router.post('/api/history/:id/rescan', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }

    await documentModel.deleteDocumentsIdList([documentId]);

    res.json({
      success: true,
      message: 'Dokument wurde zurückgesetzt und wird beim nächsten Scan erneut verarbeitet.'
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/rescan:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/settings/clear-tag-cache:
 *   post:
 *     summary: Manually clear the centralized tag cache
 *     description: Forces the tag cache to refresh on next access. Useful after external tag modifications.
 *     tags:
 *       - Settings
 *     security:
 *       - ApiKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - authentication required
 *       429:
 *         description: Too many requests - rate limit exceeded (max 10 requests per 15 minutes)
 *       500:
 *         description: Server error
 */
router.post('/api/settings/clear-tag-cache', isAuthenticated, cacheClearLimiter, async (req, res) => {
  try {
    paperlessService.clearTagCache();
    console.log('[INFO] Tag cache cleared manually by user');
    res.json({ 
      success: true, 
      message: 'Tag cache cleared successfully. Cache will refresh on next use.' 
    });
  } catch (error) {
    console.error('[ERROR] clearing tag cache:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to clear tag cache' 
    });
  }
});

/**
 * @swagger
 * /api/settings/thumbnail-cache:
 *   get:
 *     summary: Get thumbnail cache statistics
 *     description: Returns current thumbnail cache count and total size from local cache storage.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Thumbnail cache stats retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     fileCount:
 *                       type: integer
 *                     totalBytes:
 *                       type: integer
 *                     totalSizeHuman:
 *                       type: string
 *       500:
 *         description: Server error
 */
router.get('/api/settings/thumbnail-cache', isAuthenticated, async (req, res) => {
  try {
    const stats = await getThumbnailCacheStats();
    return res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('[ERROR] reading thumbnail cache stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to read thumbnail cache stats'
    });
  }
});

/**
 * @swagger
 * /api/settings/thumbnail-cache/clear:
 *   post:
 *     summary: Clear thumbnail cache
 *     description: Deletes all cached thumbnail PNG files from local cache storage and returns cleanup stats.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Thumbnail cache cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 removedFiles:
 *                   type: integer
 *                 freedBytes:
 *                   type: integer
 *                 freedSizeHuman:
 *                   type: string
 *                 remaining:
 *                   type: object
 *                   properties:
 *                     fileCount:
 *                       type: integer
 *                     totalBytes:
 *                       type: integer
 *                     totalSizeHuman:
 *                       type: string
 *       429:
 *         description: Too many requests - rate limit exceeded
 *       500:
 *         description: Server error
 */
router.post('/api/settings/thumbnail-cache/clear', isAuthenticated, cacheClearLimiter, async (req, res) => {
  try {
    const cleanup = await clearThumbnailCache();
    const remaining = await getThumbnailCacheStats();

    return res.json({
      success: true,
      message: `Thumbnail cache cleared. Removed ${cleanup.removedFiles} files (${cleanup.freedSizeHuman}).`,
      removedFiles: cleanup.removedFiles,
      freedBytes: cleanup.freedBytes,
      freedSizeHuman: cleanup.freedSizeHuman,
      remaining
    });
  } catch (error) {
    console.error('[ERROR] clearing thumbnail cache:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to clear thumbnail cache'
    });
  }
});

/**
 * @swagger
 * /api/settings/reset-local-overrides:
 *   post:
 *     summary: Reset local runtime overrides
 *     description: |
 *       Removes local runtime override values so injected environment variables are used after restart.
 *       This operation is restricted to interactive user sessions and requires the current account password.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 description: Current password of the signed-in settings user
 *     responses:
 *       200:
 *         description: Override reset completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hadOverrides:
 *                   type: boolean
 *                 restart:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid password
 *       403:
 *         description: Forbidden - interactive session required
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */

router.post('/api/settings/reset-local-overrides', isAuthenticated, cacheClearLimiter, express.json(), async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({
        success: false,
        error: 'Reset local overrides requires a signed-in user session.'
      });
    }

    const currentPassword = String(req.body?.currentPassword || '').trim();
    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password is required.'
      });
    }

    const user = await documentModel.getUser(username);
    if (!user || !user.password) {
      return res.status(404).json({
        success: false,
        error: 'User not found.'
      });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Current password is invalid.'
      });
    }

    const hadOverrides = await setupService.clearRuntimeOverrides();

    res.json({
      success: true,
      hadOverrides,
      restart: true,
      message: hadOverrides
        ? 'Local runtime overrides have been removed. Restarting service to apply injected environment values.'
        : 'No local runtime overrides were found. Restarting service to reload injected environment values.'
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000);
  } catch (error) {
    console.error('[ERROR] resetting local runtime overrides:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset local runtime overrides'
    });
  }
});

/**
 * @swagger
 * /api/settings/reconcile-history:
 *   post:
 *     summary: Manually trigger history reconciliation (Server-Sent Events)
 *     description: |
 *       Triggers an immediate reconciliation pass that removes stale entries from the
 *       local AI database for documents that have been deleted in Paperless-ngx.
 *       Uses Server-Sent Events (SSE) to stream real-time progress.
 *       Returns a single result event with the number of removed entries.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Reconciliation result (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"complete","removed":3,"durationMs":120}
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error during reconciliation
 */
router.post('/api/settings/reconcile-history', isAuthenticated, cacheClearLimiter, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Starting reconciliation...' })}\n\n`);
    if (res.flush) res.flush();

    const result = await reconciliationService.reconcileAllDocuments();

    if (result && result.skipped) {
      res.write(`data: ${JSON.stringify({ type: 'complete', skipped: true, removed: 0, durationMs: result.durationMs || 0, message: 'Reconciliation skipped: a scan or reconciliation is already in progress.' })}\n\n`);
    } else {
      const removed = result ? result.removed : 0;
      const durationMs = result ? result.durationMs : 0;
      res.write(`data: ${JSON.stringify({ type: 'complete', skipped: false, removed, durationMs, message: removed > 0 ? `Removed ${removed} stale entries.` : 'No stale entries found.' })}\n\n`);
    }

    if (res.flush) res.flush();
    res.end();
  } catch (error) {
    console.error('[ERROR] manual reconciliation:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Reconciliation failed. Check server logs.' })}\n\n`);
      if (res.flush) res.flush();
      res.end();
    } catch (_) { /* client disconnected */ }
  }
});

router.post('/api/reset-all-documents', isAuthenticated, cacheClearLimiter, async (req, res) => {
  try {
    await documentModel.deleteAllDocuments();
    res.json({ success: true });
  }
  catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

/**
 * @swagger
 * /api/reset-documents:
 *   post:
 *     summary: Reset specific documents
 *     description: |
 *       Deletes processing records for specific documents, allowing them to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Paperless-AI.
 *       
 *       This operation is useful when you want to reprocess only selected documents after changes to
 *       the AI model, prompt, or document metadata configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of document IDs to reset
 *                 example: [123, 456, 789]
 *     responses:
 *       200:
 *         description: Documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid document IDs"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error resetting documents"
 */
router.post('/api/reset-documents', cacheClearLimiter, isAuthenticated, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'Invalid document IDs' });
    }

    await documentModel.deleteDocumentsIdList(ids);
    await removeThumbnailCacheForDocumentIds(ids);
    res.json({ success: true });
  }
  catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

/**
 * @swagger
 * /api/history/validate:
 *   get:
 *     summary: Validate history entries against Paperless-ngx (Server-Sent Events)
 *     description: |
 *       Checks each history entry stored locally and verifies the corresponding document still exists in Paperless-ngx.
 *       Uses Server-Sent Events (SSE) to stream real-time progress updates.
 *       Processes documents in parallel batches (50 at a time) for faster validation.
 *       Returns progress updates and final list of missing documents.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Validation in progress (SSE stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |
 *                 data: {"type":"progress","current":50,"total":100,"missing":3,"percentage":50}
 *                 
 *                 data: {"type":"complete","missing":[{"document_id":123,"title":"Test Doc"}]}
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Server error during validation
 */
router.get('/api/history/validate', isAuthenticated, async (req, res) => {
  try {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Get all history entries from local DB
    const allHistory = await documentModel.getAllHistory();
    const total = allHistory.length;
    
    // Send initial progress
    res.write(`data: ${JSON.stringify({ type: 'progress', current: 0, total, missing: 0 })}\n\n`);

    // Process documents in parallel batches for faster validation
    const missing = [];
    const BATCH_SIZE = 50; // Process 50 documents at a time
    let processed = 0;

    // Split into batches
    for (let i = 0; i < allHistory.length; i += BATCH_SIZE) {
      const batch = allHistory.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel
      const results = await Promise.allSettled(
        batch.map(async (h) => {
          try {
            await paperlessService.getDocument(h.document_id);
            return { success: true, doc: h };
          } catch (error) {
            return { success: false, doc: h };
          }
        })
      );
      
      // Collect missing documents from this batch
      results.forEach((result) => {
        if (result.status === 'fulfilled' && !result.value.success) {
          missing.push({ 
            document_id: result.value.doc.document_id, 
            title: result.value.doc.title || null 
          });
        }
      });
      
      processed += batch.length;
      
      // Send progress update after each batch
      res.write(`data: ${JSON.stringify({ 
        type: 'progress', 
        current: processed, 
        total, 
        missing: missing.length,
        percentage: Math.round((processed / total) * 100)
      })}\n\n`);
    }

    // Send final result
    res.write(`data: ${JSON.stringify({ type: 'complete', missing })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[ERROR] validating history:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Error validating history' })}\n\n`);
    res.end();
  }
});

/**
 * @swagger
 * /api/scan/now:
 *   post:
 *     summary: Trigger immediate document scan
 *     description: |
 *       Initiates an immediate scan of documents in Paperless-ngx that haven't been processed yet.
 *       This endpoint can be used to manually trigger processing without waiting for the scheduled interval.
 *       
 *       The scan will:
 *       - Connect to Paperless-ngx API
 *       - Fetch all unprocessed documents
 *       - Process each document with the configured AI service
 *       - Update documents in Paperless-ngx with generated metadata
 *       
 *       The process respects the function limitations set in the configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Scan trigger processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 started:
 *                   type: boolean
 *                 running:
 *                   type: boolean
 *                 stopRequested:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *       503:
 *         description: Scan control not ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error during document scan"
 */
router.post('/api/scan/now', isAuthenticated, async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(400).json({
        success: false,
        error: 'Setup not completed'
      });
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      return res.status(500).json({
        success: false,
        error: 'Failed to resolve Paperless user ID'
      });
    }

    const triggerScanNow = global.__paperlessAiTriggerScanNow;
    if (typeof triggerScanNow !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'Scan control is not available yet. Please try again in a moment.'
      });
    }

    const result = await triggerScanNow('api-manual');
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/now:', error);
    return res.status(500).json({
      success: false,
      error: 'Error during document scan trigger'
    });
  }
});

/**
 * @swagger
 * /api/scan/stop:
 *   post:
 *     summary: Request graceful stop for active scan
 *     description: |
 *       Requests a graceful stop of the currently running scan.
 *       The current document is allowed to finish processing before the scan exits.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Stop request processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 running:
 *                   type: boolean
 *                 stopRequested:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - authentication required
 */
router.post('/api/scan/stop', isAuthenticated, async (req, res) => {
  try {
    const requestScanStop = global.__paperlessAiRequestScanStop;
    const scanState = global.__paperlessAiScanControl || { running: false, stopRequested: false };

    if (typeof requestScanStop !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'Scan control is not available yet. Please try again in a moment.'
      });
    }

    const requested = requestScanStop();
    return res.json({
      success: true,
      running: Boolean(scanState.running),
      stopRequested: Boolean(scanState.stopRequested),
      message: requested
        ? 'Stop requested. The current document will finish before scan stops.'
        : 'No active scan to stop.'
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/stop:', error);
    return res.status(500).json({
      success: false,
      error: 'Error while requesting scan stop'
    });
  }
});

async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, customPrompt = null) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;

  const isFailed = await documentModel.isDocumentFailed(doc.id);
  if (isFailed) {
    console.log(`[DEBUG] Document ${doc.id} is marked as permanently failed, skipping until reset`);
    return null;
  }

  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
    console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
    return null;
  }else {
    console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
  }

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id)
  ]);

  if (!content || content.length < 10) {
    console.log(`[DEBUG] Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: 10), skipping analysis`);
    if (mistralOcrService.isEnabled()) {
      const added = await documentModel.addToOcrQueue(doc.id, doc.title, 'short_content_lt_10');
      if (added) {
        console.log(`[OCR] Document ${doc.id} queued for Mistral OCR (short_content)`);
      }
    } else {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(doc.id, doc.title, 'insufficient_content_lt_10', 'ai');
    }
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  // Prepare options for AI service
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes'
  };

  // Get external API data if enabled
  if (config.externalApiConfig.enabled === 'yes') {
    try {
      const externalApiService = require('../services/externalApiService');
      const externalData = await externalApiService.fetchData();
      if (externalData) {
        options.externalApiData = externalData;
        console.log('[DEBUG] Retrieved external API data for prompt enrichment');
      }
    } catch (error) {
      console.error('[ERROR] Failed to fetch external API data:', error.message);
    }
  }

  const aiService = AIServiceFactory.getService();
  let analysis;
  if(customPrompt) {
    console.log('[DEBUG] Starting document analysis with custom prompt');
    analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, customPrompt, options);
  }else{
    analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, null, options);
  }
  console.log('Repsonse from AI service:', analysis);
  if (analysis.error) {
    let queuedForOcr = false;
    if (mistralOcrService.isEnabled() && shouldQueueForOcrOnAiError(analysis.error)) {
      const queueReason = classifyOcrQueueReasonFromAiError(analysis.error);
      const added = await documentModel.addToOcrQueue(doc.id, doc.title, queueReason);
      if (added) {
        console.log(`[OCR] Document ${doc.id} queued for Mistral OCR (ai_failed: ${analysis.error})`);
      }
      queuedForOcr = true;
    }

    if (!mistralOcrService.isEnabled()) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(doc.id, doc.title, 'ai_failed_ocr_disabled', 'ai');
    } else if (!queuedForOcr) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(doc.id, doc.title, 'ai_failed_without_ocr_fallback', 'ai');
    }
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }
  await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
  return { analysis, originalData };
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};

  // Create options object with restriction settings
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes' ? true : false,
    restrictToExistingDocumentTypes: config.restrictToExistingDocumentTypes === 'yes' ? true : false
  };

  console.log(`[DEBUG] Building update data with restrictions: tags=${options.restrictToExistingTags}, correspondents=${options.restrictToExistingCorrespondents}, documentTypes=${options.restrictToExistingDocumentTypes}`);

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && config.addAIProcessedTag === 'yes') {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  // Only process title if title generation is activated
  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = analysis.document.title || doc.title;
  }

  // Add created date regardless of settings as it's a core field
  updateData.created = analysis.document.document_date || doc.created;

  // Only process document type if document type classification is activated
  if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type, options);
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }

  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];
    const customFieldsForHistory = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const customField of Object.values(customFields)) {
      if (!customField || typeof customField !== 'object') {
        console.log('[DEBUG] Skipping null/invalid custom field entry');
        continue;
      }

      if (!customField.field_name || (customField.value === null || customField.value === undefined || String(customField.value).trim() === '')) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(customField.field_name);
      if (fieldDetails?.id) {
        const validation = validateCustomFieldValue(customField.field_name, customField.value, fieldDetails.data_type);
        if (validation.skip) {
          if (validation.warn) console.warn(validation.warn);
          continue;
        }
        processedFields.push({
          field: fieldDetails.id,
          value: validation.value
        });
        customFieldsForHistory.push({
          field_name: customField.field_name,
          value: validation.value
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    // Then add any existing fields that weren't updated
    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
    if (customFieldsForHistory.length > 0) {
      updateData._customFieldsForHistory = customFieldsForHistory;
    }
  }

  // Only process correspondent if correspondent detection is activated
  if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  // Always include language if provided as it's a core field
  if (analysis.document.language) {
    updateData.language = analysis.document.language;
  }

  return updateData;
}

async function saveDocumentChanges(docId, updateData, analysis, originalData) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;
  
  const historyCustomFields = updateData._customFieldsForHistory || null;
  delete updateData._customFieldsForHistory;

  const historyDocTypeName = analysis.document.document_type ?? null;
  const historyLanguage    = analysis.document.language ?? null;
  const origDocType        = originalData.document_type ?? null;
  const origLanguage       = originalData.language ?? null;

  await Promise.all([
    documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle, origDocType, origLanguage),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title),
    documentModel.addOpenAIMetrics(
      docId, 
      analysis.metrics.promptTokens,
      analysis.metrics.completionTokens,
      analysis.metrics.totalTokens
    ),
    documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent, historyCustomFields, historyDocTypeName, historyLanguage)
  ]);
}

/**
 * @swagger
 * /api/key-regenerate:
 *   post:
 *     summary: Regenerate API key
 *     description: |
 *       Generates a new random API key for the application and updates the .env file.
 *       The previous API key will be invalidated immediately after generation.
 *       
 *       This API key can be used for programmatic access to the API endpoints
 *       by sending it in the `x-api-key` header of subsequent requests.
 *       
 *       **Security Notice**: This operation invalidates any existing API key.
 *       All systems using the previous key will need to be updated.
 *     tags:
 *       - System
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: API key regenerated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Indicates whether regeneration succeeded
 *                   example: true
 *                 newKey:
 *                   type: string
 *                   description: The newly generated API key
 *                   example: "3f7a8d6e2c1b5a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5"
 *       401:
 *         description: Unauthorized - JWT authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error regenerating API key"
 */
router.post('/api/key-regenerate', isAuthenticated, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dotenv = require('dotenv');
    const crypto = require('crypto');    
    const envPath = path.join(__dirname, '../data/', '.env');
    const legacyMode = String(process.env.CONFIG_SOURCE_MODE || 'runtime-first').trim().toLowerCase() === 'legacy';
    let envConfig = {};
    if (legacyMode && fs.existsSync(envPath)) {
      envConfig = dotenv.parse(fs.readFileSync(envPath));
    }

    // Generate a new API token
    const apiKey = crypto.randomBytes(32).toString('hex');
    envConfig.API_KEY = apiKey;

    if (legacyMode) {
      // Persist to legacy .env only in legacy mode
      const envContent = Object.entries(envConfig)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      fs.writeFileSync(envPath, envContent);
    }

    // Set runtime value for current process
    process.env.API_KEY = apiKey;
    await setupService.saveRuntimeOverrides({
      ...(await setupService.loadRuntimeOverrides()),
      API_KEY: apiKey
    });

    // Return response
    res.json({ success: true, newKey: apiKey });
  } catch (error) {
    console.error('API key regeneration error:', error);
    res.status(500).json({ error: 'Error regenerating API key' });
  }
});


const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
};

const SETUP_MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const setupMfaChallenges = new Map();

const DEFAULT_AI_PROVIDER_PRESETS = [
  {
    id: 'openai-default',
    label: 'OpenAI',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    tokenPlaceholder: 'sk-...'
  },
  {
    id: 'lmstudio-local',
    label: 'LM Studio (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-7b-instruct',
    tokenPlaceholder: 'lm-studio-token'
  },
  {
    id: 'ollama-local',
    label: 'Ollama',
    provider: 'ollama',
    apiUrl: 'http://localhost:11434',
    model: 'llama3.2',
    tokenPlaceholder: ''
  },
  {
    id: 'ionos-openai-compatible',
    label: 'IONOS (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'https://openai.inference.de-txl.ionos.com/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    tokenPlaceholder: 'ionos-api-key'
  }
];

function cleanupExpiredSetupMfaChallenges() {
  const now = Date.now();
  for (const [challengeId, challenge] of setupMfaChallenges.entries()) {
    if (now - challenge.createdAt > SETUP_MFA_CHALLENGE_TTL_MS) {
      setupMfaChallenges.delete(challengeId);
    }
  }
}

function normalizeSetupBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

function parseBooleanInput(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return defaultValue;
}

function getSetupUrlValidationOptions() {
  return {
    allowPrivateIPs: true,
    allowLocalhost: parseBooleanInput(process.env.PAPERLESS_AI_SETUP_ALLOW_LOCALHOST, false)
  };
}

function normalizeTagListInput(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDefaultScanInterval() {
  return process.env.SCAN_INTERVAL || '*/30 * * * *';
}

async function isInitialSetupOpen() {
  const [isEnvConfigured, users] = await Promise.all([
    setupService.isConfigured(),
    documentModel.getUsers()
  ]);

  const hasUsers = Array.isArray(users) && users.length > 0;
  return !(isEnvConfigured && hasUsers);
}

async function ensureSetupOpenOrRespond(res) {
  const setupOpen = await isInitialSetupOpen();
  if (!setupOpen) {
    res.status(403).json({
      success: false,
      error: 'Initial setup is already complete.'
    });
    return false;
  }

  return true;
}

function toEnvPreviewLines(config) {
  const previewKeys = [
    'PAPERLESS_API_URL',
    'PAPERLESS_API_TOKEN',
    'PAPERLESS_USERNAME',
    'PROCESS_PREDEFINED_DOCUMENTS',
    'TAGS',
    'IGNORE_TAGS',
    'ADD_AI_PROCESSED_TAG',
    'AI_PROCESSED_TAG_NAME',
    'DISABLE_AUTOMATIC_PROCESSING',
    'SCAN_INTERVAL',
    'AI_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OLLAMA_API_URL',
    'OLLAMA_MODEL',
    'CUSTOM_BASE_URL',
    'CUSTOM_API_KEY',
    'CUSTOM_MODEL',
    'AZURE_ENDPOINT',
    'AZURE_API_KEY',
    'AZURE_DEPLOYMENT_NAME',
    'AZURE_API_VERSION',
    'MISTRAL_OCR_ENABLED',
    'OCR_PROVIDER',
    'OCR_API_URL',
    'OCR_API_KEY',
    'MISTRAL_API_KEY',
    'MISTRAL_OCR_MODEL'
  ];

  return previewKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(config, key))
    .map((key) => `${key}=${config[key] == null ? '' : config[key]}`)
    .join('\n');
}

async function loadAiProviderPresets() {
  const presetsPath = path.join(process.cwd(), 'config', 'ai-provider-presets.json');

  try {
    const raw = await fs.readFile(presetsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed) ? parsed : parsed?.presets;

    if (!Array.isArray(source) || source.length === 0) {
      return DEFAULT_AI_PROVIDER_PRESETS;
    }

    return source
      .map((item, index) => ({
        id: String(item.id || `preset-${index + 1}`),
        label: String(item.label || item.name || `Preset ${index + 1}`),
        provider: String(item.provider || 'custom'),
        apiUrl: String(item.apiUrl || item.baseUrl || ''),
        model: String(item.model || ''),
        tokenPlaceholder: String(item.tokenPlaceholder || item.apiKeyPlaceholder || '')
      }))
      .filter((item) => ['openai', 'ollama', 'custom', 'azure'].includes(item.provider));
  } catch (error) {
    console.warn('[WARN] Could not load AI provider presets from config/ai-provider-presets.json:', error.message);
    return DEFAULT_AI_PROVIDER_PRESETS;
  }
}

async function validatePaperlessConnectionForSetup(paperlessUrl, paperlessToken) {
  const normalizedUrl = normalizeSetupBaseUrl(paperlessUrl);
  if (!normalizedUrl || !paperlessToken) {
    return {
      success: false,
      stage: 'input',
      message: 'Paperless API URL and API token are required.'
    };
  }

  const isReachable = await setupService.validatePaperlessConfig(normalizedUrl, paperlessToken);
  if (!isReachable) {
    return {
      success: false,
      stage: 'reachability',
      message: 'Paperless-ngx could not be reached with the provided URL and token.'
    };
  }

  const permissionResult = await setupService.validateApiPermissions(normalizedUrl, paperlessToken);
  if (!permissionResult.success) {
    return {
      success: false,
      stage: 'permissions',
      message: permissionResult.message || 'Paperless-ngx API permissions are insufficient.'
    };
  }

  return {
    success: true,
    stage: 'ok',
    message: 'Paperless-ngx connection and permissions are valid.'
  };
}

async function validateAiConnectionForSetup({ aiProvider, apiUrl, token, model, azureApiVersion }) {
  const provider = String(aiProvider || '').trim().toLowerCase();
  const normalizedApiUrl = String(apiUrl || '').trim();
  const normalizedToken = String(token || '').trim();
  const normalizedModel = String(model || '').trim();

  if (!provider || !['openai', 'ollama', 'custom', 'azure'].includes(provider)) {
    return {
      success: false,
      message: 'A valid AI provider is required.'
    };
  }

  if (provider === 'openai') {
    if (!normalizedToken) {
      return {
        success: false,
        message: 'An API token is required for OpenAI.'
      };
    }

    const valid = await setupService.validateOpenAIConfig(normalizedToken);
    return {
      success: valid,
      message: valid ? 'OpenAI credentials are valid.' : 'OpenAI test failed. Check token and network access.'
    };
  }

  if (provider === 'ollama') {
    if (!normalizedApiUrl || !normalizedModel) {
      return {
        success: false,
        message: 'API URL and model are required for Ollama.'
      };
    }

    const valid = await setupService.validateOllamaConfig(normalizedApiUrl, normalizedModel);
    return {
      success: valid,
      message: valid ? 'Ollama connection is valid.' : 'Ollama test failed. Check URL and model.'
    };
  }

  if (provider === 'azure') {
    if (!normalizedApiUrl || !normalizedToken || !normalizedModel) {
      return {
        success: false,
        message: 'Endpoint, token, and deployment/model are required for Azure.'
      };
    }

    const valid = await setupService.validateAzureConfig(
      normalizedToken,
      normalizedApiUrl,
      normalizedModel,
      azureApiVersion || '2023-05-15'
    );

    return {
      success: valid,
      message: valid ? 'Azure connection is valid.' : 'Azure test failed. Check endpoint, token, deployment, and API version.'
    };
  }

  if (!normalizedApiUrl || !normalizedModel) {
    return {
      success: false,
      message: 'API URL and model are required for custom providers.'
    };
  }

  const valid = await setupService.validateCustomConfig(normalizedApiUrl, normalizedToken, normalizedModel);
  return {
    success: valid,
    message: valid ? 'Custom provider connection is valid.' : 'Custom provider test failed. Check URL, optional token, and model.'
  };
}

async function validateOcrConnectionForSetup({ enabled, provider, apiUrl, apiKey, model }) {
  const normalizedEnabled = String(enabled ? 'yes' : 'no').trim().toLowerCase();
  if (normalizedEnabled !== 'yes') {
    return {
      success: true,
      message: 'OCR fallback is disabled.'
    };
  }

  const normalizedProviderInput = String(provider || 'mistral').trim().toLowerCase();
  const normalizedProvider = normalizedProviderInput === 'custom' ? 'ollama' : normalizedProviderInput;

  const valid = await setupService.validateOcrConfig({
    enabled: normalizedEnabled,
    provider: normalizedProvider,
    apiUrl: String(apiUrl || '').trim(),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim() || 'mistral-ocr-latest'
  });

  return {
    success: valid,
    message: valid
      ? 'OCR connection is valid.'
      : 'OCR connection test failed. Check OCR provider, OCR API URL, API key and model.'
  };
}

async function discoverAiModelsForSetup({ aiProvider, apiUrl, token }) {
  const provider = String(aiProvider || '').trim().toLowerCase();
  const normalizedApiUrl = String(apiUrl || '').trim();
  const normalizedToken = String(token || '').trim();

  const models = await setupService.discoverAiModels({
    provider,
    apiUrl: normalizedApiUrl,
    apiKey: normalizedToken
  });

  return {
    success: true,
    models,
    message: models.length > 0
      ? `Discovered ${models.length} model(s).`
      : 'No models discovered for this provider.'
  };
}

async function discoverOcrModelsForSetup({ provider, apiUrl, apiKey }) {
  const normalizedProvider = String(provider || 'mistral').trim().toLowerCase();
  const normalizedApiUrl = String(apiUrl || '').trim();
  const normalizedApiKey = String(apiKey || '').trim();

  const models = await setupService.discoverOcrModels({
    provider: normalizedProvider,
    apiUrl: normalizedApiUrl,
    apiKey: normalizedApiKey
  });

  return {
    success: true,
    models,
    message: models.length > 0
      ? `Discovered ${models.length} OCR model(s).`
      : 'No OCR models discovered for this provider.'
  };
}

/**
 * @swagger
 * /setup:
 *   get:
 *     summary: Application setup page
 *     description: |
 *       Renders the application setup page for initial configuration.
 *       
 *       This page allows configuring the connection to Paperless-ngx, AI services,
 *       and other application settings. It loads existing configuration if available
 *       and redirects to dashboard if setup is already complete.
 *       
 *       The setup page is the entry point for new installations and guides users through
 *       the process of connecting to Paperless-ngx, configuring AI providers, and setting up
 *       admin credentials.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     responses:
 *       200:
 *         description: Setup page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application setup page
 *       302:
 *         description: Redirects to dashboard if setup is already complete
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/dashboard"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Helper: Sanitize config for bootstrap (remove secrets)
function sanitizeConfigForBootstrap(config) {
  const sanitized = { ...config };
  const secretFields = [
    'PAPERLESS_API_TOKEN',
    'OPENAI_API_KEY',
    'CUSTOM_API_KEY',
    'AZURE_API_KEY',
    'OCR_API_KEY',
    'MISTRAL_API_KEY'
  ];
  secretFields.forEach(field => {
    delete sanitized[field];
  });
  return sanitized;
}

router.get('/setup', async (req, res) => {
  try {
    // SECURITY: Check setup state first to detect degraded conditions
    const setupState = await setupService.getSetupState();

    // If system is in degraded state (config exists but database corrupted),
    // refuse to render setup page with embedded config
    if (setupState === 'degraded') {
      console.warn('[SECURITY] Attempting to access /setup in degraded state (corrupted database)');
      return res.status(500).render('setup-error', {
        title: 'System Configuration Error',
        errorMessage: 'The system configuration exists but the database is inaccessible or corrupted. This is an administrative error state. Please check system logs and database integrity.',
        supportText: 'This may occur if: (1) the database file was deleted or corrupted, (2) file permissions changed, or (3) the database is locked. Restart the application after verifying database and permissions.'
      }).catch(() => {
        // Fallback if setup-error template doesn't exist
        res.status(500).send('<h1>System Configuration Error</h1><p>Database is inaccessible. Please contact your administrator.</p>');
      });
    }

    // Base configuration object - load this FIRST, before any checks
    let config = {
      PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      TAGS: normalizeArray(process.env.TAGS),
      IGNORE_TAGS: normalizeArray(process.env.IGNORE_TAGS),
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
      PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
      PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || 'yes',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      DISABLE_AUTOMATIC_PROCESSING: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT|| '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
      MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
      OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
      OCR_API_URL: process.env.OCR_API_URL || '',
      OCR_API_KEY: process.env.OCR_API_KEY || '',
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
      MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest'
    };

    // Check both configuration and users
    const [isEnvConfigured, users] = await Promise.all([
      setupService.isConfigured(),
      documentModel.getUsers()
    ]);
    const aiProviderPresets = await loadAiProviderPresets();

    // Load saved config if it exists
    if (isEnvConfigured) {
      const savedConfig = await setupService.loadConfig();
      if (savedConfig.PAPERLESS_API_URL) {
        savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
      }

      savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
      savedConfig.IGNORE_TAGS = normalizeArray(savedConfig.IGNORE_TAGS);
      savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

      config = { ...config, ...savedConfig };
    }

    // Debug output
    console.log('Current config TAGS:', config.TAGS);
    console.log('Current config IGNORE_TAGS:', config.IGNORE_TAGS);
    console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);

    // Check if system is fully configured
    const hasUsers = Array.isArray(users) && users.length > 0;
    const isFullyConfigured = isEnvConfigured && hasUsers;

    // Generate appropriate success message
    let successMessage;
    if (isEnvConfigured && !hasUsers) {
      successMessage = 'Environment is configured, but no users exist. Please create at least one user.';
    } else if (isEnvConfigured) {
      successMessage = 'The application is already configured. You can update the configuration below.';
    }

    // If everything is configured and we have users, redirect to dashboard
    // BUT only after we've loaded all the config
    if (isFullyConfigured) {
      return res.redirect('/dashboard');
    }

    // SECURITY: Sanitize config before passing to template (remove secrets from bootstrap)
    const sanitizedConfig = sanitizeConfigForBootstrap(config);

    // Render setup page with sanitized config and appropriate message
    res.render('setup', {
      config: sanitizedConfig,
      success: successMessage,
      aiProviderPresets,
      defaults: {
        scanInterval: getDefaultScanInterval()
      }
    });
  } catch (error) {
    console.error('Setup route error:', error);
    const aiProviderPresets = await loadAiProviderPresets();
    res.status(500).render('setup', {
      config: {},
      error: 'An error occurred while loading the setup page.',
      aiProviderPresets,
      defaults: {
        scanInterval: getDefaultScanInterval()
      }
    });
  }
});

/**
 * @swagger
 * /api/setup/presets:
 *   get:
 *     summary: Get AI provider presets for initial setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Preset list loaded successfully
 */
router.get('/api/setup/presets', async (_req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const presets = await loadAiProviderPresets();
    return res.json({
      success: true,
      presets
    });
  } catch (error) {
    console.error('[ERROR] GET /api/setup/presets:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load AI provider presets.'
    });
  }
});

/**
 * @swagger
 * /api/setup/mfa/setup:
 *   post:
 *     summary: Start setup MFA provisioning
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: MFA provisioning data generated
 */
router.post('/api/setup/mfa/setup', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const username = String(req.body?.username || '').trim();
    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username is required for MFA setup.'
      });
    }

    const secret = generateBase32Secret();
    const otpauthUri = buildOtpAuthUri(secret, username);
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#0f172a', light: '#ffffff' }
    });

    const challengeId = crypto.randomBytes(24).toString('hex');
    setupMfaChallenges.set(challengeId, {
      username,
      secret,
      verified: false,
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      challengeId,
      secret,
      otpauthUri,
      qrDataUrl,
      expiresInSeconds: Math.floor(SETUP_MFA_CHALLENGE_TTL_MS / 1000)
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/setup:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize MFA setup.'
    });
  }
});

/**
 * @swagger
 * /api/setup/mfa/confirm:
 *   post:
 *     summary: Confirm setup MFA code
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: MFA code validated
 */
router.post('/api/setup/mfa/confirm', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const challengeId = String(req.body?.challengeId || '').trim();
    const token = String(req.body?.token || '').trim();

    if (!challengeId || !token) {
      return res.status(400).json({
        success: false,
        error: 'Challenge ID and authentication code are required.'
      });
    }

    const challenge = setupMfaChallenges.get(challengeId);
    if (!challenge) {
      return res.status(400).json({
        success: false,
        error: 'MFA setup session expired. Start setup again.'
      });
    }

    if (!verifyTotpToken(challenge.secret, token)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authentication code. Please try again.'
      });
    }

    challenge.verified = true;
    challenge.verifiedAt = Date.now();

    return res.json({
      success: true,
      message: 'MFA code validated.'
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/confirm:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to validate MFA code.'
    });
  }
});

/**
 * @swagger
 * /api/setup/paperless/test:
 *   post:
 *     summary: Test Paperless-ngx connectivity and permissions during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Connectivity result returned
 */
router.post('/api/setup/paperless/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const paperlessUrl = String(req.body?.paperlessUrl || '').trim();
    const paperlessToken = String(req.body?.paperlessToken || '').trim();
    const validation = await validatePaperlessConnectionForSetup(paperlessUrl, paperlessToken);

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/paperless/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test Paperless-ngx connection.'
    });
  }
});

/**
 * @swagger
 * /api/setup/paperless/metadata:
 *   post:
 *     summary: Fetch Paperless-ngx counts and tags for setup wizard
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Metadata loaded successfully
 */
router.post('/api/setup/paperless/metadata', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const paperlessUrl = String(req.body?.paperlessUrl || '').trim();
    const paperlessToken = String(req.body?.paperlessToken || '').trim();
    const normalizedUrl = normalizeSetupBaseUrl(paperlessUrl);

    if (!normalizedUrl || !paperlessToken) {
      return res.status(400).json({
        success: false,
        error: 'Paperless API URL and API token are required.'
      });
    }

    const urlValidation = await validateApiUrl(normalizedUrl, getSetupUrlValidationOptions());
    if (!urlValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid Paperless API URL: ${urlValidation.error}`
      });
    }

    const initialized = await paperlessService.initializeWithCredentials(normalizedUrl, paperlessToken);
    if (!initialized) {
      return res.status(400).json({
        success: false,
        error: 'Failed to initialize Paperless-ngx client.'
      });
    }

    const [documentCount, correspondentCount, tagCount, tags] = await Promise.all([
      paperlessService.getDocumentCount(),
      paperlessService.getCorrespondentCount(),
      paperlessService.getTagCount(),
      paperlessService.getTags()
    ]);

    const tagNames = Array.from(
      new Set(
        (Array.isArray(tags) ? tags : [])
          .map((tag) => String(tag?.name || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return res.json({
      success: true,
      metadata: {
        documents: Number(documentCount || 0),
        correspondents: Number(correspondentCount || 0),
        tags: Number(tagCount || 0)
      },
      tagNames
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/paperless/metadata:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load Paperless metadata.'
    });
  }
});

/**
 * @swagger
 * /api/setup/ai/test:
 *   post:
 *     summary: Test AI provider credentials during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: AI connectivity result returned
 */
router.post('/api/setup/ai/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const validation = await validateAiConnectionForSetup({
      aiProvider: req.body?.aiProvider,
      apiUrl: req.body?.apiUrl,
      token: req.body?.token,
      model: req.body?.model,
      azureApiVersion: req.body?.azureApiVersion
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test AI connection.'
    });
  }
});

/**
 * @swagger
 * /api/setup/ai/models:
 *   post:
 *     summary: Discover available AI models during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: AI model list returned
 */
router.post('/api/setup/ai/models', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const result = await discoverAiModelsForSetup({
      aiProvider: req.body?.aiProvider,
      apiUrl: req.body?.apiUrl,
      token: req.body?.token
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover AI models.'
    });
  }
});

/**
 * @swagger
 * /api/setup/ocr/test:
 *   post:
 *     summary: Test OCR provider connectivity during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: OCR connectivity result returned
 */
router.post('/api/setup/ocr/test', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const validation = await validateOcrConnectionForSetup({
      enabled: req.body?.enabled,
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      apiKey: req.body?.apiKey,
      model: req.body?.model
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test OCR connection.'
    });
  }
});

/**
 * @swagger
 * /api/setup/ocr/models:
 *   post:
 *     summary: Discover available OCR models during setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: OCR model list returned
 */
router.post('/api/setup/ocr/models', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const result = await discoverOcrModelsForSetup({
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      apiKey: req.body?.apiKey
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover OCR models.'
    });
  }
});

router.post('/api/settings/ocr/test', isAuthenticated, express.json(), async (req, res) => {
  try {
    const validation = await validateOcrConnectionForSetup({
      enabled: req.body?.enabled,
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      apiKey: req.body?.apiKey,
      model: req.body?.model
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/settings/ocr/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test OCR connection.'
    });
  }
});

router.post('/api/settings/ai/models', isAuthenticated, express.json(), async (req, res) => {
  try {
    const result = await discoverAiModelsForSetup({
      aiProvider: req.body?.aiProvider,
      apiUrl: req.body?.apiUrl,
      token: req.body?.token
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/settings/ai/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover AI models.'
    });
  }
});

router.post('/api/settings/ocr/models', isAuthenticated, express.json(), async (req, res) => {
  try {
    const result = await discoverOcrModelsForSetup({
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      apiKey: req.body?.apiKey
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/settings/ocr/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover OCR models.'
    });
  }
});

/**
 * @swagger
 * /api/setup/complete:
 *   post:
 *     summary: Finalize initial setup, persist env config, and trigger restart
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Setup completed successfully
 */
router.post('/api/setup/complete', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    cleanupExpiredSetupMfaChallenges();

    const adminUsername = String(req.body?.adminUsername || '').trim();
    const adminPassword = String(req.body?.adminPassword || '');
    const enableMfa = parseBooleanInput(req.body?.enableMfa, false);
    const mfaChallengeId = String(req.body?.mfaChallengeId || '').trim();

    const paperlessUrl = normalizeSetupBaseUrl(req.body?.paperlessUrl);
    const paperlessUsername = String(req.body?.paperlessUsername || '').trim();
    const paperlessToken = String(req.body?.paperlessToken || '').trim();

    const scanAllDocuments = parseBooleanInput(req.body?.scanAllDocuments, false);
    const includeTag = String(req.body?.includeTag || '').trim();
    const excludeTags = normalizeTagListInput(req.body?.excludeTags);
    const processedTag = String(req.body?.processedTag || '').trim();
    const automaticScanEnabled = parseBooleanInput(req.body?.automaticScanEnabled, true);
    const scanInterval = String(req.body?.scanInterval || getDefaultScanInterval()).trim() || getDefaultScanInterval();

    const aiProvider = String(req.body?.aiProvider || '').trim().toLowerCase();
    const aiApiUrl = String(req.body?.aiApiUrl || '').trim();
    const aiToken = String(req.body?.aiToken || '').trim();
    const aiModel = String(req.body?.aiModel || '').trim();
    const aiAzureApiVersion = String(req.body?.aiAzureApiVersion || '2023-05-15').trim() || '2023-05-15';

    const allowFailedPaperlessTest = parseBooleanInput(req.body?.allowFailedPaperlessTest, false);
    const allowFailedAiTest = parseBooleanInput(req.body?.allowFailedAiTest, false);

    const mistralOcrEnabled = parseBooleanInput(req.body?.mistralOcrEnabled, false);
    const ocrProvider = String(req.body?.ocrProvider || 'mistral').trim().toLowerCase();
    const ocrApiUrl = String(req.body?.ocrApiUrl || '').trim();
    const ocrApiKey = String(req.body?.ocrApiKey || req.body?.mistralApiKey || '').trim();
    const mistralOcrModel = String(req.body?.mistralOcrModel || 'mistral-ocr-latest').trim() || 'mistral-ocr-latest';

    if (!['mistral', 'custom', 'ollama'].includes(ocrProvider)) {
      return res.status(400).json({
        success: false,
        error: 'A valid OCR provider is required.'
      });
    }

    if (mistralOcrEnabled && ocrProvider === 'mistral' && !ocrApiKey) {
      return res.status(400).json({
        success: false,
        error: 'Mistral API key is required when OCR provider is set to mistral.'
      });
    }

    if (!adminUsername || !adminPassword) {
      return res.status(400).json({
        success: false,
        error: 'Admin username and password are required.'
      });
    }

    if (adminPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long.'
      });
    }

    if (!paperlessUrl || !paperlessUsername || !paperlessToken) {
      return res.status(400).json({
        success: false,
        error: 'Paperless URL, username, and token are required.'
      });
    }

    if (!scanAllDocuments && !includeTag) {
      return res.status(400).json({
        success: false,
        error: 'Select a tag for scanned documents or enable scanning all documents.'
      });
    }

    if (!aiProvider || !['openai', 'ollama', 'custom', 'azure'].includes(aiProvider)) {
      return res.status(400).json({
        success: false,
        error: 'A valid AI provider is required.'
      });
    }

    const paperlessValidation = await validatePaperlessConnectionForSetup(paperlessUrl, paperlessToken);
    if (!paperlessValidation.success && !allowFailedPaperlessTest) {
      return res.status(400).json({
        success: false,
        error: paperlessValidation.message
      });
    }

    const aiValidation = await validateAiConnectionForSetup({
      aiProvider,
      apiUrl: aiApiUrl,
      token: aiToken,
      model: aiModel,
      azureApiVersion: aiAzureApiVersion
    });

    if (!aiValidation.success && !allowFailedAiTest) {
      return res.status(400).json({
        success: false,
        error: aiValidation.message
      });
    }

    const ocrProviderForValidation = ocrProvider === 'custom' ? 'ollama' : ocrProvider;
    const ocrValidation = await setupService.validateOcrConfig({
      enabled: mistralOcrEnabled ? 'yes' : 'no',
      provider: ocrProviderForValidation,
      apiUrl: ocrApiUrl,
      apiKey: ocrApiKey,
      model: mistralOcrModel
    });

    if (!ocrValidation) {
      return res.status(400).json({
        success: false,
        error: 'OCR connection test failed. Check OCR provider, OCR API URL, API key, and model.'
      });
    }

    const tagsForProcessing = scanAllDocuments ? [] : [includeTag];
    const apiToken = process.env.API_KEY || crypto.randomBytes(64).toString('hex');
    const jwtToken = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

    const finalConfig = {
      PAPERLESS_API_URL: paperlessUrl,
      PAPERLESS_API_TOKEN: paperlessToken,
      PAPERLESS_USERNAME: paperlessUsername,
      AI_PROVIDER: aiProvider,
      SCAN_INTERVAL: scanInterval,
      PROCESS_PREDEFINED_DOCUMENTS: scanAllDocuments ? 'no' : 'yes',
      TAGS: tagsForProcessing,
      IGNORE_TAGS: excludeTags,
      ADD_AI_PROCESSED_TAG: processedTag ? 'yes' : 'no',
      AI_PROCESSED_TAG_NAME: processedTag || 'ai-processed',
      DISABLE_AUTOMATIC_PROCESSING: automaticScanEnabled ? 'no' : 'yes',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      API_KEY: apiToken,
      JWT_SECRET: jwtToken,
      PAPERLESS_AI_INITIAL_SETUP: 'yes',
      ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING || 'yes',
      ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS || 'yes',
      ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE || 'yes',
      ACTIVATE_TITLE: process.env.ACTIVATE_TITLE || 'yes',
      ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS || 'yes',
      CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}',
      MISTRAL_OCR_ENABLED: mistralOcrEnabled ? 'yes' : 'no',
      OCR_PROVIDER: ocrProvider,
      OCR_API_URL: ocrApiUrl,
      OCR_API_KEY: ocrApiKey,
      MISTRAL_API_KEY: ocrApiKey,
      MISTRAL_OCR_MODEL: mistralOcrModel
    };

    if (aiProvider === 'openai') {
      finalConfig.OPENAI_API_KEY = aiToken;
      finalConfig.OPENAI_MODEL = aiModel || 'gpt-4o-mini';
    } else if (aiProvider === 'ollama') {
      finalConfig.OLLAMA_API_URL = aiApiUrl || 'http://localhost:11434';
      finalConfig.OLLAMA_MODEL = aiModel || 'llama3.2';
    } else if (aiProvider === 'azure') {
      finalConfig.AZURE_ENDPOINT = aiApiUrl;
      finalConfig.AZURE_API_KEY = aiToken;
      finalConfig.AZURE_DEPLOYMENT_NAME = aiModel;
      finalConfig.AZURE_API_VERSION = aiAzureApiVersion;
    } else {
      finalConfig.CUSTOM_BASE_URL = aiApiUrl;
      finalConfig.CUSTOM_API_KEY = aiToken;
      finalConfig.CUSTOM_MODEL = aiModel;
    }

    let mfaSecretToPersist = null;
    if (enableMfa) {
      if (!mfaChallengeId) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup is incomplete. Generate and confirm a code first.'
        });
      }

      const challenge = setupMfaChallenges.get(mfaChallengeId);
      if (!challenge || !challenge.verified) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup is incomplete or expired. Please repeat MFA setup.'
        });
      }

      if (challenge.username !== adminUsername) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup username does not match the admin username.'
        });
      }

      mfaSecretToPersist = challenge.secret;
    }

    await setupService.saveConfig(finalConfig, {
      skipValidation: allowFailedPaperlessTest || allowFailedAiTest
    });

    const hashedPassword = await bcrypt.hash(adminPassword, 15);
    await documentModel.addUser(adminUsername, hashedPassword);

    if (enableMfa && mfaSecretToPersist) {
      await documentModel.setUserMfaSettings(adminUsername, true, mfaSecretToPersist);
      setupMfaChallenges.delete(mfaChallengeId);
    }

    const envPreview = toEnvPreviewLines(finalConfig);

    // Enforce a fresh login after setup completion.
    res.clearCookie('jwt');
    res.clearCookie(MFA_CHALLENGE_COOKIE);
    res.clearCookie(MFA_SETUP_COOKIE);

    res.json({
      success: true,
      message: 'Initial setup completed successfully.',
      restart: true,
      redirectTo: '/login',
      envPreview
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/complete:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to complete setup: ' + error.message
    });
  }
});

/**
 * @swagger
 * /manual/preview/{id}:
 *   get:
 *     summary: Document preview
 *     description: |
 *       Fetches and returns the content of a specific document from Paperless-ngx 
 *       for preview in the manual document review interface.
 *       
 *       This endpoint retrieves document details including content, title, ID, and tags,
 *       allowing users to view the document text before applying changes or processing
 *       it with AI tools. The document content is retrieved directly from Paperless-ngx
 *       using the system's configured API credentials.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The document ID from Paperless-ngx
 *         example: 123
 *     responses:
 *       200:
 *         description: Document content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: The document content
 *                   example: "Invoice from ACME Corp. Amount: $1,234.56"
 *                 title:
 *                   type: string
 *                   description: The document title
 *                   example: "ACME Corp Invoice #12345"
 *                 id:
 *                   type: integer
 *                   description: The document ID
 *                   example: 123
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of tag names assigned to the document
 *                   example: ["Invoice", "ACME Corp", "2023"]
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/preview/:id', async (req, res) => {
  try {
    const documentId = req.params.id;
    
    // Validate documentId to prevent path traversal and SSRF
    if (!/^\d+$/.test(documentId)) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }

    console.log('Fetching content for document:', documentId);
    
    const response = await fetch(
      `${configFile.paperless.apiUrl}/api/documents/${documentId}/`,
      {
        headers: {
          'Authorization': `Token ${process.env.PAPERLESS_API_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch document content: ${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(document.tags.map(async tag => {
      const tagName = await paperlessService.getTagTextFromId(tag);
      return tagName;
    }
    ));
    console.log('Document Data:', document);
    res.json({ content: document.content, title: document.title, id: document.id, tags: document.tags });
  } catch (error) {
    console.error('Content fetch error:', error);
    res.status(500).json({ error: `Error fetching document content: ${error.message}` });
  }
});

/**
 * @swagger
 * /manual:
 *   get:
 *     summary: Document review page
 *     description: |
 *       Renders the manual document review page that allows users to browse, 
 *       view and manually process documents from Paperless-ngx.
 *       
 *       This interface enables users to review documents, view their content, and 
 *       manage tags, correspondents, and document metadata without AI assistance.
 *       Users can apply manual changes to documents based on their own judgment,
 *       which is particularly useful for correction or verification of AI-processed documents.
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Manual document review page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the manual document review interface
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual', async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('manual', {
    title: 'Document Review',
    error: null,
    success: null,
    version,
    paperlessUrl: process.env.PAPERLESS_API_URL,
    paperlessToken: process.env.PAPERLESS_API_TOKEN,
    config: {}
  });
});

/**
 * @swagger
 * /manual/tags:
 *   get:
 *     summary: Get all tags
 *     description: |
 *       Retrieves all tags from Paperless-ngx for use in the manual document review interface.
 *       
 *       This endpoint returns a complete list of all available tags that can be applied to documents,
 *       including their IDs, names, and colors. The tags are retrieved directly from Paperless-ngx
 *       and used for tag selection in the UI when manually updating document metadata.
 *     tags:
 *       - Documents
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Tag'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/tags', async (req, res) => {
  const getTags = await paperlessService.getTags();
  res.json(getTags);
});

/**
 * @swagger
 * /manual/documents:
 *   get:
 *     summary: Get all documents
 *     description: |
 *       Retrieves all documents from Paperless-ngx for display in the manual document review interface.
 *       
 *       This endpoint returns a list of all available documents that can be manually reviewed,
 *       including their basic metadata such as ID, title, and creation date. The documents are
 *       retrieved directly from Paperless-ngx and presented in the UI for selection and processing.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Documents retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Document'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/documents', async (req, res) => {
  const getDocuments = await paperlessService.getDocuments();
  res.json(getDocuments);
});

/**
 * @swagger
 * /api/correspondentsCount:
 *   get:
 *     summary: Get count of correspondents
 *     description: |
 *       Retrieves the list of correspondents with their document counts.
 *       This endpoint returns all correspondents in the system along with 
 *       the number of documents associated with each correspondent.
 *     tags: 
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of correspondents with document counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                     description: ID of the correspondent
 *                     example: 1
 *                   name:
 *                     type: string
 *                     description: Name of the correspondent
 *                     example: "ACME Corp"
 *                   count:
 *                     type: integer
 *                     description: Number of documents associated with this correspondent
 *                     example: 5
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/api/correspondentsCount', async (req, res) => {
  const correspondents = await paperlessService.listCorrespondentsNames();
  res.json(correspondents);
});

/**
 * @swagger
 * /api/tagsCount:
 *   get:
 *     summary: Get count of tags
 *     description: |
 *       Retrieves the list of tags with their document counts.
 *       This endpoint returns all tags in the system along with 
 *       the number of documents associated with each tag.
 *     tags: 
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of tags with document counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                     description: ID of the tag
 *                     example: 1
 *                   name:
 *                     type: string
 *                     description: Name of the tag
 *                     example: "Invoice"
 *                   count:
 *                     type: integer
 *                     description: Number of documents associated with this tag
 *                     example: 12
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/api/tagsCount', async (req, res) => {
  const tags = await paperlessService.listTagNames();
  res.json(tags);
});

const documentQueue = [];
let isProcessing = false;

function extractDocumentId(url) {
  const match = url.match(/\/documents\/(\d+)\//);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  throw new Error('Could not extract document ID from URL');
}

async function processQueue(customPrompt) {
  if (customPrompt) {
    console.log('Using custom prompt:', customPrompt);
  }

  if (isProcessing || documentQueue.length === 0) return;
  
  isProcessing = true;
  
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
      return;
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    const [existingTags, existingCorrespondentList, existingDocumentTypes, ownUserId] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames(),
      paperlessService.getOwnUserID()
    ]);

    const existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);

    while (documentQueue.length > 0) {
      const doc = documentQueue.shift();
      
      try {
        const result = await processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, customPrompt);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] Failed to process document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR] Error during queue processing:', error);
  } finally {
    isProcessing = false;
    
    if (documentQueue.length > 0) {
      processQueue();
    }
  }
}

/**
 * @swagger
 * /api/webhook/document:
 *   post:
 *     summary: Webhook for document updates
 *     description: |
 *       Processes incoming webhook notifications from Paperless-ngx about document
 *       changes, additions, or deletions. The webhook allows Paperless-AI next to respond
 *       to document changes in real-time.
 *       
 *       When a new document is added or updated in Paperless-ngx, this endpoint can
 *       trigger automatic AI processing for metadata extraction.
 *     tags:
 *       - Documents
 *       - API
 *       - System
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event_type
 *               - document_id
 *             properties:
 *               event_type:
 *                 type: string
 *                 description: Type of event that occurred
 *                 enum: ["added", "updated", "deleted"]
 *                 example: "added"
 *               document_id:
 *                 type: integer
 *                 description: ID of the affected document
 *                 example: 123
 *               document_info:
 *                 type: object
 *                 description: Additional information about the document (optional)
 *                 properties:
 *                   title:
 *                     type: string
 *                     example: "Invoice"
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Document event processed"
 *                 processing_queued:
 *                   type: boolean
 *                   description: Whether AI processing was queued for this document
 *                   example: true
 *       400:
 *         description: Invalid webhook payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Missing required fields: event_type, document_id"
 *       401:
 *         description: Unauthorized - invalid or missing API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized: Invalid API key"
 *       500:
 *         description: Server error processing webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/api/webhook/document', isAuthenticated, async (req, res) => {
  try {
    const { url, prompt } = req.body;
    let usePrompt = false;
    if (!url) {
      return res.status(400).send('Missing document URL');
    }
    
    try {
      const documentId = extractDocumentId(url);
      const document = await paperlessService.getDocument(documentId);
      
      if (!document) {
        return res.status(404).send(`Document with ID ${documentId} not found`);
      }
      
      documentQueue.push(document);
      if (prompt) {
        usePrompt = true;
        console.log('[DEBUG] Using custom prompt:', prompt);
        await processQueue(prompt);
      } else {
        await processQueue();
      }
      
      
      res.status(202).send({
        message: 'Document accepted for processing',
        documentId: documentId,
        queuePosition: documentQueue.length
      });
      
    } catch (error) {
      console.error('[ERROR] Failed to extract document ID or fetch document:', error);
      return res.status(200).send('Invalid document URL format');
    }
    
  } catch (error) {
    console.error('[ERROR] Error in webhook endpoint:', error);
    res.status(200).send('Internal server error');
  }
});

/**
 * @swagger
 * /dashboard:
 *   get:
 *     summary: Main dashboard page
 *     description: |
 *       Renders the main dashboard page of the application with summary statistics and visualizations.
 *       The dashboard provides an overview of processed documents, system metrics, and important statistics
 *       about document processing including tag counts, correspondent counts, and token usage.
 *       
 *       The page displays visualizations for document processing status, token distribution, 
 *       processing time statistics, and document type categorization to help administrators
 *       understand system performance and document processing patterns.
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the dashboard page
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/dashboard', async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  let paperlessUrl = '';

  try {
    paperlessUrl = await paperlessService.getPublicBaseUrl();
  } catch (error) {
    console.warn('[WARN] Could not resolve Paperless public URL for dashboard links:', error.message);
  }

  res.render('dashboard', { 
    paperless_data: { 
      tagCount: 0,
      correspondentCount: 0,
      documentCount: 0,
      processedDocumentCount: 0,
      ocrNeededCount: 0,
      failedCount: 0,
      queueBacklog: 0,
      processingEfficiencyRate: 0,
      failedRate: 0,
      processedToday: 0,
      processingTimeStats: [],
      tokenDistribution: [],
      documentTypes: [],
      tokenTrend: [],
      recentActivity: [],
      languageDistribution: []
    }, 
    openai_data: { 
      averagePromptTokens: 0,
      averageCompletionTokens: 0,
      averageTotalTokens: 0,
      tokensOverall: 0
    }, 
    version,
    paperlessUrl,
  });
});

router.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [
      tagCount,
      correspondentCount,
      documentCount,
      rawProcessedDocumentCount,
      ocrNeededCount,
      ocrFailedCount,
      processingFailedCount,
      metrics,
      processingTimeStats,
      tokenDistribution,
      documentTypes,
      tokenTrend,
      recentActivity,
      languageDistribution,
      processingStatus
    ] = await Promise.all([
      paperlessService.getTagCount(),
      paperlessService.getCorrespondentCount(),
      paperlessService.getEffectiveDocumentCount(),
      documentModel.getProcessedDocumentsCount(),
      documentModel.getOcrQueueCount(),
      documentModel.getOcrFailedCount(),
      documentModel.getFailedProcessingCount(),
      documentModel.getMetrics(),
      documentModel.getProcessingTimeStats(),
      documentModel.getTokenDistribution(),
      documentModel.getDocumentTypeStats(),
      documentModel.getTokenTrend(7),
      documentModel.getRecentHistoryDocuments(3),
      documentModel.getLanguageDistribution(5),
      documentModel.getCurrentProcessingStatus()
    ]);

    const processedDocumentCount = Math.min(rawProcessedDocumentCount, documentCount);
    const failedCount = ocrFailedCount + processingFailedCount;
    const queueBacklog = Math.max(0, ocrNeededCount + failedCount);
    const processingAttemptCount = processedDocumentCount + failedCount;
    const processingEfficiencyRate = processingAttemptCount > 0
      ? Math.round((processedDocumentCount / processingAttemptCount) * 100)
      : 0;
    const failedRate = processingAttemptCount > 0
      ? Math.round((failedCount / processingAttemptCount) * 100)
      : 0;
    const processedToday = Number(processingStatus?.processedToday || 0);

    const averagePromptTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.promptTokens, 0) / metrics.length) : 0;
    const averageCompletionTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.completionTokens, 0) / metrics.length) : 0;
    const averageTotalTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) / metrics.length) : 0;
    const tokensOverall = metrics.length > 0 ? metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) : 0;

    const normalizedTokenTrend = Array.isArray(tokenTrend)
      ? tokenTrend.map((entry) => ({
          day: entry.day,
          documents: Number(entry.documents || 0),
          totalTokens: Number(entry.totalTokens || 0)
        }))
      : [];

    const normalizedRecentActivity = Array.isArray(recentActivity)
      ? recentActivity.map((entry) => ({
          documentId: Number(entry.documentId || 0),
          title: entry.title || 'Untitled document',
          correspondent: entry.correspondent || 'Unknown correspondent',
          createdAt: entry.createdAt,
          language: entry.language || 'Unknown'
        }))
      : [];

    const normalizedLanguageDistribution = Array.isArray(languageDistribution)
      ? languageDistribution.map((entry) => ({
          language: entry.language || 'Unknown',
          count: Number(entry.count || 0)
        }))
      : [];

    res.json({
      success: true,
      paperless_data: {
        tagCount,
        correspondentCount,
        documentCount,
        processedDocumentCount,
        ocrNeededCount,
        failedCount,
        queueBacklog,
        processingEfficiencyRate,
        failedRate,
        processedToday,
        processingTimeStats,
        tokenDistribution,
        documentTypes,
        tokenTrend: normalizedTokenTrend,
        recentActivity: normalizedRecentActivity,
        languageDistribution: normalizedLanguageDistribution
      },
      openai_data: {
        averagePromptTokens,
        averageCompletionTokens,
        averageTotalTokens,
        tokensOverall
      }
    });
  } catch (error) {
    console.error('[ERROR] loading dashboard stats:', error);
    res.status(500).json({ success: false, error: 'Failed to load dashboard stats' });
  }
});

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics payload
 *     description: Returns all aggregate counters and chart datasets required by the dashboard UI.
 *     tags:
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Application settings page
 *     description: |
 *       Renders the application settings page where users can modify configuration
 *       after initial setup.
 *       
 *       This page allows administrators to update connections to Paperless-ngx, 
 *       AI provider settings, processing parameters, feature toggles, and custom fields.
 *       The interface provides validation for connection settings and displays the current
 *       configuration values.
 *       
 *       Changes made on this page require application restart to take full effect.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Settings page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application settings page
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/settings', async (req, res) => {
  const processSystemPrompt = (prompt) => {
    if (!prompt) return '';
    return prompt.replace(/\\n/g, '\n');
  };

  const normalizeArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
    return [];
  };

  let showErrorCheckSettings = false;
  const isConfigured = await setupService.isConfigured();
  const runtimeOverrides = await setupService.loadRuntimeOverrides();
  const injectedEnvSnapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ || {};
  const secretKeys = new Set(SETTINGS_SECRET_FIELDS);
  const runtimeFirstMode = String(process.env.CONFIG_SOURCE_MODE || 'runtime-first').trim().toLowerCase() !== 'legacy';
  let hasLegacyEnvMigrationNotice = false;

  if (runtimeFirstMode) {
    try {
      await fs.access(path.join(process.cwd(), 'data', '.env.migrated'));
      hasLegacyEnvMigrationNotice = true;
    } catch (_error) {
      hasLegacyEnvMigrationNotice = false;
    }
  }

  const formatValueForTooltip = (key, value) => {
    const normalizedValue = value == null ? '' : String(value);
    if (secretKeys.has(key)) {
      return normalizedValue ? '[hidden]' : '[empty]';
    }
    return normalizedValue === '' ? '[empty]' : normalizedValue;
  };

  const runtimeOverrideDetails = {};
  const runtimeOverrideKeys = new Set(
    Object.keys(runtimeOverrides || {}).filter((key) => {
      const hasInjectedValue = Object.prototype.hasOwnProperty.call(injectedEnvSnapshot, key);
      if (!hasInjectedValue) {
        return false;
      }

      const injectedValue = injectedEnvSnapshot[key] == null ? '' : String(injectedEnvSnapshot[key]);
      const overrideValue = runtimeOverrides[key] == null ? '' : String(runtimeOverrides[key]);
      const isOverwritten = injectedValue !== overrideValue;

      if (isOverwritten) {
        runtimeOverrideDetails[key] = {
          injected: formatValueForTooltip(key, injectedValue),
          override: formatValueForTooltip(key, overrideValue)
        };
      }

      return isOverwritten;
    })
  );
  if(!isConfigured && process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes') {
    showErrorCheckSettings = true;
  }
  let config = {
    PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
    PAPERLESS_PUBLIC_URL: process.env.PAPERLESS_PUBLIC_URL || '',
    PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
    PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
    SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
    RECONCILIATION_INTERVAL: process.env.RECONCILIATION_INTERVAL || '0 * * * *',
    RECONCILIATION_ENABLED: process.env.RECONCILIATION_ENABLED || 'yes',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
    PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
    
    TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
    RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
    AI_TEMPERATURE_ANALYSIS: process.env.AI_TEMPERATURE_ANALYSIS || '0.3',
    AI_TEMPERATURE_GENERATION: process.env.AI_TEMPERATURE_GENERATION || '0.7',
    TAGS: normalizeArray(process.env.TAGS),
    IGNORE_TAGS: normalizeArray(process.env.IGNORE_TAGS),
    ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
    AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
    USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
    PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
    PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
    PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || ' ',
    USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
    CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
    CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
    CUSTOM_MODEL: process.env.CUSTOM_MODEL || '',
    AZURE_ENDPOINT: process.env.AZURE_ENDPOINT|| '',
    AZURE_API_KEY: process.env.AZURE_API_KEY || '',
    AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
    AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
    RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
    RESTRICT_TO_EXISTING_CORRESPONDENTS: process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
    RESTRICT_TO_EXISTING_DOCUMENT_TYPES: process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
    EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
    EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
    EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
    EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
    EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
    EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || '',
    EXTERNAL_API_ALLOW_PRIVATE_IPS: process.env.EXTERNAL_API_ALLOW_PRIVATE_IPS || 'no',
    TAG_CACHE_TTL_SECONDS: process.env.TAG_CACHE_TTL_SECONDS || '300',
    ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING || 'yes',
    ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS || 'yes',
    ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE || 'yes',
    ACTIVATE_TITLE: process.env.ACTIVATE_TITLE || 'yes',
    ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS || 'yes',
    CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}',
    DISABLE_AUTOMATIC_PROCESSING: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
    MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
    OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
    OCR_API_URL: process.env.OCR_API_URL || '',
    OCR_API_KEY: process.env.OCR_API_KEY || '',
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
    MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
    GLOBAL_RATE_LIMIT_WINDOW_MS: process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000',
    GLOBAL_RATE_LIMIT_MAX: process.env.GLOBAL_RATE_LIMIT_MAX || '1000',
    TRUST_PROXY: typeof process.env.TRUST_PROXY === 'undefined' ? '' : process.env.TRUST_PROXY,
    COOKIE_SECURE_MODE: process.env.COOKIE_SECURE_MODE || 'auto',
    MIN_CONTENT_LENGTH: process.env.MIN_CONTENT_LENGTH || '10',
    PAPERLESS_AI_PORT: process.env.PAPERLESS_AI_PORT || '3000',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  };
  
  if (isConfigured) {
    const savedConfig = await setupService.loadConfig();
    if (savedConfig.PAPERLESS_API_URL) {
      savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
    }

    savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
    savedConfig.IGNORE_TAGS = normalizeArray(savedConfig.IGNORE_TAGS);
    savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

    config = { ...config, ...savedConfig };
  }

  // Debug-output
  console.log('Current config TAGS:', config.TAGS);
  console.log('Current config IGNORE_TAGS:', config.IGNORE_TAGS);
  console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);

  const lockedEnvKeys = Object.keys(config).filter((key) =>
    configFile.isProtectedRuntimeEnvKey(key)
  );
  const lockedEnvDetails = Object.fromEntries(
    lockedEnvKeys.map((key) => [
      key,
      {
        managed: formatValueForTooltip(key, injectedEnvSnapshot[key])
      }
    ])
  );

  const configuredSecrets = {};
  SETTINGS_SECRET_FIELDS.forEach((key) => {
    configuredSecrets[key] = Boolean(config[key]);
    config[key] = '';
  });

  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  let mfaSettings = {
    available: false,
    username: '',
    enabled: false
  };

  const settingsUsername = getAuthenticatedSettingsUsername(req);
  if (settingsUsername) {
    try {
      const settingsUser = await documentModel.getUser(settingsUsername);
      if (settingsUser) {
        mfaSettings = {
          available: true,
          username: settingsUser.username,
          enabled: isMfaEnabledForUser(settingsUser)
        };
      }
    } catch (mfaContextError) {
      console.error('[WARN] Failed to resolve MFA settings context:', mfaContextError);
    }
  }

  res.render('settings', { 
    version,
    config,
    configuredSecrets,
    runtimeOverrideKeys: Array.from(runtimeOverrideKeys),
    runtimeOverrideDetails,
    lockedEnvKeys,
    lockedEnvDetails,
    runtimeFirstMode,
    hasLegacyEnvMigrationNotice,
    mfaSettings,
    success: isConfigured ? 'The application is already configured. You can update the configuration below.' : undefined,
    settingsError: showErrorCheckSettings ? 'Please check your settings. Something is not working correctly.' : undefined
  });
});

/**
 * @swagger
 * /api/settings/api-key:
 *   get:
 *     summary: Get current application API key
 *     description: |
 *       Returns the currently active application API key for authenticated users.
 *       The key is intentionally fetched on-demand and is not embedded in server-rendered HTML.
 *     tags:
 *       - System
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current API key returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 configured:
 *                   type: boolean
 *                   description: Indicates whether an API key is currently configured
 *                   example: true
 *                 apiKey:
 *                   type: string
 *                   nullable: true
 *                   description: Current API key value when configured
 *                   example: "3f7a8d6e2c1b5a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Failed to load API key"
 */
router.get('/api/settings/api-key', isAuthenticated, async (req, res) => {
  try {
    const apiKey = configFile.getApiKey ? configFile.getApiKey() : (process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '');
    return res.json({
      success: true,
      configured: Boolean(apiKey),
      apiKey: apiKey || null
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/api-key:', error);
    return res.status(500).json({ success: false, error: 'Failed to load API key' });
  }
});

router.get('/api/settings/paperless-public-url', isAuthenticated, async (req, res) => {
  try {
    const details = await paperlessService.getPublicBaseUrlDetails({ forceRefresh: true });
    return res.json({
      success: true,
      publicUrl: details.url,
      source: details.source
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/paperless-public-url:', error);
    return res.status(500).json({ success: false, error: 'Failed to detect Paperless public URL' });
  }
});

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
      return res.status(403).json({ success: false, error: 'MFA settings require a signed-in user session.' });
    }

    const user = await documentModel.getUser(username);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.json({
      success: true,
      enabled: isMfaEnabledForUser(user),
      username: user.username
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/mfa/status:', error);
    return res.status(500).json({ success: false, error: 'Failed to load MFA status.' });
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
router.post('/api/settings/mfa/setup', isAuthenticated, express.json(), async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({ success: false, error: 'MFA settings require a signed-in user session.' });
    }

    const currentPassword = String(req.body?.currentPassword || '').trim();
    if (!currentPassword) {
      return res.status(400).json({ success: false, error: 'Current password is required.' });
    }

    const user = await documentModel.getUser(username);
    if (!user || !user.password) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Current password is invalid.' });
    }

    const jwtSecret = config.getJwtSecret();
    if (!jwtSecret) {
      return res.status(500).json({ success: false, error: 'Server misconfiguration: JWT secret missing.' });
    }

    const secret = generateBase32Secret(32);
    const setupToken = jwt.sign(
      {
        username: user.username,
        secret,
        setupType: 'mfa-setup'
      },
      jwtSecret,
      { expiresIn: '10m' }
    );

    res.cookie(MFA_SETUP_COOKIE, setupToken, {
      httpOnly: true,
      secure: shouldUseSecureCookies(req),
      sameSite: 'lax',
      path: '/'
    });

    return res.json({
      success: true,
      secret,
      otpauthUri: buildOtpAuthUri(secret, user.username),
      qrDataUrl: await QRCode.toDataURL(buildOtpAuthUri(secret, user.username), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      }),
      expiresInSeconds: 600
    });
  } catch (error) {
    console.error('[ERROR] POST /api/settings/mfa/setup:', error);
    return res.status(500).json({ success: false, error: 'Failed to start MFA setup.' });
  }
});

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
router.post('/api/settings/mfa/enable', isAuthenticated, express.json(), async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({ success: false, error: 'MFA settings require a signed-in user session.' });
    }

    const currentPassword = String(req.body?.currentPassword || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!currentPassword || !token) {
      return res.status(400).json({ success: false, error: 'Current password and authentication code are required.' });
    }

    const user = await documentModel.getUser(username);
    if (!user || !user.password) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Current password is invalid.' });
    }

    const setupToken = req.cookies[MFA_SETUP_COOKIE];
    if (!setupToken) {
      return res.status(401).json({ success: false, error: 'No active MFA setup challenge found. Start setup again.' });
    }

    const jwtSecret = config.getJwtSecret();
    if (!jwtSecret) {
      return res.status(500).json({ success: false, error: 'Server misconfiguration: JWT secret missing.' });
    }

    let payload;
    try {
      payload = jwt.verify(setupToken, jwtSecret);
      if (payload.setupType !== 'mfa-setup' || payload.username !== username) {
        throw new Error('Invalid setup payload');
      }
    } catch (tokenError) {
      res.clearCookie(MFA_SETUP_COOKIE);
      return res.status(401).json({ success: false, error: 'MFA setup session expired. Start setup again.' });
    }

    if (!verifyTotpToken(payload.secret, token)) {
      return res.status(400).json({ success: false, error: 'Invalid authentication code.' });
    }

    const updated = await documentModel.setUserMfaSettings(username, true, payload.secret);
    if (!updated) {
      return res.status(500).json({ success: false, error: 'Failed to enable MFA for user.' });
    }

    res.clearCookie(MFA_SETUP_COOKIE);
    return res.json({ success: true, message: 'MFA has been enabled.' });
  } catch (error) {
    console.error('[ERROR] POST /api/settings/mfa/enable:', error);
    return res.status(500).json({ success: false, error: 'Failed to enable MFA.' });
  }
});

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
router.post('/api/settings/mfa/verify', isAuthenticated, express.json(), async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({ success: false, error: 'MFA settings require a signed-in user session.' });
    }

    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Authentication code is required.' });
    }

    const user = await documentModel.getUser(username);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
      return res.status(400).json({ success: false, error: 'MFA is not enabled for this user.' });
    }

    const validCode = verifyTotpToken(user.mfa_secret, token);
    if (!validCode) {
      return res.status(400).json({ success: false, error: 'Invalid authentication code.' });
    }

    return res.json({ success: true, message: 'Authentication code is valid.' });
  } catch (error) {
    console.error('[ERROR] POST /api/settings/mfa/verify:', error);
    return res.status(500).json({ success: false, error: 'Failed to verify authentication code.' });
  }
});

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
router.post('/api/settings/mfa/disable', isAuthenticated, express.json(), async (req, res) => {
  try {
    const username = getAuthenticatedSettingsUsername(req);
    if (!username) {
      return res.status(403).json({ success: false, error: 'MFA settings require a signed-in user session.' });
    }

    const currentPassword = String(req.body?.currentPassword || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!currentPassword || !token) {
      return res.status(400).json({ success: false, error: 'Current password and authentication code are required.' });
    }

    const user = await documentModel.getUser(username);
    if (!user || !user.password) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Current password is invalid.' });
    }

    if (!isMfaEnabledForUser(user) || !user.mfa_secret) {
      return res.status(400).json({ success: false, error: 'MFA is not enabled for this user.' });
    }

    if (!verifyTotpToken(user.mfa_secret, token)) {
      return res.status(400).json({ success: false, error: 'Invalid authentication code.' });
    }

    const updated = await documentModel.setUserMfaSettings(username, false, null);
    if (!updated) {
      return res.status(500).json({ success: false, error: 'Failed to disable MFA for user.' });
    }

    res.clearCookie(MFA_SETUP_COOKIE);
    return res.json({ success: true, message: 'MFA has been disabled.' });
  } catch (error) {
    console.error('[ERROR] POST /api/settings/mfa/disable:', error);
    return res.status(500).json({ success: false, error: 'Failed to disable MFA.' });
  }
});

/**
 * @swagger
 * /api/settings/paperless-public-url:
 *   get:
 *     summary: Detect Paperless public URL
 *     description: Detects and returns the public base URL used for document links.
 *     tags:
 *       - Settings
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Public URL resolved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 publicUrl:
 *                   type: string
 *                 source:
 *                   type: string
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /manual/analyze:
 *   post:
 *     summary: Analyze document content manually
 *     description: |
 *       Analyzes document content using the configured AI provider and returns structured metadata.
 *       This endpoint processes the document text to extract relevant information such as tags,
 *       correspondent, and document type based on content analysis.
 *       
 *       The analysis is performed using the AI provider configured in the application settings.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The document text content to analyze
 *                 example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *               existingTags:
 *                 type: array
 *                 description: List of existing tags in the system to help with tag matching
 *                 items:
 *                   type: string
 *                 example: ["Invoice", "Finance", "Acme Corp"]
 *               id:
 *                 type: string
 *                 description: Optional document ID for tracking metrics
 *                 example: "doc_123"
 *     responses:
 *       200:
 *         description: Document analysis results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 correspondent:
 *                   type: string
 *                   description: Detected correspondent name
 *                   example: "Acme Corp"
 *                 title:
 *                   type: string
 *                   description: Suggested document title
 *                   example: "Acme Corp Invoice - August 2023"
 *                 tags:
 *                   type: array
 *                   description: Suggested tags for the document
 *                   items:
 *                     type: string
 *                   example: ["Invoice", "Finance"]
 *                 documentType:
 *                   type: string
 *                   description: Detected document type
 *                   example: "Invoice"
 *                 metrics:
 *                   type: object
 *                   description: Token usage metrics (when using OpenAI)
 *                   properties:
 *                     promptTokens:
 *                       type: number
 *                       example: 350
 *                     completionTokens:
 *                       type: number
 *                       example: 120
 *                     totalTokens:
 *                       type: number
 *                       example: 470
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or AI provider not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/analyze', express.json(), async (req, res) => {
  try {
    const { content, existingTags, id } = req.body;
    let existingCorrespondentList = await paperlessService.listCorrespondentsNames();
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);
    let existingTagsList = await paperlessService.listTagNames();
    existingTagsList = existingTagsList.map(tags => tags.name);
    let existingDocumentTypes = await paperlessService.listDocumentTypesNames();
    let existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);
    
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzeDocument(content, existingTagsList, existingCorrespondentList, existingDocumentTypesList, id || []);
      await documentModel.addOpenAIMetrics(
            id, 
            analyzeDocument.metrics.promptTokens,
            analyzeDocument.metrics.completionTokens,
            analyzeDocument.metrics.totalTokens
          )
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzeDocument(content, existingTagsList, existingCorrespondentList, existingDocumentTypesList, id || []);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzeDocument(content, existingTagsList, existingCorrespondentList, existingDocumentTypesList, id || []);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'azure') {
      const analyzeDocument = await azureService.analyzeDocument(content, existingTagsList, existingCorrespondentList, existingDocumentTypesList, id || []);
      return res.json(analyzeDocument);
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /manual/playground:
 *   post:
 *     summary: Process document using a custom prompt in playground mode
 *     description: |
 *       Analyzes document content using a custom user-provided prompt.
 *       This endpoint is primarily used for testing and experimenting with different prompts
 *       without affecting the actual document processing workflow.
 *       
 *       The analysis is performed using the AI provider configured in the application settings,
 *       but with a custom prompt that overrides the default system prompt.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The document text content to analyze
 *                 example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *               prompt:
 *                 type: string
 *                 description: Custom prompt to use for analysis
 *                 example: "Extract the company name, invoice amount, and due date from this document."
 *               documentId:
 *                 type: string
 *                 description: Optional document ID for tracking metrics
 *                 example: "doc_123"
 *     responses:
 *       200:
 *         description: Document analysis results using the custom prompt
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 result:
 *                   type: string
 *                   description: The raw AI response using the custom prompt
 *                   example: "Company: Acme Corp\nAmount: $125.00\nDue Date: 2023-08-15"
 *                 metrics:
 *                   type: object
 *                   description: Token usage metrics (when using OpenAI)
 *                   properties:
 *                     promptTokens:
 *                       type: number
 *                       example: 350
 *                     completionTokens:
 *                       type: number
 *                       example: 120
 *                     totalTokens:
 *                       type: number
 *                       example: 470
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or AI provider not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/playground', express.json(), async (req, res) => {
  try {
    const { content, existingTags, prompt, documentId } = req.body;
    
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzePlayground(content, prompt);
      await documentModel.addOpenAIMetrics(
        documentId, 
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      )
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzePlayground(content, prompt);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzePlayground(content, prompt);
      await documentModel.addOpenAIMetrics(
        documentId, 
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      )
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'azure') {
      const analyzeDocument = await azureService.analyzePlayground(content, prompt);
      await documentModel.addOpenAIMetrics(
        documentId, 
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      )
      return res.json(analyzeDocument);
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /manual/updateDocument:
 *   post:
 *     summary: Update document metadata in Paperless-ngx
 *     description: |
 *       Updates document metadata such as tags, correspondent and title in the Paperless-ngx system.
 *       This endpoint handles the translation between tag names and IDs, and manages the creation of
 *       new tags or correspondents if they don't exist in the system.
 *       
 *       The endpoint also removes any unused tags from the document to keep the metadata clean.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - documentId
 *             properties:
 *               documentId:
 *                 type: number
 *                 description: ID of the document to update in Paperless-ngx
 *                 example: 123
 *               tags:
 *                 type: array
 *                 description: List of tags to apply (can be tag IDs or names)
 *                 items:
 *                   oneOf:
 *                     - type: number
 *                     - type: string
 *                 example: ["Invoice", 42, "Finance"]
 *               correspondent:
 *                 type: string
 *                 description: Correspondent name to assign to the document
 *                 example: "Acme Corp"
 *               title:
 *                 type: string
 *                 description: New title for the document
 *                 example: "Acme Corp Invoice - August 2023"
 *     responses:
 *       200:
 *         description: Document successfully updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Document updated successfully"
 *       400:
 *         description: Invalid request parameters or tag processing errors
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["Failed to create tag: Invalid tag name"]
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/updateDocument', express.json(), async (req, res) => {
  try {
    var { documentId, tags, correspondent, title } = req.body;
    const options = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes',
      restrictToExistingDocumentTypes: config.restrictToExistingDocumentTypes === 'yes'
    };

    console.log("TITLE: ", title);
    // Convert all tags to names if they are IDs
    tags = await Promise.all(tags.map(async tag => {
      console.log('Processing tag:', tag);
      if (!isNaN(tag)) {
        const tagName = await paperlessService.getTagTextFromId(Number(tag));
        console.log('Converted tag ID:', tag, 'to name:', tagName);
        return tagName;
      }
      return tag;
    }));

    // Filter out any null or undefined tags
    tags = tags.filter(tag => tag != null);

    // Process new tags to get their IDs
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Process correspondent if provided
    const correspondentData = correspondent ? await paperlessService.getOrCreateCorrespondent(correspondent, options) : null;


    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);
    
    // Then update with new tags (this will only add new ones since we already removed unused ones)
    const updateData = {
      tags: tagIds,
      correspondent: correspondentData ? correspondentData.id : null,
      title: title ? title : null
    };

    if(updateData.tags === null && updateData.correspondent === null && updateData.title === null) {
      return res.status(400).json({ error: 'No changes provided' });
    }
    const updateDocument = await paperlessService.updateDocument(documentId, updateData);
    
    // Mark document as processed
    await documentModel.addProcessedDocument(documentId, updateData.title);

    res.json(updateDocument);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Provides information about the current system health status.
 *       This endpoint checks database connectivity and returns system operational status.
 *       Used for monitoring and automated health checks.
 *     tags: 
 *       - System
 *     responses:
 *       200:
 *         description: System is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: Health status of the system
 *                   example: "healthy"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: Status indicating an error
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   description: Error message details
 *                   example: "Internal server error"
 *       503:
 *         description: Service unavailable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: Status indicating database error
 *                   example: "database_error"
 *                 message:
 *                   type: string
 *                   description: Details about the service unavailability
 *                   example: "Database check failed"
 */
router.get('/health', async (req, res) => {
  try {
    // const isConfigured = await setupService.isConfigured();
    // if (!isConfigured) {
    //   return res.status(503).json({ 
    //     status: 'not_configured',
    //     message: 'Application setup not completed'
    //   });
    // }
    try {
      await documentModel.isDocumentProcessed(1);
    } catch (error) {
      return res.status(503).json({ 
        status: 'database_error',
        message: 'Database check failed'
      });
    }

    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

/**
 * @swagger
 * /settings:
 *   post:
 *     summary: Update application settings
 *     description: |
 *       Updates the configuration settings of the Paperless-AI next application after initial setup.
 *       This endpoint allows administrators to modify connections to Paperless-ngx, 
 *       AI provider settings, processing parameters, and feature toggles.
 *       
 *       Changes made through this endpoint are applied immediately and affect all future
 *       document processing operations.
 *     tags:
 *       - System
 *       - Setup
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paperlessUrl:
 *                 type: string
 *                 description: URL of the Paperless-ngx instance
 *                 example: "https://paperless.example.com"
 *               paperlessToken:
 *                 type: string
 *                 description: API token for Paperless-ngx access
 *                 example: "abc123def456"
 *               paperlessUsername:
 *                 type: string
 *                 description: Username for Paperless-ngx (alternative to token authentication)
 *                 example: "admin"
 *               aiProvider:
 *                 type: string
 *                 description: Selected AI provider for document analysis
 *                 enum: ["openai", "ollama", "custom", "azure"]
 *                 example: "openai"
 *               openaiKey:
 *                 type: string
 *                 description: API key for OpenAI (required when aiProvider is 'openai')
 *                 example: "sk-abc123def456"
 *               openaiModel:
 *                 type: string
 *                 description: OpenAI model to use for analysis
 *                 example: "gpt-4"
 *               ollamaUrl:
 *                 type: string
 *                 description: URL for Ollama API (required when aiProvider is 'ollama')
 *                 example: "http://localhost:11434"
 *               ollamaModel:
 *                 type: string
 *                 description: Ollama model to use for analysis
 *                 example: "llama2"
 *               customApiKey:
 *                 type: string
 *                 description: API key for custom LLM provider
 *                 example: "api-key-123"
 *               customBaseUrl:
 *                 type: string
 *                 description: Base URL for custom LLM provider
 *                 example: "https://api.customllm.com"
 *               customModel:
 *                 type: string
 *                 description: Model name for custom LLM provider
 *                 example: "custom-model"
 *               scanInterval:
 *                 type: number
 *                 description: Interval in minutes for scanning new documents
 *                 example: 15
 *               systemPrompt:
 *                 type: string
 *                 description: Custom system prompt for document analysis
 *                 example: "Extract key information from the following document..."
 *               showTags:
 *                 type: boolean
 *                 description: Whether to show tags in the UI
 *                 example: true
 *               tokenLimit:
 *                 type: integer
 *                 description: The maximum number of tokens th AI can handle
 *                 example: 128000
 *               responseTokens:
 *                 type: integer
 *                 description: The approx. amount of tokens required for the response
 *                 example: 1000
 *               aiTemperatureAnalysis:
 *                 type: number
 *                 description: Temperature for analysis/classification calls (range 0.0-2.0)
 *                 example: 0.3
 *               aiTemperatureGeneration:
 *                 type: number
 *                 description: Temperature for generation calls (range 0.0-2.0)
 *                 example: 0.7
 *               tags:
 *                 type: string
 *                 description: Comma-separated list of tags to use for filtering
 *                 example: "Invoice,Receipt,Contract"
 *               aiProcessedTag:
 *                 type: boolean
 *                 description: Whether to add a tag for AI-processed documents
 *                 example: true
 *               aiTagName:
 *                 type: string
 *                 description: Tag name to use for AI-processed documents
 *                 example: "AI-Processed"
 *               usePromptTags:
 *                 type: boolean
 *                 description: Whether to use tags in prompts
 *                 example: true
 *               promptTags:
 *                 type: string
 *                 description: Comma-separated list of tags to use in prompts
 *                 example: "Invoice,Receipt"
 *               useExistingData:
 *                 type: boolean
 *                 description: Whether to use existing data from a previous setup
 *                 example: false
 *               activateTagging:
 *                 type: boolean
 *                 description: Enable AI-based tag suggestions
 *                 example: true
 *               activateCorrespondents:
 *                 type: boolean
 *                 description: Enable AI-based correspondent suggestions
 *                 example: true
 *               activateDocumentType:
 *                 type: boolean
 *                 description: Enable AI-based document type suggestions
 *                 example: true
 *               activateTitle:
 *                 type: boolean
 *                 description: Enable AI-based title suggestions
 *                 example: true
 *               activateCustomFields:
 *                 type: boolean
 *                 description: Enable AI-based custom field extraction
 *                 example: false
 *               customFields:
 *                 type: string
 *                 description: JSON string defining custom fields to extract
 *                 example: '{"invoice_number":{"type":"string"},"total_amount":{"type":"number"}}'
 *               disableAutomaticProcessing:
 *                 type: boolean
 *                 description: Disable automatic document processing
 *                 example: false
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["success"]
 *                   example: "success"
 *                 message:
 *                   type: string
 *                   example: "Settings updated successfully"
 *       400:
 *         description: Invalid configuration parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["error"]
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   example: "Invalid settings: AI provider required when automatic processing is enabled"
 *       500:
 *         description: Server error while updating settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["error"]
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   example: "Failed to update settings: Database error"
 */
router.post('/settings', express.json(), async (req, res) => {
  try {
    const { 
      paperlessUrl, 
      paperlessPublicUrl,
      paperlessToken,
      aiProvider,
      openaiKey,
      openaiModel,
      ollamaUrl,
      ollamaModel,
      scanInterval,
      systemPrompt,
      showTags,
      tokenLimit,
      responseTokens,
      aiTemperatureAnalysis,
      aiTemperatureGeneration,
      tags,
      ignoreTags,
      aiProcessedTag,
      aiTagName,
      usePromptTags,
      promptTags,
      paperlessUsername,
      useExistingData,
      customApiKey,
      customBaseUrl,
      customModel,
      activateTagging,
      activateCorrespondents,
      activateDocumentType,
      activateTitle,
      activateCustomFields,
      customFields,  // Added parameter
      disableAutomaticProcessing,
      azureEndpoint,
      azureApiKey,
      azureDeploymentName,
      azureApiVersion,
      tagCacheTTL,
      mistralOcrEnabled,
      ocrProvider,
      ocrApiUrl,
      ocrApiKey,
      mistralApiKey,
      mistralOcrModel,
      globalRateLimitWindowMs,
      globalRateLimitMax,
      trustProxy,
      cookieSecureMode,
      minContentLength,
      paperlessAiPort,
      externalApiAllowPrivateIps,
      logLevel
    } = req.body;

    //replace equal char in system prompt
    const processedPrompt = systemPrompt
      ? systemPrompt.replace(/\r\n/g, '\n').replace(/=/g, '')
      : '';


    const currentConfig = {
      PAPERLESS_API_URL: process.env.PAPERLESS_API_URL || '',
      PAPERLESS_PUBLIC_URL: process.env.PAPERLESS_PUBLIC_URL || '',
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || '',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || '',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      RECONCILIATION_INTERVAL: process.env.RECONCILIATION_INTERVAL || '0 * * * *',
      RECONCILIATION_ENABLED: process.env.RECONCILIATION_ENABLED || 'yes',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      AI_TEMPERATURE_ANALYSIS: process.env.AI_TEMPERATURE_ANALYSIS || '0.3',
      AI_TEMPERATURE_GENERATION: process.env.AI_TEMPERATURE_GENERATION || '0.7',
      TAGS: process.env.TAGS || '',
      IGNORE_TAGS: process.env.IGNORE_TAGS || '',
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: process.env.PROMPT_TAGS || '',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      API_KEY: process.env.API_KEY || '',
      CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
      CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
      CUSTOM_MODEL: process.env.CUSTOM_MODEL || '',
      ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING || 'yes',
      ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS || 'yes',
      ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE || 'yes',
      ACTIVATE_TITLE: process.env.ACTIVATE_TITLE || 'yes',
      ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS || 'yes',
      CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}',  // Added default
      DISABLE_AUTOMATIC_PROCESSING: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT|| '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
      RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
      RESTRICT_TO_EXISTING_CORRESPONDENTS: process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
      RESTRICT_TO_EXISTING_DOCUMENT_TYPES: process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
      EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
      EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
      EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
      EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
      EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
      EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
      EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || '',
      EXTERNAL_API_ALLOW_PRIVATE_IPS: process.env.EXTERNAL_API_ALLOW_PRIVATE_IPS || 'no',
      TAG_CACHE_TTL_SECONDS: process.env.TAG_CACHE_TTL_SECONDS || '300',
      MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
      OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
      OCR_API_URL: process.env.OCR_API_URL || '',
      OCR_API_KEY: process.env.OCR_API_KEY || '',
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
      MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      GLOBAL_RATE_LIMIT_WINDOW_MS: process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000',
      GLOBAL_RATE_LIMIT_MAX: process.env.GLOBAL_RATE_LIMIT_MAX || '1000',
      TRUST_PROXY: typeof process.env.TRUST_PROXY === 'undefined' ? '' : process.env.TRUST_PROXY,
      COOKIE_SECURE_MODE: process.env.COOKIE_SECURE_MODE || 'auto',
      MIN_CONTENT_LENGTH: process.env.MIN_CONTENT_LENGTH || '10',
      PAPERLESS_AI_PORT: process.env.PAPERLESS_AI_PORT || '3000',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    };

    const hasValue = (value) => typeof value === 'string' && value.trim() !== '';

    const hasPaperlessTokenInput = hasValue(paperlessToken);
    const hasPaperlessUrlInput = hasValue(paperlessUrl);
    const normalizedCurrentPaperlessUrl = (currentConfig.PAPERLESS_API_URL || '').replace(/\/api$/, '');
    const effectivePaperlessUrl = hasPaperlessUrlInput ? paperlessUrl : normalizedCurrentPaperlessUrl;
    const effectivePaperlessToken = hasPaperlessTokenInput ? paperlessToken.trim() : currentConfig.PAPERLESS_API_TOKEN;
    const hasOpenAiKeyInput = hasValue(openaiKey);
    const effectiveOpenAiKey = hasOpenAiKeyInput ? openaiKey.trim() : currentConfig.OPENAI_API_KEY;
    const hasCustomApiKeyInput = hasValue(customApiKey);
    const effectiveCustomApiKey = hasCustomApiKeyInput ? customApiKey.trim() : currentConfig.CUSTOM_API_KEY;
    const hasAzureApiKeyInput = hasValue(azureApiKey);
    const effectiveAzureApiKey = hasAzureApiKeyInput ? azureApiKey.trim() : currentConfig.AZURE_API_KEY;
    const normalizedOcrApiKeyInput = hasValue(ocrApiKey)
      ? String(ocrApiKey).trim()
      : String(mistralApiKey || '').trim();
    const hasOcrApiKeyInput = hasValue(normalizedOcrApiKeyInput);
    const effectiveOcrApiKey = hasOcrApiKeyInput
      ? normalizedOcrApiKeyInput
      : (currentConfig.OCR_API_KEY || currentConfig.MISTRAL_API_KEY || '');
    const normalizedOcrProvider = String(ocrProvider || currentConfig.OCR_PROVIDER || 'mistral').trim().toLowerCase();
    const effectiveOcrEnabled = hasValue(mistralOcrEnabled)
      ? String(mistralOcrEnabled).trim().toLowerCase()
      : String(currentConfig.MISTRAL_OCR_ENABLED || 'no').trim().toLowerCase();
    const effectiveOcrApiUrl = hasValue(ocrApiUrl)
      ? String(ocrApiUrl).trim()
      : String(currentConfig.OCR_API_URL || '').trim();
    const effectiveOcrModel = hasValue(mistralOcrModel)
      ? String(mistralOcrModel).trim()
      : String(currentConfig.MISTRAL_OCR_MODEL || 'mistral-ocr-latest').trim();
    const normalizeCompare = (value) => String(value || '').trim();

    if (!['mistral', 'custom', 'ollama'].includes(normalizedOcrProvider)) {
      return res.status(400).json({
        error: 'Invalid OCR provider. Allowed values are mistral and custom.'
      });
    }

    if (effectiveOcrEnabled === 'yes' && normalizedOcrProvider === 'mistral' && !effectiveOcrApiKey) {
      return res.status(400).json({
        error: 'Mistral API key is required when OCR fallback is enabled with provider mistral.'
      });
    }

    const currentOcrEnabled = String(currentConfig.MISTRAL_OCR_ENABLED || 'no').trim().toLowerCase();
    const currentOcrProvider = String(currentConfig.OCR_PROVIDER || 'mistral').trim().toLowerCase();
    const currentOcrApiUrl = String(currentConfig.OCR_API_URL || '').trim();
    const currentOcrModel = String(currentConfig.MISTRAL_OCR_MODEL || 'mistral-ocr-latest').trim();
    const shouldValidateOcr =
      effectiveOcrEnabled === 'yes' && (
        currentOcrEnabled !== effectiveOcrEnabled
        || currentOcrProvider !== normalizedOcrProvider
        || currentOcrApiUrl !== effectiveOcrApiUrl
        || currentOcrModel !== effectiveOcrModel
        || hasOcrApiKeyInput
      );

    if (shouldValidateOcr) {
      const normalizedOcrProviderForValidation = normalizedOcrProvider === 'custom' ? 'ollama' : normalizedOcrProvider;
      const ocrValid = await setupService.validateOcrConfig({
        enabled: effectiveOcrEnabled,
        provider: normalizedOcrProviderForValidation,
        apiUrl: effectiveOcrApiUrl,
        apiKey: effectiveOcrApiKey,
        model: effectiveOcrModel
      });

      if (!ocrValid) {
        return res.status(400).json({
          error: `OCR connection failed or timed out after ${setupService.getValidationTimeoutMs()}ms. Please check OCR provider, OCR API URL, API key and model.`
        });
      }
    }

    // Process custom fields
    let processedCustomFields = [];
    if (customFields) {
      try {
        const parsedFields = typeof customFields === 'string' 
          ? JSON.parse(customFields) 
          : customFields;
        
        processedCustomFields = parsedFields.custom_fields.map(field => ({
          value: field.value,
          data_type: field.data_type,
          ...(field.currency && { currency: field.currency })
        }));
      } catch (error) {
        console.error('Error processing custom fields:', error);
        processedCustomFields = [];
      }
    }

    const normalizeArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
      return [];
    };

    const sanitizeTemperatureValue = (rawValue, fallbackValue, envKey) => {
      const normalizedValue = String(rawValue ?? '').trim();
      if (!normalizedValue) {
        return fallbackValue;
      }

      const parsed = Number.parseFloat(normalizedValue);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
        console.warn(`[WARN] Invalid ${envKey} value: ${normalizedValue}. Using fallback: ${fallbackValue}`);
        return fallbackValue;
      }

      return String(parsed);
    };

    // Extract tag and correspondent restriction settings with defaults
    const restrictToExistingTags = req.body.restrictToExistingTags === 'on' || req.body.restrictToExistingTags === 'yes';
    const restrictToExistingCorrespondents = req.body.restrictToExistingCorrespondents === 'on' || req.body.restrictToExistingCorrespondents === 'yes';
    const restrictToExistingDocumentTypes = req.body.restrictToExistingDocumentTypes === 'on' || req.body.restrictToExistingDocumentTypes === 'yes';
    
    // Extract external API settings with defaults
    const externalApiEnabled = req.body.externalApiEnabled === 'on' || req.body.externalApiEnabled === 'yes';
    const externalApiUrl = req.body.externalApiUrl || '';
    const externalApiMethod = req.body.externalApiMethod || 'GET';
    const externalApiHeaders = req.body.externalApiHeaders || '{}';
    const externalApiBody = req.body.externalApiBody || '{}';
    const externalApiTimeout = req.body.externalApiTimeout || '5000';
    const externalApiTransform = req.body.externalApiTransform || '';

    if ((effectivePaperlessUrl && effectivePaperlessUrl !== normalizedCurrentPaperlessUrl) || hasPaperlessTokenInput) {
      const isPaperlessValid = await setupService.validatePaperlessConfig(effectivePaperlessUrl, effectivePaperlessToken);
      if (!isPaperlessValid) {
        return res.status(400).json({ 
          error: 'Paperless-ngx connection failed. Please check URL and Token.'
        });
      }
    }

    const updatedConfig = {};

    if (hasPaperlessUrlInput) updatedConfig.PAPERLESS_API_URL = effectivePaperlessUrl;
    if (typeof paperlessPublicUrl === 'string') updatedConfig.PAPERLESS_PUBLIC_URL = paperlessPublicUrl.trim();
    if (hasPaperlessTokenInput) updatedConfig.PAPERLESS_API_TOKEN = effectivePaperlessToken;
    if (paperlessUsername) updatedConfig.PAPERLESS_USERNAME = paperlessUsername;

    // Handle AI provider configuration
    if (aiProvider) {
      const selectedAiProvider = String(aiProvider).trim().toLowerCase();
      const currentAiProvider = String(currentConfig.AI_PROVIDER || '').trim().toLowerCase();
      const providerChanged = selectedAiProvider !== currentAiProvider;

      updatedConfig.AI_PROVIDER = selectedAiProvider;

      if (selectedAiProvider === 'openai') {
        const modelChanged = hasValue(openaiModel) && normalizeCompare(openaiModel) !== normalizeCompare(currentConfig.OPENAI_MODEL);
        const shouldValidateOpenAi = providerChanged || hasOpenAiKeyInput || modelChanged;

        if (!effectiveOpenAiKey) {
          return res.status(400).json({
            error: 'OpenAI API key is required when OpenAI provider is selected.'
          });
        }

        if (shouldValidateOpenAi) {
          const isOpenAIValid = await setupService.validateOpenAIConfig(effectiveOpenAiKey);
          if (!isOpenAIValid) {
            return res.status(400).json({ 
              error: `OpenAI API Key is not valid or timed out after ${setupService.getValidationTimeoutMs()}ms. Please check the key and connectivity.`
            });
          }
        }

        if (hasOpenAiKeyInput) {
          updatedConfig.OPENAI_API_KEY = effectiveOpenAiKey;
        }
        if (openaiModel) updatedConfig.OPENAI_MODEL = openaiModel;
      } else if (selectedAiProvider === 'ollama') {
        const effectiveOllamaUrl = ollamaUrl || currentConfig.OLLAMA_API_URL;
        const effectiveOllamaModel = ollamaModel || currentConfig.OLLAMA_MODEL;
        const urlChanged = hasValue(ollamaUrl) && normalizeCompare(ollamaUrl) !== normalizeCompare(currentConfig.OLLAMA_API_URL);
        const modelChanged = hasValue(ollamaModel) && normalizeCompare(ollamaModel) !== normalizeCompare(currentConfig.OLLAMA_MODEL);
        const shouldValidateOllama = providerChanged || urlChanged || modelChanged;

        if (!effectiveOllamaUrl || !effectiveOllamaModel) {
          return res.status(400).json({
            error: 'Ollama URL and model are required when Ollama provider is selected.'
          });
        }

        if (shouldValidateOllama) {
          const isOllamaValid = await setupService.validateOllamaConfig(
            effectiveOllamaUrl,
            effectiveOllamaModel
          );
          if (!isOllamaValid) {
            return res.status(400).json({ 
              error: `Ollama connection failed or timed out after ${setupService.getValidationTimeoutMs()}ms. Please check URL and model.`
            });
          }
        }

        if (ollamaUrl) updatedConfig.OLLAMA_API_URL = ollamaUrl;
        if (ollamaModel) updatedConfig.OLLAMA_MODEL = ollamaModel;
      } else if (selectedAiProvider === 'custom') {
        const effectiveCustomBaseUrl = customBaseUrl || currentConfig.CUSTOM_BASE_URL;
        const effectiveCustomModel = customModel || currentConfig.CUSTOM_MODEL;
        const urlChanged = hasValue(customBaseUrl) && normalizeCompare(customBaseUrl) !== normalizeCompare(currentConfig.CUSTOM_BASE_URL);
        const modelChanged = hasValue(customModel) && normalizeCompare(customModel) !== normalizeCompare(currentConfig.CUSTOM_MODEL);
        const shouldValidateCustom = providerChanged || hasCustomApiKeyInput || urlChanged || modelChanged;

        if (!effectiveCustomBaseUrl || !effectiveCustomModel) {
          return res.status(400).json({
            error: 'Custom provider URL and model are required when custom provider is selected.'
          });
        }

        if (shouldValidateCustom) {
          const isCustomValid = await setupService.validateCustomConfig(
            effectiveCustomBaseUrl,
            effectiveCustomApiKey,
            effectiveCustomModel
          );
          if (!isCustomValid) {
            return res.status(400).json({
              error: `Custom provider connection failed or timed out after ${setupService.getValidationTimeoutMs()}ms. Please check URL, API key and model.`
            });
          }
        }

        if (hasCustomApiKeyInput) updatedConfig.CUSTOM_API_KEY = effectiveCustomApiKey;
        if (customBaseUrl) updatedConfig.CUSTOM_BASE_URL = customBaseUrl;
        if (customModel) updatedConfig.CUSTOM_MODEL = customModel;
      } else if (selectedAiProvider === 'azure') {
        const effectiveAzureEndpoint = azureEndpoint || currentConfig.AZURE_ENDPOINT;
        const effectiveAzureDeployment = azureDeploymentName || currentConfig.AZURE_DEPLOYMENT_NAME;
        const effectiveAzureApiVersion = azureApiVersion || currentConfig.AZURE_API_VERSION;
        const endpointChanged = hasValue(azureEndpoint) && normalizeCompare(azureEndpoint) !== normalizeCompare(currentConfig.AZURE_ENDPOINT);
        const deploymentChanged = hasValue(azureDeploymentName) && normalizeCompare(azureDeploymentName) !== normalizeCompare(currentConfig.AZURE_DEPLOYMENT_NAME);
        const versionChanged = hasValue(azureApiVersion) && normalizeCompare(azureApiVersion) !== normalizeCompare(currentConfig.AZURE_API_VERSION);
        const shouldValidateAzure = providerChanged || hasAzureApiKeyInput || endpointChanged || deploymentChanged || versionChanged;

        if (!effectiveAzureEndpoint || !effectiveAzureApiKey || !effectiveAzureDeployment) {
          return res.status(400).json({
            error: 'Azure endpoint, API key and deployment name are required when Azure provider is selected.'
          });
        }

        if (shouldValidateAzure) {
          const isAzureValid = await setupService.validateAzureConfig(effectiveAzureApiKey, effectiveAzureEndpoint, effectiveAzureDeployment, effectiveAzureApiVersion);
          if (!isAzureValid) {
            return res.status(400).json({
              error: `Azure connection failed or timed out after ${setupService.getValidationTimeoutMs()}ms. Please check URL, API key, deployment name and API version.`
            });
          }
        }

        if (azureEndpoint) updatedConfig.AZURE_ENDPOINT = azureEndpoint;
        if (hasAzureApiKeyInput) updatedConfig.AZURE_API_KEY = effectiveAzureApiKey;
        if (azureDeploymentName) updatedConfig.AZURE_DEPLOYMENT_NAME = azureDeploymentName;
        if (azureApiVersion) updatedConfig.AZURE_API_VERSION = azureApiVersion;
      }
    }

    // Update general settings
    if (scanInterval) updatedConfig.SCAN_INTERVAL = scanInterval;
    if (systemPrompt) updatedConfig.SYSTEM_PROMPT = processedPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    if (showTags) updatedConfig.PROCESS_PREDEFINED_DOCUMENTS = showTags;
    if (tokenLimit) updatedConfig.TOKEN_LIMIT = tokenLimit;
    if (responseTokens) updatedConfig.RESPONSE_TOKENS = responseTokens;
    if (aiTemperatureAnalysis !== undefined) {
      updatedConfig.AI_TEMPERATURE_ANALYSIS = sanitizeTemperatureValue(
        aiTemperatureAnalysis,
        currentConfig.AI_TEMPERATURE_ANALYSIS,
        'AI_TEMPERATURE_ANALYSIS'
      );
    }
    if (aiTemperatureGeneration !== undefined) {
      updatedConfig.AI_TEMPERATURE_GENERATION = sanitizeTemperatureValue(
        aiTemperatureGeneration,
        currentConfig.AI_TEMPERATURE_GENERATION,
        'AI_TEMPERATURE_GENERATION'
      );
    }
    if (tags !== undefined) updatedConfig.TAGS = normalizeArray(tags);
    if (ignoreTags !== undefined) updatedConfig.IGNORE_TAGS = normalizeArray(ignoreTags);
    if (aiProcessedTag) updatedConfig.ADD_AI_PROCESSED_TAG = aiProcessedTag;
    if (aiTagName) updatedConfig.AI_PROCESSED_TAG_NAME = aiTagName;
    if (usePromptTags) updatedConfig.USE_PROMPT_TAGS = usePromptTags;
    if (promptTags) updatedConfig.PROMPT_TAGS = normalizeArray(promptTags);
    if (useExistingData) updatedConfig.USE_EXISTING_DATA = useExistingData;
    if (disableAutomaticProcessing) updatedConfig.DISABLE_AUTOMATIC_PROCESSING = disableAutomaticProcessing;

    // Update custom fields
    if (processedCustomFields.length > 0 || customFields) {
      updatedConfig.CUSTOM_FIELDS = JSON.stringify({ 
        custom_fields: processedCustomFields 
      });
    }

      // Handle limit functions
      updatedConfig.ACTIVATE_TAGGING = activateTagging ? 'yes' : 'no';
      updatedConfig.ACTIVATE_CORRESPONDENTS = activateCorrespondents ? 'yes' : 'no';
      updatedConfig.ACTIVATE_DOCUMENT_TYPE = activateDocumentType ? 'yes' : 'no';
      updatedConfig.ACTIVATE_TITLE = activateTitle ? 'yes' : 'no';
      updatedConfig.ACTIVATE_CUSTOM_FIELDS = activateCustomFields ? 'yes' : 'no';
      
      // Handle tag and correspondent restrictions
      updatedConfig.RESTRICT_TO_EXISTING_TAGS = restrictToExistingTags ? 'yes' : 'no';
      updatedConfig.RESTRICT_TO_EXISTING_CORRESPONDENTS = restrictToExistingCorrespondents ? 'yes' : 'no';
      updatedConfig.RESTRICT_TO_EXISTING_DOCUMENT_TYPES = restrictToExistingDocumentTypes ? 'yes' : 'no';
      
      // Handle external API integration
      updatedConfig.EXTERNAL_API_ENABLED = externalApiEnabled ? 'yes' : 'no';
      updatedConfig.EXTERNAL_API_URL = externalApiUrl || '';
      updatedConfig.EXTERNAL_API_METHOD = externalApiMethod || 'GET';
      updatedConfig.EXTERNAL_API_HEADERS = externalApiHeaders || '{}';
      updatedConfig.EXTERNAL_API_BODY = externalApiBody || '{}';
      updatedConfig.EXTERNAL_API_TIMEOUT = externalApiTimeout || '5000';
      updatedConfig.EXTERNAL_API_TRANSFORM = externalApiTransform || '';
      updatedConfig.EXTERNAL_API_ALLOW_PRIVATE_IPS = externalApiAllowPrivateIps || 'no';

      if (mistralOcrEnabled) updatedConfig.MISTRAL_OCR_ENABLED = mistralOcrEnabled;
      if (ocrProvider) updatedConfig.OCR_PROVIDER = String(ocrProvider).trim().toLowerCase();
      if (typeof ocrApiUrl === 'string') updatedConfig.OCR_API_URL = ocrApiUrl.trim();
      if (hasOcrApiKeyInput) {
        updatedConfig.OCR_API_KEY = effectiveOcrApiKey;
        updatedConfig.MISTRAL_API_KEY = effectiveOcrApiKey;
      }
      if (mistralOcrModel) updatedConfig.MISTRAL_OCR_MODEL = mistralOcrModel;
      if (globalRateLimitWindowMs) updatedConfig.GLOBAL_RATE_LIMIT_WINDOW_MS = globalRateLimitWindowMs;
      if (globalRateLimitMax) updatedConfig.GLOBAL_RATE_LIMIT_MAX = globalRateLimitMax;
      if (typeof trustProxy === 'string') updatedConfig.TRUST_PROXY = trustProxy.trim();
      if (typeof cookieSecureMode === 'string') {
        const normalizedCookieSecureMode = cookieSecureMode.trim().toLowerCase();
        if (['auto', 'always', 'never'].includes(normalizedCookieSecureMode)) {
          updatedConfig.COOKIE_SECURE_MODE = normalizedCookieSecureMode;
        } else {
          return res.status(400).json({
            error: 'Invalid Cookie Secure Mode. Allowed values: auto, always, never.'
          });
        }
      }
      if (minContentLength) updatedConfig.MIN_CONTENT_LENGTH = minContentLength;
      if (paperlessAiPort) updatedConfig.PAPERLESS_AI_PORT = paperlessAiPort;
      if (typeof logLevel === 'string') {
        const normalizedLogLevel = logLevel.trim().toLowerCase();
        if (['debug', 'info', 'warn', 'error'].includes(normalizedLogLevel)) {
          updatedConfig.LOG_LEVEL = normalizedLogLevel;
        } else {
          return res.status(400).json({
            error: 'Invalid Log Level. Allowed values: debug, info, warn, error.'
          });
        }
      }

    // Update tag cache TTL (validate range: 60-3600 seconds)
    if (tagCacheTTL !== undefined) {
      const ttl = parseInt(tagCacheTTL, 10);
      if (!isNaN(ttl) && ttl >= 60 && ttl <= 3600) {
        updatedConfig.TAG_CACHE_TTL_SECONDS = ttl.toString();
      } else {
        console.warn(`[WARN] Invalid TAG_CACHE_TTL_SECONDS value: ${tagCacheTTL}. Using default: 300`);
        updatedConfig.TAG_CACHE_TTL_SECONDS = '300';
      }
    }

    // Handle API key
    let apiToken = configFile.getApiKey ? configFile.getApiKey() : (process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '');
    if (!apiToken) {
      console.log('Generating new API key');
      apiToken = require('crypto').randomBytes(64).toString('hex');
      updatedConfig.API_KEY = apiToken;
    }

    const mergedConfig = {
      ...currentConfig,
      ...updatedConfig
    };

    await setupService.saveConfig(mergedConfig);
    try {
      for (const field of processedCustomFields) {
        await paperlessService.createCustomFieldSafely(field.value, field.data_type, field.currency);
      }
    } catch (error) {
      console.log('[ERROR] Error creating custom fields:', error);
    }

    res.json({ 
      success: true,
      message: 'Configuration saved successfully.',
      restart: true
    });

    // NOTE: paperlessService caches the tag cache TTL (_cacheTTL) in memory.
    // The new TAG_CACHE_TTL_SECONDS value will take effect after the server
    // restart that is triggered below. If the restart mechanism is changed
    // or removed in the future, make sure to also reset paperlessService._cacheTTL
    // to null so that its cached TTL is invalidated and reloaded from config.
    setTimeout(() => {
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({ 
      error: 'An error occurred: ' + error.message
    });
  }
});

/**
 * @swagger
 * /api/processing-status:
 *   get:
 *     summary: Get document processing status
 *     description: |
 *       Returns the current status of document processing operations.
 *       This endpoint provides information about documents in the processing queue
 *       and the current processing state (active/idle).
 *       
 *       The status information can be used by UIs to display progress indicators
 *       and provide real-time feedback about background processing operations.
 *     tags:
 *       - Documents
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Processing status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isProcessing:
 *                   type: boolean
 *                   description: Whether documents are currently being processed
 *                   example: true
 *                 isScanning:
 *                   type: boolean
 *                   description: Whether a scan loop is currently running
 *                   example: true
 *                 stopRequested:
 *                   type: boolean
 *                   description: Whether a graceful stop has been requested
 *                   example: false
 *                 currentlyProcessing:
 *                   type: object
 *                   description: Details about the document currently being processed (if any)
 *                   properties:
 *                     documentId:
 *                       type: integer
 *                       description: Document ID
 *                       example: 123
 *                     title:
 *                       type: string
 *                       description: Document title
 *                       example: "Invoice #12345"
 *                     status:
 *                       type: string
 *                       description: Current processing status
 *                       example: "processing"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Failed to fetch processing status"
 */
router.get('/api/processing-status', isAuthenticated, async (req, res) => {
  try {
      const status = await documentModel.getCurrentProcessingStatus();
      const scanState = global.__paperlessAiScanControl || {};
      res.json({
        ...status,
        isScanning: Boolean(scanState.running),
        stopRequested: Boolean(scanState.stopRequested)
      });
  } catch (error) {
      res.status(500).json({ error: 'Failed to fetch processing status' });
  }
});

router.get('/dashboard/doc/:id', async (req, res) => {
  const docId = req.params.id;
  if (!docId) {
    return res.status(400).json({ error: 'Document ID is required' });
  }
  try {
    const paperlessPublicUrl = await paperlessService.getPublicBaseUrl();
    if (!paperlessPublicUrl) {
      return res.status(500).json({ error: 'Paperless public URL is not configured' });
    }

    const redirectUrl = `${paperlessPublicUrl}/documents/${docId}/details`;
    console.log('Redirecting to Paperless-ngx URL:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

/**
 * @swagger
 * /dashboard/doc/{id}:
 *   get:
 *     summary: Redirect to Paperless document details
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       302:
 *         description: Redirect to Paperless document page
 *       400:
 *         description: Missing document ID
 *       500:
 *         description: Server error
 */

// ─── OCR Queue Routes ─────────────────────────────────────────────────────

// Page: OCR Queue UI
router.get('/ocr', protectApiRoute, async (req, res) => {
  try {
    return res.render('ocr', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      ocrEnabled: configFile.mistralOcr?.enabled === 'yes'
    });
  } catch (error) {
    console.error('[ERROR] OCR page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /ocr:
 *   get:
 *     summary: OCR queue page
 *     tags:
 *       - Navigation
 *       - OCR
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// Page: Permanently Failed UI
router.get('/failed', protectApiRoute, async (req, res) => {
  try {
    return res.render('failed', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
    });
  } catch (error) {
    console.error('[ERROR] Failed page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /failed:
 *   get:
 *     summary: Permanently failed queue page
 *     tags:
 *       - Navigation
 *       - OCR
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed queue page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// Page: About / Support Information
router.get('/about', protectApiRoute, async (req, res) => {
  try {
    const formatUptime = (totalSeconds) => {
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      parts.push(`${seconds}s`);
      return parts.join(' ');
    };

    const supportInfo = {
      appVersion: configFile.PAPERLESS_AI_VERSION || 'unknown',
      commitSha: process.env.PAPERLESS_AI_COMMIT_SHA || 'unknown',
      paperlessNgxVersion: process.env.PAPERLESS_NGX_VERSION || 'unknown',
      nodeVersion: process.version,
      platform: `${process.platform} (${process.arch})`,
      nodeEnv: process.env.NODE_ENV || 'production',
      aiProvider: configFile.aiProvider || process.env.AI_PROVIDER || 'openai',
      ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
      serverTimeUtc: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      uptime: formatUptime(Math.floor(process.uptime())),
      paperlessApiUrl: configFile.paperless?.apiUrl || 'unknown',
      ollamaApiUrl: configFile.ollama?.apiUrl || 'unknown',
      ollamaModel: configFile.ollama?.model || 'unknown',
      customBaseUrl: configFile.custom?.apiUrl || 'unknown',
      customModel: configFile.custom?.model || 'unknown',
      azureEndpoint: configFile.azure?.endpoint || 'unknown',
      azureDeploymentName: configFile.azure?.deploymentName || 'unknown',
      azureApiVersion: configFile.azure?.apiVersion || 'unknown',
      ocrProvider: configFile.mistralOcr?.provider || 'mistral',
      mistralOcrModel: configFile.mistralOcr?.model || 'unknown',
      scanInterval: configFile.scanInterval || 'unknown',
      tokenLimit: String(configFile.tokenLimit || 'unknown'),
      responseTokens: String(configFile.responseTokens || 'unknown'),
      trustProxy: String(configFile.trustProxy),
      useExistingData: configFile.useExistingData || 'no',
      restrictToExistingTags: configFile.restrictToExistingTags || 'no',
      restrictToExistingCorrespondents: configFile.restrictToExistingCorrespondents || 'no',
      restrictToExistingDocumentTypes: configFile.restrictToExistingDocumentTypes || 'no',
      paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
      openAiKeySet: Boolean(configFile.openai?.apiKey),
      customKeySet: Boolean(configFile.custom?.apiKey),
      azureKeySet: Boolean(configFile.azure?.apiKey),
      mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
      apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey())
    };

    return res.render('about', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      supportInfo
    });
  } catch (error) {
    console.error('[ERROR] About page:', error);
    return res.status(500).render('about', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      supportInfo: {
        appVersion: configFile.PAPERLESS_AI_VERSION || 'unknown',
        commitSha: process.env.PAPERLESS_AI_COMMIT_SHA || 'unknown',
        paperlessNgxVersion: process.env.PAPERLESS_NGX_VERSION || 'unknown',
        nodeVersion: process.version,
        platform: `${process.platform} (${process.arch})`,
        nodeEnv: process.env.NODE_ENV || 'production',
        aiProvider: configFile.aiProvider || process.env.AI_PROVIDER || 'openai',
        ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
        serverTimeUtc: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        uptime: 'unavailable',
        paperlessApiUrl: configFile.paperless?.apiUrl || 'unknown',
        ollamaApiUrl: configFile.ollama?.apiUrl || 'unknown',
        ollamaModel: configFile.ollama?.model || 'unknown',
        customBaseUrl: configFile.custom?.apiUrl || 'unknown',
        customModel: configFile.custom?.model || 'unknown',
        azureEndpoint: configFile.azure?.endpoint || 'unknown',
        azureDeploymentName: configFile.azure?.deploymentName || 'unknown',
        azureApiVersion: configFile.azure?.apiVersion || 'unknown',
        ocrProvider: configFile.mistralOcr?.provider || 'mistral',
        mistralOcrModel: configFile.mistralOcr?.model || 'unknown',
        scanInterval: configFile.scanInterval || 'unknown',
        tokenLimit: String(configFile.tokenLimit || 'unknown'),
        responseTokens: String(configFile.responseTokens || 'unknown'),
        trustProxy: String(configFile.trustProxy),
        useExistingData: configFile.useExistingData || 'no',
        restrictToExistingTags: configFile.restrictToExistingTags || 'no',
        restrictToExistingCorrespondents: configFile.restrictToExistingCorrespondents || 'no',
        restrictToExistingDocumentTypes: configFile.restrictToExistingDocumentTypes || 'no',
        paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
        openAiKeySet: Boolean(configFile.openai?.apiKey),
        customKeySet: Boolean(configFile.custom?.apiKey),
        azureKeySet: Boolean(configFile.azure?.apiKey),
        mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
        apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey())
      }
    });
  }
});

/**
 * @swagger
 * /about:
 *   get:
 *     summary: About and support information page
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: About page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       500:
 *         description: Server error
 */

// API: Get paginated queue
router.get('/api/ocr/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';
    const statusFilter = req.query.status || '';

    const { docs, total } = await documentModel.getOcrQueuePaginated({
      search,
      statusFilter,
      limit: length,
      offset: start
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl
    });
  } catch (error) {
    console.error('[ERROR] GET /api/ocr/queue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue:
 *   get:
 *     summary: Get paginated OCR queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR queue returned successfully
 *       500:
 *         description: Server error
 */

// API: Add a document manually to OCR queue
router.post('/api/ocr/queue/add', isAuthenticated, async (req, res) => {
  try {
    const { documentId } = req.body;
    if (documentId === undefined || documentId === null || documentId === '') {
      return res.status(400).json({ success: false, error: 'documentId is required' });
    }

    const normalizedDocumentId = String(documentId).trim();
    if (!/^\d+$/.test(normalizedDocumentId)) {
      return res.status(400).json({ success: false, error: 'documentId must be a positive integer' });
    }

    const docIdNum = Number(normalizedDocumentId);
    if (!Number.isInteger(docIdNum) || docIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'documentId must be a positive integer' });
    }

    let doc;
    try {
      doc = await paperlessService.getDocument(docIdNum);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ success: false, error: `Document ${docIdNum} was not found in Paperless-ngx` });
      }
      throw error;
    }

    if (!doc || !Number.isInteger(Number(doc.id))) {
      return res.status(404).json({ success: false, error: `Document ${docIdNum} was not found in Paperless-ngx` });
    }

    const title = (typeof doc.title === 'string' && doc.title.trim())
      ? doc.title.trim()
      : `Document ${docIdNum}`;

    const added = await documentModel.addToOcrQueue(docIdNum, title, 'manual');
    if (!added) {
      return res.json({ success: false, message: 'Document already in queue or could not be added' });
    }
    return res.json({ success: true, message: `Document ${docIdNum} added to OCR queue` });
  } catch (error) {
    console.error('[ERROR] POST /api/ocr/queue/add:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue/add:
 *   post:
 *     summary: Add document to OCR queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - documentId
 *             properties:
 *               documentId:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       200:
 *         description: Add operation result
 *       400:
 *         description: Invalid payload
 *       404:
 *         description: Document not found in Paperless-ngx
 *       500:
 *         description: Server error
 */

// API: Remove a document from OCR queue
router.delete('/api/ocr/queue/:documentId', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }
    const removed = await documentModel.removeFromOcrQueue(documentId);
    return res.json({ success: removed, message: removed ? 'Removed from queue' : 'Not found in queue' });
  } catch (error) {
    console.error('[ERROR] DELETE /api/ocr/queue/:documentId:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue/{documentId}:
 *   delete:
 *     summary: Remove document from OCR queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Remove operation result
 *       400:
 *         description: Invalid document ID
 *       500:
 *         description: Server error
 */

// API: Process a single document with OCR fallback (SSE)
router.post('/api/ocr/process/:documentId', isAuthenticated, async (req, res) => {
  const documentId = parseInt(req.params.documentId, 10);
  if (isNaN(documentId)) {
    return res.status(400).json({ success: false, error: 'Invalid document ID' });
  }

  const autoAnalyze = req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    if (!mistralOcrService.isEnabled()) {
      send({ step: 'error', message: 'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.' });
      return res.end();
    }

    await mistralOcrService.processQueueItem(documentId, {
      autoAnalyze,
      progressCallback: (step, message, data) => {
        send({ step, message, ...data });
      }
    });

  } catch (error) {
    send({ step: 'error', message: error.message });
  }

  res.end();
});

/**
 * @swagger
 * /api/ocr/process/{documentId}:
 *   post:
 *     summary: Process one OCR queue item
 *     description: Starts OCR processing for one document and streams progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid document ID
 */

// API: Process all pending items in OCR queue (SSE)
router.post('/api/ocr/process-all', isAuthenticated, async (req, res) => {
  const autoAnalyze = req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    if (!mistralOcrService.isEnabled()) {
      send({ step: 'error', message: 'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.' });
      return res.end();
    }

    const pendingItems = await documentModel.getOcrQueue('pending');
    const total = pendingItems.length;

    if (total === 0) {
      send({ step: 'done', message: 'No pending items in OCR queue.' });
      return res.end();
    }

    send({ step: 'start', message: `Processing ${total} document(s)…`, total });

    let completed = 0;
    let failed = 0;

    for (const item of pendingItems) {
      send({ step: 'progress', message: `Processing document ${item.document_id} (${item.title})…`, documentId: item.document_id, completed, total });

      try {
        await mistralOcrService.processQueueItem(item.document_id, {
          autoAnalyze,
          progressCallback: (step, message, data) => {
            send({ step: `item_${step}`, message, documentId: item.document_id, ...data });
          }
        });
        completed++;
      } catch (err) {
        failed++;
        send({ step: 'item_error', message: `Document ${item.document_id} failed: ${err.message}`, documentId: item.document_id });
      }
    }

    send({ step: 'done', message: `Batch complete. ${completed} succeeded, ${failed} failed.`, completed, failed, total });

  } catch (error) {
    send({ step: 'error', message: error.message });
  }

  res.end();
});

/**
 * @swagger
 * /api/ocr/process-all:
 *   post:
 *     summary: Process all pending OCR queue items
 *     description: Starts batch OCR processing and streams progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */

// API: Trigger AI-only analysis from existing OCR text (SSE)
router.post('/api/ocr/analyze/:documentId', isAuthenticated, async (req, res) => {
  const documentId = parseInt(req.params.documentId, 10);
  if (isNaN(documentId)) {
    return res.status(400).json({ success: false, error: 'Invalid document ID' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    const queueItem = await documentModel.getOcrQueueItem(documentId);
    if (!queueItem) {
      send({ step: 'error', message: 'Document not found in OCR queue.' });
      return res.end();
    }
    if (!queueItem.ocr_text || !String(queueItem.ocr_text).trim()) {
      send({ step: 'error', message: 'No OCR text available yet. Run OCR first.' });
      return res.end();
    }

    await mistralOcrService.analyzeFromExistingOcrText(documentId, queueItem.ocr_text, (step, message, data) => {
      send({ step, message, ...data });
    });
  } catch (error) {
    send({ step: 'error', message: error.message });
  }

  res.end();
});

/**
 * @swagger
 * /api/ocr/analyze/{documentId}:
 *   post:
 *     summary: Analyze existing OCR text with AI
 *     description: Uses existing OCR text and streams analysis progress via SSE.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SSE stream started
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid document ID
 */

// API: Get OCR text for a queue item
router.get('/api/ocr/queue/:documentId/text', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }

    const queueItem = await documentModel.getOcrQueueItem(documentId);
    if (!queueItem) {
      return res.status(404).json({ success: false, error: 'Document not found in OCR queue' });
    }

    return res.json({
      success: true,
      documentId,
      title: queueItem.title || null,
      status: queueItem.status,
      reason: queueItem.reason,
      hasOcrText: !!(queueItem.ocr_text && String(queueItem.ocr_text).trim()),
      ocrText: queueItem.ocr_text || ''
    });
  } catch (error) {
    console.error('[ERROR] GET /api/ocr/queue/:documentId/text:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/queue/{documentId}/text:
 *   get:
 *     summary: Get OCR text for one queue item
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: OCR text payload returned
 *       400:
 *         description: Invalid document ID
 *       404:
 *         description: Queue item not found
 *       500:
 *         description: Server error
 */

// API: Get OCR queue statistics
router.get('/api/ocr/stats', isAuthenticated, async (req, res) => {
  try {
    const allItems = await documentModel.getOcrQueue();
    const failedDocs = await documentModel.getFailedDocumentsPaginated({ limit: 1, offset: 0 });
    const stats = {
      pending: allItems.filter(i => i.status === 'pending').length,
      processing: allItems.filter(i => i.status === 'processing').length,
      done: allItems.filter(i => i.status === 'done').length,
      failed: allItems.filter(i => i.status === 'failed').length,
      permanentlyFailed: failedDocs.total || 0,
      total: allItems.length,
      ocrEnabled: mistralOcrService.isEnabled()
    };
    return res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ocr/stats:
 *   get:
 *     summary: Get OCR queue statistics
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: OCR statistics returned successfully
 *       500:
 *         description: Server error
 */

// API: Get paginated permanently failed documents queue
router.get('/api/failed/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';

    const { docs, total } = await documentModel.getFailedDocumentsPaginated({
      search,
      limit: length,
      offset: start
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl
    });
  } catch (error) {
    console.error('[ERROR] GET /api/failed/queue:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/failed/queue:
 *   get:
 *     summary: Get permanently failed document queue
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed queue returned successfully
 *       500:
 *         description: Server error
 */

// API: Reset terminal failure state for a document
router.post('/api/failed/reset/:documentId', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID' });
    }

    const reset = await documentModel.resetFailedDocument(documentId);
    await documentModel.clearProcessingStatusByDocumentId(documentId);

    return res.json({
      success: reset,
      message: reset
        ? `Document ${documentId} reset. It can be scanned again.`
        : `Document ${documentId} was not in failed queue.`
    });
  } catch (error) {
    console.error('[ERROR] POST /api/failed/reset/:documentId:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Reset terminal failure state for all documents in failed queue
router.post('/api/failed/reset-all', isAuthenticated, async (req, res) => {
  try {
    const count = await documentModel.resetAllFailedDocuments();

    return res.json({
      success: true,
      count,
      message: count > 0
        ? `${count} failed document${count === 1 ? '' : 's'} reset. They can be scanned again.`
        : 'No failed documents to reset.'
    });
  } catch (error) {
    console.error('[ERROR] POST /api/failed/reset-all:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/failed/reset/{documentId}:
 *   post:
 *     summary: Reset permanently failed document
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Reset operation result
 *       400:
 *         description: Invalid document ID
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/failed/reset-all:
 *   post:
 *     summary: Reset all permanently failed documents
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Reset operation result
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/changelog/status:
 *   get:
 *     summary: Check whether the What's New modal should be shown
 *     description: Returns show=true when the authenticated user has not yet seen the current release changelog.
 *     tags:
 *       - Changelog
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Changelog status
 *       401:
 *         description: Not authenticated
 */
router.get('/api/changelog/status', isAuthenticated, async (req, res) => {
  try {
    if (req.user && req.user.apiKey) {
      return res.json({ show: false });
    }

    const changelog = require('../config/changelog');
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ show: false });
    }

    const lastSeen = await documentModel.getLastSeenChangelogVersion(username);
    const show = lastSeen !== changelog.version;

    return res.json({
      show,
      version: changelog.version,
      entries: show ? changelog.entries : [],
    });
  } catch (error) {
    console.error('[ERROR] GET /api/changelog/status:', error);
    return res.status(500).json({ show: false, error: 'Failed to load changelog status' });
  }
});

/**
 * @swagger
 * /api/changelog/mark-seen:
 *   post:
 *     summary: Mark the current changelog as seen for the authenticated user
 *     tags:
 *       - Changelog
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Marked as seen
 *       401:
 *         description: Not authenticated
 */
router.post('/api/changelog/mark-seen', isAuthenticated, async (req, res) => {
  try {
    if (req.user && req.user.apiKey) {
      return res.json({ success: true });
    }

    const changelog = require('../config/changelog');
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ success: true });
    }

    await documentModel.setLastSeenChangelogVersion(username, changelog.version);
    return res.json({ success: true });
  } catch (error) {
    console.error('[ERROR] POST /api/changelog/mark-seen:', error);
    return res.status(500).json({ success: false, error: 'Failed to mark changelog as seen' });
  }
});

module.exports = router;
