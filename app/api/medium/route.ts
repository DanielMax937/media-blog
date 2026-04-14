import { NextResponse } from 'next/server'
import { logApi, logApiError } from '@/lib/services/api-logger'
import { createMediumJob } from '@/lib/services/SqliteService'
import { runMediumJob } from '@/lib/medium/run-medium-job'
import { pickFirstUnprocessedZhangxinxuArticleUrl } from '@/lib/medium/zhangxinxu-article-url-picker'

// Allow long-running background pipeline (LLM + webgemini)
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
 * POST /api/medium
 * Body: { url?: string } — if `url` omitted or empty, uses chrome-dev-mcp-server to open the
 * zhangxinxu.com JS category listing, extracts article permalink URLs, skips URLs already in
 * `generation_log` (platform='medium'), and picks the first new one.
 * Empty body (e.g. `curl -X POST` without `-d`) is treated like `{}`.
 * Response: 202 { jobId: string } — pipeline runs in-process.
 * Poll GET /api/medium/[jobId]
 */
export async function POST(request: Request) {
    let requestUrl = ''
    try {
        const body = await readJsonBodyObject(request)
        const { url } = body
        requestUrl = typeof url === 'string' ? url.trim() : ''

        if (!requestUrl) {
            const picked = await pickFirstUnprocessedZhangxinxuArticleUrl()
            if (!picked) {
                return NextResponse.json(
                    {
                        error:
                            'No zhangxinxu.com article URL available: list empty or every article URL already has a generation_log entry',
                    },
                    { status: 400 },
                )
            }
            requestUrl = picked
            logApi('api', 'POST /api/medium resolved url from zhangxinxu category listing', { url: requestUrl })
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

