import { describe, it, expect } from 'vitest';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./utils/exit-handler-fixture.mjs', import.meta.url));

function runFixture(mode?: string) {
    return new Promise<{ stdout: string; code: number | null; elapsed: number }>((resolve, reject) => {
        const startedAt = Date.now();
        const child = child_process.spawn(process.execPath, [fixture, ...(mode ? [mode] : [])]);
        let stdout = '';
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, code, elapsed: Date.now() - startedAt }));
    });
}

describe('registerAsyncOnExit', () => {
    it('finishes async cleanup before the process exits on SIGTERM', async () => {
        const { stdout, code } = await runFixture();

        expect(stdout.trim().split('\n')).toEqual(['sync', 'async']);
        expect(code).toBe(1);
    }, 15000);

    it('exits on its own once cleanup stops making progress', async () => {
        const { stdout, code, elapsed } = await runFixture('hang');

        expect(stdout.trim()).toBe('sync');
        expect(code).toBe(1);
        // Waited for the async callback rather than exiting straight away, but still gave up
        // well inside the grace period a runner allows after cancelling a job.
        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(10000);
    }, 20000);
});
