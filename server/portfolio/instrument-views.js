import { dec, div, fixed, plain } from '../lib/decimal.js';
import { isUcits } from '../lib/tax.js';
import { escapeHtml as esc } from '../pages.js';
import { chart } from './reports-views.js';
import { money, percent, table, td, th, TYPE_LABELS } from './views.js';

// One holding's page: what you hold and have made on it, its price over time
// with your buys and sales marked and your average cost, and its
// transactions (also rendered by test/accessibility.test.js).
//
// position: valuation.js positions entry (or null if never held); prices:
// [{ date, close, currency }]; trades: its transactions, oldest first;
// averages: [{ date, average }] average cost per unit after each buy or sale.

const monthName = month => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const num = value => (value === null || value === undefined ? null : Number(fixed(dec(value), 4)));

export function instrumentContent({ instrument: i, position: p, prices, trades, averages }) {
    const ucits = isUcits(i);
    const kind = i.kind !== 'etf' ? 'Share' : ucits ? 'UCITS fund' : ucits === false ? 'ETF, not UCITS' : 'ETF';
    const currency = prices.at(-1)?.currency ?? i.currency;
    const head = `<h1 class="fs-3">${esc(i.symbol)}</h1>
<p>${esc(i.name)}${i.isin ? ` · ${esc(i.isin)}` : ''} · ${kind} · <a href="/instruments/${i.id}/edit">Edit</a> · <a href="/transactions?instrument=${i.id}">Transactions</a> · <a href="/holdings">All holdings</a></p>`;

    const summary = p ? `<dl class="summary">
    <div><dt>Units</dt><dd>${esc(plain(p.units))}</dd></div>
    <div><dt>Value now</dt><dd>${money(p.valueEur, 'EUR')}</dd></div>
    <div><dt>Cost</dt><dd>${money(p.costEur, 'EUR')}${p.units > 0n ? `<br><span class="small text-secondary-emphasis">avg ${money(div(p.cost, p.units), p.currency)} a unit</span>` : ''}</dd></div>
    <div><dt>Gain not yet taken</dt><dd>${money(p.unrealisedEur, 'EUR', { signed: true })}</dd></div>
    <div><dt>Gain from sales</dt><dd>${money(p.realisedEur, 'EUR', { signed: true })}</dd></div>
    <div><dt>Dividends after tax</dt><dd>${money(p.dividendsEur, 'EUR', { signed: true })}</dd></div>
    <div><dt>Return a year</dt><dd>${percent(p.xirr)}</dd></div>
</dl>` : '<p>You haven\'t held this yet.</p>';

    // The price chart: closes, buys and sales as points on the day, and the
    // average cost when it's in the price's currency
    let priceSection = '<p>No prices yet. They\'re fetched with the next price update; check the Yahoo Finance symbol if they don\'t come.</p>';
    if (prices.length) {
        const sameCurrency = (p?.currency ?? i.currency) === currency;
        const marks = type => trades.filter(t => t.type === type).map(t => ({ date: t.date, price: num(t.price), units: num(t.units) }));
        const label = `${i.symbol}'s closing price in ${currency} from ${prices[0].date} to ${prices.at(-1).date}, now ${fixed(dec(prices.at(-1).close))}, with your ${marks('buy').length} buys and ${marks('sell').length} sales marked${sameCurrency && averages.length ? ' and your average cost a unit' : ''}. The monthly figures are in the table below.`;
        // One figure a month for the table: the month's last close
        const monthly = new Map();
        for (const q of prices) monthly.set(q.date.slice(0, 7), q);
        const rows = [...monthly].reverse().map(([month, q]) => `                <tr>${td(esc(monthName(month)))}${td(money(dec(q.close), q.currency), true)}</tr>`).join('\n');
        priceSection = `${chart('price-chart', label, {
            type: 'price', currency,
            dates: prices.map(q => q.date), closes: prices.map(q => num(q.close)),
            buys: marks('buy'), sells: marks('sell'),
            averages: sameCurrency ? averages.map(a => ({ date: a.date, value: num(a.average) })) : [],
        })}
<details class="chart-figures">
    <summary>Monthly closes, newest first</summary>
    <div class="table-responsive" tabindex="0" role="region" aria-label="Monthly closes">
        <table class="table table-sm align-middle">
            <thead><tr>${th('Month')}${th(`Close (${esc(currency)})`, true)}</tr></thead>
            <tbody>
${rows}
            </tbody>
        </table>
    </div>
</details>`;
    }

    const tradeRows = [...trades].reverse().map(t => `            <tr>
                ${td(`<span class="text-nowrap">${esc(t.date)}</span>`)}
                ${td(esc(TYPE_LABELS[t.type] ?? t.type))}
                ${td(t.units === null ? '—' : esc(plain(dec(t.units))), true)}
                ${td(!dec(t.price) ? '—' : money(dec(t.price), t.currency), true)}
                ${td(money(dec(t.amount), t.currency, { signed: true }), true)}
                ${td(dec(t.fee) ? money(dec(t.fee), t.feeCurrency ?? t.currency) : '—', true)}
            </tr>`).join('\n');

    return `${head}
${summary}
<h2 class="fs-5 mt-4" id="price-heading">Price</h2>
${priceSection}
${trades.length ? table('trades-heading', 'Transactions, newest first', th('Date') + th('Type') + th('Units', true) + th('Price', true) + th('Amount', true) + th('Fee', true), tradeRows) : ''}`;
}
