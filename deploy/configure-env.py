#!/usr/bin/env python3
"""Create the local runtime configuration without printing credentials."""
import os
from pathlib import Path
import secrets
import sys
from urllib.parse import urlsplit

config_dir = Path.home() / '.config/casierul-clasei'
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
config_dir.chmod(0o700)
env_file = config_dir / 'app.env'
values = {}
if env_file.exists():
    values = dict(line.split('=', 1) for line in env_file.read_text().splitlines() if '=' in line and not line.startswith('#'))
public_url = (sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else values.get('PUBLIC_BASE_URL', '')).rstrip('/')
url = urlsplit(public_url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
    raise SystemExit('Pass the public HTTPS origin to deploy.sh, e.g. ./deploy.sh https://casierul-clasei.example.com')
data_dir = Path.home() / '.local/share/casierul-clasei'
data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
data_dir.chmod(0o700)
values.update({
    'HOST': '127.0.0.1', 'PORT': '8018', 'ADMIN_PORT': '8118',
    'DATA_DIR': str(data_dir), 'PUBLIC_BASE_URL': public_url,
    'ADMIN_TOKEN': values.get('ADMIN_TOKEN') or secrets.token_hex(32),
    'COOKIE_SECURE': 'true', 'NODE_ENV': 'production',
})
temporary = env_file.with_suffix('.new')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
temporary.chmod(0o600)
temporary.replace(env_file)
print(f'Runtime configuration ready for {public_url}; data stays in {data_dir}.')
