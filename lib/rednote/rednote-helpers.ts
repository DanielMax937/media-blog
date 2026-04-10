import type OpenAI from 'openai';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { scrapeUrlBodyText } from '@/lib/services/chrome-devtools-scrape';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from '@/lib/services/api-logger';
import { uploadToBitstripe } from '@/lib/services/BitstripeUploader';

export async function scrapeUrl(url: string): Promise<string> {
    logApi('browser', 'rednote.scrapeUrl start', { url });
    const t0 = Date.now();
    try {
        const text = await scrapeUrlBodyText(url);
        logApi('browser', 'rednote.scrapeUrl ok', {
            url,
            durationMs: Date.now() - t0,
            textChars: text.length,
            success: true,
        });
        return text;
    } catch (err) {
        logApiError('browser', 'rednote.scrapeUrl failed', err, { url, durationMs: Date.now() - t0 });
        throw err;
    }
}

export async function extractMainContent(openai: OpenAI, raw: string): Promise<string> {
    const model = process.env.OPENAI_MODEL ?? 'gpt-5.4';
    const t0 = Date.now();
    logApi('openai', 'rednote.extractMainContent start', { model, inputChars: raw.length });
    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a helpful assistant that extracts the main content from a webpage text. Ignore navigation, footers, and sidebars. Return ONLY the main article text.',
                },
                {
                    role: 'user',
                    content: `Extract the main content from this text:\n\n${raw.substring(0, 20000)}`,
                },
            ],
        });
        const text = response.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('rednote.extractMainContent', text.length, response);
        logApi('openai', 'rednote.extractMainContent ok', {
            model,
            durationMs: Date.now() - t0,
            outputChars: text.length,
        });
        return text;
    } catch (err) {
        logApiError('openai', 'rednote.extractMainContent failed', err, {
            model,
            durationMs: Date.now() - t0,
        });
        throw err;
    }
}

export async function writeMdAndUpload(markdown: string, prefix: string): Promise<string> {
    const filename = `${prefix}-${Date.now()}.md`;
    const tmpPath = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpPath, markdown, 'utf-8');
    logApi('bitstripe', 'rednote.uploadMarkdown start', { prefix, tmpPath, markdownChars: markdown.length });
    try {
        const publicUrl = await uploadToBitstripe(tmpPath);
        logApi('bitstripe', 'rednote.uploadMarkdown ok', { publicUrl });
        return publicUrl;
    } finally {
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            /* ignore */
        }
    }
}
