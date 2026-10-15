// An in-memory stand-in for server/data/store.js, with the same behaviour,
// so the pages and imports can be tested without MySQL. Change both together.
export function createMemoryData() {
    const accounts = [];
    const instruments = [];
    const transactions = [];
    const prices = [];
    const fxRates = [];
    const status = {};
    const balances = [];
    const groups = [];
    const lastBy = (list, key) => {
        const last = {};
        for (const r of list) if (!last[r[key]] || r.date > last[r[key]]) last[r[key]] = r.date;
        return last;
    };
    const upsert = (list, row, same) => {
        const i = list.findIndex(same);
        if (i === -1) list.push(row); else list[i] = row;
    };
    const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);

    return {
        accounts,
        instruments,
        transactions,
        prices,
        fxRates,
        status,
        balances,
        groups,

        listAccounts: async () => [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
        findAccount: async (platform, externalRef) => [...accounts].sort((a, b) => a.id - b.id)
            .find(a => a.platform === platform && (externalRef === null || a.externalRef === externalRef)) ?? null,
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
        async setPriceSymbol(id, priceSymbol, priceSource) { Object.assign(instruments.find(x => x.id === id), { priceSymbol, priceSource }); },

        listPrices: async () => [...prices].sort((a, b) => a.instrumentId - b.instrumentId || (a.date < b.date ? -1 : 1)),
        lastPriceDates: async () => lastBy(prices, 'instrumentId'),
        async savePrices(list) { for (const p of list) upsert(prices, { ...p }, x => x.instrumentId === p.instrumentId && x.date === p.date); },
        listFxRates: async () => [...fxRates].sort((a, b) => a.currency.localeCompare(b.currency) || (a.date < b.date ? -1 : 1)),
        lastFxDates: async () => lastBy(fxRates, 'currency'),
        async saveFxRates(list) { for (const r of list) upsert(fxRates, { ...r }, x => x.currency === r.currency && x.date === r.date); },
        marketStatus: async () => structuredClone(status),
        async setMarketStatus(name, ok, message) {
            status[name] = { checkedAt: new Date().toISOString().slice(0, 19).replace('T', ' '), ok, message: message ?? null };
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

        listGroups: async () => groups.map((g, position) => ({ ...g, position })),
        async saveAllocation({ groups: list, removed, instruments: forInstruments, accounts: forAccounts }) {
            const kept = groups.filter(g => !removed.includes(g.id));
            for (const x of [...instruments, ...accounts]) if (removed.includes(x.allocationGroupId)) x.allocationGroupId = null;
            let next = Math.max(0, ...groups.map(g => g.id)) + 1;
            const saved = list.map(g => (g.id ? { ...kept.find(k => k.id === g.id), name: g.name, targetPct: g.targetPct } : { id: next++, name: g.name, targetPct: g.targetPct }));
            if (new Set(saved.map(g => g.name)).size !== saved.length) throw Object.assign(new Error('Duplicate name'), { code: 'ER_DUP_ENTRY' });
            groups.splice(0, groups.length, ...saved);
            for (const [id, groupId] of forInstruments) instruments.find(i => i.id === id).allocationGroupId = groupId;
            for (const [id, groupId] of forAccounts) accounts.find(a => a.id === id).allocationGroupId = groupId;
        },

        listBalances: async ({ accountId } = {}) => balances
            .filter(b => !accountId || b.accountId === accountId)
            .sort((a, b) => a.accountId - b.accountId || (a.date < b.date ? -1 : 1))
            .map(b => ({ ...b })),
        async saveBalance(b) {
            const old = balances.find(x => x.accountId === b.accountId && x.date === b.date);
            upsert(balances, { accountId: b.accountId, date: b.date, value: b.value, cash: b.cash ?? old?.cash ?? null, source: 'manual', notes: b.notes },
                x => x.accountId === b.accountId && x.date === b.date);
        },
        async deleteBalance(accountId, date) {
            const i = balances.findIndex(x => x.accountId === accountId && x.date === date);
            if (i !== -1) balances.splice(i, 1);
        },

        async importStatement({ account, instrumentIds, instruments: added, transactions: rows, updates = [], balances: cashes = [] }) {
            let accountId = account.id;
            if (!accountId) {
                accountId = accounts.length + 1;
                accounts.push({ id: accountId, ...account });
            }
            const ids = { ...instrumentIds };
            for (const i of added) {
                const id = instruments.length + 1;
                instruments.push({ id, isin: i.isin, symbol: i.symbol, name: i.name, kind: i.kind, currency: i.currency ?? 'EUR', distributing: null, assetClass: null, priceSymbol: null, priceSource: null });
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
            for (const u of updates) {
                const t = transactions.find(x => x.id === u.id && x.accountId === accountId);
                if (t) Object.assign(t, { amount: u.amount, date: u.date, notes: u.notes });
            }
            for (const b of cashes) {
                const old = balances.find(x => x.accountId === accountId && x.date === b.date);
                if (old) old.cash = b.cash;
                else balances.push({ accountId, date: b.date, value: null, cash: b.cash, source: 'import', notes: null });
            }
            return { accountId, added: rows.length };
        },
    };
}
