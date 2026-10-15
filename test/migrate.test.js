import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listMigrations, migrate, MIGRATIONS_DIR, pendingMigrations } from '../server/migrate.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'invest-migrations-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name, sql) => writeFileSync(join(dir, name), sql);

// Stands in for a mysql2 connection: keeps schema_migrations in memory and
// records every other statement
function fakeConnection({ failOn } = {}) {
    const applied = [];
    const statements = [];
    return {
        applied,
        statements,
        async query(sql, params) {
            if (sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return [[]];
            if (sql.startsWith('SELECT name, checksum FROM schema_migrations')) return [[...applied]];
            if (sql.startsWith('INSERT INTO schema_migrations')) {
                applied.push({ name: params[0], checksum: params[1] });
                return [{}];
            }
            if (failOn && sql.includes(failOn)) throw new Error('syntax error');
            statements.push(sql);
            return [{}];
        },
    };
}

test('the project\'s own migrations are valid', () => {
    assert.doesNotThrow(() => listMigrations(MIGRATIONS_DIR));
});

test('migrations are listed in number order with checksums', () => {
    write('002_second.sql', 'B');
    write('001_first.sql', 'A');
    const list = listMigrations(dir);
    assert.deepEqual(list.map(m => m.name), ['001_first.sql', '002_second.sql']);
    assert.match(list[0].checksum, /^[0-9a-f]{64}$/);
});

test('badly named or duplicate-numbered files are refused', () => {
    write('1_first.sql', 'A');
    assert.throws(() => listMigrations(dir), /doesn't look like/);
    rmSync(join(dir, '1_first.sql'));
    write('001_a.sql', 'A');
    write('001_b.sql', 'B');
    assert.throws(() => listMigrations(dir), /Two migrations are numbered 001/);
});

test('only migrations not yet applied are pending', () => {
    write('001_first.sql', 'A');
    write('002_second.sql', 'B');
    const list = listMigrations(dir);
    const pending = pendingMigrations(list, [{ name: '001_first.sql', checksum: list[0].checksum }]);
    assert.deepEqual(pending.map(m => m.name), ['002_second.sql']);
});

test('an edited or missing applied migration stops everything', () => {
    write('001_first.sql', 'A');
    const list = listMigrations(dir);
    assert.throws(() => pendingMigrations(list, [{ name: '001_first.sql', checksum: 'x'.repeat(64) }]), /was edited/);
    assert.throws(() => pendingMigrations(list, [{ name: '000_gone.sql', checksum: 'x' }]), /isn't in db\/migrations/);
});

test('migrate applies pending migrations once, in order', async () => {
    write('001_first.sql', 'CREATE TABLE a (id INT)');
    write('002_second.sql', 'CREATE TABLE b (id INT)');
    const conn = fakeConnection();
    const log = () => {};
    assert.deepEqual(await migrate(conn, { dir, log }), ['001_first.sql', '002_second.sql']);
    assert.deepEqual(conn.statements, ['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
    assert.deepEqual(await migrate(conn, { dir, log }), [], 'nothing left the second time');
    assert.equal(conn.statements.length, 2);
});

test('a failing migration is named and not recorded', async () => {
    write('001_first.sql', 'CREATE TABLE a (id INT)');
    write('002_broken.sql', 'CREATE TABLE oops');
    const conn = fakeConnection({ failOn: 'oops' });
    await assert.rejects(migrate(conn, { dir, log: () => {} }), /002_broken\.sql failed: syntax error/);
    assert.deepEqual(conn.applied.map(r => r.name), ['001_first.sql']);
});
