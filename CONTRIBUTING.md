# Contributing

Thanks for helping with Casierul clasei. The interface and most documentation are in Romanian, since the app is built for Romanian class treasurers; code, commit messages and this file are in English.

## Setting up

```
git clone https://github.com/zandaulion/casierul-clasei.git
cd casierul-clasei
npm ci
npm test
npm start          # http://127.0.0.1:8018, admin API on 127.0.0.1:8118
```

Node.js 24 or newer is required (`node:sqlite` is used without native dependencies). For a local trial without HTTPS, start with `COOKIE_SECURE=false ADMIN_TOKEN=dev-secret npm start`, then issue an invitation with `ADMIN_TOKEN=dev-secret node scripts/admin.mjs invite "Laptop"` and open the printed link. Production installations need HTTPS; `deploy.sh` installs user services but does not configure the reverse proxy or certificate.

## Before opening a pull request

- `npm test` must pass; it runs on every pull request through GitHub Actions.
- If you changed the web app, also run the browser check against a headless Chromium with remote debugging on port 9222; see "Browser checks" below.
- Keep changes focused. Financial logic lives in `server/ledger.mjs` and must stay append-only: corrections are new records, never edits.
- Amounts are integers in bani (`…Minor` fields); never use floating point for money.
- Every ledger mutation goes through `dispatch()` with a `requestId` and `expectedRevision`; new operations follow the same pattern and get tests in `test/ledger.test.mjs`.
- User-facing text is Romanian, with diacritics. Escape everything interpolated into HTML with `esc()`.
- No new runtime dependencies without a good reason; the server intentionally uses only Node built-ins plus `pdfkit`.

## Browser checks

Start a dedicated headless Chromium that exposes DevTools only on loopback, then run the functional and optional visual checks in another terminal:

```bash
chromium --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank
```

```bash
node scripts/browser-check.mjs
node scripts/browser-polish-check.mjs # optional extended layout matrix
```

On Oracle Linux 9 ARM64, the official Oracle EPEL repository provides a native headless build. Keep the repository disabled by default and enable it only for the install transaction:

```bash
sudo dnf install oracle-epel-release-el9
sudo dnf --enablerepo=ol9_developer_EPEL install chromium-headless
/usr/lib64/chromium-browser/headless_shell --headless --disable-gpu \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank
```

The browser process is temporary: stop it with `Ctrl+C` after the checks. Do not expose port 9222 publicly. The headless shell works with its sandbox when launched normally on the host; do not add `--no-sandbox` merely to bypass restrictions in a container or managed execution environment.

## Reporting bugs and ideas

Open an issue with the steps to reproduce, or with the workflow you would like to see. Security problems go through [SECURITY.md](SECURITY.md) instead. The product roadmap is in `docs/roadmap.md`; the API is described in `docs/api.md`.
