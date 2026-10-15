import { readFileSync } from 'fs';
import { join } from 'path';

// The git commit the app was started from (7 characters), or null outside a
// git checkout. /health reports it, so scripts/deploy.sh can tell whether the
// running process has the code it just pulled. Read from .git directly, at
// startup: no git process needed.

const GIT = new URL('../.git/', import.meta.url).pathname;

export function readVersion(gitDir = GIT) {
    try {
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref: ')) return head.slice(0, 7);
        const ref = head.slice(5);
        let commit;
        try {
            commit = readFileSync(join(gitDir, ref), 'utf8').trim();
        } catch {
            // Refs can also be in packed-refs, as "<commit> <ref>" lines
            commit = readFileSync(join(gitDir, 'packed-refs'), 'utf8').split('\n')
                .find(line => line.endsWith(` ${ref}`))?.split(' ')[0];
        }
        return /^[0-9a-f]{7,}$/.test(commit ?? '') ? commit.slice(0, 7) : null;
    } catch {
        return null;
    }
}

export const VERSION = readVersion();
