// Create the app's user, or set a new password for it: npm run create-user
//
//   npm run create-user -- --reset-2fa
//       Also turns off the authenticator code (for a lost phone, or a changed
//       ENCRYPTION_KEY), so the next sign-in sets it up again.
//
// Changing the password or the authenticator signs out every device.
// Run it on the server (cPanel → Terminal, in the app folder), or locally
// with DB_* pointing at the server's database through an SSH tunnel.
import 'dotenv/config';
import { hashPassword, MIN_PASSWORD } from '../server/auth/password.js';
import { createStore } from '../server/auth/store.js';
import { loadConfig } from '../server/config.js';
import { connectForMigrations, createDb } from '../server/db.js';
import { migrate } from '../server/migrate.js';

const SIGN_IN_URL = 'https://invest.sonovabitc.win/login';

// ── Prompts ─────────────────────────────────────────────────────────────────

// Reads one line from stdin. Hidden input isn't echoed (when stdin is a terminal).
let buffered = '';
function ask(question, { hidden = false } = {}) {
    process.stdout.write(question);
    const { stdin } = process;
    const raw = hidden && stdin.isTTY;
    return new Promise(resolve => {
        let line = '';
        const finish = rest => {
            stdin.off('data', onData);
            if (raw) stdin.setRawMode(false);
            stdin.pause();
            buffered = rest;
            if (raw) process.stdout.write('\n');
            resolve(line);
        };
        const onData = chunk => {
            const text = String(chunk);
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                if (char === '\u0003') process.exit(130); // Ctrl+C
                if (char === '\r' || char === '\n') {
                    // Skip the \n of a \r\n pair
                    return finish(text.slice(i + (char === '\r' && text[i + 1] === '\n' ? 2 : 1)));
                }
                if (char === '\u007f' || char === '\b') line = line.slice(0, -1);
                else line += char;
            }
        };
        if (raw) stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        if (buffered) {
            const pending = buffered;
            buffered = '';
            onData(pending);
        }
        stdin.resume();
    });
}

async function askNewPassword() {
    for (;;) {
        const password = await ask(`New password (at least ${MIN_PASSWORD} characters): `, { hidden: true });
        if (password.length < MIN_PASSWORD) {
            console.log(`That's ${password.length} characters. Use at least ${MIN_PASSWORD}.`);
            continue;
        }
        if (await ask('Type it again: ', { hidden: true }) === password) return password;
        console.log('The two didn\'t match. Try again.');
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

const config = loadConfig();
if (!config.db) {
    console.error(`Set ${config.missingDbVars.join(', ')} first (see .env.example)`);
    process.exit(1);
}

// The users table comes with the migrations
const conn = await connectForMigrations(config.db);
try {
    await migrate(conn, { log: () => {} });
} finally {
    await conn.end();
}

const db = createDb(config.db);
const store = createStore(db);
try {
    const username = (await ask('Username: ')).trim();
    if (!/^[\w.@-]{1,64}$/.test(username)) throw new Error('Use 1 to 64 letters, digits, and . _ @ -');

    const user = await store.findUserByName(username);
    if (!user) {
        await store.createUser(username, await hashPassword(await askNewPassword()));
        console.log(`Created ${username}. Now sign in at ${SIGN_IN_URL} to set up your authenticator app.`);
    } else {
        if (process.argv.includes('--reset-2fa')) {
            await store.resetTotp(user.id);
            console.log(`Turned off the authenticator code for ${user.username}. The next sign-in sets it up again.`);
        }
        if (/^y/i.test(await ask(`${user.username} already exists. Set a new password? [y/N] `))) {
            await store.setPassword(user.id, await hashPassword(await askNewPassword()));
            console.log('Password changed. Every device is signed out.');
        }
    }
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
} finally {
    await db.end();
}
