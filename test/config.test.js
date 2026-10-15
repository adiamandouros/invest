import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('the database is off until every DB_* variable is set', () => {
    const config = loadConfig({ DB_NAME: 'invest', DB_USER: 'u' });
    assert.equal(config.db, null);
    assert.deepEqual(config.missingDbVars, ['DB_PASSWORD']);
});

test('host and port have defaults', () => {
    const config = loadConfig({ DB_NAME: 'invest', DB_USER: 'u', DB_PASSWORD: 'p' });
    assert.deepEqual(config.db, { host: 'localhost', port: 3306, database: 'invest', user: 'u', password: 'p' });
    assert.equal(config.port, 3000);
});

test('PORT and DB_PORT are read as numbers', () => {
    const config = loadConfig({ PORT: '4000', DB_PORT: '3307', DB_HOST: 'db', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' });
    assert.equal(config.port, 4000);
    assert.equal(config.db.port, 3307);
    assert.equal(config.db.host, 'db');
});

test('a non-numeric PORT is kept as a socket path', () => {
    assert.equal(loadConfig({ PORT: '/tmp/lshttpd/app.sock' }).port, '/tmp/lshttpd/app.sock');
});
