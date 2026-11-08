'use strict';

const config = require('../config/config');
const { normalizeProvider, transportFor } = require('./aiProviderRules');
const openaiCompatibleService = require('./openaiCompatibleService');
const ollamaService = require('./ollamaService');
const anthropicService = require('./anthropicService');

/**
 * The service behind each transport. Which provider uses which transport is
 * the rules module's business (PROVIDERS); the three OpenAI-compatible
 * providers share one class and differ by configuration.
 */
const SERVICE_BY_TRANSPORT = Object.freeze({
  'openai-compatible': (provider) =>
    openaiCompatibleService.forProvider(provider),
  ollama: () => ollamaService,
  anthropic: () => anthropicService,
});

class AIServiceFactory {
  /**
   * The provider service for the configured AI_PROVIDER, read per call so a
   * provider switched on the settings page is the next one used. An unknown
   * value falls back to OpenAI, as it always has.
   */
  static getService() {
    const provider = normalizeProvider(config.aiProvider);
    return SERVICE_BY_TRANSPORT[transportFor(provider)](provider);
  }
}

module.exports = AIServiceFactory;
