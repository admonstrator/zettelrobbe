const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const openaiService = require('../services/openaiService.js');
const ollamaService = require('../services/ollamaService.js');
const azureService = require('../services/azureService.js');
const documentModel = require('../models/document.js');
const AIServiceFactory = require('../services/aiServiceFactory');
const configFile = require('../config/config.js');
const changelog = require('../config/changelog.js');
const dashboardWidgets = require('../config/dashboardWidgets.js');
const documentsService = require('../services/documentsService.js');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  validateApiUrl,
  validateCustomFieldValue,
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
  stripTrailingSlashes,
  toNameList,
} = require('../services/serviceUtils');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const {
  isAuthenticated,
  verifySessionToken,
  SESSION_TOKEN_TYPE,
} = require('./auth.js');
const customService = require('../services/customService.js');
const mistralOcrService = require('../services/mistralOcrService');
const quickstartService = require('../services/quickstartService');
const reconciliationService = require('../services/reconciliationService');
const scanHealthService = require('../services/scanHealthService');
const updateCheckService = require('../services/updateCheckService');
const dashboardStatsService = require('../services/dashboardStatsService');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const {
  sanitizeConfigForBootstrap,
} = require('../services/bootstrapConfigSanitizer');
const config = require('../config/config.js');
require('dotenv').config({ path: '../data/.env' });

function getCookieSecureMode() {
  return typeof config.getCookieSecureMode === 'function'
    ? config.getCookieSecureMode()
    : String(process.env.COOKIE_SECURE_MODE || 'auto')
        .trim()
        .toLowerCase();
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
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
  'AZURE_API_KEY',
  'OCR_API_KEY',
  'MISTRAL_API_KEY',
  'API_KEY',
];

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes === 0) {
    return '0 B';
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
    units.length - 1
  );
  const value = safeBytes / 1024 ** unitIndex;
  const decimals = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

async function getThumbnailCacheStats() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, {
      withFileTypes: true,
    });
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
        console.warn(
          `[WARN] Failed to read thumbnail cache file stats for ${filePath}:`,
          statError.message
        );
      }
    }

    return {
      fileCount,
      totalBytes,
      totalSizeHuman: formatBytes(totalBytes),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        fileCount: 0,
        totalBytes: 0,
        totalSizeHuman: '0 B',
      };
    }
    throw error;
  }
}

async function clearThumbnailCache() {
  try {
    const entries = await fs.readdir(THUMBNAIL_CACHE_DIR, {
      withFileTypes: true,
    });
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
          console.warn(
            `[WARN] Failed to stat thumbnail file before delete ${filePath}:`,
            statError.message
          );
        }
      }

      try {
        await fs.unlink(filePath);
        removedFiles += 1;
        freedBytes += fileSize;
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          console.warn(
            `[WARN] Failed to delete thumbnail cache file ${filePath}:`,
            unlinkError.message
          );
        }
      }
    }

    return {
      removedFiles,
      freedBytes,
      freedSizeHuman: formatBytes(freedBytes),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        removedFiles: 0,
        freedBytes: 0,
        freedSizeHuman: '0 B',
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
        console.warn(
          '[WARN] Failed to delete cached thumbnail %s:',
          thumbnailPath,
          error.message
        );
      }
    }
  }

  return { removedFiles, removedIds };
}

/**
 * Rate limiter for cache clearing operations
 * Prevents abuse of cache invalidation endpoints by limiting requests to 10 per 15 minutes per IP
 *
 * @see https://github.com/admonstrator/zettelrobbe/security/code-scanning/143
 */
const cacheClearLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    error: 'Too many cache clear requests. Please try again later.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  // Skip rate limiting for API key authenticated requests (trusted clients)
  skip: (req) => {
    const apiKey = req.headers['x-api-key'];
    const currentApiKey = config.getApiKey();
    return currentApiKey && apiKey && apiKey === currentApiKey;
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return renderLoginView(res, {
      error:
        'Too many login attempts. Please wait a few minutes and try again.',
    });
  },
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

// Routes that don't require authentication
let PUBLIC_ROUTES = ['/health', '/login', '/logout', '/setup', '/api/setup'];

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
        'Set ALLOW_REMOTE_SETUP=yes to enable it, or complete setup from localhost.',
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
        'or connect from the machine running zettelrobbe.</p>' +
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
  if (PUBLIC_ROUTES.some((route) => req.path.startsWith(route))) {
    return next();
  }

  // API key authentication
  if (currentApiKey && apiKey && apiKey === currentApiKey) {
    req.user = { apiKey: true };
  } else {
    // Fallback to JWT authentication
    if (!jwtSecret) {
      return res
        .status(500)
        .send('Server misconfiguration: JWT secret missing');
    }

    if (!token) {
      return res.redirect('/login');
    }

    const decoded = verifySessionToken(token, jwtSecret);
    if (!decoded) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
    req.user = decoded;
  }

  // Setup check
  try {
    const isConfigured = await setupService.isConfigured();

    if (!isConfigured) {
      // The wizard is only for an empty instance. Once an administrator
      // exists, an incomplete configuration is an administration job, so send
      // the signed-in user to /settings instead of to the closed wizard —
      // PAPERLESS_AI_INITIAL_SETUP=yes has always done exactly that.
      const hasUsers = await hasAnyUser();

      if (hasUsers || process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes') {
        if (!req.path.startsWith('/settings')) {
          return res.redirect('/settings');
        }
      } else if (!req.path.startsWith('/setup')) {
        return res.redirect('/setup');
      }
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
    return res
      .status(500)
      .json({ message: 'Server misconfiguration: JWT secret missing' });
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const decoded = verifySessionToken(token, jwtSecret);
  if (!decoded) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};

/**
 * True when the request carries a usable session token. For public routes such
 * as /setup, which run before any guard has looked at the request and therefore
 * never see req.user.
 */
function hasValidSession(req) {
  const jwtSecret = config.getJwtSecret();
  const token = req.cookies?.jwt || req.headers.authorization?.split(' ')[1];

  return Boolean(jwtSecret && token && verifySessionToken(token, jwtSecret));
}

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

  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function generateBase32Secret(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  let output = '';

  for (let i = 0; i < length; i += 1) {
    // The alphabet holds exactly 32 characters, so masking the low 5 bits maps
    // each random byte onto it uniformly instead of relying on a biased modulo.
    output += alphabet[bytes[i] & 0x1f];
  }

  return output;
}

function buildOtpAuthUri(secret, username) {
  const issuer = 'Zettelrobbe';
  const accountLabel = `${issuer}:${username}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
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
    const expected = generateTotpToken(
      secret,
      now + offset * TOTP_STEP_SECONDS
    );
    if (!expected || expected.length !== normalizedInput.length) {
      continue;
    }

    if (
      crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(normalizedInput)
      )
    ) {
      return true;
    }
  }

  return false;
}

function renderLoginView(res, options = {}) {
  return res.render('login', {
    error: options.error || null,
    mfaRequired: Boolean(options.mfaRequired),
    username: options.username || '',
  });
}

function isMfaEnabledForUser(user) {
  return Boolean(user && (user.mfa_enabled || user.mfaEnabled));
}

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

      if (!verifyTotpToken(mfaSecret, mfaToken)) {
        return renderLoginView(res, {
          error: 'Invalid authentication code. Please try again.',
          mfaRequired: true,
          username: challengePayload.username,
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          typ: SESSION_TOKEN_TYPE,
        },
        jwtSecret,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
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

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          typ: SESSION_TOKEN_TYPE,
        },
        jwtSecret,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: shouldUseSecureCookies(req),
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
      });

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
    await paperlessService.getCorrespondentsFromDocument(document.id);
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
 *     deprecated: true
 *     summary: AI playground testing environment (deprecated)
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
 *
 *       Deprecated: the page has been removed from the navigation and will be
 *       removed entirely in a future release. Use /manual to try a prompt
 *       against a single document.
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
    const { documents, tagNames, correspondentNames } =
      await documentsService.getDocumentsWithMetadata();

    res.json({
      success: true,
      documents,
      tagNames,
      correspondentNames,
    });
  } catch (error) {
    console.error('[ERROR] loading playground bootstrap data:', error);
    res.status(500).json({
      success: false,
      error: 'Error loading playground data',
    });
  }
});

// Compatibility endpoint for omnibox document search used by Manual/OCR views.
/**
 * @swagger
 * /api/chat/documents:
 *   get:
 *     summary: Search documents for omnibox selectors
 *     description: Searches Paperless-ngx documents for Manual/OCR document selectors.
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
 *         description: Search query. For mode=id this must be a positive integer document ID.
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [all, title, tags, correspondent, id]
 *           default: all
 *         description: Search mode (id uses exact Paperless document ID lookup).
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
 *                           tags:
 *                             type: array
 *                             description: Resolved tag names for the document.
 *                             items:
 *                               type: string
 *       500:
 *         description: Server error
 */
router.get('/api/chat/documents', isAuthenticated, async (req, res) => {
  try {
    // Keep original casing for Paperless-ngx search; server-side search via query.
    const query = String(req.query?.q || '').trim();
    const requestedLimit = Number.parseInt(
      String(req.query?.limit || '100'),
      10
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;
    const validModes = ['all', 'title', 'tags', 'correspondent', 'id'];
    const mode = validModes.includes(req.query?.mode) ? req.query.mode : 'all';

    const { documents, tagNames, correspondentNames } =
      await documentsService.getDocumentsWithMetadata(limit, query, mode);

    const normalizedDocuments = (Array.isArray(documents) ? documents : []).map(
      (doc) => {
        // Number(null) is 0, so an id check without the lower bound would treat
        // documents without a correspondent as a valid lookup.
        const correspondentId = Number(doc?.correspondent);
        const correspondentName =
          Number.isInteger(correspondentId) && correspondentId > 0
            ? correspondentNames?.[correspondentId] || ''
            : '';

        const resolvedTags = (Array.isArray(doc?.tags) ? doc.tags : [])
          .map((id) => tagNames?.[id])
          .filter(Boolean);

        return {
          id: doc?.id,
          title: doc?.title || '',
          created: doc?.created || doc?.created_date || doc?.added || null,
          correspondent: correspondentName,
          tags: resolvedTags,
        };
      }
    );

    return res.json({
      success: true,
      data: {
        documents: normalizedDocuments.slice(0, limit),
      },
    });
  } catch (error) {
    console.error('[ERROR] GET /api/chat/documents:', error);
    return res.status(500).json({
      success: false,
      error: 'Error loading chat documents',
    });
  }
});

/**
 * @swagger
 * /api/playground/bootstrap:
 *   get:
 *     deprecated: true
 *     summary: Get playground bootstrap data (deprecated)
 *     description: Returns documents and metadata required to initialize the AI playground UI. Removed from the navigation and scheduled for removal.
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
        console.warn(
          `[WARN] Failed to access thumbnail cache file ${cachePath}:`,
          cacheError.message
        );
      }

      console.log('Thumbnail not cached, fetching from Paperless');

      const thumbnailData = await paperlessService.getThumbnailImage(
        req.params.documentId
      );

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
 *       This page displays a list of all documents that have been processed by Zettelrobbe,
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
        allTags: [], // Will be loaded by JavaScript via /api/history/load-progress
        allCorrespondents: [], // Will be populated when DataTable loads
      },
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
 *       Returns a paginated list of documents that have been processed by Zettelrobbe.
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
      message: forceReload
        ? 'Force reloading filters...'
        : 'Connecting to database...',
    });

    // Small delay to ensure first message is received
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Step 2: Load filter data only (not all documents)
    sendProgress({
      type: 'progress',
      percentage: 10,
      step: 1,
      totalSteps: 2,
      message: forceReload
        ? 'Force loading tags from Paperless...'
        : 'Loading tags from Paperless...',
    });

    // Load tags from centralized cache
    const allTags = await paperlessService.getTags();

    sendProgress({
      type: 'progress',
      percentage: 50,
      step: 1,
      totalSteps: 2,
      message: `Loaded ${allTags.length} tags`,
      details: { tags: allTags.length },
    });

    // Step 3: Load correspondents from DB (fast query)
    sendProgress({
      type: 'progress',
      percentage: 70,
      step: 2,
      totalSteps: 2,
      message: 'Loading correspondents...',
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
        correspondents: allCorrespondents,
      },
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
      offset: start,
    });

    // Get total counts
    const totalCount = await documentModel.getHistoryDocumentsCount();
    const filteredCount = await documentModel.getHistoryCountFiltered({
      search,
      tagFilter,
      correspondentFilter,
    });

    // Get tags from centralized cache
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map((tag) => [tag.id, tag]));
    // Format documents with tag resolution
    const formattedDocs = docs.map((doc) => {
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds
        .map((id) => tagMap.get(parseInt(id)))
        .filter(Boolean);
      resolvedTags.sort((a, b) => a.name.localeCompare(b.name));

      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags,
        correspondent: doc.correspondent || 'Not assigned',
        link: `/dashboard/doc/${doc.document_id}`,
      };
    });

    res.json({
      draw: draw,
      recordsTotal: totalCount,
      recordsFiltered: filteredCount,
      data: formattedDocs,
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
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Zettelrobbe.
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
router.post(
  '/api/history/clear-cache',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      // Clear centralized tag cache
      paperlessService.clearTagCache();
      res.json({ success: true, message: 'Cache cleared successfully' });
    } catch (error) {
      console.error('[ERROR] clearing cache:', error);
      res.status(500).json({ error: 'Error clearing cache' });
    }
  }
);

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
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const [history, metrics, allTags] = await Promise.all([
      documentModel.getHistoryByDocumentId(documentId),
      documentModel.getMetricsByDocumentId(documentId),
      paperlessService.getTags(),
    ]);

    if (!history) {
      return res.status(404).json({
        success: false,
        error: 'No history entry found for this document',
      });
    }

    const tagMap = new Map(allTags.map((tag) => [tag.id, tag]));
    const historyTagIds = JSON.parse(history.tags || '[]').map((id) =>
      parseInt(id)
    );

    // Try to fetch live document for tag diff
    let liveTagIds = null;
    try {
      const liveDoc = await paperlessService.getDocument(documentId);
      liveTagIds = (liveDoc.tags || []).map((id) => parseInt(id));
    } catch (e) {
      console.warn(
        `[WARN] Could not fetch live document ${documentId} for diff:`,
        e.message
      );
    }

    // Build AI-set tag list with live diff status
    const aiTags = historyTagIds.map((id) => {
      const tag = tagMap.get(id);
      if (!tag)
        return { id, name: `Tag #${id}`, color: '#999999', status: 'unknown' };
      const status =
        liveTagIds === null
          ? 'unknown'
          : liveTagIds.includes(id)
            ? 'active'
            : 'removed';
      return { id: tag.id, name: tag.name, color: tag.color, status };
    });

    // Tags in Paperless that were NOT set by AI (added externally)
    const externalTags = liveTagIds
      ? liveTagIds
          .filter((id) => !historyTagIds.includes(id))
          .map((id) => {
            const tag = tagMap.get(id);
            return tag
              ? {
                  id: tag.id,
                  name: tag.name,
                  color: tag.color,
                  status: 'added_externally',
                }
              : null;
          })
          .filter(Boolean)
      : [];

    // Parse custom_fields safely
    let customFields = [];
    try {
      customFields = JSON.parse(history.custom_fields || '[]');
    } catch {
      customFields = [];
    }

    // Load original data for Restore feature
    const originalRow = await documentModel.getOriginalData(documentId);
    let originalData = null;
    if (originalRow) {
      originalData = {
        title: originalRow.title,
        correspondent: originalRow.correspondent,
        tags: JSON.parse(originalRow.tags || '[]'),
        documentType: originalRow.document_type ?? null,
        language: originalRow.language ?? null,
      };
    }

    res.json({
      success: true,
      document_id: documentId,
      history: {
        title: history.title,
        correspondent: history.correspondent,
        custom_fields: customFields,
        document_type_name: history.document_type_name ?? null,
        language: history.language ?? null,
        created_at: history.created_at,
      },
      tags: {
        aiSet: aiTags,
        external: externalTags,
        liveAvailable: liveTagIds !== null,
      },
      metrics: metrics
        ? {
            promptTokens: metrics.promptTokens,
            completionTokens: metrics.completionTokens,
            totalTokens: metrics.totalTokens,
          }
        : null,
      original: originalData,
      link: `/dashboard/doc/${documentId}`,
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
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const originalRow = await documentModel.getOriginalData(documentId);
    if (!originalRow) {
      return res.status(404).json({
        success: false,
        error: 'No original data found for this document',
      });
    }

    // Parse and sanitise — SQLite stores IDs as TEXT which can come back
    // as float-strings (e.g. '593.0') if they were originally stored as
    // a JS number that went through JSON serialisation. Paperless-ngx
    // requires proper integers; parseInt handles both '593', '593.0' and 593.
    const rawCorrespondent = originalRow.correspondent;
    const rawDocType = originalRow.document_type;

    const original = {
      tags: JSON.parse(originalRow.tags || '[]')
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id)),
      title: originalRow.title,
      correspondent:
        rawCorrespondent != null
          ? parseInt(rawCorrespondent, 10) || null
          : null,
      documentType:
        rawDocType != null ? parseInt(rawDocType, 10) || null : null,
      language: originalRow.language ?? null,
    };

    const result = await paperlessService.restoreDocument(documentId, original);
    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to restore document in Paperless-ngx',
      });
    }

    res.json({
      success: true,
      message: 'Document restored to its original state.',
    });
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
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    await rescanDocumentsByIds([documentId]);

    res.json({
      success: true,
      message: 'Document queued for reprocessing.',
    });
  } catch (error) {
    console.error('[ERROR] /api/history/:id/rescan:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/history/rescan:
 *   post:
 *     summary: Rescan (reprocess) multiple documents by ID
 *     description: |
 *       Forces reprocessing of the given documents regardless of the configured
 *       scan tag filters. The local processing record is cleared and each document
 *       is enqueued for direct AI processing, bypassing PROCESS_PREDEFINED_DOCUMENTS
 *       / TAGS scan-scope rules. Processing runs in the background.
 *     tags:
 *       - History
 *     security:
 *       - cookieAuth: []
 *       - apiKey: []
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
 *                 description: Document IDs to reprocess
 *                 example: [42, 43, 44]
 *     responses:
 *       200:
 *         description: Documents enqueued for reprocessing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 queued:
 *                   type: integer
 *                   example: 3
 *                 notFound:
 *                   type: array
 *                   items:
 *                     type: integer
 *                   example: []
 *       400:
 *         description: Invalid document IDs
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Server error
 */
router.post('/api/history/rescan', isAuthenticated, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document IDs' });
    }

    const { queued, notFound } = await rescanDocumentsByIds(ids);
    res.json({ success: true, queued, notFound });
  } catch (error) {
    console.error('[ERROR] /api/history/rescan:', error);
    res
      .status(500)
      .json({ success: false, error: 'Error queuing documents for rescan' });
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
router.post(
  '/api/settings/clear-tag-cache',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      paperlessService.clearTagCache();
      console.log('[INFO] Tag cache cleared manually by user');
      res.json({
        success: true,
        message:
          'Tag cache cleared successfully. Cache will refresh on next use.',
      });
    } catch (error) {
      console.error('[ERROR] clearing tag cache:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear tag cache',
      });
    }
  }
);

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
router.get(
  '/api/settings/thumbnail-cache',
  isAuthenticated,
  async (req, res) => {
    try {
      const stats = await getThumbnailCacheStats();
      return res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error('[ERROR] reading thumbnail cache stats:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to read thumbnail cache stats',
      });
    }
  }
);

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
router.post(
  '/api/settings/thumbnail-cache/clear',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      const cleanup = await clearThumbnailCache();
      const remaining = await getThumbnailCacheStats();

      return res.json({
        success: true,
        message: `Thumbnail cache cleared. Removed ${cleanup.removedFiles} files (${cleanup.freedSizeHuman}).`,
        removedFiles: cleanup.removedFiles,
        freedBytes: cleanup.freedBytes,
        freedSizeHuman: cleanup.freedSizeHuman,
        remaining,
      });
    } catch (error) {
      console.error('[ERROR] clearing thumbnail cache:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to clear thumbnail cache',
      });
    }
  }
);

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

router.post(
  '/api/settings/reset-local-overrides',
  isAuthenticated,
  cacheClearLimiter,
  express.json(),
  async (req, res) => {
    try {
      const username = getAuthenticatedSettingsUsername(req);
      if (!username) {
        return res.status(403).json({
          success: false,
          error: 'Reset local overrides requires a signed-in user session.',
        });
      }

      const currentPassword = String(req.body?.currentPassword || '').trim();
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password is required.',
        });
      }

      const user = await documentModel.getUser(username);
      if (!user || !user.password) {
        return res.status(404).json({
          success: false,
          error: 'User not found.',
        });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!validPassword) {
        return res.status(401).json({
          success: false,
          error: 'Current password is invalid.',
        });
      }

      const hadOverrides = await setupService.clearRuntimeOverrides();

      res.json({
        success: true,
        hadOverrides,
        restart: true,
        message: hadOverrides
          ? 'Local runtime overrides have been removed. Restarting service to apply injected environment values.'
          : 'No local runtime overrides were found. Restarting service to reload injected environment values.',
      });

      setTimeout(() => {
        process.exit(0);
      }, 5000);
    } catch (error) {
      console.error('[ERROR] resetting local runtime overrides:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reset local runtime overrides',
      });
    }
  }
);

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
router.post(
  '/api/settings/reconcile-history',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      res.write(
        `data: ${JSON.stringify({ type: 'progress', message: 'Starting reconciliation...' })}\n\n`
      );
      if (res.flush) res.flush();

      const result = await reconciliationService.reconcileAllDocuments();

      if (result && result.skipped) {
        res.write(
          `data: ${JSON.stringify({ type: 'complete', skipped: true, removed: 0, durationMs: result.durationMs || 0, message: 'Reconciliation skipped: a scan or reconciliation is already in progress.' })}\n\n`
        );
      } else {
        const removed = result ? result.removed : 0;
        const durationMs = result ? result.durationMs : 0;
        res.write(
          `data: ${JSON.stringify({ type: 'complete', skipped: false, removed, durationMs, message: removed > 0 ? `Removed ${removed} stale entries.` : 'No stale entries found.' })}\n\n`
        );
      }

      if (res.flush) res.flush();
      res.end();
    } catch (error) {
      console.error('[ERROR] manual reconciliation:', error);
      try {
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: 'Reconciliation failed. Check server logs.' })}\n\n`
        );
        if (res.flush) res.flush();
        res.end();
      } catch {
        /* client disconnected */
      }
    }
  }
);

router.post(
  '/api/reset-all-documents',
  isAuthenticated,
  cacheClearLimiter,
  async (req, res) => {
    try {
      await documentModel.deleteAllDocuments();
      res.json({ success: true });
    } catch (error) {
      console.error('[ERROR] resetting documents:', error);
      res.status(500).json({ error: 'Error resetting documents' });
    }
  }
);

/**
 * @swagger
 * /api/reset-documents:
 *   post:
 *     summary: Reset specific documents
 *     description: |
 *       Deletes processing records for specific documents, allowing them to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Zettelrobbe.
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
router.post(
  '/api/reset-documents',
  cacheClearLimiter,
  isAuthenticated,
  async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({ error: 'Invalid document IDs' });
      }

      await documentModel.deleteDocumentsIdList(ids);
      await removeThumbnailCacheForDocumentIds(ids);
      res.json({ success: true });
    } catch (error) {
      console.error('[ERROR] resetting documents:', error);
      res.status(500).json({ error: 'Error resetting documents' });
    }
  }
);

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
    res.write(
      `data: ${JSON.stringify({ type: 'progress', current: 0, total, missing: 0 })}\n\n`
    );

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
          } catch {
            return { success: false, doc: h };
          }
        })
      );

      // Collect missing documents from this batch
      results.forEach((result) => {
        if (result.status === 'fulfilled' && !result.value.success) {
          missing.push({
            document_id: result.value.doc.document_id,
            title: result.value.doc.title || null,
          });
        }
      });

      processed += batch.length;

      // Send progress update after each batch
      res.write(
        `data: ${JSON.stringify({
          type: 'progress',
          current: processed,
          total,
          missing: missing.length,
          percentage: Math.round((processed / total) * 100),
        })}\n\n`
      );
    }

    // Send final result
    res.write(`data: ${JSON.stringify({ type: 'complete', missing })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[ERROR] validating history:', error);
    res.write(
      `data: ${JSON.stringify({ type: 'error', error: 'Error validating history' })}\n\n`
    );
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
 *       400:
 *         description: Setup has not been completed yet
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
 *                   example: "Setup not completed"
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
        error: 'Setup not completed',
      });
    }

    // No user-ID probe here on purpose: the scan runs with the configured API
    // token and never needs the numeric user ID. The guard that used to sit
    // here failed a scan with an unlogged 500 whenever PAPERLESS_USERNAME did
    // not match a name in /api/users/ (issue #305).
    const triggerScanNow = global.__paperlessAiTriggerScanNow;
    if (typeof triggerScanNow !== 'function') {
      return res.status(503).json({
        success: false,
        error:
          'Scan control is not available yet. Please try again in a moment.',
      });
    }

    const result = await triggerScanNow('api-manual');
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/now:', error);
    return res.status(500).json({
      success: false,
      error: 'Error during document scan trigger',
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
    const scanState = global.__paperlessAiScanControl || {
      running: false,
      stopRequested: false,
    };

    if (typeof requestScanStop !== 'function') {
      return res.status(503).json({
        success: false,
        error:
          'Scan control is not available yet. Please try again in a moment.',
      });
    }

    const requested = requestScanStop();
    return res.json({
      success: true,
      running: Boolean(scanState.running),
      stopRequested: Boolean(scanState.stopRequested),
      message: requested
        ? 'Stop requested. The current document will finish before scan stops.'
        : 'No active scan to stop.',
    });
  } catch (error) {
    console.error('[ERROR] /api/scan/stop:', error);
    return res.status(500).json({
      success: false,
      error: 'Error while requesting scan stop',
    });
  }
});

async function processDocument(
  doc,
  existingTags,
  existingCorrespondentList,
  existingDocumentTypesList,
  customPrompt = null
) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) {
    console.log(
      `[DEBUG] Document ${doc.id} already in processed_documents — skipping. Remove via Rescan to reprocess.`
    );
    return null;
  }

  const isFailed = await documentModel.isDocumentFailed(doc.id);
  if (isFailed) {
    console.log(
      `[DEBUG] Document ${doc.id} is marked as permanently failed, skipping until reset`
    );
    return null;
  }

  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  const documentEditable = await paperlessService.getPermissionOfDocument(
    doc.id
  );
  if (!documentEditable) {
    console.log(
      `[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`
    );
    console.log(
      `[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`
    );
    return null;
  } else {
    console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
  }

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id),
  ]);

  const minContentLength = config.minContentLength;
  if (!content || content.length < minContentLength) {
    console.log(
      `[DEBUG] Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${minContentLength}), skipping analysis`
    );
    if (mistralOcrService.isEnabled()) {
      const added = await documentModel.addToOcrQueue(
        doc.id,
        doc.title,
        `short_content_lt_${minContentLength}`
      );
      if (added) {
        console.log(
          `[OCR] Document ${doc.id} queued for Mistral OCR (short_content)`
        );
      }
    } else {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        `insufficient_content_lt_${minContentLength}`,
        'ai'
      );
    }
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  // Prepare options for AI service
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents:
      config.restrictToExistingCorrespondents === 'yes',
  };

  // Get external API data if enabled
  if (config.externalApiConfig.enabled === 'yes') {
    try {
      const externalApiService = require('../services/externalApiService');
      const externalData = await externalApiService.fetchData();
      if (externalData) {
        options.externalApiData = externalData;
        console.log(
          '[DEBUG] Retrieved external API data for prompt enrichment'
        );
      }
    } catch (error) {
      console.error(
        '[ERROR] Failed to fetch external API data:',
        error.message
      );
    }
  }

  const aiService = AIServiceFactory.getService();
  let analysis;
  if (customPrompt) {
    console.log('[DEBUG] Starting document analysis with custom prompt');
    analysis = await aiService.analyzeDocument(
      content,
      existingTags,
      existingCorrespondentList,
      existingDocumentTypesList,
      doc.id,
      customPrompt,
      options
    );
  } else {
    analysis = await aiService.analyzeDocument(
      content,
      existingTags,
      existingCorrespondentList,
      existingDocumentTypesList,
      doc.id,
      null,
      options
    );
  }
  console.log('Repsonse from AI service:', analysis);
  if (analysis.error) {
    let queuedForOcr = false;
    if (
      mistralOcrService.isEnabled() &&
      shouldQueueForOcrOnAiError(analysis.error)
    ) {
      const queueReason = classifyOcrQueueReasonFromAiError(analysis.error);
      const added = await documentModel.addToOcrQueue(
        doc.id,
        doc.title,
        queueReason
      );
      if (added) {
        console.log(
          `[OCR] Document ${doc.id} queued for Mistral OCR (ai_failed: ${analysis.error})`
        );
      }
      queuedForOcr = true;
    }

    if (!mistralOcrService.isEnabled()) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        'ai_failed_ocr_disabled',
        'ai'
      );
    } else if (!queuedForOcr) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        'ai_failed_without_ocr_fallback',
        'ai'
      );
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
    restrictToExistingTags:
      config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents:
      config.restrictToExistingCorrespondents === 'yes' ? true : false,
    restrictToExistingDocumentTypes:
      config.restrictToExistingDocumentTypes === 'yes' ? true : false,
  };

  console.log(
    `[DEBUG] Building update data with restrictions: tags=${options.restrictToExistingTags}, correspondents=${options.restrictToExistingCorrespondents}, documentTypes=${options.restrictToExistingDocumentTypes}`
  );

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(
      analysis.document.tags,
      options
    );
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (
    config.limitFunctions?.activateTagging === 'no' &&
    config.addAIProcessedTag === 'yes'
  ) {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log(
      '[DEBUG] Tagging is deactivated but AI processed tag will be added'
    );
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(
      tags,
      options
    );
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
  if (
    config.limitFunctions?.activateDocumentType !== 'no' &&
    analysis.document.document_type
  ) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(
        analysis.document.document_type,
        options
      );
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }

  // Only process custom fields if custom fields detection is activated
  if (
    config.limitFunctions?.activateCustomFields !== 'no' &&
    analysis.document.custom_fields
  ) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];
    const customFieldsForHistory = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(
      doc.id
    );
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const customField of Object.values(customFields)) {
      if (!customField || typeof customField !== 'object') {
        console.log('[DEBUG] Skipping null/invalid custom field entry');
        continue;
      }

      if (
        !customField.field_name ||
        customField.value === null ||
        customField.value === undefined ||
        String(customField.value).trim() === ''
      ) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(
        customField.field_name
      );
      if (fieldDetails?.id) {
        const validation = validateCustomFieldValue(
          customField.field_name,
          customField.value,
          fieldDetails.data_type
        );
        if (validation.skip) {
          if (validation.warn) console.warn(validation.warn);
          continue;
        }
        processedFields.push({
          field: fieldDetails.id,
          value: validation.value,
        });
        customFieldsForHistory.push({
          field_name: customField.field_name,
          value: validation.value,
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
  if (
    config.limitFunctions?.activateCorrespondents !== 'no' &&
    analysis.document.correspondent
  ) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(
        analysis.document.correspondent,
        options
      );
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
  const {
    tags: originalTags,
    correspondent: originalCorrespondent,
    title: originalTitle,
  } = originalData;

  const historyCustomFields = updateData._customFieldsForHistory || null;
  delete updateData._customFieldsForHistory;

  const historyDocTypeName = analysis.document.document_type ?? null;
  const historyLanguage = analysis.document.language ?? null;
  const origDocType = originalData.document_type ?? null;
  const origLanguage = originalData.language ?? null;

  await Promise.all([
    documentModel.saveOriginalData(
      docId,
      originalTags,
      originalCorrespondent,
      originalTitle,
      origDocType,
      origLanguage
    ),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title),
    documentModel.addOpenAIMetrics(
      docId,
      analysis.metrics.promptTokens,
      analysis.metrics.completionTokens,
      analysis.metrics.totalTokens
    ),
    documentModel.addToHistory(
      docId,
      updateData.tags,
      updateData.title,
      analysis.document.correspondent,
      historyCustomFields,
      historyDocTypeName,
      historyLanguage
    ),
  ]);

  // Document counters and token figures just moved. Every path that writes
  // processed_documents has to say so, or the dashboard serves numbers from
  // before the change for up to a full TTL.
  dashboardStatsService.invalidate();
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
    const legacyMode =
      String(process.env.CONFIG_SOURCE_MODE || 'runtime-first')
        .trim()
        .toLowerCase() === 'legacy';
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
      API_KEY: apiKey,
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
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
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
    tokenPlaceholder: 'sk-...',
  },
  {
    id: 'lmstudio-local',
    label: 'LM Studio (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-7b-instruct',
    tokenPlaceholder: 'lm-studio-token',
  },
  {
    id: 'ollama-local',
    label: 'Ollama',
    provider: 'ollama',
    apiUrl: 'http://localhost:11434',
    model: 'llama3.2',
    tokenPlaceholder: '',
  },
  {
    id: 'ionos-openai-compatible',
    label: 'IONOS (OpenAI compatible)',
    provider: 'custom',
    apiUrl: 'https://openai.inference.de-txl.ionos.com/v1',
    model: 'meta-llama/llama-3.3-70b-instruct',
    tokenPlaceholder: 'ionos-api-key',
  },
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
  return stripTrailingSlashes(String(url || '').trim()).replace(/\/api$/, '');
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
    allowLocalhost: parseBooleanInput(
      process.env.PAPERLESS_AI_SETUP_ALLOW_LOCALHOST,
      false
    ),
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

/* The answer only ever flips once, from "no users" to "users exist": the setup
   wizard is the only thing that creates the first account, and addUser() never
   leaves the table empty. Caching the positive answer keeps the global guard,
   which asks on every single request, from hitting SQLite each time. The
   negative answer is not cached, so a fresh instance still notices the moment
   the wizard finishes. */
let cachedUsersExist = false;

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
 */
async function isInitialSetupOpen() {
  return !(await hasAnyUser());
}

async function ensureSetupOpenOrRespond(
  res,
  error = 'Initial setup is already complete.'
) {
  const setupOpen = await isInitialSetupOpen();
  if (!setupOpen) {
    res.status(403).json({
      success: false,
      error,
    });
    return false;
  }

  return true;
}

/* The running configuration as a .env file, grouped the way the settings page
   is. Separate from toEnvPreviewLines() below on purpose: that one previews the
   handful of values the setup wizard just collected, this one exports
   everything an operator needs to reproduce the instance elsewhere.

   The list is curated rather than a dump of process.env: the environment also
   holds the container's own variables, and JWT_SECRET is deliberately absent —
   a fresh instance mints its own, and putting it on screen buys nothing. */
const ENV_EXPORT_GROUPS = [
  {
    title: 'Paperless-ngx connection',
    keys: [
      'PAPERLESS_API_URL',
      'PAPERLESS_PUBLIC_URL',
      'PAPERLESS_API_TOKEN',
      'PAPERLESS_USERNAME',
      'PAPERLESS_PROBE_INTERVAL_SECONDS',
      'PAPERLESS_REQUEST_TIMEOUT_SECONDS',
      'STARTUP_PAPERLESS_RETRY_MINUTES',
    ],
  },
  {
    title: 'Document processing',
    keys: [
      'SCAN_INTERVAL',
      'DISABLE_AUTOMATIC_PROCESSING',
      'PROCESS_PREDEFINED_DOCUMENTS',
      'TAGS',
      'IGNORE_TAGS',
      'ADD_AI_PROCESSED_TAG',
      'AI_PROCESSED_TAG_NAME',
      'MIN_CONTENT_LENGTH',
      'USE_EXISTING_DATA',
    ],
  },
  {
    title: 'AI provider',
    keys: [
      'AI_PROVIDER',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
      'OLLAMA_API_URL',
      'OLLAMA_API_KEY',
      'OLLAMA_MODEL',
      'OLLAMA_THINK',
      'CUSTOM_BASE_URL',
      'CUSTOM_API_KEY',
      'CUSTOM_MODEL',
      'AZURE_ENDPOINT',
      'AZURE_API_KEY',
      'AZURE_DEPLOYMENT_NAME',
      'AZURE_API_VERSION',
    ],
  },
  {
    title: 'AI behaviour',
    keys: [
      'TOKEN_LIMIT',
      'RESPONSE_TOKENS',
      'AI_TEMPERATURE_ANALYSIS',
      'AI_TEMPERATURE_GENERATION',
      'SYSTEM_PROMPT',
      'PROMPT_TAGS',
      'ACTIVATE_TAGGING',
      'ACTIVATE_CORRESPONDENTS',
      'ACTIVATE_DOCUMENT_TYPE',
      'ACTIVATE_TITLE',
      'ACTIVATE_CUSTOM_FIELDS',
      'CUSTOM_FIELDS',
      'RESTRICT_TO_EXISTING_TAGS',
      'RESTRICT_TO_EXISTING_CORRESPONDENTS',
      'RESTRICT_TO_EXISTING_DOCUMENT_TYPES',
    ],
  },
  {
    title: 'External API',
    keys: [
      'EXTERNAL_API_ENABLED',
      'EXTERNAL_API_URL',
      'EXTERNAL_API_METHOD',
      'EXTERNAL_API_HEADERS',
      'EXTERNAL_API_BODY',
      'EXTERNAL_API_TIMEOUT',
      'EXTERNAL_API_TRANSFORM',
    ],
  },
  {
    title: 'OCR fallback',
    keys: [
      'MISTRAL_OCR_ENABLED',
      'OCR_PROVIDER',
      'OCR_API_URL',
      'OCR_API_KEY',
      'MISTRAL_API_KEY',
      'MISTRAL_OCR_MODEL',
      'OCR_PDF_RENDER_ENABLED',
      'OCR_PDF_RENDER_MAX_PAGES',
      'OCR_PDF_RENDER_DPI',
      'OCR_AUTO_PROCESS_ENABLED',
      'OCR_AUTO_PROCESS_INTERVAL',
      'OCR_AUTO_PROCESS_BATCH_SIZE',
      'OCR_AUTO_ANALYZE',
      'SETUP_OCR_VALIDATION_TIMEOUT_MS',
    ],
  },
  {
    title: 'Server and security',
    keys: [
      'PAPERLESS_AI_PORT',
      'API_KEY',
      'TRUST_PROXY',
      'COOKIE_SECURE_MODE',
      'GLOBAL_RATE_LIMIT_WINDOW_MS',
      'GLOBAL_RATE_LIMIT_MAX',
      'EXPOSE_API_DOCS',
      'CONFIG_SOURCE_MODE',
    ],
  },
  {
    title: 'Maintenance',
    keys: [
      'LOG_LEVEL',
      'TAG_CACHE_TTL_SECONDS',
      'RECONCILIATION_ENABLED',
      'RECONCILIATION_INTERVAL',
      'UPDATE_CHECK_ENABLED',
      'HEALTHCHECK_STRICT',
      'HEALTH_SCAN_FAILURE_THRESHOLD',
      'ANONYMIZED_TELEMETRY',
    ],
  },
  {
    title: 'Interface',
    keys: ['DATE_FORMAT'],
  },
];

/* A value only needs quoting when it carries something a .env parser would
   otherwise eat — whitespace, a comment marker or a quote of its own. */
function quoteEnvValue(value) {
  const text = String(value);
  if (!/[\s"'#]/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildEnvExport(env = process.env) {
  const lines = [];
  let count = 0;

  ENV_EXPORT_GROUPS.forEach((group) => {
    const present = group.keys.filter(
      (key) => env[key] !== undefined && String(env[key]).length > 0
    );
    if (present.length === 0) return;

    if (lines.length > 0) lines.push('');
    lines.push(`# ${group.title}`);
    present.forEach((key) => {
      lines.push(`${key}=${quoteEnvValue(env[key])}`);
      count += 1;
    });
  });

  return { env: lines.join('\n'), count };
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
    'OLLAMA_API_KEY',
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
    'MISTRAL_OCR_MODEL',
    'OCR_PDF_RENDER_ENABLED',
    'OCR_PDF_RENDER_MAX_PAGES',
    'OCR_PDF_RENDER_DPI',
    'OCR_AUTO_PROCESS_ENABLED',
    'OCR_AUTO_PROCESS_INTERVAL',
    'OCR_AUTO_PROCESS_BATCH_SIZE',
    'OCR_AUTO_ANALYZE',
  ];

  return previewKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(config, key))
    .map((key) => `${key}=${config[key] == null ? '' : config[key]}`)
    .join('\n');
}

async function loadAiProviderPresets() {
  const presetsPath = path.join(
    process.cwd(),
    'config',
    'ai-provider-presets.json'
  );

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
        tokenPlaceholder: String(
          item.tokenPlaceholder || item.apiKeyPlaceholder || ''
        ),
      }))
      .filter((item) =>
        ['openai', 'ollama', 'custom', 'azure'].includes(item.provider)
      );
  } catch (error) {
    console.warn(
      '[WARN] Could not load AI provider presets from config/ai-provider-presets.json:',
      error.message
    );
    return DEFAULT_AI_PROVIDER_PRESETS;
  }
}

// Settings pages leave secret inputs empty to mean "keep the configured
// value", so requests from there may carry an empty token even though the
// endpoint requires auth. Fall back to the stored key for the provider.
function resolveStoredAiToken(aiProvider) {
  const provider = String(aiProvider || '')
    .trim()
    .toLowerCase();
  if (provider === 'ollama') return process.env.OLLAMA_API_KEY || '';
  if (provider === 'custom') return process.env.CUSTOM_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'azure') return process.env.AZURE_API_KEY || '';
  return '';
}

function resolveSettingsAiToken(aiProvider, token) {
  const normalizedToken = String(token || '').trim();
  return normalizedToken || resolveStoredAiToken(aiProvider);
}

/* Accepts what the row menu sends (one id) and what the bulk menu sends (a
   list), so both reach the same endpoint. Anything that is not a positive
   whole number is dropped rather than rejected: a selection is assembled from
   checkboxes, and one stale row should not fail the other forty. */
function normalizeDocumentIdList(input) {
  const raw = Array.isArray(input) ? input : [input];
  const ids = raw
    .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  return [...new Set(ids)];
}

/* Quickstart detection on the settings page talks to the AI server that is
   already configured, so an empty key field means "use the stored one" rather
   than "no key" — the same rule the AI and OCR fields on that page follow. A
   saved key is never echoed back into the password input, so only this side
   can tell the two apart. Setup has no stored configuration to fall back on
   and therefore does not use this.

   Two conditions, both necessary. The key belongs to the configured provider,
   so it is resolved through resolveStoredAiToken() rather than by trying one
   variable after another — a stale CUSTOM_API_KEY left over from a provider
   switch must not be sent to an Ollama host. And it is only substituted when
   the request targets that provider's own server: the settings page keeps
   saved secrets out of the DOM on purpose, and an endpoint that forwards one
   to any URL the caller names would hand it back out again. Typed keys are
   always honoured, whatever the target. */
function resolveSettingsQuickstartApiKey(baseUrl, apiKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  if (normalizedApiKey) {
    return normalizedApiKey;
  }

  const provider = String(process.env.AI_PROVIDER || '')
    .trim()
    .toLowerCase();
  const configuredUrl =
    provider === 'ollama'
      ? process.env.OLLAMA_API_URL
      : provider === 'custom'
        ? process.env.CUSTOM_BASE_URL
        : '';

  return isSameQuickstartHost(baseUrl, configuredUrl)
    ? resolveStoredAiToken(provider)
    : '';
}

/* Compares the detection target with the configured AI server. The Quickstart
   field is written by hand and normalizeBaseUrls() strips /v1 and trailing
   slashes, so "http://host:1234/v1/" and "http://host:1234" are the same
   server; anything that does not parse is not. */
function isSameQuickstartHost(requestedUrl, configuredUrl) {
  const normalize = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch {
      return null;
    }
  };

  const requested = normalize(requestedUrl);
  const configured = normalize(configuredUrl);
  return Boolean(requested && configured && requested === configured);
}

/* The key may be typed into the form, saved from an earlier save, or
   injected through the environment. Only this side can see the last two, which
   is why neither page refuses an empty field on its own. */
function resolveOcrApiKey(apiKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  return (
    normalizedApiKey ||
    process.env.OCR_API_KEY ||
    process.env.MISTRAL_API_KEY ||
    ''
  );
}

async function validatePaperlessConnectionForSetup(
  paperlessUrl,
  paperlessToken
) {
  const normalizedUrl = normalizeSetupBaseUrl(paperlessUrl);
  if (!normalizedUrl || !paperlessToken) {
    return {
      success: false,
      stage: 'input',
      message: 'Paperless API URL and API token are required.',
    };
  }

  const isReachable = await setupService.validatePaperlessConfig(
    normalizedUrl,
    paperlessToken
  );
  if (!isReachable) {
    return {
      success: false,
      stage: 'reachability',
      message:
        'Paperless-ngx could not be reached with the provided URL and token.',
    };
  }

  const permissionResult = await setupService.validateApiPermissions(
    normalizedUrl,
    paperlessToken
  );
  if (!permissionResult.success) {
    return {
      success: false,
      stage: 'permissions',
      message:
        permissionResult.message ||
        'Paperless-ngx API permissions are insufficient.',
    };
  }

  return {
    success: true,
    stage: 'ok',
    message: 'Paperless-ngx connection and permissions are valid.',
  };
}

async function validateAiConnectionForSetup({
  aiProvider,
  apiUrl,
  token,
  model,
  azureApiVersion,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const provider = String(aiProvider || '')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedToken = String(token || '').trim();
      const normalizedModel = String(model || '').trim();

      if (
        !provider ||
        !['openai', 'ollama', 'custom', 'azure'].includes(provider)
      ) {
        return {
          success: false,
          message: 'A valid AI provider is required.',
        };
      }

      if (provider === 'openai') {
        if (!normalizedToken) {
          return {
            success: false,
            message: 'An API token is required for OpenAI.',
          };
        }

        const valid = await setupService.validateOpenAIConfig(normalizedToken);
        return {
          success: valid,
          message: valid
            ? 'OpenAI credentials are valid.'
            : 'OpenAI test failed. Check token and network access.',
        };
      }

      if (provider === 'ollama') {
        if (!normalizedModel) {
          return {
            success: false,
            message: 'Model is required for Ollama.',
          };
        }

        const detection = await setupService.detectAiApiUrlForSetup({
          provider,
          apiUrl: normalizedApiUrl,
          apiKey: normalizedToken,
        });
        const resolvedApiUrl = String(
          detection?.resolvedApiUrl || normalizedApiUrl || ''
        ).trim();

        const valid =
          detection?.mode === 'openai'
            ? await setupService.validateCustomConfig(
                resolvedApiUrl,
                normalizedToken,
                normalizedModel
              )
            : await setupService.validateOllamaConfig(
                resolvedApiUrl,
                normalizedModel,
                normalizedToken
              );

        return {
          success: valid,
          resolvedApiUrl,
          message: valid
            ? 'Ollama connection is valid.'
            : 'Ollama test failed. Check URL and model.',
        };
      }

      if (provider === 'azure') {
        if (!normalizedApiUrl || !normalizedToken || !normalizedModel) {
          return {
            success: false,
            message:
              'Endpoint, token, and deployment/model are required for Azure.',
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
          message: valid
            ? 'Azure connection is valid.'
            : 'Azure test failed. Check endpoint, token, deployment, and API version.',
        };
      }

      if (!normalizedApiUrl || !normalizedModel) {
        return {
          success: false,
          message: 'API URL and model are required for custom providers.',
        };
      }

      const detection = await setupService.detectAiApiUrlForSetup({
        provider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedToken,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl
      ).trim();
      const valid =
        detection?.mode === 'ollama'
          ? await setupService.validateOllamaConfig(
              resolvedApiUrl,
              normalizedModel,
              normalizedToken
            )
          : await setupService.validateCustomConfig(
              resolvedApiUrl,
              normalizedToken,
              normalizedModel
            );

      return {
        success: valid,
        resolvedApiUrl,
        message: valid
          ? 'Custom provider connection is valid.'
          : 'Custom provider test failed. Check URL, optional token, and model.',
      };
    }
  );
}

async function validateOcrConnectionForSetup({
  enabled,
  provider,
  apiUrl,
  apiKey,
  model,
  setupOcrValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupOcrValidationTimeoutMs,
    async () => {
      // Correctly handles both boolean (true/false) and string ('yes'/'no') values.
      // Using a truthy check on a string would misinterpret 'no' as enabled.
      const normalizedEnabled =
        enabled === true ||
        String(enabled ?? '')
          .trim()
          .toLowerCase() === 'yes'
          ? 'yes'
          : 'no';
      if (normalizedEnabled !== 'yes') {
        return {
          success: true,
          message: 'OCR fallback is disabled.',
        };
      }

      const normalizedProviderInput = String(provider || 'mistral')
        .trim()
        .toLowerCase();
      const normalizedProvider =
        normalizedProviderInput === 'custom'
          ? 'ollama'
          : normalizedProviderInput;
      const detection = await setupService.detectOcrApiUrlForSetup({
        provider: normalizedProvider,
        apiUrl: String(apiUrl || '').trim(),
        apiKey: String(apiKey || '').trim(),
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || apiUrl || ''
      ).trim();

      const valid = await setupService.validateOcrConfig({
        enabled: normalizedEnabled,
        provider: normalizedProvider,
        apiUrl: resolvedApiUrl,
        apiKey: String(apiKey || '').trim(),
        model: String(model || '').trim() || 'mistral-ocr-latest',
      });

      return {
        success: valid,
        resolvedApiUrl,
        message: valid
          ? 'OCR connection is valid.'
          : 'OCR connection test failed. Check OCR provider, OCR API URL, API key and model.',
      };
    }
  );
}

async function discoverAiModelsForSetup({
  aiProvider,
  apiUrl,
  token,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const provider = String(aiProvider || '')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedToken = String(token || '').trim();

      // For local providers, classify models via quickstart detection so
      // embedding-only models are excluded from the AI model dropdown.
      if (['custom', 'ollama'].includes(provider) && normalizedApiUrl) {
        try {
          const classification = await quickstartService.detectAndClassify({
            baseUrl: normalizedApiUrl,
            apiKey: normalizedToken,
          });

          if (classification.textModels.length > 0) {
            const excludedCount =
              classification.models.length - classification.textModels.length;
            return {
              success: true,
              models: classification.textModels,
              resolvedApiUrl: classification.resolvedAiApiUrl,
              message:
                excludedCount > 0
                  ? `Discovered ${classification.textModels.length} model(s) (${excludedCount} embedding-only model(s) excluded).`
                  : `Discovered ${classification.textModels.length} model(s).`,
            };
          }
        } catch {
          // Classification probe failed; fall through to the legacy unfiltered
          // discovery below so existing setups keep working.
        }
      }

      const detection = await setupService.detectAiApiUrlForSetup({
        provider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedToken,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl || ''
      ).trim();

      const models = await setupService.discoverAiModels({
        provider,
        apiUrl: resolvedApiUrl,
        apiKey: normalizedToken,
      });

      return {
        success: true,
        models,
        resolvedApiUrl,
        message:
          models.length > 0
            ? `Discovered ${models.length} model(s).`
            : 'No models discovered for this provider.',
      };
    }
  );
}

async function discoverOcrModelsForSetup({
  provider,
  apiUrl,
  apiKey,
  setupOcrValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupOcrValidationTimeoutMs,
    async () => {
      const normalizedProvider = String(provider || 'mistral')
        .trim()
        .toLowerCase();
      const normalizedApiUrl = String(apiUrl || '').trim();
      const normalizedApiKey = String(apiKey || '').trim();

      // For local providers, classify models via quickstart detection so
      // embedding-only models are excluded from the OCR dropdown
      // (metadata-first via LM Studio /api/v0/models or Ollama /api/show,
      // heuristics otherwise).
      //
      // Vision detection is a name heuristic, so it must rank the list rather
      // than cut it: it recognizes llava, pixtral or *-vl and misses every
      // OCR-capable model with an unremarkable name — gpt-4o among them. This
      // used to return the vision subset as soon as it was non-empty, which on
      // a router serving dozens of models hid nearly all of them. Vision hits
      // are reported separately so the UI can recommend them.
      if (
        ['custom', 'ollama'].includes(normalizedProvider) &&
        normalizedApiUrl
      ) {
        try {
          const classification = await quickstartService.detectAndClassify({
            baseUrl: normalizedApiUrl,
            apiKey: normalizedApiKey,
          });

          const models = classification.textModels;
          const visionModels = classification.visionModels;
          const excludedCount = classification.models.length - models.length;
          const details = [
            visionModels.length > 0
              ? `${visionModels.length} with detected vision support`
              : null,
            excludedCount > 0
              ? `${excludedCount} embedding-only model(s) excluded`
              : null,
          ].filter(Boolean);

          return {
            success: true,
            models,
            visionModels,
            suggestedModel: classification.suggestedOcrModel || null,
            resolvedApiUrl: classification.resolvedOcrApiUrl,
            message:
              models.length > 0
                ? `Discovered ${models.length} OCR model(s)${
                    details.length > 0 ? ` (${details.join(', ')})` : ''
                  }.`
                : 'No OCR models discovered for this provider.',
          };
        } catch {
          // Classification probe failed; fall through to the legacy unfiltered
          // discovery below so existing setups keep working.
        }
      }

      const detection = await setupService.detectOcrApiUrlForSetup({
        provider: normalizedProvider,
        apiUrl: normalizedApiUrl,
        apiKey: normalizedApiKey,
      });
      const resolvedApiUrl = String(
        detection?.resolvedApiUrl || normalizedApiUrl
      ).trim();

      const models = await setupService.discoverOcrModels({
        provider: normalizedProvider,
        apiUrl: resolvedApiUrl,
        apiKey: normalizedApiKey,
      });

      return {
        success: true,
        models,
        resolvedApiUrl,
        message:
          models.length > 0
            ? `Discovered ${models.length} OCR model(s).`
            : 'No OCR models discovered for this provider.',
      };
    }
  );
}

async function detectQuickstartForSetup({
  baseUrl,
  apiKey,
  setupValidationTimeoutMs,
}) {
  return setupService.withTemporaryValidationTimeout(
    setupValidationTimeoutMs,
    async () => {
      const detection = await quickstartService.detectAndClassify({
        baseUrl: String(baseUrl || '').trim(),
        apiKey: String(apiKey || '').trim(),
      });

      return {
        success: true,
        detection,
        message: quickstartService.buildDetectionSummaryMessage(detection),
      };
    }
  );
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
 *         description: Setup page rendered successfully (only while no administrator account exists)
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application setup page
 *       302:
 *         description: >
 *           Redirects away from the wizard once an administrator account
 *           exists - to /settings for a signed-in request, otherwise to /login.
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
router.get('/setup', async (req, res) => {
  try {
    // SECURITY: the wizard creates the administrator account and rewrites the
    // Paperless-ngx connection without asking for credentials, so it must never
    // be reachable once an account exists — not even with a broken
    // configuration. A signed-in operator gets the settings page, everyone else
    // gets the login form.
    if (await hasAnyUser()) {
      return res.redirect(hasValidSession(req) ? '/settings' : '/login');
    }

    // SECURITY: Check setup state first to detect degraded conditions
    const setupState = await setupService.getSetupState();

    // If system is in degraded state (config exists but database corrupted),
    // refuse to render setup page with embedded config
    if (setupState === 'degraded') {
      console.warn(
        '[SECURITY] Attempting to access /setup in degraded state (corrupted database)'
      );
      return res
        .status(500)
        .render('setup-error', {
          title: 'System Configuration Error',
          errorMessage:
            'The system configuration exists but the database is inaccessible or corrupted. This is an administrative error state. Please check system logs and database integrity.',
          supportText:
            'This may occur if: (1) the database file was deleted or corrupted, (2) file permissions changed, or (3) the database is locked. Restart the application after verifying database and permissions.',
        })
        .catch(() => {
          // Fallback if setup-error template doesn't exist
          res
            .status(500)
            .send(
              '<h1>System Configuration Error</h1><p>Database is inaccessible. Please contact your administrator.</p>'
            );
        });
    }

    // Base configuration object - load this FIRST, before any checks
    let config = {
      PAPERLESS_API_URL: (
        process.env.PAPERLESS_API_URL || 'http://localhost:8000'
      ).replace(/\/api$/, ''),
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS:
        process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      TAGS: normalizeArray(process.env.TAGS),
      IGNORE_TAGS: normalizeArray(process.env.IGNORE_TAGS),
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME:
        process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
      PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
      PROCESS_ONLY_NEW_DOCUMENTS:
        process.env.PROCESS_ONLY_NEW_DOCUMENTS || 'yes',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      DISABLE_AUTOMATIC_PROCESSING:
        process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
      MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
      OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
      OCR_API_URL: process.env.OCR_API_URL || '',
      OCR_API_KEY: process.env.OCR_API_KEY || '',
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
      MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      SETUP_VALIDATION_TIMEOUT_MS:
        process.env.SETUP_VALIDATION_TIMEOUT_MS || '30000',
      SETUP_OCR_VALIDATION_TIMEOUT_MS:
        process.env.SETUP_OCR_VALIDATION_TIMEOUT_MS ||
        process.env.SETUP_VALIDATION_TIMEOUT_MS ||
        '30000',
    };

    // Check both configuration and users
    const [isEnvConfigured, users] = await Promise.all([
      setupService.isConfigured(),
      documentModel.getUsers(),
    ]);
    const aiProviderPresets = await loadAiProviderPresets();

    // Load saved config if it exists
    if (isEnvConfigured) {
      const savedConfig = await setupService.loadConfig();
      if (savedConfig) {
        if (savedConfig.PAPERLESS_API_URL) {
          savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(
            /\/api$/,
            ''
          );
        }

        savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
        savedConfig.IGNORE_TAGS = normalizeArray(savedConfig.IGNORE_TAGS);
        savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

        config = { ...config, ...savedConfig };
      }
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
      successMessage =
        'Environment is configured, but no users exist. Please create at least one user.';
    } else if (isEnvConfigured) {
      successMessage =
        'The application is already configured. You can update the configuration below.';
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
        scanInterval: getDefaultScanInterval(),
      },
    });
  } catch (error) {
    console.error('Setup route error:', error);
    const aiProviderPresets = await loadAiProviderPresets();
    res.status(500).render('setup', {
      config: {},
      error: 'An error occurred while loading the setup page.',
      aiProviderPresets,
      defaults: {
        scanInterval: getDefaultScanInterval(),
      },
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
      presets,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/setup/presets:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load AI provider presets.',
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
        error: 'Username is required for MFA setup.',
      });
    }

    const secret = generateBase32Secret();
    const otpauthUri = buildOtpAuthUri(secret, username);
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#0f172a', light: '#ffffff' },
    });

    const challengeId = crypto.randomBytes(24).toString('hex');
    setupMfaChallenges.set(challengeId, {
      username,
      secret,
      verified: false,
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      challengeId,
      secret,
      otpauthUri,
      qrDataUrl,
      expiresInSeconds: Math.floor(SETUP_MFA_CHALLENGE_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/setup:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize MFA setup.',
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
        error: 'Challenge ID and authentication code are required.',
      });
    }

    const challenge = setupMfaChallenges.get(challengeId);
    if (!challenge) {
      return res.status(400).json({
        success: false,
        error: 'MFA setup session expired. Start setup again.',
      });
    }

    if (!verifyTotpToken(challenge.secret, token)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authentication code. Please try again.',
      });
    }

    challenge.verified = true;
    challenge.verifiedAt = Date.now();

    return res.json({
      success: true,
      message: 'MFA code validated.',
    });
  } catch (error) {
    console.error('[ERROR] POST /api/setup/mfa/confirm:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to validate MFA code.',
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
    const validation = await validatePaperlessConnectionForSetup(
      paperlessUrl,
      paperlessToken
    );

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/paperless/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test Paperless-ngx connection.',
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
router.post(
  '/api/setup/paperless/metadata',
  express.json(),
  async (req, res) => {
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
          error: 'Paperless API URL and API token are required.',
        });
      }

      const urlValidation = await validateApiUrl(
        normalizedUrl,
        getSetupUrlValidationOptions()
      );
      if (!urlValidation.valid) {
        return res.status(400).json({
          success: false,
          error: `Invalid Paperless API URL: ${urlValidation.error}`,
        });
      }

      const initialized = await paperlessService.initializeWithCredentials(
        normalizedUrl,
        paperlessToken
      );
      if (!initialized) {
        return res.status(400).json({
          success: false,
          error: 'Failed to initialize Paperless-ngx client.',
        });
      }

      const [documentCount, correspondentCount, tagCount, tags] =
        await Promise.all([
          paperlessService.getDocumentCount(),
          paperlessService.getCorrespondentCount(),
          paperlessService.getTagCount(),
          paperlessService.getTags(),
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
          tags: Number(tagCount || 0),
        },
        tagNames,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/setup/paperless/metadata:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not load Paperless metadata.',
      });
    }
  }
);

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
      azureApiVersion: req.body?.azureApiVersion,
      setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test AI connection.',
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
      token: req.body?.token,
      setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ai/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover AI models.',
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
      model: req.body?.model,
      // The OCR helpers take setupOcrValidationTimeoutMs, which is also what
      // the wizard sends; passing it under the AI key dropped the configured
      // OCR timeout on the floor and fell back to the global default.
      setupOcrValidationTimeoutMs:
        req.body?.setupOcrValidationTimeoutMs ??
        req.body?.setupValidationTimeoutMs,
    });

    return res.json(validation);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/test:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not test OCR connection.',
    });
  }
});

/**
 * @swagger
 * /api/setup/ocr/models:
 *   post:
 *     summary: Discover available OCR models during setup
 *     description: |
 *       Returns every discovered model that is not embedding-only. Vision
 *       support is detected from the model name, which recognizes families
 *       such as llava or pixtral and misses OCR-capable models with
 *       unremarkable names, so it ranks the list instead of filtering it:
 *       `visionModels` and `suggestedModel` are hints for the UI, not a
 *       restriction on what may be selected.
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: OCR model list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 models:
 *                   type: array
 *                   description: Every selectable OCR model (embedding-only models excluded)
 *                   items:
 *                     type: string
 *                 visionModels:
 *                   type: array
 *                   description: Subset of models whose name indicates vision support; absent for providers without model classification
 *                   items:
 *                     type: string
 *                 suggestedModel:
 *                   type: string
 *                   nullable: true
 *                   description: Recommended default; absent for providers without model classification
 *                 resolvedApiUrl:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Model discovery failed
 */
router.post('/api/setup/ocr/models', express.json(), async (req, res) => {
  try {
    if (!(await ensureSetupOpenOrRespond(res))) {
      return;
    }

    const result = await discoverOcrModelsForSetup({
      provider: req.body?.provider,
      apiUrl: req.body?.apiUrl,
      // The wizard used to take the field at face value, so an operator whose
      // key already sat in the environment was told to supply one.
      apiKey: resolveOcrApiKey(req.body?.apiKey),
      // Same key mismatch as in /api/setup/ocr/test above: the discovery
      // helper takes setupOcrValidationTimeoutMs. It matters here because
      // classifying an Ollama catalogue costs one /api/show per model and
      // runs against a deadline derived from this timeout.
      setupOcrValidationTimeoutMs:
        req.body?.setupOcrValidationTimeoutMs ??
        req.body?.setupValidationTimeoutMs,
    });

    return res.json(result);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/ocr/models:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Could not discover OCR models.',
    });
  }
});

/**
 * @swagger
 * /api/setup/quickstart/detect:
 *   post:
 *     summary: Auto-detect API flavor and classify models from a single base URL during setup
 *     tags:
 *       - Setup
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - baseUrl
 *             properties:
 *               baseUrl:
 *                 type: string
 *                 example: http://192.168.1.5:1234
 *               apiKey:
 *                 type: string
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Detection result with classified models and suggestions
 *       400:
 *         description: Detection failed (unreachable URL, blocked URL, or no compatible API)
 */
router.post(
  '/api/setup/quickstart/detect',
  express.json(),
  async (req, res) => {
    try {
      if (!(await ensureSetupOpenOrRespond(res))) {
        return;
      }

      const result = await detectQuickstartForSetup({
        baseUrl: req.body?.baseUrl,
        apiKey: req.body?.apiKey,
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/setup/quickstart/detect:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Quickstart detection failed.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/ai/test:
 *   post:
 *     summary: Test AI provider connectivity from the settings page
 *     tags:
 *       - Settings
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
 *               - aiProvider
 *             properties:
 *               aiProvider:
 *                 type: string
 *                 enum: [openai, ollama, custom, azure]
 *               apiUrl:
 *                 type: string
 *               token:
 *                 type: string
 *               model:
 *                 type: string
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: AI connectivity result returned
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/ai/test',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const validation = await validateAiConnectionForSetup({
        aiProvider: req.body?.aiProvider,
        apiUrl: req.body?.apiUrl,
        token: resolveSettingsAiToken(req.body?.aiProvider, req.body?.token),
        model: req.body?.model,
        azureApiVersion: req.body?.azureApiVersion,
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(validation);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ai/test:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not test AI connection.',
      });
    }
  }
);

router.post(
  '/api/settings/ocr/test',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const validation = await validateOcrConnectionForSetup({
        enabled: req.body?.enabled,
        provider: req.body?.provider,
        apiUrl: req.body?.apiUrl,
        apiKey: resolveOcrApiKey(req.body?.apiKey),
        model: req.body?.model,
        setupOcrValidationTimeoutMs:
          req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
      });

      return res.json(validation);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ocr/test:', error);
      return res.status(500).json({
        success: false,
        error: 'Could not test OCR connection.',
      });
    }
  }
);

router.post(
  '/api/settings/ai/models',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await discoverAiModelsForSetup({
        aiProvider: req.body?.aiProvider,
        apiUrl: req.body?.apiUrl,
        token: resolveSettingsAiToken(req.body?.aiProvider, req.body?.token),
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ai/models:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Could not discover AI models.',
      });
    }
  }
);

router.get('/api/settings/ai/presets', isAuthenticated, async (_req, res) => {
  try {
    const presets = await loadAiProviderPresets();
    return res.json({
      success: true,
      presets,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/ai/presets:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not load AI provider presets.',
    });
  }
});

/**
 * @swagger
 * /api/settings/ocr/models:
 *   post:
 *     summary: Discover available OCR models from the settings page
 *     description: |
 *       Returns every discovered model that is not embedding-only. Vision
 *       support is detected from the model name, which recognizes families
 *       such as llava or pixtral and misses OCR-capable models with
 *       unremarkable names, so it ranks the list instead of filtering it:
 *       `visionModels` and `suggestedModel` are hints for the UI, not a
 *       restriction on what may be selected.
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [mistral, custom, ollama]
 *               apiUrl:
 *                 type: string
 *               apiKey:
 *                 type: string
 *                 description: Omit or leave empty to use the stored OCR_API_KEY / MISTRAL_API_KEY
 *               setupOcrValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: OCR model list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 models:
 *                   type: array
 *                   description: Every selectable OCR model (embedding-only models excluded)
 *                   items:
 *                     type: string
 *                 visionModels:
 *                   type: array
 *                   description: Subset of models whose name indicates vision support; absent for providers without model classification
 *                   items:
 *                     type: string
 *                 suggestedModel:
 *                   type: string
 *                   nullable: true
 *                   description: Recommended default; absent for providers without model classification
 *                 resolvedApiUrl:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Model discovery failed
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/ocr/models',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await discoverOcrModelsForSetup({
        provider: req.body?.provider,
        apiUrl: req.body?.apiUrl,
        apiKey: resolveOcrApiKey(req.body?.apiKey),
        setupOcrValidationTimeoutMs:
          req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/ocr/models:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Could not discover OCR models.',
      });
    }
  }
);

/**
 * @swagger
 * /api/settings/quickstart/detect:
 *   post:
 *     summary: Auto-detect API flavor and classify models from a single base URL
 *     tags:
 *       - Settings
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
 *               - baseUrl
 *             properties:
 *               baseUrl:
 *                 type: string
 *                 example: http://192.168.1.5:1234
 *               apiKey:
 *                 type: string
 *                 description: Omit or leave empty to use the stored CUSTOM_API_KEY / OLLAMA_API_KEY
 *               setupValidationTimeoutMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Detection result with classified models and suggestions
 *       400:
 *         description: Detection failed (unreachable URL, blocked URL, or no compatible API)
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/api/settings/quickstart/detect',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const result = await detectQuickstartForSetup({
        baseUrl: req.body?.baseUrl,
        // An empty field means the stored key, not no key: the settings page
        // never renders a saved secret back into the input. Only for the
        // configured AI server, though — see the resolver.
        apiKey: resolveSettingsQuickstartApiKey(
          req.body?.baseUrl,
          req.body?.apiKey
        ),
        setupValidationTimeoutMs: req.body?.setupValidationTimeoutMs,
      });

      return res.json(result);
    } catch (error) {
      console.error('[ERROR] POST /api/settings/quickstart/detect:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Quickstart detection failed.',
      });
    }
  }
);

/**
 * @swagger
 * /api/setup/complete:
 *   post:
 *     summary: Finalize initial setup, persist env config, and trigger restart
 *     description: >
 *       Validates the Paperless, AI and OCR connections before writing the
 *       configuration. The boolean body flags paperlessTestPassed, aiTestPassed
 *       and ocrTestPassed let a caller that has just verified a connection with
 *       these exact values skip the matching probe; anything not flagged is
 *       validated here. allowFailedPaperlessTest and allowFailedAiTest still
 *       accept a connection whose validation failed.
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: Setup completed successfully
 *       403:
 *         description: >
 *           An administrator account already exists. The wizard is closed for
 *           good on this instance; nothing is validated, written or replaced.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/api/setup/complete', express.json(), async (req, res) => {
  try {
    // Before any validation and long before saveConfig()/addUser(): completing
    // setup a second time would delete the existing administrator and repoint
    // the Paperless-ngx connection, unauthenticated.
    if (
      !(await ensureSetupOpenOrRespond(
        res,
        'An administrator account already exists. Sign in and use /settings instead.'
      ))
    ) {
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

    const scanAllDocuments = parseBooleanInput(
      req.body?.scanAllDocuments,
      false
    );
    const includeTags = normalizeTagListInput(req.body?.includeTags);
    const includeTag = String(req.body?.includeTag || '').trim();
    const effectiveIncludeTags = Array.from(
      new Set([...includeTags, ...(includeTag ? [includeTag] : [])])
    );
    const excludeTags = normalizeTagListInput(req.body?.excludeTags);
    const processedTag = String(req.body?.processedTag || '').trim();
    const effectiveExcludeTags = Array.from(
      new Set([...excludeTags, ...(processedTag ? [processedTag] : [])])
    );
    const automaticScanEnabled = parseBooleanInput(
      req.body?.automaticScanEnabled,
      true
    );
    const scanInterval =
      String(req.body?.scanInterval || getDefaultScanInterval()).trim() ||
      getDefaultScanInterval();

    const aiProvider = String(req.body?.aiProvider || '')
      .trim()
      .toLowerCase();
    const aiApiUrl = String(req.body?.aiApiUrl || '').trim();
    const aiToken = String(req.body?.aiToken || '').trim();
    const aiModel = String(req.body?.aiModel || '').trim();
    const aiAzureApiVersion =
      String(req.body?.aiAzureApiVersion || '2023-05-15').trim() ||
      '2023-05-15';
    const setupValidationTimeoutMs = setupService.normalizeValidationTimeoutMs(
      req.body?.setupValidationTimeoutMs,
      30000
    );
    const setupOcrValidationTimeoutMs =
      setupService.normalizeValidationTimeoutMs(
        req.body?.setupOcrValidationTimeoutMs ??
          req.body?.setupValidationTimeoutMs,
        30000
      );

    const allowFailedPaperlessTest = parseBooleanInput(
      req.body?.allowFailedPaperlessTest,
      false
    );
    const allowFailedAiTest = parseBooleanInput(
      req.body?.allowFailedAiTest,
      false
    );

    // The wizard reports which connections it already proved reachable with
    // exactly the values being submitted (it drops the flag as soon as one of
    // them is edited). Honouring that spares the user a second wait — and a
    // second billed AI call — for probes they just watched succeed. Anything
    // not reported as passing is still validated below.
    const paperlessTestPassed = parseBooleanInput(
      req.body?.paperlessTestPassed,
      false
    );
    const aiTestPassed = parseBooleanInput(req.body?.aiTestPassed, false);
    const ocrTestPassed = parseBooleanInput(req.body?.ocrTestPassed, false);
    const alreadyVerified = { success: true, message: 'Verified by setup.' };

    const mistralOcrEnabled = parseBooleanInput(
      req.body?.mistralOcrEnabled,
      false
    );
    const ocrProvider = String(req.body?.ocrProvider || 'mistral')
      .trim()
      .toLowerCase();
    const ocrApiUrlRaw = String(req.body?.ocrApiUrl || '').trim();
    const ocrApiUrl = ocrProvider === 'mistral' ? '' : ocrApiUrlRaw;
    const ocrApiKey = String(
      req.body?.ocrApiKey || req.body?.mistralApiKey || ''
    ).trim();
    const mistralOcrModel =
      String(req.body?.mistralOcrModel || 'mistral-ocr-latest').trim() ||
      'mistral-ocr-latest';

    if (!['mistral', 'custom', 'ollama'].includes(ocrProvider)) {
      return res.status(400).json({
        success: false,
        error: 'A valid OCR provider is required.',
      });
    }

    if (mistralOcrEnabled && ocrProvider === 'mistral' && !ocrApiKey) {
      return res.status(400).json({
        success: false,
        error:
          'Mistral API key is required when OCR provider is set to mistral.',
      });
    }

    if (!adminUsername || !adminPassword) {
      return res.status(400).json({
        success: false,
        error: 'Admin username and password are required.',
      });
    }

    if (adminPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long.',
      });
    }

    if (!paperlessUrl || !paperlessUsername || !paperlessToken) {
      return res.status(400).json({
        success: false,
        error: 'Paperless URL, username, and token are required.',
      });
    }

    if (!scanAllDocuments && effectiveIncludeTags.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'Select at least one tag for scanned documents or enable scanning all documents.',
      });
    }

    if (
      !aiProvider ||
      !['openai', 'ollama', 'custom', 'azure'].includes(aiProvider)
    ) {
      return res.status(400).json({
        success: false,
        error: 'A valid AI provider is required.',
      });
    }

    const paperlessValidation = paperlessTestPassed
      ? alreadyVerified
      : await validatePaperlessConnectionForSetup(paperlessUrl, paperlessToken);
    if (!paperlessValidation.success && !allowFailedPaperlessTest) {
      return res.status(400).json({
        success: false,
        error: paperlessValidation.message,
      });
    }

    const aiValidation = aiTestPassed
      ? alreadyVerified
      : await validateAiConnectionForSetup({
          aiProvider,
          apiUrl: aiApiUrl,
          token: aiToken,
          model: aiModel,
          azureApiVersion: aiAzureApiVersion,
          setupValidationTimeoutMs,
        });

    if (!aiValidation.success && !allowFailedAiTest) {
      return res.status(400).json({
        success: false,
        error: aiValidation.message,
      });
    }

    const ocrProviderForValidation =
      ocrProvider === 'custom' ? 'ollama' : ocrProvider;
    const ocrValidation = ocrTestPassed
      ? alreadyVerified
      : await validateOcrConnectionForSetup({
          enabled: mistralOcrEnabled ? 'yes' : 'no',
          provider: ocrProviderForValidation,
          apiUrl: ocrApiUrl,
          apiKey: ocrApiKey,
          model: mistralOcrModel,
          setupOcrValidationTimeoutMs,
        });

    if (!ocrValidation.success) {
      return res.status(400).json({
        success: false,
        error: ocrValidation.message,
      });
    }

    const tagsForProcessing = scanAllDocuments ? [] : effectiveIncludeTags;
    const apiToken =
      process.env.API_KEY || crypto.randomBytes(64).toString('hex');
    const jwtToken =
      process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

    const finalConfig = {
      PAPERLESS_API_URL: paperlessUrl,
      PAPERLESS_API_TOKEN: paperlessToken,
      PAPERLESS_USERNAME: paperlessUsername,
      AI_PROVIDER: aiProvider,
      SCAN_INTERVAL: scanInterval,
      PROCESS_PREDEFINED_DOCUMENTS: scanAllDocuments ? 'no' : 'yes',
      TAGS: tagsForProcessing,
      IGNORE_TAGS: effectiveExcludeTags,
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
      MISTRAL_OCR_MODEL: mistralOcrModel,
      SETUP_VALIDATION_TIMEOUT_MS: String(setupValidationTimeoutMs),
      SETUP_OCR_VALIDATION_TIMEOUT_MS: String(setupOcrValidationTimeoutMs),
    };

    if (aiProvider === 'openai') {
      finalConfig.OPENAI_API_KEY = aiToken;
      finalConfig.OPENAI_MODEL = aiModel || 'gpt-4o-mini';
    } else if (aiProvider === 'ollama') {
      finalConfig.OLLAMA_API_URL = aiApiUrl || 'http://localhost:11434';
      finalConfig.OLLAMA_API_KEY = aiToken;
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
          error: 'MFA setup is incomplete. Generate and confirm a code first.',
        });
      }

      const challenge = setupMfaChallenges.get(mfaChallengeId);
      if (!challenge || !challenge.verified) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup is incomplete or expired. Please repeat MFA setup.',
        });
      }

      if (challenge.username !== adminUsername) {
        return res.status(400).json({
          success: false,
          error: 'MFA setup username does not match the admin username.',
        });
      }

      mfaSecretToPersist = challenge.secret;
    }

    await setupService.saveConfig(finalConfig, {
      skipValidation: allowFailedPaperlessTest || allowFailedAiTest,
    });

    const hashedPassword = await bcrypt.hash(adminPassword, 15);
    await documentModel.addUser(adminUsername, hashedPassword);

    if (enableMfa && mfaSecretToPersist) {
      await documentModel.setUserMfaSettings(
        adminUsername,
        true,
        mfaSecretToPersist
      );
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
      envPreview,
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000);
  } catch (error) {
    console.error('[ERROR] POST /api/setup/complete:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to complete setup: ' + error.message,
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
          Authorization: `Token ${process.env.PAPERLESS_API_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch document content: ${response.status} ${response.statusText}`
      );
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(
      document.tags.map(async (tag) => {
        const tagName = await paperlessService.getTagTextFromId(tag);
        return tagName;
      })
    );
    console.log('Document Data:', document);
    res.json({
      content: document.content,
      title: document.title,
      id: document.id,
      tags: document.tags,
    });
  } catch (error) {
    console.error('Content fetch error:', error);
    res
      .status(500)
      .json({ error: `Error fetching document content: ${error.message}` });
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
    config: {},
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
      console.log(
        `Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`
      );
      return;
    }

    // No own-user-ID lookup here: it was resolved, threaded through two call
    // frames and dropped, since processDocument() never reads it. It also used
    // to gate the queue — an unresolvable ID aborted manual processing
    // outright (issue #305) — so this drops the guard, the request and the
    // warning it would now log once per run.
    const [existingTags, existingCorrespondentList, existingDocumentTypes] =
      await Promise.all([
        paperlessService.getTags(),
        paperlessService.listCorrespondentsNames(),
        paperlessService.listDocumentTypesNames(),
      ]);

    // The paperlessService helpers return entity objects, so every list has to
    // be reduced to plain names before it reaches the AI services — otherwise
    // the "Pre-existing ..." prompt blocks render as "[object Object]".
    const existingTagNames = toNameList(existingTags);
    const existingCorrespondentNames = toNameList(existingCorrespondentList);
    const existingDocumentTypesList = toNameList(existingDocumentTypes);

    while (documentQueue.length > 0) {
      const doc = documentQueue.shift();

      try {
        const result = await processDocument(
          doc,
          existingTagNames,
          existingCorrespondentNames,
          existingDocumentTypesList,
          customPrompt
        );
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
 * Reprocess specific documents by ID, bypassing the scan tag/filter rules.
 *
 * Clears the local processed_documents record (so the processDocument() gate
 * lets them through) and enqueues each document for direct AI processing via
 * the shared documentQueue — regardless of whether it still carries the
 * configured trigger tag. Processing runs in the background (fire-and-forget)
 * so callers get a fast response.
 *
 * @param {Array<number|string>} ids - Document IDs to reprocess.
 * @returns {Promise<{queued: number, notFound: number[]}>}
 */
async function rescanDocumentsByIds(ids) {
  const numericIds = (Array.isArray(ids) ? ids : [])
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (numericIds.length === 0) {
    return { queued: 0, notFound: [] };
  }

  // Drop the local "already processed" record so the gate in processDocument()
  // no longer skips these documents.
  await documentModel.deleteDocumentsIdList(numericIds);
  await removeThumbnailCacheForDocumentIds(numericIds);

  const notFound = [];
  let queued = 0;

  for (const id of numericIds) {
    try {
      const document = await paperlessService.getDocument(id);
      if (!document) {
        notFound.push(id);
        continue;
      }
      documentQueue.push(document);
      queued += 1;
    } catch (error) {
      console.error(
        `[ERROR] Failed to fetch document ${id} for rescan:`,
        error.message
      );
      notFound.push(id);
    }
  }

  // Fire-and-forget: the HTTP response should not wait for AI processing.
  if (queued > 0) {
    processQueue();
  }

  return { queued, notFound };
}

/**
 * @swagger
 * /api/webhook/document:
 *   post:
 *     summary: Webhook for document updates
 *     description: |
 *       Processes incoming webhook notifications from Paperless-ngx about document
 *       changes, additions, or deletions. The webhook allows Zettelrobbe to respond
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
        console.log('[DEBUG] Using custom prompt:', prompt);
        await processQueue(prompt);
      } else {
        await processQueue();
      }

      res.status(202).send({
        message: 'Document accepted for processing',
        documentId: documentId,
        queuePosition: documentQueue.length,
      });
    } catch (error) {
      console.error(
        '[ERROR] Failed to extract document ID or fetch document:',
        error
      );
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
    console.warn(
      '[WARN] Could not resolve Paperless public URL for dashboard links:',
      error.message
    );
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
      languageDistribution: [],
    },
    openai_data: {
      averagePromptTokens: 0,
      averageCompletionTokens: 0,
      averageTotalTokens: 0,
      tokensOverall: 0,
    },
    version,
    paperlessUrl,
    // The cards the view loops over. Which widgets ship, in which order and how
    // wide, is the registry's business — the view only renders what it is given.
    dashboardWidgets,
  });
});

// The payload itself is assembled in dashboardStatsService and cached there:
// this endpoint is polled by every open dashboard, and rebuilding it per
// request meant two Paperless-ngx round trips plus a dozen queries each time.
router.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { payload, cachedAt } = await dashboardStatsService.getStats();
    res.json({ ...payload, cachedAt });
  } catch (error) {
    console.error('[ERROR] loading dashboard stats:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard stats' });
  }
});

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics payload
 *     description: |
 *       Returns all aggregate counters and chart datasets required by the dashboard UI.
 *
 *       The payload is served from an in-memory cache instead of being rebuilt per
 *       request. It is refreshed in the background (once a minute, plus after every
 *       scan run) and expires after STATS_CACHE_TTL_SECONDS (default 60). The scan
 *       loop invalidates it for every document it processes, so figures follow
 *       processing without polling Paperless-ngx on every request.
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
 *               properties:
 *                 success:
 *                   type: boolean
 *                 cachedAt:
 *                   type: integer
 *                   format: int64
 *                   description: >-
 *                     Epoch milliseconds at which the returned payload was assembled.
 *                     0 when the assembly time is unknown.
 *                 paperless_data:
 *                   type: object
 *                   description: Aggregate counters and chart datasets.
 *                 openai_data:
 *                   type: object
 *                   description: Token averages and the overall token total.
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
  const normalizeArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string')
      return value
        .split(',')
        .filter(Boolean)
        .map((item) => item.trim());
    return [];
  };

  let showErrorCheckSettings = false;
  const isConfigured = await setupService.isConfigured();
  const runtimeOverrides = await setupService.loadRuntimeOverrides();
  const injectedEnvSnapshot =
    global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ || {};
  const secretKeys = new Set(SETTINGS_SECRET_FIELDS);

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
      const hasInjectedValue = Object.prototype.hasOwnProperty.call(
        injectedEnvSnapshot,
        key
      );
      if (!hasInjectedValue) {
        return false;
      }

      const injectedValue =
        injectedEnvSnapshot[key] == null
          ? ''
          : String(injectedEnvSnapshot[key]);
      const overrideValue =
        runtimeOverrides[key] == null ? '' : String(runtimeOverrides[key]);
      const isOverwritten = injectedValue !== overrideValue;

      if (isOverwritten) {
        runtimeOverrideDetails[key] = {
          injected: formatValueForTooltip(key, injectedValue),
          override: formatValueForTooltip(key, overrideValue),
        };
      }

      return isOverwritten;
    })
  );
  // An incomplete configuration now always lands here rather than reopening the
  // setup wizard, so say why - not only in the PAPERLESS_AI_INITIAL_SETUP case.
  if (!isConfigured) {
    showErrorCheckSettings = true;
  }
  let config = {
    PAPERLESS_API_URL: (
      process.env.PAPERLESS_API_URL || 'http://localhost:8000'
    ).replace(/\/api$/, ''),
    PAPERLESS_PUBLIC_URL: process.env.PAPERLESS_PUBLIC_URL || '',
    PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
    PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
    SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
    RECONCILIATION_INTERVAL: process.env.RECONCILIATION_INTERVAL || '0 * * * *',
    RECONCILIATION_ENABLED: process.env.RECONCILIATION_ENABLED || 'yes',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
    PROCESS_PREDEFINED_DOCUMENTS:
      process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',

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
    AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
    AZURE_API_KEY: process.env.AZURE_API_KEY || '',
    AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
    AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
    RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
    RESTRICT_TO_EXISTING_CORRESPONDENTS:
      process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
    RESTRICT_TO_EXISTING_DOCUMENT_TYPES:
      process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
    EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
    EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
    EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
    EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
    EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
    EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || '',
    EXTERNAL_API_ALLOW_PRIVATE_IPS:
      process.env.EXTERNAL_API_ALLOW_PRIVATE_IPS || 'no',
    TAG_CACHE_TTL_SECONDS: process.env.TAG_CACHE_TTL_SECONDS || '300',
    ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING || 'yes',
    ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS || 'yes',
    ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE || 'yes',
    ACTIVATE_TITLE: process.env.ACTIVATE_TITLE || 'yes',
    ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS || 'yes',
    CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}',
    DISABLE_AUTOMATIC_PROCESSING:
      process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
    MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
    OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
    OCR_API_URL: process.env.OCR_API_URL || '',
    OCR_API_KEY: process.env.OCR_API_KEY || '',
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
    MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
    OCR_PDF_RENDER_ENABLED: process.env.OCR_PDF_RENDER_ENABLED || 'yes',
    OCR_PDF_RENDER_MAX_PAGES: process.env.OCR_PDF_RENDER_MAX_PAGES || '10',
    OCR_PDF_RENDER_DPI: process.env.OCR_PDF_RENDER_DPI || '150',
    OCR_AUTO_PROCESS_ENABLED: process.env.OCR_AUTO_PROCESS_ENABLED || 'no',
    OCR_AUTO_PROCESS_INTERVAL:
      process.env.OCR_AUTO_PROCESS_INTERVAL || '*/15 * * * *',
    OCR_AUTO_PROCESS_BATCH_SIZE:
      process.env.OCR_AUTO_PROCESS_BATCH_SIZE || '10',
    OCR_AUTO_ANALYZE: process.env.OCR_AUTO_ANALYZE || 'yes',
    SETUP_OCR_VALIDATION_TIMEOUT_MS:
      process.env.SETUP_OCR_VALIDATION_TIMEOUT_MS ||
      process.env.SETUP_VALIDATION_TIMEOUT_MS ||
      '30000',
    GLOBAL_RATE_LIMIT_WINDOW_MS:
      process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000',
    GLOBAL_RATE_LIMIT_MAX: process.env.GLOBAL_RATE_LIMIT_MAX || '1000',
    TRUST_PROXY:
      typeof process.env.TRUST_PROXY === 'undefined'
        ? ''
        : process.env.TRUST_PROXY,
    COOKIE_SECURE_MODE: process.env.COOKIE_SECURE_MODE || 'auto',
    MIN_CONTENT_LENGTH: process.env.MIN_CONTENT_LENGTH || '10',
    PAPERLESS_AI_PORT: process.env.PAPERLESS_AI_PORT || '3000',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    DATE_FORMAT: process.env.DATE_FORMAT || 'DD.MM.YYYY',
  };

  if (isConfigured) {
    const savedConfig = await setupService.loadConfig();
    if (savedConfig) {
      if (savedConfig.PAPERLESS_API_URL) {
        savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(
          /\/api$/,
          ''
        );
      }

      savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
      savedConfig.IGNORE_TAGS = normalizeArray(savedConfig.IGNORE_TAGS);
      savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

      config = { ...config, ...savedConfig };
    }
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
        managed: formatValueForTooltip(key, injectedEnvSnapshot[key]),
      },
    ])
  );

  const configuredSecrets = {};
  SETTINGS_SECRET_FIELDS.forEach((key) => {
    configuredSecrets[key] = Boolean(config[key]);
    config[key] = '';
  });

  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  const aiProviderPresets = await loadAiProviderPresets();
  let mfaSettings = {
    available: false,
    username: '',
    enabled: false,
  };

  const settingsUsername = getAuthenticatedSettingsUsername(req);
  if (settingsUsername) {
    try {
      const settingsUser = await documentModel.getUser(settingsUsername);
      if (settingsUser) {
        mfaSettings = {
          available: true,
          username: settingsUser.username,
          enabled: isMfaEnabledForUser(settingsUser),
        };
      }
    } catch (mfaContextError) {
      console.error(
        '[WARN] Failed to resolve MFA settings context:',
        mfaContextError
      );
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
    aiProviderPresets,
    mfaSettings,
    changelogReleases: changelog.releases,
    // No banner for the normal case: "already configured" was shown on every
    // visit to a configured instance, i.e. always, and said nothing.
    success: undefined,
    settingsError: showErrorCheckSettings
      ? 'Please check your settings. Something is not working correctly.'
      : undefined,
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
    const apiKey = configFile.getApiKey
      ? configFile.getApiKey()
      : process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '';
    return res.json({
      success: true,
      configured: Boolean(apiKey),
      apiKey: apiKey || null,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/api-key:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load API key' });
  }
});

router.get(
  '/api/settings/paperless-public-url',
  isAuthenticated,
  async (req, res) => {
    try {
      const details = await paperlessService.getPublicBaseUrlDetails({
        forceRefresh: true,
      });
      return res.json({
        success: true,
        publicUrl: details.url,
        source: details.source,
      });
    } catch (error) {
      console.error('[ERROR] GET /api/settings/paperless-public-url:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to detect Paperless public URL',
      });
    }
  }
);

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

      if (!verifyTotpToken(payload.secret, token)) {
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

      if (!verifyTotpToken(user.mfa_secret, token)) {
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
    const { content, id } = req.body;
    const existingCorrespondentList = toNameList(
      await paperlessService.listCorrespondentsNames()
    );
    const existingTagsList = toNameList(await paperlessService.listTagNames());
    const existingDocumentTypesList = toNameList(
      await paperlessService.listDocumentTypesNames()
    );

    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res
        .status(400)
        .json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzeDocument(
        content,
        existingTagsList,
        existingCorrespondentList,
        existingDocumentTypesList,
        id || []
      );
      await documentModel.addOpenAIMetrics(
        id,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzeDocument(
        content,
        existingTagsList,
        existingCorrespondentList,
        existingDocumentTypesList,
        id || []
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzeDocument(
        content,
        existingTagsList,
        existingCorrespondentList,
        existingDocumentTypesList,
        id || []
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'azure') {
      const analyzeDocument = await azureService.analyzeDocument(
        content,
        existingTagsList,
        existingCorrespondentList,
        existingDocumentTypesList,
        id || []
      );
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
 *     deprecated: true
 *     summary: Process document using a custom prompt in playground mode (deprecated)
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
    const { content, prompt, documentId } = req.body;

    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res
        .status(400)
        .json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzePlayground(
        content,
        prompt
      );
      await documentModel.addOpenAIMetrics(
        documentId,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzePlayground(
        content,
        prompt
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzePlayground(
        content,
        prompt
      );
      await documentModel.addOpenAIMetrics(
        documentId,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'azure') {
      const analyzeDocument = await azureService.analyzePlayground(
        content,
        prompt
      );
      await documentModel.addOpenAIMetrics(
        documentId,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
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
      restrictToExistingCorrespondents:
        config.restrictToExistingCorrespondents === 'yes',
      restrictToExistingDocumentTypes:
        config.restrictToExistingDocumentTypes === 'yes',
    };

    console.log('TITLE: ', title);
    // Convert all tags to names if they are IDs
    tags = await Promise.all(
      tags.map(async (tag) => {
        console.log('Processing tag:', tag);
        if (!isNaN(tag)) {
          const tagName = await paperlessService.getTagTextFromId(Number(tag));
          console.log('Converted tag ID:', tag, 'to name:', tagName);
          return tagName;
        }
        return tag;
      })
    );

    // Filter out any null or undefined tags
    tags = tags.filter((tag) => tag != null);

    // Process new tags to get their IDs
    const { tagIds, errors } = await paperlessService.processTags(
      tags,
      options
    );
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Process correspondent if provided
    const correspondentData = correspondent
      ? await paperlessService.getOrCreateCorrespondent(correspondent, options)
      : null;

    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);

    // Then update with new tags (this will only add new ones since we already removed unused ones)
    const updateData = {
      tags: tagIds,
      correspondent: correspondentData ? correspondentData.id : null,
      title: title ? title : null,
    };

    if (
      updateData.tags === null &&
      updateData.correspondent === null &&
      updateData.title === null
    ) {
      return res.status(400).json({ error: 'No changes provided' });
    }
    const updateDocument = await paperlessService.updateDocument(
      documentId,
      updateData
    );

    // Mark document as processed
    await documentModel.addProcessedDocument(documentId, updateData.title);
    dashboardStatsService.invalidate();

    res.json(updateDocument);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Builds the scanner/Paperless section of the health payload.
 * Shared by /health and /api/processing-status so both report the same state.
 */
function buildScannerHealthSnapshot() {
  const scanner = scanHealthService.getState();
  const scanState = global.__paperlessAiScanControl || {};

  return {
    scanner: {
      automaticProcessingEnabled: scanner.automaticProcessingEnabled,
      armed: scanner.armed,
      running: Boolean(scanState.running),
      scanInterval: scanner.scanInterval,
      lastRunStartedAt: scanner.lastRunStartedAt,
      lastRunFinishedAt: scanner.lastRunFinishedAt,
      lastRunSource: scanner.lastRunSource,
      lastRunStatus: scanner.lastRunStatus,
      lastSuccessfulRunAt: scanner.lastSuccessfulRunAt,
      consecutiveFailures: scanner.consecutiveFailures,
      failureThreshold: scanner.failureThreshold,
      degraded: scanner.degraded,
      lastError: scanner.lastError,
    },
    paperless: {
      reachable: scanner.paperless.reachable,
      authorized: scanner.paperless.authorized,
      usable: scanner.paperless.usable,
      status: scanner.paperless.status,
      lastCheckedAt: scanner.paperless.lastCheckedAt,
      error: scanner.paperless.error,
    },
  };
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Reports database connectivity **and** whether the document scanner is
 *       actually able to work. Used by the Docker healthcheck and monitoring.
 *
 *       `status` is `healthy` when the database is reachable and the scanner is
 *       operational, `degraded` when automatic processing is enabled but the
 *       scan loop is not armed or has failed `failureThreshold` runs in a row
 *       (for example because Paperless-ngx is unreachable), and `database_error`
 *       when the local database cannot be queried.
 *
 *       A `degraded` state answers with HTTP 503 unless `HEALTHCHECK_STRICT=no`
 *       is configured, in which case the details are reported with HTTP 200.
 *       When automatic processing is switched off via
 *       `DISABLE_AUTOMATIC_PROCESSING=yes`, a missing scan loop is expected and
 *       never reported as degraded.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: System is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
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
 *         description: |
 *           Service unavailable — either the database check failed
 *           (`database_error`) or the scanner is degraded (`degraded`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/health', async (req, res) => {
  try {
    try {
      await documentModel.isDocumentProcessed(1);
    } catch {
      return res.status(503).json({
        status: 'database_error',
        message: 'Database check failed',
      });
    }

    const snapshot = buildScannerHealthSnapshot();
    const degraded = snapshot.scanner.degraded;
    const payload = {
      status: degraded ? 'degraded' : 'healthy',
      database: 'ok',
      ...snapshot,
    };

    if (degraded) {
      payload.message = snapshot.scanner.armed
        ? `Document scan failed ${snapshot.scanner.consecutiveFailures} time(s) in a row: ${snapshot.scanner.lastError || 'unknown error'}`
        : 'Document scan scheduler is not armed';

      if (scanHealthService.strictHealthEnabled) {
        return res.status(503).json(payload);
      }
    }

    res.json(payload);
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

/**
 * @swagger
 * /settings:
 *   post:
 *     summary: Update application settings
 *     description: |
 *       Updates the configuration settings of the Zettelrobbe application after initial setup.
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
 *               ollamaApiKey:
 *                 type: string
 *                 description: Optional bearer token for Ollama endpoints that require authentication (leave empty to keep the configured value)
 *                 example: "ollama-abc123"
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
 *               reconciliationEnabled:
 *                 type: string
 *                 description: Enable automatic history reconciliation (yes/no)
 *                 example: "yes"
 *               reconciliationInterval:
 *                 type: string
 *                 description: Cron expression for the reconciliation schedule
 *                 example: "0 * * * *"
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
 *                 minimum: 1
 *                 description: Tokens a provider may spend on its answer. Reserved in the context window and sent as the generation limit (num_predict for Ollama, max_tokens elsewhere). Rejected with 400 when it is not a positive whole number.
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
 *               ocrAutoProcessEnabled:
 *                 type: string
 *                 description: Process queued OCR documents automatically (yes/no)
 *                 example: "no"
 *               ocrAutoProcessInterval:
 *                 type: string
 *                 description: Cron expression for the automatic OCR queue schedule
 *                 example: "0,15,30,45 * * * *"
 *               ocrAutoProcessBatchSize:
 *                 type: integer
 *                 description: Maximum queued documents handled per automatic OCR run (1-100)
 *                 example: 10
 *               ocrAutoAnalyze:
 *                 type: string
 *                 description: Run AI analysis directly after automatic OCR (yes/no)
 *                 example: "yes"
 *               dateFormat:
 *                 type: string
 *                 description: How every date in the web interface is rendered
 *                 enum: ["DD.MM.YYYY", "YYYY-MM-DD"]
 *                 example: "DD.MM.YYYY"
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
      ollamaApiKey,
      ollamaModel,
      scanInterval,
      reconciliationEnabled,
      reconciliationInterval,
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
      customFields, // Added parameter
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
      ocrValidationTimeout,
      ocrPdfRenderEnabled,
      ocrPdfRenderMaxPages,
      ocrPdfRenderDpi,
      ocrAutoProcessEnabled,
      ocrAutoProcessInterval,
      ocrAutoProcessBatchSize,
      ocrAutoAnalyze,
      globalRateLimitWindowMs,
      globalRateLimitMax,
      trustProxy,
      cookieSecureMode,
      minContentLength,
      paperlessAiPort,
      externalApiAllowPrivateIps,
      logLevel,
      dateFormat,
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
      OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || '',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      RECONCILIATION_INTERVAL:
        process.env.RECONCILIATION_INTERVAL || '0 * * * *',
      RECONCILIATION_ENABLED: process.env.RECONCILIATION_ENABLED || 'yes',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS:
        process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      AI_TEMPERATURE_ANALYSIS: process.env.AI_TEMPERATURE_ANALYSIS || '0.3',
      AI_TEMPERATURE_GENERATION: process.env.AI_TEMPERATURE_GENERATION || '0.7',
      TAGS: process.env.TAGS || '',
      IGNORE_TAGS: process.env.IGNORE_TAGS || '',
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME:
        process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
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
      CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}', // Added default
      DISABLE_AUTOMATIC_PROCESSING:
        process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
      RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
      RESTRICT_TO_EXISTING_CORRESPONDENTS:
        process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
      RESTRICT_TO_EXISTING_DOCUMENT_TYPES:
        process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
      EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
      EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
      EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
      EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
      EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
      EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
      EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || '',
      EXTERNAL_API_ALLOW_PRIVATE_IPS:
        process.env.EXTERNAL_API_ALLOW_PRIVATE_IPS || 'no',
      TAG_CACHE_TTL_SECONDS: process.env.TAG_CACHE_TTL_SECONDS || '300',
      MISTRAL_OCR_ENABLED: process.env.MISTRAL_OCR_ENABLED || 'no',
      OCR_PROVIDER: process.env.OCR_PROVIDER || 'mistral',
      OCR_API_URL: process.env.OCR_API_URL || '',
      OCR_API_KEY: process.env.OCR_API_KEY || '',
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
      MISTRAL_OCR_MODEL: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      SETUP_OCR_VALIDATION_TIMEOUT_MS:
        process.env.SETUP_OCR_VALIDATION_TIMEOUT_MS ||
        process.env.SETUP_VALIDATION_TIMEOUT_MS ||
        '30000',
      OCR_PDF_RENDER_ENABLED: process.env.OCR_PDF_RENDER_ENABLED || 'yes',
      OCR_PDF_RENDER_MAX_PAGES: process.env.OCR_PDF_RENDER_MAX_PAGES || '10',
      OCR_PDF_RENDER_DPI: process.env.OCR_PDF_RENDER_DPI || '150',
      OCR_AUTO_PROCESS_ENABLED: process.env.OCR_AUTO_PROCESS_ENABLED || 'no',
      OCR_AUTO_PROCESS_INTERVAL:
        process.env.OCR_AUTO_PROCESS_INTERVAL || '*/15 * * * *',
      OCR_AUTO_PROCESS_BATCH_SIZE:
        process.env.OCR_AUTO_PROCESS_BATCH_SIZE || '10',
      OCR_AUTO_ANALYZE: process.env.OCR_AUTO_ANALYZE || 'yes',
      GLOBAL_RATE_LIMIT_WINDOW_MS:
        process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '900000',
      GLOBAL_RATE_LIMIT_MAX: process.env.GLOBAL_RATE_LIMIT_MAX || '1000',
      TRUST_PROXY:
        typeof process.env.TRUST_PROXY === 'undefined'
          ? ''
          : process.env.TRUST_PROXY,
      COOKIE_SECURE_MODE: process.env.COOKIE_SECURE_MODE || 'auto',
      MIN_CONTENT_LENGTH: process.env.MIN_CONTENT_LENGTH || '10',
      PAPERLESS_AI_PORT: process.env.PAPERLESS_AI_PORT || '3000',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      DATE_FORMAT: process.env.DATE_FORMAT || 'DD.MM.YYYY',
    };

    const hasValue = (value) =>
      typeof value === 'string' && value.trim() !== '';

    const hasPaperlessTokenInput = hasValue(paperlessToken);
    const hasPaperlessUrlInput = hasValue(paperlessUrl);
    const normalizedCurrentPaperlessUrl = (
      currentConfig.PAPERLESS_API_URL || ''
    ).replace(/\/api$/, '');
    const effectivePaperlessUrl = hasPaperlessUrlInput
      ? paperlessUrl
      : normalizedCurrentPaperlessUrl;
    const effectivePaperlessToken = hasPaperlessTokenInput
      ? paperlessToken.trim()
      : currentConfig.PAPERLESS_API_TOKEN;
    const hasOpenAiKeyInput = hasValue(openaiKey);
    const effectiveOpenAiKey = hasOpenAiKeyInput
      ? openaiKey.trim()
      : currentConfig.OPENAI_API_KEY;
    const hasOllamaApiKeyInput = hasValue(ollamaApiKey);
    const effectiveOllamaApiKey = hasOllamaApiKeyInput
      ? ollamaApiKey.trim()
      : currentConfig.OLLAMA_API_KEY;
    const hasCustomApiKeyInput = hasValue(customApiKey);
    const effectiveCustomApiKey = hasCustomApiKeyInput
      ? customApiKey.trim()
      : currentConfig.CUSTOM_API_KEY;
    const hasAzureApiKeyInput = hasValue(azureApiKey);
    const effectiveAzureApiKey = hasAzureApiKeyInput
      ? azureApiKey.trim()
      : currentConfig.AZURE_API_KEY;
    const normalizedOcrApiKeyInput = hasValue(ocrApiKey)
      ? String(ocrApiKey).trim()
      : String(mistralApiKey || '').trim();
    const hasOcrApiKeyInput = hasValue(normalizedOcrApiKeyInput);
    const effectiveOcrApiKey = hasOcrApiKeyInput
      ? normalizedOcrApiKeyInput
      : currentConfig.OCR_API_KEY || currentConfig.MISTRAL_API_KEY || '';
    const normalizedOcrProvider = String(
      ocrProvider || currentConfig.OCR_PROVIDER || 'mistral'
    )
      .trim()
      .toLowerCase();
    const effectiveOcrEnabled = hasValue(mistralOcrEnabled)
      ? String(mistralOcrEnabled).trim().toLowerCase()
      : String(currentConfig.MISTRAL_OCR_ENABLED || 'no')
          .trim()
          .toLowerCase();
    const effectiveOcrValidationTimeoutMs =
      setupService.normalizeValidationTimeoutMs(
        hasValue(ocrValidationTimeout)
          ? Number.parseInt(String(ocrValidationTimeout).trim(), 10) * 1000
          : currentConfig.SETUP_OCR_VALIDATION_TIMEOUT_MS,
        30000
      );

    if (!['mistral', 'custom', 'ollama'].includes(normalizedOcrProvider)) {
      return res.status(400).json({
        error: 'Invalid OCR provider. Allowed values are mistral and custom.',
      });
    }

    if (
      effectiveOcrEnabled === 'yes' &&
      normalizedOcrProvider === 'mistral' &&
      !effectiveOcrApiKey
    ) {
      return res.status(400).json({
        error:
          'Mistral API key is required when OCR fallback is enabled with provider mistral.',
      });
    }

    // Saving deliberately runs no live OCR connection test — only the value
    // checks above. Use the "Test OCR Connection" button (/api/settings/ocr/test)
    // to verify connectivity on demand.

    // Process custom fields
    let processedCustomFields = [];
    if (customFields) {
      try {
        const parsedFields =
          typeof customFields === 'string'
            ? JSON.parse(customFields)
            : customFields;

        processedCustomFields = parsedFields.custom_fields.map((field) => ({
          value: field.value,
          data_type: field.data_type,
          ...(field.currency && { currency: field.currency }),
        }));
      } catch (error) {
        console.error('Error processing custom fields:', error);
        processedCustomFields = [];
      }
    }

    const normalizeArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string')
        return value
          .split(',')
          .filter(Boolean)
          .map((item) => item.trim());
      return [];
    };

    const sanitizeTemperatureValue = (rawValue, fallbackValue, envKey) => {
      const normalizedValue = String(rawValue ?? '').trim();
      if (!normalizedValue) {
        return fallbackValue;
      }

      const parsed = Number.parseFloat(normalizedValue);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
        console.warn(
          `[WARN] Invalid ${envKey} value: ${normalizedValue}. Using fallback: ${fallbackValue}`
        );
        return fallbackValue;
      }

      return String(parsed);
    };

    // Extract tag and correspondent restriction settings with defaults
    const restrictToExistingTags =
      req.body.restrictToExistingTags === 'on' ||
      req.body.restrictToExistingTags === 'yes';
    const restrictToExistingCorrespondents =
      req.body.restrictToExistingCorrespondents === 'on' ||
      req.body.restrictToExistingCorrespondents === 'yes';
    const restrictToExistingDocumentTypes =
      req.body.restrictToExistingDocumentTypes === 'on' ||
      req.body.restrictToExistingDocumentTypes === 'yes';

    // Extract external API settings with defaults
    const externalApiEnabled =
      req.body.externalApiEnabled === 'on' ||
      req.body.externalApiEnabled === 'yes';
    const externalApiUrl = req.body.externalApiUrl || '';
    const externalApiMethod = req.body.externalApiMethod || 'GET';
    const externalApiHeaders = req.body.externalApiHeaders || '{}';
    const externalApiBody = req.body.externalApiBody || '{}';
    const externalApiTimeout = req.body.externalApiTimeout || '5000';
    const externalApiTransform = req.body.externalApiTransform || '';

    if (
      (effectivePaperlessUrl &&
        effectivePaperlessUrl !== normalizedCurrentPaperlessUrl) ||
      hasPaperlessTokenInput
    ) {
      const isPaperlessValid = await setupService.validatePaperlessConfig(
        effectivePaperlessUrl,
        effectivePaperlessToken
      );
      if (!isPaperlessValid) {
        return res.status(400).json({
          error: 'Paperless-ngx connection failed. Please check URL and Token.',
        });
      }
    }

    const updatedConfig = {};

    if (hasPaperlessUrlInput)
      updatedConfig.PAPERLESS_API_URL = effectivePaperlessUrl;
    if (typeof paperlessPublicUrl === 'string')
      updatedConfig.PAPERLESS_PUBLIC_URL = paperlessPublicUrl.trim();
    if (hasPaperlessTokenInput)
      updatedConfig.PAPERLESS_API_TOKEN = effectivePaperlessToken;
    if (paperlessUsername) updatedConfig.PAPERLESS_USERNAME = paperlessUsername;

    // Handle AI provider configuration. Saving deliberately runs no live AI
    // connection tests — only required-field checks. Use the explicit test
    // buttons/endpoints to verify connectivity on demand.
    if (aiProvider) {
      const selectedAiProvider = String(aiProvider).trim().toLowerCase();

      updatedConfig.AI_PROVIDER = selectedAiProvider;

      if (selectedAiProvider === 'openai') {
        if (!effectiveOpenAiKey) {
          return res.status(400).json({
            error:
              'OpenAI API key is required when OpenAI provider is selected.',
          });
        }

        if (hasOpenAiKeyInput) {
          updatedConfig.OPENAI_API_KEY = effectiveOpenAiKey;
        }
        if (openaiModel) updatedConfig.OPENAI_MODEL = openaiModel;
      } else if (selectedAiProvider === 'ollama') {
        const effectiveOllamaUrl = ollamaUrl || currentConfig.OLLAMA_API_URL;
        const effectiveOllamaModel = ollamaModel || currentConfig.OLLAMA_MODEL;

        if (!effectiveOllamaUrl || !effectiveOllamaModel) {
          return res.status(400).json({
            error:
              'Ollama URL and model are required when Ollama provider is selected.',
          });
        }

        if (ollamaUrl) updatedConfig.OLLAMA_API_URL = ollamaUrl;
        if (hasOllamaApiKeyInput)
          updatedConfig.OLLAMA_API_KEY = effectiveOllamaApiKey;
        if (ollamaModel) updatedConfig.OLLAMA_MODEL = ollamaModel;
      } else if (selectedAiProvider === 'custom') {
        const effectiveCustomBaseUrl =
          customBaseUrl || currentConfig.CUSTOM_BASE_URL;
        const effectiveCustomModel = customModel || currentConfig.CUSTOM_MODEL;

        if (!effectiveCustomBaseUrl || !effectiveCustomModel) {
          return res.status(400).json({
            error:
              'Custom provider URL and model are required when custom provider is selected.',
          });
        }

        if (hasCustomApiKeyInput)
          updatedConfig.CUSTOM_API_KEY = effectiveCustomApiKey;
        if (customBaseUrl) updatedConfig.CUSTOM_BASE_URL = customBaseUrl;
        if (customModel) updatedConfig.CUSTOM_MODEL = customModel;
      } else if (selectedAiProvider === 'azure') {
        const effectiveAzureEndpoint =
          azureEndpoint || currentConfig.AZURE_ENDPOINT;
        const effectiveAzureDeployment =
          azureDeploymentName || currentConfig.AZURE_DEPLOYMENT_NAME;

        if (
          !effectiveAzureEndpoint ||
          !effectiveAzureApiKey ||
          !effectiveAzureDeployment
        ) {
          return res.status(400).json({
            error:
              'Azure endpoint, API key and deployment name are required when Azure provider is selected.',
          });
        }

        if (azureEndpoint) updatedConfig.AZURE_ENDPOINT = azureEndpoint;
        if (hasAzureApiKeyInput)
          updatedConfig.AZURE_API_KEY = effectiveAzureApiKey;
        if (azureDeploymentName)
          updatedConfig.AZURE_DEPLOYMENT_NAME = azureDeploymentName;
        if (azureApiVersion) updatedConfig.AZURE_API_VERSION = azureApiVersion;
      }
    }

    // Update general settings
    if (scanInterval) updatedConfig.SCAN_INTERVAL = scanInterval;
    if (typeof reconciliationEnabled === 'string') {
      const normalizedReconciliationEnabled = reconciliationEnabled
        .trim()
        .toLowerCase();
      if (['yes', 'no'].includes(normalizedReconciliationEnabled)) {
        updatedConfig.RECONCILIATION_ENABLED = normalizedReconciliationEnabled;
      }
    }
    if (
      typeof reconciliationInterval === 'string' &&
      reconciliationInterval.trim()
    ) {
      updatedConfig.RECONCILIATION_INTERVAL = reconciliationInterval.trim();
    }
    if (systemPrompt)
      updatedConfig.SYSTEM_PROMPT = processedPrompt
        .replace(/\r\n/g, '\n')
        .replace(/\n/g, '\\n');
    if (showTags) updatedConfig.PROCESS_PREDEFINED_DOCUMENTS = showTags;
    if (tokenLimit) {
      // Same reason as Response Tokens below: an unparsable value used to be
      // stored verbatim and reached the AI services as NaN, which truncated
      // every document to an empty prompt instead of failing.
      // Stricter than Number.parseInt() on purpose - the value that motivated
      // this check is "128k", and parseInt() would happily read that as 128
      // and cap every prompt at 128 tokens.
      const normalizedTokenLimit = String(tokenLimit).trim();
      if (
        !/^\d+$/.test(normalizedTokenLimit) ||
        Number(normalizedTokenLimit) < 1
      ) {
        return res.status(400).json({
          error: 'Invalid Token Limit. Expected a positive whole number.',
        });
      }
      updatedConfig.TOKEN_LIMIT = String(Number(normalizedTokenLimit));
    }
    if (responseTokens) {
      // Validated here rather than left to the loader's fallback: the value is
      // a generation limit now, and an operator who mistypes it should be told
      // so while the form is still on screen.
      const parsedResponseTokens = Number.parseInt(
        String(responseTokens).trim(),
        10
      );
      if (!Number.isFinite(parsedResponseTokens) || parsedResponseTokens < 1) {
        return res.status(400).json({
          error: 'Invalid Response Tokens. Expected a positive whole number.',
        });
      }
      updatedConfig.RESPONSE_TOKENS = String(parsedResponseTokens);
    }
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
    if (ignoreTags !== undefined)
      updatedConfig.IGNORE_TAGS = normalizeArray(ignoreTags);
    if (aiProcessedTag) updatedConfig.ADD_AI_PROCESSED_TAG = aiProcessedTag;
    if (aiTagName) updatedConfig.AI_PROCESSED_TAG_NAME = aiTagName;
    if (usePromptTags) updatedConfig.USE_PROMPT_TAGS = usePromptTags;
    if (promptTags) updatedConfig.PROMPT_TAGS = normalizeArray(promptTags);
    if (useExistingData) updatedConfig.USE_EXISTING_DATA = useExistingData;
    if (disableAutomaticProcessing)
      updatedConfig.DISABLE_AUTOMATIC_PROCESSING = disableAutomaticProcessing;

    // Update custom fields
    if (processedCustomFields.length > 0 || customFields) {
      updatedConfig.CUSTOM_FIELDS = JSON.stringify({
        custom_fields: processedCustomFields,
      });
    }

    // Handle limit functions
    updatedConfig.ACTIVATE_TAGGING = activateTagging ? 'yes' : 'no';
    updatedConfig.ACTIVATE_CORRESPONDENTS = activateCorrespondents
      ? 'yes'
      : 'no';
    updatedConfig.ACTIVATE_DOCUMENT_TYPE = activateDocumentType ? 'yes' : 'no';
    updatedConfig.ACTIVATE_TITLE = activateTitle ? 'yes' : 'no';
    updatedConfig.ACTIVATE_CUSTOM_FIELDS = activateCustomFields ? 'yes' : 'no';

    // Handle tag and correspondent restrictions
    updatedConfig.RESTRICT_TO_EXISTING_TAGS = restrictToExistingTags
      ? 'yes'
      : 'no';
    updatedConfig.RESTRICT_TO_EXISTING_CORRESPONDENTS =
      restrictToExistingCorrespondents ? 'yes' : 'no';
    updatedConfig.RESTRICT_TO_EXISTING_DOCUMENT_TYPES =
      restrictToExistingDocumentTypes ? 'yes' : 'no';

    // Handle external API integration
    updatedConfig.EXTERNAL_API_ENABLED = externalApiEnabled ? 'yes' : 'no';
    updatedConfig.EXTERNAL_API_URL = externalApiUrl || '';
    updatedConfig.EXTERNAL_API_METHOD = externalApiMethod || 'GET';
    updatedConfig.EXTERNAL_API_HEADERS = externalApiHeaders || '{}';
    updatedConfig.EXTERNAL_API_BODY = externalApiBody || '{}';
    updatedConfig.EXTERNAL_API_TIMEOUT = externalApiTimeout || '5000';
    updatedConfig.EXTERNAL_API_TRANSFORM = externalApiTransform || '';
    updatedConfig.EXTERNAL_API_ALLOW_PRIVATE_IPS =
      externalApiAllowPrivateIps || 'no';

    if (mistralOcrEnabled)
      updatedConfig.MISTRAL_OCR_ENABLED = mistralOcrEnabled;
    if (ocrProvider)
      updatedConfig.OCR_PROVIDER = String(ocrProvider).trim().toLowerCase();
    if (normalizedOcrProvider === 'mistral') {
      updatedConfig.OCR_API_URL = '';
    } else if (typeof ocrApiUrl === 'string') {
      updatedConfig.OCR_API_URL = ocrApiUrl.trim();
    }
    if (hasOcrApiKeyInput) {
      updatedConfig.OCR_API_KEY = effectiveOcrApiKey;
      updatedConfig.MISTRAL_API_KEY = effectiveOcrApiKey;
    }
    if (mistralOcrModel) updatedConfig.MISTRAL_OCR_MODEL = mistralOcrModel;
    if (typeof ocrPdfRenderEnabled === 'string') {
      const normalizedPdfRenderEnabled = ocrPdfRenderEnabled
        .trim()
        .toLowerCase();
      if (['yes', 'no'].includes(normalizedPdfRenderEnabled)) {
        updatedConfig.OCR_PDF_RENDER_ENABLED = normalizedPdfRenderEnabled;
      }
    }
    if (ocrPdfRenderMaxPages !== undefined) {
      const pdfRenderMaxPages = parseInt(ocrPdfRenderMaxPages, 10);
      if (
        !isNaN(pdfRenderMaxPages) &&
        pdfRenderMaxPages >= 1 &&
        pdfRenderMaxPages <= 50
      ) {
        updatedConfig.OCR_PDF_RENDER_MAX_PAGES = pdfRenderMaxPages.toString();
      } else {
        console.warn(
          `[WARN] Invalid OCR_PDF_RENDER_MAX_PAGES value: ${ocrPdfRenderMaxPages}. Using default: 10`
        );
        updatedConfig.OCR_PDF_RENDER_MAX_PAGES = '10';
      }
    }
    if (ocrPdfRenderDpi !== undefined) {
      const pdfRenderDpi = parseInt(ocrPdfRenderDpi, 10);
      if (!isNaN(pdfRenderDpi) && pdfRenderDpi >= 72 && pdfRenderDpi <= 300) {
        updatedConfig.OCR_PDF_RENDER_DPI = pdfRenderDpi.toString();
      } else {
        console.warn(
          `[WARN] Invalid OCR_PDF_RENDER_DPI value: ${ocrPdfRenderDpi}. Using default: 150`
        );
        updatedConfig.OCR_PDF_RENDER_DPI = '150';
      }
    }
    if (typeof ocrAutoProcessEnabled === 'string') {
      const normalizedAutoProcessEnabled = ocrAutoProcessEnabled
        .trim()
        .toLowerCase();
      if (['yes', 'no'].includes(normalizedAutoProcessEnabled)) {
        updatedConfig.OCR_AUTO_PROCESS_ENABLED = normalizedAutoProcessEnabled;
      }
    }
    if (typeof ocrAutoAnalyze === 'string') {
      const normalizedAutoAnalyze = ocrAutoAnalyze.trim().toLowerCase();
      if (['yes', 'no'].includes(normalizedAutoAnalyze)) {
        updatedConfig.OCR_AUTO_ANALYZE = normalizedAutoAnalyze;
      }
    }
    if (
      typeof ocrAutoProcessInterval === 'string' &&
      ocrAutoProcessInterval.trim()
    ) {
      // An invalid cron pattern makes cron.schedule() throw during startup,
      // so it is rejected here instead of taking the app down on restart.
      const normalizedAutoProcessInterval = ocrAutoProcessInterval.trim();
      if (!cron.validate(normalizedAutoProcessInterval)) {
        return res.status(400).json({
          error:
            'Invalid OCR Processing Interval. Use cron syntax, for example */15 * * * *.',
        });
      }
      updatedConfig.OCR_AUTO_PROCESS_INTERVAL = normalizedAutoProcessInterval;
    }
    if (ocrAutoProcessBatchSize !== undefined) {
      const autoProcessBatchSize = parseInt(ocrAutoProcessBatchSize, 10);
      if (
        !isNaN(autoProcessBatchSize) &&
        autoProcessBatchSize >= 1 &&
        autoProcessBatchSize <= 100
      ) {
        updatedConfig.OCR_AUTO_PROCESS_BATCH_SIZE =
          autoProcessBatchSize.toString();
      } else {
        console.warn(
          `[WARN] Invalid OCR_AUTO_PROCESS_BATCH_SIZE value: ${ocrAutoProcessBatchSize}. Using default: 10`
        );
        updatedConfig.OCR_AUTO_PROCESS_BATCH_SIZE = '10';
      }
    }
    updatedConfig.SETUP_OCR_VALIDATION_TIMEOUT_MS = String(
      effectiveOcrValidationTimeoutMs
    );
    if (globalRateLimitWindowMs)
      updatedConfig.GLOBAL_RATE_LIMIT_WINDOW_MS = globalRateLimitWindowMs;
    if (globalRateLimitMax)
      updatedConfig.GLOBAL_RATE_LIMIT_MAX = globalRateLimitMax;
    if (typeof trustProxy === 'string')
      updatedConfig.TRUST_PROXY = trustProxy.trim();
    if (typeof cookieSecureMode === 'string') {
      const normalizedCookieSecureMode = cookieSecureMode.trim().toLowerCase();
      if (['auto', 'always', 'never'].includes(normalizedCookieSecureMode)) {
        updatedConfig.COOKIE_SECURE_MODE = normalizedCookieSecureMode;
      } else {
        return res.status(400).json({
          error:
            'Invalid Cookie Secure Mode. Allowed values: auto, always, never.',
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
          error: 'Invalid Log Level. Allowed values: debug, info, warn, error.',
        });
      }
    }
    if (typeof dateFormat === 'string') {
      // Upper-cased before the comparison because the value doubles as the
      // pattern it describes — an operator typing dd.mm.yyyy into the .env file
      // means the same thing the select does.
      const normalizedDateFormat = dateFormat.trim().toUpperCase();
      if (['DD.MM.YYYY', 'YYYY-MM-DD'].includes(normalizedDateFormat)) {
        updatedConfig.DATE_FORMAT = normalizedDateFormat;
      } else {
        return res.status(400).json({
          error: 'Invalid Date Format. Allowed values: DD.MM.YYYY, YYYY-MM-DD.',
        });
      }
    }

    // Update tag cache TTL (validate range: 60-3600 seconds)
    if (tagCacheTTL !== undefined) {
      const ttl = parseInt(tagCacheTTL, 10);
      if (!isNaN(ttl) && ttl >= 60 && ttl <= 3600) {
        updatedConfig.TAG_CACHE_TTL_SECONDS = ttl.toString();
      } else {
        console.warn(
          `[WARN] Invalid TAG_CACHE_TTL_SECONDS value: ${tagCacheTTL}. Using default: 300`
        );
        updatedConfig.TAG_CACHE_TTL_SECONDS = '300';
      }
    }

    // Handle API key
    let apiToken = configFile.getApiKey
      ? configFile.getApiKey()
      : process.env.API_KEY || process.env.PAPERLESS_AI_API_KEY || '';
    if (!apiToken) {
      console.log('Generating new API key');
      apiToken = require('crypto').randomBytes(64).toString('hex');
      updatedConfig.API_KEY = apiToken;
    }

    const mergedConfig = {
      ...currentConfig,
      ...updatedConfig,
    };

    // The route has already validated the submitted values (and Paperless
    // reachability when its settings changed). Skip saveConfig's built-in
    // validateConfig so saving does not live-test Paperless/AI on every save.
    await setupService.saveConfig(mergedConfig, { skipValidation: true });
    try {
      for (const field of processedCustomFields) {
        await paperlessService.createCustomFieldSafely(
          field.value,
          field.data_type,
          field.currency
        );
      }
    } catch (error) {
      console.log('[ERROR] Error creating custom fields:', error);
    }

    res.json({
      success: true,
      message: 'Configuration saved successfully.',
      restart: true,
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
      error: 'An error occurred: ' + error.message,
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
 *                 scanner:
 *                   $ref: '#/components/schemas/ScannerHealth'
 *                 paperless:
 *                   $ref: '#/components/schemas/PaperlessHealth'
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
      stopRequested: Boolean(scanState.stopRequested),
      ...buildScannerHealthSnapshot(),
    });
  } catch {
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
      return res
        .status(500)
        .json({ error: 'Paperless public URL is not configured' });
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
      ocrEnabled: configFile.mistralOcr?.enabled === 'yes',
      // Same reading as ocrAutoProcessService.autoAnalyze, so the checkbox
      // starts where OCR_AUTO_ANALYZE stands and the button does what the
      // scheduled drain does. It used to start unchecked regardless, which
      // made the same queue behave differently depending on who ran it.
      ocrAutoAnalyze: configFile.mistralOcr?.autoAnalyze !== 'no',
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

// Page: Ignored Documents Queue
router.get('/ignored', protectApiRoute, async (req, res) => {
  try {
    return res.render('ignored', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
    });
  } catch (error) {
    console.error('[ERROR] Ignored page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /ignored:
 *   get:
 *     summary: Permanently ignored documents page
 *     tags:
 *       - Navigation
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Ignored queue page rendered successfully
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
      restrictToExistingCorrespondents:
        configFile.restrictToExistingCorrespondents || 'no',
      restrictToExistingDocumentTypes:
        configFile.restrictToExistingDocumentTypes || 'no',
      paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
      openAiKeySet: Boolean(configFile.openai?.apiKey),
      customKeySet: Boolean(configFile.custom?.apiKey),
      azureKeySet: Boolean(configFile.azure?.apiKey),
      mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
      apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey()),
    };

    return res.render('about', {
      version: configFile.PAPERLESS_AI_VERSION || ' ',
      supportInfo,
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
        aiProvider:
          configFile.aiProvider || process.env.AI_PROVIDER || 'openai',
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
        restrictToExistingCorrespondents:
          configFile.restrictToExistingCorrespondents || 'no',
        restrictToExistingDocumentTypes:
          configFile.restrictToExistingDocumentTypes || 'no',
        paperlessTokenSet: Boolean(configFile.paperless?.apiToken),
        openAiKeySet: Boolean(configFile.openai?.apiKey),
        customKeySet: Boolean(configFile.custom?.apiKey),
        azureKeySet: Boolean(configFile.azure?.apiKey),
        mistralKeySet: Boolean(configFile.mistralOcr?.apiKey),
        apiKeySet: Boolean(configFile.getApiKey && configFile.getApiKey()),
      },
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
      offset: start,
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl,
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

/**
 * @swagger
 * /api/ocr/queue/ids:
 *   get:
 *     summary: Get document IDs currently waiting in the OCR queue
 *     description: >-
 *       Returns the Paperless-ngx document IDs with status pending or processing.
 *       Used by the OCR view to hide already queued documents from search results.
 *     tags:
 *       - OCR
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Queued document IDs returned successfully
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
 *                     ids:
 *                       type: array
 *                       items:
 *                         type: integer
 *       500:
 *         description: Server error
 */

// API: Get all document IDs currently in the OCR queue
router.get('/api/ocr/queue/ids', isAuthenticated, async (req, res) => {
  try {
    const ids = await documentModel.getOcrQueueDocumentIds();
    return res.json({ success: true, data: { ids } });
  } catch (error) {
    console.error('[ERROR] GET /api/ocr/queue/ids:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Add one or more documents manually to the OCR queue
router.post('/api/ocr/queue/add', isAuthenticated, async (req, res) => {
  try {
    const rawInput = req.body.documentIds ?? req.body.documentId;
    if (rawInput === undefined || rawInput === null || rawInput === '') {
      return res
        .status(400)
        .json({ success: false, error: 'documentId is required' });
    }

    const documentIds = normalizeDocumentIdList(rawInput);
    if (!documentIds.length) {
      return res.status(400).json({
        success: false,
        error: 'documentId must be a positive integer',
      });
    }

    const single = documentIds.length === 1;
    let added = 0;
    const missing = [];

    for (const docIdNum of documentIds) {
      let doc;
      try {
        doc = await paperlessService.getDocument(docIdNum);
      } catch (error) {
        if (error.response?.status === 404) {
          doc = null;
        } else {
          throw error;
        }
      }

      if (!doc || !Number.isInteger(Number(doc.id))) {
        // One document that has since been deleted in Paperless-ngx must not
        // cost the rest of the selection its place in the queue.
        if (single) {
          return res.status(404).json({
            success: false,
            error: `Document ${docIdNum} was not found in Paperless-ngx`,
          });
        }
        missing.push(docIdNum);
        continue;
      }

      const title =
        typeof doc.title === 'string' && doc.title.trim()
          ? doc.title.trim()
          : `Document ${docIdNum}`;

      if (await documentModel.addToOcrQueue(docIdNum, title, 'manual')) {
        added += 1;
      }
    }

    if (single && !added) {
      return res.json({
        success: false,
        message: 'Document already in queue or could not be added',
      });
    }

    const skipped = documentIds.length - added - missing.length;
    return res.json({
      success: true,
      added,
      skipped,
      missing,
      message: single
        ? `Document ${documentIds[0]} added to OCR queue`
        : `${added} document(s) added to the OCR queue` +
          (skipped ? `, ${skipped} already queued` : '') +
          (missing.length ? `, ${missing.length} not found` : ''),
    });
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
 *             description: One of documentId or documentIds is required.
 *             properties:
 *               documentId:
 *                 type: integer
 *                 minimum: 1
 *                 description: A single document, as the row menu sends it.
 *               documentIds:
 *                 type: array
 *                 description: |
 *                   A selection, as the bulk menu sends it. Documents that are
 *                   already queued are counted as skipped and ones missing from
 *                   Paperless-ngx are listed, rather than failing the batch.
 *                 items:
 *                   type: integer
 *                   minimum: 1
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
router.delete(
  '/api/ocr/queue/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }
      const removed = await documentModel.removeFromOcrQueue(documentId);
      return res.json({
        success: removed,
        message: removed ? 'Removed from queue' : 'Not found in queue',
      });
    } catch (error) {
      console.error('[ERROR] DELETE /api/ocr/queue/:documentId:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

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
router.post(
  '/api/ocr/process/:documentId',
  isAuthenticated,
  async (req, res) => {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const autoAnalyze =
      req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    };

    try {
      if (!mistralOcrService.isEnabled()) {
        send({
          step: 'error',
          message:
            'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.',
        });
        return res.end();
      }

      await mistralOcrService.processQueueItem(documentId, {
        autoAnalyze,
        progressCallback: (step, message, data) => {
          send({ step, message, ...data });
        },
      });
      dashboardStatsService.invalidate();
    } catch (error) {
      send({ step: 'error', message: error.message });
    }

    res.end();
  }
);

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
  const autoAnalyze =
    req.body?.autoAnalyze === true || req.body?.autoAnalyze === 'true';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    if (!mistralOcrService.isEnabled()) {
      send({
        step: 'error',
        message:
          'OCR fallback is not enabled. Set MISTRAL_OCR_ENABLED=yes in your .env file.',
      });
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
      send({
        step: 'progress',
        message: `Processing document ${item.document_id} (${item.title})…`,
        documentId: item.document_id,
        completed,
        total,
      });

      try {
        await mistralOcrService.processQueueItem(item.document_id, {
          autoAnalyze,
          progressCallback: (step, message, data) => {
            send({
              step: `item_${step}`,
              message,
              documentId: item.document_id,
              ...data,
            });
          },
        });
        completed++;
        dashboardStatsService.invalidate();
      } catch (err) {
        failed++;
        send({
          step: 'item_error',
          message: `Document ${item.document_id} failed: ${err.message}`,
          documentId: item.document_id,
        });
      }
    }

    send({
      step: 'done',
      message: `Batch complete. ${completed} succeeded, ${failed} failed.`,
      completed,
      failed,
      total,
    });
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
router.post(
  '/api/ocr/analyze/:documentId',
  isAuthenticated,
  async (req, res) => {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
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
        send({
          step: 'error',
          message: 'No OCR text available yet. Run OCR first.',
        });
        return res.end();
      }

      await mistralOcrService.analyzeFromExistingOcrText(
        documentId,
        queueItem.ocr_text,
        (step, message, data) => {
          send({ step, message, ...data });
        }
      );
    } catch (error) {
      send({ step: 'error', message: error.message });
    }

    res.end();
  }
);

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
router.get(
  '/api/ocr/queue/:documentId/text',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const queueItem = await documentModel.getOcrQueueItem(documentId);
      if (!queueItem) {
        return res
          .status(404)
          .json({ success: false, error: 'Document not found in OCR queue' });
      }

      return res.json({
        success: true,
        documentId,
        title: queueItem.title || null,
        status: queueItem.status,
        reason: queueItem.reason,
        hasOcrText: !!(queueItem.ocr_text && String(queueItem.ocr_text).trim()),
        ocrText: queueItem.ocr_text || '',
      });
    } catch (error) {
      console.error('[ERROR] GET /api/ocr/queue/:documentId/text:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

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
    const [allItems, failedDocs, ignoredCount] = await Promise.all([
      documentModel.getOcrQueue(),
      documentModel.getFailedDocumentsPaginated({ limit: 1, offset: 0 }),
      documentModel.getIgnoredCount(),
    ]);
    const stats = {
      pending: allItems.filter((i) => i.status === 'pending').length,
      processing: allItems.filter((i) => i.status === 'processing').length,
      done: allItems.filter((i) => i.status === 'done').length,
      // Counted separately rather than folded into "done": these are the items
      // Paperless-ngx refused the content for, so this queue entry is the only
      // place their OCR text exists. Items completed before the wrote_back
      // column existed carry null and stay out of this count — their outcome
      // was never recorded.
      notWrittenBack: allItems.filter(
        (i) => i.status === 'done' && i.wrote_back === 0
      ).length,
      failed: allItems.filter((i) => i.status === 'failed').length,
      permanentlyFailed: failedDocs.total || 0,
      ignored: ignoredCount,
      total: allItems.length,
      ocrEnabled: mistralOcrService.isEnabled(),
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
      offset: start,
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl,
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
router.post(
  '/api/failed/reset/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const reset = await documentModel.resetFailedDocument(documentId);
      await documentModel.clearProcessingStatusByDocumentId(documentId);

      return res.json({
        success: reset,
        message: reset
          ? `Document ${documentId} reset. It can be scanned again.`
          : `Document ${documentId} was not in failed queue.`,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/failed/reset/:documentId:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// API: Reset terminal failure state for all documents in failed queue
router.post('/api/failed/reset-all', isAuthenticated, async (req, res) => {
  try {
    const count = await documentModel.resetAllFailedDocuments();

    return res.json({
      success: true,
      count,
      message:
        count > 0
          ? `${count} failed document${count === 1 ? '' : 's'} reset. They can be scanned again.`
          : 'No failed documents to reset.',
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

// API: Get paginated ignored documents queue
router.get('/api/ignored/queue', isAuthenticated, async (req, res) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const length = parseInt(req.query.length || '25', 10);
    const search = req.query.search || '';

    const { docs, total } = await documentModel.getIgnoredDocumentsPaginated({
      search,
      limit: length,
      offset: start,
    });

    const paperlessUrl = await paperlessService.getPublicBaseUrl();

    return res.json({
      success: true,
      data: docs,
      recordsTotal: total,
      recordsFiltered: total,
      paperlessUrl,
    });
  } catch (error) {
    console.error('[ERROR] GET /api/ignored/queue:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/ignored/add:
 *   post:
 *     summary: Add one or more documents to the ignored list
 *     description: |
 *       Ignored documents are skipped by every future scan. Accepts a single
 *       id from the history row menu or a selection from its bulk menu; a
 *       document that was already ignored counts as skipped rather than an
 *       error.
 *     tags:
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: One of documentId or documentIds is required.
 *             properties:
 *               documentId:
 *                 type: integer
 *                 minimum: 1
 *               documentIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                   minimum: 1
 *               title:
 *                 type: string
 *                 description: Stored with a single document; ignored for a selection.
 *               reason:
 *                 type: string
 *                 default: manual
 *     responses:
 *       200:
 *         description: How many were added and how many were already ignored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 added:
 *                   type: integer
 *                 skipped:
 *                   type: integer
 *                 message:
 *                   type: string
 *       400:
 *         description: No usable document id in the payload
 */
// API: Add one or more documents to the ignored list
router.post('/api/ignored/add', isAuthenticated, async (req, res) => {
  try {
    const documentIds = normalizeDocumentIdList(
      req.body.documentIds ?? req.body.documentId
    );
    if (!documentIds.length) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const title = req.body.title || '';
    const reason = req.body.reason || 'manual';

    let added = 0;
    for (const documentId of documentIds) {
      // The title belongs to one document, so it only travels when one was
      // asked for; a bulk call lets the model fall back to what it knows.
      const wasAdded = await documentModel.addIgnoredDocument(
        documentId,
        documentIds.length === 1 ? title : '',
        reason
      );
      if (wasAdded) added += 1;
    }

    const skipped = documentIds.length - added;
    return res.json({
      success: true,
      added,
      skipped,
      message:
        documentIds.length === 1
          ? added
            ? `Document ${documentIds[0]} added to ignored list.`
            : `Document ${documentIds[0]} was already ignored.`
          : `${added} document(s) added to ignored list${skipped ? `, ${skipped} already ignored` : ''}.`,
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ignored/add:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Remove a document from the ignored list (unignore)
router.delete('/api/ignored/:documentId', isAuthenticated, async (req, res) => {
  try {
    const documentId = parseInt(req.params.documentId, 10);
    if (isNaN(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document ID' });
    }

    const removed = await documentModel.removeIgnoredDocument(documentId);
    return res.json({
      success: removed,
      message: removed
        ? `Document ${documentId} removed from ignored list. It can be scanned again.`
        : `Document ${documentId} was not in ignored list.`,
    });
  } catch (error) {
    console.error('[ERROR] DELETE /api/ignored/:documentId:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Clear all ignored documents
router.post('/api/ignored/clear-all', isAuthenticated, async (req, res) => {
  try {
    const count = await documentModel.clearAllIgnoredDocuments();
    return res.json({
      success: true,
      count,
      message:
        count > 0
          ? `${count} ignored document${count === 1 ? '' : 's'} removed. They can be scanned again.`
          : 'No ignored documents to remove.',
    });
  } catch (error) {
    console.error('[ERROR] POST /api/ignored/clear-all:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Move a failed document to the ignored list (atomic: add to ignored + remove from failed)
router.post(
  '/api/failed/ignore/:documentId',
  isAuthenticated,
  async (req, res) => {
    try {
      const documentId = parseInt(req.params.documentId, 10);
      if (isNaN(documentId)) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid document ID' });
      }

      const failedDocs = await documentModel.getFailedDocumentsPaginated({
        search: String(documentId),
        limit: 1,
        offset: 0,
      });
      const failedDoc = failedDocs.docs.find(
        (d) => d.document_id === documentId
      );
      const title = failedDoc?.title || '';

      await documentModel.addIgnoredDocument(
        documentId,
        title,
        'failed_document'
      );
      await documentModel.resetFailedDocument(documentId);
      await documentModel.clearProcessingStatusByDocumentId(documentId);

      return res.json({
        success: true,
        message: `Document ${documentId} moved to ignored list.`,
      });
    } catch (error) {
      console.error('[ERROR] POST /api/failed/ignore/:documentId:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * @swagger
 * /api/update-check:
 *   get:
 *     summary: Report whether a newer release is available
 *     description: |
 *       Compares the running version against the latest GitHub release tag.
 *
 *       The lookup happens on the server and its result is cached for 24 hours,
 *       so browsers never contact GitHub themselves and a busy instance makes at
 *       most one outbound request per day. Set `UPDATE_CHECK_ENABLED=no` to turn
 *       the outbound call off; the endpoint then reports `enabled: false`.
 *     tags:
 *       - System
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Update status
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
 *                     enabled:
 *                       type: boolean
 *                     currentVersion:
 *                       type: string
 *                     latestVersion:
 *                       type: string
 *                       nullable: true
 *                     updateAvailable:
 *                       type: boolean
 *                     checkedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *       401:
 *         description: Not authenticated
 */
router.get('/api/update-check', isAuthenticated, async (req, res) => {
  try {
    const status = await updateCheckService.getStatus();
    // The upstream error message is for the server log, not for the browser.
    const data = { ...status };
    delete data.error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[ERROR] GET /api/update-check:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to check for updates' });
  }
});

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
    return res
      .status(500)
      .json({ show: false, error: 'Failed to load changelog status' });
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

    await documentModel.setLastSeenChangelogVersion(
      username,
      changelog.version
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('[ERROR] POST /api/changelog/mark-seen:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to mark changelog as seen' });
  }
});

/**
 * @swagger
 * /api/settings/env-file:
 *   get:
 *     summary: Export the running configuration as a .env file
 *     description: >
 *       Returns the instance's configuration as .env lines, grouped by topic
 *       and covering only variables that are actually set. Intended for moving
 *       an instance or pinning its settings into docker-compose. The body
 *       contains API tokens and keys in clear text; JWT_SECRET is deliberately
 *       excluded, since a fresh instance generates its own.
 *     tags:
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The configuration as .env text
 *       401:
 *         description: Not authenticated
 */
router.get('/api/settings/env-file', isAuthenticated, async (req, res) => {
  try {
    const { env, count } = buildEnvExport();
    return res.json({
      success: true,
      data: { env, count, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error('[ERROR] GET /api/settings/env-file:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to build the configuration' });
  }
});

/* Dashboard storage format v1.
   ---------------------------
   The dashboard sends back the boards the user arranged:

     {
       version: 1,
       active: 'default',
       dashboards: [
         {
           slug: 'default',
           name: 'Dashboard',
           widgets: [{ id: 'task-runner', span: 12, rows: 0, hidden: false }]
         }
       ]
     }

   This blob goes straight into users.dashboard_layout, so the validator below
   is the only thing between a hostile payload and the database. It rejects
   whole configurations rather than repairing them: a payload it cannot vouch
   for is a bug or an attack, and storing the salvageable half of either is
   worse than a 400.

   Widget and dashboard ids are deliberately not checked against a list. The
   dashboard adds and renames cards, and a stale server-side list would silently
   drop a card's placement; the shape, the spans and the counts are what has to
   be trustworthy. Anything the browser no longer knows is ignored when the
   layout is applied.

   Two conventions run through the whole format:

   - Absent means "use the defaults". No stored config, an empty dashboards
     list, and a dashboard without widgets all say the same thing: render the
     cards the way the server shipped them, in registry order.
   - active is a pointer, not data. A slug that no longer resolves — a deleted
     board, a stale client — falls back to the first dashboard instead of
     failing the write. The arrangement is the valuable part, and landing on
     board one beats losing it to a 400 over a name. */
const DASHBOARD_WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DASHBOARD_MAX_WIDGETS = 50;
const DASHBOARD_MIN_SPAN = 3;
const DASHBOARD_GRID_COLUMNS = 12;
const DASHBOARD_MIN_ROWS = 3;
const DASHBOARD_MAX_ROWS = 24;
const DASHBOARD_CONFIG_VERSION = 1;
const DASHBOARD_MAX_BOARDS = 10;
const DASHBOARD_MAX_NAME_LENGTH = 60;
const DASHBOARD_DEFAULT_SLUG = 'default';

/* Nothing stored: a valid v1 config that asks for the defaults. */
function emptyDashboardConfig() {
  return {
    version: DASHBOARD_CONFIG_VERSION,
    active: DASHBOARD_DEFAULT_SLUG,
    dashboards: [],
  };
}

/* One board's cards, cleaned. Returns null — not a partial list — as soon as
   anything is off, so a single bad card takes the whole write down with it. */
function normalizeDashboardWidgets(input) {
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.length > DASHBOARD_MAX_WIDGETS) {
    return null;
  }

  const seen = new Set();
  const widgets = [];
  for (const entry of input) {
    const id = String(entry?.id || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);

    // span and rows are parsed rather than compared: they are read off DOM
    // datasets in the browser, where everything is a string.
    const span = Number.parseInt(entry?.span, 10);
    if (
      !Number.isInteger(span) ||
      span < DASHBOARD_MIN_SPAN ||
      span > DASHBOARD_GRID_COLUMNS
    ) {
      return null;
    }

    // Tile rows. 0 means "as tall as the content needs", which is the default
    // and the only value outside the 3..24 range a card may carry.
    const rows = Number.parseInt(entry?.rows, 10) || 0;
    if (
      rows !== 0 &&
      (rows < DASHBOARD_MIN_ROWS || rows > DASHBOARD_MAX_ROWS)
    ) {
      return null;
    }

    // hidden is a toggle, not data: absent, null or anything falsy means the
    // card is shown. Nothing to reject here, so nothing does.
    widgets.push({ id, span, rows, hidden: Boolean(entry?.hidden) });
  }

  return widgets;
}

/* "Give me the defaults back" arrives in two shapes: no boards at all, or the
   single board the reset button empties. Both clear the stored config. More
   than one board is left alone — an empty board among several is a named view
   that happens to show the default cards, and dropping its name would be the
   opposite of what the user asked for. */
function isDashboardResetRequest(input) {
  if (!input || !Array.isArray(input.dashboards)) {
    return false;
  }
  if (input.dashboards.length === 0) {
    return true;
  }
  return (
    input.dashboards.length === 1 &&
    Array.isArray(input.dashboards[0]?.widgets) &&
    input.dashboards[0].widgets.length === 0
  );
}

function normalizeDashboardConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  // Strict: version is written by our own code, never typed into a form, so a
  // string '1' is a bug worth surfacing rather than a value worth coercing.
  if (input.version !== DASHBOARD_CONFIG_VERSION) {
    return null;
  }
  if (!Array.isArray(input.dashboards)) {
    return null;
  }
  if (
    input.dashboards.length < 1 ||
    input.dashboards.length > DASHBOARD_MAX_BOARDS
  ) {
    return null;
  }

  const slugs = new Set();
  const dashboards = [];
  for (const entry of input.dashboards) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    // Slugs are ids, so they answer to the widget-id rules: lowercase, no
    // markup, short enough to live in a URL.
    const slug = String(entry.slug || '').trim();
    if (!DASHBOARD_WIDGET_ID.test(slug) || slugs.has(slug)) {
      return null;
    }
    slugs.add(slug);

    // The name is what the user typed, so it is trimmed first and then has to
    // still say something. It is escaped where it is rendered, not here.
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name.length < 1 || name.length > DASHBOARD_MAX_NAME_LENGTH) {
      return null;
    }

    // A board without widgets is the default arrangement under a name, so a
    // missing list is the same as an empty one. A non-array is not.
    const widgets = normalizeDashboardWidgets(
      entry.widgets === undefined || entry.widgets === null ? [] : entry.widgets
    );
    if (!widgets) {
      return null;
    }

    dashboards.push({ slug, name, widgets });
  }

  const requested = String(input.active || '').trim();
  const active = slugs.has(requested) ? requested : dashboards[0].slug;

  return { version: DASHBOARD_CONFIG_VERSION, active, dashboards };
}

/**
 * @swagger
 * /api/dashboard/layout:
 *   get:
 *     summary: Read the authenticated user's dashboard configuration
 *     description: >
 *       Returns the stored configuration in storage format v1: the named
 *       dashboards the user arranged, each with its widgets in display order,
 *       and the slug of the active one. An empty dashboards list means nothing
 *       has been customised and every board renders in its default order — the
 *       same answer a user without a stored configuration gets.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: The stored configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     version:
 *                       type: integer
 *                       example: 1
 *                     active:
 *                       type: string
 *                       description: Slug of the dashboard currently shown
 *                       example: "default"
 *                     dashboards:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           slug:
 *                             type: string
 *                             example: "default"
 *                           name:
 *                             type: string
 *                             example: "Dashboard"
 *                           widgets:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                   example: "task-runner"
 *                                 span:
 *                                   type: integer
 *                                   description: Width in grid columns, 3 to 12
 *                                   example: 12
 *                                 rows:
 *                                   type: integer
 *                                   description: Height in tile rows, 3 to 24, or 0 for as tall as the content
 *                                   example: 0
 *                                 hidden:
 *                                   type: boolean
 *                                   example: false
 *       401:
 *         description: Not authenticated
 */
router.get('/api/dashboard/layout', isAuthenticated, async (req, res) => {
  try {
    const username = req.user && req.user.username;
    if (!username) {
      return res.json({ success: true, data: emptyDashboardConfig() });
    }

    const stored = await documentModel.getDashboardLayout(username);
    // What was stored was validated on the way in, so it is handed back as it
    // is. Only the shape is checked: this is an unreleased feature, and a blob
    // in an older shape is a development leftover that should quietly fall back
    // to the defaults rather than reach the browser.
    const dashboardConfig =
      stored &&
      stored.version === DASHBOARD_CONFIG_VERSION &&
      Array.isArray(stored.dashboards)
        ? stored
        : emptyDashboardConfig();

    return res.json({ success: true, data: dashboardConfig });
  } catch (error) {
    console.error('[ERROR] GET /api/dashboard/layout:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to load dashboard layout' });
  }
});

/**
 * @swagger
 * /api/dashboard/layout:
 *   put:
 *     summary: Store or reset the authenticated user's dashboard configuration
 *     description: >
 *       Takes a complete configuration in storage format v1 and replaces the
 *       stored one; there is no partial update. Up to 10 dashboards, each with
 *       a slug, a name of 1 to 60 characters and up to 50 widgets in display
 *       order. Widget spans are 3 to 12 grid columns; rows are 3 to 24 tile
 *       rows, or 0 for a card that is as tall as its content. A dashboard
 *       without widgets shows the default arrangement under its own name.
 *
 *       Two payloads reset instead of storing: an empty dashboards array, and a
 *       single dashboard whose widgets array is empty. Both clear the stored
 *       configuration, so every board returns to its default order. Emptying
 *       one board out of several does not reset — that board simply shows the
 *       defaults and keeps its name.
 *
 *       If active names a dashboard that is not in the payload it is replaced
 *       with the first dashboard's slug rather than rejecting the write.
 *     tags:
 *       - Dashboard
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: integer
 *                 enum: [1]
 *                 example: 1
 *               active:
 *                 type: string
 *                 description: Slug of the dashboard to show
 *                 example: "default"
 *               dashboards:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required:
 *                     - slug
 *                     - name
 *                   properties:
 *                     slug:
 *                       type: string
 *                       pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                       example: "default"
 *                     name:
 *                       type: string
 *                       minLength: 1
 *                       maxLength: 60
 *                       example: "Dashboard"
 *                     widgets:
 *                       type: array
 *                       maxItems: 50
 *                       items:
 *                         type: object
 *                         required:
 *                           - id
 *                           - span
 *                         properties:
 *                           id:
 *                             type: string
 *                             pattern: "^[a-z0-9][a-z0-9-]{0,39}$"
 *                             example: "task-runner"
 *                           span:
 *                             type: integer
 *                             minimum: 3
 *                             maximum: 12
 *                             example: 12
 *                           rows:
 *                             type: integer
 *                             description: 3 to 24 tile rows, or 0 for as tall as the content
 *                             example: 0
 *                           hidden:
 *                             type: boolean
 *                             default: false
 *     responses:
 *       200:
 *         description: Configuration stored or reset
 *       400:
 *         description: Malformed configuration
 *       401:
 *         description: Not authenticated
 */
router.put(
  '/api/dashboard/layout',
  isAuthenticated,
  express.json(),
  async (req, res) => {
    try {
      const username = req.user && req.user.username;
      if (!username) {
        return res.json({ success: true, message: 'No user to store against' });
      }

      // Nothing arranged is not stored as "an empty arrangement": the row is
      // cleared, so the dashboard falls back to the registry order.
      if (isDashboardResetRequest(req.body)) {
        await documentModel.setDashboardLayout(username, null);
        return res.json({
          success: true,
          data: emptyDashboardConfig(),
          message: 'Dashboard layout reset',
        });
      }

      const dashboardConfig = normalizeDashboardConfig(req.body);
      if (!dashboardConfig) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid dashboard layout' });
      }

      await documentModel.setDashboardLayout(username, dashboardConfig);
      return res.json({
        success: true,
        data: dashboardConfig,
        message: 'Dashboard layout saved',
      });
    } catch (error) {
      console.error('[ERROR] PUT /api/dashboard/layout:', error);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to save dashboard layout' });
    }
  }
);

module.exports = router;
