// Exercised by test-register-on-exit.test.ts in a child process: the handlers under test
// end with process.exit, which cannot be observed from inside the test runner.
import { registerAsyncOnExit, registerOnExit } from '../../packages/core/dist/helpers/register-on-exit.js';

const mode = process.argv[2];

registerOnExit(() => console.log('sync'));

registerAsyncOnExit(async () => {
    if (mode === 'hang') return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log('async');
});

// Hold the event loop open so the signal has a running process to interrupt.
setTimeout(() => {}, 60_000);

process.kill(process.pid, 'SIGTERM');
