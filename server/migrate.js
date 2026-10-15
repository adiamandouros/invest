import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Database schema changes live in db/migrations/NNN_short_name.sql and are
// applied once each, in order. schema_migrations records which ones ran and
// a checksum, so an edited migration is caught instead of silently ignored:
// change the schema with a new migration, never by editing an applied one.
//
// MySQL commits each CREATE/ALTER on its own, so a migration that fails
// halfway can't be rolled back. It isn't recorded, and the error says which
// one it was; fix the database by hand, then start the app again.

export const MIGRATIONS_DIR = new URL('../db/migrations/', import.meta.url).pathname;
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

export function listMigrations(dir = MIGRATIONS_DIR) {
    const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
    const seen = new Set();
    return files.map(name => {
        const match = name.match(FILE_NAME);
        if (!match) throw new Error(`Migration file name ${name} doesn't look like 001_short_name.sql`);
        if (seen.has(match[1])) throw new Error(`Two migrations are numbered ${match[1]}`);
        seen.add(match[1]);
        const sql = readFileSync(join(dir, name), 'utf8');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

// The migrations still to run, given the rows in schema_migrations
export function pendingMigrations(migrations, applied) {
    const byName = new Map(migrations.map(m => [m.name, m]));
    for (const row of applied) {
        const local = byName.get(row.name);
        if (!local) throw new Error(`The database has migration ${row.name}, which isn't in db/migrations`);
        if (local.checksum !== row.checksum) throw new Error(`Migration ${row.name} was edited after it was applied`);
    }
    const done = new Set(applied.map(row => row.name));
    return migrations.filter(m => !done.has(m.name));
}

// Apply every pending migration through `conn` (a mysql2 connection that
// allows multiple statements). Returns the names applied.
export async function migrate(conn, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(255) NOT NULL PRIMARY KEY,
        checksum   CHAR(64)     NOT NULL,
        applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [applied] = await conn.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    const pending = pendingMigrations(listMigrations(dir), applied);
    for (const migration of pending) {
        log(`[migrate] Applying ${migration.name}`);
        try {
            await conn.query(migration.sql);
        } catch (err) {
            throw new Error(`Migration ${migration.name} failed: ${err.message}`, { cause: err });
        }
        await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [migration.name, migration.checksum]);
    }
    if (!pending.length) log('[migrate] Database is up to date');
    return pending.map(m => m.name);
}
