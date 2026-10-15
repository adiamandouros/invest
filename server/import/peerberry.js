import { dec } from '../lib/decimal.js';
import { p2pStatement } from './p2p.js';
import { excelDate, readXlsx } from './xlsx.js';

// Reads PeerBerry transaction exports (Transactions, all types, exported to
// Excel) into a P2P statement (see p2p.js). Several files are read as one, so
// yearly exports that overlap at their ends are fine. PeerBerry gives no
// balance column, so the cash is worked out from the first deposit on.

const HEADER = ['ID', 'Date', 'Type', 'Amount', 'Currency'];

// Type → what it is. Checked in order; anything else is reported.
const KINDS = [
    [/^DEPOSIT$/, 'deposit'],
    [/^WITHDRAWAL$/, 'withdrawal'],
    [/TAX/, 'tax'],
    [/FEE/, 'fee'],
    [/^(INVESTMENT|.*PRINCIPAL)$/, 'internal'],
    [/INTEREST/, 'interest'],
    [/(BONUS|CAMPAIGN|REFERRAL|CASHBACK)/, 'bonus'],
];

export const isPeerberry = rows => HEADER.every((name, i) => rows[0]?.[i] === name);

function peerberryRows(rows) {
    if (!isPeerberry(rows)) throw new Error('This isn\'t a PeerBerry transactions export');
    return rows.slice(1).filter(cells => cells.some(c => c !== '')).map((cells, index) => {
        const [id, rawDate, type, amount, currency] = cells;
        const date = excelDate(rawDate).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{3}$/.test(currency ?? '') || !id) {
            throw new Error(`Row ${index + 2} of the PeerBerry file can't be read: expected an ID, a date and a currency`);
        }
        const label = type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
        // PeerBerry's IDs grow over time, so they order a day's rows
        return {
            id, at: date, order: Number(id) || 0, date, amount: dec(amount), balance: null, currency,
            label, kind: KINDS.find(([pattern]) => pattern.test(type))?.[1] ?? null,
        };
    });
}

// `files`: Buffers of .xlsx files
export const parsePeerberry = files => p2pStatement({
    platform: 'peerberry', name: 'PeerBerry', rows: [files].flat().flatMap(data => peerberryRows(readXlsx(data))),
});
