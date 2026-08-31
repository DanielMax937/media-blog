/**
 * Page text scraping via local-service chrome-devtools-mcp-server (REST).
 * Default: http://127.0.0.1:9223 — see docs/API.md
 *
 * Timeouts (HTTP client `fetch`, not only MCP-internal navigation):
 * - `CDS_NAVIGATION_TIMEOUT_MS` — passed to MCP `new_page` as `timeout` (how long Chrome may load).
 * - `CDS_NEW_PAGE_HTTP_TIMEOUT_MS` — max wait for the **HTTP response** to `new_page` (must be
 *   ≥ navigation timeout + overhead; default = nav + `CDS_NEW_PAGE_HTTP_BUFFER_MS`).
 * - `CDS_EVAL_HTTP_TIMEOUT_MS` — `evaluate_script` (default 120s).
 * - `CDS_LIST_HTTP_TIMEOUT_MS` / `CDS_CLOSE_HTTP_TIMEOUT_MS` — `list_pages` / `close_page`.
 * - `CDS_V2EX_JOBS_POST_WAIT_MS` — after `new_page` on V2EX jobs tab, wait before scraping links (default 3000).
 * - `CDS_V2EX_DEBUG_HTML` — when `1`/`true`, or in development when not `0`/`false`: write full
 *   `document.documentElement.outerHTML` to `data/debug/v2ex-jobs-last.html` and log a short preview.
 */

import fs from 'fs';
import path from 'path';
import { logApi } from '@/lib/services/api-logger';
import { getChromiumLaunchOptions } from '@/lib/services/PlaywrightBrowser';

const CDS_BASE =
    process.env.CHROME_DEVTOOLS_MCP_URL?.replace(/\/$/, '') ||
    process.env.CDS_BASE_URL?.replace(/\/$/, '') ||
    'http://127.0.0.1:9223';

/** Server-side navigation budget for MCP (slow SPAs / V2EX, etc.). */
const DEFAULT_NAV_TIMEOUT_MS = 180_000;

/** Client HTTP must stay open until MCP finishes `new_page` (nav) + CDP overhead. */
const DEFAULT_NEW_PAGE_HTTP_BUFFER_MS = 90_000;

const DEFAULT_EVAL_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_LIST_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_SELECT_HTTP_TIMEOUT_MS = 60_000;

/** Let V2EX jobs list DOM settle after navigation before querying `.cell.item` (0 = skip). */
const DEFAULT_V2EX_JOBS_POST_WAIT_MS = 3_000;

/** Relative to `process.cwd()`; under `/data/` (gitignored). */
const V2EX_DEBUG_HTML_FILE = path.join('data', 'debug', 'v2ex-jobs-last.html');
const FORCE_PLAYWRIGHT_SCRAPE_ENV = 'FORCE_PLAYWRIGHT_SCRAPE';
const ZHANGXINXU_HOSTNAME = 'www.zhangxinxu.com';

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldForcePlaywright(): boolean {
    return isTruthy(process.env[FORCE_PLAYWRIGHT_SCRAPE_ENV]);
}

class WrongZhangxinxuPageError extends Error {
    constructor(message: string, public readonly href: string, public readonly targetUrl: string) {
        super(message);
        this.name = 'WrongZhangxinxuPageError';
    }
}

class WrongScrapePageError extends Error {
    constructor(message: string, public readonly href: string, public readonly targetUrl: string) {
        super(message);
        this.name = 'WrongScrapePageError';
    }
}

function shouldWriteV2exDebugHtml(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    const v = process.env.CDS_V2EX_DEBUG_HTML;
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
    return process.env.NODE_ENV === 'development';
}

function writeV2exDebugHtmlFile(fullHtml: string): string {
    const abs = path.join(process.cwd(), V2EX_DEBUG_HTML_FILE);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, fullHtml, 'utf8');
    return abs;
}

export type CdsToolResponse = {
    is_error: boolean;
    content: Array<{ type: string; text?: string }>;
};

function firstTextBlock(res: CdsToolResponse): string {
    for (const b of res.content) {
        if (b.text) return b.text;
    }
    return '';
}

function envMs(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
}

function evaluateScriptParams(pageId: number | null, script: string): Record<string, unknown> {
    if (pageId == null) {
        throw new Error('Chrome DevTools MCP evaluate_script requires pageId, but no pageId was found');
    }
    return {
        pageId,
        function: script,
        waitForStableDom: false,
    };
}

function isChromeDevtoolsUnavailableError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
        message.includes('Chrome DevTools MCP') ||
        message.includes('ECONNREFUSED') ||
        message.includes('fetch failed') ||
        message.includes('connect ECONNREFUSED') ||
        message.includes('connect EPERM')
    );
}

async function scrapeUrlBodyTextViaPlaywright(url: string): Promise<string> {
    const { chromium } = await import('playwright');
    const navTimeout = envMs('PW_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
    const browser = await chromium.launch(getChromiumLaunchOptions(false));
    const page = await browser.newPage();

    try {
        page.setDefaultNavigationTimeout(navTimeout);
        page.setDefaultTimeout(navTimeout);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        await page.waitForLoadState('networkidle', { timeout: Math.min(navTimeout, 30_000) }).catch(() => {
            /* tolerate slow long-polling pages */
        });
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        return text;
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

async function listV2exJobsTabCountLividTopicUrlsViaPlaywright(jobsTabUrl: string): Promise<string[]> {
    const { chromium } = await import('playwright');
    const navTimeout = envMs('PW_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
    const postWaitMs = envMs('CDS_V2EX_JOBS_POST_WAIT_MS', DEFAULT_V2EX_JOBS_POST_WAIT_MS);
    const browser = await chromium.launch(getChromiumLaunchOptions(false));
    const page = await browser.newPage();

    try {
        page.setDefaultNavigationTimeout(navTimeout);
        page.setDefaultTimeout(navTimeout);
        await page.goto(jobsTabUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        await page.waitForLoadState('networkidle', { timeout: Math.min(navTimeout, 30_000) }).catch(() => {});
        if (postWaitMs > 0) {
            await page.waitForTimeout(postWaitMs);
        }
        return await page.evaluate(() => {
            const seen = new Set<string>();
            const out: string[] = [];
            const base = 'https://www.v2ex.com';
            for (const cell of document.querySelectorAll('#Main .cell.item')) {
                const a = cell.querySelector('a.count_livid') as HTMLAnchorElement | null;
                if (!a || !a.href) continue;
                try {
                    const u = new URL(a.getAttribute('href') || a.href, base);
                    if (!u.pathname.startsWith('/t/')) continue;
                    u.hash = '';
                    const canonical = u.href;
                    if (!seen.has(canonical)) {
                        seen.add(canonical);
                        out.push(canonical);
                    }
                } catch {
                    /* ignore malformed links */
                }
            }
            return out;
        });
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

async function listZhangxinxuCategoryArticleUrlsViaPlaywright(categoryUrl: string): Promise<string[]> {
    const { chromium } = await import('playwright');
    const navTimeout = envMs('PW_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
    const browser = await chromium.launch(getChromiumLaunchOptions(false));
    const page = await browser.newPage();

    try {
        page.setDefaultNavigationTimeout(navTimeout);
        page.setDefaultTimeout(navTimeout);
        await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        await page.waitForLoadState('networkidle', { timeout: Math.min(navTimeout, 30_000) }).catch(() => {});
        return await page.evaluate(() => {
            const seen = new Set<string>();
            const out: string[] = [];
            const selectors = [
                'a[rel="bookmark"]',
                '.entry-title a',
                'article h2 a',
                '.post h2 a',
                'h2 a[rel="bookmark"]',
            ];
            const anchors = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
            for (const anchor of anchors) {
                const a = anchor as HTMLAnchorElement;
                const href = (a.getAttribute('href') || a.href || '').trim();
                if (!href) continue;
                try {
                    const u = new URL(href, location.href);
                    if (!/^https:\/\/www\.zhangxinxu\.com\/wordpress\/\d{4}\/\d{2}\//.test(u.href)) continue;
                    u.hash = '';
                    u.search = '';
                    const canonical = u.href;
                    if (!seen.has(canonical)) {
                        seen.add(canonical);
                        out.push(canonical);
                    }
                } catch {
                    /* ignore malformed links */
                }
            }
            return out;
        });
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

async function cdsPost(
    toolPath: string,
    body: Record<string, unknown>,
    fetchTimeoutMs: number,
): Promise<CdsToolResponse> {
    const url = `${CDS_BASE}${toolPath.startsWith('/') ? '' : '/'}${toolPath}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(fetchTimeoutMs),
        });
    } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
            throw new Error(
                `Chrome DevTools MCP ${toolPath} HTTP timeout after ${fetchTimeoutMs}ms (raise CDS_*_HTTP_TIMEOUT_MS or CDS_NAVIGATION_TIMEOUT_MS)`,
            );
        }
        throw err;
    }
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Chrome DevTools MCP ${toolPath} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    let json: CdsToolResponse;
    try {
        json = JSON.parse(text) as CdsToolResponse;
    } catch {
        throw new Error(`Chrome DevTools MCP ${toolPath}: invalid JSON: ${text.slice(0, 200)}`);
    }
    return json;
}

async function selectPageById(pageId: number, selectTimeoutMs: number): Promise<void> {
    const select = await cdsPost('/api/select_page', { pageId }, selectTimeoutMs);
    if (select.is_error) {
        throw new Error(firstTextBlock(select) || `select_page failed for pageId=${pageId}`);
    }
}

type CdsPageEntry = {
    pageId: number;
    url?: string;
    selected?: boolean;
};

function normalizeUrlPathname(pathname: string): string {
    return pathname.replace(/\/+$/, '') || '/';
}

function isMatchingZhangxinxuCategoryHref(href: string, targetUrl: string): boolean {
    try {
        const current = new URL(href);
        const target = new URL(targetUrl);
        return (
            current.hostname === ZHANGXINXU_HOSTNAME &&
            target.hostname === ZHANGXINXU_HOSTNAME &&
            normalizeUrlPathname(current.pathname) === normalizeUrlPathname(target.pathname)
        );
    } catch {
        return false;
    }
}

function isMatchingTargetHref(href: string, targetUrl: string): boolean {
    try {
        const current = new URL(href);
        const target = new URL(targetUrl);
        return (
            current.hostname === target.hostname &&
            normalizeUrlPathname(current.pathname) === normalizeUrlPathname(target.pathname)
        );
    } catch {
        return false;
    }
}

function pageEntryFromUnknown(value: unknown): CdsPageEntry | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;
    const pageIdValue = o.pageId ?? o.page_id ?? o.id ?? o.index;
    const pageId =
        typeof pageIdValue === 'number'
            ? pageIdValue
            : typeof pageIdValue === 'string' && /^\d+$/.test(pageIdValue)
                ? Number(pageIdValue)
                : null;
    if (pageId == null) return null;
    return {
        pageId,
        url: typeof o.url === 'string' ? o.url : typeof o.href === 'string' ? o.href : undefined,
        selected: o.selected === true || o.isSelected === true,
    };
}

function pageEntriesFromJson(value: unknown): CdsPageEntry[] {
    if (Array.isArray(value)) return value.map(pageEntryFromUnknown).filter((x): x is CdsPageEntry => x != null);
    if (!value || typeof value !== 'object') return [];
    const o = value as Record<string, unknown>;
    const candidates = [o.pages, o.tabs, o.targets, o.data].filter(Array.isArray);
    for (const candidate of candidates) {
        const entries = pageEntriesFromJson(candidate);
        if (entries.length > 0) return entries;
    }
    const single = pageEntryFromUnknown(o);
    return single ? [single] : [];
}

function parsePageEntriesFromToolText(text: string): CdsPageEntry[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        const entries = pageEntriesFromJson(parsed);
        if (entries.length > 0) return entries;
    } catch {
        /* fall through */
    }

    const entries: CdsPageEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+):\s+(.+?)\s*$/);
        if (!m) continue;
        const url = m[2].match(/https?:\/\/\S+/)?.[0]?.replace(/[)\],]+$/, '');
        entries.push({
            pageId: Number(m[1]),
            url,
            selected: /\[selected\]/i.test(line),
        });
    }
    return entries;
}

async function selectMatchingPageByTargetUrl(
    targetUrl: string,
    listTimeoutMs: number,
    selectTimeoutMs: number,
    logPrefix: string,
    isMatch: (href: string, targetUrl: string) => boolean = isMatchingTargetHref,
): Promise<number | null> {
    const list = await cdsPost('/api/list_pages', {}, listTimeoutMs);
    if (list.is_error) {
        throw new Error(firstTextBlock(list) || 'list_pages failed');
    }
    const entries = parsePageEntriesFromToolText(firstTextBlock(list));
    const matched = entries
        .filter((entry) => entry.url && isMatch(entry.url, targetUrl))
        .at(-1);
    if (!matched) {
        logApi('browser', `${logPrefix}: no matching tab found`, {
            targetUrl,
            pageCount: entries.length,
        });
        return null;
    }
    await selectPageById(matched.pageId, selectTimeoutMs);
    logApi('browser', `${logPrefix}: selected matching tab`, {
        targetUrl,
        pageId: matched.pageId,
        href: matched.url || '',
    });
    return matched.pageId;
}

async function selectMatchingZhangxinxuPage(
    targetUrl: string,
    listTimeoutMs: number,
    selectTimeoutMs: number,
): Promise<number | null> {
    return selectMatchingPageByTargetUrl(
        targetUrl,
        listTimeoutMs,
        selectTimeoutMs,
        'zhangxinxu.category',
        isMatchingZhangxinxuCategoryHref,
    );
}

/**
 * chrome-dev-mcp-server wraps `evaluate_script` results in prose + a fenced JSON string, e.g.
 * `Script ran on page and returned:\n```json\n\"<html>...\"\n```` — without unwrapping,
 * downstream `JSON.parse` / link extraction sees the wrapper and fails (empty list).
 */
function unwrapChromeMcpEvaluateOutput(text: string): string {
    const t = text.trim();
    const m = t.match(/Script ran on page and returned:\s*\n?```(?:json)?\s*\n([\s\S]*?)\n```/i);
    if (!m) return text;
    const inner = m[1].trim();
    try {
        const parsed = JSON.parse(inner) as unknown;
        if (typeof parsed === 'string') return parsed;
        return JSON.stringify(parsed);
    } catch {
        return inner;
    }
}

/** Extract string result from evaluate_script MCP text (may be JSON-wrapped). */
function parseEvaluateResultText(res: CdsToolResponse): string {
    if (res.is_error) {
        throw new Error(firstTextBlock(res) || 'evaluate_script failed');
    }
    let raw = firstTextBlock(res).trim();
    if (!raw) return '';
    raw = unwrapChromeMcpEvaluateOutput(raw);
    try {
        const v = JSON.parse(raw) as unknown;
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            if (typeof o.result === 'string') return o.result;
            if (typeof o.value === 'string') return o.value;
        }
    } catch {
        /* use raw */
    }
    return raw;
}

/**
 * Opens URL in a new tab via MCP, returns `document.body.innerText`, best-effort closes the tab.
 */
export async function scrapeUrlBodyText(url: string): Promise<string> {
    if (shouldForcePlaywright()) {
        logApi('browser', 'scrapeUrlBodyText forced to playwright headed', { url });
        return await scrapeUrlBodyTextViaPlaywright(url);
    }

    try {
        const navTimeout = envMs('CDS_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
        const buffer = envMs('CDS_NEW_PAGE_HTTP_BUFFER_MS', DEFAULT_NEW_PAGE_HTTP_BUFFER_MS);
        const newPageHttpTimeout = envMs(
            'CDS_NEW_PAGE_HTTP_TIMEOUT_MS',
            navTimeout + buffer,
        );
        const evalTimeout = envMs('CDS_EVAL_HTTP_TIMEOUT_MS', DEFAULT_EVAL_HTTP_TIMEOUT_MS);
        const listTimeout = envMs('CDS_LIST_HTTP_TIMEOUT_MS', DEFAULT_LIST_HTTP_TIMEOUT_MS);
        const closeTimeout = envMs('CDS_CLOSE_HTTP_TIMEOUT_MS', DEFAULT_CLOSE_HTTP_TIMEOUT_MS);
        const selectTimeout = envMs('CDS_SELECT_HTTP_TIMEOUT_MS', DEFAULT_SELECT_HTTP_TIMEOUT_MS);

        let lastWrongPage: WrongScrapePageError | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const nav = await cdsPost('/api/new_page', { url, timeout: navTimeout }, newPageHttpTimeout);
            if (nav.is_error) {
                throw new Error(firstTextBlock(nav) || 'new_page failed');
            }

            let pageId = parsePageIdFromToolText(firstTextBlock(nav));
            let selectedByUrl = false;
            try {
                const matchedPageId = await selectMatchingPageByTargetUrl(
                    url,
                    listTimeout,
                    selectTimeout,
                    'scrapeUrlBodyText',
                );
                if (matchedPageId != null) {
                    pageId = matchedPageId;
                    selectedByUrl = true;
                }
            } catch (err) {
                logApi('browser', 'scrapeUrlBodyText: select matching tab failed', {
                    targetUrl: url,
                    reason: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
                });
            }
            if (pageId != null && !selectedByUrl) {
                await selectPageById(pageId, selectTimeout);
            }

            const evalRes = await cdsPost(
                '/api/evaluate_script',
                evaluateScriptParams(
                    pageId,
                    `() => {
          const el = document.body;
          return JSON.stringify({
            href: location.href,
            text: el ? el.innerText : '',
          });
        }`,
                ),
                evalTimeout,
            );
            const raw = parseEvaluateResultText(evalRes);

            if (pageId != null) {
                try {
                    const close = await cdsPost('/api/close_page', { pageId }, closeTimeout);
                    if (close.is_error) {
                        console.warn('[chrome-devtools-scrape] close_page failed:', firstTextBlock(close).slice(0, 200));
                    }
                } catch (e) {
                    console.warn('[chrome-devtools-scrape] close_page error:', e);
                }
            }

            try {
                const parsed = JSON.parse(raw) as unknown;
                if (parsed && typeof parsed === 'object') {
                    const o = parsed as Record<string, unknown>;
                    const href = typeof o.href === 'string' ? o.href : '';
                    if (!isMatchingTargetHref(href, url)) {
                        lastWrongPage = new WrongScrapePageError(
                            `evaluated wrong page for scrapeUrlBodyText: ${href || '(empty href)'}`,
                            href,
                            url,
                        );
                        logApi('browser', 'scrapeUrlBodyText: evaluated wrong tab', {
                            targetUrl: url,
                            href,
                            attempt,
                        });
                        continue;
                    }
                    return typeof o.text === 'string' ? o.text : '';
                }
            } catch {
                /* Older MCP wrappers should not reach this after our JSON.stringify script; keep a fallback. */
            }
            return raw;
        }

        if (lastWrongPage) throw lastWrongPage;
        return '';
    } catch (err) {
        if (!isChromeDevtoolsUnavailableError(err)) throw err;

        logApi('browser', 'scrapeUrlBodyText fallback to playwright headed', {
            url,
            reason: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
        });
        return await scrapeUrlBodyTextViaPlaywright(url);
    }
}

const V2EX_JOBS_DEFAULT_URL = 'https://www.v2ex.com/?tab=jobs';

/**
 * Opens `jobsTabUrl` (default V2EX jobs tab), collects canonical topic URLs from each
 * `#Main .cell.item a.count_livid` (reply-count links point at `/t/{id}`), dedupes in order.
 */
export async function listV2exJobsTabCountLividTopicUrls(
    jobsTabUrl: string = V2EX_JOBS_DEFAULT_URL,
): Promise<string[]> {
    if (shouldForcePlaywright()) {
        logApi('browser', 'listV2exJobsTabCountLividTopicUrls forced to playwright headed', { url: jobsTabUrl });
        return await listV2exJobsTabCountLividTopicUrlsViaPlaywright(jobsTabUrl);
    }

    try {
    const navTimeout = envMs('CDS_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
    const buffer = envMs('CDS_NEW_PAGE_HTTP_BUFFER_MS', DEFAULT_NEW_PAGE_HTTP_BUFFER_MS);
    const newPageHttpTimeout = envMs(
        'CDS_NEW_PAGE_HTTP_TIMEOUT_MS',
        navTimeout + buffer,
    );
    const evalTimeout = envMs('CDS_EVAL_HTTP_TIMEOUT_MS', DEFAULT_EVAL_HTTP_TIMEOUT_MS);
    const listTimeout = envMs('CDS_LIST_HTTP_TIMEOUT_MS', DEFAULT_LIST_HTTP_TIMEOUT_MS);
    const closeTimeout = envMs('CDS_CLOSE_HTTP_TIMEOUT_MS', DEFAULT_CLOSE_HTTP_TIMEOUT_MS);
    const selectTimeout = envMs('CDS_SELECT_HTTP_TIMEOUT_MS', DEFAULT_SELECT_HTTP_TIMEOUT_MS);

    const nav = await cdsPost('/api/new_page', { url: jobsTabUrl, timeout: navTimeout }, newPageHttpTimeout);
    if (nav.is_error) {
        throw new Error(firstTextBlock(nav) || 'new_page failed');
    }

    let pageId = parsePageIdFromToolText(firstTextBlock(nav));
    if (pageId == null) {
        try {
            const list = await cdsPost('/api/list_pages', {}, listTimeout);
            if (!list.is_error) pageId = parsePageIdFromToolText(firstTextBlock(list));
        } catch {
            /* ignore */
        }
    }
    if (pageId != null) {
        await selectPageById(pageId, selectTimeout);
    }

    const postWaitMs = envMs('CDS_V2EX_JOBS_POST_WAIT_MS', DEFAULT_V2EX_JOBS_POST_WAIT_MS);
    if (postWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, postWaitMs));
    }

    if (process.env.NODE_ENV !== 'test') {
        const injectRes = await cdsPost(
            '/api/evaluate_script',
            evaluateScriptParams(
                pageId,
                `() => {
          try {
            window.__BLOG2MEDIA_V2EX_DEBUG__ = { t: Date.now(), href: location.href };
            const marker = document.createElement('script');
            marker.setAttribute('data-blog2media-v2ex-debug', '1');
            marker.textContent = '';
            document.documentElement.appendChild(marker);
            return 'injected';
          } catch (e) {
            return 'inject_failed:' + (e && e.message ? e.message : String(e));
          }
        }`,
            ),
            evalTimeout,
        );
        const injectOut = parseEvaluateResultText(injectRes).slice(0, 200);
        logApi('browser', 'v2ex.jobs: debug inject marker', { result: injectOut });

        const diagRes = await cdsPost(
            '/api/evaluate_script',
            evaluateScriptParams(
                pageId,
                `() => {
          const main = document.querySelector('#Main');
          return JSON.stringify({
            locationHref: location.href,
            title: document.title || '',
            outerHtmlChars: document.documentElement.outerHTML.length,
            bodyChars: document.body ? document.body.innerHTML.length : 0,
            mainInnerChars: main ? main.innerHTML.length : 0,
            cellItemCount: document.querySelectorAll('#Main .cell.item').length,
            countLividInCells: document.querySelectorAll('#Main .cell.item a.count_livid').length,
            countLividGlobal: document.querySelectorAll('a.count_livid').length,
          });
        }`,
            ),
            evalTimeout,
        );
        const diagRaw = parseEvaluateResultText(diagRes);
        try {
            const d = JSON.parse(diagRaw) as Record<string, unknown>;
            logApi('browser', 'v2ex.jobs: dom diagnostics', {
                locationHref: String(d.locationHref ?? ''),
                title: String(d.title ?? '').slice(0, 120),
                outerHtmlChars: Number(d.outerHtmlChars ?? 0),
                bodyChars: Number(d.bodyChars ?? 0),
                mainInnerChars: Number(d.mainInnerChars ?? 0),
                cellItemCount: Number(d.cellItemCount ?? 0),
                countLividInCells: Number(d.countLividInCells ?? 0),
                countLividGlobal: Number(d.countLividGlobal ?? 0),
            });
        } catch {
            logApi('browser', 'v2ex.jobs: dom diagnostics parse failed', { preview: diagRaw.slice(0, 300) });
        }

        if (shouldWriteV2exDebugHtml()) {
            const htmlRes = await cdsPost(
                '/api/evaluate_script',
                evaluateScriptParams(pageId, `() => document.documentElement.outerHTML`),
                evalTimeout,
            );
            const fullHtml = parseEvaluateResultText(htmlRes);
            const absPath = writeV2exDebugHtmlFile(fullHtml);
            logApi('browser', 'v2ex.jobs: wrote full page HTML', {
                path: absPath,
                chars: fullHtml.length,
                preview: fullHtml.slice(0, 400).replace(/\s+/g, ' '),
            });
        }
    }

    const evalRes = await cdsPost(
        '/api/evaluate_script',
        evaluateScriptParams(
            pageId,
            `() => {
          const seen = new Set();
          const out = [];
          const base = 'https://www.v2ex.com';
          for (const cell of document.querySelectorAll('#Main .cell.item')) {
            const a = cell.querySelector('a.count_livid');
            if (!a || !a.href) continue;
            try {
              const u = new URL(a.getAttribute('href') || a.href, base);
              if (!u.pathname.startsWith('/t/')) continue;
              u.hash = '';
              const canonical = u.href;
              if (!seen.has(canonical)) {
                seen.add(canonical);
                out.push(canonical);
              }
            } catch (e) {
              /* skip bad href */
            }
          }
          return JSON.stringify(out);
        }`,
        ),
        evalTimeout,
    );

    const raw = parseEvaluateResultText(evalRes);
    if (pageId != null) {
        try {
            const close = await cdsPost('/api/close_page', { pageId }, closeTimeout);
            if (close.is_error) {
                console.warn('[chrome-devtools-scrape] close_page failed:', firstTextBlock(close).slice(0, 200));
            }
        } catch (e) {
            console.warn('[chrome-devtools-scrape] close_page error:', e);
        }
    }

    try {
        const v = JSON.parse(raw) as unknown;
        if (Array.isArray(v)) {
            return v.filter((x): x is string => typeof x === 'string');
        }
    } catch {
        /* fall through */
    }
    return [];
    } catch (err) {
        if (!isChromeDevtoolsUnavailableError(err)) throw err;

        logApi('browser', 'listV2exJobsTabCountLividTopicUrls fallback to playwright headed', {
            url: jobsTabUrl,
            reason: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
        });
        return await listV2exJobsTabCountLividTopicUrlsViaPlaywright(jobsTabUrl);
    }
}

const ZHANGXINXU_CATEGORY_JS_URL = 'https://www.zhangxinxu.com/wordpress/category/js/';

function extractZhangxinxuArticleUrlsFromHtml(html: string): string[] {
    if (!html) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const matches = html.match(/https:\/\/www\.zhangxinxu\.com\/wordpress\/\d{4}\/\d{2}\/[^"'#?\s<]+\/?/g) || [];
    for (const href of matches) {
        try {
            const u = new URL(href);
            u.hash = '';
            u.search = '';
            const canonical = u.href;
            if (!seen.has(canonical)) {
                seen.add(canonical);
                out.push(canonical);
            }
        } catch {
            /* ignore malformed matches */
        }
    }
    return out;
}

/**
 * Opens a zhangxinxu.com WordPress category page and returns all article permalink URLs
 * found via `a[rel="bookmark"]` selectors (standard WordPress bookmark links).
 * If `categoryUrl` is omitted, defaults to the JS category listing.
 * `page` controls pagination: 1 = first page, N = `/page/N/` (WordPress convention).
 */
export async function listZhangxinxuCategoryArticleUrls(
    categoryUrl: string = ZHANGXINXU_CATEGORY_JS_URL,
    page: number = 1,
): Promise<string[]> {
    if (page > 1) {
        const base = categoryUrl.replace(/\/?(\?.*)?$/, '');
        categoryUrl = `${base}/page/${page}/`;
    }
    if (shouldForcePlaywright()) {
        logApi('browser', 'listZhangxinxuCategoryArticleUrls forced to playwright headed', { url: categoryUrl });
        return await listZhangxinxuCategoryArticleUrlsViaPlaywright(categoryUrl);
    }

    try {
        const navTimeout = envMs('CDS_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
        const buffer = envMs('CDS_NEW_PAGE_HTTP_BUFFER_MS', DEFAULT_NEW_PAGE_HTTP_BUFFER_MS);
        const newPageHttpTimeout = envMs('CDS_NEW_PAGE_HTTP_TIMEOUT_MS', navTimeout + buffer);
        const evalTimeout = envMs('CDS_EVAL_HTTP_TIMEOUT_MS', DEFAULT_EVAL_HTTP_TIMEOUT_MS);
        const listTimeout = envMs('CDS_LIST_HTTP_TIMEOUT_MS', DEFAULT_LIST_HTTP_TIMEOUT_MS);
        const closeTimeout = envMs('CDS_CLOSE_HTTP_TIMEOUT_MS', DEFAULT_CLOSE_HTTP_TIMEOUT_MS);
        const selectTimeout = envMs('CDS_SELECT_HTTP_TIMEOUT_MS', DEFAULT_SELECT_HTTP_TIMEOUT_MS);

        let lastWrongPage: WrongZhangxinxuPageError | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const nav = await cdsPost('/api/new_page', { url: categoryUrl, timeout: navTimeout }, newPageHttpTimeout);
            if (nav.is_error) {
                throw new Error(firstTextBlock(nav) || 'new_page failed');
            }

            let pageId = parsePageIdFromToolText(firstTextBlock(nav));
            let selectedByUrl = false;
            try {
                const matchedPageId = await selectMatchingZhangxinxuPage(categoryUrl, listTimeout, selectTimeout);
                if (matchedPageId != null) {
                    pageId = matchedPageId;
                    selectedByUrl = true;
                }
            } catch (err) {
                logApi('browser', 'zhangxinxu.category: select matching tab failed', {
                    targetUrl: categoryUrl,
                    reason: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
                });
            }
            if (pageId != null && !selectedByUrl) {
                await selectPageById(pageId, selectTimeout);
            }

            const evalRes = await cdsPost(
                '/api/evaluate_script',
                evaluateScriptParams(
                    pageId,
                    `() => {
          const seen = new Set();
          const out = [];
          const selectors = [
            'a[rel="bookmark"]',
            '.entry-title a',
            'article h2 a',
            '.post h2 a',
            'h2 a[rel="bookmark"]',
          ];
          const anchors = [
            ...selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
          ];
          for (const a of anchors) {
            const href = (a.getAttribute('href') || a.href || '').trim();
            if (!href) continue;
            try {
              const u = new URL(href, location.href);
              if (!/^https:\\/\\/www\\.zhangxinxu\\.com\\/wordpress\\/\\d{4}\\/\\d{2}\\//.test(u.href)) continue;
              u.hash = '';
              u.search = '';
              const canonical = u.href;
              if (!seen.has(canonical)) {
                seen.add(canonical);
                out.push(canonical);
              }
            } catch (e) {
              /* skip bad href */
            }
          }
          return JSON.stringify({
            href: location.href,
            title: document.title || '',
            relBookmark: document.querySelectorAll('a[rel="bookmark"]').length,
            entryTitle: document.querySelectorAll('.entry-title a').length,
            anchorCount: anchors.length,
            urls: out,
            html: out.length ? '' : document.documentElement.outerHTML,
          });
        }`,
                ),
                evalTimeout,
            );

            const raw = parseEvaluateResultText(evalRes);

            if (pageId != null) {
                try {
                    const close = await cdsPost('/api/close_page', { pageId }, closeTimeout);
                    if (close.is_error) {
                        console.warn('[chrome-devtools-scrape] close_page failed:', firstTextBlock(close).slice(0, 200));
                    }
                } catch (e) {
                    console.warn('[chrome-devtools-scrape] close_page error:', e);
                }
            }

            try {
                const v = JSON.parse(raw) as unknown;
                if (Array.isArray(v)) {
                    return v.filter((x): x is string => typeof x === 'string');
                }
                if (v && typeof v === 'object') {
                    const o = v as Record<string, unknown>;
                    const href = typeof o.href === 'string' ? o.href : '';
                    if (!isMatchingZhangxinxuCategoryHref(href, categoryUrl)) {
                        lastWrongPage = new WrongZhangxinxuPageError(
                            `evaluated wrong page for zhangxinxu category: ${href || '(empty href)'}`,
                            href,
                            categoryUrl,
                        );
                        logApi('browser', 'zhangxinxu.category: evaluated wrong tab', {
                            targetUrl: categoryUrl,
                            href,
                            attempt,
                        });
                        continue;
                    }

                    const urls = Array.isArray(o.urls)
                        ? o.urls.filter((x): x is string => typeof x === 'string')
                        : [];
                    if (urls.length > 0) {
                        return urls;
                    }
                    const fallback = extractZhangxinxuArticleUrlsFromHtml(
                        typeof o.html === 'string' ? o.html : '',
                    );
                    logApi('browser', 'zhangxinxu.category: diagnostics', {
                        href,
                        title: typeof o.title === 'string' ? o.title.slice(0, 120) : '',
                        relBookmark: Number(o.relBookmark ?? 0),
                        entryTitle: Number(o.entryTitle ?? 0),
                        anchorCount: Number(o.anchorCount ?? 0),
                        fallbackCount: fallback.length,
                    });
                    return fallback;
                }
            } catch {
                /* fall through */
            }
            return [];
        }
        if (lastWrongPage) throw lastWrongPage;
        return [];
    } catch (err) {
        if (!isChromeDevtoolsUnavailableError(err)) throw err;

        logApi('browser', 'listZhangxinxuCategoryArticleUrls fallback to playwright headed', {
            url: categoryUrl,
            reason: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
        });
        return await listZhangxinxuCategoryArticleUrlsViaPlaywright(categoryUrl);
    }
}

export function getChromeDevToolsBaseUrl(): string {
    return CDS_BASE;
}

/** Best-effort extract a page id from MCP tool text (JSON or prose). */
function parsePageIdFromToolText(text: string): number | null {
    if (!text) return null;
    try {
        const j = JSON.parse(text) as unknown;
        if (typeof j === 'number') return j;
        if (j && typeof j === 'object') {
            const o = j as Record<string, unknown>;
            if (typeof o.pageId === 'number') return o.pageId;
            if (typeof o.page_id === 'number') return o.page_id;
        }
    } catch {
        /* fall through */
    }
    const selected =
        text.match(/^\s*(\d+): .*?\[selected\]\s*$/im) ??
        text.match(/^\s*(\d+): .*?\[selected]/im);
    if (selected) return Number(selected[1]);
    const listedPageIds = Array.from(text.matchAll(/^\s*(\d+):\s+/gm)).map((m) => Number(m[1]));
    if (listedPageIds.length > 0) {
        return listedPageIds[listedPageIds.length - 1];
    }
    const m = text.match(/\bpageId["']?\s*[:=]\s*(\d+)/i) ?? text.match(/\bpage_id["']?\s*[:=]\s*(\d+)/i);
    return m ? Number(m[1]) : null;
}
