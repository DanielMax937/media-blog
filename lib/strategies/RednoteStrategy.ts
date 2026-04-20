import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';
import { isWebgeminiAvailable, planXhsImages, generateXhsImages } from '../services/XhsImageService';
import { uploadToBitstripe } from '../services/BitstripeUploader';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from '../services/api-logger';
import { getImageGenerationBackendName } from '../services/GoogleImageService';
import { chatWithFallback } from '../llm-fallback';

export class RednoteStrategy implements BlogStrategy {
    private openai: OpenAI;

    constructor(openai: OpenAI) {
        this.openai = openai;
    }

    async generate(content: string): Promise<{ content: string; imageUrls?: string[] }> {
        const model = process.env.OPENAI_MODEL ?? 'gpt-5.4';
        const tStyle = Date.now();
        logApi('openai', 'RednoteStrategy.styleMarkdown start', { model, inputChars: content.length });
        let markdown = '';
        try {
            const styleResponse = await chatWithFallback(this.openai, {
                model,
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are a social media expert specializing in "Rednote" (Xiaohongshu) style posts. Your goal is to convert the input text into a viral Rednote blog post.',
                    },
                    {
                        role: 'user',
                        content: `Convert the following article into a Rednote style blog post.
          
          Rules:
          1. Use an engaging title with emojis.
          2. Use emojis throughout the text.
          3. Keep paragraphs short and punchy.
          4. Use a friendly, enthusiastic tone.
          5. Add relevant hashtags at the end.
          6. The content MUST be in Chinese (Simplified Chinese), regardless of the input language.
          
          Input Text:
          ${content}`,
                    },
                ],
            });

            markdown = styleResponse.choices?.[0]?.message?.content || '';
            logOpenAiRawResponseIfEmpty('RednoteStrategy.styleMarkdown', markdown.length, styleResponse);
            logApi('openai', 'RednoteStrategy.styleMarkdown ok', {
                model,
                durationMs: Date.now() - tStyle,
                outputChars: markdown.length,
            });
        } catch (err) {
            logApiError('openai', 'RednoteStrategy.styleMarkdown failed', err, {
                model,
                durationMs: Date.now() - tStyle,
            });
            throw err;
        }

        // Step 2: XHS images (webgemini / uploads) — best-effort: slides generate sequentially;
        // each successful file is uploaded separately so partial success still fills imageUrls.
        let imageUrls: string[] = [];
        try {
            imageUrls = await this.generateAndUploadImages(markdown);
        } catch (err) {
            logApiError(
                'api',
                'RednoteStrategy: XHS / webgemini pipeline failed; continuing with text-only markdown',
                err,
                { markdownChars: markdown.length },
            );
        }

        return { content: markdown, imageUrls };
    }

    private async generateAndUploadImages(markdown: string): Promise<string[]> {
        const backend = getImageGenerationBackendName();
        logApi(backend === 'google-ai' ? 'genai' : 'webgemini', 'RednoteStrategy.image backend availability check', {
            backend,
        });
        const available = await isWebgeminiAvailable();
        logApi(backend === 'google-ai' ? 'genai' : 'webgemini', 'RednoteStrategy.image backend availability result', {
            backend,
            ok: available,
        });
        if (!available) {
            logApi('api', 'RednoteStrategy: image backend unavailable; skipping XHS images', {
                backend,
            });
            return [];
        }

        const plan = await planXhsImages(this.openai, markdown);
        console.log(`[RednoteStrategy] Image plan: slug="${plan.slug}", count=${plan.images.length}`);
        logApi('api', 'RednoteStrategy.planXhsImages done', { slug: plan.slug, imageCount: plan.images.length });

        const tGen = Date.now();
        const localPaths = await generateXhsImages(plan);
        logApi(backend === 'google-ai' ? 'genai' : 'webgemini', 'RednoteStrategy.generateXhsImages done', {
            durationMs: Date.now() - tGen,
            fileCount: localPaths.length,
            expectedSlides: plan.images.length,
            backend,
        });

        const urls: string[] = [];
        for (const localPath of localPaths) {
            try {
                const url = await uploadToBitstripe(localPath);
                urls.push(url);
                console.log(`[RednoteStrategy] Uploaded: ${url}`);
            } catch (err) {
                console.error(`[RednoteStrategy] Upload failed for ${localPath}:`, err);
                logApiError('bitstripe', 'RednoteStrategy.upload image failed', err, { localPath });
            }
        }

        if (urls.length === 0) {
            logApi('api', 'RednoteStrategy: all image uploads failed; continuing without image URLs', {
                localPathCount: localPaths.length,
            });
            return [];
        }

        return urls;
    }
}
