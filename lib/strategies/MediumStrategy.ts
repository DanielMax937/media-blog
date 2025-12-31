import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';
import { query, Options } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';

export class MediumStrategy implements BlogStrategy {
    private openai: OpenAI;

    constructor(openai: OpenAI) {
        this.openai = openai;
    }

    /**
     * Generate demo HTML using Claude Agent SDK
     * The agent can autonomously create and write the demo file
     */
    private async generateDemoWithAgent(englishContent: string): Promise<string> {
        const demosDir = path.join(process.cwd(), 'public', 'demos');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `demo-${timestamp}.html`;
        const filepath = path.join(demosDir, filename);

        const options: Options = {
            allowedTools: ['Write', 'Bash'],
            systemPrompt: `You are a frontend developer creating an educational demo page. Create a self-contained HTML file that demonstrates concepts from the article in a "code snippet → live showcase" format.

STRUCTURE REQUIREMENTS:
- Organize the page as a series of sections, each containing:
  1. A heading describing the concept
  2. The code snippet shown in a <pre><code> block with syntax highlighting
  3. Immediately followed by a live interactive showcase demonstrating that exact code
- Use clear visual separation between sections (borders, backgrounds, spacing)
- Each showcase should be directly tied to the code snippet above it

VISUAL DESIGN:
- Use a clean, modern design with good typography
- Code blocks should have syntax highlighting (dark background, colored syntax)
- Showcases should have a distinct visual container (e.g., dashed border, light background)
- Add "Code:" and "Result:" labels to clearly distinguish sections

TECHNICAL REQUIREMENTS:
- Self-contained HTML with embedded CSS and JavaScript
- Use modern CSS (flexbox, grid, CSS variables)
- Make showcases interactive where possible (hover effects, click handlers, animations)
- Ensure code in <pre> blocks matches the actual implementation in showcases

You MUST use the Write tool to save the HTML file to: ${filepath}
After writing, output the complete HTML content.`,
        };

        const prompt = `Create a demo for this article and save it to ${filepath}:\n\n${englishContent}`;

        let demoContent = '';

        console.log('🤖 Claude Agent generating demo...');

        for await (const message of query({ prompt, options })) {
            if (message.type === 'assistant') {
                // Extract text content from assistant message
                for (const block of message.message.content) {
                    if (block.type === 'text') {
                        demoContent += block.text;
                    }
                }
            } else if (message.type === 'result') {
                if (message.subtype === 'success') {
                    console.log('📝 Agent completed:', message.result);
                }
            }
        }

        // If agent wrote the file, read it back; otherwise parse from response
        if (fs.existsSync(filepath)) {
            console.log('✅ Demo saved by agent to:', filepath);
            console.log('   Accessible at: /demos/' + filename);
            return fs.readFileSync(filepath, 'utf-8');
        }

        // Fallback: extract HTML from agent's text response
        let demo = demoContent;
        demo = demo.replace(/^```html\n?/g, '').replace(/\n?```$/g, '').trim();

        // Ensure demos directory exists
        if (!fs.existsSync(demosDir)) {
            fs.mkdirSync(demosDir, { recursive: true });
        }

        // Write the file manually if agent didn't
        if (demo) {
            fs.writeFileSync(filepath, demo, 'utf-8');
            console.log('✅ Demo saved to:', filepath);
        }

        return demo;
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

        // 2. Detect if it's a technical blog early
        const detectResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a technical content analyzer. Answer "YES" if the content is about software engineering, programming, or technical tutorials. Otherwise answer "NO".',
                },
                {
                    role: 'user',
                    content: englishContent.substring(0, 1000),
                },
            ],
        });
        const isTechnical = detectResponse.choices[0].message.content?.trim().toUpperCase().includes('YES');

        let demo = undefined;
        let demoCodeExamples = '';
        
        if (isTechnical) {
            // 3. Generate Demo FIRST for technical content using Claude Agent SDK
            demo = await this.generateDemoWithAgent(englishContent);

            // 4. Extract code examples from the demo
            demoCodeExamples = `\n\nHere is the working demo code that was generated:\n\`\`\`html\n${demo}\n\`\`\`\n\nUse relevant snippets from this code to create practical code examples in the article.`;
        }

        // 5. Format as Medium Blog with image placeholders (and code examples if technical)
        const formatResponse = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional blog writer for Medium. Format the text into a high-quality Medium article with the following requirements:

1. Use proper headings, clear paragraphs, and a professional yet engaging tone
2. Strategically add image placeholders throughout the article where visuals would help readers understand concepts better
3. Use this format for image placeholders: ![Image description](IMAGE_PLACEHOLDER)
4. Add descriptive alt text that explains what the image should show (e.g., "Architecture diagram showing the flow", "Screenshot of the dashboard interface", "Comparison chart of performance metrics")
5. Place 2-4 image placeholders at logical points: after introducing complex concepts, before code examples, or to illustrate workflows
6. Do NOT add images at the very beginning or end - focus on supporting complex explanations in the body

${isTechnical ? `7. IMPORTANT: This is a TECHNICAL article. Include 2-4 practical code examples extracted from the provided demo code.
8. Show relevant code snippets (HTML, CSS, or JavaScript) that demonstrate key concepts
9. Add explanatory text before and after each code block
10. Use proper syntax highlighting with language tags (e.g., \`\`\`javascript, \`\`\`html, \`\`\`css)
11. Keep code examples concise and focused on specific concepts
12. Do NOT include the entire demo code - extract only the most educational snippets
13. AFTER each major code example, add a screenshot placeholder to show the result: ![Screenshot showing the result of [describe what the code does]](DEMO_SCREENSHOT_PLACEHOLDER)
14. Place 2-3 demo screenshot placeholders throughout the article to demonstrate what the code produces visually
15. Demo screenshots should be placed right after code blocks to show "Here's the code → Here's what it looks like"` : ''}

Example placeholder: ![Architecture diagram showing the microservices communication flow](IMAGE_PLACEHOLDER)
Example demo screenshot: ![Screenshot showing the interactive button with hover effect](DEMO_SCREENSHOT_PLACEHOLDER)`,
                },
                {
                    role: 'user',
                    content: englishContent + demoCodeExamples,
                },
            ],
        });
        const mediumContent = formatResponse.choices[0].message.content || '';

        return { content: mediumContent, demo };
    }
}
