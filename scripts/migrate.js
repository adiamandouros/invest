// Apply pending database migrations: npm run migrate
// (The app also does this when it starts; this is for checking by hand.)
import 'dotenv/config';
import { loadConfig } from '../server/config.js';
import { connectForMigrations } from '../server/db.js';
import { migrate } from '../server/migrate.js';

const config = loadConfig();
if (!config.db) {
    console.error(`Set ${config.missingDbVars.join(', ')} first (see .env.example)`);
    process.exit(1);
}

const conn = await connectForMigrations(config.db);
try {
    await migrate(conn);
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
} finally {
    await conn.end();
}
