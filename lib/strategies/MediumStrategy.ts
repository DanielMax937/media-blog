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
import { chatWithFallback, describeOpenAIModel, getFallbackOpenAI, getPrimaryOpenAIModel, FALLBACK_ANTHROPIC_MODEL } from '../llm-fallback';

const DEFAULT_DEMO_OPENAI_TIMEOUT_MS = 5 * 60 * 1000;

function getPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function compactText(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

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

        const demo = demoContent.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();

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

    private generateFallbackDemo(englishContent: string, reason: string): { content: string; filename: string } {
        const demosDir = path.join(process.cwd(), 'public', 'demos');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `demo-${timestamp}.html`;
        const filepath = path.join(demosDir, filename);

        if (!fs.existsSync(demosDir)) {
            fs.mkdirSync(demosDir, { recursive: true });
        }

        const title = escapeHtml(compactText(
            englishContent.split(/\n+/).map(line => line.trim()).find(Boolean) || 'Interactive JavaScript Demo',
            90
        ));
        const summary = escapeHtml(compactText(englishContent, 280));
        const demo = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #18202a; }
    main { max-width: 920px; margin: 0 auto; padding: 40px 20px 56px; }
    section { background: #fff; border: 1px solid #d9dde5; border-radius: 8px; padding: 24px; margin-top: 18px; }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; }
    h2 { font-size: 20px; margin: 0 0 14px; }
    p { line-height: 1.6; margin: 0; }
    pre { overflow: auto; background: #101722; color: #d9e6f2; border-radius: 6px; padding: 16px; }
    code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; }
    .showcase { display: grid; gap: 12px; margin-top: 14px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; }
    input { flex: 1 1 260px; min-height: 40px; border: 1px solid #c3cad6; border-radius: 6px; padding: 0 12px; font: inherit; }
    button { min-height: 40px; border: 0; border-radius: 6px; padding: 0 14px; background: #1769e0; color: #fff; font-weight: 650; cursor: pointer; }
    button:hover { background: #0f55b6; }
    .event-card { border: 1px solid #cfe0ff; background: #eef5ff; border-radius: 6px; padding: 14px; }
    .log { min-height: 90px; border: 1px solid #d8dde7; background: #fbfcfe; border-radius: 6px; padding: 12px; white-space: pre-wrap; }
    .label { font-size: 12px; font-weight: 700; text-transform: uppercase; color: #566273; margin-bottom: 8px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${title}</h1>
      <p>${summary}</p>
    </section>
    <section>
      <h2>Code: Dispatching a CustomEvent</h2>
      <pre><code>const event = new CustomEvent('show', {
  detail: { message: payload, sentAt: new Date().toLocaleTimeString() }
});

window.dispatchEvent(event);</code></pre>
      <div class="label">Result</div>
      <div class="showcase">
        <div class="controls">
          <input id="payload" value="Hello from a CustomEvent">
          <button id="dispatch">Dispatch event</button>
        </div>
        <div class="event-card" id="latest">Waiting for an event...</div>
      </div>
    </section>
    <section>
      <h2>Code: Listening for the Event Payload</h2>
      <pre><code>window.addEventListener('show', (event) => {
  render(event.detail.message, event.detail.sentAt);
});</code></pre>
      <div class="label">Event log</div>
      <div class="log" id="event-log">No events yet.</div>
    </section>
  </main>
  <script>
    const input = document.querySelector('#payload');
    const latest = document.querySelector('#latest');
    const log = document.querySelector('#event-log');
    const history = [];

    document.querySelector('#dispatch').addEventListener('click', () => {
      const message = input.value.trim() || 'Default CustomEvent payload';
      const event = new CustomEvent('show', {
        detail: { message, sentAt: new Date().toLocaleTimeString() }
      });
      window.dispatchEvent(event);
    });

    window.addEventListener('show', (event) => {
      const detail = event.detail || {};
      latest.textContent = detail.message + ' | sent at ' + detail.sentAt;
      history.unshift('[' + detail.sentAt + '] ' + detail.message);
      log.textContent = history.slice(0, 6).join('\\n');
    });
  </script>
</body>
</html>`;

        fs.writeFileSync(filepath, demo, 'utf-8');
        logApi('api', 'MediumStrategy.generateDemo fallback ok', {
            reason,
            outputChars: demo.length,
            filepath,
        });
        console.log('Demo saved to:', filepath);
        console.log('   Accessible at: /demos/' + filename);
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
        const demoModel = modelOverride ?? getPrimaryOpenAIModel();
        const demoModelLog = describeOpenAIModel(demoModel);
        const requestTimeoutMs = getPositiveIntEnv('MEDIUM_DEMO_OPENAI_TIMEOUT_MS', DEFAULT_DEMO_OPENAI_TIMEOUT_MS);
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

        const t0 = Date.now();
        logApi('openai', 'MediumStrategy.generateDemo start', {
            model: demoModelLog,
            inputChars: englishContent.length,
            timeoutMs: requestTimeoutMs,
        });
        const demoResponse = await chatWithFallback(client, {
            model: demoModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }, {
            timeout: requestTimeoutMs,
            maxRetries: 0,
            providerFallback: false,
        });
        let demo = demoResponse.choices?.[0]?.message?.content || '';
        logOpenAiRawResponseIfEmpty('MediumStrategy.generateDemo', demo.length, demoResponse);
        logApi('openai', 'MediumStrategy.generateDemo ok', {
            model: demoModelLog,
            durationMs: Date.now() - t0,
            outputChars: demo.length,
        });

        demo = demo.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();

        if (!demo) {
            throw new Error('Medium demo generation returned empty content');
        }

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
            try {
                const result = await this.generateDemoWithOpenAi(englishContent);
                if (result.content.trim()) {
                    return result;
                }
                logApi('openai', 'MediumStrategy.generateDemo empty; using fallback demo', {
                    provider,
                    inputChars: englishContent.length,
                });
            } catch (err) {
                const error = err as Error;
                logApi('openai', 'MediumStrategy.generateDemo failed; using fallback demo', {
                    provider,
                    errName: error?.name ?? 'Error',
                    message: String(error?.message ?? err).slice(0, 300),
                    inputChars: englishContent.length,
                });
            }
            return this.generateFallbackDemo(englishContent, 'openai-demo-generation-unavailable');
        }
        try {
            const result = await this.generateDemoWithClaude(englishContent);
            if (result.content.trim()) {
                return result;
            }
            logApi('claude', 'MediumStrategy.generateDemo empty; using fallback demo', {
                provider,
                inputChars: englishContent.length,
            });
        } catch (err) {
            const error = err as Error;
            logApi('claude', 'MediumStrategy.generateDemo failed; using fallback demo', {
                provider,
                errName: error?.name ?? 'Error',
                message: String(error?.message ?? err).slice(0, 300),
                inputChars: englishContent.length,
            });
        }
        return this.generateFallbackDemo(englishContent, 'claude-demo-generation-unavailable');
    }

    async generate(content: string): Promise<{ content: string; demo?: string }> {
        const model = getPrimaryOpenAIModel();
        const modelLog = describeOpenAIModel(model);
        let t0 = Date.now();
        logApi('openai', 'MediumStrategy.translate start', { model: modelLog, inputChars: content.length });
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
            model: modelLog,
            durationMs: Date.now() - t0,
            outputChars: englishContent.length,
        });

        t0 = Date.now();
        logApi('openai', 'MediumStrategy.detectTechnical start', { model: modelLog });
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
            model: modelLog,
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
            model: modelLog,
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
            model: modelLog,
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
            mediumContent = this.ensureDemoScreenshotPlaceholder(mediumContent);
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

    private ensureDemoScreenshotPlaceholder(markdown: string): string {
        if (markdown.includes('DEMO_SCREENSHOT_PLACEHOLDER')) return markdown;

        const placeholder =
            '![Demo showing the interactive result of the preceding code](DEMO_SCREENSHOT_PLACEHOLDER)';
        const codeBlock = markdown.match(/```[\s\S]*?```/);
        if (!codeBlock || codeBlock.index == null) {
            return `${markdown.trimEnd()}\n\n${placeholder}`;
        }

        const insertAt = codeBlock.index + codeBlock[0].length;
        return `${markdown.slice(0, insertAt)}\n\n${placeholder}${markdown.slice(insertAt)}`;
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
