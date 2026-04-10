import OpenAI from 'openai';
import { RednoteStrategy } from '@/lib/strategies/RednoteStrategy';
import { logApi, logApiError } from '@/lib/services/api-logger';
import { getOpenAiBaseUrl } from '@/lib/openai-base-url';
import {
    logGeneration,
    updateRednoteJob,
} from '@/lib/services/SqliteService';
import { extractMainContent, scrapeUrl, writeMdAndUpload } from '@/lib/rednote/rednote-helpers';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
});

/**
 * Runs the full Rednote pipeline in the background: scrape → LLM → strategy → upload → SQLite.
 * Updates `rednote_job` row for `jobId` as work progresses and on success/failure.
 */
export async function runRednoteJob(jobId: string, requestUrl: string): Promise<void> {
    updateRednoteJob(jobId, { status: 'processing', error: null });

    try {
        const rawContent = await scrapeUrl(requestUrl);
        if (!rawContent) {
            const err = 'Failed to extract content from URL';
            updateRednoteJob(jobId, { status: 'failed', error: err });
            logApi('api', 'rednote job scrape empty body', { jobId, url: requestUrl });
            return;
        }

        const mainContent = await extractMainContent(openai, rawContent);
        const strategy = new RednoteStrategy(openai);
        const { content: markdown, imageUrls = [] } = await strategy.generate(mainContent);
        const mdUrl = await writeMdAndUpload(markdown, 'rednote');
        const generationLogId = logGeneration(requestUrl, mdUrl, imageUrls);

        updateRednoteJob(jobId, {
            status: 'completed',
            md_url: mdUrl,
            image_urls: JSON.stringify(imageUrls),
            generation_log_id: generationLogId,
            error: null,
        });

        logApi('api', 'rednote job completed', {
            jobId,
            url: requestUrl,
            mdUrl,
            imageCount: imageUrls.length,
            markdownChars: markdown.length,
            generationLogId,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[runRednoteJob]', jobId, error);
        updateRednoteJob(jobId, { status: 'failed', error: message });
        logApiError('api', 'rednote job failed', error, { jobId, url: requestUrl });
    }
}
