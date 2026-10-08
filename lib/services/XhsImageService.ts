import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { generateImageWithCodex, isCodexImageGenerationAvailable } from './CodexImageService';
import { chatWithFallback, describeOpenAIModel, getPrimaryOpenAIModel } from '../llm-fallback';


function getSelectedImageBackend() {
    return {
        backend: 'codex-cli',
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
 * Uses the configured OpenAI-compatible chat endpoint to analyse the markdown
 * and produce XHS-style image prompts. Returns a plan with a slug and an
 * ordered list of image descriptors. Retries once with a stricter prompt if
 * the first response is not valid JSON.
 *
 * response_format json_object mode is used when the model is not Claude to enforce
 * strict JSON output. Claude reliably follows JSON format instructions natively.
 */
export async function planXhsImages(openai: OpenAI, markdown: string): Promise<XhsImagePlan> {
    const model = getPrimaryOpenAIModel('XHS_PLANNER_MODEL');
    const modelLog = describeOpenAIModel(model);
    // Enable JSON mode for non-Claude models (gpt-* variants) to avoid freeform text responses
    const isClaudeModel = model?.toLowerCase().startsWith('claude') ?? false;
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
            model: modelLog,
            attempt: extraInstruction ? 'retry' : 'first',
            markdownChars: markdown.length,
        });
        const resp = await chatWithFallback(openai, {
            model,
            messages,
            max_tokens: 2048,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });
        const content = resp.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('planXhsImages callLLM', content.length, resp);
        logApi('openai', 'planXhsImages chat.completions ok', {
            model: modelLog,
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
 * Calls native Codex CLI once and saves a local PNG. No image backend fallback.
 */
async function generateImage(prompt: string, outPath: string): Promise<void> {
    logApi('api', 'XhsImage generate submit', {
        backend: 'codex-cli', outFile: path.basename(outPath), promptChars: prompt.length,
    });
    await generateImageWithCodex(prompt, outPath, { width: 1024, height: 1365 });
    logApi('api', 'XhsImage generate completed', {
        backend: 'codex-cli', outFile: path.basename(outPath),
    });
}

/**
 * Checks only native Codex CLI availability; no alternate image backend.
 */
export async function isImageBackendAvailable(): Promise<boolean> {
    const selection = getSelectedImageBackend();
    logApi('api', 'XhsImage backend selection', selection);

    try {
        const ok = await isCodexImageGenerationAvailable();
        logApi('api', 'XhsImage native CLI availability result', { ...selection, ok });
        return ok;
    } catch (error) {
        logApiError('api', 'XhsImage native CLI availability failed', error, selection);
        return false;
    }
}

/** @deprecated Compatibility name only; this checks native Codex CLI. */
export const isWebgeminiAvailable = isImageBackendAvailable;

/**
 * Generates XHS slides one at a time (cover → content → ending).
 * Each slide is submitted once; failure/unknown outcomes are never resubmitted.
 * A failed slide is skipped so later slides still run.
 * Returns local file paths only for slides that succeeded (order preserved among successes).
 * Native CLI execution is sequential across the three slides.
 */
export async function generateXhsImages(plan: XhsImagePlan): Promise<string[]> {
    validatePlan(plan);
    // The LLM-provided slug enters both a directory prefix and filenames.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(plan.slug)) {
        throw new SyntaxError('XhsImagePlan slug is not a safe filename component');
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `blog2media-xhs-${plan.slug}-`));
    const paths: string[] = [];

    for (let i = 0; i < plan.images.length; i++) {
        const { type, prompt } = plan.images[i];
        const nn = String(i + 1).padStart(2, '0');
        const outFile = path.join(tmpDir, `${nn}-${type}-${plan.slug}.png`);
        const base = path.basename(outFile);
        try {
            await generateImage(prompt, outFile);
            console.log(`[XhsImageService] ✓ ${base}`);
            paths.push(outFile);
        } catch (error) {
            logApiError('api', 'XhsImage slide failed; not resubmitted', error, {
                backend: 'codex-cli', slug: plan.slug, slideIndex: i, type, outFile: base,
            });
        }
    }

    return paths;
}
