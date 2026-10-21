# Casierul clasei v0.1.0 — self-hosting source kit

Casierul clasei is a Romanian-language PWA for managing a school class fund.
Cashiers record expenses, contributions, advances and corrections; invited
parents can view their own child's position, while auditors can view the whole
ledger. This ZIP contains the complete source needed to build the Node app in
Docker, including the local PDF viewer, fonts, and the admin and backup scripts.

**This kit is for a fresh installation.** It does not migrate or upgrade an
existing Casierul clasei volume or systemd installation. It contains no
student records, contacts, financial data, screenshots, database, invitation
codes or real configuration. [The example](examples/first-run.md) uses
invented labels only. The application code and release documentation are
GPL-3.0-or-later; bundled third-party components keep their own terms in
[NOTICE.md](NOTICE.md).

## Run locally first

You need Docker with Compose, `openssl`, `curl`, and enough disk for a Node 24
image. Verify the ZIP against the separately downloaded `SHA256SUMS`, extract
it, and run these commands inside `Casierul-clasei-v0.1.0/`:

1. Copy `example.env` to `.env`. Set `PUBLIC_BASE_URL` to
   `http://127.0.0.1:8018` and `COOKIE_SECURE=false` for this **local trial**.
   Generate a private admin token with `openssl rand -hex 32` and paste the
   result into `ADMIN_TOKEN`. Run `chmod 600 .env`; never commit or share it.
2. Run `docker compose config --quiet`, then `docker compose up -d --build`.
   Check `docker compose ps` and
   `curl --fail http://127.0.0.1:8018/api/health`.
3. Run `docker compose exec app node scripts/admin.mjs invite "Local trial"`.
   Open the returned link on **this computer** at the exact
   `http://127.0.0.1:8018` origin and redeem it. The first cashier device to
   activate on a fresh installation becomes the owner.
4. Follow the [synthetic first-run example](examples/first-run.md). The app
   starts with an empty ledger; no example records are inserted automatically.

For a different host port, set `CASIERUL_PORT` in `.env` and use that same port
in `PUBLIC_BASE_URL` and the browser. Keep the Compose port bound to loopback.
The admin API is on a separate loopback listener **inside the container**;
never proxy or publish it. The public listener returns 404 for admin routes.

## Access from other devices

Use a private HTTPS reverse proxy or VPN in front of the loopback web port.
Set `PUBLIC_BASE_URL` to the exact HTTPS origin and `COOKIE_SECURE=true` in
`.env`, then run `docker compose up -d`. The server rejects requests from a
different browser origin. Protect the host and volume: SQLite files, report
archives and backups are **not encrypted at rest** by this application.
Parents' phone numbers, children's names, attachments and financial history
can be stored there. Give each person only the invitation role they need.

## Back up before every upgrade

For Docker, create a validated SQLite snapshot and copy it **outside** the
container volume:

```sh
mkdir -m 700 -p private-backups
docker compose exec -T app node scripts/backup.mjs
docker compose cp app:/data/backups/. ./private-backups/
```

Protect that folder, keep a separate off-machine copy, and check that the
backup finished successfully. A complete restore needs `auth.sqlite`, every
active classroom database and any archived reports **from the same snapshot**.
Never overwrite a running database, mix snapshots or assume an older version
can read a newer schema. See the main repository's
[operations guide](https://github.com/zandaulion/casierul-clasei/blob/main/docs/operations.md)
before restoring or upgrading. `docker compose down` keeps the volume;
`docker compose down -v` deletes it.

## Source, support and limits

This tagged tree is the source used for the Docker image. The
[development repository](https://github.com/zandaulion/casierul-clasei)
contains automated tests, design documents and deployment scripts. Report
bugs using invented examples, never actual student or payment data. Report
security issues through [SECURITY.md](SECURITY.md).

The app supports careful bookkeeping; it cannot verify that physical cash or
bank payments occurred. Reconcile the ledger with receipts and the actual
fund. Saving requires a network connection; there is no offline write queue.
For a Romanian product guide and current feature list, read the
[main README](https://github.com/zandaulion/casierul-clasei/blob/main/README.md).
