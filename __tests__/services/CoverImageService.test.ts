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

import { generateCoverImage } from '../../lib/services/CoverImageService';
import OpenAI from 'openai';
import * as logger from '../../lib/services/api-logger';
import * as googleImageService from '../../lib/services/GoogleImageService';

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

function makeOpenAI(content: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('CoverImageService', () => {
    const logApi = logger.logApi as jest.Mock;
    const logApiError = logger.logApiError as jest.Mock;
    const isEnabled = googleImageService.isGoogleImageGenerationEnabled as jest.Mock;
    const isConfigured = googleImageService.isGoogleImageGenerationConfigured as jest.Mock;
    const backendName = googleImageService.getImageGenerationBackendName as jest.Mock;
    const generateDirect = googleImageService.generateImageWithGoogleAi as jest.Mock;

    beforeEach(() => {
        jest.resetAllMocks();
        isEnabled.mockReturnValue(false);
        isConfigured.mockReturnValue(false);
        backendName.mockReturnValue('webgemini');
    });

    it('skips cover generation in direct mode when env is enabled but config is incomplete', async () => {
        isEnabled.mockReturnValue(true);
        isConfigured.mockReturnValue(false);
        backendName.mockReturnValue('google-ai');
        const openai = makeOpenAI('A tech illustration prompt');

        const result = await generateCoverImage('# Article\n\nContent', openai, '/tmp');

        expect(result).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(logApi).toHaveBeenCalledWith('api', 'CoverImage backend selection', {
            backend: 'google-ai',
            directEnabled: true,
            directConfigured: false,
        });
        expect(logApi).toHaveBeenCalledWith('genai', 'CoverImage direct backend config result', {
            backend: 'google-ai',
            ok: false,
        });
        expect(logApi).toHaveBeenCalledWith('api', 'CoverImage backend unavailable, skipping generation', {
            backend: 'google-ai',
            directEnabled: true,
            directConfigured: false,
        });
    });

    it('uses direct Google AI without checking webgemini health when env enables it', async () => {
        isEnabled.mockReturnValue(true);
        isConfigured.mockReturnValue(true);
        backendName.mockReturnValue('google-ai');
        generateDirect.mockResolvedValue(undefined);
        const openai = makeOpenAI('A tech illustration prompt');

        const result = await generateCoverImage('# Article\n\nContent', openai, '/tmp');

        expect(result).toMatch(/^\/tmp\/cover-\d+\.png$/);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(generateDirect).toHaveBeenCalledTimes(1);
        expect(logApi).toHaveBeenCalledWith('api', 'CoverImage backend selection', {
            backend: 'google-ai',
            directEnabled: true,
            directConfigured: true,
        });
        expect(logApi).toHaveBeenCalledWith('genai', 'CoverImage direct backend config result', {
            backend: 'google-ai',
            ok: true,
        });
        expect(logApi).toHaveBeenCalledWith(
            'genai',
            'CoverImage generate submit',
            expect.objectContaining({ backend: 'google-ai' })
        );
    });

    it('uses webgemini health check only when direct mode is disabled', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
        const openai = makeOpenAI('A tech illustration prompt');

        const result = await generateCoverImage('# Article\n\nContent', openai, '/tmp');

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(logApi).toHaveBeenCalledWith('api', 'CoverImage backend selection', {
            backend: 'webgemini',
            directEnabled: false,
            directConfigured: false,
        });
        expect(logApi).toHaveBeenCalledWith(
            'webgemini',
            'CoverImage backend health check start',
            expect.objectContaining({ backend: 'webgemini' })
        );
        expect(logApiError).toHaveBeenCalledWith(
            'webgemini',
            'CoverImage backend health check failed',
            expect.any(Error),
            expect.objectContaining({ backend: 'webgemini' })
        );
    });
});
