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

    // Initialisiere Log-Datei
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
    // Prüfe ob die Datei die maximale Größe überschreitet
    if (this.checkFileSize()) {
      // Lösche die alte Datei
      try {
        fs.unlinkSync(this.logPath);
      } catch {
        // Ignoriere Fehler wenn Datei nicht existiert
      }
    }

    // Initialisiere HTML-Datei wenn nötig
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

  formatLogMessage(type, args) {
    const msg = util.format(...args);
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

  writeToFile(message) {
    // Prüfe Dateigröße vor dem Schreiben
    if (this.checkFileSize()) {
      // Lösche die alte Datei
      fs.unlinkSync(this.logPath);

      // Bei HTML-Format müssen wir den Header neu schreiben
      if (this.format === 'html') {
        this.initHtmlFile();
      }
    }

    fs.appendFileSync(this.logPath, message);
  }

  overrideConsoleMethods() {
    console.log = (...args) => {
      if (!this.shouldLog('info')) {
        return;
      }

      const logMessage = this.formatLogMessage('info', args);
      this.originalConsole.log(...args);
      this.writeToFile(logMessage);
    };

    console.error = (...args) => {
      if (!this.shouldLog('error')) {
        return;
      }

      const logMessage = this.formatLogMessage('error', args);
      this.originalConsole.error(...args);
      this.writeToFile(logMessage);
    };

    console.warn = (...args) => {
      if (!this.shouldLog('warn')) {
        return;
      }

      const logMessage = this.formatLogMessage('warn', args);
      this.originalConsole.warn(...args);
      this.writeToFile(logMessage);
    };

    console.info = (...args) => {
      if (!this.shouldLog('info')) {
        return;
      }

      const logMessage = this.formatLogMessage('info', args);
      this.originalConsole.info(...args);
      this.writeToFile(logMessage);
    };

    console.debug = (...args) => {
      if (!this.shouldLog('debug')) {
        return;
      }

      const logMessage = this.formatLogMessage('debug', args);
      this.originalConsole.debug(...args);
      this.writeToFile(logMessage);
    };
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
