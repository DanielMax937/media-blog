jest.mock('openai', () => jest.fn().mockImplementation(() => ({})));

jest.mock('@/lib/strategies/MediumStrategy', () => ({
    MediumStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: '# Generated Article\n\n![Cover](https://www.bitstripe.cn/files/cover.png)\n\nBody.',
            demo: '<html>demo</html>',
        }),
    })),
}));

jest.mock('@/lib/rednote/rednote-helpers', () => ({
    scrapeUrl: jest.fn().mockResolvedValue('raw article text'),
    extractMainContent: jest.fn().mockResolvedValue('main article text'),
    writeMdAndUpload: jest.fn().mockResolvedValue('https://www.bitstripe.cn/files/article.md'),
}));

jest.mock('@/lib/services/SqliteService', () => ({
    logGeneration: jest.fn().mockReturnValue(42),
    updateMediumJob: jest.fn(),
}));

jest.mock('@/lib/services/TelegramService', () => ({
    sendJobNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/services/AstroMicroMdxService', () => ({
    writeAstroMicroMdxFromMedium: jest.fn().mockReturnValue({
        blogDir: '/repo/astro-micro/src/content/blog',
        postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
        filePath: '/repo/astro-micro/src/content/blog/2026-06-20/index.mdx',
        slug: '2026-06-20',
    }),
}));

jest.mock('@/lib/services/AstroMicroGitService', () => ({
    commitAndPushAstroMicroPost: jest.fn().mockResolvedValue({
        enabled: true,
        committed: true,
        pushed: true,
        branch: 'main',
        remote: 'origin',
        commitSha: 'abc1234',
    }),
}));

import { runMediumJob } from '../../lib/medium/run-medium-job';
import { updateMediumJob } from '@/lib/services/SqliteService';
import { sendJobNotification } from '@/lib/services/TelegramService';
import { writeAstroMicroMdxFromMedium } from '@/lib/services/AstroMicroMdxService';
import { commitAndPushAstroMicroPost } from '@/lib/services/AstroMicroGitService';

describe('runMediumJob', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (writeAstroMicroMdxFromMedium as jest.Mock).mockReturnValue({
            blogDir: '/repo/astro-micro/src/content/blog',
            postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
            filePath: '/repo/astro-micro/src/content/blog/2026-06-20/index.mdx',
            slug: '2026-06-20',
        });
        (commitAndPushAstroMicroPost as jest.Mock).mockResolvedValue({
            enabled: true,
            committed: true,
            pushed: true,
            branch: 'main',
            remote: 'origin',
            commitSha: 'abc1234',
        });
    });

    it('writes MDX and publishes the generated astro-micro post to git', async () => {
        await runMediumJob('job-1', 'https://example.com/article');

        expect(writeAstroMicroMdxFromMedium).toHaveBeenCalledWith({
            markdown: '# Generated Article\n\n![Cover](https://www.bitstripe.cn/files/cover.png)\n\nBody.',
            demoHtml: '<html>demo</html>',
            imageUrls: ['https://www.bitstripe.cn/files/cover.png'],
            sourceUrl: 'https://example.com/article',
        });
        expect(commitAndPushAstroMicroPost).toHaveBeenCalledWith({
            postDir: '/repo/astro-micro/src/content/blog/2026-06-20',
            slug: '2026-06-20',
            sourceUrl: 'https://example.com/article',
        });
        expect(updateMediumJob).toHaveBeenLastCalledWith('job-1', expect.objectContaining({
            status: 'completed',
            md_url: 'https://www.bitstripe.cn/files/article.md',
            generation_log_id: 42,
        }));
        expect(sendJobNotification).toHaveBeenCalledWith(expect.objectContaining({
            localArtifactPaths: ['/repo/astro-micro/src/content/blog/2026-06-20/index.mdx'],
        }));
    });

    it('keeps the Medium job completed when astro-micro git publishing fails', async () => {
        (commitAndPushAstroMicroPost as jest.Mock).mockRejectedValueOnce(new Error('push failed'));

        await runMediumJob('job-2', 'https://example.com/article');

        expect(updateMediumJob).toHaveBeenLastCalledWith('job-2', expect.objectContaining({
            status: 'completed',
        }));
        expect(sendJobNotification).toHaveBeenCalledWith(expect.objectContaining({
            status: 'completed',
        }));
    });
});
