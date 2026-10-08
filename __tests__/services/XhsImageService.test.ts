jest.mock('../../lib/services/api-logger', () => ({
    logApi: jest.fn(),
    logApiError: jest.fn(),
    logOpenAiRawResponseIfEmpty: jest.fn(),
}));

jest.mock('../../lib/services/CodexImageService', () => ({ generateImageWithCodex: jest.fn(), isCodexImageGenerationAvailable: jest.fn() }));
jest.mock('../../lib/llm-fallback', () => ({
    getPrimaryOpenAIModel: jest.fn(() => undefined),
    describeOpenAIModel: jest.fn(() => '(default)'),
    chatWithFallback: jest.fn((client: OpenAI, params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => client.chat.completions.create({ ...params, stream: false }, {})),
}));
jest.mock('fs', () => ({ mkdtempSync: jest.fn(() => '/tmp/offline-codex-slides') }));
import * as fs from 'fs';
import * as native from '../../lib/services/CodexImageService';
import { planXhsImages, isImageBackendAvailable, isWebgeminiAvailable, generateXhsImages, XhsImagePlan } from '../../lib/services/XhsImageService';
import OpenAI from 'openai';
jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));

function makeMockOpenAI(content: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('XhsImageService', () => {
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

    describe('planXhsImages', () => {
        it('parses a valid plan from plain JSON response', async () => {
            const fakePlan = {
                slug: 'ai-tools',
                images: [
                    { type: 'cover', prompt: 'Cover image, Aspect ratio: 3:4' },
                    { type: 'content', prompt: 'Content image, Aspect ratio: 3:4' },
                    { type: 'ending', prompt: 'Ending image, Aspect ratio: 3:4' },
                ],
            };

            const result = await planXhsImages(makeMockOpenAI(JSON.stringify(fakePlan)), '# Test markdown\n\nSome content');

            expect(result.slug).toBe('ai-tools');
            expect(result.images).toHaveLength(3);
            expect(result.images[0].type).toBe('cover');
            expect(result.images[2].type).toBe('ending');
        });

        it('extracts JSON from a markdown code fence when model wraps response', async () => {
            const fakePlan = {
                slug: 'v2ex-topic',
                images: [
                    { type: 'cover', prompt: 'p1' },
                    { type: 'content', prompt: 'p2' },
                    { type: 'ending', prompt: 'p3' },
                ],
            };
            const wrappedResponse = `下面是根据文案生成的图片计划：\n\`\`\`json\n${JSON.stringify(fakePlan)}\n\`\`\``;

            const result = await planXhsImages(makeMockOpenAI(wrappedResponse), 'content');

            expect(result.slug).toBe('v2ex-topic');
            expect(result.images).toHaveLength(3);
        });

        it('extracts JSON from prose response containing embedded JSON object', async () => {
            const fakePlan = {
                slug: 'embed-test',
                images: [
                    { type: 'cover', prompt: 'a' },
                    { type: 'content', prompt: 'b' },
                    { type: 'ending', prompt: 'cta' },
                ],
            };
            const proseResponse = `好的，这是我的计划 ${JSON.stringify(fakePlan)} 希望有帮助`;

            const result = await planXhsImages(makeMockOpenAI(proseResponse), 'content');

            expect(result.slug).toBe('embed-test');
            expect(result.images).toHaveLength(3);
        });

        it('throws when response contains no parseable JSON', async () => {
            const badResponse = '下面这版是基于你给的文案生成的描述，没有JSON格式。';
            // Both calls return bad content (simulates retry failure)
            const mockCreate = jest.fn().mockResolvedValue({
                choices: [{ message: { content: badResponse } }],
            });
            const mockOpenAI = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

            await expect(planXhsImages(mockOpenAI, 'content'))
                .rejects.toThrow(/Could not extract JSON/);
            // Should have been called twice (first + retry)
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        it('succeeds on retry if first call returns prose but second returns JSON', async () => {
            const fakePlan = {
                slug: 'retry-ok',
                images: [
                    { type: 'cover', prompt: 'p1' },
                    { type: 'content', prompt: 'p2' },
                    { type: 'ending', prompt: 'p3' },
                ],
            };
            const mockCreate = jest.fn()
                .mockResolvedValueOnce({ choices: [{ message: { content: '这是说明文字，非JSON' } }] })
                .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fakePlan) } }] });
            const mockOpenAI = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

            const result = await planXhsImages(mockOpenAI, 'content');
            expect(result.slug).toBe('retry-ok');
            expect(result.images).toHaveLength(3);
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        it('omits model by default so the gateway default is used', async () => {
            const previousModel = process.env.XHS_PLANNER_MODEL;
            delete process.env.XHS_PLANNER_MODEL;
            const fakePlan = {
                slug: 'test-model',
                images: [
                    { type: 'cover', prompt: 'p1, Aspect ratio: 3:4' },
                    { type: 'content', prompt: 'p2, Aspect ratio: 3:4' },
                    { type: 'ending', prompt: 'p3, Aspect ratio: 3:4' },
                ],
            };
            const mockCreate = jest.fn().mockResolvedValue({
                choices: [{ message: { content: JSON.stringify(fakePlan) } }],
            });
            const mockOpenAI = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

            try {
                await planXhsImages(mockOpenAI, 'content');
            } finally {
                if (previousModel === undefined) {
                    delete process.env.XHS_PLANNER_MODEL;
                } else {
                    process.env.XHS_PLANNER_MODEL = previousModel;
                }
            }

            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    response_format: { type: 'json_object' },
                }), {}
            );
            expect(mockCreate.mock.calls[0][0].model).toBeUndefined();
        });

        it('throws when plan JSON is missing required fields (empty images)', async () => {
            const badPlan = { slug: 'no-images', images: [] };
            const mockCreate = jest.fn()
                .mockResolvedValue({ choices: [{ message: { content: JSON.stringify(badPlan) } }] });
            const mockOpenAI = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

            await expect(planXhsImages(mockOpenAI, 'content'))
                .rejects.toThrow(/Invalid XhsImagePlan/);
            // Both attempts returned invalid plan → 2 calls
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        it('throws when LLM returns empty content', async () => {
            const mockCreate = jest.fn()
                .mockResolvedValue({ choices: [{ message: { content: null } }] });
            const mockOpenAI = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

            await expect(planXhsImages(mockOpenAI, 'content'))
                .rejects.toThrow(/empty response/);
            // Empty content on first call → throws immediately (no retry)
            expect(mockCreate).toHaveBeenCalledTimes(1);
        });
    });

    describe('isImageBackendAvailable', () => {
        it('checks only native Codex even when old Google flag is enabled', async () => {
            process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';
            expect(await isImageBackendAvailable()).toBe(true);
            expect(native.isCodexImageGenerationAvailable).toHaveBeenCalledTimes(1);
        });
        it('returns false when CLI is unavailable', async () => {
            (native.isCodexImageGenerationAvailable as jest.Mock).mockResolvedValue(false);
            expect(await isImageBackendAvailable()).toBe(false);
        });
        it('returns false when CLI probe throws', async () => {
            (native.isCodexImageGenerationAvailable as jest.Mock).mockRejectedValue(new Error('probe failed'));
            expect(await isImageBackendAvailable()).toBe(false);
        });
        it('keeps the old exported name as a Codex-only compatibility alias', async () => {
            expect(isWebgeminiAvailable).toBe(isImageBackendAvailable);
            expect(await isWebgeminiAvailable()).toBe(true);
            expect(native.isCodexImageGenerationAvailable).toHaveBeenCalledTimes(1);
        });
    });

    describe('generateXhsImages', () => {
        const plan: XhsImagePlan = { slug: 'offline-topic', images: [{ type: 'cover', prompt: 'cover' }, { type: 'content', prompt: 'content' }, { type: 'ending', prompt: 'ending' }] };
        it('submits exactly three native images in order at 1024x1365', async () => {
            expect(await generateXhsImages(plan)).toEqual(['/tmp/offline-codex-slides/01-cover-offline-topic.png', '/tmp/offline-codex-slides/02-content-offline-topic.png', '/tmp/offline-codex-slides/03-ending-offline-topic.png']);
            expect((native.generateImageWithCodex as jest.Mock).mock.calls.map(([prompt]) => prompt)).toEqual(['cover', 'content', 'ending']);
            expect((native.generateImageWithCodex as jest.Mock).mock.calls.every(([, , options]) => options.width === 1024 && options.height === 1365)).toBe(true);
        });
        it('does not retry a failed or unknown slide and continues preserving partial order', async () => {
            (native.generateImageWithCodex as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('outcome unknown')).mockResolvedValueOnce(undefined);
            expect(await generateXhsImages(plan)).toEqual(['/tmp/offline-codex-slides/01-cover-offline-topic.png', '/tmp/offline-codex-slides/03-ending-offline-topic.png']);
            expect((native.generateImageWithCodex as jest.Mock).mock.calls.map(([prompt]) => prompt)).toEqual(['cover', 'content', 'ending']);
        });
        it('returns an empty list after three failures without fallback calls', async () => {
            (native.generateImageWithCodex as jest.Mock).mockRejectedValue(new Error('CLI failed'));
            expect(await generateXhsImages(plan)).toEqual([]);
            expect(native.generateImageWithCodex).toHaveBeenCalledTimes(3);
        });
        it.each(['../outside', 'nested/path', '/absolute', 'unsafe\\path', '..', ''])('rejects unsafe slug %s before directory or CLI calls', async slug => {
            await expect(generateXhsImages({ ...plan, slug })).rejects.toThrow('safe filename');
            expect(fs.mkdtempSync).not.toHaveBeenCalled();
            expect(native.generateImageWithCodex).not.toHaveBeenCalled();
        });
        it('rejects a malformed slide plan before any file or CLI operation', async () => {
            await expect(generateXhsImages({ ...plan, images: plan.images.slice(0, 2) })).rejects.toThrow('exactly 3');
            expect(fs.mkdtempSync).not.toHaveBeenCalled();
            expect(native.generateImageWithCodex).not.toHaveBeenCalled();
        });
    });
});
