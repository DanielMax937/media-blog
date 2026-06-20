import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    buildAstroMicroMdx,
    writeAstroMicroMdxFromMedium,
} from '../../lib/services/AstroMicroMdxService';

describe('AstroMicroMdxService', () => {
    let tmpDir: string | null = null;

    afterEach(() => {
        delete process.env.ASTRO_MICRO_BLOG_DIR;
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
        }
    });

    it('builds Astro-compatible MDX with frontmatter and keeps existing code snippets', () => {
        const result = buildAstroMicroMdx({
            sourceUrl: 'https://example.com/article',
            now: new Date('2026-06-20T01:00:00.000Z'),
            markdown: `# My Demo Article

![Cover](https://www.bitstripe.cn/files/cover.png)

Intro paragraph with [a link](https://example.com) and useful context.

![Generated visual](IMAGE_PLACEHOLDER)

![Generated demo](DEMO_SCREENSHOT_PLACEHOLDER)

\`\`\`css
.box { color: red; }
\`\`\`
`,
            imageUrls: [
                'https://www.bitstripe.cn/files/cover.png',
                'https://www.bitstripe.cn/files/demo-result.gif',
            ],
            demoHtml: '<!doctype html>\n<html><body><script>console.log("demo")</script></body></html>',
        });

        expect(result.title).toBe('My Demo Article');
        expect(result.date).toBe('2026-06-20');
        expect(result.content).toContain('title: "My Demo Article"');
        expect(result.content).toContain('description: "Intro paragraph with a link and useful context."');
        expect(result.content).not.toMatch(/^# My Demo Article/m);
        expect(result.content).toContain('![Cover](https://www.bitstripe.cn/files/cover.png)');
        expect(result.content.match(/https:\/\/www\.bitstripe\.cn\/files\/cover\.png/g)?.length).toBe(1);
        expect(result.content).toContain('![Generated image 1](https://www.bitstripe.cn/files/demo-result.gif)');
        expect(result.content).not.toContain('IMAGE_PLACEHOLDER');
        expect(result.content).not.toContain('DEMO_SCREENSHOT_PLACEHOLDER');
        expect(result.content).toContain('```css');
        expect(result.content).toContain('.box { color: red; }');
        expect(result.content).not.toContain('## Demo Code');
        expect(result.content).not.toContain('<!doctype html>');
    });

    it('inserts focused demo snippets into the article body when markdown has no code blocks', () => {
        const result = buildAstroMicroMdx({
            sourceUrl: 'https://example.com/article',
            now: new Date('2026-06-20T01:00:00.000Z'),
            markdown: `# Snippet Article

Intro paragraph that explains the interaction.

## Why it matters

The example reacts to user input.
`,
            demoHtml: `<!doctype html>
<html>
<head>
  <style>
    .card {
      color: red;
      border: 1px solid currentColor;
    }
  </style>
</head>
<body>
  <section class="card">
    <button id="toggle">Toggle</button>
  </section>
  <script>
    const button = document.querySelector('#toggle');
    button?.addEventListener('click', () => {
      document.body.classList.toggle('active');
    });
  </script>
</body>
</html>`,
        });

        expect(result.content).toContain('## Demo Code Snippets');
        expect(result.content).toContain('### Markup');
        expect(result.content).toContain('<button id="toggle">Toggle</button>');
        expect(result.content).toContain('### Styles');
        expect(result.content).toContain('.card {');
        expect(result.content).toContain('### Interaction');
        expect(result.content).toContain("addEventListener('click'");
        expect(result.content).not.toContain('<!doctype html>');
        expect(result.content).not.toContain('<html>');

        const introIndex = result.content.indexOf('Intro paragraph that explains the interaction.');
        const snippetIndex = result.content.indexOf('## Demo Code Snippets');
        const nextSectionIndex = result.content.indexOf('## Why it matters');
        expect(introIndex).toBeLessThan(snippetIndex);
        expect(snippetIndex).toBeLessThan(nextSectionIndex);
    });

    it('extracts inline H1 after a leading uploaded image and drops non-content prelude text', () => {
        const result = buildAstroMicroMdx({
            sourceUrl: 'https://example.com/article',
            now: new Date('2026-06-20T01:00:00.000Z'),
            markdown:
                '![Cover Image](https://www.bitstripe.cn/files/cover-inline.png)\n\n' +
                'Internal generation note.# Inline Title\n\nArticle body.',
        });

        expect(result.title).toBe('Inline Title');
        expect(result.content).toContain('![Cover Image](https://www.bitstripe.cn/files/cover-inline.png)');
        expect(result.content).toContain('Article body.');
        expect(result.content).not.toContain('Internal generation note');
        expect(result.content).not.toMatch(/^# Inline Title/m);
    });

    it('writes index.mdx into the configured astro-micro blog directory without overwriting', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-micro-mdx-'));
        process.env.ASTRO_MICRO_BLOG_DIR = tmpDir;

        const first = writeAstroMicroMdxFromMedium({
            sourceUrl: 'https://example.com/article',
            now: new Date('2026-06-20T01:00:00.000Z'),
            markdown: '# Collision Title\n\nBody text.',
            demoHtml: '<html>demo</html>',
        });
        const second = writeAstroMicroMdxFromMedium({
            sourceUrl: 'https://example.com/article-2',
            now: new Date('2026-06-20T02:00:00.000Z'),
            markdown: '# Collision Title\n\nSecond body text.',
            demoHtml: '<html>demo 2</html>',
        });

        expect(first.slug).toBe('2026-06-20');
        expect(second.slug).toBe('2026-06-20-collision-title');
        expect(fs.existsSync(first.filePath)).toBe(true);
        expect(fs.existsSync(second.filePath)).toBe(true);
        expect(fs.readFileSync(second.filePath, 'utf-8')).toContain('Second body text.');
    });
});
