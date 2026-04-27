import fs from 'fs';
import os from 'os';
import OpenAI from 'openai';
import { logApi, logApiError } from '@/lib/services/api-logger';
import { getOpenAiBaseUrl } from '@/lib/openai-base-url';
import {
    logGeneration,
    updateFuturesJob,
} from '@/lib/services/SqliteService';
import { sendJobNotification } from '@/lib/services/TelegramService';
import { writeMdAndUpload } from '@/lib/rednote/rednote-helpers';
import { uploadToBitstripe } from '@/lib/services/BitstripeUploader';
import { generateCoverImage } from '@/lib/services/CoverImageService';
import { completeWebgeminiDeepResearch } from '@/lib/futures/webgemini-deepresearch';
import { extractAllUrls, extractImageUrls } from '@/lib/markdown-extract-urls';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
});

function stripOuterMarkdownFence(text: string): string {
    const t = text.trim();
    const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(t);
    if (m) return m[1].trim();
    return t;
}

function buildFuturesReportPrompt(ymd: string): string {
    const dateDisplay = `${ymd.slice(0, 4)}年${ymd.slice(4, 6)}月${ymd.slice(6, 8)}日`;
    return `你是一位资深期货分析师，兼长**微信公众号长文**排版。

请用 **Gemini Deep Research** 研究并撰写一份 ${dateDisplay} 的**中国期货市场复盘报告**，整体风格要贴近**微信公众号**：读者友好、段落分明、小标题醒目，但仍保持专业与克制（避免空洞鸡汤、避免标题党）。

输出要求：
1. 使用 **Markdown**；首行必须是 \`# 标题\`，标题需概括日期与复盘主题，并适合公众号转发语意。
2. 结构建议（可按实际信息删减）：**导语式开头**（2–4 句抓要点）→ 分节小标题（如 \`## 一、盘面速览\`、\`## 二、品种与板块\` 等）→ **关键驱动与逻辑** → **风险与关注点** → **简要展望或操作思路备忘**。
3. 所有数据和分析必须基于真实市场信息，**严禁编造**具体数字、涨跌幅或未出现的合约信息。
4. 语言：**中文为主**；专业、可读；可适当用「我们」「本期」等公众号常用口吻，但不要过度口语化。
5. **不要**输出任何前言或后记（例如「以下是报告」「本文由 AI 生成」）；**只输出 Markdown 正文**。`;
}

async function prependCoverImage(markdown: string): Promise<{ markdown: string; coverUrl: string | null }> {
    try {
        const tmpDir = os.tmpdir();
        const coverPath = await generateCoverImage(markdown, openai, tmpDir);
        if (!coverPath) return { markdown, coverUrl: null };

        const coverUrl = await uploadToBitstripe(coverPath).catch((err) => {
            console.warn('[runFuturesJob] Cover upload failed:', err);
            return null;
        });
        fs.unlink(coverPath, () => {});

        if (!coverUrl) return { markdown, coverUrl: null };

        const h1Match = markdown.match(/^(#\s+.+)$/m);
        if (h1Match) {
            const idx = markdown.indexOf(h1Match[0]) + h1Match[0].length;
            const coverBlock = `\n\n![封面](${coverUrl})\n`;
            return { markdown: markdown.slice(0, idx) + coverBlock + markdown.slice(idx), coverUrl };
        }
        return { markdown: `![封面](${coverUrl})\n\n` + markdown, coverUrl };
    } catch (err) {
        console.error('[runFuturesJob] prependCoverImage failed:', err);
        return { markdown, coverUrl: null };
    }
}

/**
 * Gemini Deep Research 生成指定日期中国期货市场复盘报告 → 封面图 → bitstripe → SQLite → Telegram。
 */
export async function runFuturesJob(jobId: string, overviewUrl: string, ymd: string): Promise<void> {
    updateFuturesJob(jobId, { status: 'processing', error: null });

    try {
        const prompt = buildFuturesReportPrompt(ymd);
        logApi('api', 'futures job webgemini deepresearch start', { jobId, date: ymd, promptChars: prompt.length });
        let markdown = stripOuterMarkdownFence(await completeWebgeminiDeepResearch(prompt));
        if (!markdown.trim()) {
            throw new Error('webgemini Deep Research 返回的 Markdown 为空');
        }

        const { markdown: mdWithCover, coverUrl } = await prependCoverImage(markdown);
        markdown = mdWithCover;

        const imageUrls = extractImageUrls(markdown);
        const artifactUrls = extractAllUrls(markdown);
        const mdUrl = await writeMdAndUpload(markdown, 'futures');
        const generationLogId = logGeneration(overviewUrl, mdUrl, imageUrls, 'futures');

        updateFuturesJob(jobId, {
            status: 'completed',
            md_url: mdUrl,
            image_urls: JSON.stringify(imageUrls),
            generation_log_id: generationLogId,
            error: null,
        });

        logApi('api', 'futures job completed', {
            jobId,
            url: overviewUrl,
            mdUrl,
            coverUrl,
            imageCount: imageUrls.length,
            markdownChars: markdown.length,
            generationLogId,
        });
        await notifyFuturesCompletion(jobId, overviewUrl, mdUrl, coverUrl, imageUrls, artifactUrls);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[runFuturesJob]', jobId, error);
        updateFuturesJob(jobId, { status: 'failed', error: message });
        logApiError('api', 'futures job failed', error, { jobId, url: overviewUrl });
        await notifyFuturesFailure(jobId, overviewUrl, message);
    }
}

async function notifyFuturesCompletion(
    jobId: string,
    sourceUrl: string,
    mdUrl: string,
    coverUrl: string | null,
    imageUrls: string[],
    artifactUrls: string[],
): Promise<void> {
    try {
        const mergedArtifacts = [...artifactUrls];
        if (coverUrl && !mergedArtifacts.includes(coverUrl)) {
            mergedArtifacts.unshift(coverUrl);
        }
        await sendJobNotification({
            platform: 'futures',
            status: 'completed',
            jobId,
            sourceUrl,
            mdUrl,
            imageUrls,
            artifactUrls: mergedArtifacts,
        });
    } catch (error) {
        logApiError('api', 'futures completion notification failed', error, {
            jobId,
            url: sourceUrl,
            mdUrl,
        });
    }
}

async function notifyFuturesFailure(jobId: string, sourceUrl: string, message: string): Promise<void> {
    try {
        await sendJobNotification({
            platform: 'futures',
            status: 'failed',
            jobId,
            sourceUrl,
            error: message,
        });
    } catch (error) {
        logApiError('api', 'futures failure notification failed', error, {
            jobId,
            url: sourceUrl,
            error: message,
        });
    }
}
