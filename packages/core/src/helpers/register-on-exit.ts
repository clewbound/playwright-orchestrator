// Signals arrive with a limited grace period before the process is force-killed
// (GitHub Actions allows a few seconds on cancellation), so async cleanup is bounded
// rather than awaited indefinitely — a hung storage call must not delay shutdown.
const ASYNC_EXIT_TIMEOUT_MS = 5000;

const callbacks: (() => void)[] = [];
const asyncCallbacks: (() => Promise<void>)[] = [];
let handled = false;

function runCallbacks() {
    for (const callback of callbacks) {
        try {
            callback();
        } catch (err) {
            // Ignore errors during exit handling.
        }
    }
}

async function runAsyncCallbacks() {
    if (asyncCallbacks.length === 0) return;
    const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, ASYNC_EXIT_TIMEOUT_MS).unref();
    });
    await Promise.race([Promise.allSettled(asyncCallbacks.map((callback) => callback())), timeout]);
}

function signalHandler() {
    if (handled) return;
    handled = true;
    runCallbacks();
    // Only signal handlers can await; the 'exit' event runs on a closing event loop.
    runAsyncCallbacks().finally(() => process.exit(1));
}

function exitHandler() {
    if (handled) return;
    handled = true;
    runCallbacks();
}

for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
    process.on(signal, signalHandler);
}

process.on('exit', exitHandler);

export function registerOnExit(callback: () => void) {
    callbacks.push(callback);
}

/**
 * Registers cleanup that needs to reach storage. Runs on SIGINT/SIGHUP/SIGTERM only —
 * the 'exit' event cannot await, so work registered here is skipped on a plain exit.
 */
export function registerAsyncOnExit(callback: () => Promise<void>) {
    asyncCallbacks.push(callback);
}
