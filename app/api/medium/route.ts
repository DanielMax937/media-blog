import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { scrapeUrlBodyText } from '@/lib/services/chrome-devtools-scrape'
import { MediumStrategy } from '@/lib/strategies/MediumStrategy'
import { uploadToBitstripe } from '@/lib/services/BitstripeUploader'
import { logGeneration } from '@/lib/services/SqliteService'
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from '@/lib/services/api-logger'
import { getOpenAiBaseUrl } from '@/lib/openai-base-url'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
})

/**
 * POST /api/medium
 * Body: { url: string }
 * Response: string[]  — [mdUrl, ...imageUrls]
 * where imageUrls includes the cover image URL and any demo GIF URLs embedded
 * in the generated markdown by MediumStrategy.
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

        logApi('api', 'POST /api/medium start', { url: requestUrl })

        const rawContent = await scrapeUrl(url)
        if (!rawContent) {
            logApi('api', 'POST /api/medium scrape empty', { url: requestUrl })
            return NextResponse.json({ error: 'Failed to extract content from URL' }, { status: 500 })
        }

        const mainContent = await extractMainContent(rawContent)

        const strategy = new MediumStrategy(openai)
        const { content: markdown } = await strategy.generate(mainContent)

        const imageUrls = extractImageUrls(markdown)

        const mdUrl = await writeMdAndUpload(markdown, 'medium')

        logGeneration(url, mdUrl, imageUrls)

        logApi('api', 'POST /api/medium ok', {
            url: requestUrl,
            mdUrl,
            imageCount: imageUrls.length,
            markdownChars: markdown.length,
        })

        return NextResponse.json([mdUrl, ...imageUrls])
    } catch (error) {
        console.error('[/api/medium] Error:', error)
        logApiError('api', 'POST /api/medium failed', error, { url: requestUrl })
        return NextResponse.json({ error: 'Failed to generate Medium post' }, { status: 500 })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scrapeUrl(url: string): Promise<string> {
    logApi('browser', 'medium.scrapeUrl start', { url })
    const t0 = Date.now()
    try {
        const text = await scrapeUrlBodyText(url)
        logApi('browser', 'medium.scrapeUrl ok', {
            url,
            durationMs: Date.now() - t0,
            textChars: text.length,
        })
        return text
    } catch (err) {
        logApiError('browser', 'medium.scrapeUrl failed', err, { url, durationMs: Date.now() - t0 })
        throw err
    }
}

async function extractMainContent(raw: string): Promise<string> {
    const model = process.env.OPENAI_MODEL ?? 'gpt-5.4'
    const t0 = Date.now()
    logApi('openai', 'medium.extractMainContent start', { model, inputChars: raw.length })
    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a helpful assistant that extracts the main content from a webpage text. Ignore navigation, footers, and sidebars. Return ONLY the main article text.',
                },
                {
                    role: 'user',
                    content: `Extract the main content from this text:\n\n${raw.substring(0, 20000)}`,
                },
            ],
        })
        const text = response.choices?.[0]?.message?.content ?? ''
        logOpenAiRawResponseIfEmpty('medium.extractMainContent', text.length, response)
        logApi('openai', 'medium.extractMainContent ok', {
            model,
            durationMs: Date.now() - t0,
            outputChars: text.length,
        })
        return text
    } catch (err) {
        logApiError('openai', 'medium.extractMainContent failed', err, {
            model,
            durationMs: Date.now() - t0,
        })
        throw err
    }
}

/**
 * Extract all image URLs from markdown image syntax: ![alt](url)
 * Specifically targets bitstripe-hosted URLs that the MediumStrategy embeds.
 */
export function extractImageUrls(markdown: string): string[] {
    const pattern = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g
    const urls: string[] = []
    let match: RegExpExecArray | null
    while ((match = pattern.exec(markdown)) !== null) {
        urls.push(match[1])
    }
    return urls
}

async function writeMdAndUpload(markdown: string, prefix: string): Promise<string> {
    const filename = `${prefix}-${Date.now()}.md`
    const tmpPath = path.join(os.tmpdir(), filename)
    fs.writeFileSync(tmpPath, markdown, 'utf-8')
    logApi('bitstripe', 'medium.uploadMarkdown start', { prefix, tmpPath, markdownChars: markdown.length })
    try {
        const publicUrl = await uploadToBitstripe(tmpPath)
        logApi('bitstripe', 'medium.uploadMarkdown ok', { publicUrl })
        return publicUrl
    } finally {
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    }
}
