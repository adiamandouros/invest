# Invest

A private web app for tracking investments: ETF purchases and P2P lending (Mintos, PeerBerry, Esketit, Robocash). It records every transaction and shows current value, yields and history in EUR.

Runs at https://invest.sonovabitc.win (Mediahost cPanel, Node.js 20, MySQL).

## Status

Phases 0 and 1 of the plan: the app skeleton, database, deployment, and sign-in (password + authenticator code). Next up are ETF transactions, then daily prices and FX, P2P accounts, the dashboard and charts, the yearly tax summary, and statement imports.

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
