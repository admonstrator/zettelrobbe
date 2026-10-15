// The OpenAI provider is a composition root over the shared DocumentAnalyzer
// (services/llm/). This path stays so its callers need no change.
module.exports = require('./llm/providers/openaiProvider');
