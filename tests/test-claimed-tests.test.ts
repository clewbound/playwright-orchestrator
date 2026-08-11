import { describe, it, expect } from 'vitest';
import { ClaimedTests } from '../packages/core/src/runner/claimed-tests.js';
import type { TestItem } from '../packages/core/src/types/adapters.js';

function makeTestItem(testId: string, order: number): TestItem {
    return {
        testId,
        file: 'tests/foo.spec.ts',
        position: '5:1',
        projects: ['chrome'],
        order,
        timeout: 5000,
        ema: 100,
    };
}

describe('ClaimedTests', () => {
    it('hands back every test that has no result yet', () => {
        const claimed = new ClaimedTests();
        claimed.add([makeTestItem('a', 1), makeTestItem('b', 2)]);

        expect(claimed.drain().map(({ testId }) => testId)).toEqual(['a', 'b']);
    });

    it('keeps tests claimed across several batches', () => {
        const claimed = new ClaimedTests();
        claimed.add([makeTestItem('a', 1)]);
        claimed.add([makeTestItem('b', 2)]);

        expect(claimed.drain()).toHaveLength(2);
    });

    it('drops a test once its result is stored', () => {
        const claimed = new ClaimedTests();
        claimed.add([makeTestItem('a', 1), makeTestItem('b', 2)]);
        claimed.settle('a');

        expect(claimed.drain().map(({ testId }) => testId)).toEqual(['b']);
    });

    it('empties itself on drain so a second drain releases nothing', () => {
        const claimed = new ClaimedTests();
        claimed.add([makeTestItem('a', 1)]);
        claimed.drain();

        expect(claimed.drain()).toEqual([]);
    });

    it('ignores a settle for a test it never claimed', () => {
        const claimed = new ClaimedTests();
        claimed.add([makeTestItem('a', 1)]);
        claimed.settle('unknown');

        expect(claimed.drain()).toHaveLength(1);
    });
});
