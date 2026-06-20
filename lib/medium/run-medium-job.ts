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
import { extractAllUrls, extractImageUrls } from '@/lib/markdown-extract-urls';
import { writeAstroMicroMdxFromMedium } from '@/lib/services/AstroMicroMdxService';
import { commitAndPushAstroMicroPost } from '@/lib/services/AstroMicroGitService';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
});

export { extractAllUrls, extractImageUrls } from '@/lib/markdown-extract-urls';

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
        const { content: markdown, demo } = await strategy.generate(mainContent);
        const imageUrls = extractImageUrls(markdown);
        const artifactUrls = extractAllUrls(markdown);
        const mdUrl = await writeMdAndUpload(markdown, 'medium');
        let mdxLocalPath: string | null = null;

        try {
            const mdxResult = writeAstroMicroMdxFromMedium({
                markdown,
                demoHtml: demo,
                imageUrls,
                sourceUrl: requestUrl,
            });
            mdxLocalPath = mdxResult.filePath;
            logApi('api', 'medium mdx copied to astro-micro', {
                jobId,
                url: requestUrl,
                slug: mdxResult.slug,
                filePath: mdxResult.filePath,
            });

            try {
                const publishResult = await commitAndPushAstroMicroPost({
                    postDir: mdxResult.postDir,
                    slug: mdxResult.slug,
                    sourceUrl: requestUrl,
                });
                logApi('api', 'medium mdx published to astro-micro git', {
                    jobId,
                    url: requestUrl,
                    slug: mdxResult.slug,
                    committed: publishResult.committed,
                    pushed: publishResult.pushed,
                    commitSha: publishResult.commitSha ?? null,
                    reason: publishResult.reason ?? null,
                });
            } catch (publishError) {
                logApiError('api', 'medium mdx git publish failed', publishError, {
                    jobId,
                    url: requestUrl,
                    slug: mdxResult.slug,
                    filePath: mdxResult.filePath,
                });
            }
        } catch (mdxError) {
            logApiError('api', 'medium mdx copy failed', mdxError, {
                jobId,
                url: requestUrl,
            });
        }

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
            mdxLocalPath,
            generationLogId,
        });
        await notifyMediumCompletion(jobId, requestUrl, mdUrl, imageUrls, artifactUrls, mdxLocalPath);
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
    mdxLocalPath: string | null,
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
            localArtifactPaths: mdxLocalPath ? [mdxLocalPath] : undefined,
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
