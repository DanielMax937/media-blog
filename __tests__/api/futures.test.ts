/**
 * Tests for POST /api/futures (async job enqueue)
 */

jest.mock('@/lib/futures/run-futures-job', () => ({
    runFuturesJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    createFuturesJob: jest.fn().mockReturnValue('test-futures-job-id'),
}));

import { POST } from '../../app/api/futures/route';
import { createFuturesJob } from '@/lib/services/SqliteService';
import { runFuturesJob } from '@/lib/futures/run-futures-job';

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

describe('POST /api/futures', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 202 with jobId and sourceUrl built from date', async () => {
        const req = makeRequest({ date: '20260323' });
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = (await res.json()) as Record<string, unknown>;
        expect(data.jobId).toBe('test-futures-job-id');
        expect(data.sourceUrl).toBe('https://www.bitstripe.cn/files/20260323_overview.html');
        expect(data.date).toBe('20260323');
        expect(createFuturesJob).toHaveBeenCalledWith('https://www.bitstripe.cn/files/20260323_overview.html');
        expect(runFuturesJob).toHaveBeenCalledWith(
            'test-futures-job-id',
            'https://www.bitstripe.cn/files/20260323_overview.html',
        );
    });

    it('returns 400 for invalid date format', async () => {
        const req = makeRequest({ date: '2026-03-23' });
        const res = await POST(req);
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error?: string };
        expect(data.error).toMatch(/YYYYMMDD/);
        expect(runFuturesJob).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed JSON body', async () => {
        const req = {
            text: () => Promise.resolve('{not-json'),
        } as unknown as Request;
        const res = await POST(req);
        expect(res.status).toBe(400);
    });

    it('accepts empty body and still enqueues (uses today Shanghai date)', async () => {
        const req = makeRequest({}, { emptyBody: true });
        const res = await POST(req);
        expect(res.status).toBe(202);
        const data = (await res.json()) as { date?: string; sourceUrl?: string };
        expect(data.date).toMatch(/^\d{8}$/);
        expect(data.sourceUrl).toMatch(/^https:\/\/www\.bitstripe\.cn\/files\/\d{8}_overview\.html$/);
        expect(runFuturesJob).toHaveBeenCalled();
    });
});
