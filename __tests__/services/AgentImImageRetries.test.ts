/** Legacy filename retained: uncertain native Codex outcomes are never retried. */
jest.mock('../../lib/services/api-logger', () => ({ logApi: jest.fn(), logApiError: jest.fn(), logOpenAiRawResponseIfEmpty: jest.fn() }));
jest.mock('../../lib/services/CodexImageService', () => ({ generateImageWithCodex: jest.fn(), isCodexImageGenerationAvailable: jest.fn() }));
jest.mock('../../lib/services/AgentImService', () => ({
    generateAgentImImage: jest.fn(() => { throw new Error('Agent-im forbidden in retry tests'); }),
    isAgentImAvailable: jest.fn(() => { throw new Error('Agent-im forbidden in retry tests'); }),
}), { virtual: true });
jest.mock('fs', () => ({ mkdtempSync: () => '/tmp/offline-codex-retry-slides' }));
jest.mock('node:child_process', () => ({
    spawn: jest.fn(() => { throw new Error('CLI forbidden in mocked retry tests'); }),
    execFile: jest.fn(() => { throw new Error('CLI forbidden in mocked retry tests'); }),
}));
import { generateXhsImages, XhsImagePlan } from '../../lib/services/XhsImageService';
import { generateCoverImage } from '../../lib/services/CoverImageService';
import { generateImageWithCodex, isCodexImageGenerationAvailable } from '../../lib/services/CodexImageService';
import OpenAI from 'openai';
const generate = generateImageWithCodex as jest.Mock;
const available = isCodexImageGenerationAvailable as jest.Mock;
const plan: XhsImagePlan = { slug: 'offline', images: [{ type: 'cover', prompt: 'cover' }, { type: 'content', prompt: 'content' }, { type: 'ending', prompt: 'ending' }] };

describe('native Codex boundary does not duplicate uncertain generation', () => {
    const originalFetch = global.fetch;
    beforeEach(() => {
        jest.clearAllMocks();
        generate.mockReset();
        available.mockResolvedValue(true);
        global.fetch = jest.fn(() => { throw new Error('Network forbidden in retry tests'); }) as unknown as typeof fetch;
    });
    afterEach(() => {
        expect(global.fetch).not.toHaveBeenCalled();
        global.fetch = originalFetch;
    });
    it.each(['timeout', 'ECONNRESET', 'invalid native response', 'disk full', 'nonzero exit'])
        ('does not resubmit a slide after %s; later slides still work', async kind => {
            generate.mockRejectedValueOnce(new Error(kind));
            const paths = await generateXhsImages(plan);
            expect(paths).toHaveLength(2);
            expect(generate.mock.calls.map(([prompt]) => prompt)).toEqual(['cover', 'content', 'ending']);
            expect(generate).toHaveBeenCalledTimes(3);
        });
    it('also prevents duplicate cover generation after a disconnection', async () => {
        generate.mockRejectedValueOnce(new Error('ECONNRESET'));
        const client = { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'cover prompt' } }] }) } } } as unknown as OpenAI;
        expect(await generateCoverImage('# article', client, '/tmp')).toBeNull();
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate).toHaveBeenCalledWith('cover prompt', expect.any(String), { width: 1536, height: 864 });
    });
});
