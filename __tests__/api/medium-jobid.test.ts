/**
 * Tests for GET /api/medium/[jobId]
 */

jest.mock('@/lib/services/SqliteService', () => ({
    getMediumJob: jest.fn(),
}));

import { GET } from '../../app/api/medium/[jobId]/route';
import { getMediumJob } from '@/lib/services/SqliteService';

function makeContext(jobId: string) {
    return { params: Promise.resolve({ jobId }) };
}

describe('GET /api/medium/[jobId]', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 404 when job is unknown', async () => {
        (getMediumJob as jest.Mock).mockReturnValue(null);
        const res = await GET({} as Request, makeContext('missing-id'));
        expect(res.status).toBe(404);
    });

    it('returns job payload with urls when completed', async () => {
        (getMediumJob as jest.Mock).mockReturnValue({
            job_id: 'j1',
            source_url: 'https://www.zhangxinxu.com/',
            status: 'completed',
            error: null,
            md_url: 'https://cdn/md.md',
            image_urls: JSON.stringify(['https://cdn/cover.png']),
            generation_log_id: 7,
            created_at: 't0',
            updated_at: 't1',
        });
        const res = await GET({} as Request, makeContext('j1'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('completed');
        expect(data.urls).toEqual(['https://cdn/md.md', 'https://cdn/cover.png']);
        expect(data.imageUrls).toEqual(['https://cdn/cover.png']);
        expect(data.generationLogId).toBe(7);
        expect(data.sourceUrl).toBe('https://www.zhangxinxu.com/');
    });

    it('returns urls null when processing', async () => {
        (getMediumJob as jest.Mock).mockReturnValue({
            job_id: 'j2',
            source_url: 'https://www.zhangxinxu.com/',
            status: 'processing',
            error: null,
            md_url: null,
            image_urls: null,
            generation_log_id: null,
            created_at: 't0',
            updated_at: 't1',
        });
        const res = await GET({} as Request, makeContext('j2'));
        const data = await res.json();
        expect(data.status).toBe('processing');
        expect(data.urls).toBeNull();
        expect(data.imageUrls).toBeNull();
    });

    it('returns urls null when failed', async () => {
        (getMediumJob as jest.Mock).mockReturnValue({
            job_id: 'j3',
            source_url: 'https://example.com',
            status: 'failed',
            error: 'Scrape failed',
            md_url: null,
            image_urls: null,
            generation_log_id: null,
            created_at: 't0',
            updated_at: 't1',
        });
        const res = await GET({} as Request, makeContext('j3'));
        const data = await res.json();
        expect(data.status).toBe('failed');
        expect(data.error).toBe('Scrape failed');
        expect(data.urls).toBeNull();
    });

    it('handles malformed image_urls JSON gracefully', async () => {
        (getMediumJob as jest.Mock).mockReturnValue({
            job_id: 'j4',
            source_url: 'https://example.com',
            status: 'completed',
            error: null,
            md_url: 'https://cdn/md.md',
            image_urls: 'NOT_JSON',
            generation_log_id: 1,
            created_at: 't0',
            updated_at: 't1',
        });
        const res = await GET({} as Request, makeContext('j4'));
        const data = await res.json();
        expect(data.status).toBe('completed');
        expect(data.imageUrls).toEqual([]);
    });
});
