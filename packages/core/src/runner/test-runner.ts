import { TestItem, TestRunConfig } from '../types/adapters.js';
import { rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { TestExecutionReporter } from './test-execution-reporter.js';
import path from 'node:path';
import * as uuid from 'uuid';
import { injectable, inject } from 'inversify';
import type { ShardHandler } from '../adapters/shard-handler.js';
import type { BatchHandlerFactory } from '../commands/run.js';
import { BrowserManager } from './browser-manager.js';
import { WebServerManager } from './web-server-manager.js';
import { SetupManager } from '../helpers/setup-manager.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SYMBOLS } from '../symbols.js';
import type { TestEventHandlerFactory } from './test-event-handler.js';
import { cliVersion } from '../commands/version.js';
import { registerOnExit } from '../helpers/register-on-exit.js';

@injectable()
export class TestRunner {
    private cleanupFs = new Set<string>();

    constructor(
        @inject(SYMBOLS.RunId) private readonly runId: string,
        @inject(SYMBOLS.OutputFolder) private readonly outputFolder: string,
        @inject(SYMBOLS.ShardHandler) private readonly shardHandler: ShardHandler,
        @inject(SYMBOLS.BrowserManager) private readonly browserManager: BrowserManager,
        @inject(SYMBOLS.WebServerManager) private readonly webServerManager: WebServerManager,
        @inject(SYMBOLS.SetupManager) private readonly setupManager: SetupManager,
        @inject(SYMBOLS.BatchHandlerFactory) private readonly batchHandlerFactory: BatchHandlerFactory,
        @inject(SYMBOLS.TestExecutionReporter) private readonly reporter: TestExecutionReporter,
        @inject(SYMBOLS.TestEventHandlerFactory) private readonly testEventHandlerFactory: TestEventHandlerFactory,
    ) {
        registerOnExit(() => {
            this.cleanupTemp();
        });
    }

    async runTests(): Promise<boolean> {
        await this.removePreviousOutput();
        const config = await this.shardHandler.startShard(this.runId);
        if (config.version !== cliVersion) {
            console.error(
                `Version mismatch: Orchestrator CLI version is ${cliVersion} but test run was created with version ${config.version}. Please make sure to use the same version of Playwright Orchestrator across all your machines.`,
            );
            process.exitCode = 1;
            return false;
        }

        const originalConfigFile = config.configFile;
        let setupSucceeded = false;

        try {
            // NOTE: Setup runs independently on each shard. In distributed deployments this is
            // intentional — each machine needs its own setup state (auth tokens, storage state, etc.).
            // Users should ensure globalSetup and dependency projects are idempotent and safe to run
            // concurrently across shards.
            if (config.setup && originalConfigFile) {
                await this.setupManager.runSetup(config.setup, originalConfigFile);
                setupSucceeded = true;
            }

            // Exclude dependency/teardown projects from browser launches — their tests are not
            // scheduled by the orchestrator, so launching browser servers for them wastes resources.
            if (config.setup) {
                const excludeSet = new Set([...config.setup.dependencyProjects, ...config.setup.teardownProjects]);
                if (excludeSet.size > 0) {
                    config.projects = config.projects.filter((p) => !excludeSet.has(p.name));
                }
            }

            const [browsers] = await Promise.all([
                this.browserManager.runBrowsers(config),
                this.webServerManager.startServers(config),
            ]);
            config.configFile = await this.createTempConfig(config.configFile);
            if (config.configFile) {
                this.cleanupFs.add(config.configFile);
            }

            await this.runTestsUntilAvailable(config, browsers);
        } finally {
            this.reporter.printSummary();
            if (setupSucceeded && config.setup && originalConfigFile) {
                try {
                    await this.setupManager.runTeardown(config.setup, originalConfigFile);
                } catch (err) {
                    console.error('Global teardown failed:', err instanceof Error ? err.message : err);
                }
            }
            await this.shardHandler.finishShard(this.runId);
        }
        return !this.reporter.hasFailed();
    }

    private cleanupTemp() {
        for (const entry of this.cleanupFs) {
            rmSync(entry, { force: true, recursive: true });
        }
        this.cleanupFs.clear();
    }

    private async removePreviousOutput() {
        await rm(this.outputFolder, { recursive: true, force: true });
    }

    private async runTestsUntilAvailable(config: TestRunConfig, browsers: Record<string, string>) {
        const batchHandler = this.batchHandlerFactory(config.options.batchMode);
        const runningBatches = new Set<Promise<void>>();
        let batchNumber = 0;
        let nextBatch = await batchHandler.getNextBatch(this.runId, config);
        while (nextBatch || runningBatches.size > 0) {
            if (nextBatch && runningBatches.size < config.workers) {
                batchNumber++;
                const batchPromise = this.runTestBatch(nextBatch, config, browsers, batchNumber).finally(() => {
                    runningBatches.delete(batchPromise);
                });
                runningBatches.add(batchPromise);
                nextBatch = await batchHandler.getNextBatch(this.runId, config);
            } else {
                await Promise.race(runningBatches);
            }
        }
        await Promise.all(runningBatches);
    }

    private async runTestBatch(
        tests: TestItem[],
        config: TestRunConfig,
        browsers: Record<string, string>,
        batchNumber: number,
    ) {
        const batchName = `Batch ${batchNumber}`;
        const { onData, onExit, batchResolver } = this.testEventHandlerFactory(tests, config, batchName);

        const batchId = uuid.v7();

        const batchArtifact = path.relative(process.cwd(), `${this.outputFolder}/${batchId}.zip`);
        try {
            await new Promise<void>((resolve, reject) => {
                const playwright = spawn('npx', ['playwright', 'test', ...this.buildParams(tests, config)], {
                    env: {
                        ...process.env,
                        PLAYWRIGHT_BLOB_OUTPUT_FILE: batchArtifact,
                        ...(config.configFile && {
                            PLAYWRIGHT_ORCHESTRATOR_BROWSERS: JSON.stringify(browsers),
                        }),
                        PLAYWRIGHT_ORCHESTRATOR_GROUPING: config.options.grouping,
                    },
                });
                createInterface({ input: playwright.stdout, crlfDelay: Infinity }).on('line', onData);
                playwright.on('exit', () => onExit().then(resolve, reject));
            });
            batchResolver.success();
        } catch (err) {
            batchResolver.fail(err);
            throw err;
        }
    }

    private buildParams(tests: TestItem[], config: TestRunConfig): string[] {
        const args = [];
        const projects = new Set<string>();
        for (const test of tests) {
            args.push(`${test.file}:${test.position}`);
            for (const project of test.projects) {
                projects.add(project);
            }
        }
        args.push(...config.args);
        args.push('--workers', '1');
        args.push('--reporter', 'blob,@playwright-orchestrator/core/test-result-reporter');
        for (const project of projects) {
            args.push('--project', project);
        }
        if (config.configFile) {
            args.push('--config', config.configFile);
        }
        return args;
    }

    private async createTempConfig(file: string | undefined): Promise<string | undefined> {
        if (!file) return;
        // Strip webServer (handled by WebServerManager), globalSetup/globalTeardown and
        // project dependencies (handled by SetupManager). The orchestrator owns lifecycle
        // and scheduling. Browser endpoints are injected via PLAYWRIGHT_ORCHESTRATOR_BROWSERS env var.
        const content = `
import config from '${path.resolve(file)}';

const browsers: Record<string, string> = JSON.parse(process.env.PLAYWRIGHT_ORCHESTRATOR_BROWSERS ?? '{}');

config.webServer = undefined;
config.globalSetup = undefined;
config.globalTeardown = undefined;
for (const project of config?.projects ?? []) {
    project.dependencies = [];
    project.teardown = undefined;
    if (!project.use) project.use = {};
    if (!project.use.connectOptions) project.use.connectOptions = {};
    if (!project.use.connectOptions.wsEndpoint) {
        project.use.connectOptions.wsEndpoint = browsers[project.name!];
    }
}

export default config;`;

        const tempFile = path.join(path.dirname(path.resolve(file)), `.playwright-${uuid.v7()}.config.tmp.ts`);
        await writeFile(tempFile, content);
        return tempFile;
    }
}
