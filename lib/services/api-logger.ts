import fs from 'fs/promises';
import path from 'path';
import util from 'util';

/** Defaults to project-root `blog2media.log` (already in .gitignore). */
const LOG_FILE = process.env.BLOG2MEDIA_LOG_FILE ?? path.join(process.cwd(), 'blog2media.log');

export type ApiLogCategory = 'openai' | 'claude' | 'webgemini' | 'genai' | 'bitstripe' | 'browser' | 'api';

/**
 * Append one TSV-style line to the log file (async, non-blocking).
 * Skips file I/O when `NODE_ENV === 'test'` so Jest does not pollute the log.
 */
export function logApi(
    category: ApiLogCategory,
    message: string,
    meta?: Record<string, string | number | boolean | null | undefined>
): void {
    if (process.env.NODE_ENV === 'test') return;

    const ts = new Date().toISOString();
    let suffix = '';
    if (meta && Object.keys(meta).length > 0) {
        try {
            suffix = `\t${JSON.stringify(meta)}`;
        } catch {
            suffix = '\t(meta not serializable)';
        }
    }
    const line = `${ts}\t[${category}]\t${message}${suffix}\n`;
    void fs.appendFile(LOG_FILE, line, 'utf8').catch((e) => {
        console.error('[api-logger] appendFile failed:', e);
    });
}

export function logApiError(
    category: ApiLogCategory,
    message: string,
    err: unknown,
    meta?: Record<string, string | number | boolean | null | undefined>
): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    logApi(category, `${message}: ${errMsg}`, {
        ...meta,
        errName: err instanceof Error ? err.name : typeof err,
    });
}

/**
 * When assistant message content is empty, append the full raw SDK response object to the log file
 * (JSON when possible, else util.inspect) so upstream/proxy issues can be diagnosed.
 */
export function logOpenAiRawResponseIfEmpty(context: string, contentLength: number, response: unknown): void {
    if (contentLength > 0) return;
    if (process.env.NODE_ENV === 'test') return;

    let raw: string;
    try {
        raw = JSON.stringify(response, null, 2);
    } catch {
        raw = util.inspect(response, {
            depth: 12,
            maxArrayLength: null,
            maxStringLength: 200_000,
        });
    }
    const ts = new Date().toISOString();
    const header = `${ts}\t[openai]\t${context} empty message content — full raw LLM response object:\n`;
    void fs.appendFile(LOG_FILE, `${header}${raw}\n----\n`, 'utf8').catch((e) => {
        console.error('[api-logger] appendFile (raw response) failed:', e);
    });
}
