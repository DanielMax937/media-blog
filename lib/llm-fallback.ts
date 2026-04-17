import OpenAI from 'openai';

const FALLBACK_OPENAI_API_KEY = 'sk-15507a2ad0414801b7e7579f7b38f474';
const FALLBACK_OPENAI_BASE_URL = 'https://api.deepseek.com';
export const FALLBACK_OPENAI_MODEL = 'deepseek-chat';

export const FALLBACK_ANTHROPIC_API_KEY = 'sk-15507a2ad0414801b7e7579f7b38f474';
export const FALLBACK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
export const FALLBACK_ANTHROPIC_MODEL = 'deepseek-chat';

let _fallbackOpenAI: OpenAI | null = null;

export function getFallbackOpenAI(): OpenAI {
    if (!_fallbackOpenAI) {
        _fallbackOpenAI = new OpenAI({
            apiKey: FALLBACK_OPENAI_API_KEY,
            baseURL: FALLBACK_OPENAI_BASE_URL,
        });
    }
    return _fallbackOpenAI;
}

type NonStreamingParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * Calls openai.chat.completions.create with the given params.
 * On error, retries once using the DeepSeek fallback client with model=deepseek-chat.
 */
export async function chatWithFallback(
    openai: OpenAI,
    params: NonStreamingParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
        return await openai.chat.completions.create({ ...params, stream: false });
    } catch (primaryErr) {
        console.warn('[llm-fallback] Primary OpenAI call failed, retrying with DeepSeek fallback:', primaryErr);
        return await getFallbackOpenAI().chat.completions.create({
            ...params,
            model: FALLBACK_OPENAI_MODEL,
            stream: false,
        });
    }
}
