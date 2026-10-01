import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, cp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backupDatabases } from '../scripts/backup.mjs';
import { Ledger } from '../server/ledger.mjs';
import { AuthStore } from '../server/auth.mjs';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('live WAL-backed STRICT databases restore as standalone private files with money, retry and access intact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'casierul-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new Ledger(path.join(directory, 'ledger.sqlite'), { reportPdfHotLimit: 1 });
  const auth = new AuthStore(path.join(directory, 'auth.sqlite'), { publicBaseUrl: 'https://example.test' });
  t.after(() => { ledger.close(); auth.close(); });
  // Require a modern SQLite reader for both files, not just the ledger schema.
  auth.db.exec('CREATE TABLE strict_backup_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL) STRICT; INSERT INTO strict_backup_probe VALUES (1, \'captured in WAL\')');
  const invite = auth.createInvite('Telefon');
  const device = auth.redeemInvite(invite.code, 'Telefon');
  const actor = { id: device.device.id, label: device.device.label };
  const secondClassId = randomUUID();
  const secondLedgerName = `classroom-${secondClassId}.sqlite`;
  const secondLedger = new Ledger(path.join(directory, secondLedgerName));
  t.after(() => secondLedger.close());
  auth.createClassroom({ id: secondClassId, ledgerFile: secondLedgerName, requestId: randomUUID(),
    requestFingerprint: 'backup-test', ownerDeviceId: device.device.id });
  secondLedger.dispatch('settings.update', { schoolName: 'Școala B', className: 'II B', schoolYear: '2026–2027',
    openingBalanceMinor: 0, requestId: randomUUID(), expectedRevision: 0 }, actor);
  const child = ledger.dispatch('child.create', { firstName: 'Ana', lastName: 'Avram', requestId: randomUUID(), expectedRevision: 0 }, actor).state.children[0];
  const request = { childId: child.id, receivedMinor: 12500, changeMinor: 500, allocations: [], requestId: randomUUID(), expectedRevision: 1 };
  const receipt = ledger.dispatch('collection.create', request, actor);
  ledger.dispatch('settings.update', { schoolLogo: tinyPng, requestId: randomUUID(), expectedRevision: 2 }, actor);
  ledger.dispatch('child.contacts.update', { childId: child.id, contacts: [{ label: 'Mama', phone: '0722 111 222' }],
    requestId: randomUUID(), expectedRevision: 3 }, actor);
  const expense = ledger.dispatch('expense.create', { title: 'Culegeri', type: 'fixed', amountMinor: 2500,
    participants: [{ childId: child.id }], requestId: randomUUID(), expectedRevision: 4 }, actor).state.expenses[0];
  const evidence = Buffer.from('%PDF-1.4\nDOVADĂ IMUABILĂ\n%%EOF');
  const attachment = ledger.createAttachment({ requestId: randomUUID(), expectedRevision: 5,
    entityType: 'expense', entityId: expense.id, filename: 'dovada.pdf', mimeType: 'application/pdf',
    visibility: 'class', data: evidence }, actor);
  await ledger.createReport({ requestId: randomUUID(), type: 'class' }, actor);
  await ledger.createReport({ requestId: randomUUID(), type: 'class' }, actor);
  const expected = ledger.getState();
  const archivedReport = expected.reports.find(report => report.archived);
  const archivedPdf = ledger.getReportPdf(archivedReport.id).pdf;
  assert.ok((await stat(path.join(directory, 'ledger.sqlite-wal'))).size > 0);
  assert.ok((await stat(path.join(directory, 'auth.sqlite-wal'))).size > 0);

  const folder = await backupDatabases(directory);
  assert.deepEqual((await readdir(folder)).sort(), ['auth.sqlite', secondLedgerName, 'ledger.sqlite', 'report-archive'].sort());
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  for (const name of ['ledger.sqlite', secondLedgerName, 'auth.sqlite']) assert.equal((await stat(path.join(folder, name))).mode & 0o777, 0o600);

  // Later live writes must not change the completed snapshot.
  ledger.dispatch('payment.create', { amountMinor: 1000, destination: 'Magazin', requestId: randomUUID(), expectedRevision: expected.revision }, actor);
  const restored = path.join(directory, 'restored');
  await mkdir(restored);
  for (const name of ['ledger.sqlite', secondLedgerName, 'auth.sqlite']) await copyFile(path.join(folder, name), path.join(restored, name));
  await cp(path.join(folder, 'report-archive'), path.join(restored, 'report-archive'), { recursive: true });
  const restoredLedger = new Ledger(path.join(restored, 'ledger.sqlite'));
  const restoredAuth = new AuthStore(path.join(restored, 'auth.sqlite'));
  try {
    assert.deepEqual(restoredLedger.getState(), expected);
    assert.equal(restoredLedger.getState().summary.balanceMinor, 12000);
    assert.equal(restoredLedger.getState().contacts[0].phone, '+40722111222');
    assert.ok(restoredLedger.getBrandingImage('school').data.length > 0);
    assert.deepEqual(restoredLedger.getAttachment(attachment.attachmentId).data, evidence, 'evidence attachments remain in the daily SQLite snapshot');
    assert.deepEqual(restoredLedger.getReportPdf(archivedReport.id).pdf, archivedPdf, 'archived generated PDFs restore with the same bytes');
    assert.equal(createHash('sha256').update(archivedPdf).digest('hex'), archivedReport.sha256);
    assert.equal(restoredLedger.dispatch('collection.create', request, actor).transactionId, receipt.transactionId);
    assert.equal(restoredLedger.getState().transactions.length, 1);
    assert.equal(restoredAuth.getDevice(device.token).id, device.device.id);
    assert.equal(restoredAuth.db.prepare('SELECT marker FROM strict_backup_probe').get().marker, 'captured in WAL');
    const restoredInvite = restoredAuth.listInvites().invites[0];
    assert.equal(restoredInvite.use_count, 1);
    assert.equal(restoredInvite.max_uses, 2);
    assert.equal(restoredInvite.used_at, null);
    assert.equal(restoredInvite.code, invite.code);
    assert.ok(restoredAuth.redeemInvite(invite.code, 'Laptop').token);
    assert.throws(() => restoredAuth.redeemInvite(invite.code), { status: 404 });
    const restoredSecondLedger = new Ledger(path.join(restored, secondLedgerName));
    try { assert.equal(restoredSecondLedger.getState().settings.className, 'II B'); }
    finally { restoredSecondLedger.close(); }
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
