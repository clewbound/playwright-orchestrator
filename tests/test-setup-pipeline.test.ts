import { describe, it, expect, vi } from 'vitest';
import { BaseTestRunCreator } from '../packages/core/src/adapters/base-test-run-creator.js';
import type { TestItem, TestSortItem, TestRun, BaseOptions } from '../packages/core/src/types/adapters.js';
import { Grouping, BatchMode } from '../packages/core/src/types/adapters.js';
import type { ReporterTestRunInfo, SetupConfig } from '../packages/core/src/types/test-info.js';

class TestableCreator extends BaseTestRunCreator {
    testInfoMap: Map<string, TestSortItem> = new Map();
    savedTests: TestItem[] = [];
    savedRun?: TestRun;

    async loadTestInfos(_tests: TestItem[]): Promise<Map<string, TestSortItem>> {
        return this.testInfoMap;
    }

    async saveRunData(_runId: string, run: TestRun, tests: TestItem[]): Promise<void> {
        this.savedTests = tests;
        this.savedRun = run;
    }
}

function makeRunInfo(
    testRun: ReporterTestRunInfo['testRun'],
    setup?: SetupConfig,
): ReporterTestRunInfo {
    return { testRun, config: { workers: 1, projects: [] }, setup };
}

function makeOptions(overrides: Partial<BaseOptions> = {}): BaseOptions {
    return {
        batchMode: BatchMode.Off,
        grouping: Grouping.Project,
        historyWindow: 10,
        ...overrides,
    };
}

function makeCreator(runInfo: ReporterTestRunInfo): TestableCreator {
    const creator = new TestableCreator();
    (creator as any).runInfoLoader = { load: vi.fn().mockResolvedValue(runInfo) };
    return creator;
}

describe('BaseTestRunCreator dependency project exclusion', () => {
    it('excludes tests from dependency projects (project grouping)', async () => {
        const runInfo = makeRunInfo(
            {
                'setup.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['setup'], title: 'create auth', annotations: [], children: undefined },
                },
                'app.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test app', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: ['setup'], teardownProjects: [], globalSetup: undefined, globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedTests).toHaveLength(1);
        expect(creator.savedTests[0].testId).toBe('[chromium] app.spec.ts > test app');
    });

    it('excludes tests from dependency projects (test grouping)', async () => {
        const runInfo = makeRunInfo(
            {
                'setup.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['setup'], title: 'create auth', annotations: [], children: undefined },
                },
                'app.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test app', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: ['setup'], teardownProjects: [], globalSetup: undefined, globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions({ grouping: Grouping.Test }) });

        expect(creator.savedTests).toHaveLength(1);
        expect(creator.savedTests[0].testId).toBe('app.spec.ts > test app');
    });

    it('removes dependency project from multi-project test (test grouping)', async () => {
        // A test belongs to both 'setup' (dependency) and 'chromium' (top-level)
        const runInfo = makeRunInfo(
            {
                'shared.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['setup', 'chromium'], title: 'shared test', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: ['setup'], teardownProjects: [], globalSetup: undefined, globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions({ grouping: Grouping.Test }) });

        expect(creator.savedTests).toHaveLength(1);
        expect(creator.savedTests[0].projects).toEqual(['chromium']);
    });

    it('includes all tests when no setup config exists', async () => {
        const runInfo = makeRunInfo({
            'a.spec.ts': {
                '1:1': { timeout: 5000, projects: ['chromium'], title: 'test a', annotations: [], children: undefined },
            },
            'b.spec.ts': {
                '1:1': { timeout: 5000, projects: ['firefox'], title: 'test b', annotations: [], children: undefined },
            },
        });
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedTests).toHaveLength(2);
    });

    it('stores setup config in saved run config', async () => {
        const setup: SetupConfig = {
            globalSetup: '/test/global-setup.ts',
            globalTeardown: '/test/global-teardown.ts',
            dependencyProjects: ['setup'],
            teardownProjects: [],
        };
        const runInfo = makeRunInfo(
            {
                'app.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test', annotations: [], children: undefined },
                },
            },
            setup,
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedRun!.config.setup).toEqual(setup);
    });

    it('does not store setup config when no setup exists', async () => {
        const runInfo = makeRunInfo({
            'app.spec.ts': {
                '1:1': { timeout: 5000, projects: ['chromium'], title: 'test', annotations: [], children: undefined },
            },
        });
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedRun!.config.setup).toBeUndefined();
    });

    it('does not filter tests when setup exists but dependencyProjects is empty', async () => {
        const runInfo = makeRunInfo(
            {
                'a.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test a', annotations: [], children: undefined },
                },
                'b.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['firefox'], title: 'test b', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: [], teardownProjects: [], globalSetup: '/test/global-setup.ts', globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedTests).toHaveLength(2);
        expect(creator.savedRun!.config.setup).toBeDefined();
        expect(creator.savedRun!.config.setup!.globalSetup).toBe('/test/global-setup.ts');
    });

    it('excludes teardown projects from test queue', async () => {
        const runInfo = makeRunInfo(
            {
                'cleanup.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['cleanup'], title: 'teardown auth', annotations: [], children: undefined },
                },
                'app.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test app', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: [], teardownProjects: ['cleanup'], globalSetup: undefined, globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedTests).toHaveLength(1);
        expect(creator.savedTests[0].testId).toBe('[chromium] app.spec.ts > test app');
    });

    it('excludes both dependency and teardown projects from test queue', async () => {
        const runInfo = makeRunInfo(
            {
                'setup.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['setup'], title: 'create auth', annotations: [], children: undefined },
                },
                'cleanup.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['cleanup'], title: 'teardown auth', annotations: [], children: undefined },
                },
                'app.spec.ts': {
                    '1:1': { timeout: 5000, projects: ['chromium'], title: 'test app', annotations: [], children: undefined },
                },
            },
            { dependencyProjects: ['setup'], teardownProjects: ['cleanup'], globalSetup: undefined, globalTeardown: undefined },
        );
        const creator = makeCreator(runInfo);
        await creator.create({ runId: 'r', args: [], options: makeOptions() });

        expect(creator.savedTests).toHaveLength(1);
        expect(creator.savedTests[0].testId).toBe('[chromium] app.spec.ts > test app');
    });
});
