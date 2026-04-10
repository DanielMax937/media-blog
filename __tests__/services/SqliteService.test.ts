/**
 * Tests for SqliteService — uses an in-memory SQLite database to avoid
 * touching the real on-disk DB.
 */

import Database from 'better-sqlite3';

// We need to intercept the DB path before the module initialises it.
// Strategy: mock 'better-sqlite3' to capture the constructor call, then
// return a real in-memory DB so the SQL works properly.

let _inMemoryDb: Database.Database;

jest.mock('better-sqlite3', () => {
    // Return an in-memory instance regardless of the path argument
    // eslint-disable-next-line no-var
    var BetterSqlite3 = jest.fn().mockImplementation(() => {
        _inMemoryDb = new (jest.requireActual('better-sqlite3'))(':memory:');
        return _inMemoryDb;
    });
    return BetterSqlite3;
});

// Silence fs.mkdirSync calls for the data directory
jest.mock('fs', () => {
    const real = jest.requireActual<typeof import('fs')>('fs');
    return {
        ...real,
        existsSync: jest.fn().mockReturnValue(true),
        mkdirSync: jest.fn(),
    };
});

import {
    logGeneration,
    getAllLogs,
    getLogsBySourceUrl,
    hasGenerationLogForSourceUrl,
    closeDb,
    createRednoteJob,
    updateRednoteJob,
    getRednoteJob,
    claimNextQueuedRednoteJob,
} from '../../lib/services/SqliteService';

describe('SqliteService', () => {
    afterEach(() => {
        closeDb();
        // Reset the in-memory DB by re-creating it on next getDb() call
    });

    describe('logGeneration', () => {
        it('inserts a row and returns a numeric id', () => {
            const id = logGeneration('https://example.com', 'https://cdn.example.com/post.md', ['https://cdn.example.com/img1.png'], 'rednote');
            expect(typeof id).toBe('number');
            expect(id).toBeGreaterThan(0);
        });

        it('stores source_url and md_url correctly', () => {
            logGeneration('https://test.com/article', 'https://bitstripe.cn/files/a.md', [], 'rednote');
            const logs = getAllLogs();
            expect(logs.length).toBeGreaterThanOrEqual(1);
            const row = logs.find(l => l.source_url === 'https://test.com/article');
            expect(row).toBeDefined();
            expect(row?.md_url).toBe('https://bitstripe.cn/files/a.md');
        });

        it('serialises image_urls as JSON string', () => {
            const images = ['https://cdn.example.com/img1.png', 'https://cdn.example.com/img2.png'];
            logGeneration('https://img.test', 'https://bitstripe.cn/files/b.md', images, 'medium');
            const logs = getAllLogs();
            const row = logs.find(l => l.source_url === 'https://img.test');
            expect(row).toBeDefined();
            expect(JSON.parse(row!.image_urls)).toEqual(images);
        });

        it('stores empty image_urls as empty JSON array', () => {
            logGeneration('https://empty.test', 'https://bitstripe.cn/files/c.md', [], 'medium');
            const logs = getAllLogs();
            const row = logs.find(l => l.source_url === 'https://empty.test');
            expect(JSON.parse(row!.image_urls)).toEqual([]);
        });

        it('stores platform correctly', () => {
            logGeneration('https://platform.test/1', 'https://bitstripe.cn/files/p1.md', [], 'rednote');
            logGeneration('https://platform.test/2', 'https://bitstripe.cn/files/p2.md', [], 'medium');
            const logs = getAllLogs();
            const r = logs.find(l => l.source_url === 'https://platform.test/1');
            const m = logs.find(l => l.source_url === 'https://platform.test/2');
            expect(r?.platform).toBe('rednote');
            expect(m?.platform).toBe('medium');
        });
    });

    describe('getAllLogs', () => {
        it('returns rows in descending id order', () => {
            logGeneration('https://a.com', 'https://bitstripe.cn/files/a.md', [], 'rednote');
            logGeneration('https://b.com', 'https://bitstripe.cn/files/b.md', [], 'medium');
            const logs = getAllLogs();
            expect(logs.length).toBeGreaterThanOrEqual(2);
            // Newest first
            expect(logs[0].id! >= logs[1].id!).toBe(true);
        });
    });

    describe('getLogsBySourceUrl', () => {
        it('returns only rows matching the given source URL', () => {
            logGeneration('https://filter.com', 'https://bitstripe.cn/files/f.md', [], 'rednote');
            logGeneration('https://other.com', 'https://bitstripe.cn/files/o.md', [], 'medium');
            const logs = getLogsBySourceUrl('https://filter.com');
            expect(logs.every(l => l.source_url === 'https://filter.com')).toBe(true);
        });

        it('returns empty array when no matching rows', () => {
            const logs = getLogsBySourceUrl('https://nowhere.example');
            expect(logs).toEqual([]);
        });
    });

    describe('hasGenerationLogForSourceUrl', () => {
        it('returns false when no log exists for URL + platform', () => {
            expect(hasGenerationLogForSourceUrl('https://missing.example/t/1', 'rednote')).toBe(false);
        });

        it('returns true after logGeneration for matching source_url + platform', () => {
            logGeneration('https://seen.example/t/2', 'https://bitstripe.cn/files/x.md', [], 'rednote');
            expect(hasGenerationLogForSourceUrl('https://seen.example/t/2', 'rednote')).toBe(true);
        });

        it('returns false for the same URL on a different platform', () => {
            logGeneration('https://cross.example/t/3', 'https://bitstripe.cn/files/y.md', [], 'rednote');
            // Rednote done but medium not yet
            expect(hasGenerationLogForSourceUrl('https://cross.example/t/3', 'medium')).toBe(false);
        });

        it('allows the same URL to be logged for both platforms independently', () => {
            logGeneration('https://both.example/t/4', 'https://bitstripe.cn/files/r.md', [], 'rednote');
            logGeneration('https://both.example/t/4', 'https://bitstripe.cn/files/m.md', [], 'medium');
            expect(hasGenerationLogForSourceUrl('https://both.example/t/4', 'rednote')).toBe(true);
            expect(hasGenerationLogForSourceUrl('https://both.example/t/4', 'medium')).toBe(true);
        });
    });

    describe('rednote_job', () => {
        it('createRednoteJob inserts queued row and returns id', () => {
            const id = createRednoteJob('https://rednote.example/p');
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(10);
            const row = getRednoteJob(id);
            expect(row).toBeDefined();
            expect(row?.source_url).toBe('https://rednote.example/p');
            expect(row?.status).toBe('queued');
        });

        it('updateRednoteJob and getRednoteJob round-trip', () => {
            const id = createRednoteJob('https://x.com');
            updateRednoteJob(id, {
                status: 'completed',
                md_url: 'https://md',
                image_urls: JSON.stringify(['https://img']),
                generation_log_id: 3,
                error: null,
            });
            const row = getRednoteJob(id);
            expect(row?.status).toBe('completed');
            expect(row?.md_url).toBe('https://md');
            expect(JSON.parse(row!.image_urls!)).toEqual(['https://img']);
            expect(row?.generation_log_id).toBe(3);
        });

        it('claimNextQueuedRednoteJob takes oldest queued and sets processing', () => {
            const a = createRednoteJob('https://older.example');
            const b = createRednoteJob('https://newer.example');
            expect(getRednoteJob(a)?.status).toBe('queued');
            expect(getRednoteJob(b)?.status).toBe('queued');
            const first = claimNextQueuedRednoteJob();
            expect(first?.jobId).toBe(a);
            expect(getRednoteJob(a)?.status).toBe('processing');
            const second = claimNextQueuedRednoteJob();
            expect(second?.jobId).toBe(b);
            expect(getRednoteJob(b)?.status).toBe('processing');
            expect(claimNextQueuedRednoteJob()).toBeNull();
        });
    });
});
