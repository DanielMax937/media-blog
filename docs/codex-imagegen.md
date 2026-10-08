# Native Codex image generation

## Scope and two independent paths

Medium cover images and Rednote/XHS slides use **only native Codex image generation**.
The application launches `codex app-server --listen stdio://` as a CLI subprocess,
not an Agent-im HTTP image endpoint. The existing text, image-prompt planning,
Medium demos, uploads, publishing and Telegram paths are unchanged.

The chat endpoint and image backend are separate configuration surfaces:

- `OPENAI_*` / fallback chat settings still select text generation.
- `CODEX_IMAGE_*` settings select the native CLI image subprocess.

`AgentImService` and `GoogleImageService` may still exist for independent callers,
but neither is a fallback or selector for these two image workflows.
`GOOGLE_IMAGE_USE_DIRECT_API` therefore does not override Medium/XHS images.
The legacy `isWebgeminiAvailable` export is only a compatibility alias for the
Codex login check, not a browser/WebGemini request.

## Prerequisites

Tested with Codex CLI **0.159.2**, Node.js and the existing ChatGPT CLI login.
The CLI must support the experimental app-server image item protocol.
Run `codex login status` as the same macOS user as the service; the backend
requires `Logged in using ChatGPT`. No OpenAI API key is needed for this path.
The subprocess explicitly removes `OPENAI_API_KEY` and `OPENAI_BASE_URL`, and
never silently switches to the Images API or Agent-im.

```dotenv
# Optional absolute binary path when launchd has a minimal PATH:
CODEX_IMAGE_CLI=/Users/caoxiaopeng/.npm-global/bin/codex
# Optional child-process-only proxy; otherwise inherit HTTP(S)_PROXY:
CODEX_IMAGE_PROXY=http://127.0.0.1:1087
# Default 15 minutes; allowed range 1000..1800000 milliseconds:
CODEX_IMAGE_TIMEOUT_MS=900000
# Optional orchestration-model/effort overrides, not an image API model name:
# CODEX_IMAGE_MODEL=gpt-6.1-sol
# CODEX_IMAGE_REASONING_EFFORT=ultra
```

Without explicit model/effort overrides, the service reads those two fields from
the device's `CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The native
image tool chooses its image-generation backend; a chat model label is not an
image-model selector. Authentication uses the existing Codex home. MCP servers,
plugins, apps, hooks, shell tools, multi-agent tools and web search are disabled
for the subprocess. Existing MCP names are read locally, then each whole server
definition is replaced by a valid disabled entry for both CLI bootstrap and thread
configuration. An empty MCP table alone does not disable inherited servers.
Parent Codex session variables are not passed on, and localhost bypasses the proxy.
The ephemeral thread uses a read-only sandbox, no approvals
and native-image-only instructions; it must not publish or inspect credentials.

## Success, safety and failures

Each image submits one turn. Calls are serialized within the server process,
including Next.js hot reloads. The app-server must advertise native image
generation, emit exactly one `imageGeneration` completed item without failure,
and complete the same turn. Exit code zero, assistant prose or a filename alone
is not evidence of image success.

The service accepts the native item's `savedPath` or its PNG base64 `result`.
Saved paths must be fresh regular files within the per-call temporary directory
or Codex's `generated_images` directory; symlinks and unrelated paths are rejected.
PNG bytes are bounded and fully decoded. `sharp` normalizes a new copy to the
established output layouts: Medium **1536 × 864**, XHS **1024 × 1365**.
Essential content should stay away from edges because normalization uses a cover crop.
Native images in Codex's generated-images cache are retained; the worker's owned
temporary directory is removed only after its process closes. Output is published atomically with mode
0600; an existing output file is never overwritten.

There is **no automatic image retry or alternate backend**, including on timeout,
disconnect or local save failure: the upstream image may already exist. A timeout
terminates only that call's owned CLI process group. If termination cannot be
confirmed, the call fails within a bounded grace period and subsequent image calls
are blocked until the original process closes, preventing uncertain overlap.
Medium keeps its existing
`null`-on-cover-failure behavior. XHS preserves exactly three planned slides in
cover → content → ending order and returns successful slides only; a failed slide
does not prevent later slides from being attempted once.

Logs include backend, basename, duration and dimensions, not raw CLI stderr,
image base64, prompts, account data or keys. The CLI is experimental: re-run the
isolated acceptance after upgrading its protocol.

## Isolated verification (no publication)

Install development dependencies, then use these fully mocked tests:

```bash
npx jest --runInBand --runTestsByPath \
  __tests__/services/CodexImageService.test.ts \
  __tests__/services/CoverImageService.test.ts \
  __tests__/services/XhsImageService.test.ts \
  __tests__/services/AgentImSlides.test.ts \
  __tests__/services/AgentImImageRetries.test.ts \
  __tests__/strategies/RednoteStrategy.test.ts
npx tsc --noEmit --incremental false
```

Live acceptance requires the explicit `--live` argument and consumes Codex
image-generation usage. It invokes only the image wrappers, with fixed offline
text planning, and verifies one Medium cover plus all three XHS slides. It does
not start full jobs, upload files, publish articles or send Telegram notifications.
Use a new output directory for each intentional run; do not automatically replay
failed/unknown calls.

```bash
CODEX_IMAGE_PROXY=http://127.0.0.1:1087 \
  node scripts/verify-codex-images.cjs --live /absolute/new/acceptance-directory
```

Inspect `manifest.json` and `image-verification.log` in that directory. Never use
the unrestricted full Jest suite as live acceptance: unrelated publication tests
may have side effects unless their publishers/transports are explicitly mocked.

## Verified 2026-10-09

- Codex CLI 0.159.2 with the existing ChatGPT login and local HTTP proxy.
- All 104 scoped offline tests, TypeScript checking and Next.js webpack production build passed.
- Real image-only acceptance produced a Medium cover and all three ordered XHS
  slides; every PNG was fully decoded, dimensions and 0600 permissions verified,
  and SHA256 receipts recorded. Text planning was fixed/offline; no publishing,
  uploads or Telegram occurred.
- A further distinct native image completed using the final patched service and
  strict thread/turn checks. During its real generation, the only child of the
  native app-server was its code-mode host; no third-party MCP processes started.
- Native generation latency varied substantially in this run (approximately
  1–15 minutes per image). An accepted upstream request is not yet a completed
  image, and waiting/timeout must not cause an automatic duplicate submission.
