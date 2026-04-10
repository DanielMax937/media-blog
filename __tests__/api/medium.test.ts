/**
 * Tests for POST /api/medium
 */

// Mock external dependencies
jest.mock('@/lib/services/chrome-devtools-scrape', () => ({
    scrapeUrlBodyText: jest.fn().mockResolvedValue('Raw scraped article content here'),
}));

const COVER_URL = 'https://www.bitstripe.cn/files/cover.png';
const GIF_URL = 'https://www.bitstripe.cn/files/demo.gif';
const MEDIUM_MARKDOWN = `# My Article\n\n![Cover Image](${COVER_URL})\n\nSome text.\n\n![Demo animation](${GIF_URL})\n\n> Try it live!`;

jest.mock('@/lib/strategies/MediumStrategy', () => ({
    MediumStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: MEDIUM_MARKDOWN,
        }),
    })),
}));

jest.mock('@/lib/services/BitstripeUploader', () => ({
    uploadToBitstripe: jest.fn().mockResolvedValue('https://www.bitstripe.cn/files/post.md'),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    logGeneration: jest.fn().mockReturnValue(1),
}));

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
}));

jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: jest.fn().mockResolvedValue({
                    choices: [{ message: { content: 'Extracted main content' } }],
                }),
            },
        },
    }));
});

// Import after mocks
import { POST, extractImageUrls } from '../../app/api/medium/route';
import { uploadToBitstripe } from '@/lib/services/BitstripeUploader';
import { logGeneration } from '@/lib/services/SqliteService';
import { scrapeUrlBodyText } from '@/lib/services/chrome-devtools-scrape';
import { MediumStrategy } from '@/lib/strategies/MediumStrategy';

const mockScrape = scrapeUrlBodyText as jest.MockedFunction<typeof scrapeUrlBodyText>;
const MockMediumStrategy = MediumStrategy as jest.MockedClass<typeof MediumStrategy>;

function makeRequest(body: Record<string, unknown>): Request {
    return {
        json: () => Promise.resolve(body),
    } as unknown as Request;
}

describe('extractImageUrls', () => {
    it('extracts HTTP image URLs from markdown image syntax', () => {
        const md = `# Title\n![Cover](https://cdn.example.com/cover.png)\nText\n![GIF](https://cdn.example.com/anim.gif)`;
        expect(extractImageUrls(md)).toEqual([
            'https://cdn.example.com/cover.png',
            'https://cdn.example.com/anim.gif',
        ]);
    });

    it('returns empty array when no images', () => {
        expect(extractImageUrls('# No images here')).toEqual([]);
    });

    it('ignores relative or non-http image URLs', () => {
        const md = `![Local](./local.png) ![Data](data:image/png;base64,abc)`;
        expect(extractImageUrls(md)).toEqual([]);
    });

    it('ignores plain markdown links (not images)', () => {
        const md = `[Click here](https://example.com)`;
        expect(extractImageUrls(md)).toEqual([]);
    });
});

describe('POST /api/medium', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 400 when url is missing', async () => {
        const req = makeRequest({});
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/url is required/i);
    });

    it('returns flat URL array: [mdUrl, coverUrl, gifUrl]', async () => {
        const req = makeRequest({ url: 'https://example.com/article' });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const urls = await res.json();
        expect(Array.isArray(urls)).toBe(true);
        expect(urls[0]).toBe('https://www.bitstripe.cn/files/post.md');
        expect(urls).toContain(COVER_URL);
        expect(urls).toContain(GIF_URL);
    });

    it('calls uploadToBitstripe with a .md temp file', async () => {
        const req = makeRequest({ url: 'https://example.com/article' });
        await POST(req);
        expect(uploadToBitstripe).toHaveBeenCalledWith(
            expect.stringMatching(/medium-\d+\.md$/)
        );
    });

    it('logs the generation to SQLite with extracted image URLs', async () => {
        const url = 'https://medium-log-test.example.com';
        const req = makeRequest({ url });
        await POST(req);
        expect(logGeneration).toHaveBeenCalledWith(
            url,
            'https://www.bitstripe.cn/files/post.md',
            expect.arrayContaining([COVER_URL, GIF_URL])
        );
    });

    it('returns 500 when scraping fails to extract content', async () => {
        mockScrape.mockResolvedValueOnce('');

        const req = makeRequest({ url: 'https://failing.example.com' });
        const res = await POST(req);
        expect(res.status).toBe(500);
    });

    it('returns 500 on unexpected strategy error', async () => {
        MockMediumStrategy.mockImplementationOnce(() => ({
            generate: jest.fn().mockRejectedValue(new Error('Strategy failure')),
        }));

        const req = makeRequest({ url: 'https://error.example.com' });
        const res = await POST(req);
        expect(res.status).toBe(500);
    });

    it('handles markdown with no embedded images gracefully', async () => {
        MockMediumStrategy.mockImplementationOnce(() => ({
            generate: jest.fn().mockResolvedValue({ content: '# Article with no images\n\nJust text.' }),
        }));

        const req = makeRequest({ url: 'https://no-images.example.com' });
        const res = await POST(req);
        expect(res.status).toBe(200);
        const urls = await res.json();
        // Should still return the md URL
        expect(urls).toEqual(['https://www.bitstripe.cn/files/post.md']);
    });
});
