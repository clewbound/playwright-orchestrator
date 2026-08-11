import { TestStatus } from '../types/test-info.js';
import type { ResultTestParams } from '../types/adapters.js';
import type { TestRunReport } from '../types/reporter.js';

export interface Adapter {
    getReportData(runId: string): Promise<TestRunReport>;
    updateTestWithResults(status: TestStatus, resultParams: ResultTestParams): Promise<void>;
    /**
     * Returns tests that a shard claimed but never reported a result for to the queue, and
     * answers how many were reclaimed. A claim is stamped when the test is handed out and is
     * not refreshed while it runs, so `staleMinutes` has to exceed the longest single test —
     * below that, a claim held by a healthy shard is reclaimed and the test runs twice.
     *
     * Optional because storages that claim a test by removing it from the queue keep no record
     * of what was taken, leaving nothing to reset once the claiming process is gone.
     */
    cleanupStaleTests?(runId: string, staleMinutes: number): Promise<number>;
}
