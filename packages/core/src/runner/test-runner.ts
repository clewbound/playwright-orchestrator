import type { TestItem, TestRunConfig, TestRunContext } from '../types/adapters.js';
import { rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { TestExecutionReporter } from './test-execution-reporter.js';
import path from 'node:path';
import * as uuid from 'uuid';
import { injectable, inject } from 'inversify';
import type { ShardHandler } from '../adapters/shard-handler.js';
import type { BatchHandlerFactory } from '../commands/run.js';
import type { BatchHandler } from '../batch/batch-handler.js';
import { BrowserManager } from './browser-manager.js';
import { WebServerManager } from './web-server-manager.js';
import { GlobalSetupManager } from './global-setup-manager.js';
import { SYMBOLS } from '../symbols.js';
import { runPlaywright } from '../helpers/run-playwright.js';
import type { TestEventHandlerFactory } from './test-event-handler.js';
import { cliVersion } from '../commands/version.js';
import { registerAsyncOnExit, registerOnExit } from '../helpers/register-on-exit.js';
import { PlaywrightConfigLoader } from '../helpers/playwright-config.js';
import { ClaimedTests } from './claimed-tests.js';

@injectable()
export class TestRunner {
    private cleanupFs = new Set<string>();

    constructor(
        @inject(SYMBOLS.RunContext) private readonly runContext: TestRunContext,
        @inject(SYMBOLS.ShardHandler) private readonly shardHandler: ShardHandler,
        @inject(SYMBOLS.BrowserManager) private readonly browserManager: BrowserManager,
        @inject(SYMBOLS.WebServerManager) private readonly webServerManager: WebServerManager,
        @inject(SYMBOLS.GlobalSetupManager) private readonly globalSetupManager: GlobalSetupManager,
        @inject(SYMBOLS.BatchHandlerFactory) private readonly batchHandlerFactory: BatchHandlerFactory,
        @inject(SYMBOLS.TestExecutionReporter) private readonly reporter: TestExecutionReporter,
        @inject(SYMBOLS.TestEventHandlerFactory) private readonly testEventHandlerFactory: TestEventHandlerFactory,
        @inject(SYMBOLS.PlaywrightConfigLoader) private readonly configLoader: PlaywrightConfigLoader,
        @inject(SYMBOLS.ClaimedTests) private readonly claimedTests: ClaimedTests,
    ) {
        registerOnExit(() => {
            this.cleanupTemp();
        });
        registerAsyncOnExit(() => this.releaseClaimedTests());
    }

    async runTests(): Promise<boolean> {
        await this.removePreviousOutput();
        const config = await this.shardHandler.startShard();
        if (config.version !== cliVersion) {
            console.error(
                `Version mismatch: Orchestrator CLI version is ${cliVersion} but test run was created with version ${config.version}. Please make sure to use the same version of Playwright Orchestrator across all your machines.`,
            );
            process.exitCode = 1;
            return false;
        }
        await this.configLoader.loadPlaywrightConfig(config.configFile);
        const [browsers] = await Promise.all([
            this.browserManager.runBrowsers(config),
            this.webServerManager.startServers(),
        ]);
        config.configFile = await this.createTempConfig(config.configFile);
        if (config.configFile) {
            this.cleanupFs.add(config.configFile);
        }
        await this.globalSetupManager.runSetup(config, browsers);

        try {
            await this.runTestsUntilAvailable(config, browsers);
        } finally {
            // A batch whose subprocess dies before reporting leaves its tests claimed even
            // though this shard ran to completion. Released ahead of teardown so a failing
            // teardown cannot strand them, and so other shards can pick them up sooner.
            await this.releaseClaimedTests();
            await this.globalSetupManager.runTeardown(config, browsers);
            this.reporter.printSummary();
            await this.shardHandler.finishShard();
        }
        return !this.reporter.hasFailed();
    }

    private async releaseClaimedTests() {
        const outstanding = this.claimedTests.drain();
        if (outstanding.length === 0) return;
        try {
            await this.shardHandler.releaseTests(outstanding);
            console.log(`Released ${outstanding.length} unfinished test(s) back to the queue`);
        } catch (err) {
            console.error(`Failed to release ${outstanding.length} claimed test(s):`, err);
        }
    }

    private cleanupTemp() {
        for (const entry of this.cleanupFs) {
            rmSync(entry, { force: true, recursive: true });
        }
        this.cleanupFs.clear();
    }

    private async removePreviousOutput() {
        await rm(this.runContext.outputFolder, { recursive: true, force: true });
    }

    private async runTestsUntilAvailable(config: TestRunConfig, browsers: Record<string, string>) {
        const batchHandler = this.batchHandlerFactory(config.options.batchMode);
        const runningBatches = new Set<Promise<void>>();
        let batchNumber = 0;
        let nextBatch = await this.claimNextBatch(batchHandler, config);
        while (nextBatch || runningBatches.size > 0) {
            if (nextBatch && runningBatches.size < config.workers) {
                batchNumber++;
                const batchPromise = this.runTestBatch(nextBatch, config, browsers, batchNumber).finally(() => {
                    runningBatches.delete(batchPromise);
                });
                runningBatches.add(batchPromise);
                nextBatch = await this.claimNextBatch(batchHandler, config);
            } else {
                await Promise.race(runningBatches);
            }
        }
        await Promise.all(runningBatches);
    }

    private async claimNextBatch(batchHandler: BatchHandler, config: TestRunConfig) {
        const batch = await batchHandler.getNextBatch(config);
        // Tests are owed back from the moment storage hands them over, not from the moment a
        // batch starts — a shard killed while waiting for a free worker still holds the claim.
        if (batch) this.claimedTests.add(batch);
        return batch;
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

        const batchArtifact = path.relative(process.cwd(), `${this.runContext.outputFolder}/${batchId}.zip`);
        try {
            await runPlaywright(this.buildParams(tests, config), onData, {
                ...process.env,
                PLAYWRIGHT_BLOB_OUTPUT_FILE: batchArtifact,
                ...(config.configFile && {
                    PLAYWRIGHT_ORCHESTRATOR_BROWSERS: JSON.stringify(browsers),
                }),
                PLAYWRIGHT_ORCHESTRATOR_GROUPING: config.options.grouping,
            });
            await onExit();
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
            args.push(`${test.file.replace(/\\/g, '/')}:${test.position}`);
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
        // Browser endpoints are injected via PLAYWRIGHT_ORCHESTRATOR_BROWSERS env var.
        const content = `
import config from '${path.resolve(file).replace(/\\/g, '/')}';

const browsers: Record<string, string> = JSON.parse(process.env.PLAYWRIGHT_ORCHESTRATOR_BROWSERS ?? '{}');

config.webServer = undefined;
config.globalSetup = undefined;
config.globalTeardown = undefined;
for (const project of config?.projects ?? []) {
    if (!project.use) project.use = {};
    const wsEndpoint = browsers[project.name!];
    if (wsEndpoint) {
        if (!project.use.connectOptions) project.use.connectOptions = {};
        project.use.connectOptions.wsEndpoint = wsEndpoint;
    }
    project.dependencies = [];
    project.teardown = undefined;
}

export default config;`;

        const tempFile = path.join(path.dirname(path.resolve(file)), `.playwright-${uuid.v7()}.config.tmp.ts`);
        await writeFile(tempFile, content);
        return tempFile;
    }
}
