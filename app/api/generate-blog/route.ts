import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { StrategyFactory } from '@/lib/strategies/StrategyFactory'
import { scrapeUrlBodyText } from '@/lib/services/chrome-devtools-scrape'
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from '@/lib/services/api-logger'
import { getOpenAiBaseUrl } from '@/lib/openai-base-url'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: getOpenAiBaseUrl(),
})

export async function POST(request: Request) {
    let requestUrl = ''
    let requestType = 'rednote'
    try {
        const { url, type = 'rednote' } = await request.json()
        requestUrl = typeof url === 'string' ? url : ''
        requestType = typeof type === 'string' ? type : 'rednote'

        if (!url) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 })
        }

        logApi('api', 'POST /api/generate-blog start', { url: requestUrl, type: requestType })

        let content = ''
        const tScrape = Date.now()

        try {
            logApi('browser', 'generate-blog.scrape start', { url: requestUrl })
            content = await scrapeUrlBodyText(url)
            logApi('browser', 'generate-blog.scrape ok', {
                url: requestUrl,
                durationMs: Date.now() - tScrape,
                textChars: content.length,
            })
        } catch (e) {
            logApiError('browser', 'generate-blog.scrape failed', e, { url: requestUrl })
            throw e
        }

        if (!content) {
            logApi('api', 'generate-blog scrape empty', { url: requestUrl })
            return NextResponse.json({ error: 'Failed to extract content' }, { status: 500 })
        }

        const model = process.env.OPENAI_MODEL ?? 'gpt-5.4'
        const tLlm = Date.now()
        logApi('openai', 'generate-blog.extractMainContent start', { model, inputChars: content.length })
        const extractionResponse = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a helpful assistant that extracts the main content from a webpage text. Ignore navigation, footers, and sidebars. Return ONLY the main article text.',
                },
                {
                    role: 'user',
                    content: `Extract the main content from this text:\n\n${content.substring(0, 20000)}`,
                },
            ],
        })

        const mainContent = extractionResponse.choices?.[0]?.message?.content || ''
        logOpenAiRawResponseIfEmpty('generate-blog.extractMainContent', mainContent.length, extractionResponse)
        logApi('openai', 'generate-blog.extractMainContent ok', {
            model,
            durationMs: Date.now() - tLlm,
            outputChars: mainContent.length,
        })

        const strategy = StrategyFactory.create(type, openai)
        logApi('api', 'generate-blog strategy.generate start', { type: requestType })
        const result = await strategy.generate(mainContent)
        logApi('api', 'POST /api/generate-blog ok', {
            url: requestUrl,
            type: requestType,
            contentChars: result.content?.length ?? 0,
        })

        return NextResponse.json(result)
    } catch (error) {
        console.error('Error generating blog:', error)
        logApiError('api', 'POST /api/generate-blog failed', error, {
            url: requestUrl,
            type: requestType,
        })
        return NextResponse.json({ error: 'Failed to generate blog' }, { status: 500 })
    }
}
