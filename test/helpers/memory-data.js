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
        listInstruments: async () => [...instruments].sort((a, b) => a.symbol.localeCompare(b.symbol)),
        listTransactions: async ({ accountId, instrumentId } = {}) => transactions
            .filter(t => (!accountId || t.accountId === accountId) && (!instrumentId || t.instrumentId === instrumentId))
            .sort(byDate)
            .map(t => ({ ...t })),

        async importStatement({ account, instrumentIds, instruments: added, transactions: rows }) {
            let accountId = account.id;
            if (!accountId) {
                accountId = accounts.length + 1;
                accounts.push({ id: accountId, ...account });
            }
            const ids = { ...instrumentIds };
            for (const i of added) {
                const id = instruments.length + 1;
                instruments.push({ id, isin: i.isin, symbol: i.symbol, name: i.name, kind: i.kind, currency: i.currency ?? 'EUR', distributing: null });
                ids[i.key] = id;
            }
            for (const t of rows) {
                if (transactions.some(e => e.accountId === accountId && e.importRef === t.ref)) throw new Error(`Duplicate import_ref ${t.ref}`);
                transactions.push({
                    id: transactions.length + 1, accountId, instrumentId: t.instrumentKey ? ids[t.instrumentKey] : null,
                    type: t.type, date: t.date, units: t.units, price: t.price, amount: t.amount, currency: t.currency,
                    fee: t.fee ?? '0', feeCurrency: t.feeCurrency, fxToEur: t.fxToEur, importRef: t.ref, notes: t.notes,
                });
            }
            return { accountId, added: rows.length };
        },
    };
}
