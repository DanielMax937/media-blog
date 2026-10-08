import OpenAI from 'openai';
import path from 'path';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { generateImageWithCodex, isCodexImageGenerationAvailable } from './CodexImageService';
import { chatWithFallback, describeOpenAIModel, getPrimaryOpenAIModel } from '../llm-fallback';
function getSelectedImageBackend() {
    return {
        backend: 'codex-cli',
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

    const model = getPrimaryOpenAIModel();
    const modelLog = describeOpenAIModel(model);
    const t0 = Date.now();
    logApi('openai', 'CoverImageService.generateCoverPrompt start', { model: modelLog, markdownChars: markdown.length });
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
            model: modelLog,
            durationMs: Date.now() - t0,
            promptChars: text.length,
        });
        return text;
    } catch (err) {
        logApiError('openai', 'CoverImageService.generateCoverPrompt failed', err, {
            model: modelLog,
            durationMs: Date.now() - t0,
        });
        throw err;
    }
}

/**
 * Calls native Codex CLI once. Unknown outcomes must not be resubmitted.
 */
async function generateCoverFromCodex(prompt: string, outPath: string): Promise<void> {
    logApi('api', 'CoverImage generate submit', {
        backend: 'codex-cli', outFile: path.basename(outPath), promptChars: prompt.length,
    });
    await generateImageWithCodex(prompt, outPath, { width: 1536, height: 864 });
    logApi('api', 'CoverImage generate completed', {
        backend: 'codex-cli', outFile: path.basename(outPath),
    });
}

/**
 * Checks only native Codex CLI availability; no alternate image backend.
 */
async function isImageBackendAvailable(): Promise<boolean> {
    const selection = getSelectedImageBackend();
    logApi('api', 'CoverImage backend selection', selection);

    try {
        const ok = await isCodexImageGenerationAvailable();
        logApi('api', 'CoverImage native CLI availability result', { ...selection, ok });
        return ok;
    } catch (error) {
        logApiError('api', 'CoverImage native CLI availability failed', error, selection);
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
    const backendAvailable = await isImageBackendAvailable();
    const selection = getSelectedImageBackend();
    if (!backendAvailable) {
        logApi('api', 'CoverImage backend unavailable, skipping generation', selection);
        console.log(`[CoverImageService] ${selection.backend} unavailable, skipping cover generation`);
        return null;
    }

    const outPath = path.join(outputDir, `cover-${Date.now()}.png`);
    try {
        const prompt = await generateCoverPrompt(markdown, openai);
        await generateCoverFromCodex(prompt, outPath);
        console.log('[CoverImageService] ✓ Cover image generated:', path.basename(outPath));
        return outPath;
    } catch (error) {
        logApiError('api', 'CoverImage generation failed; not resubmitted', error, {
            backend: 'codex-cli', outFile: path.basename(outPath),
        });
        return null;
    }
}
