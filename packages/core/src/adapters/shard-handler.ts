import type { TestItem, TestRunConfig } from '../types/adapters.js';

export interface ShardHandler {
    startShard(): Promise<TestRunConfig>;
    finishShard(): Promise<void>;
    getNextTest(config: TestRunConfig): Promise<TestItem | undefined>;
    getNextTestByProject(project: string): Promise<TestItem | undefined>;
    /**
     * Returns claimed tests to the queue so another shard — or a re-run of this one — can
     * pick them up. Called when a shard exits with tests still claimed but no result written.
     *
     * Storages that track a per-test status re-assert it before flipping, so a result that
     * landed concurrently is never overwritten. Storages that claim by removing the test from
     * a queue cannot make that check, so a release racing a result may re-queue a test that
     * already finished; it runs twice on the next attempt rather than being lost.
     */
    releaseTests(tests: TestItem[]): Promise<void>;
    getRemainingCounters(config: TestRunConfig): Promise<{ remainingCount: number; remainingTime: number }>;
}
