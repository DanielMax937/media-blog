import {
    planInteractionSteps,
    recordDemoSession,
    buildReplayHtml,
    captureReplayFrames,
    composeGifWithFfmpeg,
    generateGifForDemo,
} from '../../lib/services/DemoGifService';
import OpenAI from 'openai';
import os from 'os';
import path from 'path';

// Use var (not const/let) so Jest's hoist of jest.mock() can access them via closure.
// The factory creates closures over these bindings; actual values are set in beforeEach.
// eslint-disable-next-line no-var
var _mockEvaluate: jest.Mock;
// eslint-disable-next-line no-var
var _mockScreenshot: jest.Mock;
// eslint-disable-next-line no-var
var _mockWaitForFunction: jest.Mock;
// eslint-disable-next-line no-var
var _mockWaitForTimeout: jest.Mock;

jest.mock('playwright', () => {
    const mockPage = () => ({
        goto: jest.fn().mockResolvedValue(undefined),
        evaluate: _mockEvaluate,
        screenshot: _mockScreenshot,
        waitForTimeout: _mockWaitForTimeout,
        waitForFunction: _mockWaitForFunction,
        click: jest.fn().mockResolvedValue(undefined),
        fill: jest.fn().mockResolvedValue(undefined),
        hover: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockReturnValue({ scrollIntoViewIfNeeded: jest.fn() }),
    });
    return {
        chromium: {
            launch: jest.fn().mockImplementation(async () => ({
                newContext: jest.fn().mockImplementation(async () => ({
                    newPage: jest.fn().mockImplementation(async () => mockPage()),
                })),
                close: jest.fn().mockResolvedValue(undefined),
            })),
        },
    };
});

jest.mock('child_process', () => ({
    spawn: jest.fn(),
}));

jest.mock('fs', () => {
    const actual = jest.requireActual<typeof import('fs')>('fs');
    return {
        ...actual,
        readFileSync: jest.fn((p: string, enc?: unknown) => {
            if (typeof p === 'string' && (p.endsWith('.js') || p.endsWith('.css'))) {
                return '/* mock asset */';
            }
            return actual.readFileSync(p, enc as BufferEncoding);
        }),
        writeFileSync: jest.fn(),
        mkdirSync: jest.fn(),
        unlink: jest.fn((_p: string, cb?: () => void) => { if (cb) cb(); }),
        rmdir: jest.fn(),
    };
});

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpenAI(content: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

function makeSpawnOk(): void {
    mockSpawn.mockReturnValue({
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: (code: number) => void) => {
            if (event === 'close') setImmediate(() => cb(0));
        }),
    });
}

const SAMPLE_EVENTS = [
    { type: 4, data: {}, timestamp: 1000 },
    { type: 3, data: {}, timestamp: 2500 },
    { type: 3, data: {}, timestamp: 4000 },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DemoGifService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _mockEvaluate = jest.fn();
        _mockScreenshot = jest.fn().mockResolvedValue(Buffer.from('PNGDATA'));
        _mockWaitForTimeout = jest.fn().mockResolvedValue(undefined);
        _mockWaitForFunction = jest.fn().mockResolvedValue(undefined);
        makeSpawnOk();
    });

    // ── planInteractionSteps ──────────────────────────────────────────────

    describe('planInteractionSteps', () => {
        it('returns parsed steps from LLM response', async () => {
            const steps = [
                { type: 'wait', duration: 800, description: 'Wait for load' },
                { type: 'click', selector: '#btn', description: 'Click button' },
            ];
            const openai = makeOpenAI(JSON.stringify({ steps }));
            const result = await planInteractionSteps(
                '# Article', '<html><button id="btn">Click</button></html>', 'Show demo', openai
            );
            expect(result).toHaveLength(2);
            expect(result[0].type).toBe('wait');
            expect(result[1].selector).toBe('#btn');
        });

        it('returns a fallback wait step when LLM response is invalid JSON', async () => {
            const openai = makeOpenAI('invalid json {{{');
            const result = await planInteractionSteps('md', '<html></html>', 'ctx', openai);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('wait');
        });

        it('returns empty array when LLM returns empty steps', async () => {
            const openai = makeOpenAI(JSON.stringify({ steps: [] }));
            const result = await planInteractionSteps('md', '<html></html>', 'ctx', openai);
            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(0);
        });

        it('calls OpenAI with json_object format and OPENAI_MODEL default', async () => {
            const mockCreate = jest.fn().mockResolvedValue({
                choices: [{ message: { content: JSON.stringify({ steps: [] }) } }],
            });
            const openai = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
            await planInteractionSteps('md', '<html></html>', 'ctx', openai);
            const expectedModel = process.env.OPENAI_MODEL ?? 'gpt-5.4';
            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({ response_format: { type: 'json_object' }, model: expectedModel })
            );
        });
    });

    // ── buildReplayHtml ───────────────────────────────────────────────────
    // Pure function — no mocks needed

    describe('buildReplayHtml', () => {
        const eventsJson = JSON.stringify(SAMPLE_EVENTS);

        it('contains rrweb-player initialisation with autoPlay', () => {
            const html = buildReplayHtml(eventsJson);
            expect(html).toContain('rrwebPlayer');
            expect(html).toContain('autoPlay: true');
            expect(html).toContain('showController: false');
        });

        it('calculates replay duration from event timestamps', () => {
            const html = buildReplayHtml(eventsJson);
            // duration = lastTimestamp - firstTimestamp = 4000 - 1000 = 3000
            expect(html).toContain('3000');
            expect(html).toContain('__replayDuration');
        });

        it('sets __playerReady flag after player init', () => {
            const html = buildReplayHtml(eventsJson);
            expect(html).toContain('__playerReady = true');
        });

        it('includes a #player target element', () => {
            const html = buildReplayHtml(eventsJson);
            expect(html).toContain('id="player"');
        });

        it('returns a valid HTML document', () => {
            const html = buildReplayHtml(eventsJson);
            expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
            expect(html).toContain('</html>');
        });

        it('embeds the events JSON verbatim', () => {
            const html = buildReplayHtml(eventsJson);
            expect(html).toContain(eventsJson);
        });

        it('uses 3000ms fallback duration for single-event array', () => {
            const singleEvent = JSON.stringify([{ type: 4, timestamp: 1000 }]);
            const html = buildReplayHtml(singleEvent);
            expect(html).toContain('3000');
        });
    });

    // ── recordDemoSession ─────────────────────────────────────────────────

    describe('recordDemoSession', () => {
        it('returns null when rrweb.record is not available on page', async () => {
            _mockEvaluate
                .mockResolvedValueOnce(undefined) // inject bundle
                .mockResolvedValueOnce(false);    // recording did NOT start

            const result = await recordDemoSession('/tmp/demo.html', []);
            expect(result).toBeNull();
        });

        it('returns null when events array is empty', async () => {
            _mockEvaluate
                .mockResolvedValueOnce(undefined) // inject bundle
                .mockResolvedValueOnce(true)      // recording started
                .mockResolvedValueOnce([]);        // empty events

            const result = await recordDemoSession('/tmp/demo.html', []);
            expect(result).toBeNull();
        });

        it('returns serialized events JSON on success', async () => {
            _mockEvaluate
                .mockResolvedValueOnce(undefined)  // inject bundle
                .mockResolvedValueOnce(true)       // recording started
                .mockResolvedValueOnce(SAMPLE_EVENTS); // extracted events

            const result = await recordDemoSession('/tmp/demo.html', [
                { type: 'wait', duration: 500, description: 'wait' },
            ]);

            expect(result).not.toBeNull();
            const parsed = JSON.parse(result!);
            expect(parsed).toHaveLength(3);
        });
    });

    // ── captureReplayFrames ───────────────────────────────────────────────

    describe('captureReplayFrames', () => {
        it('calls waitForFunction to detect player readiness', async () => {
            const frameDir = path.join(os.tmpdir(), 'test-frames');
            await captureReplayFrames('/tmp/replay.html', 200, frameDir, 200);
            expect(_mockWaitForFunction).toHaveBeenCalled();
        });

        it('captures at least one screenshot during replay', async () => {
            const frameDir = path.join(os.tmpdir(), 'test-frames-2');
            const frames = await captureReplayFrames('/tmp/replay.html', 200, frameDir, 200);
            expect(_mockScreenshot).toHaveBeenCalled();
            expect(frames.length).toBeGreaterThan(0);
        });
    });

    // ── composeGifWithFfmpeg ──────────────────────────────────────────────

    describe('composeGifWithFfmpeg', () => {
        it('throws immediately when no frames provided', async () => {
            await expect(composeGifWithFfmpeg([], '/tmp/out.gif')).rejects.toThrow('No frames');
        });

        it('calls ffmpeg with concat demuxer and paletteuse filter', async () => {
            const spawnInstance = {
                stderr: { on: jest.fn() },
                on: jest.fn((event: string, cb: (code: number) => void) => {
                    if (event === 'close') setImmediate(() => cb(0));
                }),
            };
            mockSpawn.mockReturnValueOnce(spawnInstance);

            await composeGifWithFfmpeg(['/tmp/f1.png', '/tmp/f2.png'], '/tmp/out.gif');

            expect(mockSpawn).toHaveBeenCalledWith(
                'ffmpeg',
                expect.arrayContaining([
                    '-f', 'concat',
                    expect.stringContaining('palettegen'),
                    '/tmp/out.gif',
                ])
            );
        });

        it('rejects when ffmpeg exits with non-zero code', async () => {
            const failSpawn = {
                stderr: { on: jest.fn() },
                on: jest.fn((event: string, cb: (code: number) => void) => {
                    if (event === 'close') setImmediate(() => cb(1));
                }),
            };
            mockSpawn.mockReturnValueOnce(failSpawn);

            await expect(
                composeGifWithFfmpeg(['/tmp/f1.png', '/tmp/f2.png'], '/tmp/out.gif')
            ).rejects.toThrow('ffmpeg exited 1');
        });

        it('defaults to 5fps (200ms interval)', async () => {
            const spawnInstance = {
                stderr: { on: jest.fn() },
                on: jest.fn((event: string, cb: (code: number) => void) => {
                    if (event === 'close') setImmediate(() => cb(0));
                }),
            };
            mockSpawn.mockReturnValueOnce(spawnInstance);

            await composeGifWithFfmpeg(['/tmp/f1.png', '/tmp/f2.png'], '/tmp/out.gif');

            const args = mockSpawn.mock.calls[0][1] as string[];
            const vfArg = args[args.indexOf('-vf') + 1];
            expect(vfArg).toContain('fps=5');
        });
    });

    // ── generateGifForDemo (integration) ─────────────────────────────────

    describe('generateGifForDemo', () => {
        it('returns null when recording produces no events', async () => {
            _mockEvaluate
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce([]);

            const result = await generateGifForDemo('/tmp/demo.html', [], '/tmp/out.gif');
            expect(result).toBeNull();
        });

        it('returns null when rrweb.record is unavailable', async () => {
            _mockEvaluate
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(false); // recording not started

            const result = await generateGifForDemo('/tmp/demo.html', [], '/tmp/out.gif');
            expect(result).toBeNull();
        });
    });
});
