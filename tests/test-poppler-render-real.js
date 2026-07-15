// Real-binary test for popplerService: renders a minimal in-memory PDF with
// the actual pdftoppm binary and checks the PNG output plus temp cleanup.
// The test runner skips this test when pdftoppm is not installed.

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');

const popplerService = require('../services/popplerService');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Builds a fully valid single-page empty PDF with a correct xref table.
function buildMinimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 144] >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function listOcrTempDirs() {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((name) => name.startsWith('paperless-ai-ocr-'));
}

async function main() {
  assert.strictEqual(
    await popplerService.isAvailable(),
    true,
    'pdftoppm should be available (the runner skips this test otherwise)'
  );

  const tempDirsBefore = await listOcrTempDirs();

  const result = await popplerService.renderPdfToImages(buildMinimalPdf(), {
    maxPages: 2,
    dpi: 72,
  });

  assert.strictEqual(
    result.pages.length,
    1,
    'Expected exactly one rendered page'
  );
  assert.strictEqual(result.pages[0].pageNumber, 1, 'Expected page number 1');
  assert.strictEqual(
    result.pages[0].mimeType,
    'image/png',
    'Expected PNG output'
  );
  assert.strictEqual(
    result.truncated,
    false,
    'Expected no truncation below the page limit'
  );

  const pngBuffer = Buffer.from(result.pages[0].base64, 'base64');
  assert.ok(
    pngBuffer.subarray(0, 4).equals(PNG_MAGIC),
    'Expected rendered page to start with the PNG magic bytes'
  );

  const tempDirsAfter = await listOcrTempDirs();
  assert.deepStrictEqual(
    tempDirsAfter,
    tempDirsBefore,
    'Expected the render temp directory to be cleaned up'
  );

  // Invalid input must throw (and still clean up its temp dir).
  await assert.rejects(
    popplerService.renderPdfToImages(Buffer.from('not a pdf'), {
      maxPages: 2,
      dpi: 72,
    }),
    /pdftoppm failed to render any page/,
    'Expected rejection for non-PDF input'
  );
  assert.deepStrictEqual(
    await listOcrTempDirs(),
    tempDirsBefore,
    'Expected temp cleanup after a failed render'
  );
}

main()
  .then(() => {
    console.log(
      '[PASS] popplerService renders PDFs to PNG pages with pdftoppm and cleans up'
    );
  })
  .catch((error) => {
    console.error('[FAIL] poppler real render test failed:', error.message);
    process.exitCode = 1;
  });
