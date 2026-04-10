import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { logApi, logApiError } from './api-logger';

const execAsync = promisify(exec);

const UPLOAD_SCRIPT = `${process.env.HOME}/.cursor/skills/bitstripe-uploader/scripts/upload.sh`;
const URL_PREFIX = process.env.BITSTRIPE_URL_PREFIX ?? 'https://www.bitstripe.cn/files/';

/**
 * Uploads a local file to BitStripe via the upload.sh scp script.
 * Returns the public HTTPS URL for the uploaded file.
 */
export async function uploadToBitstripe(localFilePath: string): Promise<string> {
    const t0 = Date.now();
    const base = path.basename(localFilePath);
    logApi('bitstripe', 'uploadToBitstripe start', { file: base });
    try {
        const { stdout, stderr } = await execAsync(`bash "${UPLOAD_SCRIPT}" "${localFilePath}"`);
        if (stderr) {
            console.warn('[BitstripeUploader] stderr:', stderr.trim());
        }
        const url = stdout.trim();
        if (!url.startsWith(URL_PREFIX)) {
            throw new Error(`Unexpected upload output: ${url}`);
        }
        logApi('bitstripe', 'uploadToBitstripe ok', {
            file: base,
            durationMs: Date.now() - t0,
            urlPrefix: url.slice(0, 48),
        });
        return url;
    } catch (err) {
        logApiError('bitstripe', 'uploadToBitstripe failed', err, {
            file: base,
            durationMs: Date.now() - t0,
        });
        throw err;
    }
}
