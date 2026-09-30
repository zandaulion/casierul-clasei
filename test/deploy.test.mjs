import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('systemd installer renders the actual checkout and executable paths', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'casierul-deploy-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'checkout with spaces');
  const destination = path.join(temporary, 'systemd units');
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(ROOT, 'deploy'), path.join(project, 'deploy'), { recursive: true });
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();

  execFileSync(python, [path.join(project, 'deploy/install-systemd.py'), project, destination, process.execPath, python]);

  const main = fs.readFileSync(path.join(destination, 'casierul-clasei.service'), 'utf8');
  const backup = fs.readFileSync(path.join(destination, 'casierul-clasei-backup.service'), 'utf8');
  const preview = fs.readFileSync(path.join(destination, 'casierul-clasei-preview.service'), 'utf8');
  assert.ok(main.includes(`WorkingDirectory=${project.replaceAll(' ', '\\x20')}`));
  assert.ok(main.includes(`ExecStart="${process.execPath}" "${project}/server/index.mjs"`));
  assert.ok(backup.includes(`ExecStart="${process.execPath}" "${project}/scripts/backup.mjs"`));
  assert.ok(preview.includes(`--directory "${project}/preview"`));
  assert.ok(fs.existsSync(path.join(destination, 'casierul-clasei-backup.timer')));
});
