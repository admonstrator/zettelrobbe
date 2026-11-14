// @ts-check
'use strict';

/**
 * Password-protected PDFs: whether a file needs a password to be opened, and
 * which of a list of candidates opens it.
 *
 * Shells out to poppler's `pdfinfo`, which the image already ships for the
 * OCR page renderer, so nothing new is installed. Only a user password stops
 * a PDF from being read; a file that merely carries an owner password
 * (printing or copying restrictions) opens without one and does not count as
 * protected, which is the same line Paperless-ngx draws before it decrypts.
 *
 * A candidate is tried as user password and as owner password, because the
 * decryption in Paperless-ngx accepts either. Passwords travel as arguments
 * of a child process without a shell, so nothing in them is interpreted; they
 * are visible in the process list of the container while pdfinfo runs, which
 * is the price of not adding a PDF library.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const PDFINFO_TIMEOUT_MS = 10000;
const MAX_STDIO_BUFFER_BYTES = 256 * 1024;
/** Exactly how poppler reports a missing or wrong user password. */
const INCORRECT_PASSWORD = /incorrect password/i;

/**
 * @typedef {(file: string, args: string[], options: object) => Promise<{ stdout: string, stderr: string }>} ExecFile
 */

/**
 * The stored password list as a list. The setting holds a JSON array, so a
 * password may contain commas, quotes or spaces; a plain text value (one
 * password per line) is read as well, for a list typed into the environment
 * by hand. Empty entries and repeats are dropped, the order is kept.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function parsePasswordList(raw) {
  /** @type {unknown[]} */
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        items = text.split(/\r?\n/);
      }
    } else {
      items = text.split(/\r?\n/);
    }
  }
  /** @type {string[]} */
  const list = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    // Leading and trailing blanks are almost always a typing accident in a
    // list of one password per line; inner blanks are kept.
    const password = item.trim();
    if (password && !list.includes(password)) list.push(password);
  }
  return list;
}

/**
 * @param {string[]} list
 * @returns {string}
 */
function serializePasswordList(list) {
  return list.length ? JSON.stringify(list) : '';
}

/**
 * Whether the bytes are a PDF. The header may follow a little junk, which
 * PDF readers tolerate, so the first kilobyte is searched.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.subarray(0, 1024).includes('%PDF-');
}

class PdfPasswordService {
  constructor() {
    /** @type {ExecFile} Instance property so tests can inject a fake. */
    this._execFile = /** @type {ExecFile} */ (
      /** @type {unknown} */ (promisify(execFile))
    );
  }

  /**
   * Runs pdfinfo on the file, optionally with a password.
   *
   * @param {string} filePath
   * @param {string[]} passwordArgs e.g. ['-upw', 'secret']
   * @returns {Promise<{ ok: boolean, incorrectPassword: boolean, missingTool: boolean }>}
   */
  async _probe(filePath, passwordArgs) {
    try {
      await this._execFile('pdfinfo', [...passwordArgs, filePath], {
        timeout: PDFINFO_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_STDIO_BUFFER_BYTES,
      });
      return { ok: true, incorrectPassword: false, missingTool: false };
    } catch (error) {
      const err = /** @type {{ code?: unknown, stderr?: unknown }} */ (error);
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
        return { ok: false, incorrectPassword: false, missingTool: true };
      }
      return {
        ok: false,
        incorrectPassword: INCORRECT_PASSWORD.test(String(err?.stderr || '')),
        missingTool: false,
      };
    }
  }

  /**
   * Writes the bytes to a private temporary file for the duration of fn.
   *
   * @template T
   * @param {Buffer} buffer
   * @param {(filePath: string) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withTempFile(buffer, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zr-pdf-unlock-'));
    try {
      const filePath = path.join(dir, 'document.pdf');
      await fs.writeFile(filePath, buffer, { mode: 0o600 });
      return await fn(filePath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Whether the file is a PDF that cannot be opened without a password.
   * A file that is no PDF, a damaged PDF and a missing pdfinfo all answer
   * false: those are not this service's case, and the OCR run that asked
   * goes on to fail or succeed for its own reasons.
   *
   * @param {Buffer} buffer
   * @returns {Promise<boolean>}
   */
  async needsPassword(buffer) {
    if (!isPdf(buffer)) return false;
    return this._withTempFile(buffer, async (filePath) => {
      const result = await this._probe(filePath, []);
      if (result.missingTool) {
        console.warn(
          '[OCR] pdfinfo is not available; password-protected PDFs cannot be recognised'
        );
      }
      return result.incorrectPassword;
    });
  }

  /**
   * The first candidate that opens the file, or null when none does.
   *
   * @param {Buffer} buffer
   * @param {string[]} candidates
   * @returns {Promise<string|null>}
   */
  async findPassword(buffer, candidates) {
    const list = parsePasswordList(candidates);
    if (!list.length || !isPdf(buffer)) return null;
    return this._withTempFile(buffer, async (filePath) => {
      for (const password of list) {
        for (const flag of ['-upw', '-opw']) {
          const result = await this._probe(filePath, [flag, password]);
          if (result.ok) return password;
          if (result.missingTool) {
            throw new Error(
              'pdfinfo (poppler-utils) is not installed, so passwords cannot be checked'
            );
          }
        }
      }
      return null;
    });
  }
}

// The singleton plus the pure helpers, which the settings catalogue uses
// without touching any process.
module.exports = Object.assign(new PdfPasswordService(), {
  parsePasswordList,
  serializePasswordList,
  isPdf,
});
