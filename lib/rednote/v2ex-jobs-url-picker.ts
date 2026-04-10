import { logApi } from '@/lib/services/api-logger';
import { listV2exJobsTabCountLividTopicUrls } from '@/lib/services/chrome-devtools-scrape';
import { hasGenerationLogForSourceUrl } from '@/lib/services/SqliteService';

const PREVIEW_MAX = 8;

/**
 * Opens V2EX jobs tab via chrome-dev-mcp-server, lists topic URLs from `a.count_livid` in each `.cell.item`,
 * and returns the first URL that has no `generation_log` row yet.
 */
export async function pickFirstUnprocessedV2exJobsTopicUrl(): Promise<string | null> {
    const links = await listV2exJobsTabCountLividTopicUrls();
    logApi('api', 'v2ex.jobs.pick: scraped topic links (from MCP)', {
        linkCount: links.length,
        preview: links.slice(0, PREVIEW_MAX).join(' | ') || '(none)',
    });

    let skipped = 0;
    for (const href of links) {
        if (!hasGenerationLogForSourceUrl(href, 'rednote')) {
            logApi('api', 'v2ex.jobs.pick: first unprocessed topic', {
                url: href,
                skippedAlreadyInLog: skipped,
            });
            return href;
        }
        skipped += 1;
    }

    logApi('api', 'v2ex.jobs.pick: no url available', {
        linkCount: links.length,
        reason: links.length === 0 ? 'empty_list' : 'all_hrefs_in_generation_log',
        skippedCount: skipped,
    });
    return null;
}
