/**
 * Normalizes OPENAI_BASE_URL for OpenAI-compatible gateways (e.g. new-api).
 * If the shell overrides .env with a host-only URL (no /v1), requests hit the web SPA and return HTML.
 */
export function getOpenAiBaseUrl(): string | undefined {
    const raw = process.env.OPENAI_BASE_URL?.trim();
    if (!raw) return undefined;
    const collapsed = raw.replace(/\/+$/, '');
    if (collapsed.endsWith('/v1')) return collapsed;
    return `${collapsed}/v1`;
}
