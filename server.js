import 'dotenv/config';
import { createApp } from './server/app.js';
import { loadConfig } from './server/config.js';
import { connectForMigrations, createDb } from './server/db.js';
import { migrate } from './server/migrate.js';

const config = loadConfig();

// Bring the database schema up to date once the app is listening. If that
// fails, the error is logged and the app keeps running.
async function migrateOnStart() {
    let conn;
    try {
        conn = await connectForMigrations(config.db);
        await migrate(conn);
    } catch (err) {
        console.error(`[migrate] ${err.message}`);
    } finally {
        await conn?.end().catch(() => {});
    }
}

// No top-level await in this file: on Node versions that load it with
// require() it would fail with ERR_REQUIRE_ASYNC_MODULE (see start.cjs).
const db = config.db ? createDb(config.db) : null;
if (!db) console.warn(`[db] Not configured: set ${config.missingDbVars.join(', ')} (see .env.example)`);

createApp({ db }).listen(config.port, () => {
    console.log(`Invest running at http://localhost:${config.port}`);
    if (config.db) migrateOnStart();
});
