const mockGoto = jest.fn();
const mockWaitForLoadState = jest.fn();
const mockEvaluate = jest.fn();
const mockPageClose = jest.fn();
const mockBrowserClose = jest.fn();
const mockNewPage = jest.fn();
const mockLaunch = jest.fn();
const mockWaitForTimeout = jest.fn();

jest.mock('playwright', () => ({
    chromium: {
        launch: mockLaunch,
    },
}));

describe('chrome-devtools-scrape', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        mockGoto.mockResolvedValue(undefined);
        mockWaitForLoadState.mockResolvedValue(undefined);
        mockEvaluate.mockResolvedValue('Playwright body text');
        mockPageClose.mockResolvedValue(undefined);
        mockBrowserClose.mockResolvedValue(undefined);
        mockNewPage.mockResolvedValue({
            goto: mockGoto,
            waitForLoadState: mockWaitForLoadState,
            evaluate: mockEvaluate,
            waitForTimeout: mockWaitForTimeout,
            close: mockPageClose,
            setDefaultNavigationTimeout: jest.fn(),
            setDefaultTimeout: jest.fn(),
        });
        mockLaunch.mockResolvedValue({
            newPage: mockNewPage,
            close: mockBrowserClose,
        });
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('falls back to playwright headed when Chrome DevTools MCP is unavailable', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9223')) as typeof fetch;
        const { scrapeUrlBodyText } = await import('../../lib/services/chrome-devtools-scrape');

        const text = await scrapeUrlBodyText('https://example.com/post');

        expect(text).toBe('Playwright body text');
        expect(mockLaunch).toHaveBeenCalledWith({ headless: false });
        expect(mockGoto).toHaveBeenCalledWith(
            'https://example.com/post',
            expect.objectContaining({ waitUntil: 'domcontentloaded' })
        );
    });

    it('falls back to playwright headed for V2EX listing when Chrome DevTools MCP is unavailable', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9223')) as typeof fetch;
        mockEvaluate.mockResolvedValue([
            'https://www.v2ex.com/t/1',
            'https://www.v2ex.com/t/2',
        ]);
        const { listV2exJobsTabCountLividTopicUrls } = await import('../../lib/services/chrome-devtools-scrape');

        const urls = await listV2exJobsTabCountLividTopicUrls();

        expect(urls).toEqual(['https://www.v2ex.com/t/1', 'https://www.v2ex.com/t/2']);
        expect(mockLaunch).toHaveBeenCalledWith({ headless: false });
    });

    it('uses playwright directly when FORCE_PLAYWRIGHT_SCRAPE is enabled', async () => {
        process.env.FORCE_PLAYWRIGHT_SCRAPE = 'true';
        global.fetch = jest.fn() as typeof fetch;
        const { scrapeUrlBodyText } = await import('../../lib/services/chrome-devtools-scrape');

        const text = await scrapeUrlBodyText('https://example.com/forced');

        expect(text).toBe('Playwright body text');
        expect(global.fetch).not.toHaveBeenCalled();
        delete process.env.FORCE_PLAYWRIGHT_SCRAPE;
    });

    it('retries zhangxinxu category scraping when evaluate runs on the wrong tab', async () => {
        const targetUrl = 'https://www.zhangxinxu.com/wordpress/category/js/page/2/';
        const articleUrl = 'https://www.zhangxinxu.com/wordpress/2025/04/dom-caretpositionfrompoint-api/';
        const toolResponse = (text: string) =>
            new Response(JSON.stringify({ is_error: false, content: [{ type: 'text', text }] }), { status: 200 });
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(toolResponse(JSON.stringify({ pageId: 1 })))
            .mockResolvedValueOnce(toolResponse('1: https://top.100ppi.com/zdb/detail-day---11.html [selected]'))
            .mockResolvedValueOnce(toolResponse('selected page 1'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({
                href: 'https://top.100ppi.com/zdb/detail-day---11.html',
                title: '能源大宗榜',
                relBookmark: 0,
                entryTitle: 0,
                anchorCount: 0,
                urls: [],
                html: '',
            })))
            .mockResolvedValueOnce(toolResponse('closed page 1'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({ pageId: 2 })))
            .mockResolvedValueOnce(toolResponse(`1: https://top.100ppi.com/zdb/detail-day---11.html
2: ${targetUrl} [selected]`))
            .mockResolvedValueOnce(toolResponse('selected page 2'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({
                href: targetUrl,
                title: 'JavaScript | 张鑫旭',
                relBookmark: 10,
                entryTitle: 10,
                anchorCount: 10,
                urls: [articleUrl],
                html: '',
            })))
            .mockResolvedValueOnce(toolResponse('closed page 2'));
        global.fetch = fetchMock as unknown as typeof fetch;

        const { listZhangxinxuCategoryArticleUrls } = await import('../../lib/services/chrome-devtools-scrape');
        const urls = await listZhangxinxuCategoryArticleUrls(undefined, 2);

        expect(urls).toEqual([articleUrl]);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/new_page'),
            expect.objectContaining({
                body: expect.stringContaining(targetUrl),
            }),
        );
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/evaluate_script'))).toHaveLength(2);
    });

    it('retries body scraping when evaluate runs on the wrong tab', async () => {
        const targetUrl = 'https://www.v2ex.com/t/1209586';
        const toolResponse = (text: string) =>
            new Response(JSON.stringify({ is_error: false, content: [{ type: 'text', text }] }), { status: 200 });
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(toolResponse(JSON.stringify({ pageId: 1 })))
            .mockResolvedValueOnce(toolResponse('1: https://top.100ppi.com/zdb/detail-day---11.html [selected]'))
            .mockResolvedValueOnce(toolResponse('selected page 1'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({
                href: 'https://top.100ppi.com/zdb/detail-day---11.html',
                text: 'wrong page text',
            })))
            .mockResolvedValueOnce(toolResponse('closed page 1'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({ pageId: 2 })))
            .mockResolvedValueOnce(toolResponse(`1: https://top.100ppi.com/zdb/detail-day---11.html
2: ${targetUrl} [selected]`))
            .mockResolvedValueOnce(toolResponse('selected page 2'))
            .mockResolvedValueOnce(toolResponse(JSON.stringify({
                href: targetUrl,
                text: 'correct V2EX body text',
            })))
            .mockResolvedValueOnce(toolResponse('closed page 2'));
        global.fetch = fetchMock as unknown as typeof fetch;

        const { scrapeUrlBodyText } = await import('../../lib/services/chrome-devtools-scrape');
        const text = await scrapeUrlBodyText(targetUrl);

        expect(text).toBe('correct V2EX body text');
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/new_page'),
            expect.objectContaining({
                body: expect.stringContaining(targetUrl),
            }),
        );
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/evaluate_script'))).toHaveLength(2);
    });
});
