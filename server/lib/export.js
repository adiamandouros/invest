// Everything the app holds about your money, for your own backups: one JSON
// file with every table (not the sign-in tables: no password, authenticator
// secret or sessions), and the transactions as CSV for a spreadsheet.
// `data`: server/data/store.js.

export const BACKUP_FORMAT = 1;

export async function backup(data, now = new Date()) {
    const [accounts, instruments, transactions, p2pBalances, allocationGroups, prices, fxRates] = await Promise.all([
        data.listAccounts(), data.listInstruments(), data.listTransactions(), data.listBalances(), data.listGroups(),
        data.listPrices(), data.listFxRates(),
    ]);
    return {
        app: 'invest',
        format: BACKUP_FORMAT,
        exportedAt: now.toISOString(),
        accounts, instruments, transactions, p2pBalances, allocationGroups, prices, fxRates,
    };
}

const cell = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export async function transactionsCsv(data) {
    const [accounts, instruments, transactions] = await Promise.all([data.listAccounts(), data.listInstruments(), data.listTransactions()]);
    const account = new Map(accounts.map(a => [a.id, a]));
    const instrument = new Map(instruments.map(i => [i.id, i]));
    const rows = [
        ['Date', 'Account', 'Type', 'Symbol', 'ISIN', 'Units', 'Price', 'Amount', 'Currency', 'Fee', 'Fee currency', 'EUR rate', 'Notes', 'Statement reference'],
        ...transactions.map(t => {
            const i = instrument.get(t.instrumentId);
            return [t.date, account.get(t.accountId)?.name, t.type, i?.symbol, i?.isin, t.units, t.price, t.amount, t.currency,
                t.fee, t.feeCurrency, t.fxToEur, t.notes, t.importRef];
        }),
    ];
    return `${rows.map(r => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
