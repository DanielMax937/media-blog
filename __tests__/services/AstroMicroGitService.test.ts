import { execFile } from 'child_process';
import { commitAndPushAstroMicroPost } from '../../lib/services/AstroMicroGitService';

jest.mock('child_process', () => ({
    execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

function mockGitResponses(responses: Record<string, string>): void {
    mockExecFile.mockImplementation(
        (
            _command: string,
            args: string[],
            _options: unknown,
            callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
            const key = args.join(' ');
            const stdout = responses[key] ?? '';
            callback(null, stdout, '');
        }
    );
}

describe('AstroMicroGitService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.ASTRO_MICRO_GIT_PUBLISH;
        delete process.env.ASTRO_MICRO_GIT_AUTHOR_NAME;
        delete process.env.ASTRO_MICRO_GIT_AUTHOR_EMAIL;
        delete process.env.ASTRO_MICRO_GIT_BRANCH;
        delete process.env.ASTRO_MICRO_GIT_REMOTE;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('commits only the generated post directory and pushes main with the configured default author', async () => {
        mockGitResponses({
            'rev-parse --show-toplevel': '/repo/astro-micro\n',
            'rev-parse --abbrev-ref HEAD': 'main\n',
            'diff --cached --name-only -- src/content/blog/2026-06-20 public/sitemap.xml':
                'src/content/blog/2026-06-20/index.mdx\n',
            'rev-parse --short HEAD': 'abc1234\n',
        });

        const result = await commitAndPushAstroMicroPost({
            postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
            slug: '2026-06-20',
            sourceUrl: 'https://example.com/article',
            additionalPaths: ['/repo/astro-micro/public/sitemap.xml'],
        });

        expect(result).toMatchObject({
            enabled: true,
            committed: true,
            pushed: true,
            branch: 'main',
            remote: 'origin',
            relativePostDir: 'src/content/blog/2026-06-20',
            relativePaths: ['src/content/blog/2026-06-20', 'public/sitemap.xml'],
            commitSha: 'abc1234',
        });

        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['pull', '--ff-only', 'origin', 'main'],
            expect.objectContaining({ cwd: '/repo/astro-micro' }),
            expect.any(Function)
        );
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['add', '--', 'src/content/blog/2026-06-20', 'public/sitemap.xml'],
            expect.objectContaining({ cwd: '/repo/astro-micro' }),
            expect.any(Function)
        );
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            [
                'commit',
                '-m',
                'add generated medium post 2026-06-20',
                '-m',
                'Source: https://example.com/article',
                '--',
                'src/content/blog/2026-06-20',
                'public/sitemap.xml',
            ],
            expect.objectContaining({
                cwd: '/repo/astro-micro',
                env: expect.objectContaining({
                    GIT_AUTHOR_NAME: 'daniel1989',
                    GIT_AUTHOR_EMAIL: 'riyueniao2010@gmail.com',
                    GIT_COMMITTER_NAME: 'daniel1989',
                    GIT_COMMITTER_EMAIL: 'riyueniao2010@gmail.com',
                }),
            }),
            expect.any(Function)
        );
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['push', 'origin', 'main'],
            expect.objectContaining({ cwd: '/repo/astro-micro' }),
            expect.any(Function)
        );
    });

    it('skips commit and push when the generated post has no staged changes', async () => {
        mockGitResponses({
            'rev-parse --show-toplevel': '/repo/astro-micro\n',
            'rev-parse --abbrev-ref HEAD': 'main\n',
            'diff --cached --name-only -- src/content/blog/2026-06-20': '',
        });

        const result = await commitAndPushAstroMicroPost({
            postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
            slug: '2026-06-20',
            sourceUrl: 'https://example.com/article',
        });

        expect(result.reason).toBe('no_changes');
        expect(mockExecFile).not.toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['commit']),
            expect.anything(),
            expect.any(Function)
        );
        expect(mockExecFile).not.toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['push']),
            expect.anything(),
            expect.any(Function)
        );
    });

    it('can be disabled for local runs', async () => {
        process.env.ASTRO_MICRO_GIT_PUBLISH = 'false';

        const result = await commitAndPushAstroMicroPost({
            postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
            slug: '2026-06-20',
            sourceUrl: 'https://example.com/article',
        });

        expect(result).toEqual({
            enabled: false,
            committed: false,
            pushed: false,
            branch: 'main',
            remote: 'origin',
            reason: 'disabled',
        });
        expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('fails when astro-micro is not on the target branch', async () => {
        mockGitResponses({
            'rev-parse --show-toplevel': '/repo/astro-micro\n',
            'rev-parse --abbrev-ref HEAD': 'feature\n',
        });

        await expect(
            commitAndPushAstroMicroPost({
                postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
                slug: '2026-06-20',
                sourceUrl: 'https://example.com/article',
            })
        ).rejects.toThrow(/expected main/);
    });
});
