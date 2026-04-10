/**
 * Tests for POST /api/rednote (async job enqueue)
 */

jest.mock('@/lib/services/chrome-devtools-scrape', () => ({
    scrapeUrlBodyText: jest.fn().mockResolvedValue('Raw scraped article content here'),
}));

jest.mock('@/lib/rednote/run-rednote-job', () => ({
    runRednoteJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/strategies/RednoteStrategy', () => ({
    RednoteStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: '# Rednote Post\n\nContent here.',
            imageUrls: [
                'https://www.bitstripe.cn/files/slide1.png',
                'https://www.bitstripe.cn/files/slide2.png',
            ],
        }),
    })),
}));

jest.mock('@/lib/services/BitstripeUploader', () => ({
    uploadToBitstripe: jest.fn().mockResolvedValue('https://www.bitstripe.cn/files/post.md'),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    createRednoteJob: jest.fn().mockReturnValue('test-job-id'),
    logGeneration: jest.fn().mockReturnValue(1),
}));

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
}));

jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: jest.fn().mockResolvedValue({
                    choices: [{ message: { content: 'Extracted main content' } }],
                }),
            },
        },
    }));
});

import { POST } from '../../app/api/rednote/route';
import { createRednoteJob } from '@/lib/services/SqliteService';
import { runRednoteJob } from '@/lib/rednote/run-rednote-job';

function makeRequest(body: Record<string, unknown>): Request {
    return {
        json: () => Promise.resolve(body),
    } as unknown as Request;
}

describe('POST /api/rednote', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 400 when url is missing', async () => {
        const req = makeRequest({});
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/url is required/i);
    });

    it('returns 202 with jobId and schedules runRednoteJob (Chrome DevTools MCP scrape in worker path)', async () => {
        const req = makeRequest({ url: 'https://example.com/article' });
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.jobId).toBe('test-job-id');
        expect(createRednoteJob).toHaveBeenCalledWith('https://example.com/article');
        expect(runRednoteJob).toHaveBeenCalledWith('test-job-id', 'https://example.com/article');
    });
});
