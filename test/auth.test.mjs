import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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

test('invites are single use, expire, and erase plaintext when used or revoked', (t) => {
  let time = Date.parse('2026-09-28T12:00:00Z');
  const { auth, file } = authStore(t, { now: () => time });
  const invite = auth.createInvite('Telefon casier');
  assert.match(invite.url, /^https:\/\/clasa.example\/\?invite=/u);
  const result = auth.redeemInvite(invite.code.toLowerCase());
  assert.equal(result.device.label, 'Telefon casier');
  assert.equal(result.device.is_owner, true, 'first treasurer can create the initial set of classrooms');
  assert.equal(auth.getDevice(result.token).id, result.device.id);
  assert.throws(() => auth.redeemInvite(invite.code), { status: 404 });
  const used = auth.listInvites().invites.find((item) => item.id === invite.id);
  assert.equal(used.code, null);
  assert.equal(used.url, null);
  const db = new DatabaseSync(file);
  const stored = db.prepare('SELECT token_hash FROM devices WHERE id = ?').get(result.device.id);
  assert.equal(stored.token_hash.length, 64);
  assert.notEqual(stored.token_hash, result.token);
  db.close();
  const revoked = auth.createInvite('Alt telefon');
  auth.revokeInvite(revoked.id);
  assert.equal(auth.listInvites().invites[0].code, null);
  assert.throws(() => auth.redeemInvite(revoked.code), { status: 404 });
  const expired = auth.createInvite();
  time += 8 * 86400000;
  assert.throws(() => auth.redeemInvite(expired.code), { status: 410 });
});

test('failed redemption rolls back device creation and does not consume invite', (t) => {
  const { auth } = authStore(t);
  const invite = auth.createInvite('Casier');
  auth.db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE OF used_at ON invites
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  assert.throws(() => auth.redeemInvite(invite.code), /simulated write failure/u);
  assert.equal(auth.listDevices().devices.length, 0);
  assert.equal(auth.listInvites().invites[0].used_at, null);
  assert.equal(auth.listInvites().invites[0].code, invite.code);
  auth.db.exec('DROP TRIGGER fail_claim');
  assert.ok(auth.redeemInvite(invite.code).device.id);
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
  assert.deepEqual({ role: redeemed.device.role, child: redeemed.device.child_id, expiry: redeemed.device.access_expires_at },
    { role: 'parent', child: 'child-ana', expiry: accessExpiresAt });
  assert.equal(auth.listDevices().devices[0].role, 'parent');
  assert.equal(auth.listInvites().invites[0].child_id, 'child-ana');
  time = Date.parse('2027-07-01T00:00:00Z');
  assert.equal(auth.getDevice(redeemed.token), null);
});

test('existing auth databases migrate legacy devices to treasurer access', (t) => {
  const dir = temporary(t), file = path.join(dir, 'auth.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE invites (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, code TEXT, url TEXT,
    label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0,
    device_id TEXT REFERENCES devices(id) ON DELETE SET NULL);`);
  db.close();
  const auth = new AuthStore(file);
  t.after(() => auth.close());
  const redeemed = auth.redeemInvite(auth.createInvite('Legacy').code);
  assert.equal(redeemed.device.role, 'treasurer');
});

test('parent state exposes class totals and only the associated child', () => {
  const child = (id, firstName) => ({ id, firstName, lastName: 'Pop', active: true, creditMinor: 0, dueMinor: 1000,
    contributions: [{ expenseId: 'expense-1', title: 'Poze', amountMinor: 1000, paidMinor: 0, remainingMinor: 1000 }] });
  const state = { revision: 2, settings: {}, summary: { totalDueMinor: 2000 }, children: [child('ana', 'Ana'), child('ion', 'Ion')],
    expenses: [{ id: 'expense-1', title: 'Poze', comment: 'notă internă', contributions: [
      { childId: 'ana', amountMinor: 1000 }, { childId: 'ion', amountMinor: 1000 }], totalMinor: 2000 }],
    transactions: [
      { id: 'own', type: 'collection', childId: 'ana', comment: 'propriu' },
      { id: 'other', type: 'collection', childId: 'ion', comment: 'privat' },
      { id: 'payment', type: 'payment', childId: null, comment: 'intern' },
    ], reports: [
      { id: 'class', type: 'class', subjectId: null }, { id: 'matrix', type: 'matrix', subjectId: null },
      { id: 'own-report', type: 'child', subjectId: 'ana' }, { id: 'other-report', type: 'child', subjectId: 'ion' },
    ] };
  const view = projectState(state, { role: 'parent', child_id: 'ana' });
  assert.deepEqual(view.children.map((item) => item.id), ['ana']);
  assert.equal(view.expenses[0].participantCount, 2);
  assert.deepEqual(view.expenses[0].contributions.map((item) => item.childId), ['ana']);
  assert.deepEqual(view.transactions.map((item) => item.id), ['own', 'payment']);
  assert.equal(view.transactions[1].comment, '');
  assert.deepEqual(view.reports.map((item) => item.id), ['class', 'own-report']);
  assert.equal(view.summary.totalDueMinor, 2000);
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

test('concurrent redemption produces exactly one session', async (t) => {
  const { app, publicRequest } = await fixture(t);
  const invite = app.auth.createInvite();
  const results = await Promise.all(Array.from({ length: 4 }, () => publicRequest('/api/auth/redeem', {
    method: 'POST', body: { code: invite.code },
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 404, 404, 404]);
  assert.equal(app.auth.listDevices().devices.length, 1);
});

test('all seven console endpoints support private console Origin and no-body revoke/delete', async (t) => {
  const { adminRequest, publicRequest } = await fixture(t);
  const response = await adminRequest('/api/admin/invites', {
    method: 'POST', body: { label: 'Casier' }, headers: { Origin: 'https://private-tailnet.example' },
  });
  assert.equal(response.status, 201);
  const invite = await response.json();
  assert.equal((await (await adminRequest('/api/admin/invites')).json()).invites[0].code, invite.code);
  const redeemed = await publicRequest('/api/auth/redeem', { method: 'POST', body: { code: invite.code } });
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const device = (await redeemed.json()).device;
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
  assert.equal(ledger.calls.length, 0);
  assert.equal((await publicRequest('/api/children/kid-123', {
    method: 'POST', body: { ...base, firstName: 'Ana', lastName: 'Pop' }, headers: { Cookie: cookie },
  })).status, 200);
  assert.equal(ledger.calls[0].body.childId, 'kid-123');
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
