import { logApi, logApiError } from '@/lib/services/api-logger';
import { withWebgeminiConcurrency } from '@/lib/services/webgemini-concurrency';

const WEBGEMINI_BASE = (process.env.WEBGEMINI_URL ?? 'http://127.0.0.1:8200').replace(/\/$/, '');

const POLL_INTERVAL_MS = 5000;
/** webgemini default WG_TASK_TIMEOUT_S is 600s; allow extra margin for queue + polling. */
const CHAT_POLL_TIMEOUT_MS = 15 * 60 * 1000;

type ChatPollJson = {
    status: string;
    text?: string | null;
    error?: string | null;
};

/**
 * Submits `POST /chat` and polls `GET /chat/{job_id}` until completed or failed.
 */
export async function completeWebgeminiChat(prompt: string): Promise<string> {
    return withWebgeminiConcurrency(async () => {
        const t0 = Date.now();
        logApi('webgemini', 'POST /chat submit', { base: WEBGEMINI_BASE, promptChars: prompt.length });
        const submitRes = await fetch(`${WEBGEMINI_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: AbortSignal.timeout(120_000),
        });
        if (!submitRes.ok) {
            const body = await submitRes.text();
            logApi('webgemini', 'POST /chat failed', { status: submitRes.status, bodySnippet: body.slice(0, 240) });
            throw new Error(`webgemini POST /chat failed: ${submitRes.status} ${body.slice(0, 400)}`);
        }
        const { job_id: jobId } = (await submitRes.json()) as { job_id: string };
        logApi('webgemini', 'POST /chat queued', { jobId, durationMs: Date.now() - t0 });

        const deadline = Date.now() + CHAT_POLL_TIMEOUT_MS;
        let polls = 0;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            polls += 1;
            const pollRes = await fetch(`${WEBGEMINI_BASE}/chat/${jobId}`, {
                signal: AbortSignal.timeout(60_000),
            });
            if (!pollRes.ok) {
                logApi('webgemini', 'GET /chat/{id} non-ok', { jobId, status: pollRes.status });
                continue;
            }
            const result = (await pollRes.json()) as ChatPollJson;
            if (result.status === 'completed') {
                const text = result.text ?? '';
                if (!text.trim()) {
                    throw new Error('webgemini chat completed but returned empty text');
                }
                logApi('webgemini', 'GET /chat/{id} completed', {
                    jobId,
                    polls,
                    durationMs: Date.now() - t0,
                    textChars: text.length,
                });
                return text;
            }
            if (result.status === 'failed') {
                const err = result.error || 'unknown error';
                logApiError('webgemini', 'chat job failed', new Error(err), { jobId, polls });
                throw new Error(`webgemini chat failed: ${err}`);
            }
        }
        logApi('webgemini', 'chat poll timeout', { jobId, polls, durationMs: Date.now() - t0 });
        throw new Error(`webgemini chat job ${jobId} timed out after ${CHAT_POLL_TIMEOUT_MS}ms`);
    });
}
