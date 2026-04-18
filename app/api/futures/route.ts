import { NextResponse } from 'next/server'
import { logApi, logApiError } from '@/lib/services/api-logger'
import { createFuturesJob } from '@/lib/services/SqliteService'
import { runFuturesJob } from '@/lib/futures/run-futures-job'
import { buildOverviewPageUrl, formatYmdShanghai, parseYmdCompact } from '@/lib/futures/overview-url'

export const maxDuration = 3600

/** `curl -X POST` without `-d` sends an empty body; `request.json()` throws. Treat as `{}`. */
async function readJsonBodyObject(request: Request): Promise<Record<string, unknown>> {
    const raw = await request.text()
    const trimmed = raw.trim()
    if (!trimmed) return {}
    let v: unknown
    try {
        v = JSON.parse(trimmed)
    } catch {
        throw new SyntaxError('invalid_json_body')
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>
    }
    return {}
}

/**
 * POST /api/futures
 * Body: { date?: string } — optional `YYYYMMDD` (Asia/Shanghai calendar day when omitted).
 * Builds `https://www.bitstripe.cn/files/{date}_overview.html`, then async pipeline:
 * HTTP check → browser scrape → webgemini POST /chat (Markdown 报告) → 封面图 → bitstripe → Telegram.
 * Response: 202 { jobId, sourceUrl, date }
 * Poll GET /api/futures/[jobId]
 */
export async function POST(request: Request) {
    try {
        const body = await readJsonBodyObject(request)
        const dateRaw = body.date
        let ymd: string
        if (typeof dateRaw === 'string' && dateRaw.trim()) {
            try {
                ymd = parseYmdCompact(dateRaw.trim())
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                return NextResponse.json({ error: msg }, { status: 400 })
            }
        } else {
            ymd = formatYmdShanghai(new Date())
        }

        const sourceUrl = buildOverviewPageUrl(ymd)
        const jobId = createFuturesJob(sourceUrl)
        logApi('api', 'POST /api/futures accepted (async)', { sourceUrl, jobId, date: ymd })

        void runFuturesJob(jobId, sourceUrl).catch((err) => {
            console.error('[/api/futures] runFuturesJob unhandled:', err)
            logApiError('api', 'runFuturesJob unhandled rejection', err, { jobId, url: sourceUrl })
        })

        return NextResponse.json({ jobId, sourceUrl, date: ymd }, { status: 202 })
    } catch (error) {
        if (error instanceof SyntaxError && error.message === 'invalid_json_body') {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        console.error('[/api/futures] Error:', error)
        logApiError('api', 'POST /api/futures failed to enqueue', error, {})
        return NextResponse.json({ error: 'Failed to enqueue futures job' }, { status: 500 })
    }
}
