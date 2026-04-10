import { NextResponse } from 'next/server'
import { getMediumJob } from '@/lib/services/SqliteService'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ jobId: string }> }

/**
 * GET /api/medium/[jobId]
 * Returns async job status and, when completed, the same URLs as the former synchronous API.
 */
export async function GET(_request: Request, context: RouteContext) {
    const { jobId } = await context.params
    if (!jobId) {
        return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
    }

    const row = getMediumJob(jobId)
    if (!row) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    let imageUrls: string[] | null = null
    if (row.image_urls) {
        try {
            imageUrls = JSON.parse(row.image_urls) as string[]
        } catch {
            imageUrls = []
        }
    }

    const body = {
        jobId: row.job_id,
        status: row.status,
        sourceUrl: row.source_url,
        error: row.error,
        mdUrl: row.md_url,
        imageUrls,
        generationLogId: row.generation_log_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        /** When status is `completed`, same shape as legacy POST: [mdUrl, ...imageUrls] */
        urls: row.status === 'completed' && row.md_url ? [row.md_url, ...(imageUrls ?? [])] : null,
    }

    return NextResponse.json(body)
}
