import { readFileSync } from 'fs';
import { applyImport, parseStatement, planImport } from '../../server/import/index.js';
import { createMemoryData } from './memory-data.js';

// A small made-up portfolio for the reports and the overview: one ETF at a
// broker, and the made-up PeerBerry and Mintos statements in test/fixtures.
// Made up, by hand:
//   ETF (EUR, broker account): 101 deposited 2024-02-01; 10 bought at 10 + 1 fee on 2024-03-01;
//     closes 12 on 2024-12-31 and 15 from 2025-06-30; dividend 2 on 2025-03-01; 5 sold at 15 on 2025-06-30
//   PeerBerry (test/fixtures/peerberry-*.xlsx): 2024 only, 200 in, 50 out, 2.55 interest → 152.55
//   Mintos (test/fixtures/mintos-statement.csv): 2025 only, 500 in, 100 out → 405.412346
// 2024: 0 → 272.55 (ETF 120 + PeerBerry 152.55), put in 251, gain 21.55 (ETF +19, PeerBerry +2.55)
// 2025: → 709.962346 (ETF 75 + cash 77 + PeerBerry + Mintos), put in 400, gain 37.412346
//   (ETF 75 − 120 + 2 + 75 = +32, Mintos +5.412346); realised 75 − 50.5 = 24.5
export async function fixture() {
    const data = createMemoryData();
    const read = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
    await applyImport(await planImport(parseStatement([read('peerberry-1.xlsx'), read('peerberry-2.xlsx')]), data), data);
    await applyImport(await planImport(parseStatement(read('mintos-statement.csv')), data), data);
    const broker = await data.createAccount({ name: 'Broker', kind: 'broker', platform: 'broker', baseCurrency: 'EUR', openedOn: null, notes: null });
    const etf = await data.createInstrument({ symbol: 'ETF', name: 'An ETF', isin: null, kind: 'etf', currency: 'EUR', distributing: true, assetClass: null });
    const row = t => data.createTransaction({ accountId: broker, instrumentId: null, units: null, price: null, fee: '0', feeCurrency: null, fxToEur: '1', notes: null, currency: 'EUR', ...t });
    await row({ type: 'deposit', date: '2024-02-01', amount: '101' });
    await row({ type: 'buy', date: '2024-03-01', instrumentId: etf, units: '10', price: '10', amount: '-100', fee: '1' });
    await row({ type: 'dividend', date: '2025-03-01', instrumentId: etf, amount: '2' });
    await row({ type: 'sell', date: '2025-06-30', instrumentId: etf, units: '5', price: '15', amount: '75' });
    await data.savePrices([{ instrumentId: etf, date: '2024-12-31', close: '12', currency: 'EUR', source: 'manual' }, { instrumentId: etf, date: '2025-06-30', close: '15', currency: 'EUR', source: 'manual' }]);
    await data.saveAllocation({
        groups: [{ id: null, name: 'ETFs', targetPct: '60' }, { id: null, name: 'P2P', targetPct: '40' }], removed: [],
        instruments: [[etf, 1]], accounts: [[1, 2], [2, 2]],
    });
    return data;
}

