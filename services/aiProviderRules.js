'use strict';

/**
 * The one place that says how a provider and a model are to be talked to,
 * and which of the AI settings a person has to see.
 *
 * Two audiences read this module:
 *
 * - The provider services read `resolveRules(provider, model)` to learn
 *   what a request may carry — a temperature, a reasoning effort, a thinking
 *   switch, a JSON schema — and under which name the completion cap travels.
 *   The rules used to live in five service files, each with its own idea of
 *   them; a model-family regexp here replaces a `switch` there.
 *
 * - The settings page reads `AI_OPTIONS` to render the AI sections: which
 *   options are part of the basic view, which are tucked behind "Advanced",
 *   which providers each applies to, and the sentence that explains it to
 *   someone who does not know what prompt caching is.
 *
 * Nothing here talks to a provider or reads process.env; the module is pure
 * so a test can hold it against a model name and a table.
 */

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'openai'|'azure'|'custom'|'ollama'|'anthropic'} ProviderId
 * @typedef {'openai-compatible'|'ollama'|'anthropic'} Transport
 */

/**
 * The providers a person can pick. `transport` is the wire protocol — the
 * three OpenAI-compatible providers share one service, the other two have
 * their own. `connection` lists the environment keys that make a provider
 * usable at all; the setup wizard and the settings page both ask for these
 * and nothing else in the basic view.
 */
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    transport: 'openai-compatible',
    connection: Object.freeze(['OPENAI_API_KEY', 'OPENAI_MODEL']),
  }),
  Object.freeze({
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    transport: 'anthropic',
    connection: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']),
  }),
  Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    transport: 'ollama',
    connection: Object.freeze(['OLLAMA_API_URL', 'OLLAMA_MODEL']),
  }),
  Object.freeze({
    id: 'custom',
    label: 'OpenAI-compatible endpoint',
    transport: 'openai-compatible',
    connection: Object.freeze([
      'CUSTOM_BASE_URL',
      'CUSTOM_API_KEY',
      'CUSTOM_MODEL',
    ]),
  }),
  Object.freeze({
    id: 'azure',
    label: 'Azure OpenAI',
    transport: 'openai-compatible',
    connection: Object.freeze([
      'AZURE_ENDPOINT',
      'AZURE_API_KEY',
      'AZURE_DEPLOYMENT_NAME',
    ]),
  }),
]);

const PROVIDER_IDS = Object.freeze(PROVIDERS.map((provider) => provider.id));

/**
 * @param {unknown} value
 * @returns {ProviderId}
 */
function normalizeProvider(value) {
  const id = String(value ?? '')
    .trim()
    .toLowerCase();
  return PROVIDER_IDS.includes(id) ? /** @type {ProviderId} */ (id) : 'openai';
}

/**
 * @param {unknown} provider
 * @returns {Transport}
 */
function transportFor(provider) {
  const id = normalizeProvider(provider);
  return PROVIDERS.find((entry) => entry.id === id).transport;
}

/* ------------------------------------------------------------------ */
/* Request rules                                                       */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} RequestRules
 * @property {Transport} transport
 * @property {boolean} temperature        the request may carry a temperature
 * @property {'openai'|'compatible'|'anthropic'|null} reasoningEffort
 *   which dialect of a reasoning-effort field the model takes, null for none
 * @property {'ollama'|'chat_template'|'anthropic'|null} thinkingSwitch
 *   how thinking is switched off for this model, null when it cannot be
 * @property {'json_schema'|'json_object'|'prompt'|'anthropic'} structuredOutput
 *   how a JSON answer is requested: a schema field, a json mode, an
 *   instruction in the prompt, or the Anthropic output_config
 * @property {boolean} promptCaching      the provider caches a marked prompt
 * @property {'max_tokens'|'max_completion_tokens'|'num_predict'} maxTokensParam
 * @property {boolean} streaming          the transport streams completions
 * @property {'minimal'|'low'|null} reasoningOffEffort
 *   the reasoning_effort value that asks this model for (almost) no thinking,
 *   sent when a caller switches thinking off; null when there is none to send
 * @property {string|null} thinkingPromptSwitch
 *   a line appended to the user message that switches thinking off for model
 *   families that read it from the prompt itself (Qwen's `/no_think`), for a
 *   gateway that drops `chat_template_kwargs`; null for none
 * @property {boolean} defaultCompletionCap
 *   a generateText() call without a maxTokens option still sends
 *   RESPONSE_TOKENS as its cap; false leaves the cap to the provider
 */

const GPT_5_MODEL_PATTERN = /gpt-?5/i;
const O_SERIES_MODEL_PATTERN = /(?:^|[/:_\s-])o[1-4](?:$|[-_.])/i;
const GPT_OSS_MODEL_PATTERN = /gpt-?oss/i;
const QWEN_MODEL_PATTERN = /qwen/i;

/**
 * Model families whose rules differ from the transport default. Patterns are
 * tried in order; the first match wins and only overrides what it names. An
 * entry with `providers` applies to those providers only.
 * Anthropic models are not listed: their per-model traits stay in
 * services/anthropicSupport.js, which this module defers to for them.
 *
 * - gpt-5 and the o-series reject a temperature other than the default and
 *   reject `max_tokens` (they want `max_completion_tokens`); both take
 *   `reasoning_effort`, gpt-5 down to 'minimal', the o-series down to 'low'.
 * - gpt-oss takes `reasoning_effort` 'low' where an OpenAI-compatible server
 *   serves it; OpenAI and Azure have never been sent the field for it.
 * - Qwen reads the `/no_think` soft switch out of the prompt as well as the
 *   chat template switch, so a gateway that drops one still passes the other.
 *
 * @type {ReadonlyArray<{transport: Transport, pattern: RegExp, providers?: ReadonlyArray<ProviderId>, rules: Partial<RequestRules>}>}
 */
const MODEL_FAMILIES = Object.freeze([
  {
    transport: 'openai-compatible',
    pattern: GPT_5_MODEL_PATTERN,
    rules: {
      temperature: false,
      reasoningEffort: 'openai',
      reasoningOffEffort: 'minimal',
      maxTokensParam: 'max_completion_tokens',
    },
  },
  {
    transport: 'openai-compatible',
    pattern: O_SERIES_MODEL_PATTERN,
    rules: {
      temperature: false,
      reasoningEffort: 'openai',
      reasoningOffEffort: 'low',
      maxTokensParam: 'max_completion_tokens',
    },
  },
  {
    transport: 'openai-compatible',
    pattern: GPT_OSS_MODEL_PATTERN,
    providers: ['custom'],
    rules: { reasoningEffort: 'compatible', reasoningOffEffort: 'low' },
  },
  {
    transport: 'openai-compatible',
    pattern: QWEN_MODEL_PATTERN,
    providers: ['custom'],
    rules: {
      thinkingSwitch: 'chat_template',
      thinkingPromptSwitch: '/no_think',
    },
  },
]);

/**
 * What a provider changes about its transport's defaults, before any model
 * family is applied.
 *
 * - openai: a generateText() call without a cap of its own has always gone
 *   out without one, so the model answers with whatever it allows.
 * - custom: every server that applies a chat template understands
 *   `chat_template_kwargs`, and one that does not passes it through, so the
 *   thinking switch is sent for every model there.
 *
 * @type {Readonly<Partial<Record<ProviderId, Partial<RequestRules>>>>}
 */
const PROVIDER_DEFAULTS = Object.freeze({
  openai: Object.freeze({ defaultCompletionCap: false }),
  custom: Object.freeze({ thinkingSwitch: 'chat_template' }),
});

/** @type {Readonly<Record<Transport, RequestRules>>} */
const TRANSPORT_DEFAULTS = Object.freeze({
  'openai-compatible': Object.freeze({
    transport: 'openai-compatible',
    temperature: true,
    reasoningEffort: null,
    thinkingSwitch: null,
    structuredOutput: 'prompt',
    promptCaching: false,
    maxTokensParam: 'max_tokens',
    streaming: true,
    reasoningOffEffort: null,
    thinkingPromptSwitch: null,
    defaultCompletionCap: true,
  }),
  ollama: Object.freeze({
    transport: 'ollama',
    temperature: true,
    reasoningEffort: null,
    thinkingSwitch: 'ollama',
    structuredOutput: 'json_schema',
    promptCaching: false,
    maxTokensParam: 'num_predict',
    streaming: true,
    reasoningOffEffort: null,
    thinkingPromptSwitch: null,
    defaultCompletionCap: true,
  }),
  anthropic: Object.freeze({
    transport: 'anthropic',
    temperature: false,
    reasoningEffort: 'anthropic',
    thinkingSwitch: 'anthropic',
    structuredOutput: 'anthropic',
    promptCaching: true,
    maxTokensParam: 'max_tokens',
    streaming: true,
    reasoningOffEffort: null,
    thinkingPromptSwitch: null,
    defaultCompletionCap: true,
  }),
});

/**
 * The request rules for a provider and a model name.
 *
 * @param {unknown} provider
 * @param {unknown} [model]
 * @returns {RequestRules}
 */
function resolveRules(provider, model = '') {
  const id = normalizeProvider(provider);
  const transport = transportFor(id);
  const name = String(model ?? '').trim();
  const base = { ...TRANSPORT_DEFAULTS[transport], ...PROVIDER_DEFAULTS[id] };
  if (name === '') return base;

  const family = MODEL_FAMILIES.find(
    (entry) =>
      entry.transport === transport &&
      (!entry.providers || entry.providers.includes(id)) &&
      entry.pattern.test(name)
  );
  const rules = { ...base, ...(family ? family.rules : {}) };

  // The custom provider serves hosted and self-hosted models alike, behind
  // gateways that each read the OpenAI dialect a little differently. The
  // compatible dialect is what all of them understand: reasoning_effort
  // 'low' rather than 'minimal', and the cap as max_tokens.
  if (id === 'custom') {
    if (rules.reasoningEffort === 'openai') {
      rules.reasoningEffort = 'compatible';
    }
    if (rules.reasoningOffEffort === 'minimal') {
      rules.reasoningOffEffort = 'low';
    }
    rules.maxTokensParam = 'max_tokens';
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* Settings catalogue                                                  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} AiOption
 * @property {string} key         the environment key the field writes
 * @property {string} label       the label on the settings page
 * @property {string} help        one or two plain sentences for a person who
 *   does not know the term; says what changing it does, not what it is
 * @property {'basic'|'advanced'} level
 * @property {ReadonlyArray<ProviderId>|null} providers  which providers show
 *   the option; null means all of them
 * @property {string} [defaultValue]  what applies when the field is empty
 * @property {'provider'|'tidy-up'} [section]  which settings section
 *   shows the option: the AI provider or the Tidy up page; absent means the
 *   AI provider
 */

/**
 * Every AI option the settings page offers, in display order. The connection
 * fields (keys, URLs, model names) are not in here — they are listed per
 * provider in PROVIDERS and are always shown.
 *
 * "basic" is what a person needs to get a working, sensible setup. Everything
 * else is "advanced" and hidden until asked for.
 *
 * @type {ReadonlyArray<AiOption>}
 */
const AI_OPTIONS = Object.freeze([
  {
    key: 'RESPONSE_TOKENS',
    label: 'Answer length',
    help: 'How long an answer the model may write for one document, in tokens (roughly three quarters of a word each). The default is enough for tags, a title and a few fields; raise it only when answers arrive cut off.',
    level: 'advanced',
    providers: ['openai', 'azure', 'custom', 'ollama'],
    defaultValue: '1000',
    section: 'provider',
  },
  {
    key: 'TOKEN_LIMIT',
    label: 'Document length limit',
    help: 'The most text of one document that is sent to the model, in tokens. Longer documents are shortened to fit. Match it to what the model accepts; too high and the provider refuses the request, too low and long documents lose their ending.',
    level: 'advanced',
    providers: null,
    defaultValue: '128000',
    section: 'provider',
  },
  {
    key: 'AI_TEMPERATURE_ANALYSIS',
    label: 'Analysis creativity',
    help: 'How freely the model may deviate from the most likely answer when it tags and titles a document, from 0 (always the same answer) to 2 (very varied). Low values give consistent tags; leave it unless tags come out erratic.',
    level: 'advanced',
    providers: ['openai', 'azure', 'custom', 'ollama'],
    defaultValue: '0.3',
    section: 'provider',
  },
  {
    key: 'AI_TEMPERATURE_GENERATION',
    label: 'Generation creativity',
    help: 'The same setting for the free-text tasks — the playground, the duplicate review and tag simplification. A little higher than for analysis, because those answers may be worded freely.',
    level: 'advanced',
    providers: ['openai', 'azure', 'custom', 'ollama'],
    defaultValue: '0.7',
    section: 'provider',
  },
  {
    key: 'ANTHROPIC_EFFORT',
    label: 'Thinking effort',
    help: 'How much the model may think before it answers. Higher levels take longer and cost more tokens but help with hard documents. Empty leaves the model at its own default, which suits most archives.',
    level: 'advanced',
    providers: ['anthropic'],
    defaultValue: '',
    section: 'provider',
  },
  {
    key: 'ANTHROPIC_MAX_TOKENS',
    label: 'Answer and thinking budget',
    help: 'The most tokens one request may spend on thinking and answering together. The default leaves room for both; lower it to cap costs, raise it when answers are cut off at a high thinking effort.',
    level: 'advanced',
    providers: ['anthropic'],
    defaultValue: '16000',
    section: 'provider',
  },
  {
    key: 'ANTHROPIC_STRUCTURED_OUTPUT',
    label: 'Structured answers',
    help: 'Asks the model to answer in exactly the shape the app expects, so no answer is lost to a formatting slip. Switch it off only if a proxy in front of the API rejects the request.',
    level: 'advanced',
    providers: ['anthropic'],
    defaultValue: 'yes',
    section: 'provider',
  },
  {
    key: 'ANTHROPIC_PROMPT_CACHING',
    label: 'Reuse the instructions',
    help: 'The instructions are the same for every document of a scan. With this on, the provider keeps them for a few minutes and charges a fraction for the repeat, which makes a scan noticeably cheaper. There is no reason to switch it off except for a proxy that cannot handle it.',
    level: 'advanced',
    providers: ['anthropic'],
    defaultValue: 'yes',
    section: 'provider',
  },
  {
    key: 'ANTHROPIC_API_URL',
    label: 'API address',
    help: 'Only for a proxy in front of the Anthropic API. Empty means api.anthropic.com.',
    level: 'advanced',
    providers: ['anthropic'],
    defaultValue: '',
    section: 'provider',
  },
  {
    key: 'OLLAMA_THINK',
    label: 'Let the model think',
    help: 'Reasoning models such as Qwen3 or DeepSeek-R1 can write down their thoughts before answering. That improves hard cases but slows every document down and needs a larger answer length. Off unless you know your model benefits.',
    level: 'advanced',
    providers: ['ollama'],
    defaultValue: 'false',
    section: 'provider',
  },
  {
    key: 'OLLAMA_API_KEY',
    label: 'API key',
    help: 'Only needed when the Ollama server sits behind a proxy that asks for a token. A plain Ollama install has no key; leave it empty.',
    level: 'advanced',
    providers: ['ollama'],
    defaultValue: '',
    section: 'provider',
  },
  {
    key: 'AZURE_API_VERSION',
    label: 'API version',
    help: 'The Azure OpenAI API version every request names. The default works for chat models; change it only when Azure asks for a newer one, for example for a recent model.',
    level: 'advanced',
    providers: ['azure'],
    defaultValue: '2023-05-15',
    section: 'provider',
  },

  // Tidy up page. Finding, merging and splitting names work by rule and need
  // no model; these options govern what the model does there when a person
  // asks for it, and the guard that keeps analysis from creating new
  // near-duplicates. They apply to every provider. The first three are the
  // basic view; the rest sit behind the section's Advanced options, budget
  // and brakes first, then evidence, memory, thinking and request sizes.
  {
    key: 'DUPLICATES_AI_REVIEW',
    label: 'Ask the model about unclear pairs',
    help: 'On the Tidy up page, the model reads the pairs of names that spelling rules cannot settle, looks at a few document titles and says whether they mean the same thing. Off, the page decides by spelling rules alone. Nothing runs until you start a run there.',
    level: 'basic',
    providers: null,
    defaultValue: 'yes',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_GUARD_NEW_NAMES',
    label: 'Reuse an existing name instead of creating a near-duplicate',
    help: 'When document analysis proposes a tag or correspondent that already exists in another spelling (upper or lower case, umlauts, a legal form such as GmbH, singular or plural, or the same words in another order), the existing one is used and the Tidy up page lists the mapping. A name that only looks like a typo of an existing one is logged, and the new name is still created.',
    level: 'basic',
    providers: null,
    defaultValue: 'yes',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_MODEL',
    label: 'Model for Tidy up',
    help: 'A stronger model of the same provider, used only for the questions the Tidy up page asks. Empty uses the model set under AI provider.',
    level: 'basic',
    providers: null,
    defaultValue: '',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_TOKEN_BUDGET',
    label: 'Token budget per run',
    help: 'The most one Tidy up run may spend on the model across all its requests, in tokens (roughly three quarters of a word each). When it is reached the run stops and keeps the answers it already has; 0 means no limit.',
    level: 'advanced',
    providers: null,
    defaultValue: '200000',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_IDLE_STOP_SECONDS',
    label: 'Stop an unwatched run after (seconds)',
    help: 'A run nobody has watched for this long stops itself, so a closed browser tab cannot leave the model running; 0 means never.',
    level: 'advanced',
    providers: null,
    defaultValue: '60',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_REQUEST_SECONDS',
    label: 'Seconds per request',
    help: 'The page first measures your model on one small request, then puts as many pairs into each request as fit into this many seconds. Shorter means smaller requests and more frequent progress.',
    level: 'advanced',
    providers: null,
    defaultValue: '30',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_CONCURRENCY',
    label: 'Requests at once',
    help: 'How many model requests run in parallel. 0 lets the page choose: one for Ollama, three for a hosted provider. More at once finishes sooner but costs the same tokens.',
    level: 'advanced',
    providers: null,
    defaultValue: '0',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_REVIEW_BATCH_SIZE',
    label: 'Pairs per request',
    help: 'How many name pairs one model request asks about. Fewer pairs mean more, shorter requests; more pairs need a model that can read more text at once.',
    level: 'advanced',
    providers: null,
    defaultValue: '25',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_CANDIDATE_FLOOR',
    label: 'Lowest similarity shown to the model',
    help: 'Pairs whose spelling is too far apart to be suggested on their own, but more alike than this score (0.5 to 0.95), are shown to the model too. A lower value asks about more pairs and costs more tokens.',
    level: 'advanced',
    providers: null,
    defaultValue: '0.6',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_EXCERPTS',
    label: 'Read document excerpts for spelling-only pairs',
    help: 'When two names were linked by spelling alone, the model also reads a short excerpt of a few of their documents. That tells apart names that look like a typo of each other but mean different things.',
    level: 'advanced',
    providers: null,
    defaultValue: 'yes',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_EXCERPT_CHARS',
    label: 'Excerpt length in characters',
    help: 'How much of each document the model reads for such a pair. Longer excerpts cost more tokens.',
    level: 'advanced',
    providers: null,
    defaultValue: '300',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_EXCERPT_DOCUMENTS',
    label: 'Documents per name for excerpts',
    help: 'How many documents of each tag or correspondent are sampled for those excerpts.',
    level: 'advanced',
    providers: null,
    defaultValue: '2',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_VERDICT_MEMORY_DAYS',
    label: 'Remember answers for (days)',
    help: 'A pair the model has already answered about is not asked about again while both names stay unchanged. 0 switches this memory off.',
    level: 'advanced',
    providers: null,
    defaultValue: '90',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_THINKING',
    label: 'Let the model think first',
    help: 'Reasoning models write down their thoughts before the answer and can spend the whole answer budget on them. Off, the model gets the evidence instead and answers in a fraction of the time and cost. Switch it on only if your model answers badly without it.',
    level: 'advanced',
    providers: null,
    defaultValue: 'no',
    section: 'tidy-up',
  },
  {
    key: 'DUPLICATES_AI_SWEEP_NAMES',
    label: 'Names per request when looking for synonyms',
    help: 'To find synonyms, translations and abbreviations that spelling rules cannot see, the model reads the whole list of names in parts. This is how many names go into one part. The same size applies when the model proposes the document types and topics for splitting tags.',
    level: 'advanced',
    providers: null,
    defaultValue: '300',
    section: 'tidy-up',
  },
  {
    key: 'SIMPLIFY_TAGS_PER_REQUEST',
    label: 'Tags per request when splitting',
    help: 'How many tag names the model looks at in one request when it suggests splitting a combined tag such as "Electricity bill" into a document type and a topic. Fewer names mean more requests; more names need a model that can read more text at once.',
    level: 'advanced',
    providers: null,
    defaultValue: '50',
    section: 'tidy-up',
  },
  {
    key: 'SIMPLIFY_VOCABULARY_SIZE',
    label: 'Number of document types and topics to propose',
    help: 'When you have not saved your own list yet, the model proposes the document types and topics that tags are split into. This is about how many it aims for, both together. Smaller means fewer, broader topics.',
    level: 'advanced',
    providers: null,
    defaultValue: '25',
    section: 'tidy-up',
  },
]);

/** @param {AiOption} option */
function sectionOf(option) {
  return option.section || 'provider';
}

/**
 * The options a provider shows, optionally limited to one level and to one
 * settings section.
 *
 * @param {unknown} provider
 * @param {'basic'|'advanced'} [level]
 * @param {'provider'|'tidy-up'} [section]
 * @returns {AiOption[]}
 */
function optionsFor(provider, level, section) {
  const id = normalizeProvider(provider);
  return AI_OPTIONS.filter(
    (option) =>
      (option.providers === null || option.providers.includes(id)) &&
      (!level || option.level === level) &&
      (!section || sectionOf(option) === section)
  );
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  AI_OPTIONS,
  MODEL_FAMILIES,
  TRANSPORT_DEFAULTS,
  PROVIDER_DEFAULTS,
  normalizeProvider,
  transportFor,
  resolveRules,
  optionsFor,
  sectionOf,
};
