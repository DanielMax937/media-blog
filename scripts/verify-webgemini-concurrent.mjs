/**
 * 临时脚本：并发 3 路调用 webgemini POST /image，并轮询至完成，用于验证服务端并发能力。
 *
 * 用法（在 blog2media 目录）:
 *   node scripts/verify-webgemini-concurrent.mjs
 *
 * 环境变量（可选，与项目一致）:
 *   WEBGEMINI_URL — 默认 http://127.0.0.1:8200
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadDotenv() {
    if (!existsSync(envPath)) return;
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
        ) {
            v = v.slice(1, -1);
        }
        if (process.env[k] === undefined) process.env[k] = v;
    }
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    loadDotenv();
    const base = (process.env.WEBGEMINI_URL || 'http://127.0.0.1:8200').replace(/\/$/, '');

    console.log(`[verify-webgemini] base = ${base}`);

    const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    console.log(`[verify-webgemini] GET /health → ${healthRes.status} ${healthRes.ok ? 'ok' : ''}`);
    if (!healthRes.ok) {
        console.error('[verify-webgemini] webgemini 不可用，请先启动服务后再试。');
        process.exit(1);
    }

    const prompts = [
        'Minimal abstract test image A for concurrency verify: soft blue gradient, simple geometric shape, 3:4 aspect ratio.',
        'Minimal abstract test image B for concurrency verify: soft green gradient, simple geometric shape, 3:4 aspect ratio.',
        'Minimal abstract test image C for concurrency verify: soft orange gradient, simple geometric shape, 3:4 aspect ratio.',
    ];

    const submitOne = async (index) => {
        const formData = new FormData();
        formData.append('prompt', prompts[index]);
        const t0 = Date.now();
        const res = await fetch(`${base}/image`, { method: 'POST', body: formData });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`POST /image #${index + 1} HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error(`POST /image #${index + 1}: 非 JSON 响应: ${text.slice(0, 200)}`);
        }
        const jobId = body.job_id;
        if (!jobId) {
            throw new Error(`POST /image #${index + 1}: 缺少 job_id: ${text.slice(0, 300)}`);
        }
        console.log(
            `[verify-webgemini] 提交 #${index + 1} → job_id=${jobId} (${Date.now() - t0}ms)`
        );
        return { index, jobId, submitAt: t0 };
    };

    console.log('[verify-webgemini] 并发提交 3 个 /image …');
    const submitStart = Date.now();
    const submitted = await Promise.all([0, 1, 2].map((i) => submitOne(i)));
    console.log(`[verify-webgemini] 3 路提交完成，耗时 ${Date.now() - submitStart}ms`);

    const pollOne = async ({ index, jobId }) => {
        const t0 = Date.now();
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let polls = 0;
        while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            polls += 1;
            const pollRes = await fetch(`${base}/image/${jobId}`);
            if (!pollRes.ok) continue;
            const result = await pollRes.json();
            if (result.status === 'completed' && result.images?.length) {
                const localPath = result.images[0].local_path;
                console.log(
                    `[verify-webgemini] #${index + 1} job=${jobId} 完成 polls=${polls} ` +
                        `耗时=${Date.now() - t0}ms path=${localPath}`
                );
                return { index, jobId, polls, localPath, ok: true };
            }
            if (result.status === 'failed') {
                throw new Error(`job ${jobId} (#${index + 1}) status=failed`);
            }
        }
        throw new Error(`job ${jobId} (#${index + 1}) 轮询超时`);
    };

    const pollStart = Date.now();
    const outcomes = await Promise.all(submitted.map((s) => pollOne(s)));
    console.log(`[verify-webgemini] 3 路全部完成，轮询阶段 wall ${Date.now() - pollStart}ms`);
    console.log('[verify-webgemini] 结果:', outcomes);
}

main().catch((err) => {
    console.error('[verify-webgemini] 失败:', err);
    process.exit(1);
});
