import { escapeHtml as esc } from '../pages.js';

// The export page (also rendered by test/accessibility.test.js). `counts`:
// how many rows of each kind the downloads hold.
export const exportContent = ({ counts }) => `<h1 class="fs-3">Export your data</h1>
<p>Your own copy of everything in the app, on top of the hosting's backups. Keep it somewhere private: it lists all your holdings and transactions.</p>
<h2 class="fs-5 mt-4">Full backup</h2>
<p>Every account, instrument, transaction, P2P balance, allocation group, price and exchange rate, as one JSON file. Your password, authenticator app and sign-ins aren't in it.</p>
<p>Right now: ${esc(`${counts.accounts} accounts, ${counts.transactions} transactions, ${counts.prices} prices`)}.</p>
<p><a href="/export/backup.json" class="btn btn-primary" download>Download the backup (JSON)</a></p>
<h2 class="fs-5 mt-4">Transactions for a spreadsheet</h2>
<p>Every transaction, one per row, for Excel or LibreOffice.</p>
<p><a href="/export/transactions.csv" class="btn btn-outline-primary" download>Download the transactions (CSV)</a></p>
<p class="mt-4"><a href="/settings">Back to settings</a></p>`;
