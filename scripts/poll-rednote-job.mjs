/**
 * 轮询 GET /api/rednote/[jobId]，直到 status 为 completed 或 failed。
 *
 * 用法（在 blog2media 目录）:
 *   node scripts/poll-rednote-job.mjs <jobId>
 *   BLOG_BASE_URL=http://127.0.0.1:3001 node scripts/poll-rednote-job.mjs <jobId>
 *
 * 可选环境变量:
 *   BLOG_BASE_URL — 默认 http://127.0.0.1:3001
 *   POLL_INTERVAL_MS — 默认 5000
 *   POLL_MAX_MS — 默认 3600000（1 小时）
 */

const jobId = process.argv[2];
if (!jobId) {
    console.error('用法: node scripts/poll-rednote-job.mjs <jobId>');
    process.exit(1);
}

const base = (process.env.BLOG_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const maxMs = Number(process.env.POLL_MAX_MS ?? 3600_000);

const url = `${base}/api/rednote/${jobId}`;
const started = Date.now();

async function main() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (Date.now() - started > maxMs) {
            console.error(`[poll-rednote] 超过 POLL_MAX_MS (${maxMs}ms)，退出`);
            process.exit(1);
        }
        const t0 = Date.now();
        let res;
        try {
            res = await fetch(url, {
                signal: AbortSignal.timeout(60_000),
            });
        } catch (e) {
            console.error(`[poll-rednote] 请求失败 (${Date.now() - t0}ms):`, e.message);
            await new Promise((r) => setTimeout(r, intervalMs));
            continue;
        }
        const text = await res.text();
        if (!res.ok) {
            console.error(`[poll-rednote] HTTP ${res.status}: ${text.slice(0, 500)}`);
            process.exit(res.status === 404 ? 2 : 1);
        }
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            console.error('[poll-rednote] 非 JSON:', text.slice(0, 200));
            await new Promise((r) => setTimeout(r, intervalMs));
            continue;
        }
        const st = body.status;
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[poll-rednote] +${elapsed}s status=${st}`);
        if (st === 'completed' || st === 'failed') {
            console.log(JSON.stringify(body, null, 2));
            process.exit(st === 'completed' ? 0 : 3);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

main().catch((e) => {
    console.error('[poll-rednote]', e);
    process.exit(1);
});
