import { logApi } from '@/lib/services/api-logger';
import { listZhangxinxuCategoryArticleUrls } from '@/lib/services/chrome-devtools-scrape';
import { hasGenerationLogForSourceUrl } from '@/lib/services/SqliteService';

const PREVIEW_MAX = 8;
const MAX_PAGES = 50;

/**
 * Opens the zhangxinxu.com JS category listing via chrome-dev-mcp-server, extracts
 * article permalink URLs from `a[rel="bookmark"]` links, and returns the first URL
 * that has no `generation_log` row yet (platform = 'medium').
 * Iterates through paginated category pages if all URLs on the current page
 * have already been processed. Returns `null` when every page is exhausted.
 */
export async function pickFirstUnprocessedZhangxinxuArticleUrl(): Promise<string | null> {
    let totalSkipped = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
        const links = await listZhangxinxuCategoryArticleUrls(undefined, page);
        logApi('api', 'zhangxinxu.pick: scraped article links', {
            page,
            linkCount: links.length,
            preview: links.slice(0, PREVIEW_MAX).join(' | ') || '(none)',
        });

        if (links.length === 0) {
            logApi('api', 'zhangxinxu.pick: no more pages', { page, totalSkipped });
            break;
        }

        let skippedOnPage = 0;
        for (const href of links) {
            if (!hasGenerationLogForSourceUrl(href, 'medium')) {
                logApi('api', 'zhangxinxu.pick: first unprocessed article', {
                    page,
                    url: href,
                    skippedAlreadyInLog: totalSkipped,
                });
                return href;
            }
            skippedOnPage += 1;
            totalSkipped += 1;
        }

        logApi('api', 'zhangxinxu.pick: all processed on page, advancing', {
            page,
            skippedOnPage,
            nextPage: page + 1,
        });
    }

    logApi('api', 'zhangxinxu.pick: no url available', {
        reason: 'all_pages_exhausted',
        totalSkipped,
        maxPages: MAX_PAGES,
    });
    return null;
}
