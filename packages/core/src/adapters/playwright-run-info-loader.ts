import { injectable } from 'inversify';
import type { RunInfoLoader } from './run-info-loader.js';
import type { ReporterTestRunInfo } from '../types/test-info.js';
import { spawnAsync } from '../helpers/spawn.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

@injectable()
export class PlaywrightRunInfoLoader implements RunInfoLoader {
    async load(args: string[]): Promise<ReporterTestRunInfo> {
        const req = createRequire(join(process.cwd(), 'package.json'));
        const playwrightCli = join(dirname(req.resolve('@playwright/test/package.json')), 'cli.js');
        const { stdout } = await spawnAsync(
            process.execPath,
            [playwrightCli, 'test', ...args, '--list', '--reporter', '@playwright-orchestrator/core/run-info-reporter'],
            { env: { ...process.env, NO_COLOR: '1' } },
        );
        // Extract JSON from stdout — skip any non-JSON lines (e.g., dotenvx logs)
        const jsonMatch = stdout.match(/(\{[\s\S]*\})\s*$/);
        if (!jsonMatch) {
            throw new Error(`Failed to parse test run info from Playwright output:\n${stdout}`);
        }
        return JSON.parse(jsonMatch[1]) as ReporterTestRunInfo;
    }
}
