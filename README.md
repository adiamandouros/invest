# Invest

A private web app for tracking investments: ETF purchases and P2P lending (Mintos, PeerBerry, Esketit, Robocash). It records every transaction and shows current value, yields and history in EUR.

Runs at https://invest.sonovabitc.win (Mediahost cPanel, Node.js 20, MySQL).

## Status

Phases 0 and 1 of the plan are live: the app skeleton, database, deployment, and sign-in (password + authenticator code). Phase 2 is done: accounts, instruments, a transaction ledger, Freedom24 statement imports, a holdings page with cost basis, and forms to add, edit and delete entries by hand. Next up are daily prices and FX, P2P accounts, the dashboard and charts, the yearly tax summary, and P2P statement imports.

## Running locally

```bash
npm install
cp .env.example .env   # then fill in the DB_* settings and ENCRYPTION_KEY
npm run dev            # http://localhost:3000, restarts on changes
npm test
```

Without the `DB_*` settings the app still starts, and `/health` reports the database as "not configured".

## Signing in

Every page needs a signed-in session, except `/login`, `/health` and the static files. Sign-in has two steps: username and password, then a 6-digit code from an authenticator app. Each code works only once.

- **Create the user:** `npm run create-user`. It asks for a username and a password of at least 12 characters, then you sign in and scan the QR code to set up the authenticator app. Run it again for the same username to set a new password.
- **Lost phone:** `npm run create-user -- --reset-2fa`, then sign in to set up the app again.
- **`ENCRYPTION_KEY`** encrypts the authenticator secret in the database (see `.env.example`). If it's lost or changed, sign-in fails until you run `--reset-2fa`.
- Five wrong attempts block a client for 15 minutes. Ten in a row lock the user for 15 minutes, from everywhere. Changing the password or resetting the authenticator signs out every device.

On the server, run the script from cPanel → Terminal: `cd ~/repositories/invest && source ~/nodevenv/repositories/invest/20/bin/activate && npm run create-user`.

## Holdings and imports

Every account (a broker or a P2P platform) has one ledger in the `transactions` table: buys, sells, dividends, withheld tax, fees, deposits, withdrawals, transfers and currency exchanges. Each row's `amount` is its signed cash effect, so cash balances are plain sums. `server/lib/holdings.js` turns the ledger into holdings: units, cost basis (FIFO, fees included, in EUR at the rate on the day) and realised gains.

**Freedom24:** in Freedom24, open Reports → Broker report, choose the whole period and the JSON format, then upload the file on the app's Import page. The preview shows what's new and compares the result with the report's closing cash and positions before anything is saved. Each row is saved with Freedom24's own ID, so importing the same or an overlapping report again only adds what's new.

**By hand:** Transactions → *Add a transaction*, or *Edit* on any row. Amounts are typed as positive numbers, and the type decides whether money came in or went out; currency exchanges are the exception, with a negative amount for the side paid. Editing an imported row keeps its link to the statement, so importing again doesn't add it back. Instruments and Accounts have their own pages, where you can say whether an ETF pays out its dividends.

Never commit a real statement: the repository is public. Tests use the made-up `test/fixtures/freedom24-report.json`.

## Database

Schema changes are SQL files in `db/migrations/`, named `NNN_short_name.sql` and applied in order. The app applies new ones when it starts (`npm run migrate` does it by hand). The `schema_migrations` table records each one with a checksum. **Never edit a migration that has been applied: add a new one.** MySQL can't roll back a half-applied `CREATE`/`ALTER`, so a failed migration has to be fixed by hand before the app is started again.

Money is stored as `DECIMAL` and read back as strings, so no amount is rounded through a float.

## Deploying on cPanel

First-time setup:

1. **MySQL Databases:** create the database and a user, and give the user *All privileges* on it. cPanel prefixes both names with `sonovabi_`.
2. **Git Version Control → Create:** clone this repository into `~/repositories/invest`.
3. **Setup Node.js App → Create:** Node.js 20, application root `repositories/invest`, URL `invest.sonovabitc.win`, startup file `start.cjs`. Set `DB_NAME`, `DB_USER`, `DB_PASSWORD` (`DB_HOST` defaults to `localhost`) and `ENCRYPTION_KEY`, either as the app's environment variables or in a `.env` file in `~/repositories/invest`. Then click *Run NPM Install* and *Restart*.
4. **SSL/TLS Status:** make sure AutoSSL covers `invest.sonovabitc.win`.
5. Open https://invest.sonovabitc.win/health. It should show `{"status":"ok","db":"ok"}`.

Each later deploy: *Git Version Control → Manage → Pull or Deploy*: *Update from Remote*, then *Deploy HEAD Commit*. This runs `.cpanel.yml`, which installs packages and restarts the app (see `scripts/cpanel-deploy.sh`). Never run `npm install` in the app folder on the server, because `node_modules` there is a link the Node.js selector manages.

If every request hangs, LiteSpeed is probably still sending requests to an old app process that never started, and *Restart* doesn't replace it. In cPanel → Terminal, `ps -u sonovabi -o pid,etime,args | grep -i [n]ode` lists the app processes. A working one is named `lsnode:/home/sonovabi/repositories/invest/`. A stuck one shows as `node …/lsnode.js`, and `readlink /proc/<pid>/cwd` points into `~/nodevenv/repositories/invest/`. Stop it with `kill <pid>`; the next request starts a fresh process.

LiteSpeed serves `public/` itself with a 7-day cache, so stylesheets and scripts are linked with a `?v=<hash>` that changes on every deploy.
