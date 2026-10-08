/** Legacy filename retained; image behavior now uses mocked native Codex CLI. */
jest.mock('../../lib/services/api-logger', () => ({ logApi: jest.fn(), logApiError: jest.fn(), logOpenAiRawResponseIfEmpty: jest.fn() }));
jest.mock('../../lib/services/CodexImageService', () => ({ generateImageWithCodex: jest.fn(), isCodexImageGenerationAvailable: jest.fn() }));
jest.mock('../../lib/services/AgentImService', () => ({
    generateAgentImImage: jest.fn(() => { throw new Error('Agent-im forbidden in slide tests'); }),
    isAgentImAvailable: jest.fn(() => { throw new Error('Agent-im forbidden in slide tests'); }),
}), { virtual: true });
jest.mock('fs', () => ({ mkdtempSync: () => '/tmp/offline-codex-slides' }));
jest.mock('node:child_process', () => ({
    spawn: jest.fn(() => { throw new Error('CLI forbidden in mocked slide tests'); }),
    execFile: jest.fn(() => { throw new Error('CLI forbidden in mocked slide tests'); }),
}));
import { generateXhsImages, XhsImagePlan } from '../../lib/services/XhsImageService';
import { generateImageWithCodex } from '../../lib/services/CodexImageService';
const generate = generateImageWithCodex as jest.Mock;
const plan: XhsImagePlan = { slug: 'offline', images: [{ type: 'cover', prompt: 'cover' }, { type: 'content', prompt: 'content' }, { type: 'ending', prompt: 'ending' }] };
describe('Codex CLI three slides, no retries and partial results', () => {
    const originalFetch = global.fetch;
    beforeEach(() => {
        jest.clearAllMocks();
        generate.mockReset();
        global.fetch = jest.fn(() => { throw new Error('Network forbidden in slide tests'); }) as unknown as typeof fetch;
    });
    afterEach(() => {
        expect(global.fetch).not.toHaveBeenCalled();
        global.fetch = originalFetch;
    });
    it('generates three in order at the existing XHS dimensions', async () => {
        const paths = await generateXhsImages(plan);
        expect(paths).toEqual(['/tmp/offline-codex-slides/01-cover-offline.png', '/tmp/offline-codex-slides/02-content-offline.png', '/tmp/offline-codex-slides/03-ending-offline.png']);
        expect(generate.mock.calls.map(([prompt]) => prompt)).toEqual(['cover', 'content', 'ending']);
        expect(generate.mock.calls.every(([, , size]) => size.width === 1024 && size.height === 1365)).toBe(true);
    });
    it('does not repeat a failed slide and preserves later partial results', async () => {
        generate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
        const paths = await generateXhsImages(plan);
        expect(paths).toEqual(['/tmp/offline-codex-slides/01-cover-offline.png', '/tmp/offline-codex-slides/03-ending-offline.png']);
        expect(generate.mock.calls.map(([prompt]) => prompt)).toEqual(['cover', 'content', 'ending']);
    });
});
