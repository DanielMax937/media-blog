import fs from 'fs';
import type { LaunchOptions } from 'playwright';

const CHROME_EXECUTABLE_CANDIDATES = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));

export function getChromiumLaunchOptions(headless: boolean): LaunchOptions {
    const executablePath = CHROME_EXECUTABLE_CANDIDATES.find(candidate => fs.existsSync(candidate));
    return executablePath ? { headless, executablePath } : { headless };
}
