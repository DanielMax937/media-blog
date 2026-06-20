import fs from 'fs';
import path from 'path';

export interface UpdateAstroMicroSitemapParams {
    blogDir: string;
    siteUrl?: string;
    sitemapPath?: string;
}

export interface UpdateAstroMicroSitemapResult {
    sitemapPath: string;
    urlCount: number;
    blogUrlCount: number;
    updated: boolean;
}

const DEFAULT_SITE_URL = 'https://melin.vercel.app';
const SITEMAP_XMLNS =
    'http://www.sitemaps.org/schemas/sitemap/0.9';

function normalizeSiteUrl(siteUrl: string): string {
    return siteUrl.trim().replace(/\/+$/, '');
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function resolveAstroMicroRoot(blogDir: string): string {
    let current = path.resolve(blogDir);
    while (true) {
        if (
            fs.existsSync(path.join(current, 'public')) &&
            (fs.existsSync(path.join(current, 'astro.config.mjs')) ||
                fs.existsSync(path.join(current, 'package.json')))
        ) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Unable to resolve astro-micro root from blog dir: ${blogDir}`);
        }
        current = parent;
    }
}

function hasPostIndex(postDir: string): boolean {
    return ['index.mdx', 'index.md', 'index.mdoc'].some((filename) =>
        fs.existsSync(path.join(postDir, filename))
    );
}

function listBlogSlugs(blogDir: string): string[] {
    if (!fs.existsSync(blogDir)) return [];

    return fs
        .readdirSync(blogDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && hasPostIndex(path.join(blogDir, entry.name)))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a));
}

function buildSitemapXml(siteUrl: string, blogSlugs: string[]): string {
    const baseUrl = normalizeSiteUrl(siteUrl);
    const urls = [
        `${baseUrl}/`,
        `${baseUrl}/blog/`,
        ...blogSlugs.map((slug) => `${baseUrl}/blog/${encodeURIComponent(slug)}`),
    ];

    const body = urls
        .map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`)
        .join('\n');

    return `<urlset xmlns="${SITEMAP_XMLNS}">\n${body}\n</urlset>\n`;
}

export function updateAstroMicroSitemap(
    params: UpdateAstroMicroSitemapParams
): UpdateAstroMicroSitemapResult {
    const blogDir = path.resolve(params.blogDir);
    const repoRoot = resolveAstroMicroRoot(blogDir);
    const sitemapPath = params.sitemapPath
        ? path.resolve(params.sitemapPath)
        : path.join(repoRoot, 'public', 'sitemap.xml');
    const siteUrl = params.siteUrl ?? process.env.ASTRO_MICRO_SITE_URL ?? DEFAULT_SITE_URL;
    const blogSlugs = listBlogSlugs(blogDir);
    const xml = buildSitemapXml(siteUrl, blogSlugs);

    fs.mkdirSync(path.dirname(sitemapPath), { recursive: true });
    const previous = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
    const updated = previous !== xml;
    if (updated) fs.writeFileSync(sitemapPath, xml, 'utf8');

    return {
        sitemapPath,
        urlCount: blogSlugs.length + 2,
        blogUrlCount: blogSlugs.length,
        updated,
    };
}
