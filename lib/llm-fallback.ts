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
export const FALLBACK_OPENAI_BASE_URL = process.env.FALLBACK_OPENAI_BASE_URL?.trim() || 'http://127.0.0.1:3300/v1';
export const FALLBACK_OPENAI_MODEL = process.env.FALLBACK_OPENAI_MODEL?.trim() || 'codex-login/gpt-5.5';

const FALLBACK_ANTHROPIC_API_KEY_ENV = 'FALLBACK_ANTHROPIC_API_KEY';
export const FALLBACK_ANTHROPIC_BASE_URL = process.env.FALLBACK_ANTHROPIC_BASE_URL?.trim() || 'http://127.0.0.1:3300/v1';
export const FALLBACK_ANTHROPIC_MODEL = process.env.FALLBACK_ANTHROPIC_MODEL?.trim() || 'codex-login/gpt-5.5';
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
export type PrimaryChatParams = Omit<NonStreamingParams, 'model'> & { model?: string };
export type ChatRequestOptions = {
    timeout?: number;
    maxRetries?: number;
    signal?: AbortSignal | null;
    providerFallback?: boolean;
};

export function getPrimaryOpenAIModel(envName = 'OPENAI_MODEL'): string | undefined {
    return process.env[envName]?.trim() || undefined;
}

export function describeOpenAIModel(model: string | undefined): string {
    return model ?? '(default)';
}

function withOptionalModel(params: PrimaryChatParams): NonStreamingParams {
    const { model, ...rest } = params;
    return (model ? { ...rest, model } : rest) as NonStreamingParams;
}

/**
 * Calls openai.chat.completions.create with the given params.
 * On error, retries once using the configured OpenAI-compatible fallback.
 */
export async function chatWithFallback(
    openai: OpenAI,
    params: PrimaryChatParams,
    requestOptions?: ChatRequestOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { providerFallback = true, ...sdkRequestOptions } = requestOptions ?? {};
    try {
        return await openai.chat.completions.create({ ...withOptionalModel(params), stream: false }, sdkRequestOptions);
    } catch (primaryErr) {
        if (!providerFallback) {
            throw primaryErr;
        }
        console.warn('[llm-fallback] Primary OpenAI call failed, retrying with OpenAI-compatible fallback:', primaryErr);
        const response = await getFallbackOpenAI().chat.completions.create({
            ...params,
            model: FALLBACK_OPENAI_MODEL,
            stream: false,
        }, sdkRequestOptions);
        const content = response.choices?.[0]?.message?.content ?? '';
        logApi('openai', 'llm fallback response', {
            primaryModel: describeOpenAIModel(params.model),
            fallbackModel: FALLBACK_OPENAI_MODEL,
            contentChars: content.length,
            contentPreview: previewText(content),
            finishReason: response.choices?.[0]?.finish_reason ?? '',
        });
        return response;
    }
}
