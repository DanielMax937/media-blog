/** Codex app-server JSON-RPC tests; fake children and test-owned PNGs only. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as childProcess from 'node:child_process';
import { generateImageWithCodex, isCodexImageGenerationAvailable } from '../../lib/services/CodexImageService';
import { logApi } from '../../lib/services/api-logger';

jest.mock('node:child_process', () => {
    const execFile = jest.fn((...args: unknown[]) => {
        const command = args[1] as string[];
        const stdout = command[0] === 'mcp'
            ? JSON.stringify([{ name: 'chrome-devtools', enabled: true }, { name: 'cua_repl', enabled: true }])
            : 'Logged in using ChatGPT\n';
        const callback = [...args].reverse().find((arg: unknown) => typeof arg === 'function') as
            ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
        if (callback) queueMicrotask(() => callback(null, stdout, ''));
        return { kill: jest.fn(), stdout, stderr: '' };
    });
    const { promisify } = jest.requireActual<typeof import('node:util')>('node:util');
    Object.defineProperty(execFile, promisify.custom, {
        value: async (...args: unknown[]) => {
            const result = execFile(...args);
            return { stdout: result.stdout, stderr: result.stderr };
        },
    });
    return { spawn: jest.fn(), execFile, exec: jest.fn(() => { throw new Error('Shell forbidden in offline tests'); }) };
});
jest.mock('../../lib/services/api-logger', () => ({ logApi: jest.fn(), logApiError: jest.fn() }));
jest.mock('../../lib/services/AgentImService', () => ({
    generateAgentImImage: jest.fn(() => { throw new Error('Agent-im generation forbidden in offline tests'); }),
    isAgentImAvailable: jest.fn(() => { throw new Error('Agent-im probe forbidden in offline tests'); }),
}), { virtual: true });
jest.mock('undici', () => ({
    fetch: jest.fn(() => { throw new Error('Network forbidden in offline tests'); }),
    ProxyAgent: jest.fn(),
}));

type Scenario = 'success' | 'fragmented' | 'base64' | 'no-evidence' | 'no-file' | 'nonzero' |
    'invalid-png' | 'broken-png' | 'empty-png' | 'symlink' | 'outside' | 'timeout' |
    'two-evidence' | 'no-turn' | 'turn-failed' | 'turn-error' | 'assistant-path' |
    'stale' | 'oversized' | 'secret-stderr' | 'capability-denied' | 'protocol-error' |
    'missing-thread' | 'missing-turn-id' | 'native-failure' | 'unexpected-tool' |
    'wrong-thread' | 'wrong-item-turn' | 'wrong-completed-turn' | 'invalid-base64' |
    'base64-not-png' | 'base64-corrupt-png' | 'missing-native-payload' | 'unsafe-saved-and-base64' |
    'duplicate-id3' | 'missing-item-thread' | 'missing-item-turn' | 'missing-completed-thread' |
    'missing-completed-turn' | 'large-base64' | 'eof-hang-term-ignore' | 'never-close-timeout';

type RpcRequest = { id?: number; method?: string; params?: Record<string, unknown> };

class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 2147483000;
    exitCode: number | null = null;
    signalCode: string | null = null;
    input = '';
    requests: RpcRequest[] = [];
    closed = false;
    cwd?: string;
    shutdownPolicy: 'normal' | 'kill-only' | 'never' = 'normal';
    kill = jest.fn((signal = 'SIGTERM') => {
        this.respondToSignal(signal);
        return true;
    });

    respondToSignal(signal: string) {
        this.signalCode = signal;
        if (this.shutdownPolicy === 'normal' || (this.shutdownPolicy === 'kill-only' && signal === 'SIGKILL')) {
            queueMicrotask(() => this.close(null, signal));
        }
    }

    close(code: number | null, signal: string | null = null) {
        if (this.closed) return;
        this.closed = true;
        this.exitCode = code;
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', code, signal);
        this.emit('close', code, signal);
    }
}

describe('CodexImageService app-server native protocol, completely offline', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;
    const spawn = childProcess.spawn as jest.Mock;
    const execFile = childProcess.execFile as unknown as jest.Mock;
    let fixturePng: Buffer;
    let largeFixturePng: Buffer;
    let testDir: string;
    let scenarios: Scenario[];
    let children: FakeChild[];
    let active: number;
    let peakActive: number;
    let signalGuard: jest.SpyInstance;
    let mcpScenario: 'normal' | 'fail' | 'unsafe' | 'bad-json';
    const shared = globalThis as typeof globalThis & {
        blog2mediaCodexImageQueue?: Promise<void>; blog2mediaCodexImageBlocked?: boolean;
    };
    const fetchGuard = jest.fn(() => { throw new Error('Fetch forbidden in offline tests'); });

    beforeAll(async () => {
        fixturePng = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#2894aa' } }).png().toBuffer();
        largeFixturePng = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#2894aa' } })
            .png({ compressionLevel: 0 }).toBuffer();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        delete shared.blog2mediaCodexImageQueue;
        delete shared.blog2mediaCodexImageBlocked;
        process.env = { ...originalEnv, OPENAI_API_KEY: 'offline-secret-api-key', OPENAI_BASE_URL: 'https://offline-api.invalid/v1' };
        global.fetch = fetchGuard as unknown as typeof fetch;
        mcpScenario = 'normal';
        execFile.mockImplementation((...args: unknown[]) => {
            const command = args[1] as string[];
            if (!(['login', 'status'].join(' ') === command.join(' ') || ['mcp', 'list', '--json'].join(' ') === command.join(' '))) {
                throw new Error('Unexpected local metadata invocation in offline tests');
            }
            if (command[0] === 'mcp' && mcpScenario === 'fail') throw new Error('offline-private-mcp-error');
            const stdout = command[0] !== 'mcp' ? 'Logged in using ChatGPT\n' :
                mcpScenario === 'unsafe' ? JSON.stringify([{ name: 'unsafe.name;$(private-command)' }]) :
                mcpScenario === 'bad-json' ? 'offline-private-invalid-mcp-response' :
                JSON.stringify([{ name: 'chrome-devtools', enabled: true }, { name: 'cua_repl', enabled: true }]);
            const callback = [...args].reverse().find(arg => typeof arg === 'function') as
                ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
            if (callback) queueMicrotask(() => callback(null, stdout, ''));
            return { kill: jest.fn(), stdout, stderr: '' };
        });
        signalGuard = jest.spyOn(process, 'kill').mockImplementation((processId, signal) => {
            for (const child of children ?? []) {
                if (child.pid === Math.abs(processId) && !child.closed) child.respondToSignal(String(signal ?? 'SIGTERM'));
            }
            return true;
        });
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog2media-codex-image-tests-'));
        scenarios = ['success'];
        children = [];
        active = 0;
        peakActive = 0;
        spawn.mockImplementation((_command: string, args: string[], options: { cwd?: string; signal?: AbortSignal }) => {
            const child = new FakeChild();
            children.push(child);
            if (!args.includes('app-server')) throw new Error('Unexpected subprocess invocation in offline tests');
            const scenario = scenarios.shift() ?? 'success';
            child.cwd = options.cwd;
            child.shutdownPolicy = scenario === 'eof-hang-term-ignore' ? 'kill-only' :
                scenario === 'never-close-timeout' ? 'never' : 'normal';
            active += 1;
            peakActive = Math.max(peakActive, active);
            child.once('close', () => { active -= 1; });
            options.signal?.addEventListener('abort', () => child.kill());
            child.stdin.once('finish', () => {
                if (child.shutdownPolicy === 'normal') queueMicrotask(() => child.close(0));
            });
            let pendingRequest = '';
            const reply = (value: unknown) => {
                if (!child.closed) child.stdout.write(JSON.stringify(value) + '\n');
            };
            const emitNativeResult = () => {
                if (child.closed) return;
                try {
                    if (!options.cwd) throw new Error('Native generation must use a temporary cwd');
                    const generatedDir = path.join(options.cwd, 'generated_images');
                    fs.mkdirSync(generatedDir, { recursive: true });
                    let source = path.join(generatedDir, '源图像.png');
                    if (scenario === 'outside' || scenario === 'unsafe-saved-and-base64') source = path.join(testDir, 'outside.png');
                    if (scenario !== 'no-file') {
                        if (scenario === 'symlink') {
                            const target = path.join(testDir, 'symlink-target.png');
                            fs.writeFileSync(target, fixturePng);
                            fs.symlinkSync(target, source);
                        } else {
                            fs.writeFileSync(source, scenario === 'invalid-png' ? Buffer.from('not a PNG; invalid content longer than 24 bytes') :
                                scenario === 'broken-png' ? Buffer.concat([fixturePng.subarray(0, 8), Buffer.alloc(64)]) :
                                scenario === 'empty-png' ? Buffer.alloc(0) : fixturePng);
                        }
                    }
                    if (scenario === 'stale') fs.utimesSync(source, new Date(0), new Date(0));
                    if (scenario === 'oversized') fs.truncateSync(source, 33 * 1024 * 1024);
                    const image: Record<string, unknown> = { type: 'imageGeneration', status: 'completed', failure: null, savedPath: source };
                    if (['base64', 'large-base64', 'invalid-base64', 'base64-not-png', 'base64-corrupt-png', 'missing-native-payload'].includes(scenario)) {
                        delete image.savedPath;
                        if (scenario !== 'missing-native-payload') image.result = scenario === 'invalid-base64' ? '%not-base64' :
                            scenario === 'base64-not-png' ? Buffer.from('not a PNG').toString('base64') :
                            scenario === 'base64-corrupt-png' ? Buffer.concat([fixturePng.subarray(0, 8), Buffer.alloc(64)]).toString('base64') :
                            (scenario === 'large-base64' ? largeFixturePng : fixturePng).toString('base64');
                    }
                    if (scenario === 'unsafe-saved-and-base64') image.result = fixturePng.toString('base64');
                    if (scenario === 'native-failure') image.failure = { message: 'offline-private-native-error' };
                    const nativeEvent: { method: string; params: Record<string, unknown> } = { method: 'item/completed', params: {
                        threadId: scenario === 'wrong-thread' ? 'other-thread' : 'offline-thread',
                        turnId: scenario === 'wrong-item-turn' ? 'other-turn' : 'offline-turn', item: image,
                    } };
                    if (scenario === 'missing-item-thread') delete nativeEvent.params.threadId;
                    if (scenario === 'missing-item-turn') delete nativeEvent.params.turnId;
                    const turn: Record<string, unknown> = {
                        id: scenario === 'wrong-completed-turn' ? 'other-turn' : 'offline-turn',
                        status: scenario === 'turn-failed' ? 'failed' : 'completed',
                        error: scenario === 'turn-error' ? { message: 'offline-private-turn-error' } : null,
                    };
                    if (scenario === 'missing-completed-turn') delete turn.id;
                    const turnEvent: { method: string; params: Record<string, unknown> } = { method: 'turn/completed', params: {
                        threadId: 'offline-thread', turn,
                    } };
                    if (scenario === 'missing-completed-thread') delete turnEvent.params.threadId;
                    const events = [
                        ...(scenario === 'unexpected-tool' ? [{ method: 'item/started', params: {
                            threadId: 'offline-thread', turnId: 'offline-turn', item: { type: 'commandExecution' },
                        } }] : []),
                        ...(scenario === 'no-evidence' ? [] : scenario === 'assistant-path' ? [{
                            method: 'item/completed', params: { threadId: 'offline-thread', turnId: 'offline-turn',
                                item: { type: 'agentMessage', text: source } },
                        }] : [nativeEvent]),
                        ...(scenario === 'two-evidence' ? [nativeEvent] : []),
                        ...(['no-turn', 'nonzero'].includes(scenario) ? [] : [turnEvent]),
                    ];
                    if (scenario === 'secret-stderr') child.stderr.write('offline-private-cli-reply-token');
                    const wire = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
                    if (scenario === 'fragmented') {
                        const split = wire.indexOf(Buffer.from('源')) + 1;
                        child.stdout.write(wire.subarray(0, split));
                        child.stdout.write(wire.subarray(split, split + 1));
                        child.stdout.write(wire.subarray(split + 1));
                    } else child.stdout.write(wire);
                    if (['no-turn', 'nonzero', 'wrong-completed-turn', 'missing-completed-thread', 'missing-completed-turn'].includes(scenario)) {
                        child.close(scenario === 'nonzero' ? 2 : 0);
                    }
                } catch (error) {
                    child.emit('error', error);
                    child.close(2);
                }
            };
            const request = (value: RpcRequest) => {
                child.requests.push(value);
                queueMicrotask(() => {
                    if (child.closed) return;
                    if (value.method === 'initialize') {
                        if (scenario === 'protocol-error') reply({ id: value.id, error: { code: -32603, message: 'offline-private-protocol-error' } });
                        else reply({ id: value.id, result: { userAgent: 'offline' } });
                    } else if (value.method === 'modelProvider/capabilities/read') {
                        reply({ id: value.id, result: { imageGeneration: scenario !== 'capability-denied' } });
                    } else if (value.method === 'thread/start') {
                        reply({ id: value.id, result: { thread: scenario === 'missing-thread' ? {} : { id: 'offline-thread' } } });
                        if (scenario === 'duplicate-id3') reply({ id: value.id, result: { thread: { id: 'offline-thread' } } });
                    } else if (value.method === 'turn/start') {
                        reply({ id: value.id, result: { turn: scenario === 'missing-turn-id' ? {} : { id: 'offline-turn' } } });
                        if (!['timeout', 'never-close-timeout', 'missing-turn-id'].includes(scenario)) setTimeout(emitNativeResult, 5);
                    }
                });
            };
            child.stdin.on('data', (chunk: Buffer) => {
                child.input += chunk.toString();
                pendingRequest += chunk.toString();
                let newline: number;
                while ((newline = pendingRequest.indexOf('\n')) !== -1) {
                    const line = pendingRequest.slice(0, newline);
                    pendingRequest = pendingRequest.slice(newline + 1);
                    request(JSON.parse(line) as RpcRequest);
                }
            });
            return child;
        });
    });

    afterEach(() => {
        for (const child of children) child.close(0);
        jest.useRealTimers();
        signalGuard.mockRestore();
        process.env = originalEnv;
        global.fetch = originalFetch;
        fs.rmSync(testDir, { recursive: true, force: true });
        // A deliberately unclosed fake leaves only its recorded, test-created runtime directory.
        for (const child of children) {
            if (child.cwd && path.dirname(child.cwd) === path.resolve(os.tmpdir())
                && path.basename(child.cwd).startsWith('blog2media-codex-image-')) {
                fs.rmSync(child.cwd, { recursive: true, force: true });
            }
        }
        delete shared.blog2mediaCodexImageQueue;
        delete shared.blog2mediaCodexImageBlocked;
        expect(fetchGuard).not.toHaveBeenCalled();
    });

    function generationCalls() {
        return spawn.mock.calls.filter(([, args]) => args.includes('app-server'));
    }

    async function waitUntil(predicate: () => boolean) {
        // Keep filesystem completion and protocol microtasks real even when deadlines are fake.
        for (let attempt = 0; attempt < 5000; attempt += 1) {
            if (predicate()) return;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        throw new Error('Offline child did not reach the expected stage');
    }

    it('availability checks local login only, without creating a thread or image', async () => {
        expect(await isCodexImageGenerationAvailable()).toBe(true);
        expect(generationCalls()).toHaveLength(0);
        expect(execFile).toHaveBeenCalledWith(expect.any(String), ['login', 'status'], expect.any(Object));
        expect(execFile.mock.calls.map(([, args]) => args)).not.toContainEqual(['mcp', 'list', '--json']);
    });

    it.each(['fail', 'unsafe', 'bad-json'] as const)('fails closed before starting a child when MCP isolation metadata is %s', async scenario => {
        mcpScenario = scenario;
        const output = path.join(testDir, 'mcp-rejected.png');
        const error = await generateImageWithCodex('offline picture', output, { width: 96, height: 64 })
            .then(() => { throw new Error('Expected isolation rejection'); }, caught => caught as Error);
        expect(error.message).toBe('Codex image generation failed (mcp_isolation_failed)');
        expect(JSON.stringify((logApi as jest.Mock).mock.calls)).not.toContain('offline-private');
        expect(error.message).not.toContain('private-command');
        expect(generationCalls()).toHaveLength(0);
        expect(fs.existsSync(output)).toBe(false);
    });

    it('uses app-server argv, prompt JSON stdin and account authentication', async () => {
        process.env.CODEX_IMAGE_MODEL = 'offline-device-model';
        for (const name of ['CODEX_REMOTE_PAYLOAD', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_PERMISSION_PROFILE']) {
            process.env[name] = 'offline-private-parent-session';
        }
        process.env.NO_PROXY = 'offline.local';
        process.env.no_proxy = 'offline.lowercase';
        const prompt = 'Offline picture; $(do-not-execute)';
        await generateImageWithCodex(prompt, path.join(testDir, 'cover.png'), { width: 96, height: 64 });
        expect(generationCalls()).toHaveLength(1);
        const [, args, options] = generationCalls()[0];
        expect(options.shell).toBe(false);
        expect(args).toEqual(expect.arrayContaining(['app-server', '--listen', 'stdio://',
            '--disable', 'plugins', 'apps', 'shell_tool', 'multi_agent', 'hooks', 'web_search="disabled"']));
        for (const tool of ['plugins', 'apps', 'shell_tool', 'multi_agent', 'hooks']) {
            expect(args[args.indexOf(tool) - 1]).toBe('--disable');
        }
        expect(args[args.indexOf('image_generation') - 1]).toBe('--enable');
        expect(args).not.toContain('mcp_servers={}');
        for (const name of ['chrome-devtools', 'cua_repl']) {
            const config = `mcp_servers.${name}={command="/usr/bin/false",enabled=false}`;
            expect(args).toContain(config);
            expect(args[args.indexOf(config) - 1]).toBe('-c');
        }
        expect(execFile).toHaveBeenCalledWith(expect.any(String), ['mcp', 'list', '--json'], expect.objectContaining({ timeout: 5000 }));
        expect(args).not.toContain('--model');
        expect(args).toContain('model="offline-device-model"');
        expect(args).not.toContain(prompt);
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
        expect(options.env.OPENAI_BASE_URL).toBeUndefined();
        for (const name of ['CODEX_REMOTE_PAYLOAD', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_PERMISSION_PROFILE']) {
            expect(options.env[name]).toBeUndefined();
        }
        expect(options.env.NO_PROXY).toBe(options.env.no_proxy);
        expect(options.env.NO_PROXY.split(',')).toEqual(expect.arrayContaining([
            'offline.local', 'offline.lowercase', '127.0.0.1', 'localhost', '::1',
        ]));
        expect(options.env.CODEX_HOME).toBe(originalEnv.CODEX_HOME);
        const child = children[0];
        expect(child.requests.map(request => request.method)).toEqual([
            'initialize', 'initialized', 'modelProvider/capabilities/read', 'thread/start', 'turn/start',
        ]);
        const thread = child.requests.find(request => request.method === 'thread/start')!.params!;
        expect(thread).toEqual(expect.objectContaining({ approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }));
        expect(thread.config).toEqual({ mcp_servers: {
            'chrome-devtools': { command: '/usr/bin/false', enabled: false },
            cua_repl: { command: '/usr/bin/false', enabled: false },
        } });
        const turn = child.requests.find(request => request.method === 'turn/start')!.params!;
        expect(turn.threadId).toBe('offline-thread');
        expect(JSON.stringify(turn.input)).toContain(prompt);
    });

    it.each(['success', 'fragmented', 'base64', 'large-base64'] as Scenario[])('saves complete resized PNG with native RPC evidence: %s', async scenario => {
        scenarios = [scenario];
        const output = path.join(testDir, 'cover.png');
        await generateImageWithCodex('offline picture', output, { width: 96, height: 64 });
        const metadata = await sharp(output).metadata();
        expect(metadata.format).toBe('png');
        expect([metadata.width, metadata.height]).toEqual([96, 64]);
        expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    });

    it.each(['no-evidence', 'no-file', 'nonzero', 'invalid-png', 'broken-png', 'empty-png', 'symlink', 'outside',
        'two-evidence', 'no-turn', 'turn-failed', 'turn-error', 'assistant-path', 'stale', 'oversized',
        'capability-denied', 'protocol-error', 'missing-thread', 'missing-turn-id', 'native-failure', 'unexpected-tool',
        'wrong-thread', 'wrong-item-turn', 'wrong-completed-turn', 'invalid-base64', 'base64-not-png',
        'base64-corrupt-png', 'missing-native-payload', 'unsafe-saved-and-base64', 'missing-item-thread',
        'missing-item-turn', 'missing-completed-thread', 'missing-completed-turn'] as Scenario[])
        ('rejects %s without retries or another backend', async scenario => {
            scenarios = [scenario];
            const output = path.join(testDir, 'rejected.png');
            await expect(generateImageWithCodex('offline picture', output, { width: 96, height: 64 })).rejects.toThrow();
            expect(generationCalls()).toHaveLength(1);
            expect(fs.existsSync(output)).toBe(false);
            if (scenario === 'capability-denied') {
                expect(children[0].requests.map(request => request.method)).not.toContain('turn/start');
            }
        });

    it('consumes a repeated thread/start response only once, without another image request', async () => {
        scenarios = ['duplicate-id3'];
        await generateImageWithCodex('offline picture', path.join(testDir, 'duplicate-response.png'), { width: 96, height: 64 });
        expect(generationCalls()).toHaveLength(1);
        expect(children[0].requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
        const nativeCompletions = (logApi as jest.Mock).mock.calls.filter(([, message, details]) =>
            message === 'Codex image CLI progress' && details.stage === 'native_image_completed');
        expect(nativeCompletions).toHaveLength(1);
    });

    it('does not overwrite an existing output file', async () => {
        const output = path.join(testDir, 'existing.png');
        fs.writeFileSync(output, fixturePng);
        await expect(generateImageWithCodex('offline picture', output, { width: 96, height: 64 })).rejects.toThrow();
        expect(fs.readFileSync(output)).toEqual(fixturePng);
        expect(generationCalls()).toHaveLength(0);
    });

    it('does not log raw prompt, API key or CLI stderr', async () => {
        scenarios = ['secret-stderr'];
        await generateImageWithCodex('offline-private-prompt-marker', path.join(testDir, 'private.png'), { width: 96, height: 64 });
        const logs = JSON.stringify((logApi as jest.Mock).mock.calls);
        expect(logs).not.toContain('offline-private-prompt-marker');
        expect(logs).not.toContain('offline-secret-api-key');
        expect(logs).not.toContain('offline-private-cli-reply-token');
    });

    it.each([0, -1, 15, 3841, 32.5, Number.NaN])('rejects invalid dimensions before spawning: %s', async width => {
        await expect(generateImageWithCodex('offline picture', path.join(testDir, 'size.png'), { width, height: 64 })).rejects.toThrow();
        expect(generationCalls()).toHaveLength(0);
    });

    it.each(['', 'X'.repeat(32001)])('rejects empty or oversized prompts before spawning', async prompt => {
        await expect(generateImageWithCodex(prompt, path.join(testDir, 'prompt.png'), { width: 96, height: 64 })).rejects.toThrow();
        expect(generationCalls()).toHaveLength(0);
    });

    it('terminates a timed-out child once and never resubmits', async () => {
        process.env.CODEX_IMAGE_TIMEOUT_MS = '1000';
        scenarios = ['timeout'];
        const output = path.join(testDir, 'timeout.png');
        await expect(generateImageWithCodex('offline picture', output, { width: 96, height: 64 })).rejects.toThrow();
        expect(generationCalls()).toHaveLength(1);
        expect(fs.existsSync(output)).toBe(false);
        expect(signalGuard).toHaveBeenCalledWith(-children[0].pid, 'SIGTERM');
    });

    it('forces a successful child to close with SIGKILL when EOF and SIGTERM are ignored', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        scenarios = ['eof-hang-term-ignore'];
        const output = path.join(testDir, 'forced-close.png');
        const result = generateImageWithCodex('offline picture', output, { width: 96, height: 64 });
        // Always attach a rejection handler before advancing deadlines.
        const settled = result.then(() => ({ ok: true }), error => ({ ok: false, error }));
        await waitUntil(() => children[0]?.requests.some(request => request.method === 'turn/start') ?? false);
        await jest.advanceTimersByTimeAsync(10);
        expect(children[0].stdin.writableEnded).toBe(true);
        expect(children[0].closed).toBe(false);
        await jest.advanceTimersByTimeAsync(3600);
        expect(await settled).toEqual({ ok: true });
        expect(signalGuard.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
        expect(children[0].closed).toBe(true);
        expect((await sharp(output).metadata()).format).toBe('png');
        expect(shared.blog2mediaCodexImageBlocked).toBe(false);
    });

    it('settles an unclosed timed-out process and blocks all later calls without another child', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        process.env.CODEX_IMAGE_TIMEOUT_MS = '1000';
        scenarios = ['never-close-timeout'];
        const output = path.join(testDir, 'unclosed-timeout.png');
        const result = generateImageWithCodex('offline picture', output, { width: 96, height: 64 });
        const settled = result.then(() => undefined, error => error);
        await waitUntil(() => children[0]?.requests.some(request => request.method === 'turn/start') ?? false);
        await jest.advanceTimersByTimeAsync(6001);
        expect(await settled).toEqual(expect.objectContaining({ code: 'timeout', outcomeUnknown: true }));
        expect(shared.blog2mediaCodexImageBlocked).toBe(true);
        expect(children[0].closed).toBe(false);
        expect(signalGuard.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
        expect(fs.existsSync(output)).toBe(false);
        await expect(generateImageWithCodex('offline next picture', path.join(testDir, 'blocked.png'), { width: 96, height: 64 }))
            .rejects.toEqual(expect.objectContaining({ code: 'previous_process_unclosed', outcomeUnknown: true }));
        expect(generationCalls()).toHaveLength(1);
    });

    it('serializes concurrent app-server generation', async () => {
        scenarios = ['success', 'success', 'success'];
        await Promise.all([1, 2, 3].map(number => generateImageWithCodex(
            'offline picture', path.join(testDir, `concurrent-${number}.png`), { width: 96, height: 64 },
        )));
        expect(generationCalls()).toHaveLength(3);
        expect(peakActive).toBe(1);
        expect(active).toBe(0);
    });
});
