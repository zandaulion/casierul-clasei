---
name: deploy
description: Install, upgrade, verify or roll back a production deployment of Casierul clasei on a Linux server (systemd user service or Docker, behind an HTTPS reverse proxy), and issue the first cashier invitation. Use when asked to deploy, install, publish, host, upgrade or move this app to a server.
---

# Deploying Casierul clasei

You are deploying a small Node.js PWA that holds children's names, parents' phone numbers and a class's money. Treat the data directory and the admin token as sensitive, prefer the repository's own scripts over hand-made equivalents, and stop to ask the human whenever this guide says so.

Read this whole file before running anything. Background, in Romanian, is in `docs/operations.md`; when they disagree, the scripts are the truth.

## How the app is put together

- One process (`server/index.mjs`) serves two listeners:
  - **public** `HOST:PORT`, default `127.0.0.1:8018` — the web app and `/api/*`; it always answers 404 for `/api/admin/*`.
  - **admin** `127.0.0.1:ADMIN_PORT`, default `8118`, always loopback — invitations and devices, authenticated by the `X-Admin-Token` header. Never expose or proxy it to the internet.
- Data: SQLite files in `DATA_DIR` (`auth.sqlite`, `ledger.sqlite`, one `classroom-<uuid>.sqlite` per extra classroom, `backups/`). Schema migrations run automatically on start.
- Configuration is environment variables only:

  | Variable | Meaning |
  |---|---|
  | `PUBLIC_BASE_URL` | Required. The exact HTTPS origin users open, e.g. `https://casierul.example.com` (scheme + host, no path, no trailing slash). Requests whose `Origin` differs are rejected with 403. |
  | `ADMIN_TOKEN` | Secret for the admin API. Without it every admin request is 404. |
  | `DATA_DIR` | Data directory. |
  | `HOST`, `PORT` | Public listener, default `127.0.0.1:8018`. |
  | `ADMIN_PORT` | Admin listener port on 127.0.0.1, default `8118`. |
  | `COOKIE_SECURE` | `true` (default) in production. `false` only for a local plain-HTTP trial. |

- There is no HTTPS in the app. Production always needs a reverse proxy that terminates TLS (Caddy, nginx, Cloudflare Tunnel, Traefik). The session cookie is `__Host-` + `Secure`, so over plain HTTP activation silently fails unless `COOKIE_SECURE=false`.
- The first **cashier** device that activates an invitation on a fresh install becomes the **owner** (it can create more classrooms). This cannot be reassigned from the UI.

## Hard rules

- Never print, log, commit or include `ADMIN_TOKEN` or `.env`/`app.env` contents in a response. When inspecting configuration, show only the non-secret settings needed for the decision and always redact the token. A newly issued invitation code or link may be delivered only to the human who requested it, in their private conversation.
- Never delete, move, rename or overwrite anything in `DATA_DIR` (including `classroom-*.sqlite`, `*-wal`, `*-shm`). Restoring a backup is the human's decision; see "Rolling back".
- Never redeem a real invitation yourself to "test" activation: it consumes one of its two activations, and on a fresh install it makes your client the owner. Use the checks in "Verify" instead.
- Never run the app as root, never bind the admin port to anything but loopback, never open ports 8018/8118 in the firewall.
- An explicit request to install, upgrade or deploy authorizes routine read-only checks, dependency installation inside the checkout, a validated backup, the repository's deploy or build command, service or container restart, and the known optional console update performed by `deploy.sh`. Ask separately before installing system packages, changing reverse-proxy or firewall configuration, enabling lingering, restoring, replacing or deleting production data, or running an unexpected privileged command outside that workflow. Say exactly what you will run when separate approval is needed.
- Take a backup before every upgrade of an existing installation.
- Do not edit application code to make a deployment work. If something in the repository is wrong, stop and report it.

## Step 1 — Gather facts (read-only)

Run and note the results:

```bash
uname -a; cat /etc/os-release | head -3
node --version; npm --version; python3 --version
command -v systemctl docker curl git caddy nginx cloudflared
id -un; echo "$HOME"
systemctl --user status casierul-clasei.service --no-pager 2>/dev/null | head -5
test -f ~/.config/casierul-clasei/app.env && echo "existing systemd install"
docker compose ls 2>/dev/null
ss -ltnp 2>/dev/null | grep -E ':(8018|8118)\b'
getenforce 2>/dev/null
```

Then establish with the human, asking only for what you cannot detect:

1. **Fresh install or upgrade?** An existing `~/.config/casierul-clasei/app.env`, a running `casierul-clasei.service` or a compose project with this app means upgrade — go to "Upgrading".
2. **Public origin** (`https://…`) and whether its DNS already points at this server or at Cloudflare.
3. **Method**: systemd user service (default when Node.js 24+ is present) or Docker (when Docker is present and preferred, or Node.js cannot be upgraded).
4. **Reverse proxy**: what is already running on ports 80/443, or whether to use Cloudflare Tunnel.

If ports 8018 or 8118 are already used by something else, stop and ask: both ports are fixed in `deploy.sh` and `deploy/configure-env.py`.

## Step 2a — Install with systemd (no Docker)

Prerequisites: Node.js **24 or newer** (`node:sqlite`), npm, Python 3, systemd user services, curl, git. If Node.js is older, ask the human before installing a newer one (distribution packages, NodeSource or nvm for this user).

```bash
git clone https://github.com/zandaulion/casierul-clasei.git ~/projects/casierul-clasei   # any user-writable path works
cd ~/projects/casierul-clasei
npm ci                                   # deploy.sh runs the tests, which need node_modules
./deploy.sh https://casierul.example.com # the exact public origin
```

What `deploy.sh` does, in order: checks the required commands, runs `npm test`, writes `~/.config/casierul-clasei/app.env` (mode 600; generates `ADMIN_TOKEN` once and keeps it on later runs; `DATA_DIR=~/.local/share/casierul-clasei`), renders the systemd user units for this checkout into `~/.config/systemd/user/`, connects the optional invitation console if `/etc/caddy/Caddyfile` and `/var/www/pwa-invite-console/apps.json` both exist, restarts `casierul-clasei.service`, waits for `/api/health`, then enables the daily backup timer and runs a first backup.

- If it prints the **lingering** warning, the service will not start after a reboot until someone logs in. Ask the human to run (or allow you to run) `sudo loginctl enable-linger <user>`.
- If the health check fails, `deploy.sh` stops the app and starts `casierul-clasei-preview.service`, which serves the static design preview on port 8018 — **the public URL then shows a mock-up, not the app**. Diagnose with `journalctl --user -u casierul-clasei.service -n 100 --no-pager`, fix the cause, and run `./deploy.sh` again promptly.
- `deploy.sh` must be run from the checkout that should be served; the units point at that directory.

Continue with Step 3.

## Step 2b — Install with Docker

```bash
git clone https://github.com/zandaulion/casierul-clasei.git && cd casierul-clasei
umask 077
printf 'PUBLIC_BASE_URL=https://casierul.example.com\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d --build
docker compose ps        # wait until the app is "healthy"
```

- The container publishes only `127.0.0.1:8018`; data lives in the named volume `data` (`/data` in the container). The admin API stays inside the container: run admin commands with `docker compose exec app node scripts/admin.mjs …`.
- `.env` is git-ignored; keep it that way.
- Backups are **not** scheduled automatically in Docker. Set up the host job described in "Backups" and tell the human.
- Known limitation: through Docker's port publishing the app sees the Docker bridge address, not loopback, so it ignores forwarded client addresses and all clients share one activation rate-limit bucket (10 failed codes per 10 minutes). Mention this to the human; it only matters if someone floods wrong codes.

For a **local trial without HTTPS** only: `PUBLIC_BASE_URL=http://127.0.0.1:8018` and `COOKIE_SECURE=false` in `.env`, and open exactly `http://127.0.0.1:8018` (not `localhost`, which is a different origin). Never use these settings on a public server.

Continue with Step 3.

## Step 3 — Reverse proxy and HTTPS

The proxy must send the public origin to `http://127.0.0.1:8018`, and nothing else from this app. Do not route `/api/admin` or port 8118 anywhere. Show the human the exact change before applying it; validate the configuration before reloading.

For an upgrade whose public origin and proxy are unchanged, verify the existing route and leave the proxy, firewall and lingering settings alone.

The app reads the client address for rate limiting from `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, and only when the connection comes from loopback. A proxy that is not Cloudflare must therefore **remove `CF-Connecting-IP`** and set `X-Forwarded-For` to the real client address only.

**Caddy** (obtains certificates automatically; DNS must point at this server and ports 80/443 must be reachable):

```caddyfile
casierul.example.com {
	reverse_proxy 127.0.0.1:8018 {
		header_up -CF-Connecting-IP
	}
}
```

`caddy validate --config /etc/caddy/Caddyfile` then `sudo systemctl reload caddy`. Caddy replaces untrusted `X-Forwarded-For` with the client address by default.

**nginx** (certificate from certbot or existing):

```nginx
server {
    listen 443 ssl;
    server_name casierul.example.com;
    # ssl_certificate / ssl_certificate_key as for the other sites on this host
    client_max_body_size 11m;   # attachments are limited to 10 MB by the app
    location / {
        proxy_pass http://127.0.0.1:8018;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

`sudo nginx -t` then `sudo systemctl reload nginx`. Also redirect port 80 to HTTPS.

**Cloudflare Tunnel** (`cloudflared` running on this same host, so it connects from loopback and sets `CF-Connecting-IP` itself): add an ingress rule before the catch-all and restart the tunnel.

```yaml
ingress:
  - hostname: casierul.example.com
    service: http://127.0.0.1:8018
  - service: http_status:404
```

**SELinux** (`getenforce` prints `Enforcing`): if the proxy logs "permission denied" connecting to 127.0.0.1:8018, ask before running `sudo setsebool -P httpd_can_network_connect 1`.

## Step 4 — Verify

All of these must hold before you report success. Replace the origin.

```bash
ORIGIN=https://casierul.example.com
curl -fsS http://127.0.0.1:8018/api/health                                   # {"ok":true}
curl -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/api/health"               # 200
curl -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/api/state"                # 401 (no session)
curl -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/api/admin/invites"        # 404 (admin never public)
curl -sSI "$ORIGIN/" | grep -i -E '^(content-security-policy|x-frame-options):' # both present
ss -ltn | grep -E ':(8018|8118)\b'      # both listening on 127.0.0.1 only (in Docker: 8018 on 127.0.0.1, 8118 absent)
```

Plus, for systemd: `systemctl --user is-active casierul-clasei.service` (active) and `systemctl --user list-timers casierul-clasei-backup.timer` (scheduled), and `ls ~/.local/share/casierul-clasei/backups/` shows a dated folder. For Docker: `docker compose ps` shows healthy.

Check that the admin API works from the server without printing the token:

```bash
node scripts/admin.mjs options                          # systemd
docker compose exec app node scripts/admin.mjs options  # Docker
```

## Step 5 — First cashier invitation (fresh install only)

```bash
node scripts/admin.mjs invite "Telefonul casierului"                          # systemd
docker compose exec app node scripts/admin.mjs invite "Telefonul casierului"  # Docker
```

It prints a code and a link valid for 7 days and two devices (e.g. phone and laptop). Give both **only** to the human who asked for the deployment, and tell them: the first cashier device to activate becomes the owner; open the link on the phone, tap «Deschide registrul clasei», then configure the class in the app. Further invitations (parents, auditors, other classrooms) are issued with `node scripts/admin.mjs options` and `invite --role … --for …`; see `node scripts/admin.mjs` without arguments.

## Upgrading an existing installation

1. Confirm with the human which branch, commit or tag to deploy, and record the current revision with `git rev-parse HEAD`. Identify whether the existing installation uses systemd or Docker; do not run the fresh-install path over it.
2. For systemd, inspect `~/.config/casierul-clasei/app.env` without displaying `ADMIN_TOKEN` or the complete file. `deploy/configure-env.py` preserves `PUBLIC_BASE_URL` and `ADMIN_TOKEN`, but currently writes these values on every run:

   ```bash
   python3 - <<'PY'
   from pathlib import Path

   path = Path.home() / ".config/casierul-clasei/app.env"
   values = dict(line.split("=", 1) for line in path.read_text().splitlines()
                 if "=" in line and not line.startswith("#"))
   for key in ("PUBLIC_BASE_URL", "HOST", "PORT", "ADMIN_PORT", "DATA_DIR",
               "COOKIE_SECURE", "NODE_ENV"):
       print(f"{key}={values.get(key, '[missing]')}")
   PY
   ```

   ```text
   HOST=127.0.0.1
   PORT=8018
   ADMIN_PORT=8118
   DATA_DIR=$HOME/.local/share/casierul-clasei
   COOKIE_SECURE=true
   NODE_ENV=production
   ```

   If the installed value for any of these settings differs, stop and explain that `deploy.sh` would replace it. Do not deploy until the human chooses whether to adopt the repository defaults or the configuration script is updated deliberately. Record only the non-secret settings needed for this comparison.
3. Back up (see "Backups") and confirm that the command succeeded and a new dated backup folder exists before changing the checkout.
4. Fetch without changing the working tree: `git fetch --prune origin`. Inspect `git status --short`, the incoming commit list and the paths changed between the current and target revisions.
   - Never reset, clean, stash, discard or overwrite local work as part of an upgrade.
   - Stop and ask if a local change overlaps an incoming path or affects runtime code, deployment files, dependencies or configuration.
   - A local customization the human has already asked to preserve may remain only when the incoming revision does not touch that path. Record its diff or hash before updating and verify it afterwards.
   - An untracked file at a path the target revision will create is a collision; stop before updating.
5. Update and redeploy. Use a fast-forward update for a normal branch deployment; check out an exact commit or tag only when the human explicitly requested that revision:

   ```bash
   git pull --ff-only
   npm ci
   ./deploy.sh            # systemd; the origin is remembered in app.env
   ```

   Docker: `docker compose up -d --build`, then wait for `healthy`.
6. Run every check in "Verify". Read the startup logs for migration errors (`journalctl --user -u casierul-clasei.service -n 50 --no-pager`, or `docker compose logs --tail 50 app`). Verify that the public origin, data location, listener ports and other recorded non-secret settings are unchanged.
7. Do not create a first invitation during an upgrade. Installed PWAs pick up the new version automatically on their next visit; nothing needs changing on the phones.

## Rolling back

Do not assume that older code can read a database that newer code has opened. Before a code rollback, inspect the changes to `server/ledger.mjs`, `server/auth.mjs`, classroom storage and migrations between the two revisions. If database behavior changed, establish compatibility with an existing test or test the old revision against a copy of the post-upgrade database; otherwise stop and explain that a safe code-only rollback has not been established. Only then check out the revision recorded before the upgrade, run `npm ci`, redeploy and verify.

Data restore is a last resort that loses everything entered since the backup. Only do it when the human explicitly asks, following "Copii de siguranță" in `docs/operations.md`: stop the app, copy the whole current data directory aside, replace `auth.sqlite` and **all** classroom databases with files from the **same** dated backup folder, remove stale `-wal`/`-shm` files next to them, keep ownership and `0600`/`0700` permissions, start the app and have the human check each classroom's balance.

## Backups

- systemd: daily via `casierul-clasei-backup.timer` into `DATA_DIR/backups/<timestamp>/`; manual run: `systemctl --user start casierul-clasei-backup.service`.
- Docker: `docker compose exec app node scripts/backup.mjs`, then copy out of the volume:

  ```bash
  mkdir -p docker-backups && chmod 700 docker-backups
  docker compose cp app:/data/backups/. ./docker-backups/
  ```

  Offer to schedule this with the host's cron or a systemd timer.
- Backups stay on the same machine and are never pruned. Tell the human they need an off-site copy and occasional cleanup; do not set up remote transfer without their decision on the destination.

## Optional: invitation console

[pwa-invite-console](https://github.com/zandaulion/pwa-invite-console) gives a graphical page for invitations and devices. It needs Caddy with a private (tailnet-only or authenticated) listener, which injects the admin token. Only set it up if the human asks; follow "Consola de invitații" in `docs/operations.md`. `deploy.sh` connects it automatically when it finds the Caddyfile and the console's `apps.json`; other layouts use `CASIERUL_CADDYFILE`, `CASIERUL_CONSOLE_APPS` and `CASIERUL_CONSOLE_ANCHOR`. Anyone who can open the console has full admin rights: never put it on a public listener.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `deploy.sh` exits with "Pass the public HTTPS origin" | First run without the URL argument, or the URL is not `https://host` without path. |
| `npm test` fails inside `deploy.sh` with `ERR_MODULE_NOT_FOUND` | `npm ci` was not run. |
| Activation shows "Originea cererii nu este permisă" / HTTP 403 | `PUBLIC_BASE_URL` differs from the address in the browser (scheme, host, `www.`, port). Fix it in `app.env` (or `.env`) and restart. |
| Activation seems to succeed but the app asks for the code again | Cookie not stored: site served over plain HTTP with `COOKIE_SECURE=true`, or the proxy strips `Set-Cookie`. |
| HTTP 429 "Prea multe încercări" | Activation rate limit; it clears after 10 minutes. Behind a non-loopback proxy all clients share one bucket. |
| Public URL shows a static mock-up | `deploy.sh` fell back to the preview after a failed health check; see the journal and redeploy. |
| Service not running after reboot | Lingering not enabled for the service user. |
| `node:sqlite` errors or `ExperimentalWarning` only | Node.js older than 24. |
| PWA keeps showing an old version on one phone | Open `ORIGIN/bust` on that device; it clears only that browser's cache. |

## Report back to the human

When done, tell them, without secrets in shared channels:

- the public URL, the method (systemd or Docker) and the commit deployed;
- where data lives, where the configuration file is (not its contents), and the backup schedule;
- the verification results;
- the first invitation code and link (fresh install), and that the first cashier device becomes the owner;
- what is still theirs to do: lingering if not enabled, off-site backups, private vulnerability reporting on GitHub if this is their fork, and anything you were not allowed to change.
