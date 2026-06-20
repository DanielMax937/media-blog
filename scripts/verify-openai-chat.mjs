/**
 * 临时脚本：从项目根 `.env` 读取 OPENAI_API_KEY / OPENAI_BASE_URL，
 * 调用 OpenAI 兼容的 chat.completions，用于确认网关与密钥是否可用。
 *
 * 用法（在 blog2media 目录）:
 *   node scripts/verify-openai-chat.mjs
 * 可选环境变量:
 *   OPENAI_VERIFY_MODEL — 覆盖默认模型（默认取 OPENAI_MODEL；未设置则使用网关默认模型）
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadDotenv() {
    if (!existsSync(envPath)) {
        console.error(`未找到 ${envPath}，请在 blog2media 根目录配置 .env`);
        process.exit(1);
    }
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
        process.env[k] = v;
    }
}

function maskKey(key) {
    if (!key || key.length < 12) return '(too short or missing)';
    return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function looksLikeHtml(s) {
    return typeof s === 'string' && /^\s*</.test(s) && /<\/html>\s*$/i.test(s.trim());
}

loadDotenv();

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const model =
    process.env.OPENAI_VERIFY_MODEL ||
    process.env.OPENAI_MODEL ||
    undefined;

console.log('--- verify-openai-chat ---');
console.log('baseURL:', baseURL ?? '(undefined — SDK 将用默认 api.openai.com)');
console.log('apiKey:', maskKey(apiKey));
console.log('model:', model ?? '(gateway default)');
console.log('');

if (!apiKey) {
    console.error('OPENAI_API_KEY 未设置');
    process.exit(1);
}

const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
});

try {
    const request = {
        messages: [
            { role: 'system', content: 'You reply with one short English sentence.' },
            { role: 'user', content: 'Say hello in exactly three words.' },
        ],
        max_tokens: 64,
        ...(model ? { model } : {}),
    };
    const response = await client.chat.completions.create(request);

    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? '';
    const finish = choice?.finish_reason;

    console.log('HTTP/SDK: ok');
    console.log('finish_reason:', finish);
    console.log('content length:', content.length);
    console.log('content preview:', JSON.stringify(content.slice(0, 200)));

    if (!content.length) {
        console.error('\n内容为空。若网关错误返回了管理后台 HTML，请检查 baseURL 是否指向 /v1 等 API 根路径。');
        const rt = typeof response;
        console.error('response typeof:', rt);
        if (rt === 'string') {
            console.error('response 为字符串（非标准 SDK 对象），前 800 字符:');
            console.error(response.slice(0, 800));
        } else if (response && rt === 'object') {
            let dump;
            try {
                dump = JSON.stringify(response, null, 2);
            } catch {
                dump = String(response);
            }
            console.error('response 摘要（前 2500 字符）:\n', dump.slice(0, 2500));
        }
        process.exit(2);
    }

    if (looksLikeHtml(content)) {
        console.error('\n返回内容像 HTML（多为网关返回了 Web 控制台页面，而非 JSON API）。请核对 OPENAI_BASE_URL。');
        process.exit(3);
    }

    console.log('\n结论: OPENAI_BASE_URL + OPENAI_API_KEY 可正常完成 chat 调用。');
    process.exit(0);
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('调用失败:', msg);
    if (err?.status) console.error('status:', err.status);
    if (err?.code) console.error('code:', err.code);
    process.exit(1);
}
