import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { withWebgeminiConcurrency } from './webgemini-concurrency';
import {
    generateImageWithGoogleAi,
    getImageGenerationBackendName,
    isGoogleImageGenerationConfigured,
    isGoogleImageGenerationEnabled,
} from './GoogleImageService';

const WEBGEMINI_BASE = process.env.WEBGEMINI_URL ?? 'http://127.0.0.1:8200';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — long jobs / slow polls

function getSelectedImageBackend() {
    return {
        backend: getImageGenerationBackendName(),
        directEnabled: isGoogleImageGenerationEnabled(),
        directConfigured: isGoogleImageGenerationConfigured(),
    };
}

/** Rednote / XHS: always exactly three slides (cover → content → ending). */
const XHS_PLAN_IMAGE_COUNT = 3 as const;
const XHS_PLAN_TYPES: Array<'cover' | 'content' | 'ending'> = ['cover', 'content', 'ending'];

export interface XhsImagePlan {
    slug: string;
    images: Array<{ type: 'cover' | 'content' | 'ending'; prompt: string }>;
}

/**
 * Attempt to extract a JSON object from an LLM response that may include
 * surrounding prose, markdown fences, or other non-JSON text.
 */
function extractJsonFromText(text: string): unknown {
    // 1. Try the whole string first
    try { return JSON.parse(text); } catch { /* continue */ }

    // 2. Try stripping a markdown code fence: ```json ... ```
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }

    // 3. Try extracting the first { ... } block
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
        try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch { /* continue */ }
    }

    throw new SyntaxError(`Could not extract JSON from LLM response: ${text.substring(0, 120)}`);
}

/**
 * Validates that the given value is a well-formed XhsImagePlan.
 * Throws if the structure is missing required fields.
 */
function validatePlan(plan: unknown): XhsImagePlan {
    if (
        typeof plan !== 'object' || plan === null ||
        typeof (plan as Record<string, unknown>).slug !== 'string' ||
        !Array.isArray((plan as Record<string, unknown>).images)
    ) {
        throw new SyntaxError(
            `Invalid XhsImagePlan structure: ${JSON.stringify(plan).substring(0, 120)}`
        );
    }
    const typed = plan as XhsImagePlan;
    if (typed.images.length !== XHS_PLAN_IMAGE_COUNT) {
        throw new SyntaxError(
            `Invalid XhsImagePlan: expected exactly ${XHS_PLAN_IMAGE_COUNT} images, got ${typed.images.length}`
        );
    }
    for (let i = 0; i < XHS_PLAN_IMAGE_COUNT; i++) {
        const img = typed.images[i] as Record<string, unknown>;
        const wantType = XHS_PLAN_TYPES[i];
        if (img.type !== wantType) {
            throw new SyntaxError(
                `Image ${i} must have type "${wantType}", got ${JSON.stringify(img.type)}`
            );
        }
        if (typeof img.prompt !== 'string' || img.prompt.trim().length === 0) {
            throw new SyntaxError(
                `Image ${i} missing prompt: ${JSON.stringify(typed.images[i]).substring(0, 80)}`
            );
        }
    }
    return typed;
}

/**
 * Uses Claude (via OpenAI-compatible API) to analyse the markdown and produce
 * XHS-style image prompts.  Returns a plan with a slug and an ordered list of
 * image descriptors.  Retries once with a stricter prompt if the first
 * response is not valid JSON.
 *
 * response_format json_object mode is used when the model is not Claude to enforce
 * strict JSON output. Claude reliably follows JSON format instructions natively.
 */
export async function planXhsImages(openai: OpenAI, markdown: string): Promise<XhsImagePlan> {
    const model = process.env.XHS_PLANNER_MODEL ?? 'claude-sonnet-4-6';
    // Enable JSON mode for non-Claude models (gpt-* variants) to avoid freeform text responses
    const isClaudeModel = model.toLowerCase().startsWith('claude');
    const responseFormat = isClaudeModel ? undefined : { type: 'json_object' as const };

    const systemPrompt = `You are a Xiaohongshu visual strategist. Analyse the given Xiaohongshu post and produce an image prompt plan in pure JSON — no prose, no markdown fences, no explanations.

Output schema (strict) — exactly THREE images in this order:
{"slug":"2-4-word-kebab-case-topic","images":[
  {"type":"cover","prompt":"<English prompt, cute Xiaohongshu illustration style, Aspect ratio: 3:4>"},
  {"type":"content","prompt":"<English prompt, one key insight, Aspect ratio: 3:4>"},
  {"type":"ending","prompt":"<English prompt, CTA / summary / engagement, Aspect ratio: 3:4>"}
]}

Rules:
- Image 0 MUST be type "cover" — strong hook, eye-catching
- Image 1 MUST be type "content" — one key insight
- Image 2 MUST be type "ending" — CTA / summary / engagement
- Total images: exactly 3 — no more, no fewer
- All prompts in English, cute cartoon illustration style, include "Aspect ratio: 3:4"
- Output ONLY the JSON object. No other text whatsoever.`;

    const userContent = `Output JSON only — the images array must contain exactly 3 entries in order: cover, then content, then ending. Post content:\n\n${markdown.substring(0, 6000)}`;

    async function callLLM(extraInstruction?: string): Promise<string> {
        const messages: Array<{ role: 'system' | 'user'; content: string }> = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: extraInstruction ? `${userContent}\n\n${extraInstruction}` : userContent },
        ];
        const t0 = Date.now();
        logApi('openai', 'planXhsImages chat.completions.create', {
            model,
            attempt: extraInstruction ? 'retry' : 'first',
            markdownChars: markdown.length,
        });
        const resp = await openai.chat.completions.create({
            model,
            messages,
            max_tokens: 2048,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });
        const content = resp.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('planXhsImages callLLM', content.length, resp);
        logApi('openai', 'planXhsImages chat.completions ok', {
            model,
            durationMs: Date.now() - t0,
            responseChars: content.length,
        });
        if (!content) {
            throw new Error('[planXhsImages] LLM returned empty response');
        }
        return content;
    }

    const raw = await callLLM();
    try {
        return validatePlan(extractJsonFromText(raw));
    } catch (err) {
        console.warn('[planXhsImages] First attempt failed, retrying:', (err as Error).message);
        logApiError('openai', 'planXhsImages validate first attempt', err, {});
    }

    const examplePlan = '{"slug":"example-topic","images":[{"type":"cover","prompt":"cute illustration, Aspect ratio: 3:4"},{"type":"content","prompt":"cute illustration, Aspect ratio: 3:4"},{"type":"ending","prompt":"cute illustration, Aspect ratio: 3:4"}]}';
    const raw2 = await callLLM(
        `IMPORTANT: You MUST output a JSON object whose "images" array has exactly 3 items in order: cover, content, ending. Example structure:\n${examplePlan}`
    );
    return validatePlan(extractJsonFromText(raw2));
}

/**
 * Submits an image generation job to the local webgemini service and polls
 * until the image is ready. Returns the absolute local path of the PNG.
 * (webgemini accepts prompt-only multipart — reference images optional.)
 */
async function generateImage(prompt: string, outPath: string): Promise<void> {
    if (isGoogleImageGenerationEnabled()) {
        logApi('genai', 'XhsImage generate submit', {
            backend: 'google-ai',
            outFile: path.basename(outPath),
            promptChars: prompt.length,
        });
        await generateImageWithGoogleAi(prompt, outPath, {
            width: 1024,
            height: 1365,
        });
        logApi('genai', 'XhsImage generate completed', {
            backend: 'google-ai',
            outFile: path.basename(outPath),
        });
        return;
    }

    await withWebgeminiConcurrency(async () => {
        const formData = new FormData();
        formData.append('prompt', prompt);

        const t0 = Date.now();
        logApi('webgemini', 'POST /image submit', {
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
            logApi('webgemini', 'POST /image submit failed', { status: submitRes.status, bodySnippet: body.slice(0, 200) });
            throw new Error(`webgemini submit failed: ${submitRes.status} ${body}`);
        }
        const { job_id: jobId } = (await submitRes.json()) as { job_id: string };
        logApi('webgemini', 'POST /image queued', { jobId, durationMs: Date.now() - t0 });

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let polls = 0;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            polls += 1;
            const pollRes = await fetch(`${WEBGEMINI_BASE}/image/${jobId}`);
            if (!pollRes.ok) continue;
            const result = (await pollRes.json()) as { status: string; images?: Array<{ local_path: string }> };
            if (result.status === 'completed' && result.images?.length) {
                fs.copyFileSync(result.images[0].local_path, outPath);
                logApi('webgemini', 'GET /image/{jobId} completed', {
                    jobId,
                    polls,
                    durationMs: Date.now() - t0,
                    outFile: path.basename(outPath),
                });
                return;
            }
            if (result.status === 'failed') {
                logApi('webgemini', 'GET /image/{jobId} job failed', { jobId, polls });
                throw new Error(`webgemini job ${jobId} failed`);
            }
        }
        logApi('webgemini', 'GET /image/{jobId} poll timeout', { jobId, polls, durationMs: Date.now() - t0 });
        throw new Error(`webgemini job ${jobId} timed out`);
    });
}

/**
 * Checks whether the currently selected image backend is available.
 * Direct Google AI mode is decided only by env vars, never by webgemini health.
 */
export async function isWebgeminiAvailable(): Promise<boolean> {
    const selection = getSelectedImageBackend();
    logApi('api', 'XhsImage backend selection', selection);

    if (selection.directEnabled) {
        const ok = selection.directConfigured;
        logApi('genai', 'XhsImage direct backend config result', {
            backend: selection.backend,
            ok,
        });
        return ok;
    }

    try {
        logApi('webgemini', 'XhsImage backend health check start', {
            backend: selection.backend,
            base: WEBGEMINI_BASE,
        });
        const res = await fetch(`${WEBGEMINI_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        logApi('webgemini', 'XhsImage backend health check result', {
            backend: selection.backend,
            ok: res.ok,
            status: res.status,
        });
        return res.ok;
    } catch (err) {
        logApiError('webgemini', 'XhsImage backend health check failed', err, {
            backend: selection.backend,
            base: WEBGEMINI_BASE,
        });
        return false;
    }
}

/**
 * Generates all XHS images from the given plan in parallel (order preserved).
 * Concurrency is capped process-wide by {@link withWebgeminiConcurrency} (max 2 in-flight jobs).
 */
export async function generateXhsImages(plan: XhsImagePlan): Promise<string[]> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `blog2media-xhs-${plan.slug}-`));

    const paths = await Promise.all(
        plan.images.map(async ({ type, prompt }, i) => {
            const nn = String(i + 1).padStart(2, '0');
            const outFile = path.join(tmpDir, `${nn}-${type}-${plan.slug}.png`);

            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    await generateImage(prompt, outFile);
                    console.log(`[XhsImageService] ✓ ${path.basename(outFile)}`);
                    return outFile;
                } catch (err) {
                    if (attempt < 2) {
                        console.warn(`[XhsImageService] Retry ${attempt} for ${path.basename(outFile)}`);
                    } else {
                        console.error(`[XhsImageService] ✗ ${path.basename(outFile)} failed after retry:`, err);
                        throw err;
                    }
                }
            }
            throw new Error(`[generateXhsImages] unreachable for ${outFile}`);
        })
    );

    return paths;
}
