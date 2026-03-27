import { injectable } from 'inversify';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import * as uuid from 'uuid';
import type { SetupConfig } from '../types/test-info.js';
import { registerOnExit } from './register-on-exit.js';

@injectable()
export class SetupManager {
    private readonly cleanupFiles: string[] = [];

    constructor() {
        registerOnExit(() => this.cleanup());
    }

    async runSetup(setup: SetupConfig, configFile: string): Promise<void> {
        if (setup.globalSetup && setup.dependencyProjects.length > 0) {
            // Run globalSetup + dependency projects in a single Playwright invocation.
            // Keep globalSetup, strip globalTeardown so it doesn't run prematurely.
            //
            // KNOWN LIMITATION: If globalSetup returns a cleanup function, Playwright's task
            // runner will call it when this subprocess exits — before the orchestrator's test
            // batches begin. This means process-based state (servers, DBs) started by globalSetup
            // will not persist into the test phase. File-based state (auth tokens, storage state)
            // is unaffected. A future improvement would be to import and call globalSetup directly,
            // holding the cleanup reference across the full orchestrator lifecycle.
            await this.runDependencyProjects(setup.dependencyProjects, configFile, {
                keepGlobalSetup: true,
            });
        } else if (setup.globalSetup) {
            await this.runGlobalLifecycle(configFile, 'setup');
        } else if (setup.dependencyProjects.length > 0) {
            await this.runDependencyProjects(setup.dependencyProjects, configFile, {
                keepGlobalSetup: false,
            });
        }
    }

    async runTeardown(setup: SetupConfig, configFile: string): Promise<void> {
        // Run teardown projects first (reverse of setup order)
        if (setup.teardownProjects.length > 0) {
            await this.runDependencyProjects(setup.teardownProjects, configFile, {
                keepGlobalSetup: false,
            });
        }
        // Then run globalTeardown
        if (setup.globalTeardown) {
            await this.runGlobalLifecycle(configFile, 'teardown');
        }
    }

    cleanup(): void {
        for (const file of this.cleanupFiles) {
            rmSync(file, { force: true });
        }
        this.cleanupFiles.length = 0;
    }

    private async runGlobalLifecycle(configFile: string, phase: 'setup' | 'teardown'): Promise<void> {
        const stripSetup = phase === 'teardown' ? 'config.globalSetup = undefined;\n' : '';
        const stripTeardown = phase === 'setup' ? 'config.globalTeardown = undefined;\n' : '';

        const content = [
            `import config from '${path.resolve(configFile)}';`,
            stripSetup + stripTeardown + 'config.webServer = undefined;',
            'export default config;',
        ].join('\n');

        const tempFile = await this.writeTempConfig(configFile, content);
        console.log(`Running global ${phase}...`);
        // Use --grep with an impossible pattern so no tests run, but globalSetup/Teardown still executes
        await this.runPlaywright(['--config', tempFile, '--grep', '__pw_orchestrator_noop__', '--pass-with-no-tests']);
    }

    private async runDependencyProjects(
        projects: string[],
        configFile: string,
        options: { keepGlobalSetup: boolean },
    ): Promise<void> {
        const lines = [`import config from '${path.resolve(configFile)}';`];
        if (!options.keepGlobalSetup) {
            lines.push('config.globalSetup = undefined;');
        }
        lines.push('config.globalTeardown = undefined;');
        lines.push('config.webServer = undefined;');
        lines.push('export default config;');

        const tempFile = await this.writeTempConfig(configFile, lines.join('\n'));
        const args = ['--config', tempFile];
        for (const project of projects) {
            args.push('--project', project);
        }
        console.log(`Running dependency projects: ${projects.join(', ')}`);
        await this.runPlaywright(args);
    }

    private runPlaywright(args: string[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const proc = spawn('npx', ['playwright', 'test', ...args], {
                stdio: 'inherit',
                env: process.env,
            });
            proc.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Playwright process exited with code ${code}`));
            });
            proc.on('error', reject);
        });
    }

    private async writeTempConfig(configFile: string, content: string): Promise<string> {
        const tempFile = path.join(
            path.dirname(path.resolve(configFile)),
            `.playwright-orchestrator-${uuid.v7()}.config.tmp.ts`,
        );
        await writeFile(tempFile, content);
        this.cleanupFiles.push(tempFile);
        return tempFile;
    }
}
