/**
 * Renders views/settings.ejs the way GET /settings does, with the catalogue
 * defaults as the configuration and no secret stored, without a server or a
 * database. For tests that read the page as a person sees it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..', '..');

/**
 * @param {Record<string, unknown>} [overrides] locals that replace the defaults
 * @returns {Promise<string>} the page
 */
async function renderSettingsPage(overrides = {}) {
  const catalog = require('../../services/settingsCatalog');
  const aiProviderRules = require('../../services/aiProviderRules');
  const aiFormOptions = require('../../services/aiFormOptions');
  const { DEFAULT_OCR_PROMPTS } = require('../../services/ocrPrompt');
  const { RESTART_REQUIRED_KEYS } = require('../../config/restartRequiredKeys');

  const config = catalog.defaultsFromEnv({}, 'page');
  const configuredSecrets = {};
  catalog.secretKeys().forEach((key) => {
    configuredSecrets[key] = false;
    config[key] = '';
  });
  const presets = await aiFormOptions.loadAiProviderPresets();
  // The shell's sidebar reads a few app* locals of its own.
  const shellLocals = {};
  const navScripts = fs.readFileSync(
    path.join(root, 'views', 'partials', 'sidebar-nav-scripts.ejs'),
    'utf8'
  );
  [...new Set(navScripts.match(/\bapp[A-Z][A-Za-z]*/g) || [])].forEach(
    (key) => {
      shellLocals[key] = '';
    }
  );
  return ejs.renderFile(path.join(root, 'views', 'settings.ejs'), {
    ...shellLocals,
    version: 'test',
    theme: 'light',
    config,
    configuredSecrets,
    pdfPasswordCount: 0,
    lockedEnvKeys: [],
    bootId: 'test',
    aiProviderPresets: presets,
    aiProviderChoice: aiFormOptions.matchProviderChoice(
      presets,
      config.AI_PROVIDER,
      ''
    )?.id,
    anthropicOptions: aiFormOptions.getAnthropicFormOptions(),
    ocrPromptDefaults: DEFAULT_OCR_PROMPTS,
    aiOptions: aiProviderRules.AI_OPTIONS,
    aiProviders: aiProviderRules.PROVIDERS,
    restartRequiredKeys: Array.from(RESTART_REQUIRED_KEYS),
    mfaSettings: { available: true, username: 'admin', enabled: false },
    oidcDetectedRedirectUri: '',
    oidcStatus: { enabled: false, errors: [] },
    changelogReleases: [],
    success: undefined,
    settingsError: undefined,
    ...overrides,
  });
}

module.exports = { renderSettingsPage, root };
