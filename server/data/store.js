// The SQL for accounts, instruments and transactions, on a mysql2 pool.
// test/helpers/memory-data.js mirrors this interface for the tests, so change
// both together. Decimals come back as strings, dates as 'YYYY-MM-DD'.

const toAccount = row => row && {
    id: row.id, name: row.name, kind: row.kind, platform: row.platform, externalRef: row.external_ref,
    baseCurrency: row.base_currency, openedOn: row.opened_on,
};

const toInstrument = row => row && {
    id: row.id, isin: row.isin, symbol: row.symbol, name: row.name, kind: row.kind, currency: row.currency,
    distributing: row.distributing === null ? null : Boolean(row.distributing),
};

const toTransaction = row => ({
    id: Number(row.id), accountId: row.account_id, instrumentId: row.instrument_id, type: row.type, date: row.trade_date,
    units: row.units, price: row.price, amount: row.amount, currency: row.currency, fee: row.fee,
    feeCurrency: row.fee_currency, fxToEur: row.fx_to_eur, importRef: row.import_ref, notes: row.notes,
});

export function createDataStore(db) {
    const rows = async (sql, params) => (await db.query(sql, params))[0];

    return {
        listAccounts: async () => (await rows('SELECT * FROM accounts ORDER BY name')).map(toAccount),
        findAccount: async (platform, externalRef) =>
            toAccount((await rows('SELECT * FROM accounts WHERE platform = ? AND external_ref = ?', [platform, externalRef]))[0]) ?? null,

        listInstruments: async () => (await rows('SELECT * FROM instruments ORDER BY symbol')).map(toInstrument),

        // Oldest first. Filters: { accountId, instrumentId }
        async listTransactions({ accountId, instrumentId } = {}) {
            const where = [];
            const params = [];
            if (accountId) { where.push('account_id = ?'); params.push(accountId); }
            if (instrumentId) { where.push('instrument_id = ?'); params.push(instrumentId); }
            const sql = `SELECT * FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date, id`;
            return (await rows(sql, params)).map(toTransaction);
        },

        // Writes an import plan (server/import/index.js) in one transaction: the
        // account if it's new, the new instruments, then the transactions.
        // Returns { accountId, added }.
        async importStatement({ account, instrumentIds, instruments, transactions }) {
            const conn = await db.getConnection();
            try {
                await conn.beginTransaction();
                let accountId = account.id;
                if (!accountId) {
                    const [result] = await conn.query(
                        `INSERT INTO accounts (name, kind, platform, external_ref, base_currency, opened_on)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [account.name, account.kind, account.platform, account.externalRef, account.baseCurrency, account.openedOn]);
                    accountId = result.insertId;
                }
                const ids = { ...instrumentIds };
                for (const i of instruments) {
                    const [result] = await conn.query(
                        'INSERT INTO instruments (isin, symbol, name, kind, currency) VALUES (?, ?, ?, ?, ?)',
                        [i.isin, i.symbol, i.name, i.kind, i.currency ?? 'EUR']);
                    ids[i.key] = result.insertId;
                }
                if (transactions.length) {
                    await conn.query(
                        `INSERT INTO transactions (account_id, instrument_id, type, trade_date, units, price, amount,
                                                   currency, fee, fee_currency, fx_to_eur, import_ref, notes)
                         VALUES ?`,
                        [transactions.map(t => [
                            accountId, t.instrumentKey ? ids[t.instrumentKey] : null, t.type, t.date, t.units, t.price, t.amount,
                            t.currency, t.fee ?? '0', t.feeCurrency, t.fxToEur, t.ref, t.notes,
                        ])]);
                }
                await conn.commit();
                return { accountId, added: transactions.length };
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
        },
    };
}
