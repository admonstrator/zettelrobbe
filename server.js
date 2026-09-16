const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const documentModel = require('./models/document');
const setupService = require('./services/setupService');
const { runStartupMigrations } = require('./services/startupMigrations');
const setupRoutes = require('./routes/setup');
const { isAuthenticated } = require('./routes/auth');
const mistralOcrService = require('./services/mistralOcrService');
const ocrAutoProcessService = require('./services/ocrAutoProcessService');
const reconciliationService = require('./services/reconciliationService');
const scanHealthService = require('./services/scanHealthService');
const dashboardStatsService = require('./services/dashboardStatsService');
const { RUN_STATUS } = scanHealthService;
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Logger = require('./services/loggerService');
const {
  validateCustomFieldValue,
  shouldQueueForOcrOnAiError,
  classifyOcrQueueReasonFromAiError,
  isTimeoutError,
  buildTimeoutErrorMessage,
} = require('./services/serviceUtils');
const dataDir = path.join(process.cwd(), 'data');
const openApiDir = path.join(dataDir, 'OPENAPI');
const openApiPath = path.join(openApiDir, 'openapi.json');
const dataLogsDir = path.join(process.cwd(), 'data', 'logs');

const htmlLogger = new Logger({
  logFile: 'logs.html',
  logDir: dataLogsDir,
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10,
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  logDir: dataLogsDir,
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10,
});

const app = express();
// Express 5 changed the default query parser to "simple", which does not parse
// nested bracket parameters (e.g. order[0][column], columns[1][data]) sent by
// DataTables server-side processing. Restore the Express 4 "extended" (qs)
// parser so req.query.order/columns are objects again and table sorting works.
app.set('query parser', 'extended');
const scanControl = global.__paperlessAiScanControl || {
  running: false,
  stopRequested: false,
  source: null,
  startedAt: null,
  stopRequestedAt: null,
};
global.__paperlessAiScanControl = scanControl;

function requestScanStop() {
  if (!scanControl.running) {
    return false;
  }

  scanControl.stopRequested = true;
  scanControl.stopRequestedAt = new Date().toISOString();
  return true;
}

async function triggerScanNow(source = 'manual') {
  if (scanControl.running) {
    return {
      started: false,
      running: true,
      stopRequested: scanControl.stopRequested,
      message: 'Scan is already running.',
    };
  }

  // The OCR drain works on the same documents through the same AI backend.
  // Letting a scan start next to it is what bought a second paid OCR run for a
  // document the drain had just finished (issue #322).
  if (ocrAutoProcessService.running) {
    return {
      started: false,
      running: false,
      message: 'OCR auto-processing is currently running.',
    };
  }

  scanDocuments(source).catch((error) => {
    console.error(
      `[ERROR] scanDocuments() failed in triggerScanNow: ${error.message}`
    );
    console.debug(error);
  });

  return {
    started: true,
    running: true,
    stopRequested: false,
    message: 'Scan started.',
  };
}

global.__paperlessAiTriggerScanNow = triggerScanNow;
global.__paperlessAiRequestScanStop = requestScanStop;

function persistJwtSecret(secret) {
  const runtimeDataDir = path.join(process.cwd(), 'data');
  const envFilePath = path.join(runtimeDataDir, '.env');
  const runtimeOverridesPath = path.join(
    runtimeDataDir,
    'runtime-overrides.json'
  );

  try {
    fsSync.mkdirSync(runtimeDataDir, { recursive: true });

    let envContent = '';
    if (fsSync.existsSync(envFilePath)) {
      envContent = fsSync.readFileSync(envFilePath, 'utf8');
    }

    const hasJwtSecretLine = /^\s*JWT_SECRET\s*=.*$/m.test(envContent);
    let updatedEnvContent = envContent;

    if (hasJwtSecretLine) {
      updatedEnvContent = envContent.replace(
        /^\s*JWT_SECRET\s*=.*$/m,
        `JWT_SECRET=${secret}`
      );
    } else {
      const trimmed = envContent.trimEnd();
      updatedEnvContent = trimmed
        ? `${trimmed}\nJWT_SECRET=${secret}\n`
        : `JWT_SECRET=${secret}\n`;
    }

    fsSync.writeFileSync(envFilePath, updatedEnvContent, 'utf8');
  } catch (error) {
    console.warn(
      '[WARN] Could not persist generated JWT_SECRET to data/.env:',
      error.message
    );
  }

  try {
    if (!fsSync.existsSync(runtimeOverridesPath)) {
      return;
    }

    const raw = fsSync.readFileSync(runtimeOverridesPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};

    if (!parsed.JWT_SECRET || String(parsed.JWT_SECRET).trim() === '') {
      parsed.JWT_SECRET = secret;
      fsSync.writeFileSync(
        runtimeOverridesPath,
        JSON.stringify(parsed, null, 2),
        'utf8'
      );
    }
  } catch (error) {
    console.warn(
      '[WARN] Could not update JWT_SECRET in runtime-overrides.json:',
      error.message
    );
  }
}

function ensureJwtSecret() {
  const existingSecret = config.getJwtSecret();
  if (existingSecret) {
    return existingSecret;
  }

  const generatedSecret = crypto.randomBytes(64).toString('hex');
  process.env.JWT_SECRET = generatedSecret;
  persistJwtSecret(generatedSecret);

  console.warn(
    '[WARN] JWT_SECRET was missing. Generated and persisted a new secret. Existing sessions may require re-login.'
  );
  return generatedSecret;
}

const JWT_SECRET = ensureJwtSecret();

if (!JWT_SECRET) {
  console.error(
    'JWT_SECRET environment variable is not set. Refusing to start without a secure JWT secret.'
  );
  process.exit(1);
}

const trustProxy = config.getTrustProxy();
if (trustProxy !== false) {
  app.set('trust proxy', trustProxy);
}

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

  if (req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return Boolean(req.secure || forwardedProto === 'https');
  }

  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProto === 'https');
}

const csrfCookieSecure = shouldUseSecureCookies();

// Retry tracking to prevent infinite retry loops
const retryTracker = new Map();

// Configurable minimum content length (default: 10 characters)
const MIN_CONTENT_LENGTH = config.minContentLength;

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'Access-Control-Allow-Private-Network',
  ],
  credentials: false,
};

const apiGlobalLimiter = rateLimit({
  windowMs: config.globalRateLimitWindowMs,
  max: config.globalRateLimitMax,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'];
    const currentApiKey = config.getApiKey();
    if (currentApiKey && apiKey && apiKey === currentApiKey) {
      return `api-key:${apiKey}`;
    }

    const token = req.cookies?.jwt || req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userIdentifier =
          decoded?.id || decoded?.userId || decoded?.username || decoded?.sub;
        if (userIdentifier) {
          return `user:${userIdentifier}`;
        }
      } catch {
        // Ignore invalid token and fallback to IP
      }
    }

    return ipKeyGenerator(req.ip);
  },
});

app.use(cors(corsOptions));

// Chrome Private Network Access: respond to preflight with the required header
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Private-Network', 'true');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

app.use((req, res, next) => {
  const themeCookie = req.cookies?.theme;
  const resolvedTheme = themeCookie === 'dark' ? 'dark' : 'light';
  res.locals.theme = resolvedTheme;
  res.locals.appVersion = config.PAPERLESS_AI_VERSION || 'unknown';
  res.locals.appCommitSha = process.env.PAPERLESS_AI_COMMIT_SHA || 'unknown';
  res.locals.appPaperlessNgxVersion =
    process.env.PAPERLESS_NGX_VERSION || 'unknown';
  res.locals.appAiProvider =
    config.aiProvider || process.env.AI_PROVIDER || 'openai';
  res.locals.appOcrEnabled = config.mistralOcr?.enabled === 'yes';
  res.locals.appOcrProvider = config.mistralOcr?.provider || 'mistral';
  res.locals.appNodeEnv = process.env.NODE_ENV || 'production';
  res.locals.appNodeVersion = process.version;
  res.locals.appPlatform = `${process.platform} (${process.arch})`;
  res.locals.appServerTimeUtc = new Date().toISOString();
  res.locals.appServerTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  res.locals.appDateFormat = config.dateFormat || 'DD.MM.YYYY';
  res.locals.appPaperlessApiUrl = config.paperless?.apiUrl || 'unknown';
  res.locals.appOllamaApiUrl = config.ollama?.apiUrl || 'unknown';
  res.locals.appOllamaModel = config.ollama?.model || 'unknown';
  res.locals.appCustomBaseUrl = config.custom?.apiUrl || 'unknown';
  res.locals.appCustomModel = config.custom?.model || 'unknown';
  res.locals.appAzureEndpoint = config.azure?.endpoint || 'unknown';
  res.locals.appAzureDeploymentName = config.azure?.deploymentName || 'unknown';
  res.locals.appAzureApiVersion = config.azure?.apiVersion || 'unknown';
  res.locals.appMistralOcrModel = config.mistralOcr?.model || 'unknown';
  res.locals.appScanInterval = config.scanInterval || 'unknown';
  res.locals.appTokenLimit = String(config.tokenLimit || 'unknown');
  res.locals.appResponseTokens = String(config.responseTokens || 'unknown');
  res.locals.appTrustProxy = String(config.trustProxy);
  res.locals.appUseExistingData = config.useExistingData || 'no';
  res.locals.appRestrictTags = config.restrictToExistingTags || 'no';
  res.locals.appRestrictCorrespondents =
    config.restrictToExistingCorrespondents || 'no';
  res.locals.appRestrictDocumentTypes =
    config.restrictToExistingDocumentTypes || 'no';
  res.locals.appPaperlessTokenSet = Boolean(config.paperless?.apiToken);
  res.locals.appOpenAiKeySet = Boolean(config.openai?.apiKey);
  res.locals.appCustomKeySet = Boolean(config.custom?.apiKey);
  res.locals.appAzureKeySet = Boolean(config.azure?.apiKey);
  res.locals.appMistralKeySet = Boolean(config.mistralOcr?.apiKey);
  res.locals.appApiKeySet = Boolean(config.getApiKey && config.getApiKey());
  res.locals.loginCookieSecurityWarning = null;

  if (req.path === '/login' && csrfCookieSecure && !isHttpsRequest(req)) {
    res.locals.loginCookieSecurityWarning =
      'You are accessing the login page over HTTP while the system is configured to use HTTPS by default. To resolve this, either switch to HTTPS or set COOKIE_SECURE_MODE=never in your .env or docker-compose.yml file and restart the container.';
  }

  next();
});

// CSRF Protection configuration
const { invalidCsrfTokenError, generateCsrfToken, doubleCsrfProtection } =
  doubleCsrf({
    getSecret: () => JWT_SECRET,
    getSessionIdentifier: (req) => {
      const token =
        req.cookies?.jwt || req.headers.authorization?.split(' ')[1];
      if (token) {
        return `jwt:${token}`;
      }

      const apiKey = req.headers['x-api-key'];
      const currentApiKey = config.getApiKey();
      if (currentApiKey && apiKey && apiKey === currentApiKey) {
        return `api-key:${apiKey}`;
      }

      return `ip:${req.ip || 'unknown'}`;
    },
    cookieName: 'psai.x-csrf-token',
    cookieOptions: {
      sameSite: 'lax',
      path: '/',
      secure: csrfCookieSecure,
    },
    size: 64,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getCsrfTokenFromRequest: (req) =>
      req.headers['x-csrf-token'] || req.body._csrf,
  });

// Middleware to skip CSRF for API Key authenticated requests and provide token to EJS
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const currentApiKey = config.getApiKey();

  // If API Key is valid, skip CSRF
  if (currentApiKey && apiKey && apiKey === currentApiKey) {
    return next();
  }

  // Handle CSRF protection for other requests
  doubleCsrfProtection(req, res, (err) => {
    if (err) {
      if (err === invalidCsrfTokenError) {
        if (req.method === 'POST' && req.path === '/login') {
          const baseError =
            'Invalid CSRF token. The login page may have expired or your browser did not send the CSRF cookie.';
          const guidance = res.locals.loginCookieSecurityWarning
            ? ' This is commonly caused by HTTP access with secure cookies enabled. Set COOKIE_SECURE_MODE=never for local HTTP and restart, or switch to HTTPS. See: https://zettelrob.be/getting-started/configuration/#cookie-and-proxy-flags-all-supported-values'
            : ' Refresh the login page and try again.';

          return res.status(403).render('login', {
            error: `${baseError}${guidance}`,
            mfaRequired: false,
            username: String(req.body?.username || ''),
          });
        }

        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
      return next(err);
    }

    // Make CSRF token available to EJS templates
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  });
});

/**
 * @swagger
 * /api/csrf-token:
 *   get:
 *     summary: Issue a CSRF token for the current browser
 *     description: |
 *       Returns a token paired with the CSRF cookie this response sets, for a
 *       page whose own token has gone stale.
 *
 *       A token is minted per page render and the cookie it pairs with belongs
 *       to the browser, not the tab — so a second tab, a navigation, or the
 *       restart after saving settings leaves every older tab holding a token
 *       the server no longer accepts. /js/csrf.js calls this after a rejected
 *       request and repeats the request once.
 *
 *       Deliberately unauthenticated: the login form needs the same recovery,
 *       and a token is only usable together with the cookie sent alongside it.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: A token matching the cookie set on this response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 csrfToken:
 *                   type: string
 *                   example: "e3b0c44298fc1c14…"
 */
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: generateCsrfToken(req, res) });
});

app.use(['/api', '/manual'], apiGlobalLimiter);

const isApiDocsEnabled = config.exposeApiDocs === 'yes';
let swaggerSpec = null;

if (isApiDocsEnabled) {
  const swaggerUi = require('swagger-ui-express');
  swaggerSpec = require('./swagger');

  // Swagger documentation route (protected)
  app.use(
    '/api-docs',
    isAuthenticated,
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      swaggerOptions: {
        url: '/api-docs/openapi.json',
      },
    })
  );

  /**
   * @swagger
   * /api-docs/openapi.json:
   *   get:
   *     summary: Retrieve the OpenAPI specification
   *     description: |
   *       Returns the complete OpenAPI specification for the Zettelrobbe API.
   *       This endpoint attempts to serve a static OpenAPI JSON file first, falling back
   *       to dynamically generating the specification if the file cannot be read.
   *
   *       The OpenAPI specification document contains all API endpoints, parameters,
   *       request bodies, responses, and schemas for the entire application.
   *     tags: [API, System]
   *     responses:
   *       200:
   *         description: OpenAPI specification returned successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: The complete OpenAPI specification
   *       302:
   *         description: Redirect to login when authentication is missing or invalid
   *         headers:
   *           Location:
   *             schema:
   *               type: string
   *               example: /login
   *       404:
   *         description: OpenAPI specification file not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Server error occurred while retrieving the OpenAPI specification
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  app.get('/api-docs/openapi.json', isAuthenticated, (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Try to serve the static file first
    fs.readFile(openApiPath)
      .then((data) => {
        res.send(JSON.parse(data));
      })
      .catch((err) => {
        console.warn(
          'Error reading OpenAPI file, generating dynamically:',
          err.message
        );
        // Fallback to generating the spec if file can't be read
        res.send(swaggerSpec);
      });
  });

  /**
   * @swagger
   * /api-docs.json:
   *   get:
   *     summary: Redirect to OpenAPI specification endpoint
   *     description: Backward-compatible redirect to `/api-docs/openapi.json`.
   *     tags:
   *       - API
   *       - System
   *     security:
   *       - BearerAuth: []
   *       - ApiKeyAuth: []
   *     responses:
   *       302:
   *         description: Redirects to `/api-docs/openapi.json`
   */
  // Add a redirect for the old endpoint for backward compatibility
  app.get('/api-docs.json', isAuthenticated, (req, res) => {
    res.redirect('/api-docs/openapi.json');
  });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// //Layout middleware
// app.use((req, res, next) => {
//   const originalRender = res.render;
//   res.render = function (view, locals = {}) {
//     originalRender.call(this, view, locals, (err, html) => {
//       if (err) return next(err);
//       originalRender.call(this, 'layout', { content: html, ...locals });
//     });
//   };
//   next();
// });

// Initialize data directory
async function initializeDataDirectory() {
  try {
    await fs.access(dataDir);
  } catch {
    console.log('Creating data directory...');
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Save OpenAPI specification to file
async function saveOpenApiSpec() {
  if (!isApiDocsEnabled || !swaggerSpec) {
    return true;
  }

  try {
    // Ensure the directory exists
    try {
      await fs.access(openApiDir);
    } catch {
      console.log('Creating OPENAPI directory...');
      await fs.mkdir(openApiDir, { recursive: true });
    }

    // Write the specification to file
    await fs.writeFile(openApiPath, JSON.stringify(swaggerSpec, null, 2));
    console.log(`OpenAPI specification saved to ${openApiPath}`);
    return true;
  } catch (error) {
    console.error(`Failed to save OpenAPI specification: ${error.message}`);
    console.debug(error);
    return false;
  }
}

// Document processing functions
async function processDocument(
  doc,
  existingTags,
  existingCorrespondentList,
  existingDocumentTypesList,
  context = {}
) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;

  // A document that waits in the OCR queue, or sits inside an OCR run right
  // now, gets both its text and its analysis from that path. Analysing it here
  // would work on the very text the OCR run is about to replace, and the three
  // Paperless-ngx calls below would be spent for nothing.
  const queuedForOcrIds = context.ocrQueuedDocumentIds;
  if (
    (queuedForOcrIds && queuedForOcrIds.has(Number(doc.id))) ||
    mistralOcrService.isDocumentActivelyProcessing(doc.id)
  ) {
    console.debug(
      `Document ${doc.id} is waiting for Mistral OCR, skipping analysis this round`
    );
    return null;
  }

  const isIgnored = await documentModel.isDocumentIgnored(doc.id);
  if (isIgnored) {
    console.debug(
      `Document ${doc.id} is marked as ignored, skipping permanently`
    );
    return null;
  }

  const isFailed = await documentModel.isDocumentFailed(doc.id);
  if (isFailed) {
    console.debug(
      `Document ${doc.id} is marked as permanently failed, skipping until reset`
    );
    return null;
  }

  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  // Check if the document can be edited.
  const documentEditable = await paperlessService.getPermissionOfDocument(
    doc.id
  );
  if (!documentEditable) {
    console.debug(
      `Document ${doc.id} is not editable by the Zettelrobbe user, skipping analysis`
    );
    return null;
  }

  console.debug(`Document ${doc.id} is editable by the Paperless-AI user`);

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id),
  ]);

  // Both automatic queue points share this helper. The Paperless-ngx calls
  // above take long enough for a running OCR job to finish in between, delete
  // its queue row and put the document into processed_documents — the scan
  // then used to insert a fresh pending row and buy a second paid OCR run
  // (issue #322). The checks here keep that out of the log and off the wire;
  // skipIfProcessed is the atomic safety net inside the insert itself.
  const queueForOcr = async (queueReason) => {
    if (await documentModel.isDocumentProcessed(doc.id)) {
      console.debug(
        `Document ${doc.id} was processed while this scan was running, not queued for Mistral OCR (already processed)`
      );
      return false;
    }

    if (mistralOcrService.isDocumentActivelyProcessing(doc.id)) {
      console.debug(
        `Document ${doc.id} is inside an OCR run, not queued for Mistral OCR (currently processing)`
      );
      return false;
    }

    const queued = await documentModel.addToOcrQueue(
      doc.id,
      doc.title,
      queueReason,
      { skipIfProcessed: true }
    );

    if (!queued) {
      const queueItem = await documentModel.getOcrQueueItem(doc.id);
      let state = 'already processed';
      if (queueItem?.status === 'done') {
        state = 'already done';
      } else if (queueItem?.status === 'processing') {
        state = 'currently processing';
      }
      console.debug(
        `Document ${doc.id} was not queued for Mistral OCR (${state})`
      );
    }

    return queued;
  };

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    console.debug(
      `Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${MIN_CONTENT_LENGTH}), skipping analysis`
    );
    // Queue for Mistral OCR if enabled.
    if (mistralOcrService.isEnabled()) {
      const added = await queueForOcr(`short_content_lt_${MIN_CONTENT_LENGTH}`);
      if (added) {
        console.info(
          `Document ${doc.id} queued for Mistral OCR (short_content)`
        );
      }
    } else {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        `insufficient_content_lt_${MIN_CONTENT_LENGTH}`,
        'ai'
      );
      retryTracker.delete(doc.id);
    }
    return null;
  }

  // Check retry limit to prevent infinite retry loops
  const docRetries = retryTracker.get(doc.id) || 0;
  if (docRetries >= 3) {
    console.warn(
      `Document ${doc.id} has failed ${docRetries} times, skipping to prevent infinite retry loop`
    );
    await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
    retryTracker.delete(doc.id);
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  const aiService = AIServiceFactory.getService();
  const analysis = await aiService.analyzeDocument(
    content,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypesList,
    doc.id
  );
  console.debug('Response from AI service:', analysis);
  if (analysis.error) {
    const aiErrorMessage = isTimeoutError(analysis.error)
      ? `${buildTimeoutErrorMessage('AI')} Original error: ${analysis.error}`
      : analysis.error;

    if (isTimeoutError(analysis.error)) {
      console.error(`[TIMEOUT][AI] Document ${doc.id}: ${analysis.error}`);
    }

    let queuedForOcr = false;
    let markedTerminalFailed = false;
    // Queue for Mistral OCR on OCR-relevant AI errors (e.g. low content, invalid response structure)
    if (
      mistralOcrService.isEnabled() &&
      shouldQueueForOcrOnAiError(aiErrorMessage)
    ) {
      const queueReason = classifyOcrQueueReasonFromAiError(aiErrorMessage);
      const added = await queueForOcr(queueReason);
      if (added) {
        console.log(
          `[OCR] Document ${doc.id} queued for Mistral OCR (ai_failed: ${aiErrorMessage})`
        );
      }
      // The OCR path stays responsible for this document even when nothing was
      // queued: a refusal means it is already processed, already done or inside
      // a run, and none of those is a terminal AI failure worth recording.
      queuedForOcr = true;
    }

    if (!mistralOcrService.isEnabled()) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        // A service that knows exactly why it gave up says so; everything else
        // keeps the generic reason this branch has always recorded.
        analysis.errorCode || 'ai_failed_ocr_disabled',
        'ai'
      );
      retryTracker.delete(doc.id);
      markedTerminalFailed = true;
    } else if (!queuedForOcr) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(
        doc.id,
        doc.title,
        analysis.errorCode || 'ai_failed_without_ocr_fallback',
        'ai'
      );
      retryTracker.delete(doc.id);
      markedTerminalFailed = true;
    }

    // Increment retry count on error
    if (!markedTerminalFailed) {
      retryTracker.set(doc.id, docRetries + 1);
    }
    throw new Error(`[ERROR] Document analysis failed: ${aiErrorMessage}`);
  }

  // Clear retry count on success
  retryTracker.delete(doc.id);
  return { analysis, originalData };
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents:
      config.restrictToExistingCorrespondents === 'yes',
    restrictToExistingDocumentTypes:
      config.restrictToExistingDocumentTypes === 'yes',
  };

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
    console.debug(
      'Tagging is deactivated but the AI processed tag will still be added'
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
    console.debug('Tagging is deactivated');
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
      console.error(`[ERROR] Error processing document type: ${error.message}`);
      console.debug(error);
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
    console.debug('Found existing fields:', existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];

      if (
        !customField.field_name ||
        customField.value === null ||
        customField.value === undefined ||
        String(customField.value).trim() === ''
      ) {
        console.debug('Skipping empty or invalid custom field');
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
        // Capture name + validated value for history at the point where we have both
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
      console.error(`[ERROR] Error processing correspondent: ${error.message}`);
      console.debug(error);
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

  // Pull out history-only data and remove it before sending updateData to Paperless
  const historyCustomFields = updateData._customFieldsForHistory || null;
  delete updateData._customFieldsForHistory;

  const historyDocTypeName = analysis.document.document_type ?? null;
  const historyLanguage = analysis.document.language ?? null;
  const origDocType = originalData.document_type ?? null;
  const origLanguage = originalData.language ?? null;

  await documentModel.saveOriginalData(
    docId,
    originalTags,
    originalCorrespondent,
    originalTitle,
    origDocType,
    origLanguage
  );

  const updatedDocument = await paperlessService.updateDocument(
    docId,
    updateData
  );
  if (!updatedDocument) {
    throw new Error(`Paperless update failed for document ${docId}`);
  }

  const persistenceTasks = [
    documentModel.addProcessedDocument(docId, updateData.title),
    documentModel.addToHistory(
      docId,
      updateData.tags,
      updateData.title,
      analysis.document.correspondent,
      historyCustomFields,
      historyDocTypeName,
      historyLanguage
    ),
  ];

  if (analysis.metrics) {
    persistenceTasks.push(
      documentModel.addOpenAIMetrics(
        docId,
        analysis.metrics.promptTokens,
        analysis.metrics.completionTokens,
        analysis.metrics.totalTokens
      )
    );
  }

  await Promise.all(persistenceTasks);
}

// Main scanning function
// The initial scan runs through here as well (source='initial') so it shares the
// concurrency guard, the stop support and the health reporting below.
async function scanDocuments(source = 'scheduler') {
  if (scanControl.running) {
    console.info('Scan request ignored because a task is already running');
    return;
  }

  // The OCR cron already stands down while a scan runs; this is the other
  // direction. Both paths analyse the same documents through the same AI
  // backend, and a scan that overlaps an OCR run is what let a document be
  // OCR'd twice within minutes (issue #322).
  if (ocrAutoProcessService.running) {
    console.info(
      'Scan request ignored because OCR auto-processing is currently running'
    );
    return;
  }

  const scanStartedAtMs = Date.now();
  const scanStats = {
    source,
    total: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    stopRequested: false,
    abortReason: null,
  };

  scanControl.running = true;
  scanControl.stopRequested = false;
  scanControl.source = source;
  scanControl.startedAt = new Date().toISOString();
  scanControl.stopRequestedAt = null;
  scanHealthService.recordRunStart(source);

  console.info(`Scan started (source=${source})`);

  try {
    // Probe first: the read helpers below swallow transport errors and return
    // empty lists, which would make an unreachable Paperless-ngx look like a
    // successful scan with nothing to do.
    const connection = await paperlessService.checkConnection();
    scanHealthService.recordConnectivity(connection);

    if (!connection.reachable || !connection.authorized) {
      scanStats.abortReason = connection.reachable
        ? 'paperless_unauthorized'
        : 'paperless_unreachable';
      scanHealthService.recordRunResult({
        status: RUN_STATUS.PAPERLESS_UNREACHABLE,
        error: connection.error,
      });
      console.error(
        `[ERROR] Scan aborted: Paperless-ngx is not usable (${connection.error}). ` +
          `The scheduler stays armed and retries at the next interval (${config.scanInterval}).`
      );
      return;
    }

    let [
      existingTags,
      documents,
      existingCorrespondentList,
      existingDocumentTypes,
    ] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames(),
    ]);

    scanStats.total = documents.length;

    // get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(
      (correspondent) => correspondent.name
    );

    // get existing document types list
    const existingDocumentTypesList = existingDocumentTypes.map(
      (docType) => docType.name
    );

    // Extract tag names from tag objects
    const existingTagNames = existingTags.map((tag) => tag.name);

    // Read once per run: every document that waits for OCR or is being OCR'd
    // is skipped below before the scan spends a single Paperless-ngx call on
    // it. Documents that enter the queue during this run are caught by the
    // per-document checks in processDocument().
    const ocrQueuedDocumentIds = new Set(
      (await documentModel.getOcrQueueDocumentIds()).map((documentId) =>
        Number(documentId)
      )
    );

    for (const doc of documents) {
      if (scanControl.stopRequested) {
        scanStats.stopRequested = true;
        console.info(
          `Graceful stop requested. Halting scan before next document (source=${scanControl.source || 'unknown'})`
        );
        break;
      }

      try {
        const result = await processDocument(
          doc,
          existingTagNames,
          existingCorrespondentList,
          existingDocumentTypesList,
          { ocrQueuedDocumentIds }
        );
        if (!result) {
          scanStats.skipped += 1;
          continue;
        }

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
        scanStats.processed += 1;
        // The document counters and token figures just changed. Marking the
        // cache stale costs nothing here; the next dashboard poll pays for the
        // rebuild, so a long scan does not rebuild once per document.
        dashboardStatsService.invalidate();
      } catch (error) {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        scanStats.failed += 1;
        // A failure moves the failed counter and the failure rate, which the
        // dashboard shows just as prominently as the successes.
        dashboardStatsService.invalidate();
        console.error(
          `[ERROR] processing document ${doc.id}: ${error.message}`
        );
        console.debug(error);
      }
    }

    // Documents that fail individually are not an infrastructure problem, so
    // the run itself still counts as successful for health reporting.
    scanHealthService.recordRunResult({ status: RUN_STATUS.OK });
  } catch (error) {
    scanHealthService.recordRunResult({
      status: RUN_STATUS.ERROR,
      error: error.message,
    });
    scanStats.abortReason = 'error';
    console.error(`[ERROR] during document scan: ${error.message}`);
    console.debug(error);
  } finally {
    const durationMs = Date.now() - scanStartedAtMs;
    const abortSuffix = scanStats.abortReason
      ? `, aborted=${scanStats.abortReason}`
      : '';
    console.info(
      `Scan completed (source=${scanStats.source}, total=${scanStats.total}, processed=${scanStats.processed}, skipped=${scanStats.skipped}, failed=${scanStats.failed}, stopRequested=${scanStats.stopRequested}${abortSuffix}, durationMs=${durationMs})`
    );

    scanControl.running = false;
    scanControl.stopRequested = false;
    scanControl.source = null;
    scanControl.startedAt = null;
    scanControl.stopRequestedAt = null;

    // Rebuild once the run is over so the first dashboard poll after a scan
    // reads finished numbers instead of paying for the assembly itself.
    // Detached: nothing in the scan depends on it, and an unhandled rejection
    // would take the process down.
    dashboardStatsService.refresh().catch((error) => {
      console.debug(
        `[DASHBOARD-STATS] Refresh after scan failed: ${error.message}`
      );
    });
  }
}

// Routes
app.use('/', setupRoutes);

// Development-only reference page for the zr UI framework. It ships no product
// behaviour, only one sample of every component, so it is not registered in a
// production build and is deliberately absent from the navigation.
if (process.env.NODE_ENV !== 'production') {
  /**
   * @swagger
   * /styleguide:
   *   get:
   *     summary: UI framework styleguide page (development builds only)
   *     description: |
   *       Renders one sample of every zr framework component. The route is only
   *       registered when `NODE_ENV` is not `production`; a production build
   *       answers this path with the generic 404 handler.
   *     tags:
   *       - Navigation
   *     security:
   *       - BearerAuth: []
   *       - ApiKeyAuth: []
   *     responses:
   *       200:
   *         description: Styleguide page rendered successfully
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   *       302:
   *         description: Redirect to login when authentication is missing or invalid
   *         headers:
   *           Location:
   *             schema:
   *               type: string
   *               example: /login
   *       404:
   *         description: Route not registered because the app runs in production
   *       500:
   *         description: Server error
   */
  app.get('/styleguide', isAuthenticated, async (req, res) => {
    try {
      return res.render('styleguide', {
        version: config.PAPERLESS_AI_VERSION || ' ',
      });
    } catch (error) {
      console.error('[ERROR] Styleguide page:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}

/**
 * @swagger
 * /:
 *   get:
 *     summary: Root endpoint that redirects to the dashboard
 *     description: |
 *       This endpoint serves as the entry point for the application.
 *       When accessed, it automatically redirects the user to the dashboard page.
 *       No parameters or authentication are required for this redirection.
 *     tags: [Navigation, System]
 *     responses:
 *       302:
 *         description: Redirects to the dashboard page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               example: "<html><body>Redirecting to dashboard...</body></html>"
 *       500:
 *         description: Server error occurred during redirection
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/', async (req, res) => {
  try {
    res.redirect('/dashboard');
  } catch (error) {
    console.error(`[ERROR] in root route: ${error.message}`);
    console.debug(error);
    res.status(500).send('Error processing request');
  }
});

// /health is served by routes/setup.js, which is mounted above this file's
// routes. A second handler here was never reachable and has been removed so the
// OpenAPI spec documents the handler that actually answers.

// Error handler
// Express detects error middleware by its four-argument signature, so `next`
// must stay even though it is unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Backoff schedule for the startup connectivity retry, in milliseconds.
// The last value repeats until the retry window configured via
// STARTUP_PAPERLESS_RETRY_MINUTES is exhausted.
const INITIAL_CONNECT_BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const DEFAULT_STARTUP_RETRY_MINUTES = 30;

function initialConnectDelayMs(attempt) {
  const index = Math.min(attempt - 1, INITIAL_CONNECT_BACKOFF_MS.length - 1);
  return INITIAL_CONNECT_BACKOFF_MS[Math.max(index, 0)];
}

function startupRetryWindowMs() {
  const configured = Number(config.startup?.paperlessRetryMinutes);
  const minutes =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_STARTUP_RETRY_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Waits for Paperless-ngx to become usable and then runs the initial scan.
 *
 * Runs detached from startup: the scan scheduler is already armed at this
 * point, so giving up here only means the first scan waits for the next cron
 * tick instead of never happening (issue #272).
 */
async function runInitialScanWhenReachable() {
  const deadlineMs = Date.now() + startupRetryWindowMs();
  let attempt = 0;

  for (;;) {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.warn(
        'Initial scan skipped: setup is not completed yet. The scheduled scan stays armed.'
      );
      return;
    }

    const connection = await paperlessService.checkConnection();
    scanHealthService.recordConnectivity(connection);

    if (connection.reachable && connection.authorized) {
      console.log(`Starting initial scan at ${new Date().toISOString()}`);
      await scanDocuments('initial');
      return;
    }

    attempt += 1;
    const delayMs = initialConnectDelayMs(attempt);

    if (Date.now() + delayMs > deadlineMs) {
      // Count the abandoned initial scan as exactly one failed run. Counting
      // every retry would trip the degraded threshold within minutes and make
      // /health answer 503 during a perfectly normal slow start.
      scanHealthService.recordRunResult({
        status: RUN_STATUS.PAPERLESS_UNREACHABLE,
        error: connection.error,
      });
      console.error(
        `[STARTUP] Paperless-ngx still not usable after ${attempt} attempt(s): ${connection.error}. ` +
          `Skipping the initial scan — the scheduled scan (${config.scanInterval}) stays armed and keeps retrying.`
      );
      return;
    }

    console.warn(
      `[STARTUP] Paperless-ngx not usable yet: ${connection.error}. ` +
        `Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}). ` +
        `The scheduled scan (${config.scanInterval}) is armed regardless.`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const DEFAULT_PAPERLESS_PROBE_INTERVAL_SECONDS = 60;
const MIN_PAPERLESS_PROBE_INTERVAL_SECONDS = 10;

function paperlessProbeIntervalMs() {
  const configured = Number(config.health?.paperlessProbeIntervalSeconds);
  if (!Number.isFinite(configured)) {
    return DEFAULT_PAPERLESS_PROBE_INTERVAL_SECONDS * 1000;
  }
  if (configured <= 0) {
    return 0;
  }
  return Math.max(configured, MIN_PAPERLESS_PROBE_INTERVAL_SECONDS) * 1000;
}

/**
 * Probes Paperless-ngx on a fixed interval, independently of the scan loop.
 *
 * The scan loop only probes when it runs, so between two ticks an outage was
 * invisible to the dashboard — and entirely invisible with
 * DISABLE_AUTOMATIC_PROCESSING=yes. This keeps `paperless.lastCheckedAt` fresh
 * so the UI can warn immediately.
 *
 * Only connectivity is recorded here; the consecutive-failure counter belongs
 * to actual scan runs and must not be moved by a passive probe.
 */
function startConnectivityMonitor() {
  const intervalMs = paperlessProbeIntervalMs();
  if (intervalMs === 0) {
    console.info(
      '[HEALTH] Paperless-ngx connectivity probe is disabled (PAPERLESS_PROBE_INTERVAL_SECONDS=0).'
    );
    return;
  }

  let probeRunning = false;

  const probe = async () => {
    // A scan probes on its own and would only duplicate the request here.
    if (probeRunning || scanControl.running) {
      return;
    }
    probeRunning = true;

    try {
      if (!(await setupService.isConfigured())) {
        // Nothing configured yet — reporting "not reachable" would warn about
        // a connection the user has not set up.
        scanHealthService.clearConnectivity();
        return;
      }

      scanHealthService.recordConnectivity(
        await paperlessService.checkConnection()
      );
    } catch (error) {
      console.debug(
        `[HEALTH] Connectivity probe failed unexpectedly: ${error.message}`
      );
    } finally {
      probeRunning = false;
    }
  };

  const timer = setInterval(probe, intervalMs);
  // Never keep the event loop alive just for the probe.
  timer.unref?.();
  console.info(
    `[HEALTH] Paperless-ngx connectivity probe armed (every ${intervalMs / 1000}s).`
  );

  probe();
}

// Start scanning
async function startScanning() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(
        `Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`
      );
    }

    // Reconciliation: remove stale documents deleted in Paperless-ngx.
    // Armed independently of Paperless-ngx reachability so a temporary outage
    // cannot leave the app without any scheduled work.
    if (config.reconciliationEnabled === 'yes') {
      console.log(
        'Configured reconciliation interval:',
        config.reconciliationInterval
      );
      cron.schedule(config.reconciliationInterval, async () => {
        console.debug(
          `[RECONCILIATION] Scheduled run triggered at ${new Date().toISOString()}`
        );
        await reconciliationService.reconcileAllDocuments();
      });
    } else {
      console.info(
        '[RECONCILIATION] Automatic reconciliation is disabled (RECONCILIATION_ENABLED=no).'
      );
    }

    // Dashboard statistics are cached, and the cache is kept warm from here so
    // no visitor ever waits for the assembly. Armed before the automatic
    // processing kill-switch below on purpose: the dashboard is served (and
    // polled) whether or not scanning is enabled.
    if (isConfigured) {
      dashboardStatsService.refresh().catch((error) => {
        console.debug(`[DASHBOARD-STATS] Warmup failed: ${error.message}`);
      });
    }

    cron.schedule('* * * * *', async () => {
      // Never compete with a running scan for the Paperless API — the scan
      // invalidates the cache per document anyway, and the run end refreshes it.
      if (scanControl.running) {
        return;
      }
      if (!(await setupService.isConfigured())) {
        return;
      }
      await dashboardStatsService.refresh().catch((error) => {
        console.debug(
          `[DASHBOARD-STATS] Scheduled refresh failed: ${error.message}`
        );
      });
    });

    if (config.disableAutomaticProcessing === 'yes') {
      scanHealthService.markAutomaticProcessingDisabled();
      console.info(
        'Automatic document processing is disabled (DISABLE_AUTOMATIC_PROCESSING=yes). No scan is scheduled.'
      );
      return;
    }

    // OCR auto-processing: drain the pending OCR queue without anyone having
    // to press "Process All Pending". Armed after the kill-switch above
    // because OCR + AI writes results back to Paperless-ngx, which is exactly
    // what DISABLE_AUTOMATIC_PROCESSING is meant to stop.
    if (ocrAutoProcessService.isEnabled()) {
      const ocrAutoProcessInterval = ocrAutoProcessService.interval;
      console.log(
        'Configured OCR auto-processing interval:',
        ocrAutoProcessInterval
      );
      cron.schedule(ocrAutoProcessInterval, async () => {
        // Never compete with a running scan for the same AI backend.
        if (scanControl.running) {
          console.debug(
            '[OCR] Auto-processing skipped: a document scan is currently running.'
          );
          return;
        }
        await ocrAutoProcessService.drainQueue();
      });
    } else {
      console.info(
        '[OCR] Automatic OCR queue processing is disabled (OCR_AUTO_PROCESS_ENABLED=no).'
      );
    }

    // Arm the scheduler before talking to Paperless-ngx. A connection failure
    // at startup must never leave the app running without a scan loop —
    // every scheduled run re-checks connectivity on its own.
    console.log('Configured scan interval:', config.scanInterval);
    cron.schedule(config.scanInterval, async () => {
      console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
      if (!(await setupService.isConfigured())) {
        console.warn('Scheduled scan skipped: setup is not completed.');
        return;
      }
      await scanDocuments();
    });
    scanHealthService.markArmed(config.scanInterval);

    // Detached on purpose: startup must not block while Paperless-ngx is still
    // coming up. unhandledRejection terminates the process, so catch here.
    runInitialScanWhenReachable().catch((error) => {
      console.error(`[ERROR] during initial scan: ${error.message}`);
      console.debug(error);
    });
  } catch (error) {
    console.error(`[ERROR] in startScanning: ${error.message}`);
    console.debug(error);
  }
}

// Error handlers
// process.on('SIGTERM', async () => {
//   console.log('Received SIGTERM. Starting graceful shutdown...');
//   try {
//     console.log('Closing database...');
//     await documentModel.closeDatabase(); // Jetzt warten wir wirklich auf den Close
//     console.log('Database closed successfully');
//     process.exit(0);
//   } catch (error) {
//     console.error('[ERROR] during shutdown:', error);
//     process.exit(1);
//   }
// });

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.info(`Received ${signal} signal. Starting graceful shutdown...`);
  try {
    console.info('Closing database...');
    await documentModel.closeDatabase();
    console.info('Database closed successfully');
    process.exit(0);
  } catch (error) {
    console.error(`[ERROR] during ${signal} shutdown: ${error.message}`);
    console.debug(error);
    process.exit(1);
  }
}

// Handle both SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  const port = process.env.PAPERLESS_AI_PORT || 3000;
  try {
    await initializeDataDirectory();
    await runStartupMigrations(console);
    await mistralOcrService.recoverInterruptedJobs(console);
    await saveOpenApiSpec(); // Save OpenAPI specification on startup
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      warnIfRemoteSetupExposed();
      startScanning();
      // Armed separately from the scan scheduler so the dashboard also warns
      // when automatic processing is switched off.
      startConnectivityMonitor();
    });
  } catch (error) {
    console.error(`Failed to start server: ${error.message}`);
    console.debug(error);
    process.exit(1);
  }
}

/**
 * Emits a security warning when the server starts with an incomplete setup
 * AND ALLOW_REMOTE_SETUP=yes, meaning the unauthenticated setup endpoints
 * are reachable from the network.
 */
async function warnIfRemoteSetupExposed() {
  if (process.env.ALLOW_REMOTE_SETUP !== 'yes') {
    return;
  }

  try {
    const isConfigured = await setupService.isConfigured();
    if (isConfigured) {
      return;
    }

    const msg =
      '[SECURITY WARNING] Setup is not yet complete and ALLOW_REMOTE_SETUP=yes. ' +
      'The setup endpoints are reachable from the network. ' +
      'Disable ALLOW_REMOTE_SETUP or restrict network access until setup is finished.';

    console.warn(msg);
    htmlLogger.log(`⚠️ ${msg}`);
    txtLogger.log(msg);
  } catch {
    // Non-fatal — warning is best-effort
  }
}

startServer();
