import { logApi, logApiError } from '@/lib/services/api-logger';

/**
 * Fast HTTP check before browser scrape. Throws if the overview HTML is not retrievable.
 */
export async function assertOverviewPageExists(url: string): Promise<void> {
    const t0 = Date.now();
    logApi('api', 'futures.assertOverviewPageExists HEAD', { url });
    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 404) {
            throw new Error(`概览页面不存在 (404): ${url}`);
        }
        if (res.ok) {
            logApi('api', 'futures.assertOverviewPageExists HEAD ok', {
                url,
                durationMs: Date.now() - t0,
                status: res.status,
            });
            return;
        }
        // Many static hosts return 405 for HEAD — fall through to GET.
        if (res.status !== 405 && res.status !== 501) {
            throw new Error(`概览页面不可用 (HTTP ${res.status}): ${url}`);
        }
        logApi('api', 'futures.assertOverviewPageExists HEAD not usable, trying GET', {
            url,
            status: res.status,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.includes('不可用')) throw err;

        logApi('api', 'futures.assertOverviewPageExists HEAD failed, trying GET', {
            url,
            reason: msg.slice(0, 200),
        });
    }

    try {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 404) {
            throw new Error(`概览页面不存在 (404): ${url}`);
        }
        if (!res.ok) {
            throw new Error(`概览页面不可用 (HTTP ${res.status}): ${url}`);
        }
        logApi('api', 'futures.assertOverviewPageExists GET ok', { url, durationMs: Date.now() - t0 });
    } catch (err) {
        logApiError('api', 'futures.assertOverviewPageExists failed', err, { url });
        throw err;
    }
}
