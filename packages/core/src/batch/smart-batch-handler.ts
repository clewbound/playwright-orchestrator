import { injectable, injectFromBase } from 'inversify';
import type { BatchHandler } from './batch-handler.js';
import type { TestItem, TestRunConfig } from '../types/adapters.js';
import { BaseBatchHandler } from './base-batch-handler.js';

@injectable()
@injectFromBase({ extendProperties: true, extendConstructorArguments: false })
export class SmartBatchHandler extends BaseBatchHandler implements BatchHandler {
    async getNextBatch(config: TestRunConfig): Promise<TestItem[] | undefined> {
        const batch: TestItem[] = [];
        let accumulated = 0;

        while (true) {
            if (batch.length > 0) {
                const { nRemaining, tRemaining } = await this.getCounters(config);
                if (nRemaining === 0) break;
                const budget = tRemaining / Math.sqrt(nRemaining);
                const cap = Math.ceil(Math.sqrt(nRemaining));
                if (accumulated >= budget || batch.length >= cap) break;
            }

            const test = await this.getNextTest(config, batch[0]?.projects[0]);
            if (!test) break;

            batch.push(test);
            accumulated += test.ema;
        }

        return batch.length > 0 ? batch : undefined;
    }
}
