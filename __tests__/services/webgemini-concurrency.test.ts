import {
    WEBGEMINI_MAX_CONCURRENT,
    withWebgeminiConcurrency,
} from '../../lib/services/webgemini-concurrency';

describe('webgemini-concurrency', () => {
    it('caps concurrent withWebgeminiConcurrency executions at WEBGEMINI_MAX_CONCURRENT', async () => {
        expect(WEBGEMINI_MAX_CONCURRENT).toBe(2);

        let concurrent = 0;
        let maxSeen = 0;

        const run = async () => {
            await withWebgeminiConcurrency(async () => {
                concurrent += 1;
                maxSeen = Math.max(maxSeen, concurrent);
                await new Promise((r) => setTimeout(r, 15));
                concurrent -= 1;
            });
        };

        await Promise.all(Array.from({ length: 8 }, () => run()));

        expect(maxSeen).toBe(2);
        expect(concurrent).toBe(0);
    });
});
