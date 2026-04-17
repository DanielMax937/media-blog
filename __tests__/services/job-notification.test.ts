jest.mock('../../lib/rednote/rednote-helpers', () => ({
    scrapeUrl: jest.fn().mockResolvedValue('raw'),
    extractMainContent: jest.fn().mockResolvedValue('main'),
    writeMdAndUpload: jest.fn().mockResolvedValue('https://cdn.example.com/out.md'),
}));

jest.mock('../../lib/strategies/RednoteStrategy', () => ({
    RednoteStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: '# title',
            imageUrls: ['https://cdn.example.com/1.png'],
        }),
    })),
}));

jest.mock('../../lib/strategies/MediumStrategy', () => ({
    MediumStrategy: jest.fn().mockImplementation(() => ({
        generate: jest.fn().mockResolvedValue({
            content: '# title\n\n![img](https://cdn.example.com/cover.png)',
        }),
    })),
}));

jest.mock('../../lib/services/SqliteService', () => ({
    logGeneration: jest.fn().mockReturnValue(7),
    updateRednoteJob: jest.fn(),
    updateMediumJob: jest.fn(),
}));

jest.mock('../../lib/services/TelegramService', () => ({
    sendJobNotification: jest.fn().mockResolvedValue(undefined),
}));

import { scrapeUrl } from '../../lib/rednote/rednote-helpers';
import { runRednoteJob } from '../../lib/rednote/run-rednote-job';
import { runMediumJob } from '../../lib/medium/run-medium-job';
import { sendJobNotification } from '../../lib/services/TelegramService';

describe('job completion notifications', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('sends telegram when rednote job completes', async () => {
        await runRednoteJob('job-red', 'https://example.com/red');

        expect(sendJobNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'rednote',
                status: 'completed',
                jobId: 'job-red',
                sourceUrl: 'https://example.com/red',
                mdUrl: 'https://cdn.example.com/out.md',
            }),
        );
    });

    it('sends telegram when medium job completes', async () => {
        await runMediumJob('job-medium', 'https://example.com/medium');

        expect(sendJobNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'medium',
                status: 'completed',
                jobId: 'job-medium',
                sourceUrl: 'https://example.com/medium',
                mdUrl: 'https://cdn.example.com/out.md',
            }),
        );
    });

    it('sends telegram failed when rednote scrape is empty', async () => {
        (scrapeUrl as jest.Mock).mockResolvedValueOnce(null);

        await runRednoteJob('job-empty', 'https://example.com/empty');

        expect(sendJobNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'rednote',
                status: 'failed',
                jobId: 'job-empty',
                sourceUrl: 'https://example.com/empty',
                error: 'Failed to extract content from URL',
            }),
        );
    });

    it('sends telegram failed when medium scrape is empty', async () => {
        (scrapeUrl as jest.Mock).mockResolvedValueOnce('');

        await runMediumJob('job-m-empty', 'https://example.com/m-empty');

        expect(sendJobNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'medium',
                status: 'failed',
                jobId: 'job-m-empty',
                sourceUrl: 'https://example.com/m-empty',
                error: 'Failed to extract content from URL',
            }),
        );
    });
});
