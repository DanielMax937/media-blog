import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateAstroMicroSitemap } from '../../lib/services/AstroMicroSitemapService';

describe('AstroMicroSitemapService', () => {
    let tmpDir: string | null = null;

    afterEach(() => {
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
        }
    });

    function makeAstroMicroFixture(): { root: string; blogDir: string; sitemapPath: string } {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-micro-sitemap-'));
        const root = path.join(tmpDir, 'astro-micro');
        const blogDir = path.join(root, 'src', 'content', 'blog');
        const sitemapPath = path.join(root, 'public', 'sitemap.xml');

        fs.mkdirSync(path.join(root, 'public'), { recursive: true });
        fs.mkdirSync(path.join(blogDir, '2026-06-20'), { recursive: true });
        fs.mkdirSync(path.join(blogDir, '2025-02-17'), { recursive: true });
        fs.mkdirSync(path.join(blogDir, 'draft-without-index'), { recursive: true });
        fs.writeFileSync(path.join(root, 'astro.config.mjs'), 'export default {};\n');
        fs.writeFileSync(path.join(blogDir, '2026-06-20', 'index.mdx'), '---\ntitle: New\n---\n');
        fs.writeFileSync(path.join(blogDir, '2025-02-17', 'index.md'), '---\ntitle: Old\n---\n');

        return { root, blogDir, sitemapPath };
    }

    it('writes sitemap.xml with root, blog index, and all indexed blog posts', () => {
        const { blogDir, sitemapPath } = makeAstroMicroFixture();

        const result = updateAstroMicroSitemap({
            blogDir,
            siteUrl: 'https://example.com/',
        });

        expect(result).toEqual({
            sitemapPath,
            urlCount: 4,
            blogUrlCount: 2,
            updated: true,
        });

        const xml = fs.readFileSync(sitemapPath, 'utf8');
        expect(xml).toContain('<loc>https://example.com/</loc>');
        expect(xml).toContain('<loc>https://example.com/blog/</loc>');
        expect(xml).toContain('<loc>https://example.com/blog/2026-06-20</loc>');
        expect(xml).toContain('<loc>https://example.com/blog/2025-02-17</loc>');
        expect(xml).not.toContain('draft-without-index');
        expect(xml.indexOf('/blog/2026-06-20')).toBeLessThan(xml.indexOf('/blog/2025-02-17'));
    });

    it('reports updated false when sitemap content is already current', () => {
        const { blogDir } = makeAstroMicroFixture();

        updateAstroMicroSitemap({ blogDir, siteUrl: 'https://example.com' });
        const result = updateAstroMicroSitemap({ blogDir, siteUrl: 'https://example.com' });

        expect(result.updated).toBe(false);
    });
});
