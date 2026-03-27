import { describe, it, expect } from 'vitest';
import { RunBuilder } from '../packages/core/src/playwright-tools/run-builder.js';
import type { FullConfig, FullProject, Suite, TestCase } from '@playwright/test/reporter';

function makeProject(name: string, deps: string[] = []): FullProject {
    return {
        name,
        dependencies: deps,
        grep: /.*/,
        grepInvert: null,
        metadata: {},
        snapshotDir: '',
        outputDir: '',
        repeatEach: 1,
        retries: 0,
        testDir: '',
        testIgnore: [],
        testMatch: '**/*.spec.ts',
        timeout: 30000,
        use: {},
    } as FullProject;
}

function makeConfig(overrides: Partial<FullConfig> = {}): FullConfig {
    return {
        configFile: '/test/playwright.config.ts',
        globalSetup: null,
        globalTeardown: null,
        globalTimeout: 0,
        grepInvert: null,
        grep: /.*/,
        maxFailures: 0,
        metadata: {},
        projects: [],
        reporter: [],
        rootDir: '/test',
        quiet: false,
        shard: null,
        updateSnapshots: 'none',
        version: '1.40.0',
        workers: 4,
        webServer: null,
        ...overrides,
    } as FullConfig;
}

describe('RunBuilder dependency detection', () => {
    it('returns no setup when no dependencies or globalSetup exist', () => {
        const config = makeConfig({
            projects: [makeProject('chromium'), makeProject('firefox')],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup).toBeUndefined();
    });

    it('detects dependency projects from project dependencies', () => {
        const config = makeConfig({
            projects: [
                makeProject('setup', []),
                makeProject('chromium', ['setup']),
                makeProject('firefox', ['setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup).toBeDefined();
        expect(result.setup!.dependencyProjects).toEqual(['setup']);
    });

    it('detects multiple dependency projects', () => {
        const config = makeConfig({
            projects: [
                makeProject('global-setup', []),
                makeProject('auth-setup', ['global-setup']),
                makeProject('chromium', ['auth-setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.dependencyProjects).toContain('global-setup');
        expect(result.setup!.dependencyProjects).toContain('auth-setup');
    });

    it('captures globalSetup and globalTeardown paths', () => {
        const config = makeConfig({
            globalSetup: '/test/global-setup.ts',
            globalTeardown: '/test/global-teardown.ts',
            projects: [makeProject('chromium')],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup).toBeDefined();
        expect(result.setup!.globalSetup).toBe('/test/global-setup.ts');
        expect(result.setup!.globalTeardown).toBe('/test/global-teardown.ts');
        expect(result.setup!.dependencyProjects).toEqual([]);
    });

    it('combines globalSetup with dependency projects', () => {
        const config = makeConfig({
            globalSetup: '/test/global-setup.ts',
            projects: [
                makeProject('setup', []),
                makeProject('chromium', ['setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.globalSetup).toBe('/test/global-setup.ts');
        expect(result.setup!.dependencyProjects).toEqual(['setup']);
    });

    it('handles diamond dependency graph', () => {
        // setup -> auth, setup -> db, auth -> tests, db -> tests
        const config = makeConfig({
            projects: [
                makeProject('setup', []),
                makeProject('auth', ['setup']),
                makeProject('db', ['setup']),
                makeProject('tests', ['auth', 'db']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        const deps = result.setup!.dependencyProjects.sort();
        expect(deps).toEqual(['auth', 'db', 'setup']);
    });

    it('does not include top-level projects as dependencies', () => {
        const config = makeConfig({
            projects: [
                makeProject('setup', []),
                makeProject('chromium', ['setup']),
                makeProject('firefox', ['setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.dependencyProjects).not.toContain('chromium');
        expect(result.setup!.dependencyProjects).not.toContain('firefox');
    });

    // M4: project.teardown is a Playwright feature where a setup project
    // names a teardown project. These should be detected and excluded too.
    it('detects teardown projects from project.teardown property', () => {
        const setupProject = { ...makeProject('setup'), teardown: 'cleanup' };
        const config = makeConfig({
            projects: [
                setupProject as FullProject,
                makeProject('cleanup'),
                makeProject('chromium', ['setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.teardownProjects).toContain('cleanup');
    });

    it('separates dependency projects from teardown projects', () => {
        const setupProject = { ...makeProject('setup'), teardown: 'cleanup' };
        const config = makeConfig({
            projects: [
                setupProject as FullProject,
                makeProject('cleanup'),
                makeProject('chromium', ['setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.dependencyProjects).toContain('setup');
        expect(result.setup!.dependencyProjects).not.toContain('cleanup');
        expect(result.setup!.teardownProjects).toContain('cleanup');
        expect(result.setup!.teardownProjects).not.toContain('setup');
    });

    it('detects multiple teardown projects', () => {
        const config = makeConfig({
            projects: [
                { ...makeProject('auth-setup'), teardown: 'auth-cleanup' } as FullProject,
                { ...makeProject('db-setup'), teardown: 'db-cleanup' } as FullProject,
                makeProject('auth-cleanup'),
                makeProject('db-cleanup'),
                makeProject('chromium', ['auth-setup', 'db-setup']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup!.teardownProjects.sort()).toEqual(['auth-cleanup', 'db-cleanup']);
        expect(result.setup!.dependencyProjects.sort()).toEqual(['auth-setup', 'db-setup']);
    });

    it('handles project appearing in both dependencies and teardown', () => {
        // Project 'shared' is depended on by chromium AND is a teardown for setup
        const config = makeConfig({
            projects: [
                { ...makeProject('setup'), teardown: 'shared' } as FullProject,
                makeProject('shared'),
                makeProject('chromium', ['shared']),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        // 'shared' appears in dependencies (chromium depends on it) AND teardown (setup tears down to it)
        expect(result.setup!.dependencyProjects).toContain('shared');
        expect(result.setup!.teardownProjects).toContain('shared');
    });

    it('creates setup config with only teardown projects (no deps, no globalSetup)', () => {
        const config = makeConfig({
            projects: [
                { ...makeProject('tests'), teardown: 'cleanup' } as FullProject,
                makeProject('cleanup'),
            ],
        });
        const result = new RunBuilder().parseConfig(config).build();
        expect(result.setup).toBeDefined();
        expect(result.setup!.dependencyProjects).toEqual([]);
        expect(result.setup!.teardownProjects).toEqual(['cleanup']);
    });
});
