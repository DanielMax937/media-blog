# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A blog generation application that scrapes web content and transforms it into platform-specific blog posts using AI. Supports two output formats: Chinese Rednote (小红书) style and English Medium professional format.

## Development Commands

```bash
npm run dev      # Start development server at localhost:3000
npm run build    # Production build
npm start        # Start production server
npm run lint     # Run ESLint
```

## Architecture

### Core Flow
1. User submits URL + platform type via React form (`app/page.tsx`)
2. API route (`app/api/generate-blog/route.ts`) orchestrates the pipeline:
   - **Chrome DevTools MCP server** (`lib/services/chrome-devtools-scrape.ts`, HTTP to `127.0.0.1:9223` by default) extracts page text — not Playwright
   - OpenAI cleans content (removes nav/footers)
   - Strategy pattern transforms content for target platform
3. Medium strategy generates interactive HTML demos for technical content

### Strategy Pattern (`lib/strategies/`)
- `BlogStrategy.ts` - Interface defining `generate(content: string): Promise<{ content: string; demo?: string }>`
- `RednoteStrategy.ts` - Converts to Chinese with emojis, hashtags, viral style
- `MediumStrategy.ts` - English professional format with code examples; auto-generates demos for technical content saved to `/public/demos/`
- `StrategyFactory.ts` - Returns strategy based on type parameter ('rednote' or 'medium')

### Web scraping (`lib/services/chrome-devtools-scrape.ts`)
- Calls **local-service `chrome-dev-mcp-server`** REST API (`POST /api/new_page`, `/api/evaluate_script`, etc.) — same stack as Cursor Chrome DevTools MCP, not Playwright.
- Env: `CHROME_DEVTOOLS_MCP_URL` or `CDS_BASE_URL` (default `http://127.0.0.1:9223`).

### Key External Dependencies
- **OpenAI-compatible chat endpoint** - Content extraction, translation, formatting, and demo generation (configured via `.env`)
- **Claude Agent SDK** - Optional demo HTML generation for technical content in MediumStrategy
- **Playwright** (optional) - Used only by `DemoGifService` for headless GIF recording, not for URL scraping

## Configuration

### Environment Variables (`.env`)
- `OPENAI_BASE_URL` - OpenAI-compatible API endpoint, e.g. `http://127.0.0.1:3300/v1`
- `OPENAI_API_KEY` - API key or local gateway placeholder
- `OPENAI_MODEL` - Optional `runner/model` override; leave empty to use the gateway default
- `MEDIUM_DEMO_PROVIDER` - Set to `openai` to route demo generation through the OpenAI-compatible endpoint
- `ANTHROPIC_API_KEY` - Optional Claude credential if `MEDIUM_DEMO_PROVIDER=claude`

### Path Aliases
`@/*` maps to project root for absolute imports

## Stateless Design
No database - the application processes content on-demand without persistence. Generated demos are saved as static files to `/public/demos/`.
