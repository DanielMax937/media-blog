/**
 * Tests for the JSONL mirror file written alongside `generation_log` rows.
 * The mirror exists so external readers (e.g. the daily cron health-check
 * shell script) can avoid contending with the live SQLite WAL.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Same in-memory mock as SqliteService.test.ts so SQL writes still work.
let _inMemoryDb: Database.Database;
jest.mock('better-sqlite3', () => {
    // eslint-disable-next-line no-var
    var BetterSqlite3 = jest.fn().mockImplementation(() => {
        _inMemoryDb = new (jest.requireActual('better-sqlite3'))(':memory:');
        return _inMemoryDb;
    });
    return BetterSqlite3;
});

// Real fs is used here (no mock) so we can assert on actual file contents.
// The mirror path is overridden via env var below.

let mirrorFile: string;
// Captured at runtime via require() so env override above takes effect.
type SqliteServiceModule = typeof import('../../lib/services/SqliteService');
let logGeneration: SqliteServiceModule['logGeneration'];
let closeDb: SqliteServiceModule['closeDb'];

beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog2media-mirror-'));
    mirrorFile = path.join(tmpDir, 'generation-log.jsonl');
    process.env.BLOG2MEDIA_GENERATION_LOG_FILE = mirrorFile;

    // Require AFTER the env var is set so the module-level constant captures
    // the override path (otherwise it would default to ${cwd}/data/...).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../lib/services/SqliteService') as SqliteServiceModule;
    logGeneration = mod.logGeneration;
    closeDb = mod.closeDb;
});

afterAll(() => {
    delete process.env.BLOG2MEDIA_GENERATION_LOG_FILE;
});

describe('logGeneration mirror file', () => {
    afterEach(() => {
        closeDb();
        if (fs.existsSync(mirrorFile)) {
            fs.unlinkSync(mirrorFile);
        }
    });

    function readMirrorLines(): Array<Record<string, unknown>> {
        const txt = fs.readFileSync(mirrorFile, 'utf8');
        return txt
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l));
    }

    it('appends one JSONL line per logGeneration call', () => {
        const id = logGeneration(
            'https://example.com',
            'https://cdn.example.com/p.md',
            ['https://cdn.example.com/i.png'],
            'rednote'
        );
        const lines = readMirrorLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            id,
            platform: 'rednote',
            source_url: 'https://example.com',
            md_url: 'https://cdn.example.com/p.md',
            image_urls: ['https://cdn.example.com/i.png'],
        });
        expect(typeof lines[0].created_at_cst).toBe('string');
    });

    it('uses Asia/Shanghai timestamp suffix +08:00', () => {
        logGeneration('https://t', 'https://m', [], 'medium');
        const [row] = readMirrorLines();
        expect(row.created_at_cst).toMatch(/\+08:00$/);
    });

    it('records platform field for each row', () => {
        logGeneration('https://r', 'https://r.md', [], 'rednote');
        logGeneration('https://m', 'https://m.md', [], 'medium');
        logGeneration('https://f', 'https://f.md', [], 'futures');
        const platforms = readMirrorLines().map((r) => r.platform);
        expect(platforms).toEqual(['rednote', 'medium', 'futures']);
    });

    it('preserves image_urls as an array (not a JSON string)', () => {
        const imgs = ['https://a.png', 'https://b.png'];
        logGeneration('https://x', 'https://x.md', imgs, 'rednote');
        const [row] = readMirrorLines();
        expect(row.image_urls).toEqual(imgs);
    });

    it('appends across multiple calls without truncating', () => {
        logGeneration('https://1', 'https://1.md', [], 'rednote');
        logGeneration('https://2', 'https://2.md', [], 'rednote');
        logGeneration('https://3', 'https://3.md', [], 'medium');
        const lines = readMirrorLines();
        expect(lines.map((l) => l.source_url)).toEqual([
            'https://1',
            'https://2',
            'https://3',
        ]);
    });
});
