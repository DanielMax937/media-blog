import { NextResponse } from 'next/server'
import { logApi, logApiError } from '@/lib/services/api-logger'
import { createRednoteJob } from '@/lib/services/SqliteService'
import { runRednoteJob } from '@/lib/rednote/run-rednote-job'
import { pickFirstUnprocessedV2exJobsTopicUrl } from '@/lib/rednote/v2ex-jobs-url-picker'

// Allow long-running background pipeline (LLM + webgemini); scraping uses external Chrome DevTools MCP.
export const maxDuration = 3600;

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
 * POST /api/rednote
 * Body: { url?: string } — if `url` omitted or empty, uses chrome-dev-mcp-server to open V2EX jobs tab,
 * collects `.cell.item a.count_livid` topic links, skips URLs already in `generation_log`, and picks the first new one.
 * Empty body (e.g. `curl -X POST` without `-d`) is treated like `{}`.
 * Response: 202 { jobId: string } — pipeline runs in-process (scraping via chrome-devtools-mcp-server, not Playwright).
 * Poll GET /api/rednote/[jobId]
 */
export async function POST(request: Request) {
    let requestUrl = ''
    try {
        const body = await readJsonBodyObject(request)
        const { url } = body
        requestUrl = typeof url === 'string' ? url.trim() : ''

        if (!requestUrl) {
            const picked = await pickFirstUnprocessedV2exJobsTopicUrl()
            if (!picked) {
                return NextResponse.json(
                    {
                        error:
                            'No V2EX jobs topic URL available: list empty or every topic URL already has a generation_log entry',
                    },
                    { status: 400 },
                )
            }
            requestUrl = picked
            logApi('api', 'POST /api/rednote resolved url from V2EX jobs tab', { url: requestUrl })
        }

        const jobId = createRednoteJob(requestUrl)
        logApi('api', 'POST /api/rednote accepted (async)', { url: requestUrl, jobId })

        void runRednoteJob(jobId, requestUrl).catch((err) => {
            console.error('[/api/rednote] runRednoteJob unhandled:', err)
            logApiError('api', 'runRednoteJob unhandled rejection', err, { jobId, url: requestUrl })
        })

        return NextResponse.json({ jobId }, { status: 202 })
    } catch (error) {
        if (error instanceof SyntaxError && error.message === 'invalid_json_body') {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        console.error('[/api/rednote] Error:', error)
        logApiError('api', 'POST /api/rednote failed to enqueue', error, { url: requestUrl })
        return NextResponse.json({ error: 'Failed to enqueue Rednote job' }, { status: 500 })
    }
}
