import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AuthStore, COOKIE_NAME, adminTokenMatches, readSessionCookie } from '../server/auth.mjs';
import { projectState } from '../server/index.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casierul-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function authStore(t, options = {}) {
  const file = path.join(temporary(t), 'auth.sqlite');
  const auth = new AuthStore(file, { publicBaseUrl: 'https://clasa.example', ...options });
  t.after(() => auth.close());
  return { auth, file };
}

test('invites activate two independent devices and erase plaintext only when exhausted or revoked', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth, file } = authStore(t, { now: () => time });
  const invite = auth.createInvite('Telefon casier');
  assert.match(invite.url, /^https:\/\/clasa.example\/\?invite=/u);
  assert.equal(invite.max_uses, 2);
  assert.equal(invite.use_count, 0);
  const result = auth.redeemInvite(invite.code.toLowerCase());
  assert.equal(result.device.label, 'Telefon casier');
  assert.equal(result.device.is_owner, true, 'first treasurer can create the initial set of classrooms');
  assert.equal(auth.getDevice(result.token).id, result.device.id);
  const partial = auth.listInvites().invites.find((item) => item.id === invite.id);
  assert.equal(partial.use_count, 1);
  assert.equal(partial.max_uses, 2);
  assert.equal(partial.code, invite.code);
  assert.equal(partial.url, invite.url);
  assert.equal(partial.used_at, null);
  assert.equal(partial.device_id, result.device.id);
  const second = auth.redeemInvite(invite.code, 'Laptop casier');
  assert.equal(second.device.label, 'Laptop casier');
  assert.equal(second.device.is_owner, false, 'a second activation keeps the existing first-owner policy');
  assert.notEqual(second.device.id, result.device.id);
  assert.notEqual(second.token, result.token);
  assert.equal(auth.getDevice(second.token).id, second.device.id);
  assert.throws(() => auth.redeemInvite(invite.code), { status: 404 });
  assert.equal(auth.listDevices().devices.length, 2);
  const used = auth.listInvites().invites.find((item) => item.id === invite.id);
  assert.equal(used.use_count, 2);
  assert.equal(used.used_at, new Date(time).toISOString());
  assert.equal(used.device_id, second.device.id);
  assert.equal(used.code, null);
  assert.equal(used.url, null);
  const db = new DatabaseSync(file);
  const stored = db.prepare('SELECT token_hash FROM devices WHERE id = ?').get(result.device.id);
  assert.equal(stored.token_hash.length, 64);
  assert.notEqual(stored.token_hash, result.token);
  db.close();
  auth.setDeviceRevoked(result.device.id, true);
  assert.equal(auth.getDevice(result.token), null);
  assert.ok(auth.getDevice(second.token), 'revoking one device leaves the other session active');
  assert.throws(() => auth.redeemInvite(invite.code), { status: 404 }, 'revocation does not return an activation');
  auth.deleteDevice(second.device.id);
  assert.equal(auth.getDevice(second.token), null);
  assert.equal(auth.listInvites().invites.find((item) => item.id === invite.id).use_count, 2);
  assert.throws(() => auth.redeemInvite(invite.code), { status: 404 }, 'deletion does not return an activation');
  const revoked = auth.createInvite('Alt telefon');
  const active = auth.redeemInvite(revoked.code);
  auth.revokeInvite(revoked.id);
  assert.equal(auth.listInvites().invites[0].code, null);
  assert.throws(() => auth.redeemInvite(revoked.code), { status: 404 });
  assert.ok(auth.getDevice(active.token), 'revoking an invitation does not revoke an activated device');
  const expired = auth.createInvite();
  auth.redeemInvite(expired.code);
  time += 8 * 86400000;
  assert.throws(() => auth.redeemInvite(expired.code), { status: 410 });
  assert.equal(auth.listInvites().invites[0].use_count, 1);
});

test('failed redemption rolls back devices and permissions at either activation', (t) => {
  const { auth } = authStore(t);
  const invite = auth.createInvite('Casier');
  for (const useCount of [0, 1]) {
    const before = auth.listInvites().invites[0];
    auth.db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE OF used_at ON invites
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    assert.throws(() => auth.redeemInvite(invite.code), /simulated write failure/u);
    assert.equal(auth.listDevices().devices.length, useCount);
    assert.equal(auth.db.prepare('SELECT COUNT(*) AS count FROM device_permissions').get().count, useCount);
    assert.deepEqual(auth.listInvites().invites[0], before);
    auth.db.exec('DROP TRIGGER fail_claim');
    assert.ok(auth.redeemInvite(invite.code).device.id);
  }
});

test('revocation and logout invalidate the server session, and sessions expire', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth } = authStore(t, { now: () => time });
  const result = auth.redeemInvite(auth.createInvite().code);
  auth.setDeviceRevoked(result.device.id, true);
  assert.equal(auth.getDevice(result.token), null);
  auth.setDeviceRevoked(result.device.id, false);
  assert.ok(auth.getDevice(result.token));
  auth.logout(result.token);
  assert.equal(auth.getDevice(result.token), null);
  auth.setDeviceRevoked(result.device.id, false);
  time += 401 * 86400000;
  assert.equal(auth.getDevice(result.token), null);
});

test('role, child scope and access expiry pass from invite to the device', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth } = authStore(t, { now: () => time });
  const accessExpiresAt = '2027-06-30T23:59:59.999Z';
  const invite = auth.createInvite('Părinte Ana', { role: 'parent', childId: 'child-ana', accessExpiresAt });
  const redeemed = auth.redeemInvite(invite.code);
  const second = auth.redeemInvite(invite.code);
  for (const { device } of [redeemed, second]) {
    assert.deepEqual({ role: device.role, child: device.child_id, expiry: device.access_expires_at },
      { role: 'parent', child: 'child-ana', expiry: accessExpiresAt });
    assert.deepEqual({ ...auth.resolvePermission(device.id) }, {
      classroom_id: 'default', role: 'parent', child_id: 'child-ana', access_expires_at: accessExpiresAt,
    });
  }
  assert.equal(auth.listDevices().devices[0].role, 'parent');
  assert.equal(auth.listInvites().invites[0].child_id, 'child-ana');
  time = Date.parse('2027-07-01T00:00:00Z');
  assert.equal(auth.getDevice(redeemed.token), null);
  assert.equal(auth.getDevice(second.token), null);
});

test('legacy migration preserves closed invites and keeps partial activation counts on reopen', (t) => {
  const dir = temporary(t), file = path.join(dir, 'auth.sqlite');
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE invites (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, code TEXT, url TEXT,
    label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0,
    device_id TEXT REFERENCES devices(id) ON DELETE SET NULL);`);
  const legacy = [
    { code: 'AAAA-AAAA-AAAA-AAAA', used_at: null, revoked: 0, expires_at: '2026-10-01T12:00:00.000Z' },
    { code: 'BBBB-BBBB-BBBB-BBBB', used_at: '2026-09-27T12:00:00.000Z', revoked: 0, expires_at: '2026-10-01T12:00:00.000Z' },
    { code: 'CCCC-CCCC-CCCC-CCCC', used_at: null, revoked: 1, expires_at: '2026-10-01T12:00:00.000Z' },
    { code: 'DDDD-DDDD-DDDD-DDDD', used_at: null, revoked: 0, expires_at: '2026-09-27T12:00:00.000Z' },
  ];
  for (const [index, invite] of legacy.entries()) {
    db.prepare(`INSERT INTO invites (code_hash, code, url, label, created_at, expires_at, used_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      createHash('sha256').update(invite.code.replaceAll('-', '')).digest('hex'),
      invite.used_at || invite.revoked ? null : invite.code,
      invite.used_at || invite.revoked ? null : `https://clasa.example/?invite=${invite.code}`,
      `Legacy ${index}`, '2026-09-25T12:00:00.000Z', invite.expires_at, invite.used_at, invite.revoked);
  }
  db.close();
  let auth = new AuthStore(file, { now });
  t.after(() => auth.close());
  const byLabel = Object.fromEntries(auth.listInvites().invites.map(invite => [invite.label, invite]));
  assert.equal(byLabel['Legacy 0'].max_uses, 2);
  assert.equal(byLabel['Legacy 0'].use_count, 0);
  assert.equal(byLabel['Legacy 1'].max_uses, 1);
  assert.equal(byLabel['Legacy 1'].use_count, 1);
  assert.throws(() => auth.redeemInvite(legacy[1].code), { status: 404 }, 'previously consumed codes stay closed');
  assert.throws(() => auth.redeemInvite(legacy[2].code), { status: 404 });
  assert.throws(() => auth.redeemInvite(legacy[3].code), { status: 410 });
  const redeemed = auth.redeemInvite(legacy[0].code);
  assert.equal(redeemed.device.role, 'treasurer');
  const partial = auth.listInvites().invites.find(invite => invite.label === 'Legacy 0');
  assert.equal(partial.use_count, 1);
  assert.equal(partial.used_at, null);
  auth.close();
  auth = new AuthStore(file, { now });
  assert.deepEqual(auth.listInvites().invites.find(invite => invite.label === 'Legacy 0'), partial);
  assert.ok(auth.getDevice(redeemed.token));
  assert.ok(auth.redeemInvite(legacy[0].code).token);
  assert.throws(() => auth.redeemInvite(legacy[0].code), { status: 404 });
  assert.throws(() => auth.redeemInvite(legacy[1].code), { status: 404 });
});

test('redeem and addAccess share two activations without charging for duplicate access', (t) => {
  const { auth } = authStore(t);
  const owner = auth.redeemInvite(auth.createInvite('Owner').code);
  auth.createClassroom({ id: 'another-class', ledgerFile: 'another.sqlite', requestId: 'another-class',
    requestFingerprint: 'another-class', ownerDeviceId: owner.device.id });
  for (const firstMethod of ['redeem', 'addAccess']) {
    const existing = auth.redeemInvite(auth.createInvite(`Existing ${firstMethod}`).code);
    const invite = auth.createInvite('Părinte Ana', { classroomId: 'another-class', role: 'parent', childId: 'ana' });
    let fresh;
    if (firstMethod === 'redeem') fresh = auth.redeemInvite(invite.code);
    else auth.addAccess(invite.code, existing.device.id);
    const firstDevice = firstMethod === 'redeem' ? fresh.device : existing.device;
    assert.throws(() => auth.addAccess(invite.code, firstDevice.id), { status: 409 });
    const partial = auth.listInvites().invites.find(item => item.id === invite.id);
    assert.equal(partial.use_count, 1);
    assert.equal(partial.code, invite.code);
    if (firstMethod === 'redeem') auth.addAccess(invite.code, existing.device.id);
    else fresh = auth.redeemInvite(invite.code);
    for (const device of [existing.device, fresh.device]) {
      assert.deepEqual({ ...auth.resolvePermission(device.id, 'another-class') }, {
        classroom_id: 'another-class', role: 'parent', child_id: 'ana', access_expires_at: null,
      });
    }
    const third = auth.redeemInvite(auth.createInvite(`Third ${firstMethod}`).code);
    const deviceCount = auth.listDevices().devices.length;
    assert.throws(() => auth.redeemInvite(invite.code), { status: 404 });
    assert.throws(() => auth.addAccess(invite.code, third.device.id), { status: 404 });
    assert.equal(auth.listDevices().devices.length, deviceCount);
    assert.throws(() => auth.resolvePermission(third.device.id, 'another-class'), { status: 403 });
    const full = auth.listInvites().invites.find(item => item.id === invite.id);
    assert.equal(full.use_count, 2);
    assert.equal(full.device_id, firstMethod === 'redeem' ? existing.device.id : fresh.device.id);
    assert.ok(full.used_at);
    assert.equal(full.code, null);
    assert.equal(full.url, null);
  }
});

test('failed addAccess rolls back the permission and preserves the remaining activation', (t) => {
  const { auth } = authStore(t);
  const owner = auth.redeemInvite(auth.createInvite('Owner').code);
  auth.createClassroom({ id: 'another-class', ledgerFile: 'another.sqlite', requestId: 'another-class',
    requestFingerprint: 'another-class', ownerDeviceId: owner.device.id });
  const existing = auth.redeemInvite(auth.createInvite('Existing').code);
  const invite = auth.createInvite('Auditor', { classroomId: 'another-class', role: 'auditor' });
  auth.redeemInvite(invite.code);
  const before = auth.listInvites().invites.find(item => item.id === invite.id);
  auth.db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE OF used_at ON invites
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  assert.throws(() => auth.addAccess(invite.code, existing.device.id), /simulated write failure/u);
  assert.throws(() => auth.resolvePermission(existing.device.id, 'another-class'), { status: 403 });
  assert.deepEqual(auth.listInvites().invites.find(item => item.id === invite.id), before);
  auth.db.exec('DROP TRIGGER fail_claim');
  assert.equal(auth.addAccess(invite.code, existing.device.id).role, 'auditor');
  assert.equal(auth.listInvites().invites.find(item => item.id === invite.id).use_count, 2);
});

test('expired access blocks both activation routes without spending the remaining invitation slot', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth } = authStore(t, { now: () => time });
  const owner = auth.redeemInvite(auth.createInvite('Owner').code);
  auth.createClassroom({ id: 'another-class', ledgerFile: 'another.sqlite', requestId: 'another-class',
    requestFingerprint: 'another-class', ownerDeviceId: owner.device.id });
  const existing = auth.redeemInvite(auth.createInvite('Existing').code);
  const invite = auth.createInvite('Temporary auditor', { classroomId: 'another-class', role: 'auditor',
    accessExpiresAt: '2026-09-29T12:00:00.000Z' });
  const activated = auth.redeemInvite(invite.code);
  const before = auth.listInvites().invites.find(item => item.id === invite.id);
  const deviceCount = auth.listDevices().devices.length;
  time = Date.parse('2026-09-29T12:00:00Z');
  assert.ok(invite.expires_at > new Date(time).toISOString(), 'the invitation itself is still within its seven-day lifetime');
  assert.throws(() => auth.redeemInvite(invite.code), { status: 410 });
  assert.throws(() => auth.addAccess(invite.code, existing.device.id), { status: 410 });
  assert.deepEqual(auth.listInvites().invites.find(item => item.id === invite.id), before);
  assert.equal(auth.listDevices().devices.length, deviceCount);
  assert.ok(!auth.listPermissions(existing.device.id, { includeExpired: true })
    .some(permission => permission.classroom_id === 'another-class'));
  assert.equal(auth.getDevice(activated.token), null);
  assert.ok(auth.getDevice(existing.token));
});

test('parent state exposes class totals and only the associated child', () => {
  const child = (id, firstName) => ({ id, firstName, lastName: 'Pop', active: true, creditMinor: 0, dueMinor: 1000,
    contributions: [{ expenseId: 'expense-1', title: 'Poze', amountMinor: 1000, paidMinor: 0, remainingMinor: 1000 }] });
  const state = { revision: 2, settings: {}, summary: { totalDueMinor: 2000 }, children: [child('ana', 'Ana'), child('ion', 'Ion')],
    contacts: [{ childId: 'ana', position: 1, label: 'Mama', phone: '+40722111222' }],
    expenses: [{ id: 'expense-1', title: 'Poze', comment: 'notă internă', dueMinor: 2000,
      latestPayment: { id: 'payment', amountMinor: 2000, destination: 'Fotograf', occurredAt: '2026-09-30T10:00:00.000Z' },
      collectedAfterLatestPaymentMinor: 500, directAfterLatestPaymentMinor: 0, contributions: [
      { childId: 'ana', amountMinor: 1000 }, { childId: 'ion', amountMinor: 1000 }], totalMinor: 2000 }],
    advances: [{ id: 'advance', person: 'Casier', comment: 'notă internă' }],
    attachments: [{ id: 'internal-doc', visibility: 'internal' }, { id: 'class-doc', visibility: 'class' }], transactions: [
      { id: 'own', type: 'collection', childId: 'ana', comment: 'propriu' },
      { id: 'other', type: 'collection', childId: 'ion', comment: 'privat' },
      { id: 'payment', type: 'payment', childId: null, comment: 'intern' },
      { id: 'advance', type: 'fund_advance', childId: null, comment: 'intern' },
      { id: 'repayment', type: 'advance_repayment', childId: null, comment: 'intern' },
    ], reports: [
      { id: 'class', type: 'class', subjectId: null }, { id: 'matrix', type: 'matrix', subjectId: null },
      { id: 'own-report', type: 'child', subjectId: 'ana' }, { id: 'other-report', type: 'child', subjectId: 'ion' },
    ] };
  const view = projectState(state, { role: 'parent', child_id: 'ana' });
  assert.deepEqual(view.children.map((item) => item.id), ['ana']);
  assert.equal(view.expenses[0].participantCount, 2);
  assert.deepEqual(view.expenses[0].contributions.map((item) => item.childId), ['ana']);
  assert.equal(view.expenses[0].collectedAfterLatestPaymentMinor, 500, 'parent keeps the class aggregate calculated before child scoping');
  assert.equal(view.expenses[0].dueMinor, 2000);
  assert.deepEqual(view.transactions.map((item) => item.id), ['own', 'payment', 'advance', 'repayment']);
  assert.equal(view.transactions[1].comment, '');
  assert.equal(view.advances[0].comment, '');
  assert.deepEqual(view.attachments.map((item) => item.id), ['class-doc']);
  assert.deepEqual(view.reports.map((item) => item.id), ['class', 'own-report']);
  assert.equal(view.summary.totalDueMinor, 2000);
  assert.equal(Object.hasOwn(view, 'contacts'), false);
  assert.equal(Object.hasOwn(projectState(state, { role: 'auditor' }), 'contacts'), false);
  assert.deepEqual(projectState(state, { role: 'treasurer' }).contacts, state.contacts);
});

test('redeem attempts are rate limited and recover after the window', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth } = authStore(t, { now: () => time });
  const invite = auth.createInvite();
  for (let count = 0; count < 25; count++) assert.throws(() => auth.redeemInvite('invalid'), { status: 400 });
  assert.throws(() => auth.redeemInvite(invite.code), { status: 429 });
  time += 10 * 60000 + 1;
  assert.ok(auth.redeemInvite(invite.code).token);
});

test('token gates fail closed and duplicate session cookies are rejected', () => {
  assert.equal(adminTokenMatches('secret', ''), false);
  assert.equal(adminTokenMatches('secret', 'secret'), true);
  assert.equal(adminTokenMatches('secreu', 'secret'), false);
  assert.equal(adminTokenMatches(['secret'], 'secret'), false);
  const token = 'a'.repeat(43);
  assert.equal(readSessionCookie(`unrelated=x; ${COOKIE_NAME}=${token}`), token);
  assert.equal(readSessionCookie(`${COOKIE_NAME}=${token}; ${COOKIE_NAME}=${token}`), null);
});

function stubLedger() {
  return {
    calls: [],
    getState() { return { revision: 0, children: [], expenses: [], transactions: [] }; },
    dispatch(operation, body, actor) { this.calls.push({ operation, body, actor }); return { state: this.getState() }; },
    exportData() { return { version: 1, state: this.getState() }; },
    getBrandingImage(kind) { return kind === 'school' ? { mimeType: 'image/png', data: Buffer.from('logo'), updatedAt: '2026-09-29T10:00:00Z' } : null; },
    close() {},
  };
}

async function fixture(t, options = {}) {
  const dir = temporary(t);
  const webDir = path.join(dir, 'web');
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Casierul</title>');
  fs.writeFileSync(path.join(webDir, 'app.js'), 'export const ready = true;');
  fs.writeFileSync(path.join(webDir, 'sw.js'), 'const VERSION = "__BUILD_VERSION__";');
  fs.writeFileSync(path.join(webDir, 'bust.html'), '<title>Resetare</title>');
  fs.writeFileSync(path.join(webDir, '.env'), 'PRIVATE=yes');
  fs.writeFileSync(path.join(dir, 'secret.json'), '{"secret":true}');
  fs.symlinkSync(path.join(dir, 'secret.json'), path.join(webDir, 'escape.json'));
  const { createApp } = await import('../server/index.mjs');
  const ledger = stubLedger();
  const app = createApp({ dataDir: dir, publicBaseUrl: 'https://clasa.example', adminToken: 'test-admin-secret',
    cookieSecure: true, webDir, ledger, ...options });
  t.after(() => app.close());
  await Promise.all([app.publicServer, app.adminServer].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
  const publicUrl = `http://127.0.0.1:${app.publicServer.address().port}`;
  const adminUrl = `http://127.0.0.1:${app.adminServer.address().port}`;
  const request = (url, { method = 'GET', body, headers = {} } = {}) => fetch(url, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const publicRequest = (route, opts) => request(`${publicUrl}${route}`, opts);
  const adminRequest = (route, opts = {}) => request(`${adminUrl}${route}`, {
    ...opts, headers: { 'X-Admin-Token': 'test-admin-secret', ...opts.headers },
  });
  async function activate() {
    const invite = app.auth.createInvite('Casier');
    const response = await publicRequest('/api/auth/redeem', { method: 'POST', body: { code: invite.code } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const payload = await response.json();
    return { cookie, device: payload.device };
  }
  return { app, ledger, dir, publicUrl, publicRequest, adminRequest, request, activate };
}

test('public API never exposes admin even with a forged valid header', async (t) => {
  const { publicRequest, adminRequest, request, app } = await fixture(t);
  for (const route of ['/api/admin', '/api/admin/devices', '/api/admin/invites']) {
    const response = await publicRequest(route, { headers: { 'X-Admin-Token': 'test-admin-secret', 'X-Admin': '1' } });
    assert.equal(response.status, 404);
  }
  const adminUrl = `http://127.0.0.1:${app.adminServer.address().port}`;
  assert.equal((await request(`${adminUrl}/api/admin/devices`)).status, 404);
  assert.equal((await adminRequest('/api/admin/devices', { headers: { 'X-Admin-Token': 'bad' } })).status, 404);
  assert.equal((await adminRequest('/api/admin/devices')).status, 200);
  assert.equal((await adminRequest('/api/state')).status, 404);
});

test('public invitation redemption sets a host-only secure HttpOnly session and no token JSON', async (t) => {
  const { app, publicRequest } = await fixture(t);
  const invite = app.auth.createInvite('Telefon');
  const response = await publicRequest('/api/auth/redeem', {
    method: 'POST', body: { code: invite.code }, headers: { Origin: 'https://clasa.example', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-casierul=/u);
  for (const value of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=34560000']) assert.ok(cookie.includes(value));
  assert.ok(!cookie.includes('Domain='));
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['device']);
  assert.ok(!JSON.stringify(body).includes('token'));
  const me = await publicRequest('/api/auth/me', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await me.json()).device.id, body.device.id);
  assert.equal((await publicRequest('/api/auth/me')).status, 401);
});

test('concurrent redemption produces exactly two independent sessions', async (t) => {
  const { app, publicRequest } = await fixture(t);
  const invite = app.auth.createInvite();
  const results = await Promise.all(Array.from({ length: 4 }, () => publicRequest('/api/auth/redeem', {
    method: 'POST', body: { code: invite.code },
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 404, 404]);
  assert.equal(app.auth.listDevices().devices.length, 2);
  assert.equal(app.auth.db.prepare('SELECT COUNT(*) AS count FROM device_permissions').get().count, 2);
  const successful = results.filter(result => result.status === 200);
  const cookies = successful.map(result => result.headers.get('set-cookie').split(';')[0]);
  assert.notEqual(cookies[0], cookies[1]);
  for (const cookie of cookies) {
    assert.equal((await publicRequest('/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  }
  for (const response of results.filter(result => result.status !== 200)) {
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const exhausted = app.auth.listInvites().invites.find(item => item.id === invite.id);
  assert.equal(exhausted.use_count, 2);
  assert.equal(exhausted.code, null);
});

test('all seven console endpoints support private console Origin and no-body revoke/delete', async (t) => {
  const { adminRequest, publicRequest } = await fixture(t);
  const response = await adminRequest('/api/admin/invites', {
    method: 'POST', body: { label: 'Casier' }, headers: { Origin: 'https://private-tailnet.example' },
  });
  assert.equal(response.status, 201);
  const invite = await response.json();
  assert.equal(invite.max_uses, 2);
  assert.equal(invite.use_count, 0);
  assert.equal((await (await adminRequest('/api/admin/invites')).json()).invites[0].code, invite.code);
  const redeemed = await publicRequest('/api/auth/redeem', { method: 'POST', body: { code: invite.code } });
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const device = (await redeemed.json()).device;
  const partial = (await (await adminRequest('/api/admin/invites')).json()).invites[0];
  assert.equal(partial.use_count, 1);
  assert.equal(partial.max_uses, 2);
  assert.equal(partial.code, invite.code);
  assert.equal(partial.used_at, null);
  const devices = await (await adminRequest('/api/admin/devices')).json();
  assert.equal(devices.devices[0].id, device.id);
  assert.equal(devices.devices[0].has_push, false);
  assert.equal((await adminRequest(`/api/admin/devices/${device.id}/label`, { method: 'POST', body: { label: 'Laptop' } })).status, 200);
  assert.equal((await adminRequest(`/api/admin/devices/${device.id}/revoke`, { method: 'POST', body: { revoked: true } })).status, 200);
  assert.equal((await publicRequest('/api/state', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await adminRequest(`/api/admin/devices/${device.id}/revoke`, { method: 'POST', body: { revoked: false } })).status, 200);
  assert.equal((await publicRequest('/api/state', { headers: { Cookie: cookie } })).status, 200);
  const second = await (await adminRequest('/api/admin/invites', { method: 'POST', body: {} })).json();
  assert.equal((await adminRequest(`/api/admin/invites/${second.id}/revoke`, { method: 'POST' })).status, 200);
  assert.equal((await adminRequest(`/api/admin/devices/${device.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await publicRequest('/api/state', { headers: { Cookie: cookie } })).status, 401);
});

test('mutations reject cross-origin and same-site requests; CLI with session and JSON works', async (t) => {
  const { publicRequest, activate, ledger } = await fixture(t);
  const { cookie } = await activate();
  const body = { requestId: 'request-1', expectedRevision: 0, firstName: 'Ana', lastName: 'Pop' };
  for (const headers of [
    { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await publicRequest('/api/children', { method: 'POST', body, headers: { Cookie: cookie, ...headers } })).status, 403);
  }
  assert.equal(ledger.calls.length, 0);
  const response = await publicRequest('/api/children', { method: 'POST', body, headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(ledger.calls[0].operation, 'child.create');
  assert.equal(ledger.calls[0].actor.label, 'Casier');
});

test('read-only devices can read state but cannot mutate, export or issue reports', async (t) => {
  const { adminRequest, publicRequest, ledger } = await fixture(t);
  assert.deepEqual(await (await adminRequest('/api/admin/invite-options')).json(), {
    children: [{ id: 'classroom:default', name: 'Clasă neconfigurată — întreaga clasă' }],
  });
  const inviteResponse = await adminRequest('/api/admin/invites', { method: 'POST', body: {
    label: 'Auditor', role: 'auditor', accessExpiresAt: '2099-06-30',
  } });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  assert.equal(invite.role, 'auditor');
  const redeemed = await publicRequest('/api/auth/redeem', { method: 'POST', body: { code: invite.code } });
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie };
  assert.equal((await publicRequest('/api/state', { headers })).status, 200);
  assert.equal((await publicRequest('/api/export', { headers })).status, 403);
  assert.equal((await publicRequest('/api/children', { method: 'POST', headers, body: {
    requestId: 'read-only-write', expectedRevision: 0, firstName: 'Ana', lastName: 'Pop',
  } })).status, 403);
  assert.equal((await publicRequest('/api/reports', { method: 'POST', headers, body: {
    requestId: 'read-only-report', type: 'class',
  } })).status, 403);
  assert.equal((await publicRequest('/api/expenses/expense-1/attachments', { method: 'POST', headers: {
    ...headers, 'Content-Type': 'application/pdf', 'X-Request-Id': 'read-only-document',
    'X-Expected-Revision': '0', 'X-Filename': 'bon.pdf', 'X-Visibility': 'internal',
  }, body: '%PDF-1.4\n%%EOF' })).status, 403);
  assert.equal(ledger.calls.length, 0);
});

test('classrooms keep ledgers and permissions isolated', async (t) => {
  const { app, adminRequest, publicRequest, activate } = await fixture(t);
  const owner = await activate();
  assert.equal(owner.device.is_owner, true);
  const ownerHeaders = { Cookie: owner.cookie };
  const createdResponse = await publicRequest('/api/classrooms', { method: 'POST', headers: ownerHeaders, body: {
    requestId: 'new-classroom-1', schoolName: 'Școala B', className: 'II B', schoolYear: '2026–2027',
  } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.notEqual(created.classroom.id, 'default');
  assert.equal(created.classrooms.length, 2);
  const classroomQuery = `?classroom=${created.classroom.id}`;
  const childResponse = await publicRequest(`/api/children${classroomQuery}`, { method: 'POST', headers: ownerHeaders, body: {
    requestId: 'second-class-child', expectedRevision: 1, firstName: 'Ana', lastName: 'Banu',
  } });
  assert.equal(childResponse.status, 200, await childResponse.text());
  assert.equal((await (await publicRequest(`/api/state${classroomQuery}`, { headers: ownerHeaders })).json()).children.length, 1);
  assert.equal((await (await publicRequest('/api/state', { headers: ownerHeaders })).json()).children.length, 0);

  const inviteResponse = await adminRequest('/api/admin/invites', { method: 'POST', body: {
    label: 'Verificare II B', role: 'auditor', childId: `classroom:${created.classroom.id}`,
  } });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const redemption = await publicRequest('/api/auth/redeem', { method: 'POST', body: { code: invite.code } });
  const auditorCookie = redemption.headers.get('set-cookie').split(';')[0];
  const auditorHeaders = { Cookie: auditorCookie };
  const session = await (await publicRequest('/api/auth/me', { headers: auditorHeaders })).json();
  assert.deepEqual(session.classrooms.map(item => [item.id, item.role]), [[created.classroom.id, 'auditor']]);
  assert.equal((await publicRequest(`/api/state${classroomQuery}`, { headers: auditorHeaders })).status, 200);
  assert.equal((await publicRequest('/api/state', { headers: auditorHeaders })).status, 200,
    'an omitted classroom selects the only authorized classroom for backward compatibility');
  assert.equal((await publicRequest('/api/state?classroom=default', { headers: auditorHeaders })).status, 403);
  assert.equal((await publicRequest('/api/classrooms', { method: 'POST', headers: auditorHeaders, body: {
    requestId: 'forbidden-class', schoolName: 'Nu', className: 'Nu', schoolYear: '2026–2027',
  } })).status, 403);
  assert.equal((await publicRequest(`/api/children${classroomQuery}`, { method: 'POST', headers: auditorHeaders, body: {
    requestId: 'forbidden-child', expectedRevision: 2, firstName: 'Nu', lastName: 'Merge',
  } })).status, 403);
  const addedInvite = await (await adminRequest('/api/admin/invites', { method: 'POST', body: {
    label: 'Casier implicit', role: 'treasurer', childId: 'classroom:default',
  } })).json();
  const addAccess = await publicRequest('/api/auth/access', { method: 'POST', headers: auditorHeaders, body: { code: addedInvite.code } });
  assert.equal(addAccess.status, 200);
  const expandedSession = await addAccess.json();
  assert.deepEqual(Object.fromEntries(expandedSession.classrooms.map(item => [item.id, item.role])), {
    default: 'treasurer', [created.classroom.id]: 'auditor',
  });
  assert.equal((await publicRequest('/api/children?classroom=default', { method: 'POST', headers: auditorHeaders, body: {
    requestId: 'allowed-default-child', expectedRevision: 0, firstName: 'Da', lastName: 'Merge',
  } })).status, 200, 'the same device can have a different role in another classroom');
  assert.equal((await publicRequest(`/api/children${classroomQuery}`, { method: 'POST', headers: auditorHeaders, body: {
    requestId: 'still-forbidden-child', expectedRevision: 2, firstName: 'Tot', lastName: 'Nu',
  } })).status, 403, 'adding another class does not widen the existing classroom permission');
  assert.ok(app.auth.listDevices().devices.find(item => item.id === session.device.id).permissions
    .some(permission => permission.classroom_id === created.classroom.id && permission.role === 'auditor'));
});

test('business routes enforce body types, size, ids, and method before dispatch', async (t) => {
  const { publicRequest, activate, ledger } = await fixture(t);
  const { cookie } = await activate();
  const base = { requestId: 'request-1', expectedRevision: 0 };
  const invalid = [null, [], 'false', '{', { ...base, unknown: true }, { ...base, expectedRevision: '0' },
    { ...base, firstName: 123 }, { ...base, requestId: 'bad request' }];
  for (const body of invalid) {
    const response = await publicRequest('/api/children', { method: 'POST', body, headers: { Cookie: cookie } });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await publicRequest('/api/children', {
    method: 'POST', body: base, headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
  })).status, 415);
  assert.equal((await publicRequest('/api/children', {
    method: 'POST', body: { ...base, firstName: 'a'.repeat(1100000) }, headers: { Cookie: cookie },
  })).status, 413);
  assert.equal((await publicRequest('/api/children', { headers: { Cookie: cookie } })).status, 405);
  assert.equal((await publicRequest('/api/missing', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await publicRequest('/api/expenses', {
    method: 'POST', body: { ...base, participants: [{ childId: 'kid', quantity: '2' }] }, headers: { Cookie: cookie },
  })).status, 400);
  assert.equal((await publicRequest('/api/children/kid-123/contacts', {
    method: 'POST', body: { ...base, contacts: [{ label: 'Mama', phone: 722111222 }] }, headers: { Cookie: cookie },
  })).status, 400);
  assert.equal((await publicRequest('/api/collections', {
    method: 'POST', body: { ...base, childId: 'kid-123', receivedMinor: 1400, changeMinor: 0,
      allocations: [], settlement: { type: 'rounding', allocations: [{ expenseId: 'sport', amountMinor: '14' }] } },
    headers: { Cookie: cookie },
  })).status, 400);
  assert.equal(ledger.calls.length, 0);
  assert.equal((await publicRequest('/api/children/kid-123', {
    method: 'POST', body: { ...base, firstName: 'Ana', lastName: 'Pop' }, headers: { Cookie: cookie },
  })).status, 200);
  assert.equal(ledger.calls[0].body.childId, 'kid-123');
  assert.equal((await publicRequest('/api/children/kid-123/contacts', {
    method: 'POST', body: { ...base, contacts: [{ label: 'Mama', phone: '0722 111 222' }] }, headers: { Cookie: cookie },
  })).status, 200);
  assert.equal(ledger.calls[1].operation, 'child.contacts.update');
  assert.equal(ledger.calls[1].body.childId, 'kid-123');
  assert.equal((await publicRequest('/api/collections', {
    method: 'POST', body: { ...base, childId: 'kid-123', receivedMinor: 1400, changeMinor: 0,
      allocations: [{ expenseId: 'sport', amountMinor: 1400 }],
      settlement: { type: 'credit', allocations: [{ expenseId: 'sport', amountMinor: 14 }] } },
    headers: { Cookie: cookie },
  })).status, 200);
  assert.deepEqual(ledger.calls[2].body.settlement, { type: 'credit', allocations: [{ expenseId: 'sport', amountMinor: 14 }] });
});

test('ledger 409 errors pass through and internal exceptions do not reveal internals', async (t) => {
  const { publicRequest, activate, ledger } = await fixture(t, { onError() {} });
  const { cookie } = await activate();
  const send = () => publicRequest('/api/children', {
    method: 'POST', body: { requestId: 'id-1', expectedRevision: 0, firstName: 'Ana', lastName: 'Pop' }, headers: { Cookie: cookie },
  });
  ledger.dispatch = () => { throw Object.assign(new Error('Datele s-au schimbat.'), { status: 409 }); };
  let response = await send();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Datele s-au schimbat.');
  ledger.dispatch = () => { throw new Error('SQLITE secret/path'); };
  response = await send();
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('SQLITE'));
});

test('export requires a session and contains only business data; logout invalidates the cookie', async (t) => {
  const { publicRequest, activate } = await fixture(t);
  assert.equal((await publicRequest('/api/export')).status, 401);
  const { cookie } = await activate();
  const response = await publicRequest('/api/export', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="casierul-clasei-/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['state', 'version']);
  assert.ok(!JSON.stringify(data).includes('token'));
  const logout = await publicRequest('/api/auth/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await publicRequest('/api/state', { headers: { Cookie: cookie } })).status, 401);
});

test('configured branding images require an authenticated device', async (t) => {
  const { publicRequest, activate } = await fixture(t);
  assert.equal((await publicRequest('/api/branding/school')).status, 401);
  const { cookie } = await activate();
  const logo = await publicRequest('/api/branding/school', { headers: { Cookie: cookie } });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(await logo.text(), 'logo');
  assert.equal((await publicRequest('/api/branding/class', { headers: { Cookie: cookie } })).status, 404);
});

test('static shell has safe headers, stamped worker, correct content types, and no traversal or symlinks', async (t) => {
  const { publicRequest, publicUrl, app } = await fixture(t);
  const home = await publicRequest('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  const js = await publicRequest('/app.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const sw = await publicRequest('/sw.js');
  assert.equal(sw.headers.get('cache-control'), 'no-store');
  assert.ok((await sw.text()).includes(app.buildVersion));
  for (const file of ['/escape.json', '/.env', '/server/auth.mjs', '/missing.js']) assert.equal((await publicRequest(file)).status, 404);
  const raw = (rawPath) => new Promise((resolve, reject) => {
    const url = new URL(publicUrl);
    const req = http.get({ hostname: url.hostname, port: url.port, path: rawPath }, (res) => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
  });
  assert.equal(await raw('/%2e%2e/secret.json'), 404);
  assert.equal(await raw('/../secret.json'), 404);
  assert.equal(await raw('/%5csecret.json'), 404);
  assert.equal(await raw('/%ZZ'), 400);
  assert.equal((await publicRequest('/bust')).status, 200);
  const head = await publicRequest('/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
