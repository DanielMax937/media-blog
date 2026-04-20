import { logApi, logApiError } from '@/lib/services/api-logger';
import { withWebgeminiConcurrency } from '@/lib/services/webgemini-concurrency';

const WEBGEMINI_BASE = (process.env.WEBGEMINI_URL ?? 'http://127.0.0.1:8200').replace(/\/$/, '');

function parsePositiveInt(raw: string | undefined, fallback: number, min?: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n)) return fallback;
    const floor = min ?? 1;
    return n >= floor ? n : fallback;
}

const POLL_INTERVAL_MS = parsePositiveInt(process.env.WEBGEMINI_DEEPRESEARCH_POLL_INTERVAL_MS, 20_000, 5_000);
/** Deep Research 常需 10–30+ 分钟；默认 55 分钟轮询上限，可用 WEBGEMINI_DEEPRESEARCH_POLL_TIMEOUT_MS 覆盖。 */
const DEEPRESEARCH_POLL_TIMEOUT_MS = parsePositiveInt(
    process.env.WEBGEMINI_DEEPRESEARCH_POLL_TIMEOUT_MS,
    55 * 60 * 1000,
    60_000,
);

type DeepResearchPollJson = {
    status: string;
    text?: string | null;
    error?: string | null;
};

/**
 * 提交 `POST /deepresearch`（multipart，`prompt` 字段），轮询 `GET /deepresearch/{job_id}` 直至完成或失败。
 */
export async function completeWebgeminiDeepResearch(prompt: string): Promise<string> {
    return withWebgeminiConcurrency(async () => {
        const t0 = Date.now();
        const form = new FormData();
        form.append('prompt', prompt);

        logApi('webgemini', 'POST /deepresearch submit', {
            base: WEBGEMINI_BASE,
            promptChars: prompt.length,
            pollTimeoutMs: DEEPRESEARCH_POLL_TIMEOUT_MS,
        });

        const submitRes = await fetch(`${WEBGEMINI_BASE}/deepresearch`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(180_000),
        });
        if (!submitRes.ok) {
            const body = await submitRes.text();
            logApi('webgemini', 'POST /deepresearch failed', {
                status: submitRes.status,
                bodySnippet: body.slice(0, 240),
            });
            throw new Error(`webgemini POST /deepresearch failed: ${submitRes.status} ${body.slice(0, 400)}`);
        }
        const { job_id: jobId } = (await submitRes.json()) as { job_id: string };
        logApi('webgemini', 'POST /deepresearch queued', { jobId, durationMs: Date.now() - t0 });

        const deadline = Date.now() + DEEPRESEARCH_POLL_TIMEOUT_MS;
        let polls = 0;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            polls += 1;
            const pollRes = await fetch(`${WEBGEMINI_BASE}/deepresearch/${jobId}`, {
                signal: AbortSignal.timeout(120_000),
            });
            if (!pollRes.ok) {
                logApi('webgemini', 'GET /deepresearch/{id} non-ok', { jobId, status: pollRes.status });
                continue;
            }
            const result = (await pollRes.json()) as DeepResearchPollJson;
            if (result.status === 'completed') {
                const text = result.text ?? '';
                if (!text.trim()) {
                    throw new Error('webgemini deepresearch completed but returned empty text');
                }
                logApi('webgemini', 'GET /deepresearch/{id} completed', {
                    jobId,
                    polls,
                    durationMs: Date.now() - t0,
                    textChars: text.length,
                });
                return text;
            }
            if (result.status === 'failed') {
                const err = result.error || 'unknown error';
                logApiError('webgemini', 'deepresearch job failed', new Error(err), { jobId, polls });
                throw new Error(`webgemini deepresearch failed: ${err}`);
            }
        }
        logApi('webgemini', 'deepresearch poll timeout', { jobId, polls, durationMs: Date.now() - t0 });
        throw new Error(`webgemini deepresearch job ${jobId} timed out after ${DEEPRESEARCH_POLL_TIMEOUT_MS}ms`);
    });
}
