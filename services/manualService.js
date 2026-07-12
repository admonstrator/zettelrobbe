const { 
    calculateTokens, 
    calculateTotalPromptTokens, 
    truncateToTokenLimit, 
    writePromptToFile,
    extractChatMessageContent
} = require('./serviceUtils');
const axios = require('axios');
const OpenAI = require('openai');
const config = require('../config/config');
const AzureOpenAI = require('openai').AzureOpenAI;
const emptyVar = null;

class ManualService {
    constructor() {
        if(config.aiProvider === 'custom'){
            this.openai = new OpenAI({
                apiKey: config.custom.apiKey,
                baseUrl: config.custom.apiUrl
            });
        }else if (config.aiProvider === 'azure'){
            this.openai = new AzureOpenAI({
                    apiKey: config.azure.apiKey,
                    endpoint: config.azure.endpoint,
                    deploymentName: config.azure.deploymentName,
                    apiVersion: config.azure.apiVersion
                  });
        } else {            
            this.openai = new OpenAI({ apiKey: config.openai.apiKey });
            this.ollama = axios.create({
            timeout: 300000
            });
        }
    }

    
    async analyzeDocument(content, existingTags, provider) {
        try {
        if (provider === 'openai') {
            return this._analyzeOpenAI(content, existingTags);
        } else if (provider === 'ollama') {
            return this._analyzeOllama(content, existingTags);
        } else if (provider === 'custom') {
            return this._analyzeCustom(content, existingTags);
        } else if (provider === 'azure') {
            return this._analyzeAzure(content, existingTags);
        } else {            
            throw new Error('Invalid provider');
        }
        } catch (error) {
        console.error('Error analyzing document:', error);
        return { tags: [], correspondent: null };
        }
    }
    
    async _analyzeOpenAI(content, existingTags) {
        try {
        const existingTagsList = existingTags
            .map(tag => tag.name)
            .join(', ');
        const model = process.env.OPENAI_MODEL;
        const systemPrompt = process.env.SYSTEM_PROMPT;
        await writePromptToFile(systemPrompt, content);
        const response = await this.openai.chat.completions.create({
            model: model,
            messages: [
            {
                role: "system",
                content: systemPrompt
            },
            {
                role: "user",
                content: content
            }
            ],
            ...(model !== 'o3-mini' && { temperature: config.aiTemperatureAnalysis }),
        });
    
        let jsonContent = extractChatMessageContent(response?.choices?.[0]?.message, 'ManualService/OpenAI');
        if (!jsonContent) {
            throw new Error('Invalid API response structure');
        }
        jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(jsonContent);
        } catch (error) {
            console.error('Failed to parse JSON response:', error);
            throw new Error('Invalid JSON response from API');
        }
        
        if (!Array.isArray(parsedResponse.tags) || (typeof parsedResponse.correspondent !== 'string' && parsedResponse.correspondent !== null)) {
            throw new Error('Invalid response structure');
        }
        
        return parsedResponse;
        } catch (error) {
        console.error('Failed to analyze document with OpenAI:', error);
        return { tags: [], correspondent: null };
        }
    }

    async _analyzeAzure(content, existingTags) {
        try {
        const existingTagsList = existingTags
            .map(tag => tag.name)
            .join(', ');
    
        const systemPrompt = process.env.SYSTEM_PROMPT;
        await writePromptToFile(systemPrompt, content);
        const response = await this.openai.chat.completions.create({
            model: process.env.AZURE_DEPLOYMENT_NAME,
            messages: [
            {
                role: "system",
                content: systemPrompt
            },
            {
                role: "user",
                content: content
            }
            ],
            temperature: config.aiTemperatureAnalysis,
        });
    
        let jsonContent = extractChatMessageContent(response?.choices?.[0]?.message, 'ManualService/Azure');
        if (!jsonContent) {
            throw new Error('Invalid API response structure');
        }
        jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(jsonContent);
        } catch (error) {
            console.error('Failed to parse JSON response:', error);
            throw new Error('Invalid JSON response from API');
        }
        
        if (!Array.isArray(parsedResponse.tags) || (typeof parsedResponse.correspondent !== 'string' && parsedResponse.correspondent !== null)) {
            throw new Error('Invalid response structure');
        }
        
        return parsedResponse;
        } catch (error) {
        console.error('Failed to analyze document with OpenAI:', error);
        return { tags: [], correspondent: null };
        }
    }

    async _analyzeCustom(content, existingTags) {
        try {
            const existingTagsList = existingTags
                .map(tag => tag.name)
                .join(', ');
        
            const systemPrompt = process.env.SYSTEM_PROMPT;
            const model = config.custom.model;
            const response = await this.openai.chat.completions.create({
                model: model,
                messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: content
                }
                ],
                ...(model !== 'o3-mini' && { temperature: config.aiTemperatureAnalysis }),
            });
        
            let jsonContent = extractChatMessageContent(response?.choices?.[0]?.message, 'ManualService/Custom');
            if (!jsonContent) {
                throw new Error('Invalid API response structure');
            }
            jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            
            const parsedResponse = JSON.parse(jsonContent);
            
            if (!Array.isArray(parsedResponse.tags) || (typeof parsedResponse.correspondent !== 'string' && parsedResponse.correspondent !== null)) {
                throw new Error('Invalid response structure');
            }
            
            return parsedResponse;
            } catch (error) {
            console.error('Failed to analyze document with OpenAI:', error);
            return { tags: [], correspondent: null };
            }
    }
    
    async _analyzeOllama(content, existingTags) {
        try {
        const prompt = process.env.SYSTEM_PROMPT;

        const getAvailableMemory = async () => {
            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const totalMemoryMB = (totalMemory / (1024 * 1024)).toFixed(0);
            const freeMemoryMB = (freeMemory / (1024 * 1024)).toFixed(0);
            return { totalMemoryMB, freeMemoryMB };
        };
        
        const calculateNumCtx = (promptTokenCount, expectedResponseTokens) => {
            const totalTokenUsage = promptTokenCount + expectedResponseTokens;
            const maxCtxLimit = Number(config.tokenLimit);
            
            const numCtx = Math.min(totalTokenUsage, maxCtxLimit);
            
            console.log('Prompt Token Count:', promptTokenCount);
            console.log('Expected Response Tokens:', expectedResponseTokens);
            console.log('Dynamic calculated num_ctx:', numCtx);
            
            return numCtx;
        };
        
        const calculatePromptTokenCount = (prompt) => {
            return Math.ceil(prompt.length / 4);
        };
        
        const { freeMemoryMB } = await getAvailableMemory();
        const expectedResponseTokens = 1024;
        const promptTokenCount = calculatePromptTokenCount(prompt);
        
        const numCtx = calculateNumCtx(promptTokenCount, expectedResponseTokens);
        
        const ollamaHeaders = { 'Content-Type': 'application/json' };
        const ollamaApiKey = process.env.OLLAMA_API_KEY || config.ollama.apiKey || '';
        if (ollamaApiKey) {
            ollamaHeaders.Authorization = `Bearer ${ollamaApiKey}`;
        }

        const response = await this.ollama.post(`${config.ollama.apiUrl}/api/generate`, {
            model: config.ollama.model,
            prompt: prompt,
            stream: false,
            options: {
            temperature: config.aiTemperatureGeneration,
            top_p: 0.9,
            repeat_penalty: 1.1,
            num_ctx: numCtx,
            }
        }, { headers: ollamaHeaders });
    
        if (!response.data || !response.data.response) {
            console.error('Unexpected Ollama response format:', response);
            throw new Error('Invalid response from Ollama API');
        }

        return this._parseResponse(response.data.response);
        }

        catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('Timeout bei der Ollama-Anfrage:', error);
            throw new Error('Die Analyse hat zu lange gedauert. Bitte versuchen Sie es erneut.');
        }
        console.error('Error analyzing document with Ollama:', error);
        throw error;
        }
    }
}

module.exports = ManualService; 
