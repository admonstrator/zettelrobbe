const fs = require('fs');
const util = require('util');
const path = require('path');

const LOG_LEVEL_WEIGHTS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const normalizeLogLevel = (value) => {
  if (!value) {
    return 'info';
  }

  const normalized = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_WEIGHTS, normalized)
    ? normalized
    : 'info';
};

/** What replaces a secret in a log line. */
const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Environment variables whose current value must never appear in a log file.
 *
 * This is the reliable half of the redaction: matching on the value catches a
 * token however it was printed — inside an inspected axios error, in a URL, in
 * a copy of a request body — where a pattern for the surrounding syntax would
 * not.
 */
const SECRET_ENV_KEYS = [
  'PAPERLESS_API_TOKEN',
  'OPENAI_API_KEY',
  'CUSTOM_API_KEY',
  'AZURE_API_KEY',
  'OLLAMA_API_KEY',
  'MISTRAL_API_KEY',
  'OCR_API_KEY',
  'JWT_SECRET',
  'API_KEY',
  'PAPERLESS_AI_API_KEY',
  'EXTERNAL_API_KEY',
];

/**
 * Below this length a value is too generic to blank out by substring: a
 * three-character API_KEY would censor every log line that happens to contain
 * those characters, which hides more than it protects.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 8;

/**
 * Patterns for credentials that are not in the environment — a bearer token
 * from a provider response, an API key typed into a request, the Authorization
 * header of an inspected axios error. Keys may be quoted (util.inspect prints
 * `'x-api-key': 'value'`), values quoted or bare.
 */
const SECRET_KEY_NAMES =
  '(?:authorization|proxy-authorization|x-api-key|api-key|apikey|api_key|access_token|refresh_token)';
const QUOTED_SECRET_PATTERN = new RegExp(
  `(${SECRET_KEY_NAMES}["']?\\s*[:=]\\s*)(["'])(?:[^"'\\\\]|\\\\.)*\\2`,
  'gi'
);
const BARE_SECRET_PATTERN = new RegExp(
  `(${SECRET_KEY_NAMES}["']?\\s*[:=]\\s*)([^\\s,;'"}\\]]+)`,
  'gi'
);
/** The characters a credential is built from — base64url plus the usual separators. */
const CREDENTIAL_CHARS = '[A-Za-z0-9\\-._~+/=]';

/**
 * `Bearer eyJ…` — the scheme survives, the credential does not.
 *
 * "Bearer" only ever appears as an HTTP authentication scheme, so anything of
 * credential shape behind it is one.
 */
const BEARER_SECRET_PATTERN = new RegExp(
  `\\b(bearer)\\s+(${CREDENTIAL_CHARS}{8,})`,
  'gi'
);

/**
 * `Token abc123…`, `Basic dXNlcjpwdw==` — the same, but choosier.
 *
 * "Token" and "Basic" are also ordinary English words that this app logs:
 * `[DEBUG] Token calculation - Prompt: 192, Reserved: 1192` and
 * `[WARNING] Token truncation failed for model gpt-4o` come out of the provider
 * services on every run. Blanking those would hide the numbers the line exists
 * for. So the value only counts as a credential when it looks like one: it
 * carries a digit, or it is longer than any word that would follow "Token" in
 * a sentence.
 */
const TOKEN_SECRET_PATTERN = new RegExp(
  `\\b(token|basic)\\s+((?=${CREDENTIAL_CHARS}*\\d)${CREDENTIAL_CHARS}{8,}|${CREDENTIAL_CHARS}{24,})`,
  'gi'
);

/**
 * Blanks out credentials in a rendered log line.
 *
 * Two layers, because neither is sufficient alone: the patterns catch secrets
 * this process never held (a provider's own bearer token echoed in an error),
 * and the environment values catch our own secrets however they were printed.
 * util.inspect() of an axios error renders `config.headers.Authorization`
 * verbatim — that is how the Paperless-ngx token reached data/logs/logs.txt at
 * the default log level, in exactly the files users attach to bug reports.
 *
 * @param {string} message
 * @returns {string}
 */
function redactSecrets(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return message;
  }

  let redacted = message
    .replace(QUOTED_SECRET_PATTERN, `$1$2${REDACTION_PLACEHOLDER}$2`)
    .replace(BARE_SECRET_PATTERN, `$1${REDACTION_PLACEHOLDER}`)
    .replace(BEARER_SECRET_PATTERN, `$1 ${REDACTION_PLACEHOLDER}`)
    .replace(TOKEN_SECRET_PATTERN, `$1 ${REDACTION_PLACEHOLDER}`);

  for (const secret of currentSecretValues()) {
    redacted = redacted.split(secret).join(REDACTION_PLACEHOLDER);
  }

  return redacted;
}

/**
 * The secret environment values as they stand right now, deduplicated.
 *
 * Read per call rather than at load time because the settings page writes new
 * credentials onto process.env at runtime; the joined snapshot is cached so a
 * log line normally costs a few property reads and one string compare.
 */
let secretValueCache = { snapshot: null, values: [] };

function currentSecretValues() {
  const raw = SECRET_ENV_KEYS.map((key) => process.env[key] || '');
  const snapshot = JSON.stringify(raw);
  if (secretValueCache.snapshot === snapshot) {
    return secretValueCache.values;
  }

  const values = [
    ...new Set(
      raw
        .map((value) => String(value).trim())
        .filter((value) => value.length >= MIN_REDACTABLE_SECRET_LENGTH)
    ),
  ]
    // Longest first: a token that contains a shorter one must be blanked as a
    // whole rather than left with a [redacted] hole in the middle.
    .sort((a, b) => b.length - a.length);

  secretValueCache = { snapshot, values };
  return values;
}

class Logger {
  constructor(options = {}) {
    this.logFile = options.logFile || 'application.log';
    this.logDir = options.logDir || 'logs';
    this.timestamp = options.timestamp !== false;
    this.format = options.format || 'txt';
    this.maxFileSize = options.maxFileSize || 1024 * 1024 * 10; // Standard: 10MB

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.logPath = path.join(this.logDir, this.logFile);
    /** Set once the sink turned out to be unwritable, so it is reported once. */
    this.writeFailureReported = false;

    // Initialise the log file
    this.initLogFile();

    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    };

    const requestedLogLevel =
      options.logLevel || process.env.LOG_LEVEL || 'info';
    this.logLevel = normalizeLogLevel(requestedLogLevel);
    if (String(requestedLogLevel).trim().toLowerCase() !== this.logLevel) {
      this.originalConsole.warn(
        `[WARN] Invalid LOG_LEVEL "${requestedLogLevel}". Falling back to "info".`
      );
    }

    this.overrideConsoleMethods();
  }

  shouldLog(type) {
    const currentWeight =
      LOG_LEVEL_WEIGHTS[this.logLevel] || LOG_LEVEL_WEIGHTS.info;
    const messageWeight = LOG_LEVEL_WEIGHTS[type] || LOG_LEVEL_WEIGHTS.info;
    return messageWeight >= currentWeight;
  }

  initLogFile() {
    // Drop the file if it grew past the size cap
    if (this.checkFileSize()) {
      try {
        fs.unlinkSync(this.logPath);
      } catch {
        // Nothing to remove if the file does not exist
      }
    }

    // The HTML sink needs its header before the first entry
    if (this.format === 'html') {
      this.initHtmlFile();
    }
  }

  checkFileSize() {
    if (fs.existsSync(this.logPath)) {
      const stats = fs.statSync(this.logPath);
      return stats.size >= this.maxFileSize;
    }
    return false;
  }

  initHtmlFile() {
    const htmlHeader = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Application Logs</title>
    <style>
        body {
            background-color: #1e1e1e;
            color: #ffffff;
            font-family: 'Consolas', 'Monaco', monospace;
            padding: 20px;
            margin: 0;
        }
        .log-container {
            background-color: #2d2d2d;
            border-radius: 5px;
            padding: 10px;
            max-width: 100%;
            overflow-x: auto;
        }
        .log-entry {
            padding: 3px 5px;
            margin: 2px 0;
            border-radius: 3px;
            white-space: pre-wrap;
        }
        .timestamp {
            color: #888888;
        }
        .type {
            font-weight: bold;
            margin: 0 5px;
        }
        .type-info { color: #4CAF50; }
        .type-error { color: #f44336; }
        .type-warn { color: #ff9800; }
        .type-debug { color: #2196F3; }
        .message { margin-left: 5px; }
        .auto-scroll {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #333;
            border: none;
            color: white;
            padding: 10px;
            border-radius: 5px;
            cursor: pointer;
        }
        .auto-scroll:hover {
            background: #444;
        }
    </style>
    <script>
        let autoScroll = true;
        function toggleAutoScroll() {
            autoScroll = !autoScroll;
            document.getElementById('autoScrollBtn').textContent =
                autoScroll ? 'Auto-Scroll: ON' : 'Auto-Scroll: OFF';
        }
        function scrollToBottom() {
            if (autoScroll) {
                window.scrollTo(0, document.body.scrollHeight);
            }
        }
        const observer = new MutationObserver(scrollToBottom);
        window.onload = () => {
            observer.observe(document.querySelector('.log-container'),
                { childList: true });
            scrollToBottom();
        };
    </script>
</head>
<body>
    <div class="log-container">
`;

    if (!fs.existsSync(this.logPath) || fs.statSync(this.logPath).size === 0) {
      fs.writeFileSync(this.logPath, htmlHeader);
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Turns console arguments into the single redacted string that both sinks
   * and the original console get to see. Rendering once is what makes the
   * guarantee hold: there is no second, unredacted rendering anywhere.
   *
   * @param {unknown[]} args
   * @returns {string}
   */
  renderMessage(args) {
    return redactSecrets(util.format(...args));
  }

  formatLogMessage(type, args) {
    return this.formatLogLine(type, this.renderMessage(args));
  }

  /**
   * Wraps an already-rendered, already-redacted message in the sink's format.
   * @param {string} type - debug | info | warn | error
   * @param {string} msg - redacted message text
   * @returns {string}
   */
  formatLogLine(type, msg) {
    if (this.format === 'html') {
      const timestamp = this.timestamp
        ? `<span class="timestamp">[${this.getTimestamp()}]</span>`
        : '';
      return `    <div class="log-entry">
        ${timestamp}
        <span class="type type-${type}">[${type.toUpperCase()}]</span>
        <span class="message">${this.escapeHtml(msg)}</span>
    </div>\n`;
    } else {
      return this.timestamp
        ? `[${this.getTimestamp()}] [${type.toUpperCase()}] ${msg}\n`
        : `[${type.toUpperCase()}] ${msg}\n`;
    }
  }

  escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '<br>')
      .replace(/\s/g, '&nbsp;');
  }

  /**
   * Appends a line to the sink, rotating first if the file grew past the cap.
   *
   * Never throws. Every console.* call in the process runs through here, so a
   * full disk, a read-only volume or a deleted log directory used to turn
   * `console.log` itself into an exception — a logging problem became a crash
   * in whatever code happened to be logging. The failure is reported once on
   * the real console and the process carries on without its log file.
   *
   * @param {string} message
   */
  writeToFile(message) {
    try {
      // Check the file size before writing
      if (this.checkFileSize()) {
        // Drop the old file
        fs.unlinkSync(this.logPath);

        // The HTML sink needs its header written again after rotation
        if (this.format === 'html') {
          this.initHtmlFile();
        }
      }

      fs.appendFileSync(this.logPath, message);
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  /**
   * Reports a broken log sink once per instance, on the console the logger
   * replaced. Once, because the report itself would otherwise be logged, fail
   * for the same reason, and report again.
   *
   * @param {Error} error
   */
  reportWriteFailure(error) {
    if (this.writeFailureReported) {
      return;
    }
    this.writeFailureReported = true;

    const report =
      this.originalConsole?.error ||
      // A failure during construction, before the console was captured.
      console.error;
    try {
      report(
        `[ERROR] Log file ${this.logPath} is not writable (${error && error.message}). ` +
          'Continuing without file logging.'
      );
    } catch {
      // Reporting a logging failure must not become one.
    }
  }

  /**
   * Replaces one console method with the redacting, file-writing version.
   *
   * The original console gets the rendered string rather than the raw
   * arguments: an object handed to console.error is inspected on its way to
   * the terminal too, and the terminal is where a `docker logs` ends up in a
   * bug report just like the log file does. One rendering, redacted once,
   * shown everywhere.
   *
   * @param {'log'|'error'|'warn'|'info'|'debug'} method - the console method to replace
   * @param {'debug'|'info'|'warn'|'error'} level - the level it logs at
   */
  installConsoleMethod(method, level) {
    console[method] = (...args) => {
      if (!this.shouldLog(level)) {
        return;
      }

      const message = this.renderMessage(args);
      this.originalConsole[method](message);
      this.writeToFile(this.formatLogLine(level, message));
    };
  }

  overrideConsoleMethods() {
    this.installConsoleMethod('log', 'info');
    this.installConsoleMethod('error', 'error');
    this.installConsoleMethod('warn', 'warn');
    this.installConsoleMethod('info', 'info');
    this.installConsoleMethod('debug', 'debug');
  }

  closeHtmlFile() {
    if (this.format === 'html') {
      const htmlFooter = `    </div>
    <button class="auto-scroll" id="autoScrollBtn" onclick="toggleAutoScroll()">
        Auto-Scroll: ON
    </button>
</body>
</html>`;
      this.writeToFile(htmlFooter);
    }
  }

  restore() {
    Object.assign(console, this.originalConsole);
    if (this.format === 'html') {
      this.closeHtmlFile();
    }
  }
}

module.exports = Logger;
