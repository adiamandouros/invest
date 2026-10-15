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
    priceSymbol: row.price_symbol, priceSource: row.price_source,
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
                `INSERT INTO instruments (symbol, name, isin, kind, currency, distributing, asset_class, price_symbol, price_source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [i.symbol, i.name, i.isin, i.kind, i.currency, i.distributing, i.assetClass, i.priceSymbol ?? null, i.priceSource ?? null]);
            return result.insertId;
        },
        updateInstrument: (id, i) => db.query(
            `UPDATE instruments SET symbol = ?, name = ?, isin = ?, kind = ?, currency = ?, distributing = ?, asset_class = ?,
                    price_symbol = ?, price_source = ?
             WHERE id = ?`,
            [i.symbol, i.name, i.isin, i.kind, i.currency, i.distributing, i.assetClass, i.priceSymbol ?? null, i.priceSource ?? null, id]),
        setPriceSymbol: (id, symbol, source) => db.query('UPDATE instruments SET price_symbol = ?, price_source = ? WHERE id = ?', [symbol, source, id]),

        // ── Prices and exchange rates (server/market/) ──

        listPrices: async () => (await rows('SELECT instrument_id, price_date, close, currency, source FROM prices ORDER BY instrument_id, price_date'))
            .map(r => ({ instrumentId: r.instrument_id, date: r.price_date, close: r.close, currency: r.currency, source: r.source })),
        // { instrumentId: 'YYYY-MM-DD' } for each instrument with prices
        lastPriceDates: async () => Object.fromEntries((await rows('SELECT instrument_id, MAX(price_date) AS last FROM prices GROUP BY instrument_id'))
            .map(r => [r.instrument_id, r.last])),
        async savePrices(list) {
            if (!list.length) return;
            await db.query(
                `INSERT INTO prices (instrument_id, price_date, close, currency, source) VALUES ?
                 ON DUPLICATE KEY UPDATE close = VALUES(close), currency = VALUES(currency), source = VALUES(source)`,
                [list.map(p => [p.instrumentId, p.date, p.close, p.currency, p.source])]);
        },
        listFxRates: async () => (await rows('SELECT currency, rate_date, per_eur FROM fx_rates ORDER BY currency, rate_date'))
            .map(r => ({ currency: r.currency, date: r.rate_date, perEur: r.per_eur })),
        lastFxDates: async () => Object.fromEntries((await rows('SELECT currency, MAX(rate_date) AS last FROM fx_rates GROUP BY currency'))
            .map(r => [r.currency, r.last])),
        async saveFxRates(list) {
            if (!list.length) return;
            await db.query('INSERT INTO fx_rates (currency, rate_date, per_eur) VALUES ? ON DUPLICATE KEY UPDATE per_eur = VALUES(per_eur)',
                [list.map(r => [r.currency, r.date, r.perEur])]);
        },
        // { prices: { checkedAt: Date-string (UTC), ok, message }, fx: {...} }
        marketStatus: async () => Object.fromEntries((await rows('SELECT name, checked_at, ok, message FROM market_updates'))
            .map(r => [r.name, { checkedAt: r.checked_at, ok: Boolean(r.ok), message: r.message }])),
        setMarketStatus: (name, ok, message) => db.query(
            `INSERT INTO market_updates (name, checked_at, ok, message) VALUES (?, UTC_TIMESTAMP(), ?, ?)
             ON DUPLICATE KEY UPDATE checked_at = UTC_TIMESTAMP(), ok = VALUES(ok), message = VALUES(message)`,
            [name, ok, message?.slice(0, 1000) ?? null]),

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
