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
   - Browser automation extracts page content
   - OpenAI GPT-4o cleans content (removes nav/footers)
   - Strategy pattern transforms content for target platform
3. Medium strategy generates interactive HTML demos for technical content

### Strategy Pattern (`lib/strategies/`)
- `BlogStrategy.ts` - Interface defining `generate(content: string): Promise<{ content: string; demo?: string }>`
- `RednoteStrategy.ts` - Converts to Chinese with emojis, hashtags, viral style
- `MediumStrategy.ts` - English professional format with code examples; auto-generates demos for technical content saved to `/public/demos/`
- `StrategyFactory.ts` - Returns strategy based on type parameter ('rednote' or 'medium')

### Browser Automation (`lib/browser/`)
- `MCPManagerPW.ts` - Playwright/Patchright wrapper with retry logic, tab management, persistent browser context
- `instance.ts` - Singleton export of MCPManagerPW

### Key External Dependencies
- **OpenAI GPT-4o** - Content extraction, translation, and formatting (configured via `.env`)
- **Claude Agent SDK** - Demo HTML generation for technical content in MediumStrategy
- **Playwright/Patchright** - Headless browser for web scraping
- Browser profile stored in system temp directory

## Configuration

### Environment Variables (`.env`)
- `OPENAI_BASE_URL` - OpenAI API endpoint
- `OPENAI_API_KEY` - API key for GPT-4o
- `ANTHROPIC_API_KEY` - API key for Claude (demo generation)

### Path Aliases
`@/*` maps to project root for absolute imports

## Stateless Design
No database - the application processes content on-demand without persistence. Generated demos are saved as static files to `/public/demos/`.
