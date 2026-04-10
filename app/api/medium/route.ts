import { NextResponse } from 'next/server'
import { logApi, logApiError } from '@/lib/services/api-logger'
import { createMediumJob } from '@/lib/services/SqliteService'
import { runMediumJob } from '@/lib/medium/run-medium-job'

// Allow long-running background pipeline (LLM + webgemini)
export const maxDuration = 3600;

const DEFAULT_URL = 'https://www.zhangxinxu.com/';

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
 * POST /api/medium
 * Body: { url?: string } — if `url` omitted or empty, defaults to https://www.zhangxinxu.com/
 * Empty body (e.g. `curl -X POST` without `-d`) is treated like `{}`.
 * Response: 202 { jobId: string } — pipeline runs in-process (scraping via chrome-devtools-mcp-server).
 * Poll GET /api/medium/[jobId]
 */
export async function POST(request: Request) {
    let requestUrl = ''
    try {
        const body = await readJsonBodyObject(request)
        const { url } = body
        requestUrl = typeof url === 'string' ? url.trim() : ''

        if (!requestUrl) {
            requestUrl = DEFAULT_URL
            logApi('api', 'POST /api/medium using default url', { url: requestUrl })
        }

        const jobId = createMediumJob(requestUrl)
        logApi('api', 'POST /api/medium accepted (async)', { url: requestUrl, jobId })

        void runMediumJob(jobId, requestUrl).catch((err) => {
            console.error('[/api/medium] runMediumJob unhandled:', err)
            logApiError('api', 'runMediumJob unhandled rejection', err, { jobId, url: requestUrl })
        })

        return NextResponse.json({ jobId }, { status: 202 })
    } catch (error) {
        if (error instanceof SyntaxError && error.message === 'invalid_json_body') {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        console.error('[/api/medium] Error:', error)
        logApiError('api', 'POST /api/medium failed to enqueue', error, { url: requestUrl })
        return NextResponse.json({ error: 'Failed to enqueue Medium job' }, { status: 500 })
    }
}

