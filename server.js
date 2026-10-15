import 'dotenv/config';
import { createApp } from './server/app.js';
import { loadConfig } from './server/config.js';
import { connectForMigrations, createDb } from './server/db.js';
import { migrate } from './server/migrate.js';

const config = loadConfig();

// Bring the database schema up to date before serving. If that fails the app
// still starts, and /health reports the database as unreachable.
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

let db = null;
if (config.db) {
    await migrateOnStart();
    db = createDb(config.db);
} else {
    console.warn(`[db] Not configured: set ${config.missingDbVars.join(', ')} (see .env.example)`);
}

createApp({ db }).listen(config.port, () => {
    console.log(`Invest running at http://localhost:${config.port}`);
});
