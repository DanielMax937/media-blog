import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'blog2media.db');

/** One generation run logged to SQLite. */
export interface GenerationLog {
    id?: number;
    source_url: string;
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

    _db.exec(`
        CREATE TABLE IF NOT EXISTS generation_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_url  TEXT    NOT NULL,
            md_url      TEXT    NOT NULL,
            image_urls  TEXT    NOT NULL DEFAULT '[]',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    `);

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

    return _db;
}

/**
 * Insert one generation run into the log table.
 * @param sourceUrl  The original source page URL the user submitted
 * @param mdUrl      The bitstripe public URL of the uploaded .md file
 * @param imageUrls  List of artifact image URLs (XHS slides / cover / GIFs)
 * @returns The inserted row id
 */
export function logGeneration(
    sourceUrl: string,
    mdUrl: string,
    imageUrls: string[]
): number {
    const db = getDb();
    const stmt = db.prepare(
        'INSERT INTO generation_log (source_url, md_url, image_urls) VALUES (?, ?, ?)'
    );
    const result = stmt.run(sourceUrl, mdUrl, JSON.stringify(imageUrls));
    return result.lastInsertRowid as number;
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

/** True if `generation_log` already has at least one row for this source URL (processed Rednote output). */
export function hasGenerationLogForSourceUrl(sourceUrl: string): boolean {
    const db = getDb();
    const row = db
        .prepare('SELECT 1 AS ok FROM generation_log WHERE source_url = ? LIMIT 1')
        .get(sourceUrl) as { ok: number } | undefined;
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
