import OpenAI from 'openai';
import { MediumStrategy } from '@/lib/strategies/MediumStrategy';
import { logApi, logApiError } from '@/lib/services/api-logger';
import { getOpenAiBaseUrl } from '@/lib/openai-base-url';
import {
    logGeneration,
    updateMediumJob,
} from '@/lib/services/SqliteService';
import { extractMainContent, scrapeUrl, writeMdAndUpload } from '@/lib/rednote/rednote-helpers';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
});

/**
 * Extract all image URLs from markdown image syntax: ![alt](url)
 */
export function extractImageUrls(markdown: string): string[] {
    const pattern = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
    const urls: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
        urls.push(match[1]);
    }
    return urls;
}

/**
 * Runs the full Medium pipeline in the background: scrape → LLM → strategy → upload → SQLite.
 * Updates `medium_job` row for `jobId` as work progresses and on success/failure.
 */
export async function runMediumJob(jobId: string, requestUrl: string): Promise<void> {
    updateMediumJob(jobId, { status: 'processing', error: null });

    try {
        const rawContent = await scrapeUrl(requestUrl);
        if (!rawContent) {
            const err = 'Failed to extract content from URL';
            updateMediumJob(jobId, { status: 'failed', error: err });
            logApi('api', 'medium job scrape empty body', { jobId, url: requestUrl });
            return;
        }

        const mainContent = await extractMainContent(openai, rawContent);
        const strategy = new MediumStrategy(openai);
        const { content: markdown } = await strategy.generate(mainContent);
        const imageUrls = extractImageUrls(markdown);
        const mdUrl = await writeMdAndUpload(markdown, 'medium');
        const generationLogId = logGeneration(requestUrl, mdUrl, imageUrls, 'medium');

        updateMediumJob(jobId, {
            status: 'completed',
            md_url: mdUrl,
            image_urls: JSON.stringify(imageUrls),
            generation_log_id: generationLogId,
            error: null,
        });

        logApi('api', 'medium job completed', {
            jobId,
            url: requestUrl,
            mdUrl,
            imageCount: imageUrls.length,
            markdownChars: markdown.length,
            generationLogId,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[runMediumJob]', jobId, error);
        updateMediumJob(jobId, { status: 'failed', error: message });
        logApiError('api', 'medium job failed', error, { jobId, url: requestUrl });
    }
}
