import { loadPlugins } from '../helpers/plugin.js';
import { handle } from './command-hoc.js';
import { program } from './program.js';
import type { ShardHandler } from '../adapters/shard-handler.js';
import { SYMBOLS } from '../symbols.js';

export default async () => {
    const command = program.command('cleanup').description('Reset stale tests stuck in Ongoing status.');

    for await (const { register, subCommand } of loadPlugins(command)) {
        subCommand
            .requiredOption('--run-id <string>', 'Run id to clean up')
            .option('--stale-minutes <minutes>', 'Minutes before a test is considered stale', '10')
            .action(
                handle(async (container, options) => {
                    await register(container, options);
                    const shardHandler = container.get<ShardHandler>(SYMBOLS.ShardHandler);
                    const count = await shardHandler.cleanupStaleTests(
                        options.runId,
                        parseInt(options.staleMinutes ?? '10', 10),
                    );
                    console.log(`Reset ${count} stale test(s) to Ready status.`);
                }),
            );
    }
};
