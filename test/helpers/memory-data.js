// An in-memory stand-in for server/data/store.js, with the same behaviour,
// so the pages and imports can be tested without MySQL. Change both together.
export function createMemoryData() {
    const accounts = [];
    const instruments = [];
    const transactions = [];
    const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);

    return {
        accounts,
        instruments,
        transactions,

        listAccounts: async () => [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
        findAccount: async (platform, externalRef) =>
            accounts.find(a => a.platform === platform && a.externalRef === externalRef) ?? null,
        getAccount: async id => accounts.find(a => a.id === id) ?? null,
        async createAccount(a) {
            const id = accounts.length + 1;
            accounts.push({ id, externalRef: null, ...a });
            return id;
        },
        async updateAccount(id, a) { Object.assign(accounts.find(x => x.id === id), a); },

        listInstruments: async () => [...instruments].sort((a, b) => a.symbol.localeCompare(b.symbol)),
        getInstrument: async id => instruments.find(i => i.id === id) ?? null,
        async createInstrument(i) {
            if (i.isin && instruments.some(x => x.isin === i.isin)) throw Object.assign(new Error('Duplicate isin'), { code: 'ER_DUP_ENTRY' });
            const id = instruments.length + 1;
            instruments.push({ id, ...i });
            return id;
        },
        async updateInstrument(id, i) {
            if (i.isin && instruments.some(x => x.isin === i.isin && x.id !== id)) throw Object.assign(new Error('Duplicate isin'), { code: 'ER_DUP_ENTRY' });
            Object.assign(instruments.find(x => x.id === id), i);
        },
        listTransactions: async ({ accountId, instrumentId } = {}) => transactions
            .filter(t => (!accountId || t.accountId === accountId) && (!instrumentId || t.instrumentId === instrumentId))
            .sort(byDate)
            .map(t => ({ ...t })),

        getTransaction: async id => {
            const t = transactions.find(x => x.id === id);
            return t ? { ...t } : null;
        },
        async createTransaction(t) {
            const id = Math.max(0, ...transactions.map(x => x.id)) + 1;
            transactions.push({ id, importRef: null, ...t });
            return id;
        },
        async updateTransaction(id, t) { Object.assign(transactions.find(x => x.id === id), t); },
        async deleteTransaction(id) { transactions.splice(transactions.findIndex(x => x.id === id), 1); },

        async importStatement({ account, instrumentIds, instruments: added, transactions: rows }) {
            let accountId = account.id;
            if (!accountId) {
                accountId = accounts.length + 1;
                accounts.push({ id: accountId, ...account });
            }
            const ids = { ...instrumentIds };
            for (const i of added) {
                const id = instruments.length + 1;
                instruments.push({ id, isin: i.isin, symbol: i.symbol, name: i.name, kind: i.kind, currency: i.currency ?? 'EUR', distributing: null, assetClass: null });
                ids[i.key] = id;
            }
            for (const t of rows) {
                if (transactions.some(e => e.accountId === accountId && e.importRef === t.ref)) throw new Error(`Duplicate import_ref ${t.ref}`);
                transactions.push({
                    id: Math.max(0, ...transactions.map(x => x.id)) + 1, accountId, instrumentId: t.instrumentKey ? ids[t.instrumentKey] : null,
                    type: t.type, date: t.date, units: t.units, price: t.price, amount: t.amount, currency: t.currency,
                    fee: t.fee ?? '0', feeCurrency: t.feeCurrency, fxToEur: t.fxToEur, importRef: t.ref, notes: t.notes,
                });
            }
            return { accountId, added: rows.length };
        },
    };
}
