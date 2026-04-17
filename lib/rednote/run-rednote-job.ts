import OpenAI from 'openai';
import { RednoteStrategy } from '@/lib/strategies/RednoteStrategy';
import { logApi, logApiError } from '@/lib/services/api-logger';
import { getOpenAiBaseUrl } from '@/lib/openai-base-url';
import {
    logGeneration,
    updateRednoteJob,
} from '@/lib/services/SqliteService';
import { sendJobNotification } from '@/lib/services/TelegramService';
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
            await notifyRednoteFailure(jobId, requestUrl, err);
            return;
        }

        const mainContent = await extractMainContent(openai, rawContent);
        const strategy = new RednoteStrategy(openai);
        const { content: markdown, imageUrls = [] } = await strategy.generate(mainContent);
        const artifactUrls = (typeof markdown === 'string') ? Array.from(new Set((markdown.match(/https?:\/\/[^\s)\]\">]+/g) || []))) : [];
        const mdUrl = await writeMdAndUpload(markdown, 'rednote');
        // Persist source URL + md + image URLs to SQLite `generation_log` (and link from `rednote_job`).
        const generationLogId = logGeneration(requestUrl, mdUrl, imageUrls, 'rednote');

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
        await notifyRednoteCompletion(jobId, requestUrl, mdUrl, imageUrls, artifactUrls);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[runRednoteJob]', jobId, error);
        updateRednoteJob(jobId, { status: 'failed', error: message });
        logApiError('api', 'rednote job failed', error, { jobId, url: requestUrl });
        await notifyRednoteFailure(jobId, requestUrl, message);
    }
}

async function notifyRednoteCompletion(
    jobId: string,
    requestUrl: string,
    mdUrl: string,
    imageUrls: string[],
    artifactUrls: string[],
): Promise<void> {
    try {
        await sendJobNotification({
            platform: 'rednote',
            status: 'completed',
            jobId,
            sourceUrl: requestUrl,
            mdUrl,
            imageUrls,
            artifactUrls,
        });
    } catch (error) {
        logApiError('api', 'rednote completion notification failed', error, {
            jobId,
            url: requestUrl,
            mdUrl,
        });
    }
}

async function notifyRednoteFailure(
    jobId: string,
    requestUrl: string,
    message: string,
): Promise<void> {
    try {
        await sendJobNotification({
            platform: 'rednote',
            status: 'failed',
            jobId,
            sourceUrl: requestUrl,
            error: message,
        });
    } catch (error) {
        logApiError('api', 'rednote failure notification failed', error, {
            jobId,
            url: requestUrl,
            error: message,
        });
    }
}
