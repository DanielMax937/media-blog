import fs from 'fs';
import path from 'path';

export interface AstroMicroMdxResult {
    blogDir: string;
    postDir: string;
    filePath: string;
    slug: string;
}

export interface WriteAstroMicroMdxParams {
    markdown: string;
    demoHtml?: string;
    imageUrls?: string[];
    sourceUrl: string;
    now?: Date;
}

function formatDateForAstro(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function stripFrontmatter(markdown: string): string {
    return markdown.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/, '').trimStart();
}

function extractTitle(markdown: string): string {
    const body = stripFrontmatter(markdown);
    const match = body.match(/^#\s+(.+?)\s*#*\s*$/m) ?? body.match(/#\s+(.+?)\s*#*(?:\n|$)/);
    return match?.[1]?.trim() || 'Untitled Article';
}

function removeFirstH1(markdown: string): string {
    const body = stripFrontmatter(markdown);
    const lineStartH1 = body.match(/^\s*#\s+.+?\s*#*\s*\n+/);
    if (lineStartH1) return body.slice(lineStartH1[0].length).trimStart();

    const h1 = body.match(/#\s+.+?\s*#*(?:\n|$)/);
    if (!h1 || h1.index == null) return body.trimStart();

    const prefix = body.slice(0, h1.index);
    const leadingImages = Array.from(prefix.matchAll(/!\[[^\]]*]\([^)]+\)/g)).map((match) => match[0]);
    const rest = body.slice(h1.index + h1[0].length).trimStart();
    if (leadingImages.length === 0) return rest;
    return `${leadingImages.join('\n\n')}\n\n${rest}`;
}

function removeUnresolvedImagePlaceholders(markdown: string): string {
    return markdown
        .replace(/^[ \t]*!\[[^\]]*]\((?:IMAGE_PLACEHOLDER|DEMO_SCREENSHOT_PLACEHOLDER)\)[ \t]*\n?/gm, '\n')
        .replace(/\n{3,}/g, '\n\n');
}

function stripMarkdownForDescription(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^#{1,6}\s+/gm, ' ')
        .replace(/^>\s?/gm, ' ')
        .replace(/[*_`~|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildDescription(markdownBody: string, title: string): string {
    const text = stripMarkdownForDescription(markdownBody);
    if (!text) return title;
    return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
}

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function getCodeFence(content: string): string {
    const runs = content.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
}

interface DemoCodeSnippet {
    title: string;
    language: string;
    code: string;
}

function extractMarkdownImageUrls(markdown: string): Set<string> {
    const urls = new Set<string>();
    for (const match of markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
        urls.add(match[1]);
    }
    return urls;
}

function appendMissingImageUrls(markdownBody: string, imageUrls?: string[]): string {
    const uniqueUrls = [...new Set((imageUrls ?? []).map((url) => url.trim()).filter(Boolean))];
    if (uniqueUrls.length === 0) return markdownBody;

    const existing = extractMarkdownImageUrls(markdownBody);
    const missing = uniqueUrls.filter((url) => !existing.has(url));
    if (missing.length === 0) return markdownBody;

    const images = missing
        .map((url, index) => `![Generated image ${index + 1}](${url})`)
        .join('\n\n');

    return `${markdownBody.trimEnd()}

---

## Generated Images

${images}
`;
}

function resolveAstroMicroBlogDir(): string {
    const configured = process.env.ASTRO_MICRO_BLOG_DIR?.trim();
    if (configured) return path.resolve(configured);
    return path.resolve(process.cwd(), '..', 'astro-micro', 'src', 'content', 'blog');
}

function getUniquePostDir(blogDir: string, date: string, title: string): { slug: string; postDir: string } {
    const titleSlug = slugify(title) || 'article';
    const candidates = [date, `${date}-${titleSlug}`];

    for (const slug of candidates) {
        const postDir = path.join(blogDir, slug);
        if (!fs.existsSync(postDir)) return { slug, postDir };
    }

    for (let i = 2; ; i += 1) {
        const slug = `${date}-${titleSlug}-${i}`;
        const postDir = path.join(blogDir, slug);
        if (!fs.existsSync(postDir)) return { slug, postDir };
    }
}

function hasFencedCode(markdownBody: string): boolean {
    return /```[\s\S]*?```/.test(markdownBody);
}

function normalizeCodeSnippet(code: string, maxLines: number, maxChars: number, truncationMarker: string): string {
    const lines = code
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, '  ')
        .split('\n');

    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

    const indents = lines
        .filter((line) => line.trim())
        .map((line) => line.match(/^ */)?.[0].length ?? 0);
    const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
    const normalized = lines.map((line) => line.slice(minIndent));
    const truncatedByLines = normalized.length > maxLines;
    let snippet = normalized.slice(0, maxLines).join('\n').trim();

    if (snippet.length > maxChars) {
        const clipped = snippet.slice(0, maxChars);
        snippet = clipped.slice(0, Math.max(clipped.lastIndexOf('\n'), 0)).trim() || clipped.trim();
    }

    if ((truncatedByLines || normalized.join('\n').length > snippet.length) && !snippet.endsWith(truncationMarker)) {
        snippet = `${snippet}\n${truncationMarker}`;
    }

    return snippet;
}

function extractFirstTagContent(html: string, tagName: string): string {
    const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match?.[1]?.trim() ?? '';
}

function extractScriptContent(html: string): string {
    const scripts: string[] = [];
    const scriptRegex = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scriptRegex)) {
        const code = match[1]?.trim();
        if (code) scripts.push(code);
    }
    return scripts.join('\n\n');
}

function extractHtmlBodySnippet(html: string): string {
    const body = extractFirstTagContent(html, 'body') || html;
    return body
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/^\s*<!doctype[^>]*>\s*/i, '')
        .replace(/<\/?html\b[^>]*>/gi, '')
        .replace(/<\/?head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .trim();
}

function extractDemoCodeSnippets(demoHtml: string): DemoCodeSnippet[] {
    const htmlSnippet = normalizeCodeSnippet(extractHtmlBodySnippet(demoHtml), 32, 1800, '<!-- ... -->');
    const cssSnippet = normalizeCodeSnippet(extractFirstTagContent(demoHtml, 'style'), 36, 1800, '/* ... */');
    const jsSnippet = normalizeCodeSnippet(extractScriptContent(demoHtml), 42, 2200, '// ...');

    return [
        htmlSnippet ? { title: 'Markup', language: 'html', code: htmlSnippet } : null,
        cssSnippet ? { title: 'Styles', language: 'css', code: cssSnippet } : null,
        jsSnippet ? { title: 'Interaction', language: 'javascript', code: jsSnippet } : null,
    ].filter((snippet): snippet is DemoCodeSnippet => Boolean(snippet));
}

function buildDemoCodeSnippetBlock(demoHtml: string): string {
    const snippets = extractDemoCodeSnippets(demoHtml);
    if (snippets.length === 0) return '';

    const blocks = snippets.map((snippet) => {
        const fence = getCodeFence(snippet.code);
        return `### ${snippet.title}

${fence}${snippet.language}
${snippet.code}
${fence}`;
    });

    return `## Demo Code Snippets

${blocks.join('\n\n')}`;
}

function isImageOnlyBlock(block: string): boolean {
    return block
        .trim()
        .split('\n')
        .every((line) => /^!\[[^\]]*]\([^)]+\)\s*$/.test(line.trim()));
}

function isSubstantiveParagraph(block: string): boolean {
    const trimmed = block.trim();
    if (!trimmed) return false;
    if (/^#{1,6}\s/.test(trimmed)) return false;
    if (/^```/.test(trimmed)) return false;
    if (/^---+$/.test(trimmed)) return false;
    if (/^>/.test(trimmed)) return false;
    if (/^\|/.test(trimmed)) return false;
    if (isImageOnlyBlock(trimmed)) return false;
    return true;
}

function findFirstParagraphEnd(markdownBody: string): number | null {
    const generatedImagesIndex = markdownBody.search(/\n---\n\n## Generated Images\n/);
    const searchableEnd = generatedImagesIndex === -1 ? markdownBody.length : generatedImagesIndex;
    const blockRegex = /\S[\s\S]*?(?=\n{2,}|$)/g;

    for (const match of markdownBody.slice(0, searchableEnd).matchAll(blockRegex)) {
        if (match.index == null) continue;
        const block = match[0];
        if (isSubstantiveParagraph(block)) return match.index + block.length;
    }

    return generatedImagesIndex === -1 ? null : generatedImagesIndex;
}

function insertDemoCodeSnippets(markdownBody: string, demoHtml?: string): string {
    const demo = demoHtml?.trim();
    if (!demo) return markdownBody.trimEnd() + '\n';
    if (hasFencedCode(markdownBody)) return markdownBody.trimEnd() + '\n';

    const snippetBlock = buildDemoCodeSnippetBlock(demo);
    if (!snippetBlock) return markdownBody.trimEnd() + '\n';

    const body = markdownBody.trimEnd();
    const insertAt = findFirstParagraphEnd(body);
    if (insertAt == null) return `${body}\n\n${snippetBlock}\n`;

    return `${body.slice(0, insertAt).trimEnd()}

${snippetBlock}

${body.slice(insertAt).trimStart()}`.trimEnd() + '\n';
}

export function buildAstroMicroMdx(params: WriteAstroMicroMdxParams): {
    content: string;
    title: string;
    date: string;
    description: string;
} {
    const title = extractTitle(params.markdown);
    const body = removeUnresolvedImagePlaceholders(removeFirstH1(params.markdown));
    const bodyWithImages = appendMissingImageUrls(body, params.imageUrls);
    const description = buildDescription(body, title);
    const date = formatDateForAstro(params.now ?? new Date());
    const content = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
date: "${date}"
---

${insertDemoCodeSnippets(bodyWithImages, params.demoHtml)}`;

    return { content, title, date, description };
}

export function writeAstroMicroMdxFromMedium(params: WriteAstroMicroMdxParams): AstroMicroMdxResult {
    const blogDir = resolveAstroMicroBlogDir();
    const { content, title, date } = buildAstroMicroMdx(params);
    const { slug, postDir } = getUniquePostDir(blogDir, date, title);
    const filePath = path.join(postDir, 'index.mdx');

    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');

    return { blogDir, postDir, filePath, slug };
}
