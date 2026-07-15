// services/popplerService.js
//
// Poppler Service – renders PDF pages to PNG images by shelling out to the
// system `pdftoppm` binary (poppler-utils). Used by the OCR pipeline so that
// local vision models receive real page images instead of a single
// first-page thumbnail. Deliberately config-free: callers pass maxPages and
// dpi explicitly, which keeps this service trivially unit-testable.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT_MS = 5000;
const RENDER_TIMEOUT_MS = 60000;
// pdftoppm writes images to files; stdout/stderr only carry diagnostics.
const MAX_STDIO_BUFFER_BYTES = 1024 * 1024;
// Defensive cap so a single rendered page cannot blow up request payloads.
const MAX_PAGE_FILE_BYTES = 32 * 1024 * 1024;

class PopplerService {
  constructor() {
    // Instance property so tests can inject a fake execFile implementation.
    this._execFile = promisify(execFile);
    this._availabilityPromise = null;
  }

  /**
   * Whether the system pdftoppm binary is usable. Memoized per process.
   * Only a missing/inaccessible binary counts as unavailable: poppler tools
   * print version info to stderr and the exit code of `-v` is not reliable
   * across poppler versions.
   * @returns {Promise<boolean>}
   */
  isAvailable() {
    if (!this._availabilityPromise) {
      this._availabilityPromise = this._probePdftoppm();
    }
    return this._availabilityPromise;
  }

  async _probePdftoppm() {
    try {
      await this._execFile('pdftoppm', ['-v'], { timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        return false;
      }
      const output = `${error?.stdout || ''}${error?.stderr || ''}`;
      return output.toLowerCase().includes('pdftoppm');
    }
  }

  /**
   * Render the first pages of a PDF to PNG images via pdftoppm.
   * @param {Buffer} pdfBuffer - raw PDF bytes
   * @param {{maxPages: number, dpi: number}} options
   * @returns {Promise<{
   *   pages: Array<{base64: string, mimeType: string, pageNumber: number}>,
   *   totalPages: number|null,
   *   truncated: boolean
   * }>}
   */
  async renderPdfToImages(pdfBuffer, { maxPages, dpi }) {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'paperless-ai-ocr-')
    );

    try {
      const inputPath = path.join(tempDir, 'input.pdf');
      const outputPrefix = path.join(tempDir, 'page');
      await fs.writeFile(inputPath, pdfBuffer);

      let renderError = null;
      try {
        await this._execFile(
          'pdftoppm',
          [
            '-png',
            '-r',
            String(dpi),
            '-f',
            '1',
            '-l',
            String(maxPages),
            inputPath,
            outputPrefix,
          ],
          {
            timeout: RENDER_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_STDIO_BUFFER_BYTES,
          }
        );
      } catch (error) {
        // Keep going: mildly corrupt PDFs often yield a non-zero exit code
        // after successfully rendering some pages.
        renderError = error;
      }

      const pageFiles = (await fs.readdir(tempDir))
        .map((name) => {
          const match = /^page-(\d+)\.png$/.exec(name);
          return match
            ? { name, pageNumber: Number.parseInt(match[1], 10) }
            : null;
        })
        .filter(Boolean)
        // pdftoppm zero-pads page numbers based on the document's total page
        // count, so numbers must be compared numerically, not lexically.
        .sort((a, b) => a.pageNumber - b.pageNumber);

      if (pageFiles.length === 0) {
        const detail = String(
          renderError?.stderr || renderError?.message || 'no output produced'
        ).trim();
        throw new Error(`pdftoppm failed to render any page: ${detail}`);
      }

      if (renderError) {
        const detail = String(
          renderError.stderr || renderError.message || ''
        ).trim();
        console.warn(
          `[OCR] pdftoppm exited with an error after rendering ${pageFiles.length} page(s), continuing with partial output: ${detail}`
        );
      }

      const pages = [];
      for (const { name, pageNumber } of pageFiles) {
        const fileBuffer = await fs.readFile(path.join(tempDir, name));
        if (fileBuffer.length > MAX_PAGE_FILE_BYTES) {
          console.warn(
            `[OCR] Skipping rendered page ${pageNumber}: image is ${fileBuffer.length} bytes (limit ${MAX_PAGE_FILE_BYTES})`
          );
          continue;
        }
        pages.push({
          base64: fileBuffer.toString('base64'),
          mimeType: 'image/png',
          pageNumber,
        });
      }

      if (pages.length === 0) {
        throw new Error('pdftoppm produced only oversized page images');
      }

      // Only when the page limit was hit is the total page count interesting
      // (for an accurate truncation warning). pdfinfo is best-effort.
      let totalPages = null;
      if (pageFiles.length >= maxPages) {
        totalPages = await this._readTotalPages(inputPath);
      }
      const truncated =
        pageFiles.length >= maxPages &&
        (totalPages === null || totalPages > maxPages);

      return { pages, totalPages, truncated };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _readTotalPages(inputPath) {
    try {
      const { stdout } = await this._execFile('pdfinfo', [inputPath], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_STDIO_BUFFER_BYTES,
      });
      const match = /^Pages:\s+(\d+)/m.exec(String(stdout));
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }
}

module.exports = new PopplerService();
