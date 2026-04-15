jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn(),
}));

jest.mock('undici', () => ({
    ProxyAgent: jest.fn().mockImplementation((uri: string) => ({ uri })),
    setGlobalDispatcher: jest.fn(),
}));

import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import {
    generateImageWithGoogleAi,
    getImageGenerationBackendName,
    isGoogleImageGenerationConfigured,
    isGoogleImageGenerationEnabled,
} from '../../lib/services/GoogleImageService';

describe('GoogleImageService', () => {
    const envBackup = { ...process.env };
    const mockWriteFileSync = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...envBackup };
        delete process.env.GOOGLE_IMAGE_USE_DIRECT_API;
        delete process.env.GOOGLE_AI_API_KEY;
        delete process.env.GOOGLE_AI_PROXY_URL;
        delete process.env.GOOGLE_AI_BASE_URL;
        delete process.env.GOOGLE_AI_IMAGE_MODEL;
        delete process.env.GOOGLE_AI_API_VERSION;
    });

    afterAll(() => {
        process.env = envBackup;
        mockWriteFileSync.mockRestore();
    });

    it('detects whether direct Google image mode is enabled', () => {
        expect(isGoogleImageGenerationEnabled()).toBe(false);
        expect(getImageGenerationBackendName()).toBe('webgemini');

        process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';

        expect(isGoogleImageGenerationEnabled()).toBe(true);
        expect(getImageGenerationBackendName()).toBe('google-ai');
    });

    it('requires both api key and proxy when direct mode is enabled', () => {
        process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';
        process.env.GOOGLE_AI_API_KEY = 'test-key';

        expect(isGoogleImageGenerationConfigured()).toBe(false);
    });

    it('writes the generated image to disk through the proxy-backed client', async () => {
        process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';
        process.env.GOOGLE_AI_API_KEY = 'test-key';
        process.env.GOOGLE_AI_PROXY_URL = 'http://127.0.0.1:7890';
        process.env.GOOGLE_AI_BASE_URL = 'https://proxy.example.com';
        process.env.GOOGLE_AI_IMAGE_MODEL = 'gemini-test-image';

        const mockGenerateContent = jest.fn().mockResolvedValue({
            candidates: [
                {
                    content: {
                        parts: [
                            { text: 'ok' },
                            {
                                inlineData: {
                                    data: Buffer.from('png-bytes').toString('base64'),
                                    mimeType: 'image/png',
                                },
                            },
                        ],
                    },
                },
            ],
        });

        (GoogleGenAI as jest.Mock).mockImplementation(() => ({
            models: {
                generateContent: mockGenerateContent,
            },
        }));

        await generateImageWithGoogleAi('draw something', '/tmp/out.png', {
            width: 900,
            height: 1200,
        });

        expect(ProxyAgent).toHaveBeenCalledWith('http://127.0.0.1:7890');
        expect(setGlobalDispatcher).toHaveBeenCalled();
        expect(GoogleGenAI).toHaveBeenCalledWith({
            apiKey: 'test-key',
            httpOptions: { baseUrl: 'https://proxy.example.com' },
        });
        expect(mockGenerateContent).toHaveBeenCalledWith({
            model: 'gemini-test-image',
            contents: 'draw something',
            config: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageGenerationConfig: {
                    width: 900,
                    height: 1200,
                },
            },
        });
        expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/out.png', expect.any(Buffer));
    });

    it('throws when direct mode is used without a proxy', async () => {
        process.env.GOOGLE_IMAGE_USE_DIRECT_API = 'true';
        process.env.GOOGLE_AI_API_KEY = 'test-key';

        await expect(generateImageWithGoogleAi('draw something', '/tmp/out.png')).rejects.toThrow(
            /GOOGLE_AI_PROXY_URL/
        );
    });
});
