#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME=casierul-clasei.service
cd "$PROJECT_DIR"

for command in node npm python3 systemctl curl; do
  command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done
NODE_BIN="$(command -v node)"
PYTHON_BIN="$(command -v python3)"
npm test
python3 "$PROJECT_DIR/deploy/configure-env.py" "${1:-}"
test -s "$PROJECT_DIR/web/index.html"
test -s "$PROJECT_DIR/server/index.mjs"
SYSTEMD_DIR="$HOME/.config/systemd/user"
python3 "$PROJECT_DIR/deploy/install-systemd.py" "$PROJECT_DIR" "$SYSTEMD_DIR" "$NODE_BIN" "$PYTHON_BIN"
systemctl --user daemon-reload

if command -v loginctl >/dev/null; then
  LINGER="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)"
  if [ "$LINGER" != yes ]; then
    printf 'Warning: enable lingering to start the user service after reboot without logging in: sudo loginctl enable-linger %s\n' "$(id -un)" >&2
  fi
fi

# Optional companion: the invitation console (https://github.com/zandaulion/pwa-invite-console)
# behind a private Caddy listener. When both are present the app's route and console entry are
# installed; otherwise invitations are issued with scripts/admin.mjs. See docs/operations.md.
CASIERUL_CADDYFILE="${CASIERUL_CADDYFILE:-/etc/caddy/Caddyfile}"
CASIERUL_CONSOLE_APPS="${CASIERUL_CONSOLE_APPS:-/var/www/pwa-invite-console/apps.json}"
if [ -f "$CASIERUL_CADDYFILE" ] && [ -f "$CASIERUL_CONSOLE_APPS" ]; then
  sudo -n --preserve-env=CASIERUL_CADDYFILE,CASIERUL_CONSOLE_APPS,CASIERUL_CONSOLE_ANCHOR \
    python3 "$PROJECT_DIR/deploy/install-console.py" "$HOME/.config/casierul-clasei/app.env"
else
  printf 'Invitation console not present; use scripts/admin.mjs for invitations.\n'
fi
systemctl --user disable --now casierul-clasei-preview.service 2>/dev/null || true
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8018/api/health -o /dev/null 2>/dev/null; then
    systemctl --user enable --now casierul-clasei-backup.timer
    systemctl --user start casierul-clasei-backup.service
    printf 'Casierul clasei is running at http://127.0.0.1:8018\n'
    exit 0
  fi
  sleep 0.5
done

printf 'Application health check failed. Restoring the preview; stored data is retained.\n' >&2
systemctl --user stop "$SERVICE_NAME"
systemctl --user enable --now casierul-clasei-preview.service
systemctl --user status "$SERVICE_NAME" --no-pager || true
exit 1
