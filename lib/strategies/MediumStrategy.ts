import { BlogStrategy } from './BlogStrategy';
import OpenAI from 'openai';
import { query, Options } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { uploadToBitstripe } from '../services/BitstripeUploader';
import { findDemoInsertionSlots, replaceSlotInMarkdown } from '../services/MarkdownDemoInserter';
import { planInteractionSteps, generateGifForDemo } from '../services/DemoGifService';
import { generateCoverImage } from '../services/CoverImageService';
import { logApi, logOpenAiRawResponseIfEmpty } from '../services/api-logger';
import { chatWithFallback, getFallbackOpenAI, FALLBACK_OPENAI_MODEL, FALLBACK_ANTHROPIC_API_KEY, FALLBACK_ANTHROPIC_BASE_URL, FALLBACK_ANTHROPIC_MODEL } from '../llm-fallback';

export class MediumStrategy implements BlogStrategy {
    private openai: OpenAI;

    constructor(openai: OpenAI) {
        this.openai = openai;
    }

    /**
     * Update index.html to include a new demo file link with title
     */
    private updateIndexHtml(demosDir: string, newFilename: string, title: string): void {
        const indexPath = path.join(demosDir, 'index.html');

        if (!fs.existsSync(indexPath)) {
            console.log('Warning: index.html not found, skipping update');
            return;
        }

        const indexContent = fs.readFileSync(indexPath, 'utf-8');

        // Find the demos array in the JavaScript
        const demosArrayMatch = indexContent.match(/const demos = \[([\s\S]*?)\];/);
        if (!demosArrayMatch) {
            console.log('Warning: Could not find demos array in index.html');
            return;
        }

        // Check if the file is already in the list
        if (indexContent.includes(newFilename)) {
            console.log('Info: Demo already in index.html');
            return;
        }

        // Escape title for JSON (handle quotes and special chars)
        const escapedTitle = title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        // Add new entry object to the beginning of the array
        const newEntry = `\n            { filename: '${newFilename}', title: '${escapedTitle}' },`;
        const updatedContent = indexContent.replace(
            /const demos = \[/,
            `const demos = [${newEntry}`
        );

        fs.writeFileSync(indexPath, updatedContent, 'utf-8');
        console.log('Updated index.html with new demo:', title);
    }

    /**
     * Upload files to remote server via SFTP
     */
    private async uploadViaScp(localPath: string, remotePath: string): Promise<void> {
        const host = process.env.SCP_HOST;
        const port = parseInt(process.env.SCP_PORT || '22', 10);
        const username = process.env.SCP_USERNAME;
        const password = process.env.SCP_PASSWORD;
        const remoteBasePath = process.env.SCP_REMOTE_PATH || '/data/';

        if (!host || !username || !password) {
            console.log('Warning: SCP credentials not configured in .env, skipping upload');
            return;
        }

        const fullRemotePath = `${remoteBasePath}${remotePath}`;

        // Dynamic import to avoid Turbopack build issues
        const SftpClient = (await import('ssh2-sftp-client')).default;
        const sftp = new SftpClient();

        try {
            await sftp.connect({
                host,
                port,
                username,
                password
            });

            await sftp.put(localPath, fullRemotePath);
            console.log(`Uploaded ${path.basename(localPath)} to ${host}:${fullRemotePath}`);
        } catch (error) {
            const err = error as Error;
            console.error('SFTP upload failed:', err.message);
            throw error;
        } finally {
            await sftp.end();
        }
    }

    /**
     * Upload demo files to remote server
     */
    private async uploadDemoFiles(demosDir: string, demoFilename: string): Promise<void> {
        try {
            // Upload the new demo HTML
            const demoPath = path.join(demosDir, demoFilename);
            await this.uploadViaScp(demoPath, demoFilename);

            // Upload the updated index.html
            const indexPath = path.join(demosDir, 'index.html');
            if (fs.existsSync(indexPath)) {
                await this.uploadViaScp(indexPath, 'index.html');
            }
        } catch (error) {
            console.error('Failed to upload demo files:', error);
            // Don't throw - upload failure shouldn't break the generation flow
        }
    }

    /**
     * Generate demo HTML using Claude Agent SDK, with DeepSeek as fallback.
     */
    private async generateDemoWithClaude(englishContent: string): Promise<{ content: string; filename: string }> {
        const demosDir = path.join(process.cwd(), 'public', 'demos');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `demo-${timestamp}.html`;
        const filepath = path.join(demosDir, filename);

        const options: Options = {
            allowedTools: ['Write', 'Bash'],
            model: process.env.MODEL_ID,
            systemPrompt: `You are a frontend developer creating an educational demo page. Create a self-contained HTML file that demonstrates concepts from the article in a "code snippet -> live showcase" format.

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
- Showcases should have a distinct visual container
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

        logApi('claude', 'MediumStrategy.generateDemo start', {
            provider: 'claude',
            filepath,
            inputChars: englishContent.length,
        });

        try {
            for await (const message of query({ prompt, options })) {
                if (message.type === 'assistant') {
                    for (const block of message.message.content) {
                        if (block.type === 'text') {
                            demoContent += block.text;
                        }
                    }
                } else if (message.type === 'result' && message.subtype === 'success') {
                    console.log('📝 Agent completed:', message.result);
                }
            }
        } catch (claudeErr) {
            console.warn('[MediumStrategy] Claude failed, falling back to DeepSeek:', claudeErr);
            logApi('claude', 'MediumStrategy.generateDemo fallback to deepseek', {
                error: String(claudeErr),
                filepath,
            });
            // Fall back to OpenAI-compatible deepseek endpoint
            return this.generateDemoWithOpenAi(englishContent, getFallbackOpenAI(), FALLBACK_ANTHROPIC_MODEL);
        }

        if (fs.existsSync(filepath)) {
            const demo = fs.readFileSync(filepath, 'utf-8');
            logApi('claude', 'MediumStrategy.generateDemo ok', {
                provider: 'claude',
                outputChars: demo.length,
                filepath,
            });
            console.log('Demo saved by agent to:', filepath);
            console.log('   Accessible at: /demos/' + filename);
            return { content: demo, filename };
        }

        let demo = demoContent.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();

        if (!fs.existsSync(demosDir)) {
            fs.mkdirSync(demosDir, { recursive: true });
        }

        if (demo) {
            fs.writeFileSync(filepath, demo, 'utf-8');
            console.log('Demo saved to:', filepath);
            console.log('   Accessible at: /demos/' + filename);
        }

        logApi('claude', 'MediumStrategy.generateDemo ok', {
            provider: 'claude',
            outputChars: demo.length,
            filepath,
            fallbackTextOutput: true,
        });

        return { content: demo, filename };
    }

    /**
     * Generate demo HTML with OpenAI and persist it locally.
     * Accepts an optional openaiClient and model override for fallback use.
     */
    private async generateDemoWithOpenAi(
        englishContent: string,
        openaiClient?: OpenAI,
        modelOverride?: string
    ): Promise<{ content: string; filename: string }> {
        const demosDir = path.join(process.cwd(), 'public', 'demos');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `demo-${timestamp}.html`;
        const filepath = path.join(demosDir, filename);

        // Ensure demos directory exists
        if (!fs.existsSync(demosDir)) {
            fs.mkdirSync(demosDir, { recursive: true });
        }

        const client = openaiClient ?? this.openai;
        const demoModel = modelOverride ?? 'gpt-5.4';
        const systemPrompt = `You are a frontend developer creating an educational demo page. Return only a complete self-contained HTML document.

STRUCTURE REQUIREMENTS:
- Organize the page as a series of sections, each containing:
  1. A heading describing the concept
  2. The code snippet shown in a <pre><code> block with syntax highlighting
  3. Immediately followed by a live interactive showcase demonstrating that exact code
- Use clear visual separation between sections with borders, backgrounds, and spacing
- Each showcase must directly correspond to the code snippet above it

VISUAL DESIGN:
- Use a clean, modern design with good typography
- Code blocks should have syntax highlighting with a dark background
- Showcases should have a distinct visual container
- Add "Code:" and "Result:" labels

TECHNICAL REQUIREMENTS:
- Self-contained HTML with embedded CSS and JavaScript
- Use modern CSS and semantic HTML
- Make showcases interactive where useful
- Ensure code shown in <pre> blocks matches the actual implementation in showcases
- Do not reference external assets or libraries
- Return HTML only, no markdown fences or explanation`;

        const userPrompt = `Create a demo page for this article:\n\n${englishContent}`;

        let t0 = Date.now();
        logApi('openai', 'MediumStrategy.generateDemo start', {
            model: demoModel,
            inputChars: englishContent.length,
        });
        const demoResponse = await chatWithFallback(client, {
            model: demoModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        });
        let demo = demoResponse.choices?.[0]?.message?.content || '';
        logOpenAiRawResponseIfEmpty('MediumStrategy.generateDemo', demo.length, demoResponse);
        logApi('openai', 'MediumStrategy.generateDemo ok', {
            model: demoModel,
            durationMs: Date.now() - t0,
            outputChars: demo.length,
        });

        demo = demo.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();

        if (demo) {
            fs.writeFileSync(filepath, demo, 'utf-8');
            console.log('Demo saved to:', filepath);
            console.log('   Accessible at: /demos/' + filename);
        }

        return { content: demo, filename };
    }

    private getDemoProvider(): 'claude' | 'openai' {
        const raw = process.env.MEDIUM_DEMO_PROVIDER?.trim().toLowerCase();
        return raw === 'openai' ? 'openai' : 'claude';
    }

    private async generateDemo(englishContent: string): Promise<{ content: string; filename: string }> {
        const provider = this.getDemoProvider();
        logApi('api', 'MediumStrategy.generateDemo provider selected', { provider });
        if (provider === 'openai') {
            return this.generateDemoWithOpenAi(englishContent);
        }
        return this.generateDemoWithClaude(englishContent);
    }

    async generate(content: string): Promise<{ content: string; demo?: string }> {
        const model = process.env.OPENAI_MODEL ?? 'gpt-5.4';
        let t0 = Date.now();
        logApi('openai', 'MediumStrategy.translate start', { model, inputChars: content.length });
        const translateResponse = await chatWithFallback(this.openai, {
            model,
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
        const englishContent = translateResponse.choices?.[0]?.message?.content || '';
        logOpenAiRawResponseIfEmpty('MediumStrategy.translate', englishContent.length, translateResponse);
        logApi('openai', 'MediumStrategy.translate ok', {
            model,
            durationMs: Date.now() - t0,
            outputChars: englishContent.length,
        });

        t0 = Date.now();
        logApi('openai', 'MediumStrategy.detectTechnical start', { model });
        const detectResponse = await chatWithFallback(this.openai, {
            model,
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
        const detectMsg = detectResponse.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('MediumStrategy.detectTechnical', detectMsg.trim().length, detectResponse);
        const isTechnical = detectMsg.trim().toUpperCase().includes('YES');
        logApi('openai', 'MediumStrategy.detectTechnical ok', {
            model,
            durationMs: Date.now() - t0,
            isTechnical: !!isTechnical,
            detectPreview: detectMsg.replace(/\s+/g, ' ').trim().slice(0, 200),
        });

        let demo = undefined;
        let demoFilename = '';
        let demoCodeExamples = '';

        if (isTechnical) {
            // 3. Generate demo first for technical content using the configured provider.
            const demoResult = await this.generateDemo(englishContent);
            demo = demoResult.content;
            demoFilename = demoResult.filename;

            // 4. Extract code examples from the demo
            demoCodeExamples = `\n\nHere is the working demo code that was generated:\n\`\`\`html\n${demo}\n\`\`\`\n\nUse relevant snippets from this code to create practical code examples in the article.`;
        }

        t0 = Date.now();
        logApi('openai', 'MediumStrategy.formatArticle start', {
            model,
            isTechnical: !!isTechnical,
            englishChars: englishContent.length,
        });
        const formatResponse = await chatWithFallback(this.openai, {
            model,
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
        let mediumContent = formatResponse.choices?.[0]?.message?.content || '';
        logOpenAiRawResponseIfEmpty('MediumStrategy.formatArticle', mediumContent.length, formatResponse);
        logApi('openai', 'MediumStrategy.formatArticle ok', {
            model,
            durationMs: Date.now() - t0,
            outputChars: mediumContent.length,
        });

        // 6. Update index.html and upload if a demo was generated
        if (demo && demoFilename) {
            // Extract title from the formatted blog (first # heading)
            const titleMatch = mediumContent.match(/^#\s+(.+)$/m);
            const blogTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Demo';

            // Update index.html with title and upload files
            const demosDir = path.join(process.cwd(), 'public', 'demos');
            this.updateIndexHtml(demosDir, demoFilename, blogTitle);
            await this.uploadDemoFiles(demosDir, demoFilename);

            const demoPublicUrl = `https://www.bitstripe.cn/files/${demoFilename}`;

            // 7. Generate demo GIFs for each insertion slot and embed into markdown
            mediumContent = await this.injectDemoGifs(
                mediumContent,
                demo,
                path.join(demosDir, demoFilename),
                demoPublicUrl
            );

            // 8. Add demo footer
            const demoFooter = `

---

### Try It Yourself

Want to see these concepts in action? I've created an **interactive demo** where you can experiment with the code and see real-time results.

**[View the Live Demo](${demoPublicUrl})**

Explore more demos from my previous articles in the **[Demo Gallery](https://www.bitstripe.cn/files/index.html)**.

*Happy coding!*`;

            mediumContent += demoFooter;
        }

        // 9. Generate cover image and prepend to markdown
        mediumContent = await this.addCoverImage(mediumContent);

        return { content: mediumContent, demo };
    }

    /**
     * Find DEMO_SCREENSHOT_PLACEHOLDER slots in the markdown, generate a GIF for each
     * via the rrweb pipeline, upload to bitstripe, and replace the slot with the GIF
     * plus a link to the live demo. Failures are silently skipped.
     */
    private async injectDemoGifs(
        markdown: string,
        demoHtml: string,
        demoLocalPath: string,
        demoPublicUrl: string
    ): Promise<string> {
        let result = markdown;

        try {
            const slots = await findDemoInsertionSlots(result, this.openai);
            if (slots.length === 0) {
                console.log('[MediumStrategy] No demo insertion slots found, skipping GIF generation');
                return result;
            }

            const gifDir = path.join(os.tmpdir(), `medium-gifs-${Date.now()}`);
            fs.mkdirSync(gifDir, { recursive: true });

            for (const slot of slots) {
                try {
                    console.log(`[MediumStrategy] Generating GIF for slot ${slot.index}: ${slot.contextDescription.substring(0, 60)}...`);

                    const steps = await planInteractionSteps(
                        result,
                        demoHtml,
                        slot.contextDescription,
                        this.openai
                    );

                    const gifPath = path.join(gifDir, `demo-gif-${slot.index}-${Date.now()}.gif`);
                    const localGifPath = await generateGifForDemo(demoLocalPath, steps, gifPath);

                    if (!localGifPath) {
                        console.warn(`[MediumStrategy] GIF generation failed for slot ${slot.index}, skipping`);
                        // Remove the placeholder from markdown without inserting anything
                        result = replaceSlotInMarkdown(result, slot, '');
                        continue;
                    }

                    const gifUrl = await uploadToBitstripe(localGifPath).catch((err) => {
                        console.warn(`[MediumStrategy] GIF upload failed for slot ${slot.index}:`, err);
                        return null;
                    });

                    if (!gifUrl) {
                        result = replaceSlotInMarkdown(result, slot, '');
                        fs.unlink(localGifPath, () => {});
                        continue;
                    }

                    // Replace placeholder with GIF + demo callout
                    const gifMarkdown = `![Demo animation](${gifUrl})\n\n> 🎮 **Try it live:** [Open the interactive demo](${demoPublicUrl}) to experience this yourself.`;
                    result = replaceSlotInMarkdown(result, slot, gifMarkdown);

                    console.log(`[MediumStrategy] ✓ GIF slot ${slot.index} inserted: ${gifUrl}`);
                    fs.unlink(localGifPath, () => {});
                } catch (slotErr) {
                    console.error(`[MediumStrategy] Slot ${slot.index} failed:`, slotErr);
                    result = replaceSlotInMarkdown(result, slot, '');
                }
            }
        } catch (err) {
            console.error('[MediumStrategy] injectDemoGifs failed entirely:', err);
        }

        return result;
    }

    /**
     * Generate a cover image for the article, upload to bitstripe, and prepend
     * it to the markdown. Gracefully skips if generation/upload fails.
     */
    private async addCoverImage(markdown: string): Promise<string> {
        try {
            const tmpDir = os.tmpdir();
            const coverPath = await generateCoverImage(markdown, this.openai, tmpDir);
            if (!coverPath) return markdown;

            const coverUrl = await uploadToBitstripe(coverPath).catch((err) => {
                console.warn('[MediumStrategy] Cover upload failed:', err);
                return null;
            });

            fs.unlink(coverPath, () => {});

            if (!coverUrl) return markdown;

            // Prepend cover image after the first H1 heading (or at the very top)
            const h1Match = markdown.match(/^(#\s+.+)$/m);
            if (h1Match) {
                const idx = markdown.indexOf(h1Match[0]) + h1Match[0].length;
                const coverBlock = `\n\n![Cover Image](${coverUrl})\n`;
                return markdown.slice(0, idx) + coverBlock + markdown.slice(idx);
            }
            return `![Cover Image](${coverUrl})\n\n` + markdown;
        } catch (err) {
            console.error('[MediumStrategy] addCoverImage failed:', err);
            return markdown;
        }
    }
}
