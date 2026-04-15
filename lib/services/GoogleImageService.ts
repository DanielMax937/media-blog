import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { logApi, logApiError } from './api-logger';

const DIRECT_IMAGE_ENV = 'GOOGLE_IMAGE_USE_DIRECT_API';
const API_KEY_ENV = 'GOOGLE_AI_API_KEY';
const PROXY_ENV = 'GOOGLE_AI_PROXY_URL';
const BASE_URL_ENV = 'GOOGLE_AI_BASE_URL';
const MODEL_ENV = 'GOOGLE_AI_IMAGE_MODEL';
const API_VERSION_ENV = 'GOOGLE_AI_API_VERSION';

let configuredProxyUrl: string | null = null;
let configuredProxyAgent: ProxyAgent | null = null;

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function ensureProxyDispatcher(proxyUrl: string): void {
    if (configuredProxyUrl === proxyUrl && configuredProxyAgent) return;

    const nextAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(nextAgent);
    configuredProxyAgent = nextAgent;
    configuredProxyUrl = proxyUrl;
}

function getRequiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`[GoogleImageService] Missing required env var: ${name}`);
    }
    return value;
}

function extractImage(response: unknown): { imageBase64: string; mimeType: string; text?: string } {
    const typed = response as {
        candidates?: Array<{
            finishReason?: string;
            content?: { parts?: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> };
        }>;
    };

    if (!typed.candidates || typed.candidates.length === 0) {
        console.error('[GenAI] No candidates in response:', JSON.stringify(response, null, 2).slice(0, 500));
        throw new Error('Gemini 未返回任何结果（无 candidates）');
    }

    const candidate = typed.candidates[0];
    if (!candidate.content || !candidate.content.parts) {
        console.error('[GenAI] No content/parts:', JSON.stringify(candidate, null, 2).slice(0, 500));
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            throw new Error(`Gemini 请求被拒绝: ${candidate.finishReason}`);
        }
        throw new Error('Gemini 返回格式异常：缺少 content.parts');
    }

    let textContent: string | undefined;
    for (const part of candidate.content.parts) {
        if (part.text) textContent = part.text;
        if (part.inlineData) {
            return {
                imageBase64: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
                text: textContent,
            };
        }
    }

    console.error(
        '[GenAI] No inlineData in parts:',
        JSON.stringify(candidate.content.parts.map((part) => Object.keys(part)), null, 2)
    );
    throw new Error('Gemini 未生成图片（响应中无 inlineData）');
}

export function isGoogleImageGenerationEnabled(): boolean {
    return isTruthy(process.env[DIRECT_IMAGE_ENV]);
}

export function isGoogleImageGenerationConfigured(): boolean {
    if (!isGoogleImageGenerationEnabled()) return false;

    return Boolean(process.env[API_KEY_ENV]?.trim() && process.env[PROXY_ENV]?.trim());
}

export function getImageGenerationBackendName(): 'google-ai' | 'webgemini' {
    return isGoogleImageGenerationEnabled() ? 'google-ai' : 'webgemini';
}

export async function generateImageWithGoogleAi(
    prompt: string,
    outPath: string,
    options?: {
        width?: number;
        height?: number;
        model?: string;
    }
): Promise<void> {
    const apiKey = getRequiredEnv(API_KEY_ENV);
    const proxyUrl = getRequiredEnv(PROXY_ENV);
    const baseUrl = process.env[BASE_URL_ENV]?.trim();
    const model = options?.model ?? process.env[MODEL_ENV]?.trim() ?? 'gemini-3-pro-image-preview';
    const apiVersion = process.env[API_VERSION_ENV]?.trim();
    const width = options?.width ?? 1024;
    const height = options?.height ?? 1024;

    ensureProxyDispatcher(proxyUrl);

    const ai = new GoogleGenAI({
        apiKey,
        ...(apiVersion ? { apiVersion } : {}),
        ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });

    const t0 = Date.now();
    logApi('genai', 'generate image start', {
        model,
        width,
        height,
        promptChars: prompt.length,
        outFile: path.basename(outPath),
        viaProxy: true,
        hasBaseUrl: !!baseUrl,
    });

    let response: unknown;
    try {
        response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageGenerationConfig: {
                    width,
                    height,
                },
            } as never,
        });
    } catch (err) {
        logApiError('genai', 'generate image failed', err, {
            model,
            width,
            height,
            viaProxy: true,
        });
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Gemini API 调用失败: ${message}`);
    }

    const image = extractImage(response);
    fs.writeFileSync(outPath, Buffer.from(image.imageBase64, 'base64'));

    logApi('genai', 'generate image ok', {
        model,
        width,
        height,
        durationMs: Date.now() - t0,
        outFile: path.basename(outPath),
        mimeType: image.mimeType,
    });
}
