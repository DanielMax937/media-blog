import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { chatWithFallback } from '../llm-fallback';

// Resolve node_modules bundles using process.cwd() (compatible with both ESM and CJS/Jest)
const NODE_MODULES = path.join(process.cwd(), 'node_modules');
const RRWEB_RECORD_BUNDLE = path.join(NODE_MODULES, 'rrweb/dist/record/rrweb-record.js');
const RRWEB_PLAYER_BUNDLE = path.join(NODE_MODULES, 'rrweb-player/dist/index.js');
const RRWEB_PLAYER_CSS = path.join(NODE_MODULES, 'rrweb-player/dist/style.css');

/** A single interaction step the LLM plans for the demo. */
export interface InteractionStep {
    type: 'click' | 'fill' | 'hover' | 'wait' | 'scroll';
    /** CSS selector for the target element (not required for wait/scroll without target) */
    selector?: string;
    /** Text value for fill steps */
    value?: string;
    /** Duration in ms for wait steps */
    duration?: number;
    description: string;
}

/** Raw rrweb event shape (we only use timestamp for duration calc). */
interface RrwebEvent {
    timestamp: number;
    [key: string]: unknown;
}

/**
 * Ask the LLM to produce an ordered list of demo interaction steps
 * based on the article content and demo HTML.
 */
export async function planInteractionSteps(
    markdown: string,
    demoHtml: string,
    contextDescription: string,
    openai: OpenAI
): Promise<InteractionStep[]> {
    const systemPrompt = `You are a UX demo planner. Given an article section context and a demo HTML page,
produce a short sequence of browser interaction steps that will visually demonstrate the key concept
for that section. Return strict JSON only:
{
  "steps": [
    { "type": "wait", "duration": 800, "description": "Wait for page to load" },
    { "type": "click", "selector": "#btn", "description": "Click the demo button" },
    { "type": "fill", "selector": "input", "value": "Hello", "description": "Type text" },
    { "type": "hover", "selector": ".card", "description": "Hover over card" },
    { "type": "scroll", "description": "Scroll down to see result" }
  ]
}

Rules:
- 3-8 steps maximum
- Only use element IDs or simple class selectors that clearly exist in the HTML
- Prefer clicking/filling interactive elements (buttons, inputs, select, checkboxes)
- Always start with { "type": "wait", "duration": 800 }
- If unsure about selectors, use only generic scroll/wait steps
- Return ONLY the JSON, no markdown`;

    const htmlSnippet = demoHtml.substring(0, 4000);
    const markdownSnippet = markdown.substring(0, 2000);

    const model = process.env.OPENAI_MODEL ?? 'gpt-5.4';
    const t0 = Date.now();
    logApi('openai', 'DemoGifService.planInteractionSteps start', {
        model,
        markdownChars: markdown.length,
        demoHtmlChars: demoHtml.length,
    });
    try {
        const response = await chatWithFallback(openai, {
            model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `Demo section context: ${contextDescription}\n\nArticle excerpt:\n${markdownSnippet}\n\nDemo HTML:\n${htmlSnippet}`,
                },
            ],
        });

        const rawMsg = response.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('DemoGifService.planInteractionSteps', rawMsg.length, response);
        const raw = rawMsg || '{}';
        const parsed = JSON.parse(raw) as { steps?: InteractionStep[] };
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        logApi('openai', 'DemoGifService.planInteractionSteps ok', {
            model,
            durationMs: Date.now() - t0,
            stepCount: steps.length,
        });
        return steps;
    } catch (err) {
        console.warn('[DemoGifService] planInteractionSteps failed:', err);
        logApiError('openai', 'DemoGifService.planInteractionSteps failed', err, {
            model,
            durationMs: Date.now() - t0,
        });
        return [{ type: 'wait', duration: 1000, description: 'Wait for page' }];
    }
}

// ---------------------------------------------------------------------------
// Phase 1: Record rrweb events while executing interaction steps
// ---------------------------------------------------------------------------

/**
 * Execute a single interaction step on a Playwright page.
 * Returns true if the step completed without throwing.
 */
async function executeStep(
    page: import('playwright').Page,
    step: InteractionStep
): Promise<boolean> {
    try {
        switch (step.type) {
            case 'wait':
                await page.waitForTimeout(step.duration ?? 500);
                break;
            case 'click':
                if (step.selector) {
                    await page.click(step.selector, { timeout: 5000 }).catch(() => {
                        console.warn(`[DemoGifService] click "${step.selector}" not found, skipping`);
                    });
                }
                break;
            case 'fill':
                if (step.selector) {
                    await page.fill(step.selector, step.value ?? '', { timeout: 5000 }).catch(() => {
                        console.warn(`[DemoGifService] fill "${step.selector}" not found, skipping`);
                    });
                }
                break;
            case 'hover':
                if (step.selector) {
                    await page.hover(step.selector, { timeout: 5000 }).catch(() => {
                        console.warn(`[DemoGifService] hover "${step.selector}" not found, skipping`);
                    });
                }
                break;
            case 'scroll':
                if (step.selector) {
                    await page.locator(step.selector).scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                } else {
                    await page.evaluate(() => window.scrollBy(0, 300));
                }
                break;
        }
        // Brief settle time for animations
        await page.waitForTimeout(200);
        return true;
    } catch (err) {
        console.warn(`[DemoGifService] step "${step.description}" failed:`, err);
        return false;
    }
}

/**
 * Phase 1: Open demo file in headless Playwright, inject rrweb-record from
 * node_modules (no CDN dependency), execute interaction steps, and return the
 * captured rrweb events JSON string.
 *
 * Returns null if the recording produced no events (injection/CSP failure).
 */
export async function recordDemoSession(
    demoFilePath: string,
    steps: InteractionStep[]
): Promise<string | null> {
    let browser: import('playwright').Browser | null = null;

    try {
        const rrwebRecordJs = fs.readFileSync(RRWEB_RECORD_BUNDLE, 'utf-8');

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        const page = await context.newPage();

        await page.goto(`file://${demoFilePath}`, { waitUntil: 'networkidle', timeout: 15000 });

        // Inject rrweb-record inline from node_modules — no network required
        await page.evaluate(rrwebRecordJs);

        // Start recording
        const recordingStarted = await page.evaluate(() => {
            const rec = (window as unknown as Record<string, unknown>).rrwebRecord as
                | ((opts: { emit: (e: unknown) => void }) => () => void)
                | undefined;
            if (!rec) return false;
            (window as unknown as Record<string, unknown>)._rrwebEvents = [];
            (window as unknown as Record<string, unknown>)._rrwebStop = rec({
                emit: (event: unknown) => {
                    ((window as unknown as Record<string, unknown>)._rrwebEvents as unknown[]).push(event);
                },
            });
            return true;
        });

        if (!recordingStarted) {
            console.warn('[DemoGifService] rrweb-record could not start (rrwebRecord not in scope)');
            await browser.close();
            return null;
        }

        // Execute each interaction step (rrweb records all DOM changes)
        for (const step of steps) {
            await executeStep(page, step);
        }

        // Stop recording and extract events
        const events = await page.evaluate(() => {
            const stop = (window as unknown as Record<string, unknown>)._rrwebStop as (() => void) | undefined;
            if (stop) stop();
            return (window as unknown as Record<string, unknown>)._rrwebEvents as RrwebEvent[];
        });

        await browser.close();
        browser = null;

        if (!Array.isArray(events) || events.length === 0) {
            console.warn('[DemoGifService] rrweb produced no events');
            return null;
        }

        console.log(`[DemoGifService] rrweb recorded ${events.length} events`);
        return JSON.stringify(events);
    } catch (err) {
        console.error('[DemoGifService] recordDemoSession failed:', err);
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Build rrweb-player replay HTML and capture frames with Playwright
// ---------------------------------------------------------------------------

/**
 * Build a self-contained HTML page that uses rrweb-player to auto-replay the
 * provided events. All JS and CSS from node_modules are inlined so no network
 * access is required.
 */
export function buildReplayHtml(eventsJson: string): string {
    const playerJs = fs.readFileSync(RRWEB_PLAYER_BUNDLE, 'utf-8');
    const playerCss = fs.readFileSync(RRWEB_PLAYER_CSS, 'utf-8');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 800px; height: 600px; overflow: hidden; background: #ffffff; }
#player { width: 800px; height: 600px; }
/* rrweb-player styles */
${playerCss}
</style>
</head>
<body>
<div id="player"></div>
<script>
/* rrweb-player bundle */
${playerJs}
</script>
<script>
(function() {
  var events = ${eventsJson};
  window.__replayDuration = events.length > 1
    ? events[events.length - 1].timestamp - events[0].timestamp
    : 3000;
  var player = new rrwebPlayer({
    target: document.getElementById('player'),
    props: {
      events: events,
      autoPlay: true,
      showController: false,
      width: 800,
      height: 600,
      speed: 1,
    }
  });
  window.__rrwebPlayer = player;
  window.__playerReady = true;
})();
</script>
</body>
</html>`;
}

/**
 * Phase 2: Open the replay HTML in headless Playwright and capture PNG frames
 * at a fixed interval for the duration of the replay.
 *
 * @param replayHtmlPath  Path to the self-contained replay HTML file
 * @param durationMs      Total replay duration in ms
 * @param frameDir        Directory to save frame PNGs
 * @param frameIntervalMs Interval between frames (default 200 ms → ~5 fps)
 * @returns List of absolute frame PNG paths (may be empty on failure)
 */
export async function captureReplayFrames(
    replayHtmlPath: string,
    durationMs: number,
    frameDir: string,
    frameIntervalMs = 200
): Promise<string[]> {
    let browser: import('playwright').Browser | null = null;
    const framePaths: string[] = [];

    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        const page = await context.newPage();

        await page.goto(`file://${replayHtmlPath}`, { waitUntil: 'networkidle', timeout: 15000 });

        // Wait for rrweb-player to initialise and begin auto-play
        await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__playerReady === true, {
            timeout: 10000,
        });

        // Capture frames at regular intervals for the replay duration (+10% buffer)
        const totalFrames = Math.ceil((durationMs * 1.1) / frameIntervalMs);
        for (let i = 0; i < totalFrames; i++) {
            const shot = await page.screenshot({ type: 'png' });
            const framePath = path.join(frameDir, `frame-${String(i).padStart(4, '0')}.png`);
            fs.writeFileSync(framePath, shot);
            framePaths.push(framePath);

            if (i < totalFrames - 1) {
                await page.waitForTimeout(frameIntervalMs);
            }
        }

        await browser.close();
        browser = null;

        console.log(`[DemoGifService] Captured ${framePaths.length} replay frames`);
        return framePaths;
    } catch (err) {
        console.error('[DemoGifService] captureReplayFrames failed:', err);
        return framePaths;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Phase 3: FFmpeg compose frames → GIF
// ---------------------------------------------------------------------------

/**
 * Compose a sequence of PNG frames into an optimised GIF using FFmpeg.
 * Frame rate is derived from frameIntervalMs (default 200 ms → 5 fps).
 */
export async function composeGifWithFfmpeg(
    framePaths: string[],
    outputPath: string,
    frameIntervalMs = 200
): Promise<void> {
    if (framePaths.length === 0) throw new Error('No frames to compose');

    const fps = Math.round(1000 / frameIntervalMs);

    // concat demuxer list — each frame shown for frameIntervalMs
    const listPath = path.join(os.tmpdir(), `rrweb-frames-${Date.now()}.txt`);
    const durationSec = (frameIntervalMs / 1000).toFixed(3);
    const listContent = framePaths
        .map((f) => `file '${f}'\nduration ${durationSec}`)
        .join('\n');
    fs.writeFileSync(listPath, listContent);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-vf',
            `fps=${fps},scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            '-loop', '0',
            outputPath,
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        ffmpeg.on('close', (code) => {
            fs.unlink(listPath, () => {});
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
            }
        });
        ffmpeg.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Full rrweb pipeline:
 *   1. Record rrweb events by executing LLM-planned steps in Playwright
 *   2. Build self-contained rrweb-player replay HTML (all JS/CSS inlined)
 *   3. Re-render replay with Playwright, capture frames at 5 fps
 *   4. Compose frames into an optimised GIF with FFmpeg
 *
 * If recording produces no events the pipeline aborts and returns null.
 * All intermediate files are cleaned up on exit.
 *
 * @param demoFilePath  Absolute local path to the demo HTML file
 * @param steps         Interaction steps to execute during recording
 * @param outputPath    Desired output .gif path
 * @returns Output GIF path on success, null on any failure
 */
export async function generateGifForDemo(
    demoFilePath: string,
    steps: InteractionStep[],
    outputPath: string
): Promise<string | null> {
    const frameDir = path.join(os.tmpdir(), `rrweb-replay-frames-${Date.now()}`);
    const replayHtmlPath = path.join(os.tmpdir(), `rrweb-replay-${Date.now()}.html`);
    let framePaths: string[] = [];

    try {
        fs.mkdirSync(frameDir, { recursive: true });

        // ── Phase 1: Record ─────────────────────────────────────────────────
        const eventsJson = await recordDemoSession(demoFilePath, steps);
        if (!eventsJson) {
            console.error('[DemoGifService] Recording failed — no rrweb events captured. Aborting GIF.');
            return null;
        }

        // Save rrweb events JSON as sidecar for debugging / future replay
        const sidecarPath = outputPath.replace(/\.gif$/, '-rrweb.json');
        fs.writeFileSync(sidecarPath, eventsJson, 'utf-8');
        console.log(`[DemoGifService] rrweb events saved → ${path.basename(sidecarPath)}`);

        // ── Phase 2: Build replay HTML and capture frames ────────────────────
        const events = JSON.parse(eventsJson) as RrwebEvent[];
        const durationMs =
            events.length > 1
                ? events[events.length - 1].timestamp - events[0].timestamp
                : 3000;

        const replayHtml = buildReplayHtml(eventsJson);
        fs.writeFileSync(replayHtmlPath, replayHtml, 'utf-8');

        framePaths = await captureReplayFrames(replayHtmlPath, durationMs, frameDir);

        if (framePaths.length < 2) {
            console.warn('[DemoGifService] Insufficient frames from rrweb-player replay, skipping GIF');
            return null;
        }

        // ── Phase 3: FFmpeg → GIF ────────────────────────────────────────────
        await composeGifWithFfmpeg(framePaths, outputPath);
        console.log(`[DemoGifService] ✓ GIF created via rrweb-player replay: ${path.basename(outputPath)}`);
        return outputPath;
    } catch (err) {
        console.error('[DemoGifService] generateGifForDemo failed:', err);
        return null;
    } finally {
        // Cleanup temporary files
        for (const f of framePaths) fs.unlink(f, () => {});
        fs.rmdir(frameDir, () => {});
        fs.unlink(replayHtmlPath, () => {});
    }
}
