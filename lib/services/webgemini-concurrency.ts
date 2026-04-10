/**
 * webgemini supports concurrent jobs; blog2media caps in-flight work at a fixed maximum
 * so multiple pipelines (e.g. parallel rednote jobs) do not overload the local service.
 */
export const WEBGEMINI_MAX_CONCURRENT = 2;

let inFlight = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
    if (inFlight < WEBGEMINI_MAX_CONCURRENT) {
        inFlight += 1;
        return;
    }
    await new Promise<void>((resolve) => {
        waitQueue.push(() => {
            inFlight += 1;
            resolve();
        });
    });
}

function releaseSlot(): void {
    inFlight -= 1;
    const next = waitQueue.shift();
    if (next) next();
}

/** Runs `fn` while holding one of the WEBGEMINI_MAX_CONCURRENT slots (submit + poll). */
export async function withWebgeminiConcurrency<T>(fn: () => Promise<T>): Promise<T> {
    await acquireSlot();
    try {
        return await fn();
    } finally {
        releaseSlot();
    }
}
