import { ProxyAgent, fetch as undiciFetch } from 'undici';

const MAX_MESSAGE_LENGTH = 4096;

function getProxyUrl(): string | undefined {
    return (
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy ??
        process.env.CTI_PROXY ??
        undefined
    );
}

function getToken(): string {
    return (
        process.env.TELEGRAM_BOT_TOKEN?.trim() ??
        process.env.CTI_TG_BOT_TOKEN?.trim() ??
        ''
    );
}

function getChatId(): string {
    return (
        process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ??
        process.env.CTI_TG_CHAT_ID?.trim() ??
        ''
    );
}

function splitText(text: string): string[] {
    if (!text) return [''];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
        chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
}

export async function sendTelegramMessage(text: string): Promise<void> {
    const token = getToken();
    const chatId = getChatId();

    if (!token) throw new Error('Missing env: TELEGRAM_BOT_TOKEN or CTI_TG_BOT_TOKEN');
    if (!chatId) throw new Error('Missing env: TELEGRAM_ALLOWED_CHAT_ID or CTI_TG_CHAT_ID');

    const proxyUrl = getProxyUrl();
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

    for (const chunk of splitText(text)) {
        const res = await undiciFetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: chunk,
                disable_web_page_preview: false,
            }),
            ...(dispatcher ? { dispatcher } : {}),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Telegram API ${res.status}: ${body}`);
        }
    }
}

export async function sendJobNotification(params: {
    platform: 'rednote' | 'medium' | 'futures';
    status: 'completed' | 'failed';
    jobId: string;
    sourceUrl: string;
    mdUrl?: string | null;
    imageUrls?: string[];
    artifactUrls?: string[];
    localArtifactPaths?: string[];
    error?: string | null;
}): Promise<void> {
    const lines = [
        `blog2media ${params.platform} job ${params.status}`,
        `jobId: ${params.jobId}`,
        `source: ${params.sourceUrl}`,
    ];

    if (params.mdUrl) lines.push(`md: ${params.mdUrl}`);

    // `??` does not treat `[]` as missing: when markdown has no http URLs, callers pass
    // `artifactUrls: []` and we must still show `imageUrls` (e.g. Rednote XHS uploads).
    const artifacts = [
        ...new Set([...(params.artifactUrls ?? []), ...(params.imageUrls ?? [])]),
    ];
    if (artifacts?.length) {
        lines.push(`artifacts (${artifacts.length}):`);
        for (const url of artifacts) lines.push(url);
    }

    if (params.localArtifactPaths?.length) {
        lines.push(`local artifacts (${params.localArtifactPaths.length}):`);
        for (const localPath of params.localArtifactPaths) lines.push(localPath);
    }

    if (params.error) lines.push(`error: ${params.error}`);

    await sendTelegramMessage(lines.join('\n'));
}
