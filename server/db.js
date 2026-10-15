import mysql from 'mysql2/promise';

// Connection pool for the app. Money columns are DECIMAL, and mysql2 returns
// them as strings (decimalNumbers: false) so no value is rounded through a
// float on the way in; the code converts them deliberately. Dates come back
// as 'YYYY-MM-DD' strings, so no time zone can shift a trade to another day.
export function createDb(config) {
    return mysql.createPool({
        ...config,
        connectionLimit: 5,
        charset: 'utf8mb4',
        timezone: 'Z',
        dateStrings: true,
        decimalNumbers: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
    });
}

// A separate connection that may run several statements at once, for migrations
export function connectForMigrations(config) {
    return mysql.createConnection({ ...config, charset: 'utf8mb4', timezone: 'Z', multipleStatements: true });
}

// 'ok' or 'unreachable', for /health
export async function checkDb(db) {
    try {
        await db.query('SELECT 1');
        return 'ok';
    } catch (err) {
        console.error(`[db] ${err.code ?? err.message}`);
        return 'unreachable';
    }
}
