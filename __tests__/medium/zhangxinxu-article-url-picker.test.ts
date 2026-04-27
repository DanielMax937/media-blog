/**
 * Tests for pickFirstUnprocessedZhangxinxuArticleUrl
 */

jest.mock('@/lib/services/chrome-devtools-scrape', () => ({
    listZhangxinxuCategoryArticleUrls: jest.fn(),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    hasGenerationLogForSourceUrl: jest.fn(),
}));

jest.mock('@/lib/services/api-logger', () => ({
    logApi: jest.fn(),
}));

import { pickFirstUnprocessedZhangxinxuArticleUrl } from '@/lib/medium/zhangxinxu-article-url-picker';
import { listZhangxinxuCategoryArticleUrls } from '@/lib/services/chrome-devtools-scrape';
import { hasGenerationLogForSourceUrl } from '@/lib/services/SqliteService';

const URL_A = 'https://www.zhangxinxu.com/wordpress/2024/01/js-article-a/';
const URL_B = 'https://www.zhangxinxu.com/wordpress/2024/02/js-article-b/';
const URL_C = 'https://www.zhangxinxu.com/wordpress/2024/03/js-article-c/';

describe('pickFirstUnprocessedZhangxinxuArticleUrl', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the first link when none have been processed', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock).mockResolvedValue([URL_A, URL_B, URL_C]);
        (hasGenerationLogForSourceUrl as jest.Mock).mockReturnValue(false);

        const result = await pickFirstUnprocessedZhangxinxuArticleUrl();
        expect(result).toBe(URL_A);
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 1);
        expect(hasGenerationLogForSourceUrl).toHaveBeenCalledWith(URL_A, 'medium');
    });

    it('skips already-processed links and returns the first unprocessed one', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock).mockResolvedValue([URL_A, URL_B, URL_C]);
        (hasGenerationLogForSourceUrl as jest.Mock)
            .mockReturnValueOnce(true)  // URL_A already processed
            .mockReturnValueOnce(false); // URL_B not processed

        const result = await pickFirstUnprocessedZhangxinxuArticleUrl();
        expect(result).toBe(URL_B);
        expect(hasGenerationLogForSourceUrl).toHaveBeenCalledWith(URL_A, 'medium');
        expect(hasGenerationLogForSourceUrl).toHaveBeenCalledWith(URL_B, 'medium');
    });

    it('paginates when all links on page 1 have been processed and page 2 has an unprocessed one', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock)
            .mockResolvedValueOnce([URL_A, URL_B])    // page 1: all processed
            .mockResolvedValueOnce([URL_C]);           // page 2: has unprocessed
        (hasGenerationLogForSourceUrl as jest.Mock).mockReturnValue(true); // all processed initially
        // Override for the third check (URL_C) to return false
        (hasGenerationLogForSourceUrl as jest.Mock)
            .mockReturnValueOnce(true)   // URL_A
            .mockReturnValueOnce(true)   // URL_B
            .mockReturnValueOnce(false); // URL_C

        const result = await pickFirstUnprocessedZhangxinxuArticleUrl();
        expect(result).toBe(URL_C);
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 1);
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 2);
    });

    it('returns null when all links on all pages have been processed', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock)
            .mockResolvedValueOnce([URL_A, URL_B])    // page 1
            .mockResolvedValueOnce([URL_C])            // page 2
            .mockResolvedValueOnce([]);                // page 3 (empty = last page)
        (hasGenerationLogForSourceUrl as jest.Mock).mockReturnValue(true);

        const result = await pickFirstUnprocessedZhangxinxuArticleUrl();
        expect(result).toBeNull();
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 1);
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 2);
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledWith(undefined, 3);
        expect(hasGenerationLogForSourceUrl).toHaveBeenCalledTimes(3);
    });

    it('returns null when page 1 is already empty', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock).mockResolvedValue([]);
        (hasGenerationLogForSourceUrl as jest.Mock).mockReturnValue(false);

        const result = await pickFirstUnprocessedZhangxinxuArticleUrl();
        expect(result).toBeNull();
        expect(listZhangxinxuCategoryArticleUrls).toHaveBeenCalledTimes(1);
        expect(hasGenerationLogForSourceUrl).not.toHaveBeenCalled();
    });

    it('propagates errors from listZhangxinxuCategoryArticleUrls', async () => {
        (listZhangxinxuCategoryArticleUrls as jest.Mock).mockRejectedValue(
            new Error('Chrome MCP unavailable')
        );

        await expect(pickFirstUnprocessedZhangxinxuArticleUrl()).rejects.toThrow('Chrome MCP unavailable');
    });
});
