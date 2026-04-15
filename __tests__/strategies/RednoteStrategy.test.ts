import { RednoteStrategy } from '../../lib/strategies/RednoteStrategy';
import * as XhsImageService from '../../lib/services/XhsImageService';
import * as BitstripeUploader from '../../lib/services/BitstripeUploader';
import OpenAI from 'openai';

jest.mock('../../lib/services/XhsImageService');
jest.mock('../../lib/services/BitstripeUploader');

const mockIsWebgeminiAvailable = XhsImageService.isWebgeminiAvailable as jest.Mock;
const mockPlanXhsImages = XhsImageService.planXhsImages as jest.Mock;
const mockGenerateXhsImages = XhsImageService.generateXhsImages as jest.Mock;
const mockUploadToBitstripe = BitstripeUploader.uploadToBitstripe as jest.Mock;

function makeOpenAI(markdownContent: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: markdownContent } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('RednoteStrategy', () => {
    afterEach(() => jest.resetAllMocks());

    it('returns markdown content', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockResolvedValue({
            slug: 'test',
            images: [
                { type: 'cover', prompt: 'p1' },
                { type: 'content', prompt: 'p2' },
                { type: 'ending', prompt: 'p3' },
            ],
        });
        mockGenerateXhsImages.mockResolvedValue(['/tmp/01.png', '/tmp/02.png', '/tmp/03.png']);
        mockUploadToBitstripe
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/01.png')
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/02.png')
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/03.png');

        const openai = makeOpenAI('# 测试文案\n\n内容');
        const strategy = new RednoteStrategy(openai);

        const result = await strategy.generate('test article');

        expect(result.content).toBe('# 测试文案\n\n内容');
    });

    it('throws when webgemini is unavailable (images are required)', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(false);
        const openai = makeOpenAI('# 文章');
        const strategy = new RednoteStrategy(openai);

        await expect(strategy.generate('test')).rejects.toThrow(
            /image generation backend unavailable/
        );
    });

    it('generates images and uploads when webgemini is available', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockResolvedValue({
            slug: 'test-slug',
            images: [
                { type: 'cover', prompt: 'cover prompt' },
                { type: 'content', prompt: 'content prompt' },
                { type: 'ending', prompt: 'ending prompt' },
            ],
        });
        mockGenerateXhsImages.mockResolvedValue([
            '/tmp/01-cover.png',
            '/tmp/02-content.png',
            '/tmp/03-ending.png',
        ]);
        mockUploadToBitstripe
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/01-cover.png')
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/02-content.png')
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/03-ending.png');

        const openai = makeOpenAI('# 小红书文案');
        const strategy = new RednoteStrategy(openai);

        const result = await strategy.generate('article content');

        expect(result.content).toBe('# 小红书文案');
        expect(result.imageUrls).toEqual([
            'https://www.bitstripe.cn/files/01-cover.png',
            'https://www.bitstripe.cn/files/02-content.png',
            'https://www.bitstripe.cn/files/03-ending.png',
        ]);
    });

    it('does NOT embed imageUrls in markdown content', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockResolvedValue({
            slug: 'topic',
            images: [
                { type: 'cover', prompt: 'a' },
                { type: 'content', prompt: 'b' },
                { type: 'ending', prompt: 'c' },
            ],
        });
        mockGenerateXhsImages.mockResolvedValue(['/tmp/1.png', '/tmp/2.png', '/tmp/3.png']);
        mockUploadToBitstripe.mockResolvedValue('https://www.bitstripe.cn/files/img.png');

        const openai = makeOpenAI('# 文章正文');
        const strategy = new RednoteStrategy(openai);

        const result = await strategy.generate('content');

        expect(result.content).not.toContain('bitstripe.cn');
        expect(result.imageUrls).toEqual([
            'https://www.bitstripe.cn/files/img.png',
            'https://www.bitstripe.cn/files/img.png',
            'https://www.bitstripe.cn/files/img.png',
        ]);
    });

    it('returns partial imageUrls when some (but not all) uploads fail', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockResolvedValue({
            slug: 'partial',
            images: [
                { type: 'cover', prompt: 'p1' },
                { type: 'content', prompt: 'p2' },
                { type: 'ending', prompt: 'p3' },
            ],
        });
        mockGenerateXhsImages.mockResolvedValue(['/tmp/img1.png', '/tmp/img2.png', '/tmp/img3.png']);
        mockUploadToBitstripe
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/img1.png')
            .mockRejectedValueOnce(new Error('scp failed'))
            .mockResolvedValueOnce('https://www.bitstripe.cn/files/img3.png');

        const openai = makeOpenAI('# 文章');
        const strategy = new RednoteStrategy(openai);

        const result = await strategy.generate('content');

        expect(result.imageUrls).toEqual([
            'https://www.bitstripe.cn/files/img1.png',
            'https://www.bitstripe.cn/files/img3.png',
        ]);
    });

    it('throws when ALL image uploads fail', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockResolvedValue({
            slug: 'fail-all',
            images: [
                { type: 'cover', prompt: 'p1' },
                { type: 'content', prompt: 'p2' },
                { type: 'ending', prompt: 'p3' },
            ],
        });
        mockGenerateXhsImages.mockResolvedValue(['/tmp/1.png', '/tmp/2.png', '/tmp/3.png']);
        mockUploadToBitstripe.mockRejectedValue(new Error('scp timeout'));

        const openai = makeOpenAI('# 文章');
        const strategy = new RednoteStrategy(openai);

        await expect(strategy.generate('content')).rejects.toThrow(
            /All image uploads failed/
        );
    });

    it('throws when image generation pipeline fails', async () => {
        mockIsWebgeminiAvailable.mockResolvedValue(true);
        mockPlanXhsImages.mockRejectedValue(new Error('OpenAI rate limit'));

        const openai = makeOpenAI('# 文章');
        const strategy = new RednoteStrategy(openai);

        await expect(strategy.generate('content')).rejects.toThrow('OpenAI rate limit');
    });
});
