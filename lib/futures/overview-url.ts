/**
 * Overview HTML on BitStripe uses calendar date in Asia/Shanghai: `{YYYYMMDD}_overview.html`.
 */
const BITSTRIPE_FILES_BASE = 'https://www.bitstripe.cn/files';

export function formatYmdShanghai(d: Date): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}${m}${day}`;
}

/** Parse `YYYYMMDD` → same compact form (validates length and digits). */
export function parseYmdCompact(raw: string): string {
    const s = raw.trim();
    if (!/^\d{8}$/.test(s)) {
        throw new Error('date must be YYYYMMDD (8 digits)');
    }
    return s;
}

export function buildOverviewPageUrl(ymd: string): string {
    return `${BITSTRIPE_FILES_BASE}/${ymd}_overview.html`;
}
