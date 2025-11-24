import { NextResponse } from 'next/server'
import { chromium } from 'playwright'
import OpenAI from 'openai'
import { StrategyFactory } from '@/lib/strategies/StrategyFactory'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
})

export async function POST(request: Request) {
    try {
        const { url, type = 'rednote' } = await request.json()

        if (!url) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 })
        }

        // Step 1: Scrape with Playwright
        const browser = await chromium.launch()
        const page = await browser.newPage()
        await page.goto(url)
        // Wait for some content to load, maybe the body
        await page.waitForSelector('body')

        // Extract text content - simplified for now, getting body text
        const content = await page.evaluate(() => document.body.innerText)
        await browser.close()

        // Step 2: Extract main content with LLM
        const extractionResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant that extracts the main content from a webpage text. Ignore navigation, footers, and sidebars. Return ONLY the main article text.',
                },
                {
                    role: 'user',
                    content: `Extract the main content from this text:\n\n${content.substring(0, 20000)}`, // Truncate to avoid token limits if necessary, though 4o has large context
                },
            ],
        })

        const mainContent = extractionResponse.choices[0].message.content || ''

        // Step 3: Use Strategy
        const strategy = StrategyFactory.create(type, openai)
        const result = await strategy.generate(mainContent)

        return NextResponse.json(result)
    } catch (error) {
        console.error('Error generating blog:', error)
        return NextResponse.json(
            { error: 'Failed to generate blog' },
            { status: 500 }
        )
    }
}
