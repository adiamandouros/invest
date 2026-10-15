# Invest

A private web app for tracking investments: ETF purchases and P2P lending (Mintos, PeerBerry, Esketit, Robocash). It records every transaction and shows current value, yields and history in EUR.

Runs at https://invest.sonovabitc.win (Mediahost cPanel, Node.js 20, MySQL).

## Status

Phase 0 of the plan: the app skeleton, database connection, migrations and deployment. Next up are sign-in (password + authenticator code), then ETF transactions, daily prices and FX, P2P accounts, the dashboard and charts, the yearly tax summary, and statement imports.

## Running locally

```bash
npm install
cp .env.example .env   # then fill in the DB_* settings
npm run dev            # http://localhost:3000, restarts on changes
npm test
```

Without the `DB_*` settings the app still starts, and `/health` reports the database as "not configured".

## Database

Schema changes are SQL files in `db/migrations/`, named `NNN_short_name.sql` and applied in order. The app applies new ones when it starts (`npm run migrate` does it by hand). The `schema_migrations` table records each one with a checksum. **Never edit a migration that has been applied: add a new one.** MySQL can't roll back a half-applied `CREATE`/`ALTER`, so a failed migration has to be fixed by hand before the app is started again.

Money is stored as `DECIMAL` and read back as strings, so no amount is rounded through a float.

## Deploying on cPanel

First-time setup:

1. **MySQL Databases:** create the database and a user, and give the user *All privileges* on it. cPanel prefixes both names with `sonovabi_`.
2. **Git Version Control → Create:** clone this repository into `~/invest.sonovabitc.win` (the subdomain's folder; it must be empty).
3. **Setup Node.js App → Create:** Node.js 20, mode *Production*, application root `invest.sonovabitc.win`, URL `invest.sonovabitc.win`, startup file `start.cjs` (not `server.js`: LiteSpeed loads the startup file with `require()`, which Node 20 before 20.19 can't do for an ES module). Add the environment variables `DB_NAME`, `DB_USER` and `DB_PASSWORD` (`DB_HOST` defaults to `localhost`). Then click *Run NPM Install* and *Restart*.
4. **SSL/TLS Status:** make sure AutoSSL covers `invest.sonovabitc.win`.
5. Open https://invest.sonovabitc.win/health. It should show `{"status":"ok","db":"ok"}`.

Each later deploy: *Git Version Control → Manage → Pull or Deploy*: *Update from Remote*, then *Deploy HEAD Commit*. This runs `.cpanel.yml`, which installs packages and restarts the app (see `scripts/cpanel-deploy.sh`). Never run `npm install` in the app folder on the server, because `node_modules` there is a link the Node.js selector manages.

LiteSpeed serves `public/` itself with a 7-day cache, so stylesheets and scripts are linked with a `?v=<hash>` that changes on every deploy.
