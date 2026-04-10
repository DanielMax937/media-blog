import { findDemoInsertionSlots, replaceSlotInMarkdown } from '../../lib/services/MarkdownDemoInserter';
import OpenAI from 'openai';

function makeOpenAI(content: string): OpenAI {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
    });
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
}

describe('MarkdownDemoInserter', () => {
    describe('findDemoInsertionSlots', () => {
        it('extracts DEMO_SCREENSHOT_PLACEHOLDER markers from markdown', async () => {
            const markdown = `# My Article

Some content here.

![Screenshot showing the result](DEMO_SCREENSHOT_PLACEHOLDER)

More content.

![Another demo screenshot](DEMO_SCREENSHOT_PLACEHOLDER)`;

            const openai = makeOpenAI('{}');
            const slots = await findDemoInsertionSlots(markdown, openai);

            expect(slots).toHaveLength(2);
            expect(slots[0].placeholder).toBe('![Screenshot showing the result](DEMO_SCREENSHOT_PLACEHOLDER)');
            expect(slots[0].index).toBe(0);
            expect(slots[1].placeholder).toBe('![Another demo screenshot](DEMO_SCREENSHOT_PLACEHOLDER)');
            expect(slots[1].index).toBe(1);
        });

        it('includes surrounding context in contextDescription', async () => {
            const markdown = `# Title\n\nSome context text here.\n\n![Demo result](DEMO_SCREENSHOT_PLACEHOLDER)\n\nMore text.`;
            const openai = makeOpenAI('{}');
            const slots = await findDemoInsertionSlots(markdown, openai);

            expect(slots[0].contextDescription).toContain('Demo result');
            expect(slots[0].contextDescription).toContain('Some context text');
        });

        it('falls back to LLM when no placeholders exist', async () => {
            const llmResponse = JSON.stringify({
                insertions: [
                    { afterText: 'some text here', description: 'Show button click demo' },
                ],
            });
            const openai = makeOpenAI(llmResponse);
            const markdown = '# Article\n\nSome text here\n\n```js\nconsole.log("hi")\n```\n\nEnd.';

            const slots = await findDemoInsertionSlots(markdown, openai);

            expect(slots).toHaveLength(1);
            expect(slots[0].contextDescription).toBe('Show button click demo');
            expect(slots[0].placeholder).toContain('DEMO_GIF_SLOT_');
        });

        it('returns empty array when LLM fallback fails', async () => {
            const openai = makeOpenAI('invalid json {{{');
            const markdown = '# Article\n\nNo placeholders here.';

            const slots = await findDemoInsertionSlots(markdown, openai);

            expect(slots).toEqual([]);
        });

        it('caps LLM insertions at 3', async () => {
            const llmResponse = JSON.stringify({
                insertions: [
                    { afterText: 'text1', description: 'desc1' },
                    { afterText: 'text2', description: 'desc2' },
                    { afterText: 'text3', description: 'desc3' },
                    { afterText: 'text4', description: 'desc4' },
                ],
            });
            const openai = makeOpenAI(llmResponse);
            const slots = await findDemoInsertionSlots(markdown_noplaceholder, openai);

            expect(slots.length).toBeLessThanOrEqual(3);
        });
    });

    describe('replaceSlotInMarkdown', () => {
        it('replaces placeholder with new content', () => {
            const markdown = '# Title\n\n![Demo](DEMO_SCREENSHOT_PLACEHOLDER)\n\nEnd.';
            const slot = {
                placeholder: '![Demo](DEMO_SCREENSHOT_PLACEHOLDER)',
                contextDescription: 'context',
                index: 0,
            };
            const result = replaceSlotInMarkdown(markdown, slot, '![GIF](https://cdn.example.com/demo.gif)');
            expect(result).toContain('![GIF](https://cdn.example.com/demo.gif)');
            expect(result).not.toContain('DEMO_SCREENSHOT_PLACEHOLDER');
        });

        it('appends before footer when placeholder not in text', () => {
            const markdown = '# Title\n\nContent.\n\n---\n\n### Footer\n\n*end*';
            const slot = {
                placeholder: '![Demo GIF](DEMO_GIF_SLOT_0)',
                contextDescription: 'context',
                index: 0,
            };
            const result = replaceSlotInMarkdown(markdown, slot, '![GIF](https://cdn.example.com/demo.gif)');
            // GIF should appear before the footer separator
            const gifIdx = result.indexOf('![GIF]');
            const footerIdx = result.indexOf('\n---\n');
            expect(gifIdx).toBeLessThan(footerIdx);
        });

        it('appends to end when no footer exists', () => {
            const markdown = '# Title\n\nContent here.';
            const slot = {
                placeholder: '![Demo GIF](DEMO_GIF_SLOT_0)',
                contextDescription: 'context',
                index: 0,
            };
            const result = replaceSlotInMarkdown(markdown, slot, '![GIF](https://cdn.example.com/demo.gif)');
            expect(result.endsWith('![GIF](https://cdn.example.com/demo.gif)')).toBe(true);
        });

        it('removes placeholder when replacement is empty string', () => {
            const markdown = 'Before\n\n![Demo](DEMO_SCREENSHOT_PLACEHOLDER)\n\nAfter';
            const slot = {
                placeholder: '![Demo](DEMO_SCREENSHOT_PLACEHOLDER)',
                contextDescription: 'ctx',
                index: 0,
            };
            const result = replaceSlotInMarkdown(markdown, slot, '');
            expect(result).not.toContain('DEMO_SCREENSHOT_PLACEHOLDER');
            expect(result).toContain('Before');
            expect(result).toContain('After');
        });
    });
});

const markdown_noplaceholder = '# Article\n\nSome text here\n\n```js\nconsole.log("hi")\n```\n\nEnd.';
