import { injectable } from 'inversify';
import type { TestItem } from '../types/adapters.js';

/**
 * Tracks tests this shard has taken off the shared queue but has not yet written a result
 * for. Claims live only in storage, so a shard that dies mid-batch — or a batch subprocess
 * that exits without reporting — leaves those tests claimed and unreachable to every other
 * shard until something resets them.
 */
@injectable()
export class ClaimedTests {
    private readonly claimed = new Map<string, TestItem>();

    add(tests: TestItem[]): void {
        for (const test of tests) {
            this.claimed.set(test.testId, test);
        }
    }

    /** Drops a test whose result reached storage; it is no longer this shard's to give back. */
    settle(testId: string): void {
        this.claimed.delete(testId);
    }

    /** Hands over everything still outstanding, so concurrent drains cannot release twice. */
    drain(): TestItem[] {
        const outstanding = [...this.claimed.values()];
        this.claimed.clear();
        return outstanding;
    }
}
