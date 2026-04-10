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
 */

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

/** Extract string result from evaluate_script MCP text (may be JSON-wrapped). */
function parseEvaluateResultText(res: CdsToolResponse): string {
    if (res.is_error) {
        throw new Error(firstTextBlock(res) || 'evaluate_script failed');
    }
    const raw = firstTextBlock(res).trim();
    if (!raw) return '';
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
    const navTimeout = envMs('CDS_NAVIGATION_TIMEOUT_MS', DEFAULT_NAV_TIMEOUT_MS);
    const buffer = envMs('CDS_NEW_PAGE_HTTP_BUFFER_MS', DEFAULT_NEW_PAGE_HTTP_BUFFER_MS);
    const newPageHttpTimeout = envMs(
        'CDS_NEW_PAGE_HTTP_TIMEOUT_MS',
        navTimeout + buffer,
    );
    const evalTimeout = envMs('CDS_EVAL_HTTP_TIMEOUT_MS', DEFAULT_EVAL_HTTP_TIMEOUT_MS);
    const listTimeout = envMs('CDS_LIST_HTTP_TIMEOUT_MS', DEFAULT_LIST_HTTP_TIMEOUT_MS);
    const closeTimeout = envMs('CDS_CLOSE_HTTP_TIMEOUT_MS', DEFAULT_CLOSE_HTTP_TIMEOUT_MS);

    const nav = await cdsPost('/api/new_page', { url, timeout: navTimeout }, newPageHttpTimeout);
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

    const evalRes = await cdsPost(
        '/api/evaluate_script',
        {
            function: `() => {
          const el = document.body;
          return el ? el.innerText : '';
        }`,
        },
        evalTimeout,
    );
    const bodyText = parseEvaluateResultText(evalRes);

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

    return bodyText;
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
    const m = text.match(/\bpageId["']?\s*[:=]\s*(\d+)/i) ?? text.match(/\bpage_id["']?\s*[:=]\s*(\d+)/i);
    return m ? Number(m[1]) : null;
}
