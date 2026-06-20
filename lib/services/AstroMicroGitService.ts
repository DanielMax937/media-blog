import { execFile } from 'child_process';
import path from 'path';

export interface AstroMicroGitPublishParams {
    postDir: string;
    slug: string;
    sourceUrl: string;
    branch?: string;
    remote?: string;
}

export interface AstroMicroGitPublishResult {
    enabled: boolean;
    committed: boolean;
    pushed: boolean;
    branch: string;
    remote: string;
    repoRoot?: string;
    relativePostDir?: string;
    commitSha?: string;
    reason?: 'disabled' | 'no_changes';
}

interface GitOutput {
    stdout: string;
    stderr: string;
}

const DEFAULT_BRANCH = 'main';
const DEFAULT_REMOTE = 'origin';
const DEFAULT_AUTHOR_NAME = 'daniel1989';
const DEFAULT_AUTHOR_EMAIL = 'riyueniao2010@gmail.com';

function isPublishEnabled(): boolean {
    const raw = process.env.ASTRO_MICRO_GIT_PUBLISH?.trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function getConfiguredValue(envName: string, fallback: string): string {
    return process.env[envName]?.trim() || fallback;
}

function execGit(args: string[], cwd: string, env?: Partial<NodeJS.ProcessEnv>): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            {
                cwd,
                encoding: 'utf8',
                env: { ...process.env, ...env },
                maxBuffer: 10 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = [error.message, stderr.trim()].filter(Boolean).join('\n');
                    reject(new Error(detail));
                    return;
                }
                resolve({ stdout, stderr });
            }
        );
    });
}

function ensureRelativePathInsideRepo(repoRoot: string, targetPath: string): string {
    const relativePath = path.relative(repoRoot, path.resolve(targetPath));
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Generated post is outside astro-micro git repo: ${targetPath}`);
    }
    return relativePath.split(path.sep).join('/');
}

export async function commitAndPushAstroMicroPost(
    params: AstroMicroGitPublishParams
): Promise<AstroMicroGitPublishResult> {
    const branch = params.branch ?? getConfiguredValue('ASTRO_MICRO_GIT_BRANCH', DEFAULT_BRANCH);
    const remote = params.remote ?? getConfiguredValue('ASTRO_MICRO_GIT_REMOTE', DEFAULT_REMOTE);

    if (!isPublishEnabled()) {
        return { enabled: false, committed: false, pushed: false, branch, remote, reason: 'disabled' };
    }

    const repoRoot = (await execGit(['rev-parse', '--show-toplevel'], params.postDir)).stdout.trim();
    const currentBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)).stdout.trim();
    if (currentBranch !== branch) {
        throw new Error(`astro-micro git repo is on ${currentBranch}, expected ${branch}`);
    }

    const relativePostDir = ensureRelativePathInsideRepo(repoRoot, params.postDir);

    await execGit(['pull', '--ff-only', remote, branch], repoRoot);
    await execGit(['add', '--', relativePostDir], repoRoot);

    const stagedFiles = (await execGit(['diff', '--cached', '--name-only', '--', relativePostDir], repoRoot))
        .stdout
        .trim();
    if (!stagedFiles) {
        return {
            enabled: true,
            committed: false,
            pushed: false,
            branch,
            remote,
            repoRoot,
            relativePostDir,
            reason: 'no_changes',
        };
    }

    const authorName = getConfiguredValue('ASTRO_MICRO_GIT_AUTHOR_NAME', DEFAULT_AUTHOR_NAME);
    const authorEmail = getConfiguredValue('ASTRO_MICRO_GIT_AUTHOR_EMAIL', DEFAULT_AUTHOR_EMAIL);
    const commitEnv = {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
    };

    await execGit(
        [
            'commit',
            '-m',
            `add generated medium post ${params.slug}`,
            '-m',
            `Source: ${params.sourceUrl}`,
            '--',
            relativePostDir,
        ],
        repoRoot,
        commitEnv
    );
    const commitSha = (await execGit(['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim();

    await execGit(['push', remote, branch], repoRoot);

    return {
        enabled: true,
        committed: true,
        pushed: true,
        branch,
        remote,
        repoRoot,
        relativePostDir,
        commitSha,
    };
}
