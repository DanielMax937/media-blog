/**
 * Tests for POST /api/medium (async job enqueue)
 */

jest.mock('@/lib/medium/run-medium-job', () => ({
    runMediumJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    createMediumJob: jest.fn().mockReturnValue('test-medium-job-id'),
    logGeneration: jest.fn().mockReturnValue(1),
}));

jest.mock('@/lib/strategies/MediumStrategy', () => ({
    MediumStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: '# My Article\n\n![Cover](https://cdn.example.com/cover.png)\n\nSome text.',
        }),
    })),
}));

jest.mock('@/lib/services/BitstripeUploader', () => ({
    uploadToBitstripe: jest.fn().mockResolvedValue('https://www.bitstripe.cn/files/post.md'),
}));

jest.mock('@/lib/services/chrome-devtools-scrape', () => ({
    scrapeUrlBodyText: jest.fn().mockResolvedValue('Raw scraped article content here'),
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

import { POST } from '../../app/api/medium/route';
import { createMediumJob } from '@/lib/services/SqliteService';
import { runMediumJob } from '@/lib/medium/run-medium-job';

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

describe('POST /api/medium', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 202 with jobId when url is provided', async () => {
        const req = makeRequest({ url: 'https://example.com/article' });
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.jobId).toBe('test-medium-job-id');
        expect(createMediumJob).toHaveBeenCalledWith('https://example.com/article');
        expect(runMediumJob).toHaveBeenCalledWith('test-medium-job-id', 'https://example.com/article');
    });

    it('defaults to zhangxinxu.com when url is missing', async () => {
        const req = makeRequest({});
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.jobId).toBe('test-medium-job-id');
        expect(createMediumJob).toHaveBeenCalledWith('https://www.zhangxinxu.com/');
        expect(runMediumJob).toHaveBeenCalledWith('test-medium-job-id', 'https://www.zhangxinxu.com/');
    });

    it('defaults to zhangxinxu.com when empty body (curl -X POST without -d)', async () => {
        const req = makeRequest({}, { emptyBody: true });
        const res = await POST(req);
        expect(res.status).toBe(202);
        expect(createMediumJob).toHaveBeenCalledWith('https://www.zhangxinxu.com/');
    });

    it('defaults to zhangxinxu.com when url is empty string', async () => {
        const req = makeRequest({ url: '' });
        const res = await POST(req);
        expect(res.status).toBe(202);
        expect(createMediumJob).toHaveBeenCalledWith('https://www.zhangxinxu.com/');
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

    it('fires runMediumJob without awaiting (202 returned immediately)', async () => {
        let resolveJob!: () => void;
        (runMediumJob as jest.Mock).mockReturnValueOnce(
            new Promise<void>((resolve) => { resolveJob = resolve; })
        );
        const req = makeRequest({ url: 'https://slow.example.com' });
        const res = await POST(req);
        // Should return 202 before job finishes
        expect(res.status).toBe(202);
        resolveJob();
    });
});

