import { dec } from '../lib/decimal.js';
import { p2pStatement } from './p2p.js';

// Reads Mintos account statements (Account → Account statement, exported as
// CSV) into a P2P statement (see p2p.js). Several files are read as one, so
// overlapping periods are fine. The Balance column, the cash after each row,
// lets the import check that nothing was missed.

const HEADER = ['Date', 'Transaction ID:', 'Details', 'Turnover', 'Balance', 'Currency', 'Payment Type'];

// Payment type → what it is. Checked in order; anything else is reported.
const KINDS = [
    [/^deposits?$/i, 'deposit'],
    [/^withdrawals?$/i, 'withdrawal'],
    [/^tax withholding/i, 'tax'],
    [/fee$/i, 'fee'],
    [/^(investment|principal received|secondary market transaction)/i, 'internal'],
    [/^(interest received|delayed interest income|late fees received)/i, 'interest'],
    [/(bonus|reward|cashback|referral)/i, 'bonus'],
];

const withoutBom = text => text.replace(/^﻿/, '');

export const isMintos = text => csvRows(withoutBom(text).split(/\r?\n/, 1)[0])[0]?.join('|') === HEADER.join('|');

// RFC 4180: commas, "quoted, fields" and "" for a quote inside one
export function csvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += c;
    }
    if (field || row.length) rows.push([...row, field]);
    return rows.filter(r => r.some(f => f !== ''));
}

// One file's rows for p2pStatement; `file` numbers the files, to keep their order within a second
function mintosRows(text, file = 0) {
    const [header, ...lines] = csvRows(withoutBom(text));
    if (header?.join('|') !== HEADER.join('|')) throw new Error('This isn\'t a Mintos account statement in CSV format');
    return lines.map((cells, index) => {
        const [at, id, , turnover, balance, currency, label] = cells;
        if (!/^\d{4}-\d{2}-\d{2}/.test(at ?? '') || !/^[A-Z]{3}$/.test(currency ?? '')) {
            throw new Error(`Row ${index + 2} of the statement can't be read: expected a date and a currency`);
        }
        return {
            id, at, order: file * 1e9 + index, date: at.slice(0, 10), amount: dec(turnover), balance: dec(balance), currency,
            label, kind: KINDS.find(([pattern]) => pattern.test(label))?.[1] ?? null,
        };
    });
}

export const parseMintos = texts => p2pStatement({
    platform: 'mintos', name: 'Mintos', rows: [texts].flat().flatMap((text, file) => mintosRows(text, file)),
});
