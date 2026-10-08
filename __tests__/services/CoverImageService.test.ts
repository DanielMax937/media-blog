jest.mock('../../lib/services/api-logger', () => ({ logApi: jest.fn(), logApiError: jest.fn(), logOpenAiRawResponseIfEmpty: jest.fn() }));
jest.mock('../../lib/services/CodexImageService', () => ({ generateImageWithCodex: jest.fn(), isCodexImageGenerationAvailable: jest.fn() }));
jest.mock('../../lib/llm-fallback', () => ({
    getPrimaryOpenAIModel: jest.fn(() => undefined),
    describeOpenAIModel: jest.fn(() => '(default)'),
    chatWithFallback: jest.fn((client: OpenAI, params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => client.chat.completions.create({ ...params, stream: false }, {})),
}));
import { generateCoverImage } from '../../lib/services/CoverImageService';
import * as native from '../../lib/services/CodexImageService';
import OpenAI from 'openai';

function client(content = 'cover prompt'): OpenAI {
    return { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } } } as unknown as OpenAI;
}

describe('CoverImageService native Codex only', () => {
    const originalFetch = global.fetch;
    const originalDirectFlag = process.env.GOOGLE_IMAGE_USE_DIRECT_API;
    const fetchGuard = jest.fn().mockRejectedValue(new Error('Network is forbidden in this test'));
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = fetchGuard as typeof fetch;
        (native.isCodexImageGenerationAvailable as jest.Mock).mockReset().mockResolvedValue(true);
        (native.generateImageWithCodex as jest.Mock).mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => {
        expect(fetchGuard).not.toHaveBeenCalled();
        global.fetch = originalFetch;
        if (originalDirectFlag === undefined) delete process.env.GOOGLE_IMAGE_USE_DIRECT_API;
        else process.env.GOOGLE_IMAGE_USE_DIRECT_API = originalDirectFlag;
    });

    it('uses native Codex once at 1536x864', async () => {
        const openai = client();
        const outPath = await generateCoverImage('# article', openai, '/tmp');
        expect(outPath).toMatch(/^\/tmp\/cover-\d+\.png$/);
        expect(native.generateImageWithCodex).toHaveBeenCalledWith('cover prompt', outPath, { width: 1536, height: 864 });
        expect(native.generateImageWithCodex).toHaveBeenCalledTimes(1);
        expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    });

    it('does not switch to Google when its old flag is enabled', async () => {
        process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';
        expect(await generateCoverImage('# article', client(), '/tmp')).not.toBeNull();
        expect(native.isCodexImageGenerationAvailable).toHaveBeenCalledTimes(1);
        expect(native.generateImageWithCodex).toHaveBeenCalledTimes(1);
    });

    it('returns null without text/image calls when CLI unavailable', async () => {
        (native.isCodexImageGenerationAvailable as jest.Mock).mockResolvedValue(false);
        const openai = client();
        expect(await generateCoverImage('# article', openai, '/tmp')).toBeNull();
        expect(openai.chat.completions.create).not.toHaveBeenCalled();
        expect(native.generateImageWithCodex).not.toHaveBeenCalled();
    });

    it('keeps the cover optional when availability probing throws', async () => {
        (native.isCodexImageGenerationAvailable as jest.Mock).mockRejectedValue(new Error('probe failed'));
        expect(await generateCoverImage('# article', client(), '/tmp')).toBeNull();
        expect(native.generateImageWithCodex).not.toHaveBeenCalled();
    });

    it.each(['outcome unknown', 'timeout', 'save failed'])('never resubmits after %s', async errorMessage => {
        (native.generateImageWithCodex as jest.Mock).mockRejectedValue(new Error(errorMessage));
        const openai = client();
        expect(await generateCoverImage('# article', openai, '/tmp')).toBeNull();
        expect(native.generateImageWithCodex).toHaveBeenCalledTimes(1);
        expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    });

    it('does not invoke image generation after text prompt failure', async () => {
        const openai = client();
        (openai.chat.completions.create as jest.Mock).mockRejectedValue(new Error('text failure'));
        expect(await generateCoverImage('# article', openai, '/tmp')).toBeNull();
        expect(native.generateImageWithCodex).not.toHaveBeenCalled();
    });

    it('preserves the existing fallback prompt for an empty text response', async () => {
        await generateCoverImage('# article', client(''), '/tmp');
        expect(native.generateImageWithCodex).toHaveBeenCalledWith(expect.stringContaining('Abstract technology concept'), expect.any(String), { width: 1536, height: 864 });
    });
});
