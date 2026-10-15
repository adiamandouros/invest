// The SQL for accounts, instruments and transactions, on a mysql2 pool.
// test/helpers/memory-data.js mirrors this interface for the tests, so change
// both together. Decimals come back as strings, dates as 'YYYY-MM-DD'.

const toAccount = row => row && {
    id: row.id, name: row.name, kind: row.kind, platform: row.platform, externalRef: row.external_ref,
    baseCurrency: row.base_currency, openedOn: row.opened_on, notes: row.notes,
};

const toInstrument = row => row && {
    id: row.id, isin: row.isin, symbol: row.symbol, name: row.name, kind: row.kind, currency: row.currency,
    distributing: row.distributing === null ? null : Boolean(row.distributing), assetClass: row.asset_class,
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

        getAccount: async id => toAccount((await rows('SELECT * FROM accounts WHERE id = ?', [id]))[0]) ?? null,
        async createAccount(a) {
            const [result] = await db.query(
                'INSERT INTO accounts (name, kind, platform, base_currency, opened_on, notes) VALUES (?, ?, ?, ?, ?, ?)',
                [a.name, a.kind, a.platform, a.baseCurrency, a.openedOn, a.notes]);
            return result.insertId;
        },
        updateAccount: (id, a) => db.query(
            'UPDATE accounts SET name = ?, kind = ?, platform = ?, base_currency = ?, opened_on = ?, notes = ? WHERE id = ?',
            [a.name, a.kind, a.platform, a.baseCurrency, a.openedOn, a.notes, id]),

        listInstruments: async () => (await rows('SELECT * FROM instruments ORDER BY symbol')).map(toInstrument),
        getInstrument: async id => toInstrument((await rows('SELECT * FROM instruments WHERE id = ?', [id]))[0]) ?? null,
        // Throws { code: 'ER_DUP_ENTRY' } for an ISIN that's already there
        async createInstrument(i) {
            const [result] = await db.query(
                'INSERT INTO instruments (symbol, name, isin, kind, currency, distributing, asset_class) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [i.symbol, i.name, i.isin, i.kind, i.currency, i.distributing, i.assetClass]);
            return result.insertId;
        },
        updateInstrument: (id, i) => db.query(
            `UPDATE instruments SET symbol = ?, name = ?, isin = ?, kind = ?, currency = ?, distributing = ?, asset_class = ?
             WHERE id = ?`,
            [i.symbol, i.name, i.isin, i.kind, i.currency, i.distributing, i.assetClass, id]),

        // Oldest first. Filters: { accountId, instrumentId }
        async listTransactions({ accountId, instrumentId } = {}) {
            const where = [];
            const params = [];
            if (accountId) { where.push('account_id = ?'); params.push(accountId); }
            if (instrumentId) { where.push('instrument_id = ?'); params.push(instrumentId); }
            const sql = `SELECT * FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date, id`;
            return (await rows(sql, params)).map(toTransaction);
        },

        getTransaction: async id => {
            const row = (await rows('SELECT * FROM transactions WHERE id = ?', [id]))[0];
            return row ? toTransaction(row) : null;
        },
        async createTransaction(t) {
            const [result] = await db.query(
                `INSERT INTO transactions (account_id, instrument_id, type, trade_date, units, price, amount,
                                           currency, fee, fee_currency, fx_to_eur, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [t.accountId, t.instrumentId, t.type, t.date, t.units, t.price, t.amount, t.currency, t.fee, t.feeCurrency, t.fxToEur, t.notes]);
            return Number(result.insertId);
        },
        // Keeps import_ref, so importing the statement again doesn't add the row back
        updateTransaction: (id, t) => db.query(
            `UPDATE transactions SET account_id = ?, instrument_id = ?, type = ?, trade_date = ?, units = ?, price = ?,
                    amount = ?, currency = ?, fee = ?, fee_currency = ?, fx_to_eur = ?, notes = ?
             WHERE id = ?`,
            [t.accountId, t.instrumentId, t.type, t.date, t.units, t.price, t.amount, t.currency, t.fee, t.feeCurrency, t.fxToEur, t.notes, id]),
        deleteTransaction: id => db.query('DELETE FROM transactions WHERE id = ?', [id]),

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
