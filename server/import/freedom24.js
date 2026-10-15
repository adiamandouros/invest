// Reads a Freedom24 broker report (Reports → Broker report, JSON format) into
// a statement for server/import/index.js:
//
//   { platform, accountRef, accountName, baseCurrency, openedOn,
//     period: { start, end },
//     instruments: [{ key, isin, symbol, name, kind, currency }],
//     transactions: [{ ref, instrumentKey, type, date, units, price, amount, currency,
//                      fee, feeCurrency, fxToEur, notes }],
//     opening: { cash: { currency: amount }, positions: { instrumentKey: units } },
//     closing: { cash: {...}, positions: {...} },
//     warnings: [] }
//
// Numbers stay strings. Every transaction's `ref` is built from Freedom24's own
// IDs, so importing an overlapping report again finds the same rows.

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
// Freedom24's own bookkeeping for withdrawals: money set aside, then released
// again, in pairs that add up to nothing (the withdrawal itself is a 'bank' row)
const BLOCKING = new Set(['block', 'unblock', 'block_commission', 'unblock_commission']);
// The fee for withdrawals and the interest on a negative balance come as commissions
const OTHER_FEES = /^(Other fees|Interest on the use of funds)/;

export const isFreedom24 = report => Boolean(report?.plainAccountInfoData?.client_code && report?.trades?.detailed);

const str = value => (value === null || value === undefined ? null : String(value));
const day = value => String(value).slice(0, 10);
const note = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
const negate = value => (String(value).startsWith('-') ? String(value).slice(1) : `-${value}`);

// "Currency exchange of trade (USD) to a currency exchange of the service plan (EUR) is 0.8832."
function tradeRate(comment) {
    return String(comment ?? '').match(/service plan \(EUR\) is (\d+(?:\.\d+)?)/)?.[1] ?? null;
}

export function parseFreedom24(report) {
    if (!isFreedom24(report)) throw new Error('This isn\'t a Freedom24 broker report in JSON format');
    const info = report.plainAccountInfoData;
    const warnings = [];
    const instruments = new Map();
    const bySymbol = new Map();

    function instrument({ symbol, isin, name, kind, currency }) {
        const key = isin && ISIN.test(isin) ? isin : symbol;
        const existing = instruments.get(key);
        if (existing) {
            if (name && existing.name === existing.symbol) existing.name = name;
            existing.currency ??= currency;
        } else {
            instruments.set(key, {
                key, isin: ISIN.test(isin ?? '') ? isin : null, symbol, name: name || symbol,
                kind: kind ?? 'other', currency: currency ?? null,
            });
        }
        bySymbol.set(symbol, key);
        return key;
    }

    const startPositions = report.account_at_start?.account?.positions_from_ts?.ps ?? {};
    const endPositions = report.account_at_end?.account?.positions_from_ts?.ps ?? {};
    // Names come only with positions; instr_kind is in Russian ("фонд/ETF", "акция обыкновенная")
    const names = new Map([...(startPositions.pos ?? []), ...(endPositions.pos ?? [])].map(p => [p.i, p.name]));
    const kindOf = instrKind => (/ETF/i.test(instrKind ?? '') ? 'etf' : /акци/i.test(instrKind ?? '') ? 'stock' : 'other');

    const transactions = [];
    const push = row => transactions.push({
        instrumentKey: null, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: null, notes: null, ...row,
    });

    // ── Trades ──────────────────────────────────────────────────────────────

    for (const t of report.trades.detailed) {
        const date = day(t.short_date ?? t.date);
        const sign = t.operation === 'buy' ? 1 : t.operation === 'sell' ? -1 : 0;
        if (!sign) {
            warnings.push(`Trade ${t.trade_id}: unknown operation "${t.operation}", skipped`);
            continue;
        }
        if (t.instr_type === 6) {
            // A currency exchange, e.g. USD/EUR: buying q USD for summ EUR
            const [base, quote] = String(t.instr_nm).split('/');
            push({
                ref: `trade:${t.trade_id}:${base}`, type: 'exchange', date,
                amount: sign > 0 ? str(t.q) : negate(t.q), currency: base,
                fxToEur: quote === 'EUR' ? str(t.p) : null,
            });
            push({
                ref: `trade:${t.trade_id}:${quote}`, type: 'exchange', date,
                amount: sign > 0 ? negate(t.summ) : str(t.summ), currency: quote,
                fee: str(t.commission ?? 0), feeCurrency: t.commission_currency ?? quote,
                fxToEur: quote === 'EUR' ? '1' : null,
            });
            continue;
        }
        const key = instrument({
            symbol: t.instr_nm, isin: t.isin ?? t.issue_nb, name: names.get(t.instr_nm),
            kind: kindOf(t.instr_kind), currency: t.curr_c,
        });
        push({
            ref: `trade:${t.trade_id}`, instrumentKey: key, type: sign > 0 ? 'buy' : 'sell', date,
            units: str(t.q), price: str(t.p), amount: sign > 0 ? negate(t.summ) : str(t.summ), currency: t.curr_c,
            fee: str(t.commission ?? 0), feeCurrency: t.commission_currency ?? t.curr_c,
            fxToEur: t.curr_c === 'EUR' ? '1' : tradeRate(t.comment),
        });
    }

    // ── Positions at the start, and shares received or given ────────────────

    const opening = { cash: {}, positions: {} };
    for (const a of startPositions.acc ?? []) if (Number(a.s)) opening.cash[a.curr] = str(a.s);
    for (const p of startPositions.pos ?? []) {
        if (!Number(p.q)) continue;
        const key = instrument({ symbol: p.i, isin: p.issue_nb, name: p.name, kind: p.k === 7 ? 'etf' : 'stock', currency: p.curr });
        opening.positions[key] = { units: str(p.q), price: str(p.bal_price_a ?? 0) };
    }

    for (const s of report.securities_in_outs ?? []) {
        const units = String(s.quantity);
        const key = bySymbol.get(s.ticker) ?? instrument({ symbol: s.ticker, isin: s.isin, name: names.get(s.ticker), kind: 'stock', currency: s.balance_currency });
        const received = !units.startsWith('-');
        push({
            ref: `securities:${s.id}`, instrumentKey: key, type: received ? 'shares_in' : 'shares_out', date: day(s.datetime),
            units: received ? units : negate(units), price: '0', amount: '0',
            currency: instruments.get(key).currency ?? s.balance_currency ?? 'USD', notes: note(s.comment),
        });
    }

    // ── Cash in and out ─────────────────────────────────────────────────────

    const blocked = {};
    for (const c of report.cash_in_outs ?? []) {
        if (c.offbalance) continue; // the separate "blocked" accounts behind a withdrawal
        if (BLOCKING.has(c.type)) {
            blocked[c.currency] = (blocked[c.currency] ?? 0) + Number(c.amount);
            continue;
        }
        const positive = !String(c.amount).trim().startsWith('-');
        const row = {
            ref: `cash:${c.id}`, date: day(c.datetime), amount: String(Number(c.amount)), currency: c.currency,
            fxToEur: c.currency === 'EUR' ? '1' : null, notes: note(c.comment),
        };
        if (c.type === 'bank') push({ ...row, type: positive ? 'deposit' : 'withdrawal' });
        else if (c.type === 'intercompany') push({ ...row, type: positive ? 'transfer_in' : 'transfer_out' });
        else if (c.type === 'dividend' || c.type === 'tax') {
            const key = bySymbol.get(c.ticker) ?? instrument({ symbol: c.ticker, isin: null, name: null, kind: 'other', currency: c.currency });
            push({ ...row, type: c.type, instrumentKey: key });
        } else {
            warnings.push(`Cash row ${c.id}: unknown type "${c.type}" (${c.amount} ${c.currency}), skipped`);
        }
    }
    for (const [currency, total] of Object.entries(blocked)) {
        if (Math.abs(total) > 0.004) warnings.push(`Blocked ${currency} amounts don't add up to zero (${total.toFixed(2)}): check the cash balance`);
    }

    for (const f of report.commissions?.detailed ?? []) {
        if (!OTHER_FEES.test(f.type) || !Number(f.sum)) continue;
        push({
            ref: `fee:${f.datetime}:${f.sum}${f.currency}`, type: 'fee', date: day(f.datetime),
            amount: negate(String(Number(f.sum))), currency: f.currency,
            fxToEur: f.currency === 'EUR' ? '1' : null, notes: note(f.comment),
        });
    }

    // ── What the broker says is there at the end, to check the import ───────

    const closing = { cash: {}, positions: {} };
    for (const a of endPositions.acc ?? []) closing.cash[a.curr] = str(a.s);
    for (const p of endPositions.pos ?? []) {
        if (!Number(p.q)) continue;
        const key = instrument({ symbol: p.i, isin: p.issue_nb, name: p.name, kind: p.k === 7 ? 'etf' : 'stock', currency: p.curr });
        closing.positions[key] = str(p.q);
    }

    return {
        platform: 'freedom24',
        accountRef: String(info.client_code),
        accountName: 'Freedom24',
        baseCurrency: info.base_currency ?? 'EUR',
        openedOn: info.client_date_open ? day(info.client_date_open) : null,
        period: { start: day(report.date_start), end: day(report.date_end) },
        instruments: [...instruments.values()],
        transactions,
        opening,
        closing,
        warnings,
    };
}
