import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestRunConfig } from '../packages/core/src/types/adapters.js';
import type { SetupConfig } from '../packages/core/src/types/test-info.js';

// --- Module mocks (must be before imports) ---

vi.mock('inversify', () => ({
    injectable: () => (target: any) => target,
    inject: () => () => {},
    preDestroy: () => () => {},
}));

vi.mock('../packages/core/src/helpers/register-on-exit.js', () => ({
    registerOnExit: vi.fn(),
}));

vi.mock('../packages/core/src/commands/version.js', () => ({
    cliVersion: '1.0.0-test',
}));

vi.mock('uuid', () => ({
    v7: vi.fn().mockReturnValue('mock-uuid'),
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('node:readline', () => ({
    createInterface: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis() }),
}));

vi.mock('node:fs/promises', () => ({
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
    rmSync: vi.fn(),
}));

vi.mock('playwright', () => ({
    default: {
        chromium: { launchServer: vi.fn() },
        firefox: { launchServer: vi.fn() },
        webkit: { launchServer: vi.fn() },
    },
}));

import { TestRunner } from '../packages/core/src/runner/test-runner.js';

// --- Helpers ---

const TEST_SETUP: SetupConfig = {
    globalSetup: '/project/global-setup.ts',
    globalTeardown: '/project/global-teardown.ts',
    dependencyProjects: ['setup'],
    teardownProjects: [],
};

function makeConfig(overrides: Partial<TestRunConfig> = {}): TestRunConfig {
    return {
        workers: 1,
        configFile: '/project/playwright.config.ts',
        projects: [],
        args: [],
        options: { batchMode: 'off' as any, grouping: 'project' as any, historyWindow: 10 },
        version: '1.0.0-test',
        setup: TEST_SETUP,
        ...overrides,
    };
}

function createMocks(configOverrides: Partial<TestRunConfig> = {}) {
    const config = makeConfig(configOverrides);
    const shardHandler = {
        startShard: vi.fn().mockResolvedValue(config),
        finishShard: vi.fn().mockResolvedValue(undefined),
    };
    const browserManager = {
        runBrowsers: vi.fn().mockResolvedValue({}),
    };
    const webServerManager = {
        startServers: vi.fn().mockResolvedValue(undefined),
    };
    const setupManager = {
        runSetup: vi.fn().mockResolvedValue(undefined),
        runTeardown: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
    };
    const reporter = {
        printSummary: vi.fn(),
        hasFailed: vi.fn().mockReturnValue(false),
        addLoading: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    };
    const batchHandler = {
        getNextBatch: vi.fn().mockResolvedValue(null), // no tests → loop exits immediately
    };
    const batchHandlerFactory = vi.fn().mockReturnValue(batchHandler);
    const testEventHandlerFactory = vi.fn();

    return {
        config,
        shardHandler,
        browserManager,
        webServerManager,
        setupManager,
        reporter,
        batchHandlerFactory,
        testEventHandlerFactory,
    };
}

function createRunner(mocks: ReturnType<typeof createMocks>) {
    return new TestRunner(
        'run-id',
        'output',
        mocks.shardHandler as any,
        mocks.browserManager as any,
        mocks.webServerManager as any,
        mocks.setupManager as any,
        mocks.batchHandlerFactory as any,
        mocks.reporter as any,
        mocks.testEventHandlerFactory as any,
    );
}

// --- Tests ---

describe('TestRunner setup/teardown lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('normal flow', () => {
        it('runs setup before browsers and teardown in finally', async () => {
            const mocks = createMocks();
            const runner = createRunner(mocks);
            const callOrder: string[] = [];

            mocks.setupManager.runSetup.mockImplementation(async () => {
                callOrder.push('setup');
            });
            mocks.browserManager.runBrowsers.mockImplementation(async () => {
                callOrder.push('browsers');
                return {};
            });
            mocks.setupManager.runTeardown.mockImplementation(async () => {
                callOrder.push('teardown');
            });
            mocks.shardHandler.finishShard.mockImplementation(async () => {
                callOrder.push('finishShard');
            });

            await runner.runTests();

            expect(callOrder).toEqual(['setup', 'browsers', 'teardown', 'finishShard']);
        });

        it('skips setup/teardown when no setup config exists', async () => {
            const mocks = createMocks({ setup: undefined });
            const runner = createRunner(mocks);
            await runner.runTests();

            expect(mocks.setupManager.runSetup).not.toHaveBeenCalled();
            expect(mocks.setupManager.runTeardown).not.toHaveBeenCalled();
        });

        it('skips setup/teardown when no configFile exists', async () => {
            const mocks = createMocks({ configFile: undefined });
            const runner = createRunner(mocks);
            await runner.runTests();

            expect(mocks.setupManager.runSetup).not.toHaveBeenCalled();
            expect(mocks.setupManager.runTeardown).not.toHaveBeenCalled();
        });
    });

    describe('M1: teardown after infrastructure failure', () => {
        // Validates that globalTeardown runs even when browser or webServer
        // startup fails, since both are inside the try/finally block.
        it('runs globalTeardown even if browser startup fails', async () => {
            const mocks = createMocks();
            mocks.browserManager.runBrowsers.mockRejectedValue(new Error('Browser launch failed'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.setupManager.runSetup).toHaveBeenCalled();
            expect(mocks.setupManager.runTeardown).toHaveBeenCalledWith(
                expect.objectContaining({ globalTeardown: '/project/global-teardown.ts' }),
                '/project/playwright.config.ts',
            );
        });

        it('runs globalTeardown even if webServer startup fails', async () => {
            const mocks = createMocks();
            mocks.webServerManager.startServers.mockRejectedValue(new Error('WebServer failed'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.setupManager.runTeardown).toHaveBeenCalled();
        });

        it('calls finishShard even if browser startup fails', async () => {
            const mocks = createMocks();
            mocks.browserManager.runBrowsers.mockRejectedValue(new Error('Browser launch failed'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.shardHandler.finishShard).toHaveBeenCalledWith('run-id');
        });
    });

    describe('M2: finishShard resilience', () => {
        // This test exposes M2: if runTeardown throws inside the finally block,
        // finishShard is never called, orphaning the shard record.
        it('calls finishShard even if globalTeardown fails', async () => {
            const mocks = createMocks();
            mocks.setupManager.runTeardown.mockRejectedValue(new Error('Teardown script exited code 1'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.shardHandler.finishShard).toHaveBeenCalledWith('run-id');
        });
    });

    describe('setup failure resilience', () => {
        it('calls finishShard even if runSetup fails', async () => {
            const mocks = createMocks();
            mocks.setupManager.runSetup.mockRejectedValue(new Error('Setup project failed'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.shardHandler.finishShard).toHaveBeenCalledWith('run-id');
        });

        it('does NOT run teardown if setup fails', async () => {
            const mocks = createMocks();
            mocks.setupManager.runSetup.mockRejectedValue(new Error('Setup project failed'));
            const runner = createRunner(mocks);

            await runner.runTests().catch(() => {});

            expect(mocks.setupManager.runTeardown).not.toHaveBeenCalled();
        });
    });

    describe('M5: dependency project browser filtering', () => {
        // This test exposes M5: dependency projects remain in config.projects,
        // causing BrowserManager to launch unnecessary browser servers.
        it('filters dependency projects from config before launching browsers', async () => {
            let browserProjectNames: string[] = [];
            const mocks = createMocks({
                projects: [
                    { name: 'setup', use: { defaultBrowserType: 'chromium' }, repeatEach: 1 } as any,
                    { name: 'chromium', use: { defaultBrowserType: 'chromium' }, repeatEach: 1 } as any,
                    { name: 'firefox', use: { defaultBrowserType: 'firefox' }, repeatEach: 1 } as any,
                ],
                setup: {
                    globalSetup: '/project/gs.ts',
                    globalTeardown: '/project/gt.ts',
                    dependencyProjects: ['setup'],
                    teardownProjects: [],
                },
            });
            mocks.browserManager.runBrowsers.mockImplementation(async (cfg: any) => {
                browserProjectNames = cfg.projects.map((p: any) => p.name);
                return {};
            });
            const runner = createRunner(mocks);

            await runner.runTests();

            expect(browserProjectNames).not.toContain('setup');
            expect(browserProjectNames).toContain('chromium');
            expect(browserProjectNames).toContain('firefox');
        });

        it('does not filter projects when no setup config exists', async () => {
            let browserProjectNames: string[] = [];
            const mocks = createMocks({
                projects: [
                    { name: 'chromium', use: { defaultBrowserType: 'chromium' }, repeatEach: 1 } as any,
                ],
                setup: undefined,
            });
            mocks.browserManager.runBrowsers.mockImplementation(async (cfg: any) => {
                browserProjectNames = cfg.projects.map((p: any) => p.name);
                return {};
            });
            const runner = createRunner(mocks);

            await runner.runTests();

            expect(browserProjectNames).toContain('chromium');
        });
    });
});
