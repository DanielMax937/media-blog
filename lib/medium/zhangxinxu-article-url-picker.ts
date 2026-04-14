import { logApi } from '@/lib/services/api-logger';
import { listZhangxinxuCategoryArticleUrls } from '@/lib/services/chrome-devtools-scrape';
import { hasGenerationLogForSourceUrl } from '@/lib/services/SqliteService';

const PREVIEW_MAX = 8;

/**
 * Opens the zhangxinxu.com JS category listing via chrome-dev-mcp-server, extracts
 * article permalink URLs from `a[rel="bookmark"]` links, and returns the first URL
 * that has no `generation_log` row yet (platform = 'medium').
 * Returns `null` if the list is empty or every URL has already been processed.
 */
export async function pickFirstUnprocessedZhangxinxuArticleUrl(): Promise<string | null> {
    const links = await listZhangxinxuCategoryArticleUrls();
    logApi('api', 'zhangxinxu.pick: scraped article links', {
        linkCount: links.length,
        preview: links.slice(0, PREVIEW_MAX).join(' | ') || '(none)',
    });

    let skipped = 0;
    for (const href of links) {
        if (!hasGenerationLogForSourceUrl(href, 'medium')) {
            logApi('api', 'zhangxinxu.pick: first unprocessed article', {
                url: href,
                skippedAlreadyInLog: skipped,
            });
            return href;
        }
        skipped += 1;
    }

    logApi('api', 'zhangxinxu.pick: no url available', {
        linkCount: links.length,
        reason: links.length === 0 ? 'empty_list' : 'all_hrefs_in_generation_log',
        skippedCount: skipped,
    });
    return null;
}
