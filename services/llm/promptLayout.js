'use strict';

/**
 * How the analysis instructions and the document are laid out into one
 * request, per API family.
 *
 * promptBuilder.js builds the instructions once for every provider. The chat
 * providers (openai, azure, custom) send them as the system message and the
 * document as the user message. Ollama puts them in front of the document in
 * its prompt and sends a short system prompt of its own. Both layouts are
 * kept exactly as the providers always sent them, down to the whitespace.
 *
 * A layout has two parts:
 *  - frame(instructions, { customPrompt }): the fixed text the token budget
 *    reserves room for before the document is cut;
 *  - build(instructions, content, { customPrompt }): the request's
 *    { systemPrompt, userContent }.
 */

const { buildCustomFieldsBlock } = require('./customFieldsTemplate');

/** openai, azure, custom: the instructions are the system message. */
const chatPromptLayout = {
  frame(instructions) {
    return instructions;
  },
  build(instructions, content) {
    return { systemPrompt: instructions, userContent: content };
  },
};

/** Ollama's own system prompt; %CUSTOMFIELDS% is the configured block. */
const OLLAMA_SYSTEM_PROMPT_TEMPLATE = `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
            IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
            Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
            {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_type": "Invoice/Contract/...",
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/...",
                %CUSTOMFIELDS%
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;

/** Ollama's system prompt with the configured custom fields. */
function buildOllamaSystemPrompt(customFieldsBlock = buildCustomFieldsBlock()) {
  return OLLAMA_SYSTEM_PROMPT_TEMPLATE.replace(
    '%CUSTOMFIELDS%',
    customFieldsBlock
  );
}

/** The instructions, then the document as a JSON string. */
function ollamaPrompt(instructions, content) {
  return `${instructions}
        ${JSON.stringify(content)}
        `;
}

/**
 * Ollama: instructions and document both go into the prompt. A custom
 * (webhook) prompt is followed by a blank line instead of the indented
 * block, as it always was.
 */
const ollamaPromptLayout = {
  frame(instructions, { customPrompt } = {}) {
    return customPrompt
      ? `${instructions}\n\n`
      : ollamaPrompt(instructions, '');
  },
  build(instructions, content, { customPrompt } = {}) {
    return {
      systemPrompt: buildOllamaSystemPrompt(),
      userContent: customPrompt
        ? `${instructions}\n\n${JSON.stringify(content)}`
        : ollamaPrompt(instructions, content),
    };
  },
};

module.exports = {
  chatPromptLayout,
  ollamaPromptLayout,
  ollamaPrompt,
  buildOllamaSystemPrompt,
};
