import { MediumStrategy } from '../../lib/strategies/MediumStrategy';
import * as MarkdownDemoInserter from '../../lib/services/MarkdownDemoInserter';
import * as DemoGifService from '../../lib/services/DemoGifService';
import * as CoverImageService from '../../lib/services/CoverImageService';
import * as BitstripeUploader from '../../lib/services/BitstripeUploader';
import OpenAI from 'openai';

jest.mock('../../lib/services/MarkdownDemoInserter');
jest.mock('../../lib/services/DemoGifService');
jest.mock('../../lib/services/CoverImageService');
jest.mock('../../lib/services/BitstripeUploader');
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: jest.fn().mockImplementation(async function* () {
        yield {
            type: 'assistant',
            message: {
                content: [{ type: 'text', text: '<html>demo</html>' }],
            },
        };
        yield { type: 'result', subtype: 'success', result: 'done' };
    }),
}));
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn().mockReturnValue(true),
    readFileSync: jest.fn().mockReturnValue('<html>demo</html>'),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    mkdtempSync: jest.fn().mockReturnValue('/tmp/test'),
    unlink: jest.fn(),
    rmdir: jest.fn(),
    copyFileSync: jest.fn(),
}));

const mockFindSlots = MarkdownDemoInserter.findDemoInsertionSlots as jest.Mock;
const mockReplaceSlot = MarkdownDemoInserter.replaceSlotInMarkdown as jest.Mock;
const mockPlanSteps = DemoGifService.planInteractionSteps as jest.Mock;
const mockGenerateGif = DemoGifService.generateGifForDemo as jest.Mock;
const mockGenerateCover = CoverImageService.generateCoverImage as jest.Mock;
const mockUpload = BitstripeUploader.uploadToBitstripe as jest.Mock;

function makeOpenAI(responses: string[]): OpenAI {
    let callIndex = 0;
    const mockCreate = jest.fn().mockImplementation(() =>
        Promise.resolve({
            choices: [{ message: { content: responses[callIndex++ % responses.length] } }],
        })
    );
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('MediumStrategy', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.MEDIUM_DEMO_PROVIDER;
        mockReplaceSlot.mockImplementation((md: string, _slot: unknown, replacement: string) =>
            md + replacement
        );
    });

    it('generates non-technical content without demo or GIF pipeline', async () => {
        const openai = makeOpenAI(['English translation', 'NO', 'Formatted medium content']);
        const strategy = new MediumStrategy(openai);
        mockGenerateCover.mockResolvedValue(null);
        mockFindSlots.mockResolvedValue([]);

        const result = await strategy.generate('Some non-technical article');

        expect(result.content).toBeTruthy();
        expect(mockPlanSteps).not.toHaveBeenCalled();
        expect(mockGenerateGif).not.toHaveBeenCalled();
    });

    it('skips GIF insertion when no slots found', async () => {
        process.env.MEDIUM_DEMO_PROVIDER = 'openai';
        const openai = makeOpenAI(['English', 'YES', '<html>demo</html>', 'Formatted markdown with code']);
        const strategy = new MediumStrategy(openai);
        mockFindSlots.mockResolvedValue([]);
        mockGenerateCover.mockResolvedValue(null);

        const result = await strategy.generate('Technical article about CSS');

        expect(result.content).toBeTruthy();
        expect(mockPlanSteps).not.toHaveBeenCalled();
    });

    it('defaults to claude for technical demo generation', async () => {
        const openai = makeOpenAI(['English', 'YES', 'Formatted markdown with code']);
        const strategy = new MediumStrategy(openai);
        mockFindSlots.mockResolvedValue([]);
        mockGenerateCover.mockResolvedValue(null);

        const result = await strategy.generate('Technical article about CSS');

        expect(result.content).toBeTruthy();
    });

    it('generates GIF and embeds URL when slot is found and GIF succeeds', async () => {
        process.env.MEDIUM_DEMO_PROVIDER = 'openai';
        const openai = makeOpenAI(['English', 'YES', '<html>demo</html>', 'Formatted markdown with code']);
        const strategy = new MediumStrategy(openai);

        mockFindSlots.mockResolvedValue([
            {
                placeholder: '![Demo](DEMO_SCREENSHOT_PLACEHOLDER)',
                contextDescription: 'Show button click',
                index: 0,
            },
        ]);
        mockPlanSteps.mockResolvedValue([
            { type: 'wait', duration: 500, description: 'Wait' },
            { type: 'click', selector: '#btn', description: 'Click' },
        ]);
        mockGenerateGif.mockResolvedValue('/tmp/demo.gif');
        mockUpload.mockResolvedValue('https://www.bitstripe.cn/files/demo.gif');
        mockGenerateCover.mockResolvedValue(null);
        mockReplaceSlot.mockImplementation((md: string, _slot: unknown, replacement: string) => {
            if (replacement.includes('demo.gif')) return md.replace('PLACEHOLDER_FOUND', replacement);
            return md;
        });

        const result = await strategy.generate('Technical article about React');

        expect(mockPlanSteps).toHaveBeenCalled();
        expect(mockGenerateGif).toHaveBeenCalled();
        expect(result.content).toBeTruthy();
    });

    it('skips slot when GIF generation returns null (graceful degradation)', async () => {
        process.env.MEDIUM_DEMO_PROVIDER = 'openai';
        const openai = makeOpenAI(['English', 'YES', '<html>demo</html>', 'Formatted markdown']);
        const strategy = new MediumStrategy(openai);

        mockFindSlots.mockResolvedValue([
            { placeholder: '![Demo](DEMO_SCREENSHOT_PLACEHOLDER)', contextDescription: 'ctx', index: 0 },
        ]);
        mockPlanSteps.mockResolvedValue([{ type: 'wait', duration: 500, description: 'Wait' }]);
        mockGenerateGif.mockResolvedValue(null); // GIF failed
        mockGenerateCover.mockResolvedValue(null);

        const result = await strategy.generate('Technical article');

        // Should not throw, should not have uploaded anything for this slot
        expect(mockUpload).not.toHaveBeenCalled();
        expect(result.content).toBeTruthy();
    });

    it('skips GIF upload failure gracefully', async () => {
        process.env.MEDIUM_DEMO_PROVIDER = 'openai';
        const openai = makeOpenAI(['English', 'YES', '<html>demo</html>', 'Formatted markdown']);
        const strategy = new MediumStrategy(openai);

        mockFindSlots.mockResolvedValue([
            { placeholder: '![Demo](DEMO_SCREENSHOT_PLACEHOLDER)', contextDescription: 'ctx', index: 0 },
        ]);
        mockPlanSteps.mockResolvedValue([{ type: 'click', selector: '#btn', description: 'Click' }]);
        mockGenerateGif.mockResolvedValue('/tmp/demo.gif');
        mockUpload.mockRejectedValue(new Error('Upload failed'));
        mockGenerateCover.mockResolvedValue(null);

        const result = await strategy.generate('Technical article');

        expect(result.content).toBeTruthy();
    });

    it('prepends cover image when generation and upload succeed', async () => {
        const openai = makeOpenAI(['English', 'NO', '# My Article\n\nContent here']);
        const strategy = new MediumStrategy(openai);
        mockGenerateCover.mockResolvedValue('/tmp/cover.png');
        mockUpload.mockResolvedValue('https://www.bitstripe.cn/files/cover.png');
        mockFindSlots.mockResolvedValue([]);

        const result = await strategy.generate('Some article');

        expect(result.content).toContain('https://www.bitstripe.cn/files/cover.png');
    });

    it('returns content without cover when cover generation fails', async () => {
        const openai = makeOpenAI(['English', 'NO', '# My Article\n\nContent here']);
        const strategy = new MediumStrategy(openai);
        mockGenerateCover.mockResolvedValue(null);
        mockFindSlots.mockResolvedValue([]);

        const result = await strategy.generate('Some article');

        expect(result.content).toBeTruthy();
        expect(result.content).not.toContain('Cover Image');
    });
});
