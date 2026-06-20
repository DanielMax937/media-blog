import OpenAI from 'openai';
import { logApi, logApiError, logOpenAiRawResponseIfEmpty } from './api-logger';
import { chatWithFallback, describeOpenAIModel, getPrimaryOpenAIModel } from '../llm-fallback';

export interface DemoInsertionSlot {
    /** The exact placeholder text to replace in the markdown */
    placeholder: string;
    /** Surrounding context describing what this slot is about */
    contextDescription: string;
    /** Zero-based index of this slot in the markdown */
    index: number;
}

/**
 * Scans the markdown for DEMO_SCREENSHOT_PLACEHOLDER markers and returns
 * a slot for each one, enriched with surrounding context.
 *
 * If no placeholders exist, falls back to an LLM call to identify 1-3 good
 * locations for a demo GIF and returns synthetic slot descriptors
 * (using a unique sentinel string so the caller can do a simple replace).
 */
export async function findDemoInsertionSlots(
    markdown: string,
    openai: OpenAI
): Promise<DemoInsertionSlot[]> {
    const placeholderRegex = /!\[([^\]]*)\]\(DEMO_SCREENSHOT_PLACEHOLDER\)/g;
    const slots: DemoInsertionSlot[] = [];
    let match: RegExpExecArray | null;
    let matchIndex = 0;

    while ((match = placeholderRegex.exec(markdown)) !== null) {
        // Grab ±200 chars of surrounding context
        const start = Math.max(0, match.index - 200);
        const end = Math.min(markdown.length, match.index + match[0].length + 200);
        const surroundingContext = markdown.slice(start, end);

        slots.push({
            placeholder: match[0],
            contextDescription: `Alt text: "${match[1]}". Context: ${surroundingContext}`,
            index: matchIndex++,
        });
    }

    if (slots.length > 0) {
        console.log(`[MarkdownDemoInserter] Found ${slots.length} DEMO_SCREENSHOT_PLACEHOLDER(s)`);
        return slots;
    }

    // Fallback: ask LLM to identify insertion points
    console.log('[MarkdownDemoInserter] No placeholders found, asking LLM for insertion points');
    return await findInsertionPointsViaLlm(markdown, openai);
}

/**
 * Unique sentinel format used for LLM-derived insertion slots so MediumStrategy
 * can later do a simple string replace.
 */
const SENTINEL_PREFIX = '![Demo GIF](DEMO_GIF_SLOT_';

async function findInsertionPointsViaLlm(
    markdown: string,
    openai: OpenAI
): Promise<DemoInsertionSlot[]> {
    const systemPrompt = `You are a technical article editor. Identify 1-3 locations in the article
where an animated GIF demonstrating the code/concept would add the most value.

Return strict JSON:
{
  "insertions": [
    {
      "afterText": "exact last 60 characters of the paragraph/section after which to insert the GIF",
      "description": "what the demo GIF should show at this point"
    }
  ]
}

Rules:
- Choose locations right after a code block or after explaining a complex concept
- Do NOT choose the very beginning or very end of the article
- Return at most 3 insertions
- "afterText" must be verbatim text from the markdown`;

    const model = getPrimaryOpenAIModel();
    const modelLog = describeOpenAIModel(model);
    const t0 = Date.now();
    logApi('openai', 'MarkdownDemoInserter.findInsertionPointsViaLlm start', {
        model: modelLog,
        markdownChars: markdown.length,
    });
    try {
        const response = await chatWithFallback(openai, {
            model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Article:\n\n${markdown.substring(0, 6000)}` },
            ],
        });

        const rawMsg = response.choices?.[0]?.message?.content ?? '';
        logOpenAiRawResponseIfEmpty('MarkdownDemoInserter.findInsertionPointsViaLlm', rawMsg.length, response);
        const raw = rawMsg || '{}';
        const parsed = JSON.parse(raw) as {
            insertions?: Array<{ afterText: string; description: string }>;
        };

        if (!Array.isArray(parsed.insertions) || parsed.insertions.length === 0) {
            logApi('openai', 'MarkdownDemoInserter.findInsertionPointsViaLlm empty insertions', {
                model: modelLog,
                durationMs: Date.now() - t0,
            });
            return [];
        }

        const slots = parsed.insertions.slice(0, 3).map((ins, i) => {
            const placeholder = `${SENTINEL_PREFIX}${i})`;
            return {
                placeholder,
                contextDescription: ins.description,
                index: i,
            };
        });
        logApi('openai', 'MarkdownDemoInserter.findInsertionPointsViaLlm ok', {
            model: modelLog,
            durationMs: Date.now() - t0,
            slotCount: slots.length,
        });
        return slots;
    } catch (err) {
        console.warn('[MarkdownDemoInserter] LLM fallback failed:', err);
        logApiError('openai', 'MarkdownDemoInserter.findInsertionPointsViaLlm failed', err, {
            model: modelLog,
            durationMs: Date.now() - t0,
        });
        return [];
    }
}

/**
 * Replace a slot's placeholder in the markdown with the provided replacement string.
 * For LLM-derived slots (no existing placeholder in the text), this is a no-op
 * and returns the original markdown — callers should append the GIF to the article.
 */
export function replaceSlotInMarkdown(
    markdown: string,
    slot: DemoInsertionSlot,
    replacement: string
): string {
    if (markdown.includes(slot.placeholder)) {
        return markdown.replace(slot.placeholder, replacement);
    }
    // LLM-derived slot: append before the footer/last horizontal rule
    const footerIndex = markdown.lastIndexOf('\n---\n');
    if (footerIndex !== -1) {
        return markdown.slice(0, footerIndex) + '\n\n' + replacement + markdown.slice(footerIndex);
    }
    return markdown + '\n\n' + replacement;
}
