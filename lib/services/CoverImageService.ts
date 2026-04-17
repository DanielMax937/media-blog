import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { withWebgeminiConcurrency } from './webgemini-concurrency';
import {
    generateImageWithGoogleAi,
    getImageGenerationBackendName,
    isGoogleImageGenerationConfigured,
    isGoogleImageGenerationEnabled,
} from './GoogleImageService';
import { chatWithFallback } from '../llm-fallback';

const WEBGEMINI_BASE = process.env.WEBGEMINI_URL ?? 'http://127.0.0.1:8200';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function getSelectedImageBackend() {
    return {
        backend: getImageGenerationBackendName(),
        directEnabled: isGoogleImageGenerationEnabled(),
        directConfigured: isGoogleImageGenerationConfigured(),
    };
}

/**
 * Generates a cover-image prompt from the article markdown using the LLM.
 */
async function generateCoverPrompt(markdown: string, openai: OpenAI): Promise<string> {
    const systemPrompt = `You are a visual art director. Given an article, write a single English image generation prompt
for an eye-catching cover image. Style: clean, modern, professional illustration — suitable for a Medium blog post cover.
Return ONLY the prompt string, no quotes, no extra text.
Include "16:9 aspect ratio, high resolution, professional blog cover, digital illustration style" at the end.`;

    const model = process.env.OPENAI_MODEL ?? 'gpt-5.4';
    const t0 = Date.now();
    logApi('openai', 'CoverImageService.generateCoverPrompt start', { model, markdownChars: markdown.length });
    try {
        const response = await chatWithFallback(openai, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Article:\n\n${markdown.substring(0, 3000)}` },
            ],
        });

        const rawPrompt = response.choices?.[0]?.message?.content ?? '';
        const trimmedPrompt = rawPrompt.trim();
        logOpenAiRawResponseIfEmpty('CoverImageService.generateCoverPrompt', trimmedPrompt.length, response);
        const text =
            trimmedPrompt ||
            'Abstract technology concept, 16:9 aspect ratio, high resolution, professional blog cover, digital illustration style';
        logApi('openai', 'CoverImageService.generateCoverPrompt ok', {
            model,
            durationMs: Date.now() - t0,
            promptChars: text.length,
        });
        return text;
    } catch (err) {
        logApiError('openai', 'CoverImageService.generateCoverPrompt failed', err, {
            model,
            durationMs: Date.now() - t0,
        });
        throw err;
    }
}

/**
 * Submits a cover image generation job to the webgemini service and polls until done.
 * Returns the local PNG path, or null on failure/timeout.
 */
async function generateCoverFromWebgemini(prompt: string, outPath: string): Promise<boolean> {
    if (isGoogleImageGenerationEnabled()) {
        logApi('genai', 'CoverImage generate submit', {
            backend: 'google-ai',
            outFile: path.basename(outPath),
            promptChars: prompt.length,
        });
        await generateImageWithGoogleAi(prompt, outPath, {
            width: 1536,
            height: 1024,
        });
        logApi('genai', 'CoverImage generate completed', {
            backend: 'google-ai',
            outFile: path.basename(outPath),
        });
        return true;
    }

    return withWebgeminiConcurrency(async () => {
        const formData = new FormData();
        formData.append('prompt', prompt);

        const t0 = Date.now();
        logApi('webgemini', 'CoverImage POST /image submit', {
            base: WEBGEMINI_BASE,
            promptChars: prompt.length,
            outFile: path.basename(outPath),
        });
        const submitRes = await fetch(`${WEBGEMINI_BASE}/image`, {
            method: 'POST',
            body: formData,
        });
        if (!submitRes.ok) {
            const body = await submitRes.text();
            logApi('webgemini', 'CoverImage POST /image failed', { status: submitRes.status, bodySnippet: body.slice(0, 200) });
            throw new Error(`webgemini cover submit failed: ${submitRes.status} ${body}`);
        }
        const { job_id: jobId } = (await submitRes.json()) as { job_id: string };
        logApi('webgemini', 'CoverImage POST /image queued', { jobId, durationMs: Date.now() - t0 });

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let polls = 0;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            polls += 1;
            const pollRes = await fetch(`${WEBGEMINI_BASE}/image/${jobId}`);
            if (!pollRes.ok) {
                console.warn(`[CoverImageService] poll non-ok ${pollRes.status} for job ${jobId}`);
                continue;
            }
            const result = (await pollRes.json()) as {
                status: string;
                images?: Array<{ local_path: string }>;
            };
            if (result.status === 'completed' && result.images?.length) {
                fs.copyFileSync(result.images[0].local_path, outPath);
                logApi('webgemini', 'CoverImage GET /image/{jobId} completed', {
                    jobId,
                    polls,
                    durationMs: Date.now() - t0,
                });
                return true;
            }
            if (result.status === 'failed') {
                logApi('webgemini', 'CoverImage job failed', { jobId, polls });
                throw new Error(`webgemini cover job ${jobId} failed`);
            }
        }
        logApi('webgemini', 'CoverImage poll timeout', { jobId, polls, durationMs: Date.now() - t0 });
        throw new Error(`webgemini cover job ${jobId} timed out`);
    });
}

/**
 * Checks whether the currently selected image backend is available.
 * Direct Google AI mode is decided only by env vars, never by webgemini health.
 */
async function isWebgeminiAvailable(): Promise<boolean> {
    const selection = getSelectedImageBackend();
    logApi('api', 'CoverImage backend selection', selection);

    if (selection.directEnabled) {
        const ok = selection.directConfigured;
        logApi('genai', 'CoverImage direct backend config result', {
            backend: selection.backend,
            ok,
        });
        return ok;
    }

    try {
        logApi('webgemini', 'CoverImage backend health check start', {
            backend: selection.backend,
            base: WEBGEMINI_BASE,
        });
        const res = await fetch(`${WEBGEMINI_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        logApi('webgemini', 'CoverImage backend health check result', {
            backend: selection.backend,
            ok: res.ok,
            status: res.status,
        });
        return res.ok;
    } catch (err) {
        logApiError('webgemini', 'CoverImage backend health check failed', err, {
            backend: selection.backend,
            base: WEBGEMINI_BASE,
        });
        return false;
    }
}

/**
 * Generates a cover image for a Medium article.
 *
 * @param markdown  The full article markdown (used to craft the prompt)
 * @param openai    OpenAI instance for prompt generation
 * @param outputDir Directory where the PNG will be saved
 * @returns Local path to the cover PNG, or null if generation failed / service unavailable
 */
export async function generateCoverImage(
    markdown: string,
    openai: OpenAI,
    outputDir: string
): Promise<string | null> {
    const backendAvailable = await isWebgeminiAvailable();
    const selection = getSelectedImageBackend();
    if (!backendAvailable) {
        logApi('api', 'CoverImage backend unavailable, skipping generation', selection);
        console.log(`[CoverImageService] ${selection.backend} unavailable, skipping cover generation`);
        return null;
    }

    let attempts = 0;
    const outPath = path.join(outputDir, `cover-${Date.now()}.png`);

    while (attempts < 2) {
        try {
            const prompt = await generateCoverPrompt(markdown, openai);
            console.log('[CoverImageService] Generating cover with prompt:', prompt.substring(0, 80) + '...');
            await generateCoverFromWebgemini(prompt, outPath);
            console.log('[CoverImageService] ✓ Cover image generated:', path.basename(outPath));
            return outPath;
        } catch (err) {
            attempts++;
            if (attempts >= 2) {
                console.error('[CoverImageService] Cover generation failed after retry:', err);
                return null;
            }
            console.warn('[CoverImageService] Retry cover generation...');
        }
    }
    return null;
}
