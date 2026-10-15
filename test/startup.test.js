import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

// LiteSpeed starts the app with require('server.js'). Node refuses that for a
// module with top-level await, and the live site then hung on every request.
test('server.js starts when loaded with require(), as LiteSpeed does', async () => {
    const child = spawn(process.execPath, ['-e', "require('./server.js')"], {
        cwd: new URL('..', import.meta.url).pathname,
        // No database, and a free port (dotenv doesn't override variables that are already set)
        env: { ...process.env, PORT: '0', DB_NAME: '', DB_USER: '', DB_PASSWORD: '' },
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`didn't start in 5 s:\n${output}`)), 5000);
            child.stdout.on('data', () => { if (output.includes('Invest running')) { clearTimeout(timer); resolve(); } });
            child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited with ${code}:\n${output}`)); });
        });
    } finally {
        child.kill();
    }
    assert.doesNotMatch(output, /ERR_REQUIRE/);
});
