import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupDatabases } from '../scripts/backup.mjs';
import { Ledger } from '../server/ledger.mjs';
import { AuthStore } from '../server/auth.mjs';

test('live WAL-backed STRICT databases restore as standalone private files with money, retry and access intact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'casierul-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new Ledger(path.join(directory, 'ledger.sqlite'));
  const auth = new AuthStore(path.join(directory, 'auth.sqlite'), { publicBaseUrl: 'https://example.test' });
  t.after(() => { ledger.close(); auth.close(); });
  // Require a modern SQLite reader for both files, not just the ledger schema.
  auth.db.exec('CREATE TABLE strict_backup_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL) STRICT; INSERT INTO strict_backup_probe VALUES (1, \'captured in WAL\')');
  const invite = auth.createInvite('Telefon');
  const device = auth.redeemInvite(invite.code, 'Telefon');
  const actor = { id: device.device.id, label: device.device.label };
  const child = ledger.dispatch('child.create', { firstName: 'Ana', lastName: 'Avram', requestId: randomUUID(), expectedRevision: 0 }, actor).state.children[0];
  const request = { childId: child.id, receivedMinor: 12500, changeMinor: 500, allocations: [], requestId: randomUUID(), expectedRevision: 1 };
  const receipt = ledger.dispatch('collection.create', request, actor);
  const expected = ledger.getState();
  assert.ok((await stat(path.join(directory, 'ledger.sqlite-wal'))).size > 0);
  assert.ok((await stat(path.join(directory, 'auth.sqlite-wal'))).size > 0);

  const folder = await backupDatabases(directory);
  assert.deepEqual((await readdir(folder)).sort(), ['auth.sqlite', 'ledger.sqlite']);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  for (const name of ['ledger.sqlite', 'auth.sqlite']) assert.equal((await stat(path.join(folder, name))).mode & 0o777, 0o600);

  // Later live writes must not change the completed snapshot.
  ledger.dispatch('payment.create', { amountMinor: 1000, destination: 'Magazin', requestId: randomUUID(), expectedRevision: 2 }, actor);
  const restored = path.join(directory, 'restored');
  await mkdir(restored);
  for (const name of ['ledger.sqlite', 'auth.sqlite']) await copyFile(path.join(folder, name), path.join(restored, name));
  const restoredLedger = new Ledger(path.join(restored, 'ledger.sqlite'));
  const restoredAuth = new AuthStore(path.join(restored, 'auth.sqlite'));
  try {
    assert.deepEqual(restoredLedger.getState(), expected);
    assert.equal(restoredLedger.getState().summary.balanceMinor, 12000);
    assert.equal(restoredLedger.dispatch('collection.create', request, actor).transactionId, receipt.transactionId);
    assert.equal(restoredLedger.getState().transactions.length, 1);
    assert.equal(restoredAuth.getDevice(device.token).id, device.device.id);
    assert.equal(restoredAuth.db.prepare('SELECT marker FROM strict_backup_probe').get().marker, 'captured in WAL');
    assert.equal(restoredAuth.listInvites().invites[0].used_at !== null, true);
  } finally {
    restoredLedger.close(); restoredAuth.close();
  }
});

test('a failed two-database backup leaves no completed or partial snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'casierul-backup-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new Ledger(path.join(directory, 'ledger.sqlite'));
  t.after(() => ledger.close());
  await assert.rejects(backupDatabases(directory), /auth\.sqlite/u);
  assert.deepEqual(await readdir(path.join(directory, 'backups')), []);
  assert.equal(ledger.getState().revision, 0);
});
