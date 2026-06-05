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
const reconciliationService = require('./services/reconciliationService');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Logger = require('./services/loggerService');
const { max } = require('date-fns');
const { validateCustomFieldValue, shouldQueueForOcrOnAiError, classifyOcrQueueReasonFromAiError } = require('./services/serviceUtils');
const dataDir = path.join(process.cwd(), 'data');
const openApiDir = path.join(dataDir, 'OPENAPI');
const openApiPath = path.join(openApiDir, 'openapi.json');
const dataLogsDir = path.join(process.cwd(), 'data', 'logs');

const htmlLogger = new Logger({
  logFile: 'logs.html',
  logDir: dataLogsDir,
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  logDir: dataLogsDir,
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const app = express();
const scanControl = global.__paperlessAiScanControl || {
  running: false,
  stopRequested: false,
  source: null,
  startedAt: null,
  stopRequestedAt: null
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
      message: 'Scan is already running.'
    };
  }

  scanDocuments(source).catch((error) => {
    console.error(`[ERROR] scanDocuments() failed in triggerScanNow: ${error.message}`);
    console.debug(error);
  });

  return {
    started: true,
    running: true,
    stopRequested: false,
    message: 'Scan started.'
  };
}

global.__paperlessAiTriggerScanNow = triggerScanNow;
global.__paperlessAiRequestScanStop = requestScanStop;

function persistJwtSecret(secret) {
  const runtimeDataDir = path.join(process.cwd(), 'data');
  const envFilePath = path.join(runtimeDataDir, '.env');
  const runtimeOverridesPath = path.join(runtimeDataDir, 'runtime-overrides.json');

  try {
    fsSync.mkdirSync(runtimeDataDir, { recursive: true });

    let envContent = '';
    if (fsSync.existsSync(envFilePath)) {
      envContent = fsSync.readFileSync(envFilePath, 'utf8');
    }

    const hasJwtSecretLine = /^\s*JWT_SECRET\s*=.*$/m.test(envContent);
    let updatedEnvContent = envContent;

    if (hasJwtSecretLine) {
      updatedEnvContent = envContent.replace(/^\s*JWT_SECRET\s*=.*$/m, `JWT_SECRET=${secret}`);
    } else {
      const trimmed = envContent.trimEnd();
      updatedEnvContent = trimmed ? `${trimmed}\nJWT_SECRET=${secret}\n` : `JWT_SECRET=${secret}\n`;
    }

    fsSync.writeFileSync(envFilePath, updatedEnvContent, 'utf8');
  } catch (error) {
    console.warn('[WARN] Could not persist generated JWT_SECRET to data/.env:', error.message);
  }

  try {
    if (!fsSync.existsSync(runtimeOverridesPath)) {
      return;
    }

    const raw = fsSync.readFileSync(runtimeOverridesPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};

    if (!parsed.JWT_SECRET || String(parsed.JWT_SECRET).trim() === '') {
      parsed.JWT_SECRET = secret;
      fsSync.writeFileSync(runtimeOverridesPath, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn('[WARN] Could not update JWT_SECRET in runtime-overrides.json:', error.message);
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

  console.warn('[WARN] JWT_SECRET was missing. Generated and persisted a new secret. Existing sessions may require re-login.');
  return generatedSecret;
}

const JWT_SECRET = ensureJwtSecret();

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is not set. Refusing to start without a secure JWT secret.');
  process.exit(1);
}

const trustProxy = config.getTrustProxy();
if (trustProxy !== false) {
  app.set('trust proxy', trustProxy);
}

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
const MIN_CONTENT_LENGTH = parseInt(process.env.MIN_CONTENT_LENGTH || '10', 10);


const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'x-api-key',
    'Access-Control-Allow-Private-Network'
  ],
  credentials: false
};

const apiGlobalLimiter = rateLimit({
  windowMs: config.globalRateLimitWindowMs,
  max: config.globalRateLimitMax,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.'
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
        const userIdentifier = decoded?.id || decoded?.userId || decoded?.username || decoded?.sub;
        if (userIdentifier) {
          return `user:${userIdentifier}`;
        }
      } catch (error) {
        // Ignore invalid token and fallback to IP
      }
    }

    return ipKeyGenerator(req.ip);
  }
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
  res.locals.appPaperlessNgxVersion = process.env.PAPERLESS_NGX_VERSION || 'unknown';
  res.locals.appAiProvider = config.aiProvider || process.env.AI_PROVIDER || 'openai';
  res.locals.appOcrEnabled = config.mistralOcr?.enabled === 'yes';
  res.locals.appOcrProvider = config.mistralOcr?.provider || 'mistral';
  res.locals.appNodeEnv = process.env.NODE_ENV || 'production';
  res.locals.appNodeVersion = process.version;
  res.locals.appPlatform = `${process.platform} (${process.arch})`;
  res.locals.appServerTimeUtc = new Date().toISOString();
  res.locals.appServerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
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
  res.locals.appRestrictCorrespondents = config.restrictToExistingCorrespondents || 'no';
  res.locals.appRestrictDocumentTypes = config.restrictToExistingDocumentTypes || 'no';
  res.locals.appPaperlessTokenSet = Boolean(config.paperless?.apiToken);
  res.locals.appOpenAiKeySet = Boolean(config.openai?.apiKey);
  res.locals.appCustomKeySet = Boolean(config.custom?.apiKey);
  res.locals.appAzureKeySet = Boolean(config.azure?.apiKey);
  res.locals.appMistralKeySet = Boolean(config.mistralOcr?.apiKey);
  res.locals.appApiKeySet = Boolean(config.getApiKey && config.getApiKey());
  res.locals.loginCookieSecurityWarning = null;

  if (req.path === '/login' && csrfCookieSecure && !isHttpsRequest(req)) {
    res.locals.loginCookieSecurityWarning = 'You are accessing the login page over HTTP while the system is configured to use HTTPS by default. To resolve this, either switch to HTTPS or set COOKIE_SECURE_MODE=never in your .env or docker-compose.yml file and restart the container.';
  }

  next();
});

// CSRF Protection configuration
const {
  invalidCsrfTokenError,
  generateCsrfToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => JWT_SECRET,
  getSessionIdentifier: (req) => {
    const token = req.cookies?.jwt || req.headers.authorization?.split(' ')[1];
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
  cookieName: "psai.x-csrf-token",
  cookieOptions: {
    sameSite: "lax",
    path: "/",
    secure: csrfCookieSecure,
  },
  size: 64,
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getCsrfTokenFromRequest: (req) => req.headers["x-csrf-token"] || req.body._csrf,
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
          const baseError = 'Invalid CSRF token. The login page may have expired or your browser did not send the CSRF cookie.';
          const guidance = res.locals.loginCookieSecurityWarning
            ? ' This is commonly caused by HTTP access with secure cookies enabled. Set COOKIE_SECURE_MODE=never for local HTTP and restart, or switch to HTTPS. See: https://paperless-ai-next.admon.me/getting-started/configuration/#cookie-and-proxy-flags-all-supported-values'
            : ' Refresh the login page and try again.';

          return res.status(403).render('login', {
            error: `${baseError}${guidance}`,
            mfaRequired: false,
            username: String(req.body?.username || '')
          });
        }

        return res.status(403).json({ error: "Invalid CSRF token" });
      }
      return next(err);
    }
    
    // Make CSRF token available to EJS templates
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  });
});

app.use(['/api', '/manual'], apiGlobalLimiter);

const isApiDocsEnabled = config.exposeApiDocs === 'yes';
let swaggerSpec = null;

if (isApiDocsEnabled) {
  const swaggerUi = require('swagger-ui-express');
  swaggerSpec = require('./swagger');

  // Swagger documentation route (protected)
  app.use('/api-docs', isAuthenticated, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
      url: '/api-docs/openapi.json'
    }
  }));

  /**
   * @swagger
   * /api-docs/openapi.json:
   *   get:
   *     summary: Retrieve the OpenAPI specification
   *     description: |
   *       Returns the complete OpenAPI specification for the Paperless-AI next API.
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
      .then(data => {
        res.send(JSON.parse(data));
      })
      .catch(err => {
        console.warn('Error reading OpenAPI file, generating dynamically:', err.message);
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
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;

  const isFailed = await documentModel.isDocumentFailed(doc.id);
  if (isFailed) {
    console.debug(`Document ${doc.id} is marked as permanently failed, skipping until reset`);
    return null;
  }

  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  // Check if the document can be edited.
  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.debug(`Document ${doc.id} is not editable by the Paperless-AI user, skipping analysis`);
    return null;
  }

  console.debug(`Document ${doc.id} is editable by the Paperless-AI user`);

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id)
  ]);

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    console.debug(`Document ${doc.id} has insufficient content (${content?.length || 0} chars, minimum: ${MIN_CONTENT_LENGTH}), skipping analysis`);
    // Queue for Mistral OCR if enabled.
    if (mistralOcrService.isEnabled()) {
      const added = await documentModel.addToOcrQueue(doc.id, doc.title, `short_content_lt_${MIN_CONTENT_LENGTH}`);
      if (added) {
        console.info(`Document ${doc.id} queued for Mistral OCR (short_content)`);
      }
    } else {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(doc.id, doc.title, `insufficient_content_lt_${MIN_CONTENT_LENGTH}`, 'ai');
      retryTracker.delete(doc.id);
    }
    return null;
  }

  // Check retry limit to prevent infinite retry loops
  const docRetries = retryTracker.get(doc.id) || 0;
  if (docRetries >= 3) {
    console.warn(`Document ${doc.id} has failed ${docRetries} times, skipping to prevent infinite retry loop`);
    await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
    retryTracker.delete(doc.id);
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  const aiService = AIServiceFactory.getService();
  const analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id);
  console.debug('Response from AI service:', analysis);
  if (analysis.error) {
    let queuedForOcr = false;
    let markedTerminalFailed = false;
    // Queue for Mistral OCR on OCR-relevant AI errors (e.g. low content, invalid response structure)
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
      retryTracker.delete(doc.id);
      markedTerminalFailed = true;
    } else if (!queuedForOcr) {
      await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
      await documentModel.addFailedDocument(doc.id, doc.title, 'ai_failed_without_ocr_fallback', 'ai');
      retryTracker.delete(doc.id);
      markedTerminalFailed = true;
    }

    // Increment retry count on error
    if (!markedTerminalFailed) {
      retryTracker.set(doc.id, docRetries + 1);
    }
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }

  // Clear retry count on success
  retryTracker.delete(doc.id);
  return { analysis, originalData };
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes',
    restrictToExistingDocumentTypes: config.restrictToExistingDocumentTypes === 'yes'
  };

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
    console.debug('Tagging is deactivated but the AI processed tag will still be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
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
  if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type, options);
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type: ${error.message}`);
      console.debug(error);
    }
  }
  
  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];
    const customFieldsForHistory = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.debug('Found existing fields:', existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];
      
      if (!customField.field_name || (customField.value === null || customField.value === undefined || String(customField.value).trim() === '')) {
        console.debug('Skipping empty or invalid custom field');
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
        // Capture name + validated value for history at the point where we have both
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
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;

  // Pull out history-only data and remove it before sending updateData to Paperless
  const historyCustomFields = updateData._customFieldsForHistory || null;
  delete updateData._customFieldsForHistory;

  const historyDocTypeName = analysis.document.document_type ?? null;
  const historyLanguage    = analysis.document.language ?? null;
  const origDocType        = originalData.document_type ?? null;
  const origLanguage       = originalData.language ?? null;

  await documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle, origDocType, origLanguage);

  const updatedDocument = await paperlessService.updateDocument(docId, updateData);
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
    )
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

// Main scanning functions
async function scanInitial() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('[ERROR] Setup not completed. Skipping document scan.');
      return;
    }

    let [existingTags, documents, ownUserId, existingCorrespondentList, existingDocumentTypes] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames()
    ]);
    //get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);
    let existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);
    
    // Extract tag names from tag objects
    const existingTagNames = existingTags.map(tag => tag.name);

    for (const doc of documents) {
      try {
        const result = await processDocument(doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
      } catch (error) {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        console.error(`[ERROR] processing document ${doc.id}: ${error.message}`);
        console.debug(error);
      }
    }
  } catch (error) {
    console.error(`[ERROR] during initial document scan: ${error.message}`);
    console.debug(error);
  }
}

async function scanDocuments(source = 'scheduler') {
  if (scanControl.running) {
    console.info('Scan request ignored because a task is already running');
    return;
  }

  const scanStartedAtMs = Date.now();
  const scanStats = {
    source,
    total: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    stopRequested: false
  };

  scanControl.running = true;
  scanControl.stopRequested = false;
  scanControl.source = source;
  scanControl.startedAt = new Date().toISOString();
  scanControl.stopRequestedAt = null;

  console.info(`Scan started (source=${source})`);

  try {
    let [existingTags, documents, ownUserId, existingCorrespondentList, existingDocumentTypes] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames()
    ]);

    scanStats.total = documents.length;

    // get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map((correspondent) => correspondent.name);

    // get existing document types list
    const existingDocumentTypesList = existingDocumentTypes.map((docType) => docType.name);

    // Extract tag names from tag objects
    const existingTagNames = existingTags.map((tag) => tag.name);

    for (const doc of documents) {
      if (scanControl.stopRequested) {
        scanStats.stopRequested = true;
        console.info(`Graceful stop requested. Halting scan before next document (source=${scanControl.source || 'unknown'})`);
        break;
      }

      try {
        const result = await processDocument(doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId);
        if (!result) {
          scanStats.skipped += 1;
          continue;
        }

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
        scanStats.processed += 1;
      } catch (error) {
        await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
        scanStats.failed += 1;
        console.error(`[ERROR] processing document ${doc.id}: ${error.message}`);
        console.debug(error);
      }
    }
  } catch (error) {
    console.error(`[ERROR] during document scan: ${error.message}`);
    console.debug(error);
  } finally {
    const durationMs = Date.now() - scanStartedAtMs;
    console.info(
      `Scan completed (source=${scanStats.source}, total=${scanStats.total}, processed=${scanStats.processed}, skipped=${scanStats.skipped}, failed=${scanStats.failed}, stopRequested=${scanStats.stopRequested}, durationMs=${durationMs})`
    );

    scanControl.running = false;
    scanControl.stopRequested = false;
    scanControl.source = null;
    scanControl.startedAt = null;
    scanControl.stopRequestedAt = null;
  }
}

// Routes
app.use('/', setupRoutes);

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

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Checks if the application is properly configured and the database is reachable.
 *       This endpoint can be used by monitoring systems to verify service health.
 *       
 *       The endpoint returns a 200 status code with a "healthy" status if everything is 
 *       working correctly, or a 503 status code with error details if there are issues.
 *     tags: [System]
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
 *                   example: "healthy"
 *                   description: Health status indication
 *       503:
 *         description: System is not fully configured or database is unreachable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [not_configured, error]
 *                   example: "not_configured"
 *                   description: Error status type
 *                 message:
 *                   type: string
 *                   example: "Application setup not completed"
 *                   description: Detailed error message
 */
app.get('/health', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ 
        status: 'not_configured',
        message: 'Application setup not completed'
      });
    }

    await documentModel.isDocumentProcessed(1);
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error(`Health check failed: ${error.message}`);
    console.debug(error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start scanning
async function startScanning() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    console.log('Configured scan interval:', config.scanInterval);
    console.log(`Starting initial scan at ${new Date().toISOString()}`);
    if(config.disableAutomaticProcessing != 'yes') {
      await scanInitial();
  
      cron.schedule(config.scanInterval, async () => {
        console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
        await scanDocuments();
      });
    }

    // Reconciliation: remove stale documents deleted in Paperless-ngx
    if (config.reconciliationEnabled) {
      console.log('Configured reconciliation interval:', config.reconciliationInterval);
      cron.schedule(config.reconciliationInterval, async () => {
        console.debug(`[RECONCILIATION] Scheduled run triggered at ${new Date().toISOString()}`);
        await reconciliationService.reconcileAllDocuments();
      });
    } else {
      console.info('[RECONCILIATION] Automatic reconciliation is disabled (RECONCILIATION_ENABLED=no).');
    }
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
