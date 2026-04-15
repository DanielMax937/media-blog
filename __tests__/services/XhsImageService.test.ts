jest.mock('../../lib/services/api-logger', () => ({
    logApi: jest.fn(),
    logApiError: jest.fn(),
    logOpenAiRawResponseIfEmpty: jest.fn(),
}));

jest.mock('../../lib/services/GoogleImageService', () => ({
    generateImageWithGoogleAi: jest.fn(),
    getImageGenerationBackendName: jest.fn(),
    isGoogleImageGenerationConfigured: jest.fn(),
    isGoogleImageGenerationEnabled: jest.fn(),
}));

import { planXhsImages, isWebgeminiAvailable } from '../../lib/services/XhsImageService';
import OpenAI from 'openai';
import * as logger from '../../lib/services/api-logger';
import * as googleImageService from '../../lib/services/GoogleImageService';

jest.mock('openai');

function makeMockOpenAI(content: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('XhsImageService', () => {
    const logApi = logger.logApi as jest.Mock;
    const logApiError = logger.logApiError as jest.Mock;
    const isEnabled = googleImageService.isGoogleImageGenerationEnabled as jest.Mock;
    const isConfigured = googleImageService.isGoogleImageGenerationConfigured as jest.Mock;
    const backendName = googleImageService.getImageGenerationBackendName as jest.Mock;

    beforeEach(() => {
        jest.resetAllMocks();
        isEnabled.mockReturnValue(false);
        isConfigured.mockReturnValue(false);
        backendName.mockReturnValue('webgemini');
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

        it('uses XHS_PLANNER_MODEL env var (defaults to claude-sonnet-4-6)', async () => {
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

            await planXhsImages(mockOpenAI, 'content');

            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: process.env.XHS_PLANNER_MODEL ?? 'claude-sonnet-4-6',
                })
            );
            // No response_format required — Claude returns JSON reliably via prompting
            expect(mockCreate).not.toHaveBeenCalledWith(
                expect.objectContaining({ response_format: { type: 'json_object' } })
            );
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

    describe('isWebgeminiAvailable', () => {
        it('returns true from env config in direct mode without hitting webgemini health', async () => {
            isEnabled.mockReturnValue(true);
            isConfigured.mockReturnValue(true);
            backendName.mockReturnValue('google-ai');
            const mockFetch = jest.spyOn(global, 'fetch' as never);

            const available = await isWebgeminiAvailable();

            expect(available).toBe(true);
            expect(mockFetch).not.toHaveBeenCalled();
            expect(logApi).toHaveBeenCalledWith('api', 'XhsImage backend selection', {
                backend: 'google-ai',
                directEnabled: true,
                directConfigured: true,
            });
            expect(logApi).toHaveBeenCalledWith('genai', 'XhsImage direct backend config result', {
                backend: 'google-ai',
                ok: true,
            });
            mockFetch.mockRestore();
        });

        it('returns false when direct mode is enabled but config is incomplete', async () => {
            isEnabled.mockReturnValue(true);
            isConfigured.mockReturnValue(false);
            backendName.mockReturnValue('google-ai');
            const mockFetch = jest.spyOn(global, 'fetch' as never);

            const available = await isWebgeminiAvailable();

            expect(available).toBe(false);
            expect(mockFetch).not.toHaveBeenCalled();
            expect(logApi).toHaveBeenCalledWith('api', 'XhsImage backend selection', {
                backend: 'google-ai',
                directEnabled: true,
                directConfigured: false,
            });
            expect(logApi).toHaveBeenCalledWith('genai', 'XhsImage direct backend config result', {
                backend: 'google-ai',
                ok: false,
            });
            mockFetch.mockRestore();
        });

        it('checks webgemini health only when direct mode is disabled', async () => {
            const mockFetch = jest.spyOn(global, 'fetch' as never).mockRejectedValue(new Error('ECONNREFUSED'));

            const available = await isWebgeminiAvailable();

            expect(available).toBe(false);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(logApi).toHaveBeenCalledWith('api', 'XhsImage backend selection', {
                backend: 'webgemini',
                directEnabled: false,
                directConfigured: false,
            });
            expect(logApi).toHaveBeenCalledWith(
                'webgemini',
                'XhsImage backend health check start',
                expect.objectContaining({ backend: 'webgemini' })
            );
            expect(logApiError).toHaveBeenCalledWith(
                'webgemini',
                'XhsImage backend health check failed',
                expect.any(Error),
                expect.objectContaining({ backend: 'webgemini' })
            );
            mockFetch.mockRestore();
        });
    });
});
