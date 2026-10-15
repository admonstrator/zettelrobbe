/**
 * The write-back half of document processing, shared by every path that
 * analyses a document: the scheduled scan (server.js), the manual queue
 * (routes/setup.js) and the OCR service.
 *
 * Each of the three used to carry its own copy of these steps, and the copies
 * drifted: the queue marked documents as processed when Paperless-ngx had
 * rejected the update, and the OCR path dropped custom fields and never saved
 * the snapshot "restore original" needs.
 */

const config = require('../config/config');
const paperlessService = require('./paperlessService');
const documentModel = require('../models/document');
const dashboardStatsService = require('./dashboardStatsService');
const { validateCustomFieldValue } = require('./serviceUtils');

class DocumentProcessingService {
  /**
   * Build the Paperless-ngx update payload for one analysed document.
   *
   * Honours the activate* feature toggles and the restrictToExisting*
   * settings. The returned object may carry keys starting with an underscore
   * (history-only data), which
   * {@link DocumentProcessingService#saveDocumentChanges} strips before the
   * payload is sent.
   *
   * @param {{document: Object}} analysis Result of the AI service.
   * @param {Object} doc Paperless-ngx document the analysis belongs to.
   * @returns {Promise<Object>} Update payload for paperlessService.updateDocument().
   */
  async buildUpdateData(analysis, doc) {
    const updateData = {};
    const options = {
      restrictToExistingTags: config.restrictToExistingTags === 'yes',
      restrictToExistingCorrespondents:
        config.restrictToExistingCorrespondents === 'yes',
      restrictToExistingDocumentTypes:
        config.restrictToExistingDocumentTypes === 'yes',
      // For the creation guard's record of which document a mapping served.
      documentId: doc?.id ?? null,
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
    } else if (config.addAIProcessedTag === 'yes') {
      // The completion tag is the app's own bookkeeping, and processTags()
      // applies it itself — also for an empty list. Passing the name in as a
      // subject tag as well only ever worked because the function de-duplicates
      // the ids at the end.
      console.debug(
        'Tagging is deactivated but the AI processed tag will still be added'
      );
      const { tagIds, errors } = await paperlessService.processTags(
        [],
        options
      );
      if (errors.length > 0) {
        console.warn('[ERROR] Some tags could not be processed:', errors);
      }
      updateData.tags = tagIds;
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
          updateData._documentTypeNameForHistory =
            documentType.name || analysis.document.document_type;
        }
      } catch (error) {
        console.error(
          `[ERROR] Error processing document type: ${error.message}`
        );
        console.debug(error);
      }
    }

    // Only process custom fields if custom fields detection is activated
    if (
      config.limitFunctions?.activateCustomFields !== 'no' &&
      analysis.document.custom_fields
    ) {
      await this._addCustomFields(
        analysis.document.custom_fields,
        doc,
        updateData
      );
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
          updateData._correspondentNameForHistory =
            correspondent.name || analysis.document.correspondent;
        }
      } catch (error) {
        console.error(
          `[ERROR] Error processing correspondent: ${error.message}`
        );
        console.debug(error);
      }
    }

    // Always include language if provided as it's a core field
    if (analysis.document.language) {
      updateData.language = analysis.document.language;
    }

    return updateData;
  }

  /**
   * Merge the analysed custom field values into the document's existing ones.
   *
   * @param {Object} customFields custom_fields of the analysis (array or index map).
   * @param {Object} doc
   * @param {Object} updateData Receives custom_fields and _customFieldsForHistory.
   * @private
   */
  async _addCustomFields(customFields, doc, updateData) {
    const processedFields = [];
    const customFieldsForHistory = [];

    const existingFields = await paperlessService.getExistingCustomFields(
      doc.id
    );
    console.debug('Found existing fields:', existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const customField of Object.values(customFields)) {
      if (!customField || typeof customField !== 'object') {
        console.debug('Skipping null/invalid custom field entry');
        continue;
      }

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

  /**
   * Send the update to Paperless-ngx and record the result locally.
   *
   * Saves the pre-AI state first, so a failed update leaves a document that
   * can still be restored, and only writes the processed/history/metrics rows
   * after Paperless-ngx has accepted the change.
   *
   * @param {number} docId
   * @param {Object} updateData Payload from {@link DocumentProcessingService#buildUpdateData}.
   * @param {{document: Object, metrics?: Object}} analysis
   * @param {Object} originalData The document as Paperless-ngx had it before.
   * @returns {Promise<void>}
   * @throws {Error} When Paperless-ngx rejects the update.
   */
  async saveDocumentChanges(docId, updateData, analysis, originalData) {
    const {
      tags: originalTags,
      correspondent: originalCorrespondent,
      title: originalTitle,
    } = originalData;

    // Pull out history-only data and remove it before sending updateData to
    // Paperless. The history records what was written, so correspondent and
    // document type are the names Paperless-ngx has — which differ from the
    // model's answer whenever an existing entry or another spelling was used —
    // and stay empty when nothing was set.
    const historyCustomFields = updateData._customFieldsForHistory || null;
    const historyCorrespondentName =
      updateData._correspondentNameForHistory ?? null;
    const historyDocTypeName = updateData._documentTypeNameForHistory ?? null;
    delete updateData._customFieldsForHistory;
    delete updateData._correspondentNameForHistory;
    delete updateData._documentTypeNameForHistory;

    const historyLanguage = analysis.document.language ?? null;
    const origDocType = originalData.document_type ?? null;
    const origLanguage = originalData.language ?? null;
    const recordedTitle = updateData.title || originalTitle;

    // Predefined-scan trigger tags have done their job once the document has
    // been processed; leaving them in place would make the next scan re-run
    // the document forever. Removal only happens when the operator opts in.
    if (
      config.predefinedMode === 'yes' &&
      config.removeTriggerTags === 'yes' &&
      Array.isArray(updateData.tags)
    ) {
      try {
        const triggerNames = (process.env.TAGS || '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);
        if (triggerNames.length > 0) {
          updateData.removeTagIds =
            await paperlessService.resolveTagIdsByName(triggerNames);
        }
      } catch (error) {
        console.warn(
          `[WARN] Could not resolve trigger tags for removal on document ${docId}:`,
          error.message
        );
      }
    }

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
      documentModel.addProcessedDocument(docId, recordedTitle),
      documentModel.addToHistory(
        docId,
        updateData.tags || [],
        recordedTitle,
        historyCorrespondentName,
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

    // Document counters and token figures just moved. Every path that writes
    // processed_documents has to say so, or the dashboard serves numbers from
    // before the change for up to a full TTL.
    dashboardStatsService.invalidate();
  }
}

module.exports = new DocumentProcessingService();
