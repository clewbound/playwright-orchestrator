import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { SetupConfig } from '../packages/core/src/types/test-info.js';

// --- Module mocks (must be before imports) ---

vi.mock('inversify', () => ({
    injectable: () => (target: any) => target,
}));

vi.mock('../packages/core/src/helpers/register-on-exit.js', () => ({
    registerOnExit: vi.fn(),
}));

vi.mock('uuid', () => ({
    v7: vi.fn().mockReturnValue('00000000-0000-7000-8000-000000000001'),
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
    rmSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { SetupManager } from '../packages/core/src/helpers/setup-manager.js';

// --- Helpers ---

function spawnReturning(exitCode = 0) {
    vi.mocked(spawn).mockImplementation((() => {
        const handlers: Record<string, Function[]> = {};
        const proc = {
            on(event: string, handler: Function) {
                if (!handlers[event]) handlers[event] = [];
                handlers[event].push(handler);
                return proc;
            },
        };
        // Schedule exit AFTER handlers are registered (synchronously after spawn returns)
        queueMicrotask(() => {
            for (const h of handlers['exit'] ?? []) h(exitCode);
        });
        return proc as any;
    }) as any);
}

function setup(overrides: Partial<SetupConfig> = {}): SetupConfig {
    return {
        globalSetup: undefined,
        globalTeardown: undefined,
        dependencyProjects: [],
        teardownProjects: [],
        ...overrides,
    };
}

// --- Tests ---

describe('SetupManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('runSetup branching', () => {
        it('runs globalSetup via --grep noop when only globalSetup is set', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts' }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--grep');
            expect(args).toContain('__pw_orchestrator_noop__');
        });

        it('runs dependency projects when only deps exist', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ dependencyProjects: ['setup-project'] }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--project');
            expect(args).toContain('setup-project');
            expect(args).not.toContain('--grep');
        });

        it('runs deps with globalSetup kept when both exist', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts', dependencyProjects: ['setup-project'] }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--project');
            expect(args).toContain('setup-project');
            expect(args).not.toContain('--grep');
        });

        it('is a no-op when neither globalSetup nor deps exist', async () => {
            const manager = new SetupManager();
            await manager.runSetup(setup(), '/project/playwright.config.ts');

            expect(spawn).not.toHaveBeenCalled();
            expect(writeFile).not.toHaveBeenCalled();
        });
    });

    describe('runTeardown', () => {
        it('runs teardown phase when globalTeardown is set', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runTeardown(
                setup({ globalTeardown: '/project/global-teardown.ts' }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--grep');
        });

        it('is a no-op when neither globalTeardown nor teardownProjects exist', async () => {
            const manager = new SetupManager();
            await manager.runTeardown(setup(), '/project/playwright.config.ts');

            expect(spawn).not.toHaveBeenCalled();
        });

        it('runs teardown projects via --project flags', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runTeardown(
                setup({ teardownProjects: ['cleanup'] }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--project');
            expect(args).toContain('cleanup');
            expect(args).not.toContain('--grep');
        });

        it('runs teardown projects before globalTeardown', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            const callOrder: string[] = [];

            vi.mocked(spawn).mockImplementation(((cmd: string, args: string[]) => {
                if (args.includes('--project')) callOrder.push('teardown-projects');
                if (args.includes('--grep')) callOrder.push('global-teardown');
                const handlers: Record<string, Function[]> = {};
                const proc = {
                    on(event: string, handler: Function) {
                        if (!handlers[event]) handlers[event] = [];
                        handlers[event].push(handler);
                        return proc;
                    },
                };
                queueMicrotask(() => {
                    for (const h of handlers['exit'] ?? []) h(0);
                });
                return proc as any;
            }) as any);

            await manager.runTeardown(
                setup({ teardownProjects: ['cleanup'], globalTeardown: '/project/gt.ts' }),
                '/project/playwright.config.ts',
            );

            expect(callOrder).toEqual(['teardown-projects', 'global-teardown']);
        });

        it('runs only teardown projects when no globalTeardown', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runTeardown(
                setup({ teardownProjects: ['cleanup', 'db-cleanup'] }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledTimes(1);
            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('cleanup');
            expect(args).toContain('db-cleanup');
        });
    });

    describe('generated temp config content', () => {
        it('strips globalTeardown and keeps globalSetup for setup phase', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts' }),
                '/project/playwright.config.ts',
            );

            const content = vi.mocked(writeFile).mock.calls[0][1] as string;
            expect(content).toContain('config.globalTeardown = undefined;');
            expect(content).not.toContain('config.globalSetup = undefined;');
            expect(content).toContain('config.webServer = undefined;');
            expect(content).toContain('export default config;');
        });

        it('strips globalSetup and keeps globalTeardown for teardown phase', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runTeardown(
                setup({ globalTeardown: '/project/global-teardown.ts' }),
                '/project/playwright.config.ts',
            );

            const content = vi.mocked(writeFile).mock.calls[0][1] as string;
            expect(content).toContain('config.globalSetup = undefined;');
            expect(content).not.toContain('config.globalTeardown = undefined;');
            expect(content).toContain('config.webServer = undefined;');
        });

        it('keeps globalSetup in dep config when keepGlobalSetup is true', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts', dependencyProjects: ['auth'] }),
                '/project/playwright.config.ts',
            );

            const content = vi.mocked(writeFile).mock.calls[0][1] as string;
            expect(content).not.toContain('config.globalSetup = undefined;');
            expect(content).toContain('config.globalTeardown = undefined;');
            expect(content).toContain('config.webServer = undefined;');
        });

        it('strips globalSetup in dep config when keepGlobalSetup is false', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ dependencyProjects: ['auth'] }),
                '/project/playwright.config.ts',
            );

            const content = vi.mocked(writeFile).mock.calls[0][1] as string;
            expect(content).toContain('config.globalSetup = undefined;');
            expect(content).toContain('config.globalTeardown = undefined;');
            expect(content).toContain('config.webServer = undefined;');
        });
    });

    describe('playwright CLI args', () => {
        // C1: This test exposes the missing --pass-with-no-tests flag.
        // Playwright exits code 1 on "No tests found" unless this flag is passed.
        it('includes --pass-with-no-tests for global lifecycle phases', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts' }),
                '/project/playwright.config.ts',
            );

            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--pass-with-no-tests');
        });

        it('includes --pass-with-no-tests for teardown phase', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runTeardown(
                setup({ globalTeardown: '/project/global-teardown.ts' }),
                '/project/playwright.config.ts',
            );

            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('--pass-with-no-tests');
        });

        it('passes all dependency project names as --project flags', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ dependencyProjects: ['setup', 'auth', 'db'] }),
                '/project/playwright.config.ts',
            );

            const args = vi.mocked(spawn).mock.calls[0][1] as string[];
            expect(args).toContain('setup');
            expect(args).toContain('auth');
            expect(args).toContain('db');
            // Each should be preceded by --project
            const projectFlags = args.filter((a, i) => a === '--project');
            expect(projectFlags).toHaveLength(3);
        });

        it('uses npx playwright test as the base command', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts' }),
                '/project/playwright.config.ts',
            );

            expect(spawn).toHaveBeenCalledWith(
                'npx',
                expect.arrayContaining(['playwright', 'test']),
                expect.objectContaining({ stdio: 'inherit' }),
            );
        });
    });

    describe('temp file management', () => {
        it('writes temp config to same directory as original config', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/global-setup.ts' }),
                '/project/playwright.config.ts',
            );

            const writtenPath = vi.mocked(writeFile).mock.calls[0][0] as string;
            expect(path.dirname(writtenPath)).toBe(
                path.dirname(path.resolve('/project/playwright.config.ts')),
            );
            expect(writtenPath).toMatch(/\.playwright-orchestrator-.*\.config\.tmp\.ts$/);
        });

        it('cleans up all temp files on cleanup()', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            // Create two temp files (setup + teardown)
            await manager.runSetup(
                setup({ globalSetup: '/project/gs.ts' }),
                '/project/playwright.config.ts',
            );

            manager.cleanup();

            expect(rmSync).toHaveBeenCalledWith(expect.stringContaining('.playwright-orchestrator-'), { force: true });
        });

        it('does not leave temp files after cleanup', async () => {
            spawnReturning(0);
            const manager = new SetupManager();
            await manager.runSetup(
                setup({ globalSetup: '/project/gs.ts' }),
                '/project/playwright.config.ts',
            );

            manager.cleanup();
            vi.mocked(rmSync).mockClear();
            manager.cleanup(); // second cleanup should be a no-op

            expect(rmSync).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('rejects when playwright exits with non-zero code', async () => {
            spawnReturning(1);
            const manager = new SetupManager();

            await expect(
                manager.runSetup(
                    setup({ globalSetup: '/project/global-setup.ts' }),
                    '/project/playwright.config.ts',
                ),
            ).rejects.toThrow('Playwright process exited with code 1');
        });

        it('rejects when spawn itself errors', async () => {
            vi.mocked(spawn).mockImplementation((() => {
                const handlers: Record<string, Function[]> = {};
                const proc = {
                    on(event: string, handler: Function) {
                        if (!handlers[event]) handlers[event] = [];
                        handlers[event].push(handler);
                        return proc;
                    },
                };
                queueMicrotask(() => {
                    for (const h of handlers['error'] ?? []) h(new Error('ENOENT'));
                });
                return proc as any;
            }) as any);

            const manager = new SetupManager();
            await expect(
                manager.runSetup(
                    setup({ globalSetup: '/project/global-setup.ts' }),
                    '/project/playwright.config.ts',
                ),
            ).rejects.toThrow('ENOENT');
        });
    });
});
