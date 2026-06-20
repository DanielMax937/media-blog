import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'blog2media.db');

// JSONL mirror of generation_log inserts.
// External monitoring (e.g. cron health-check) reads this file instead of
// hitting the live SQLite DB, which avoids WAL/SHM lock contention with the
// long-running next-server process.
// Override path with BLOG2MEDIA_GENERATION_LOG_FILE if needed (used in tests).
const GENERATION_LOG_FILE =
    process.env.BLOG2MEDIA_GENERATION_LOG_FILE ?? path.join(DB_DIR, 'generation-log.jsonl');

export type GenerationPlatform = 'rednote' | 'medium' | 'futures';

/** One generation run logged to SQLite. */
export interface GenerationLog {
    id?: number;
    source_url: string;
    platform: GenerationPlatform;
    md_url: string;
    /** JSON-serialized string[] */
    image_urls: string;
    created_at?: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
    if (_db) return _db;

    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }

    _db = new Database(DB_PATH);

    // Enable WAL for better concurrent read performance
    _db.pragma('journal_mode = WAL');

    // Auto-checkpoint every 100 pages to prevent WAL file from growing unbounded.
    // Without this, the WAL file can balloon to several MBs over weeks of uptime,
    // which causes external sqlite3 CLI readers (e.g. cron health-checks) to
    // race / time out under lock contention. 100 pages ≈ 400KB, a good balance
    // between checkpoint frequency and write amplification.
    _db.pragma('wal_autocheckpoint = 100');

    // Run a TRUNCATE checkpoint at startup to reset any oversized WAL left
    // behind by a previous process / crash.
    try {
        _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
        // Best-effort; ignore if another process is mid-write.
    }

    // Make sure the WAL is flushed on graceful shutdown so no unflushed pages
    // are left in the WAL file when the process exits.
    const closeOnExit = () => {
        try {
            if (_db && _db.open) {
                _db.pragma('wal_checkpoint(TRUNCATE)');
                _db.close();
            }
        } catch {
            // Ignore — process is going down anyway.
        }
    };
    process.once('SIGINT', closeOnExit);
    process.once('SIGTERM', closeOnExit);
    process.once('beforeExit', closeOnExit);

    _db.exec(`
        CREATE TABLE IF NOT EXISTS generation_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_url  TEXT    NOT NULL,
            platform    TEXT    NOT NULL DEFAULT 'rednote',
            md_url      TEXT    NOT NULL,
            image_urls  TEXT    NOT NULL DEFAULT '[]',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    `);

    // Migration: add platform column to pre-existing databases (ignored if already present)
    try {
        _db.exec(`ALTER TABLE generation_log ADD COLUMN platform TEXT NOT NULL DEFAULT 'rednote'`);
    } catch {
        // Column already exists — safe to ignore
    }

    _db.exec(`
        CREATE TABLE IF NOT EXISTS rednote_job (
            job_id              TEXT PRIMARY KEY,
            source_url          TEXT    NOT NULL,
            status              TEXT    NOT NULL,
            error               TEXT,
            md_url              TEXT,
            image_urls          TEXT,
            generation_log_id   INTEGER,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    `);

    _db.exec(`
        CREATE TABLE IF NOT EXISTS medium_job (
            job_id              TEXT PRIMARY KEY,
            source_url          TEXT    NOT NULL,
            status              TEXT    NOT NULL,
            error               TEXT,
            md_url              TEXT,
            image_urls          TEXT,
            generation_log_id   INTEGER,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    `);

    _db.exec(`
        CREATE TABLE IF NOT EXISTS futures_job (
            job_id              TEXT PRIMARY KEY,
            source_url          TEXT    NOT NULL,
            status              TEXT    NOT NULL,
            error               TEXT,
            md_url              TEXT,
            image_urls          TEXT,
            generation_log_id   INTEGER,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    `);

    return _db;
}

/**
 * Insert one generation run into the log table.
 * @param sourceUrl  The original source page URL the user submitted
 * @param mdUrl      The bitstripe public URL of the uploaded .md file
 * @param imageUrls  List of artifact image URLs (XHS slides / cover / GIFs)
 * @param platform   Which platform generated this output ('rednote' | 'medium' | 'futures')
 * @returns The inserted row id
 */
export function logGeneration(
    sourceUrl: string,
    mdUrl: string,
    imageUrls: string[],
    platform: GenerationPlatform = 'rednote'
): number {
    const db = getDb();
    const stmt = db.prepare(
        'INSERT INTO generation_log (source_url, platform, md_url, image_urls) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(sourceUrl, platform, mdUrl, JSON.stringify(imageUrls));
    const id = result.lastInsertRowid as number;
    appendGenerationLogFile({ id, source_url: sourceUrl, platform, md_url: mdUrl, image_urls: imageUrls });
    return id;
}

/**
 * Append one JSONL line to the generation-log mirror file.
 *
 * Fields match `generation_log` row semantics, plus `created_at` in
 * Asia/Shanghai (UTC+8) for easier `date(...) = today` matching in shell.
 *
 * Errors are swallowed: monitoring is best-effort and must never break the
 * primary DB write path.
 */
function appendGenerationLogFile(entry: {
    id: number;
    source_url: string;
    platform: GenerationPlatform;
    md_url: string;
    image_urls: string[];
}): void {
    try {
        if (!fs.existsSync(DB_DIR)) {
            fs.mkdirSync(DB_DIR, { recursive: true });
        }
        // Asia/Shanghai (UTC+8) ISO timestamp for easy day-bucketing in
        // shell scripts: `date(created_at_cst, 'start of day')` style.
        const cst = new Date(Date.now() + 8 * 60 * 60 * 1000)
            .toISOString()
            .replace('Z', '+08:00');
        const line = JSON.stringify({
            id: entry.id,
            platform: entry.platform,
            source_url: entry.source_url,
            md_url: entry.md_url,
            image_urls: entry.image_urls,
            created_at_cst: cst,
        }) + '\n';
        fs.appendFileSync(GENERATION_LOG_FILE, line, { encoding: 'utf8' });
    } catch (err) {
        // Never fail the primary write; just emit a console warning so it
        // shows up in blog2media.log without breaking the job.
        // eslint-disable-next-line no-console
        console.warn('[generation-log mirror] append failed:', err);
    }
}

/**
 * Fetch all generation logs (newest first). Useful for debugging / admin.
 */
export function getAllLogs(): GenerationLog[] {
    const db = getDb();
    return db
        .prepare('SELECT * FROM generation_log ORDER BY id DESC')
        .all() as GenerationLog[];
}

/**
 * Fetch generation logs for a specific source URL.
 */
export function getLogsBySourceUrl(sourceUrl: string): GenerationLog[] {
    const db = getDb();
    return db
        .prepare('SELECT * FROM generation_log WHERE source_url = ? ORDER BY id DESC')
        .all(sourceUrl) as GenerationLog[];
}

/**
 * Fetch generation logs for a calendar date in Asia/Shanghai (CST, UTC+8).
 *
 * The DB stores `created_at` as UTC via `datetime('now')`.  To map a CST
 * calendar day to the correct UTC range we add the +8 h offset:
 *   CST day [D 00:00, D+1 00:00) → UTC [D-8h, D+16h)
 *
 * Returns rows grouped by platform with their md_url values.
 */
export function getLogsByDate(dateCst: string): {
    platform: GenerationPlatform;
    md_url: string;
}[] {
    const db = getDb();
    return db
        .prepare(
            `SELECT platform, md_url
             FROM generation_log
             WHERE created_at >= datetime(?, '-8 hours')
               AND created_at <  datetime(?, '+16 hours')
               AND md_url != ''
             ORDER BY platform, id`
        )
        .all(dateCst, dateCst) as { platform: GenerationPlatform; md_url: string }[];
}

/** True if `generation_log` already has at least one row for this source URL + platform. */
export function hasGenerationLogForSourceUrl(sourceUrl: string, platform: GenerationPlatform): boolean {
    const db = getDb();
    const row = db
        .prepare('SELECT 1 AS ok FROM generation_log WHERE source_url = ? AND platform = ? LIMIT 1')
        .get(sourceUrl, platform) as { ok: number } | undefined;
    return row != null;
}

/** Close the DB connection (useful in tests). */
export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

// ---------------------------------------------------------------------------
// Async Rednote jobs
// ---------------------------------------------------------------------------

export type RednoteJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface RednoteJobRecord {
    job_id: string;
    source_url: string;
    status: RednoteJobStatus;
    error: string | null;
    md_url: string | null;
    /** JSON array string; null until completed */
    image_urls: string | null;
    generation_log_id: number | null;
    created_at: string;
    updated_at: string;
}

/**
 * Create a queued Rednote job and return its opaque id (use with GET /api/rednote/[jobId]).
 */
export function createRednoteJob(sourceUrl: string): string {
    const db = getDb();
    const jobId = randomUUID();
    db.prepare(
        `INSERT INTO rednote_job (job_id, source_url, status) VALUES (?, ?, 'queued')`
    ).run(jobId, sourceUrl);
    return jobId;
}

export type RednoteJobPatch = {
    status?: RednoteJobStatus;
    error?: string | null;
    md_url?: string | null;
    image_urls?: string | null;
    generation_log_id?: number | null;
};

export function updateRednoteJob(jobId: string, patch: RednoteJobPatch): void {
    const db = getDb();
    const cols: string[] = ['updated_at = datetime(\'now\')'];
    const values: (string | number | null)[] = [];

    if (patch.status !== undefined) {
        cols.push('status = ?');
        values.push(patch.status);
    }
    if (patch.error !== undefined) {
        cols.push('error = ?');
        values.push(patch.error);
    }
    if (patch.md_url !== undefined) {
        cols.push('md_url = ?');
        values.push(patch.md_url);
    }
    if (patch.image_urls !== undefined) {
        cols.push('image_urls = ?');
        values.push(patch.image_urls);
    }
    if (patch.generation_log_id !== undefined) {
        cols.push('generation_log_id = ?');
        values.push(patch.generation_log_id);
    }

    values.push(jobId);
    db.prepare(`UPDATE rednote_job SET ${cols.join(', ')} WHERE job_id = ?`).run(...values);
}

export function getRednoteJob(jobId: string): RednoteJobRecord | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rednote_job WHERE job_id = ?').get(jobId) as
        | RednoteJobRecord
        | undefined;
    return row ?? null;
}

/**
 * Atomically pick the oldest queued job and mark it `processing`.
 * Safe for multiple worker OS processes (BEGIN IMMEDIATE + single-row update).
 */
export function claimNextQueuedRednoteJob(): { jobId: string; sourceUrl: string } | null {
    const db = getDb();
    return db.transaction(() => {
        const row = db
            .prepare(
                `SELECT job_id, source_url FROM rednote_job WHERE status = 'queued' ORDER BY datetime(created_at) ASC LIMIT 1`
            )
            .get() as { job_id: string; source_url: string } | undefined;
        if (!row) return null;
        const r = db
            .prepare(
                `UPDATE rednote_job SET status = 'processing', updated_at = datetime('now') WHERE job_id = ? AND status = 'queued'`
            )
            .run(row.job_id);
        if (r.changes !== 1) return null;
        return { jobId: row.job_id, sourceUrl: row.source_url };
    })();
}

// ---------------------------------------------------------------------------
// Async Medium jobs
// ---------------------------------------------------------------------------

export type MediumJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface MediumJobRecord {
    job_id: string;
    source_url: string;
    status: MediumJobStatus;
    error: string | null;
    md_url: string | null;
    /** JSON array string; null until completed */
    image_urls: string | null;
    generation_log_id: number | null;
    created_at: string;
    updated_at: string;
}

/** Create a queued Medium job and return its opaque id (use with GET /api/medium/[jobId]). */
export function createMediumJob(sourceUrl: string): string {
    const db = getDb();
    const jobId = randomUUID();
    db.prepare(
        `INSERT INTO medium_job (job_id, source_url, status) VALUES (?, ?, 'queued')`
    ).run(jobId, sourceUrl);
    return jobId;
}

export type MediumJobPatch = {
    status?: MediumJobStatus;
    error?: string | null;
    md_url?: string | null;
    image_urls?: string | null;
    generation_log_id?: number | null;
};

export function updateMediumJob(jobId: string, patch: MediumJobPatch): void {
    const db = getDb();
    const cols: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    if (patch.status !== undefined) { cols.push('status = ?'); values.push(patch.status); }
    if (patch.error !== undefined) { cols.push('error = ?'); values.push(patch.error); }
    if (patch.md_url !== undefined) { cols.push('md_url = ?'); values.push(patch.md_url); }
    if (patch.image_urls !== undefined) { cols.push('image_urls = ?'); values.push(patch.image_urls); }
    if (patch.generation_log_id !== undefined) { cols.push('generation_log_id = ?'); values.push(patch.generation_log_id); }

    values.push(jobId);
    db.prepare(`UPDATE medium_job SET ${cols.join(', ')} WHERE job_id = ?`).run(...values);
}

export function getMediumJob(jobId: string): MediumJobRecord | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM medium_job WHERE job_id = ?').get(jobId) as
        | MediumJobRecord
        | undefined;
    return row ?? null;
}

// ---------------------------------------------------------------------------
// Async futures jobs (bitstripe overview → webgemini deepresearch → MD + cover)
// ---------------------------------------------------------------------------

export type FuturesJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface FuturesJobRecord {
    job_id: string;
    source_url: string;
    status: FuturesJobStatus;
    error: string | null;
    md_url: string | null;
    image_urls: string | null;
    generation_log_id: number | null;
    created_at: string;
    updated_at: string;
}

/** Create a queued futures job and return its opaque id (use with GET /api/futures/[jobId]). */
export function createFuturesJob(sourceUrl: string): string {
    const db = getDb();
    const jobId = randomUUID();
    db.prepare(
        `INSERT INTO futures_job (job_id, source_url, status) VALUES (?, ?, 'queued')`
    ).run(jobId, sourceUrl);
    return jobId;
}

export type FuturesJobPatch = {
    status?: FuturesJobStatus;
    error?: string | null;
    md_url?: string | null;
    image_urls?: string | null;
    generation_log_id?: number | null;
};

export function updateFuturesJob(jobId: string, patch: FuturesJobPatch): void {
    const db = getDb();
    const cols: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    if (patch.status !== undefined) { cols.push('status = ?'); values.push(patch.status); }
    if (patch.error !== undefined) { cols.push('error = ?'); values.push(patch.error); }
    if (patch.md_url !== undefined) { cols.push('md_url = ?'); values.push(patch.md_url); }
    if (patch.image_urls !== undefined) { cols.push('image_urls = ?'); values.push(patch.image_urls); }
    if (patch.generation_log_id !== undefined) { cols.push('generation_log_id = ?'); values.push(patch.generation_log_id); }

    values.push(jobId);
    db.prepare(`UPDATE futures_job SET ${cols.join(', ')} WHERE job_id = ?`).run(...values);
}

export function getFuturesJob(jobId: string): FuturesJobRecord | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM futures_job WHERE job_id = ?').get(jobId) as
        | FuturesJobRecord
        | undefined;
    return row ?? null;
}
