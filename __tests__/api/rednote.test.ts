/**
 * Tests for POST /api/rednote (async job enqueue)
 */

jest.mock('@/lib/services/chrome-devtools-scrape', () => ({
    scrapeUrlBodyText: jest.fn().mockResolvedValue('Raw scraped article content here'),
}));

jest.mock('@/lib/rednote/run-rednote-job', () => ({
    runRednoteJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/rednote/v2ex-jobs-url-picker', () => ({
    pickFirstUnprocessedV2exJobsTopicUrl: jest.fn(),
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
import { pickFirstUnprocessedV2exJobsTopicUrl } from '@/lib/rednote/v2ex-jobs-url-picker';

function makeRequest(body: Record<string, unknown>, options?: { emptyBody?: boolean }): Request {
    if (options?.emptyBody) {
        return {
            text: () => Promise.resolve(''),
        } as unknown as Request;
    }
    return {
        text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Request;
}

describe('POST /api/rednote', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 400 when url is missing and V2EX picker finds no new topic', async () => {
        (pickFirstUnprocessedV2exJobsTopicUrl as jest.Mock).mockResolvedValueOnce(null);
        const req = makeRequest({});
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/No V2EX jobs topic URL available/i);
        expect(pickFirstUnprocessedV2exJobsTopicUrl).toHaveBeenCalled();
    });

    it('returns 202 when url is missing and V2EX picker returns a topic url', async () => {
        const v2exTopic = 'https://www.v2ex.com/t/1204991';
        (pickFirstUnprocessedV2exJobsTopicUrl as jest.Mock).mockResolvedValueOnce(v2exTopic);
        const req = makeRequest({});
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.jobId).toBe('test-job-id');
        expect(createRednoteJob).toHaveBeenCalledWith(v2exTopic);
        expect(runRednoteJob).toHaveBeenCalledWith('test-job-id', v2exTopic);
    });

    it('returns 202 with jobId and schedules runRednoteJob (Chrome DevTools MCP scrape in worker path)', async () => {
        const req = makeRequest({ url: 'https://example.com/article' });
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.jobId).toBe('test-job-id');
        expect(createRednoteJob).toHaveBeenCalledWith('https://example.com/article');
        expect(runRednoteJob).toHaveBeenCalledWith('test-job-id', 'https://example.com/article');
        expect(pickFirstUnprocessedV2exJobsTopicUrl).not.toHaveBeenCalled();
    });

    it('treats empty body like curl without -d as {} and can enqueue via V2EX picker', async () => {
        const v2exTopic = 'https://www.v2ex.com/t/1';
        (pickFirstUnprocessedV2exJobsTopicUrl as jest.Mock).mockResolvedValueOnce(v2exTopic);
        const req = makeRequest({}, { emptyBody: true });
        const res = await POST(req);
        expect(res.status).toBe(202);
        expect(pickFirstUnprocessedV2exJobsTopicUrl).toHaveBeenCalled();
        expect(createRednoteJob).toHaveBeenCalledWith(v2exTopic);
    });

    it('returns 400 for malformed JSON body', async () => {
        const req = {
            text: () => Promise.resolve('{not-json'),
        } as unknown as Request;
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/Invalid JSON body/i);
    });
});
