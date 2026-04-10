/**
 * Tests for GET /api/rednote/[jobId]
 */

jest.mock('@/lib/services/SqliteService', () => ({
    getRednoteJob: jest.fn(),
}));

import { GET } from '../../app/api/rednote/[jobId]/route';
import { getRednoteJob } from '@/lib/services/SqliteService';

function makeContext(jobId: string) {
    return { params: Promise.resolve({ jobId }) };
}

describe('GET /api/rednote/[jobId]', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns 404 when job is unknown', async () => {
        (getRednoteJob as jest.Mock).mockReturnValue(null);
        const res = await GET({} as Request, makeContext('missing-id'));
        expect(res.status).toBe(404);
    });

    it('returns job payload with urls when completed', async () => {
        (getRednoteJob as jest.Mock).mockReturnValue({
            job_id: 'j1',
            source_url: 'https://a.com',
            status: 'completed',
            error: null,
            md_url: 'https://cdn/md.md',
            image_urls: JSON.stringify(['https://cdn/1.png']),
            generation_log_id: 7,
            created_at: 't0',
            updated_at: 't1',
        });
        const res = await GET({} as Request, makeContext('j1'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('completed');
        expect(data.urls).toEqual(['https://cdn/md.md', 'https://cdn/1.png']);
        expect(data.imageUrls).toEqual(['https://cdn/1.png']);
        expect(data.generationLogId).toBe(7);
    });

    it('returns urls null when processing', async () => {
        (getRednoteJob as jest.Mock).mockReturnValue({
            job_id: 'j2',
            source_url: 'https://b.com',
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
    });
});
