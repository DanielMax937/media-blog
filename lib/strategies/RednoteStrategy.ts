import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';
import { isWebgeminiAvailable, planXhsImages, generateXhsImages } from '../services/XhsImageService';
import { uploadToBitstripe } from '../services/BitstripeUploader';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from '../services/api-logger';
import { getImageGenerationBackendName } from '../services/GoogleImageService';

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
            const styleResponse = await this.openai.chat.completions.create({
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

        // Step 2: Generate XHS images and upload to BitStripe
        const imageUrls = await this.generateAndUploadImages(markdown);

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
            throw new Error(
                `[RednoteStrategy] ${backend} image generation backend unavailable — ` +
                'XHS image generation is required for Xiaohongshu posts'
            );
        }

        const plan = await planXhsImages(this.openai, markdown);
        console.log(`[RednoteStrategy] Image plan: slug="${plan.slug}", count=${plan.images.length}`);
        logApi('api', 'RednoteStrategy.planXhsImages done', { slug: plan.slug, imageCount: plan.images.length });

        const tGen = Date.now();
        const localPaths = await generateXhsImages(plan);
        logApi(backend === 'google-ai' ? 'genai' : 'webgemini', 'RednoteStrategy.generateXhsImages done', {
            durationMs: Date.now() - tGen,
            fileCount: localPaths.length,
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
            throw new Error('[RednoteStrategy] All image uploads failed — no image URLs available');
        }

        return urls;
    }
}
