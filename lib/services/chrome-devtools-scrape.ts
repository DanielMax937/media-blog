/**
 * Page text scraping via local-service chrome-devtools-mcp-server (REST).
 * Default: http://127.0.0.1:9223 — see docs/API.md
 */

const CDS_BASE =
    process.env.CHROME_DEVTOOLS_MCP_URL?.replace(/\/$/, '') ||
    process.env.CDS_BASE_URL?.replace(/\/$/, '') ||
    'http://127.0.0.1:9223';

const DEFAULT_NAV_TIMEOUT_MS = 120_000;

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

async function cdsPost(toolPath: string, body: Record<string, unknown>): Promise<CdsToolResponse> {
    const url = `${CDS_BASE}${toolPath.startsWith('/') ? '' : '/'}${toolPath}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
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
    const navTimeout = Number(process.env.CDS_NAVIGATION_TIMEOUT_MS ?? DEFAULT_NAV_TIMEOUT_MS);
    const nav = await cdsPost('/api/new_page', { url, timeout: navTimeout });
    if (nav.is_error) {
        throw new Error(firstTextBlock(nav) || 'new_page failed');
    }

    let pageId = parsePageIdFromToolText(firstTextBlock(nav));
    if (pageId == null) {
        try {
            const list = await cdsPost('/api/list_pages', {});
            if (!list.is_error) pageId = parsePageIdFromToolText(firstTextBlock(list));
        } catch {
            /* ignore */
        }
    }

    const evalRes = await cdsPost('/api/evaluate_script', {
        function: `() => {
          const el = document.body;
          return el ? el.innerText : '';
        }`,
    });
    const bodyText = parseEvaluateResultText(evalRes);

    if (pageId != null) {
        try {
            const close = await cdsPost('/api/close_page', { pageId });
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
