import OpenAI from 'openai';
import { logApi } from './services/api-logger';

function getRequiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`[llm-fallback] Missing required env: ${name}`);
    }
    return value;
}

const FALLBACK_OPENAI_API_KEY_ENV = 'FALLBACK_OPENAI_API_KEY';
export const FALLBACK_OPENAI_BASE_URL = process.env.FALLBACK_OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com';
export const FALLBACK_OPENAI_MODEL = process.env.FALLBACK_OPENAI_MODEL?.trim() || 'deepseek-chat';

const FALLBACK_ANTHROPIC_API_KEY_ENV = 'FALLBACK_ANTHROPIC_API_KEY';
export const FALLBACK_ANTHROPIC_BASE_URL = process.env.FALLBACK_ANTHROPIC_BASE_URL?.trim() || 'https://api.deepseek.com/anthropic';
export const FALLBACK_ANTHROPIC_MODEL = process.env.FALLBACK_ANTHROPIC_MODEL?.trim() || 'deepseek-chat';
export const FALLBACK_ANTHROPIC_API_KEY = process.env[FALLBACK_ANTHROPIC_API_KEY_ENV]?.trim() || '';

let _fallbackOpenAI: OpenAI | null = null;

function previewText(value: unknown, maxLength = 500): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function getFallbackOpenAI(): OpenAI {
    if (!_fallbackOpenAI) {
        _fallbackOpenAI = new OpenAI({
            apiKey: getRequiredEnv(FALLBACK_OPENAI_API_KEY_ENV),
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
        const response = await getFallbackOpenAI().chat.completions.create({
            ...params,
            model: FALLBACK_OPENAI_MODEL,
            stream: false,
        });
        const content = response.choices?.[0]?.message?.content ?? '';
        logApi('openai', 'llm fallback response', {
            primaryModel: typeof params.model === 'string' ? params.model : String(params.model),
            fallbackModel: FALLBACK_OPENAI_MODEL,
            contentChars: content.length,
            contentPreview: previewText(content),
            finishReason: response.choices?.[0]?.finish_reason ?? '',
        });
        return response;
    }
}
