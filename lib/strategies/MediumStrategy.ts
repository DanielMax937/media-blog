import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';

export class MediumStrategy implements BlogStrategy {
    private openai: OpenAI;

    constructor(openai: OpenAI) {
        this.openai = openai;
    }

    async generate(content: string): Promise<{ content: string; demo?: string }> {
        // 1. Translate to English
        const translateResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional translator. Translate the following text to English. Maintain the original meaning and tone.',
                },
                {
                    role: 'user',
                    content: content,
                },
            ],
        });
        const englishContent = translateResponse.choices[0].message.content || '';

        // 2. Format as Medium Blog
        const formatResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional blog writer for Medium. Format the text into a high-quality Medium article. Use proper headings, clear paragraphs, and a professional yet engaging tone.',
                },
                {
                    role: 'user',
                    content: englishContent,
                },
            ],
        });
        const mediumContent = formatResponse.choices[0].message.content || '';

        // 3. Detect if it's a technical blog
        const detectResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a technical content analyzer. Answer "YES" if the content is about software engineering, programming, or technical tutorials. Otherwise answer "NO".',
                },
                {
                    role: 'user',
                    content: mediumContent.substring(0, 1000),
                },
            ],
        });
        const isTechnical = detectResponse.choices[0].message.content?.trim().toUpperCase().includes('YES');

        let demo = undefined;
        if (isTechnical) {
            // 4. Generate Demo
            const demoResponse = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a frontend developer. Create a simple, self-contained HTML file (with embedded CSS and JS) that demonstrates the concepts discussed in the article. The code should be ready to run in a browser.',
                    },
                    {
                        role: 'user',
                        content: `Create a demo for this article:\n\n${mediumContent}`,
                    },
                ],
            });
            demo = demoResponse.choices[0].message.content || '';
            // Clean up markdown code blocks if present
            demo = demo.replace(/^```html/, '').replace(/```$/, '');
        }

        return { content: mediumContent, demo };
    }
}
