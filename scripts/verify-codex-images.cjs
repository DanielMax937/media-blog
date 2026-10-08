#!/usr/bin/env node
/** Explicit image-only live acceptance. No jobs, publishing, uploads or notifications. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const sharp = require('sharp');

if (process.argv[2] !== '--live' || process.argv.length > 4) {
    console.log('Usage: node scripts/verify-codex-images.cjs --live [absolute-output-directory]');
    console.log('Generates four real images using the logged-in Codex account. No publication or Telegram.');
    process.exit(process.argv.includes('--help') ? 0 : 2);
}
const requestedDir = process.argv[3];
if (requestedDir && !path.isAbsolute(requestedDir)) throw new Error('Output directory must be absolute');
if (requestedDir && fs.existsSync(requestedDir)) throw new Error('Use a new output directory; existing runs must not be replayed');
const outputDir = requestedDir || fs.mkdtempSync(path.join(os.tmpdir(), 'blog2media-native-acceptance-'));
if (requestedDir) fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
process.env.BLOG2MEDIA_LOG_FILE = path.join(outputDir, 'image-verification.log');
fs.writeFileSync(process.env.BLOG2MEDIA_LOG_FILE, '', { flag: 'wx', mode: 0o600 });

// Load project TS without starting Next.js. Only text planning is stubbed; image generation is real.
require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    module._compile(output, filename);
};
const llmPath = require.resolve('../lib/llm-fallback.ts');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
    getPrimaryOpenAIModel: () => undefined,
    describeOpenAIModel: () => 'fixed-offline-visual-prompt',
    chatWithFallback: async () => ({ choices: [{ message: { content:
        'Professional editorial illustration of a small creative studio with a laptop and three beautiful '
        + 'illustration boards, warm amber and navy palette, clean modern composition, no logos, '
        + 'no text or watermarks, keep important subjects in the center, 16:9 aspect ratio.' } }] }),
} };
const { generateCoverImage } = require('../lib/services/CoverImageService.ts');
const { generateXhsImages } = require('../lib/services/XhsImageService.ts');

async function inspect(filename, width, height, label) {
    const bytes = fs.readFileSync(filename);
    const metadata = await sharp(bytes, { failOn: 'warning' }).metadata();
    await sharp(bytes, { failOn: 'warning' }).raw().toBuffer();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height) {
        throw new Error(`${label}: invalid PNG dimensions`);
    }
    if ((fs.statSync(filename).mode & 0o777) !== 0o600) throw new Error(`${label}: image must have mode 0600`);
    return { label, path: filename, width, height, bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
    console.log(`Image-only live acceptance output: ${outputDir}`);
    console.log('1/4: Medium cover; native Codex call, fixed offline prompt planning.');
    const cover = await generateCoverImage('# Native illustration verification', {}, outputDir);
    if (!cover) throw new Error('Medium cover failed; do not automatically replay an unknown outcome');
    const results = [await inspect(cover, 1536, 864, 'medium-cover')];
    console.log('Medium PNG verified. 2–4/4: XHS cover, content, ending, serial native calls.');
    const images = await generateXhsImages({ slug: `native-check-${Date.now()}`, images: [
        { type: 'cover', prompt: 'Cute polished editorial illustration of a friendly robot artist arranging '
            + 'three colorful visual idea cards in a bright creative studio, pastel cream and coral, '
            + 'strong central hook, no text, logos or watermarks, keep essential subjects centered, Aspect ratio: 3:4.' },
        { type: 'content', prompt: 'Cute polished editorial illustration of a friendly robot artist checking '
            + 'one beautiful finished picture with a magnifying glass, clear focal point and simple spacious '
            + 'pastel cream and mint background, no text, logos or watermarks, keep essential subjects centered, Aspect ratio: 3:4.' },
        { type: 'ending', prompt: 'Cute polished editorial illustration of a friendly robot artist proudly '
            + 'presenting three finished illustration boards, gentle celebratory confetti, pastel cream and '
            + 'lavender, cheerful summary composition, no text, logos or watermarks, keep essential subjects centered, Aspect ratio: 3:4.' },
    ] });
    for (const [index, image] of images.entries()) {
        const destination = path.join(outputDir, path.basename(image));
        fs.copyFileSync(image, destination, fs.constants.COPYFILE_EXCL);
        results.push(await inspect(destination, 1024, 1365, `xhs-${index + 1}`));
    }
    const manifest = { backend: 'codex-cli-native-imagegen', textPlanning: 'offline-fixed-prompts',
        publishing: false, notifications: false, completedAt: new Date().toISOString(),
        success: results.length === 4, results };
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (!manifest.success) throw new Error(`XHS incomplete: ${images.length}/3; no automatic replay`);
    console.log(JSON.stringify(manifest, null, 2));
}
main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Image verification failed');
    process.exitCode = 1;
});
