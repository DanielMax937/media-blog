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
});
