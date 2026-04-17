import OpenAI from 'openai';
import { MediumStrategy } from '@/lib/strategies/MediumStrategy';
import { logApi, logApiError } from '@/lib/services/api-logger';
import { getOpenAiBaseUrl } from '@/lib/openai-base-url';
import {
    logGeneration,
    updateMediumJob,
} from '@/lib/services/SqliteService';
import { sendJobNotification } from '@/lib/services/TelegramService';
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
 * Extract all http(s) URLs from markdown (links, images, etc.) and return unique list
 */
export function extractAllUrls(markdown: string): string[] {
    if (!markdown) return [];
    const pattern = /https?:\/\/[^\s)\]\">]+/g;
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(markdown)) !== null) {
        matches.add(m[0]);
    }
    return Array.from(matches);
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
            await notifyMediumFailure(jobId, requestUrl, err);
            return;
        }

        const mainContent = await extractMainContent(openai, rawContent);
        const strategy = new MediumStrategy(openai);
        const { content: markdown } = await strategy.generate(mainContent);
        const imageUrls = extractImageUrls(markdown);
        const artifactUrls = extractAllUrls(markdown);
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
        await notifyMediumCompletion(jobId, requestUrl, mdUrl, imageUrls, artifactUrls);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[runMediumJob]', jobId, error);
        updateMediumJob(jobId, { status: 'failed', error: message });
        logApiError('api', 'medium job failed', error, { jobId, url: requestUrl });
        await notifyMediumFailure(jobId, requestUrl, message);
    }
}

async function notifyMediumCompletion(
    jobId: string,
    requestUrl: string,
    mdUrl: string,
    imageUrls: string[],
    artifactUrls: string[],
): Promise<void> {
    try {
        await sendJobNotification({
            platform: 'medium',
            status: 'completed',
            jobId,
            sourceUrl: requestUrl,
            mdUrl,
            imageUrls,
            artifactUrls,
        });
    } catch (error) {
        logApiError('api', 'medium completion notification failed', error, {
            jobId,
            url: requestUrl,
            mdUrl,
        });
    }
}

async function notifyMediumFailure(
    jobId: string,
    requestUrl: string,
    message: string,
): Promise<void> {
    try {
        await sendJobNotification({
            platform: 'medium',
            status: 'failed',
            jobId,
            sourceUrl: requestUrl,
            error: message,
        });
    } catch (error) {
        logApiError('api', 'medium failure notification failed', error, {
            jobId,
            url: requestUrl,
            error: message,
        });
    }
}
