import { it, expect, afterAll, beforeAll, describe } from 'vitest';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { testStorage } from '../utils/test-storage.js';
import { TEST_TIMEOUT } from '../utils/constants.js';
import { Grouping } from '../../packages/core/src/types/adapters.js';
import { TestStatus } from '../../packages/core/src/types/test-info.js';
import { spawnAsync } from '../../packages/core/src/helpers/spawn.js';
import { PgPool } from '../../packages/pg/src/pg-pool.js';
import { PgShardHandler } from '../../packages/pg/src/pg-shard-handler.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const orchestratorCli = createRequire(join(process.cwd(), 'package.json')).resolve('@playwright-orchestrator/core/cli');

const reportsFolder = './test-reports-folder-pg';
let container: StartedPostgreSqlContainer | undefined;
let storageOptions: string[];

beforeAll(async () => {
    const connectionString = process.env.PG_CONNECTION_STRING;
    if (connectionString) {
        storageOptions = ['pg', '--connection-string', connectionString];
    } else {
        container = await new PostgreSqlContainer('postgres:13.3-alpine').start();
        storageOptions = ['pg', '--connection-string', container.getConnectionUri()];
    }
}, 60000);

afterAll(async () => {
    await container?.stop();
    await rm(reportsFolder, { recursive: true, force: true });
});

describe('PostgreSQL plugin', () => {
    it(
        'test pg plugin',
        async () => {
            await testStorage(storageOptions, reportsFolder, Grouping.Test);
        },
        TEST_TIMEOUT,
    );
    it(
        'grouping by project',
        async () => {
            await testStorage(storageOptions, reportsFolder, Grouping.Project);
        },
        TEST_TIMEOUT,
    );

    it(
        'releases claimed tests back to the queue',
        async () => {
            const { handler, pool, tableNamePrefix, runId } = await createRunForRelease('release_queue');
            try {
                const config = await handler.startShard();
                const before = await handler.getRemainingCounters(config);

                const claimed = [await handler.getNextTest(config), await handler.getNextTest(config)].filter(
                    (test) => test !== undefined,
                );
                expect(claimed).toHaveLength(2);
                expect(await readStatuses(pool, tableNamePrefix, runId, claimed)).toEqual([
                    TestStatus.Ongoing,
                    TestStatus.Ongoing,
                ]);

                await handler.releaseTests(claimed);

                expect(await readStatuses(pool, tableNamePrefix, runId, claimed)).toEqual([
                    TestStatus.Ready,
                    TestStatus.Ready,
                ]);
                const after = await handler.getRemainingCounters(config);
                expect(after.remainingCount).toBe(before.remainingCount);
                expect(after.remainingTime).toBeCloseTo(before.remainingTime, 5);
            } finally {
                await pool.dispose();
            }
        },
        TEST_TIMEOUT,
    );

    it(
        'leaves a test alone when its result landed before the release',
        async () => {
            const { handler, pool, tableNamePrefix, runId } = await createRunForRelease('release_race');
            try {
                const config = await handler.startShard();
                const claimed = await handler.getNextTest(config);
                expect(claimed).toBeDefined();
                const claimedCounters = await handler.getRemainingCounters(config);

                // Stands in for a result that reaches storage while the shard is shutting down.
                await pool.pool.query(
                    `UPDATE ${tableNamePrefix}_tests SET status = $3 WHERE run_id = $1 AND order_num = $2`,
                    [runId, claimed!.order, TestStatus.Passed],
                );
                await handler.releaseTests([claimed!]);

                expect(await readStatuses(pool, tableNamePrefix, runId, [claimed!])).toEqual([TestStatus.Passed]);
                const after = await handler.getRemainingCounters(config);
                expect(after.remainingCount).toBe(claimedCounters.remainingCount);
                expect(after.remainingTime).toBeCloseTo(claimedCounters.remainingTime, 5);
            } finally {
                await pool.dispose();
            }
        },
        TEST_TIMEOUT,
    );
});

/**
 * Builds a run in its own set of tables and returns a shard handler wired straight to it, so
 * release behaviour can be driven step by step instead of racing a real test run.
 */
async function createRunForRelease(tableNamePrefix: string) {
    const connectionString = storageOptions[2];
    const args = [...storageOptions, '--table-name-prefix', tableNamePrefix];
    const init = await spawnAsync(process.execPath, [orchestratorCli, 'init', ...args]);
    expect(init.stdout, `Init command failed. Error: ${init.stderr}`).toBeTruthy();
    const create = await spawnAsync(process.execPath, [
        orchestratorCli,
        'create',
        ...args,
        '--config',
        'tests-playwright.config.ts',
    ]);
    const runId = create.stdout.trim();
    expect(runId, `Create command failed. Error: ${create.stderr}`).toBeTruthy();

    const createArgs = { connectionString, tableNamePrefix };
    const pool = new PgPool(createArgs);
    const handler = new PgShardHandler(createArgs, pool, {
        runId,
        shardId: 'release-shard',
        outputFolder: reportsFolder,
    });
    return { handler, pool, tableNamePrefix, runId };
}

async function readStatuses(pool: PgPool, tableNamePrefix: string, runId: string, tests: { order: number }[]) {
    const { rows } = await pool.pool.query(
        `SELECT status FROM ${tableNamePrefix}_tests
        WHERE run_id = $1 AND order_num = ANY($2::int[])
        ORDER BY order_num`,
        [runId, tests.map(({ order }) => order)],
    );
    return rows.map(({ status }) => status as TestStatus);
}
