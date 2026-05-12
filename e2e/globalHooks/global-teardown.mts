import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalTeardownMarkerFile } from './constants.mts';
import { lock } from 'proper-lockfile';

export default async function globalTeardown() {
    const reportFolder = process.env.MARKER_FOLDER;
    if (!reportFolder) return;
    const marker = join(reportFolder, globalTeardownMarkerFile);
    if (!existsSync(marker)) {
        writeFileSync(marker, '0');
    }
    const release = await lock(marker, { retries: 100 });
    const count = parseInt(readFileSync(marker, 'utf-8'), 10) + 1;
    writeFileSync(marker, String(count));
    await release();
}
