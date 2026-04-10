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
            const id = logGeneration('https://example.com', 'https://cdn.example.com/post.md', ['https://cdn.example.com/img1.png']);
            expect(typeof id).toBe('number');
            expect(id).toBeGreaterThan(0);
        });

        it('stores source_url and md_url correctly', () => {
            logGeneration('https://test.com/article', 'https://bitstripe.cn/files/a.md', []);
            const logs = getAllLogs();
            expect(logs.length).toBeGreaterThanOrEqual(1);
            const row = logs.find(l => l.source_url === 'https://test.com/article');
            expect(row).toBeDefined();
            expect(row?.md_url).toBe('https://bitstripe.cn/files/a.md');
        });

        it('serialises image_urls as JSON string', () => {
            const images = ['https://cdn.example.com/img1.png', 'https://cdn.example.com/img2.png'];
            logGeneration('https://img.test', 'https://bitstripe.cn/files/b.md', images);
            const logs = getAllLogs();
            const row = logs.find(l => l.source_url === 'https://img.test');
            expect(row).toBeDefined();
            expect(JSON.parse(row!.image_urls)).toEqual(images);
        });

        it('stores empty image_urls as empty JSON array', () => {
            logGeneration('https://empty.test', 'https://bitstripe.cn/files/c.md', []);
            const logs = getAllLogs();
            const row = logs.find(l => l.source_url === 'https://empty.test');
            expect(JSON.parse(row!.image_urls)).toEqual([]);
        });
    });

    describe('getAllLogs', () => {
        it('returns rows in descending id order', () => {
            logGeneration('https://a.com', 'https://bitstripe.cn/files/a.md', []);
            logGeneration('https://b.com', 'https://bitstripe.cn/files/b.md', []);
            const logs = getAllLogs();
            expect(logs.length).toBeGreaterThanOrEqual(2);
            // Newest first
            expect(logs[0].id! >= logs[1].id!).toBe(true);
        });
    });

    describe('getLogsBySourceUrl', () => {
        it('returns only rows matching the given source URL', () => {
            logGeneration('https://filter.com', 'https://bitstripe.cn/files/f.md', []);
            logGeneration('https://other.com', 'https://bitstripe.cn/files/o.md', []);
            const logs = getLogsBySourceUrl('https://filter.com');
            expect(logs.every(l => l.source_url === 'https://filter.com')).toBe(true);
        });

        it('returns empty array when no matching rows', () => {
            const logs = getLogsBySourceUrl('https://nowhere.example');
            expect(logs).toEqual([]);
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
