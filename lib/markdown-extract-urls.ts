/**
 * Extract all image URLs from markdown image syntax: ![alt](url)
 */
export function extractImageUrls(markdown: string): string[] {
    const pattern = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
    const urls: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
        urls.push(match[1]);
    }
    return urls;
}

/** Extract all http(s) URLs from markdown (links, images, etc.), unique. */
export function extractAllUrls(markdown: string): string[] {
    if (!markdown) return [];
    const pattern = /https?:\/\/[^\s)\]\">]+/g;
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(markdown)) !== null) {
        matches.add(m[0]);
    }
    return Array.from(matches);
}
