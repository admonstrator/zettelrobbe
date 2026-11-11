const crypto = require('crypto');
const config = require('../config/config');
const documentModel = require('../models/document');
const paperlessService = require('./paperlessService');
const setupService = require('./setupService');

/**
 * Below this many characters a text is too generic to stand for one document:
 * two one-line receipts would otherwise count as the same text.
 */
const MIN_FINGERPRINT_LENGTH = 200;

/** Page limits offered when a long document is skipped by hand. */
const PAGE_LIMIT_STEPS = [10, 20, 30, 50, 100, 200, 500, 1000];

/** Dates, years and other numbers say nothing about the next copy. */
const MONTHS =
  'jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|apr(?:il)?|jun[ei]?|jul[yi]?|aug(?:ust)?|sept?(?:ember)?|o[ck]t(?:ober)?|nov(?:ember)?|de[cz](?:ember)?';
const NUMBERS_AND_DATES = new RegExp(
  `(?<![a-z0-9])\\d[\\d./,-]*(?![a-z0-9])|(?<![a-zäöü])(?:${MONTHS})\\.?(?![a-zäöü])`,
  'gi'
);

/**
 * Title parts worth suggesting: the title without dates and numbers, each part
 * of it between dashes, colons or pipes, and the file name without its
 * extension. A part that is only the correspondent's name goes last, since it
 * would also skip that correspondent's invoices.
 *
 * @returns {string[]} at most four, the first is the proposal
 */
function suggestTitleParts(title, fileName, correspondentName) {
  const clean = (value) =>
    String(value || '')
      .replace(NUMBERS_AND_DATES, ' ')
      .replace(/[_\s]+/g, (match) => (match.includes('_') ? '_' : ' '))
      .replace(/^[\s_\-–—:|,.()]+|[\s_\-–—:|,.()]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const titleParts = String(title || '')
    .split(/\s[-–—|:]\s|\s*[|:]\s*/)
    .map(clean);
  const cleanedFileName = clean(
    String(fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '')
  );
  const correspondent = String(correspondentName || '')
    .trim()
    .toLowerCase();

  const candidates = [...titleParts, clean(title), cleanedFileName].filter(
    (part) => part.length >= 3
  );
  const seen = new Set();
  const unique = candidates.filter((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isCorrespondent = (part) =>
    correspondent && part.toLowerCase() === correspondent;
  return [
    ...unique.filter((part) => !isCorrespondent(part)),
    ...unique.filter(isCorrespondent),
  ].slice(0, 4);
}

/** The largest step below the page count, or null for a short document. */
function suggestPageLimit(pageCount) {
  const pages = Number(pageCount);
  if (!Number.isInteger(pages) || pages <= PAGE_LIMIT_STEPS[0]) {
    return null;
  }
  return PAGE_LIMIT_STEPS.filter((step) => step < pages).pop() || null;
}

/**
 * Skip rules decide, before any OCR or AI call, that a document is not worth
 * processing: too many pages, a title on the skip list, or the same text as a
 * document already on the ignored list. A match puts the document on the
 * ignored list with the rule as its reason, so it is visible and reversible.
 * A document taken off that list by hand is exempt from the rules.
 */
class SkipRuleService {
  /**
   * Fingerprint of a document text: whitespace and case do not count, so the
   * same terms with a different line break still match.
   *
   * @param {string} content
   * @returns {string|null} sha256 hex, or null for a text too short to compare
   */
  fingerprint(content) {
    const normalized = String(content || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized.length < MIN_FINGERPRINT_LENGTH) {
      return null;
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * @param {{id: number, title?: string, original_file_name?: string, page_count?: number}} doc
   *   The full Paperless-ngx document.
   * @param {string} [content] The text Paperless-ngx recognised.
   * @returns {Promise<{reason: string, contentHash: string|null}|null>}
   */
  async evaluate(doc, content) {
    if (!doc || (await documentModel.isSkipRuleExempt(doc.id))) {
      return null;
    }

    const rules = config.getSkipRulesConfig();
    const contentHash = this.fingerprint(content);

    const pageCount = Number(doc.page_count);
    if (rules.maxPageCount > 0 && pageCount > rules.maxPageCount) {
      return {
        reason: `Page limit: ${pageCount} pages (max ${rules.maxPageCount})`,
        contentHash,
      };
    }

    const names = [doc.title, doc.original_file_name]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    const pattern = rules.titlePatterns.find((candidate) =>
      names.some((name) => name.includes(candidate.toLowerCase()))
    );
    if (pattern) {
      return { reason: `Title matches "${pattern}"`, contentHash };
    }

    if (rules.ignoreRepeatedContent && contentHash) {
      const original =
        await documentModel.findIgnoredByContentHash(contentHash);
      if (original && Number(original.document_id) !== Number(doc.id)) {
        return {
          reason: `Same text as #${original.document_id}`,
          contentHash,
        };
      }
    }

    return null;
  }

  /**
   * Evaluates the rules and, on a match, moves the document to the ignored
   * list.
   *
   * @returns {Promise<{reason: string, contentHash: string|null}|null>} the match
   */
  async apply(doc, content) {
    const match = await this.evaluate(doc, content);
    if (!match) {
      return null;
    }

    await documentModel.addIgnoredDocument(
      doc.id,
      doc.title || '',
      match.reason,
      match.contentHash
    );
    await documentModel.clearProcessingStatusByDocumentId(doc.id);
    console.info(
      `Document ${doc.id} skipped before OCR and AI and moved to the ignored list (${match.reason})`
    );
    return match;
  }

  /**
   * What skipping one document by hand would propose: the document's facts and
   * a proposal for each rule. Nothing is changed.
   *
   * @param {number} documentId
   */
  async suggest(documentId) {
    const doc = await paperlessService.getDocument(documentId);
    if (!doc) {
      return null;
    }

    const correspondent = doc.correspondent
      ? await paperlessService
          .getCorrespondentNameById(doc.correspondent)
          .catch(() => null)
      : null;
    const rules = config.getSkipRulesConfig();
    const contentHash = this.fingerprint(doc.content);
    const pageCount = Number.isInteger(Number(doc.page_count))
      ? Number(doc.page_count)
      : null;

    const titleParts = suggestTitleParts(
      doc.title,
      doc.original_file_name,
      correspondent?.name
    ).filter(
      (part) =>
        !rules.titlePatterns.some(
          (pattern) => pattern.toLowerCase() === part.toLowerCase()
        )
    );
    const titleSuggestions = [];
    for (const part of titleParts) {
      titleSuggestions.push({
        pattern: part,
        historyMatches: await documentModel.countHistoryTitlesContaining(
          part,
          doc.id
        ),
      });
    }

    const suggestedLimit = suggestPageLimit(pageCount);
    return {
      document: {
        id: doc.id,
        title: doc.title || '',
        fileName: doc.original_file_name || '',
        pageCount,
        correspondent: correspondent?.name || null,
        characters: String(doc.content || '').length,
      },
      sameText: {
        available: Boolean(contentHash),
        enabled: rules.ignoreRepeatedContent,
      },
      title: {
        suggestions: titleSuggestions,
        existing: rules.titlePatterns,
      },
      pageLimit: {
        current: rules.maxPageCount,
        // Only when the current limit would not already catch this document.
        suggested:
          suggestedLimit &&
          !(rules.maxPageCount > 0 && rules.maxPageCount < pageCount)
            ? suggestedLimit
            : null,
      },
    };
  }

  /**
   * Skips one document by hand: puts it on the ignored list and stores the
   * rules chosen for documents like it.
   *
   * @param {number} documentId
   * @param {{sameText?: boolean, titlePattern?: string|null, pageLimit?: number|null}} choice
   * @returns {Promise<{rules: string[], notSaved: string[]}>} rules applied, and
   *   settings the container fixes so they could not be changed here
   */
  async skipDocument(documentId, choice = {}) {
    const doc = await paperlessService.getDocument(documentId);
    if (!doc) {
      const error = new Error(`Document ${documentId} not found`);
      error.status = 404;
      throw error;
    }

    const contentHash =
      choice.sameText === false ? null : this.fingerprint(doc.content);
    await documentModel.addIgnoredDocument(
      doc.id,
      doc.title || '',
      'manual',
      contentHash
    );
    await documentModel.clearProcessingStatusByDocumentId(doc.id);

    const rules = ['this document'];
    if (contentHash) rules.push('copies with the same text');

    const current = config.getSkipRulesConfig();
    const updates = {};
    const pattern = String(choice.titlePattern || '')
      .replace(/[,;\n\r]/g, ' ')
      .trim();
    if (pattern) {
      const known = current.titlePatterns.some(
        (existing) => existing.toLowerCase() === pattern.toLowerCase()
      );
      if (!known) {
        updates.IGNORE_TITLE_PATTERNS = [
          ...current.titlePatterns,
          pattern,
        ].join(',');
      }
      rules.push(`title contains "${pattern}"`);
    }
    const pageLimit = Number(choice.pageLimit);
    if (Number.isInteger(pageLimit) && pageLimit > 0) {
      updates.MAX_PAGE_COUNT = String(pageLimit);
      rules.push(`page limit ${pageLimit}`);
    }

    const notSaved = Object.keys(updates).filter((key) =>
      config.isProtectedRuntimeEnvKey(key)
    );
    if (Object.keys(updates).length > notSaved.length) {
      await setupService.updateConfigValues(updates);
    }

    console.info(
      `Document ${doc.id} skipped by hand with rules: ${rules.join(', ')}`
    );
    return { rules, notSaved };
  }

  /**
   * Stores the text fingerprint of documents put on the ignored list by hand,
   * so later copies are recognised. Fetches the text from Paperless-ngx one
   * document at a time; a failure only means that copy is not recognised.
   *
   * @param {Array<number>} documentIds
   */
  async rememberFingerprints(documentIds) {
    for (const documentId of documentIds) {
      try {
        const content = await paperlessService.getDocumentContent(documentId);
        const contentHash = this.fingerprint(content);
        if (contentHash) {
          await documentModel.setIgnoredContentHash(documentId, contentHash);
        }
      } catch (error) {
        console.warn(
          `Could not store the text fingerprint of ignored document ${documentId}: ${error.message}`
        );
      }
    }
  }
}

module.exports = new SkipRuleService();
module.exports.suggestTitleParts = suggestTitleParts;
module.exports.suggestPageLimit = suggestPageLimit;
