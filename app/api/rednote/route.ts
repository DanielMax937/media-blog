import { NextResponse } from 'next/server'
import { logApi, logApiError } from '@/lib/services/api-logger'
import { createRednoteJob } from '@/lib/services/SqliteService'
import { runRednoteJob } from '@/lib/rednote/run-rednote-job'

// Allow long-running background pipeline (LLM + webgemini); scraping uses external Chrome DevTools MCP.
export const maxDuration = 3600;

/**
 * POST /api/rednote
 * Body: { url: string }
 * Response: 202 { jobId: string } — pipeline runs in-process (scraping via chrome-devtools-mcp-server, not Playwright).
 * Poll GET /api/rednote/[jobId]
 */
export async function POST(request: Request) {
    let requestUrl = ''
    try {
        const body = await request.json()
        const { url } = body
        requestUrl = typeof url === 'string' ? url : ''

        if (!url) {
            return NextResponse.json({ error: 'url is required' }, { status: 400 })
        }

        const jobId = createRednoteJob(requestUrl)
        logApi('api', 'POST /api/rednote accepted (async)', { url: requestUrl, jobId })

        void runRednoteJob(jobId, requestUrl).catch((err) => {
            console.error('[/api/rednote] runRednoteJob unhandled:', err)
            logApiError('api', 'runRednoteJob unhandled rejection', err, { jobId, url: requestUrl })
        })

        return NextResponse.json({ jobId }, { status: 202 })
    } catch (error) {
        console.error('[/api/rednote] Error:', error)
        logApiError('api', 'POST /api/rednote failed to enqueue', error, { url: requestUrl })
        return NextResponse.json({ error: 'Failed to enqueue Rednote job' }, { status: 500 })
    }
}
