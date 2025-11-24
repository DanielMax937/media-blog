import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';

export class RednoteStrategy implements BlogStrategy {
    private openai: OpenAI;

    constructor(openai: OpenAI) {
        this.openai = openai;
    }

    async generate(content: string): Promise<{ content: string }> {
        const styleResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a social media expert specializing in "Rednote" (Xiaohongshu) style posts. Your goal is to convert the input text into a viral Rednote blog post.',
                },
                {
                    role: 'user',
                    content: `Convert the following article into a Rednote style blog post.
          
          Rules:
          1. Use an engaging title with emojis.
          2. Use emojis throughout the text.
          3. Keep paragraphs short and punchy.
          4. Use a friendly, enthusiastic tone.
          5. Add relevant hashtags at the end.
          6. The content MUST be in Chinese (Simplified Chinese), regardless of the input language.
          
          Input Text:
          ${content}`,
                },
            ],
        });

        return { content: styleResponse.choices[0].message.content || '' };
    }
}
