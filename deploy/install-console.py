#!/usr/bin/env python3
"""Add only this app's private route and console entry, preserving all others."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

# Where the console (https://github.com/zandaulion/pwa-invite-console) and the private
# Caddy listener live; override for a different layout. The route is inserted before
# CASIERUL_CONSOLE_ANCHOR, a line that exists exactly once inside the private site block.
CADDY = Path(os.environ.get('CASIERUL_CADDYFILE', '/etc/caddy/Caddyfile'))
APPS = Path(os.environ.get('CASIERUL_CONSOLE_APPS', '/var/www/pwa-invite-console/apps.json'))
START = '\t# BEGIN Casierul clasei private console route'
END = '\t# END Casierul clasei private console route'
ANCHOR = os.environ.get('CASIERUL_CONSOLE_ANCHOR', '\t# The train API, tailnet-only.')

def replace_file(path, content):
    stat = path.stat()
    temporary = path.with_name(path.name + '.casierul-new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.chmod(temporary, stat.st_mode)
    temporary.replace(path)

def run():
    if os.geteuid() != 0:
        raise RuntimeError('Run through deploy.sh with sudo privileges.')
    config = Path(sys.argv[1])
    entry_file = Path(__file__).with_name('console-entry.json')
    match = re.search(r'^ADMIN_TOKEN=([a-f0-9]{64})$', config.read_text(), re.MULTILINE)
    if not match:
        raise RuntimeError('Missing or malformed local admin credential.')
    token = match.group(1)
    current = CADDY.read_text()
    route = '\n'.join([
        START, '\thandle /casierul-clasei/api/* {', '\t\turi strip_prefix /casierul-clasei',
        '\t\treverse_proxy 127.0.0.1:8118 {', '\t\t\theader_up -X-Admin',
        '\t\t\theader_up X-Admin-Token ' + token, '\t\t}', '\t}', END,
    ])
    if START in current:
        if current.count(START) != 1 or current.count(END) != 1:
            raise RuntimeError('Ambiguous existing private route markers.')
        updated = re.sub(re.escape(START) + r'.*?' + re.escape(END), lambda _: route, current, count=1, flags=re.S)
    else:
        if current.count(ANCHOR) != 1:
            raise RuntimeError('Cannot identify the private listener insertion point: set CASIERUL_CONSOLE_ANCHOR to a line '
                               'that appears exactly once inside the private site block of ' + str(CADDY) + '.')
        updated = current.replace(ANCHOR, route + '\n\n' + ANCHOR, 1)
    apps = json.loads(APPS.read_text())
    entry = json.loads(entry_file.read_text())
    index = next((i for i, app in enumerate(apps) if app.get('id') == entry['id']), None)
    if index is None:
        apps.append(entry)
    else:
        apps[index] = {**apps[index], **entry}
    next_apps = json.dumps(apps, ensure_ascii=False, indent=2) + '\n'
    if updated == current and next_apps == APPS.read_text():
        print('Private console route and entry are already current.')
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backups = []
    for path in (CADDY, APPS):
        backup = path.with_name(path.name + '.casierul-backup-' + stamp)
        shutil.copy2(path, backup)
        backups.append((path, backup))
    try:
        replace_file(CADDY, updated)
        validation = subprocess.run(['/usr/bin/caddy', 'validate', '--config', str(CADDY)], capture_output=True, text=True)
        if validation.returncode:
            raise RuntimeError('Caddy validation failed; prior configuration restored. ' + validation.stderr.replace(token, '[redacted]')[-2000:])
        replace_file(APPS, next_apps)
        subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=True, capture_output=True)
        subprocess.run(['/usr/sbin/restorecon', str(CADDY), str(APPS)], check=False, capture_output=True)
    except Exception:
        for path, backup in backups:
            shutil.copy2(backup, path)
        subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=False, capture_output=True)
        raise
    print('Casierul clasei is connected to the private invitation console.')

if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
