import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { start } from '../server/index.mjs';

test('invited device manages a persisted class ledger without exposing admin or mixing credit with cash', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'casierul-integration-'));
  const options = { dataDir: directory, publicBaseUrl: 'https://class.example', adminToken: 'integration-admin-secret', port: 0, adminPort: 0 };
  let app = await start(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = () => `http://127.0.0.1:${app.publicServer.address().port}`;
  const admin = () => `http://127.0.0.1:${app.adminServer.address().port}`;
  async function json(url, init = {}) {
    const response = await fetch(url, init);
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  assert.equal((await json(origin() + '/api/state')).status, 401);
  assert.equal((await json(origin() + '/api/admin/invites', { headers: { 'X-Admin-Token': options.adminToken } })).status, 404);
  const invite = await json(admin() + '/api/admin/invites', { method: 'POST', headers: { 'X-Admin-Token': options.adminToken, 'Content-Type': 'application/json', Origin: 'https://private-console.example' }, body: JSON.stringify({ label: 'Casier test' }) });
  assert.equal(invite.status, 201);
  const redemption = await json(origin() + '/api/auth/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: options.publicBaseUrl }, body: JSON.stringify({ code: invite.data.code }) });
  assert.equal(redemption.status, 200);
  const cookie = redemption.headers.get('set-cookie').split(';')[0];
  assert.match(redemption.headers.get('set-cookie'), /HttpOnly/);
  assert.match(redemption.headers.get('set-cookie'), /Secure/);
  assert.equal(redemption.data.token, undefined);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: options.publicBaseUrl };
  let state = (await json(origin() + '/api/state', { headers })).data;
  async function mutate(endpoint, body) {
    const request = { requestId: randomUUID(), expectedRevision: state.revision, ...body };
    const response = await json(origin() + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    state = response.data.state;
    return { ...response.data, request };
  }
  await mutate('/api/settings', { schoolName: 'Școala de test', className: 'III A', schoolYear: '2026–2027', openingBalanceMinor: 5000 });
  await mutate('/api/children/bulk', { children: [{ lastName: 'Avram', firstName: 'Ana' }, { lastName: 'Bălan', firstName: 'David' }] });
  const anaId = state.children.find(child => child.firstName === 'Ana').id;
  const participants = state.children.map(child => ({ childId: child.id }));
  await mutate('/api/expenses', { title: 'Culegeri', type: 'fixed', amountMinor: 6000, participants });
  const booksId = state.expenses.find(expense => expense.title === 'Culegeri').id;
  await mutate(`/api/expenses/${booksId}`, { title: 'Culegeri școlare', type: 'fixed', amountMinor: 6000,
    participants, dueDate: '2026-10-15', comment: 'Titlu actualizat' });
  assert.equal(state.expenses.find(expense => expense.id === booksId).title, 'Culegeri școlare');
  await mutate('/api/expenses', { title: 'Materiale', type: 'split', amountMinor: 5001, participants });
  const split = state.expenses.find(expense => expense.title === 'Materiale');
  assert.equal(split.contributions.reduce((sum, c) => sum + c.amountMinor, 0), 5001);
  await mutate('/api/expenses', { title: 'Bilete', type: 'quantity', amountMinor: 2500, participants: participants.map(p => ({ ...p, quantity: p.childId === anaId ? 2 : 1 })) });
  assert.equal(state.expenses.find(expense => expense.title === 'Bilete').totalMinor, 7500);
  const collection = await mutate('/api/collections', { childId: anaId, receivedMinor: 10000, changeMinor: 1500, allocations: [{ expenseId: booksId, amountMinor: 6000 }], comment: 'Păstrează diferența rămasă în avans.' });
  assert.equal(state.children.find(child => child.id === anaId).creditMinor, 2500);
  assert.equal(state.summary.balanceMinor, 13500);
  const vendorPayment = await mutate('/api/payments', { amountMinor: 4000, destination: 'Librărie', expenseId: booksId, comment: 'Prima tranșă', occurredAt: '2026-09-28T10:30:00.000Z' });
  assert.equal(state.summary.balanceMinor, 9500);
  assert.equal(state.expenses.find(expense => expense.id === booksId).paidOutMinor, 4000);
  async function attach(entityType, entityId, filename, visibility) {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    const requestId = randomUUID(), revision = state.revision;
    const collection = entityType === 'expense' ? 'expenses' : 'payments';
    const endpoint = `/api/${collection}/${entityId}/attachments`;
    const response = await json(origin() + endpoint, { method: 'POST',
      headers: { Cookie: cookie, Origin: options.publicBaseUrl, 'Content-Type': 'application/pdf',
        'X-Request-Id': requestId, 'X-Expected-Revision': String(revision),
        'X-Filename': encodeURIComponent(filename), 'X-Visibility': visibility }, body: pdf });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    state = response.data.state;
    const retry = await json(origin() + endpoint, { method: 'POST',
      headers: { Cookie: cookie, Origin: options.publicBaseUrl, 'Content-Type': 'application/pdf',
        'X-Request-Id': requestId, 'X-Expected-Revision': String(revision),
        'X-Filename': encodeURIComponent(filename), 'X-Visibility': visibility }, body: pdf });
    assert.equal(retry.status, 201);
    assert.equal(retry.data.attachmentId, response.data.attachmentId);
    assert.equal(retry.data.state.revision, state.revision);
    return response.data.attachmentId;
  }
  const internalDocument = await attach('payment', vendorPayment.transactionId, 'factura-interna.pdf', 'internal');
  const classDocument = await attach('expense', booksId, 'factura-clasei.pdf', 'class');
  assert.equal(state.attachments.length, 2);
  const openedDocument = await fetch(origin() + `/api/attachments/${classDocument}`, { headers: { Cookie: cookie } });
  assert.equal(openedDocument.status, 200);
  assert.equal(openedDocument.headers.get('content-type'), 'application/pdf');
  assert.match(openedDocument.headers.get('content-disposition'), /^inline;/u);
  assert.equal(Buffer.from(await openedDocument.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const parentInvite = app.auth.createInvite('Părinte', { role: 'parent', childId: anaId, classroomId: 'default' });
  const parentRedemption = await json(origin() + '/api/auth/redeem', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: options.publicBaseUrl }, body: JSON.stringify({ code: parentInvite.code }) });
  const parentCookie = parentRedemption.headers.get('set-cookie').split(';')[0];
  const parentState = await json(origin() + '/api/state', { headers: { Cookie: parentCookie } });
  assert.deepEqual(parentState.data.attachments.map(item => item.id), [classDocument]);
  assert.equal((await fetch(origin() + `/api/attachments/${internalDocument}`, { headers: { Cookie: parentCookie } })).status, 404);
  assert.equal((await fetch(origin() + `/api/attachments/${classDocument}`, { headers: { Cookie: parentCookie } })).status, 200);
  const applied = await mutate('/api/credit/apply', { childId: anaId, allocations: [{ expenseId: split.id, amountMinor: 2000 }] });
  assert.equal(state.summary.balanceMinor, 9500, 'applying credit must not change cash');
  assert.equal(state.children.find(child => child.id === anaId).creditMinor, 500);
  const refund = await mutate('/api/refunds', { childId: anaId, amountMinor: 500, comment: 'Restituire avans' });
  assert.equal(state.summary.balanceMinor, 9000);
  assert.equal(state.children.find(child => child.id === anaId).creditMinor, 0);
  assert.equal((await json(origin() + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: options.publicBaseUrl }, body: JSON.stringify({ requestId: randomUUID(), type: 'class' }) })).status, 401);
  const reportRequest = { requestId: randomUUID(), type: 'class' };
  const reportResponse = await json(origin() + '/api/reports', { method: 'POST', headers, body: JSON.stringify(reportRequest) });
  assert.equal(reportResponse.status, 201, JSON.stringify(reportResponse.data));
  assert.equal(reportResponse.data.report.code, 'R-0001');
  state.reports = reportResponse.data.reports;
  const repeatedReport = await json(origin() + '/api/reports', { method: 'POST', headers, body: JSON.stringify(reportRequest) });
  assert.equal(repeatedReport.data.report.id, reportResponse.data.report.id);
  assert.equal(repeatedReport.data.reports.length, 1);
  const reportPdf = await fetch(origin() + `/api/reports/${reportResponse.data.report.id}/pdf`, { headers: { Cookie: cookie } });
  assert.equal(reportPdf.status, 200);
  assert.equal(reportPdf.headers.get('content-type'), 'application/pdf');
  assert.match(reportPdf.headers.get('content-disposition'), /attachment/u);
  assert.equal(Buffer.from(await reportPdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const previousRevision = state.revision;
  const retried = await json(origin() + '/api/collections', { method: 'POST', headers, body: JSON.stringify(collection.request) });
  assert.equal(retried.status, 200);
  state = (await json(origin() + '/api/state', { headers })).data;
  assert.equal(state.revision, previousRevision, 'network retry does not record money twice');
  assert.equal(state.summary.balanceMinor, 9000);
  const invalidReverse = await json(origin() + `/api/transactions/${collection.transactionId}/reverse`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), expectedRevision: state.revision, comment: 'Corecție dependentă' }) });
  assert.equal(invalidReverse.status, 409);
  await mutate(`/api/transactions/${refund.transactionId}/reverse`, { comment: 'Restituire introdusă greșit' });
  await mutate(`/api/transactions/${applied.transactionId}/reverse`, { comment: 'Repartizare introdusă greșit' });
  assert.equal(state.children.find(child => child.id === anaId).creditMinor, 2500);
  await mutate(`/api/transactions/${collection.transactionId}/reverse`, { comment: 'Încasare introdusă greșit' });
  assert.equal(state.summary.balanceMinor, 1000);
  assert.equal(state.children.find(child => child.id === anaId).creditMinor, 0);
  assert.equal(state.children.find(child => child.id === anaId).contributions.find(c => c.expenseId === booksId).remainingMinor, 6000);
  const snapshot = await json(origin() + '/api/export', { headers });
  assert.equal(snapshot.status, 200);
  assert.match(snapshot.headers.get('content-disposition'), /attachment/);
  for (const forbidden of ['token_hash', 'code_hash', options.adminToken, invite.data.code, cookie.split('=')[1]]) assert.equal(JSON.stringify(snapshot.data).includes(forbidden), false);
  const beforeRestart = structuredClone(state);
  await app.close(); app = await start(options);
  const afterRestart = await json(origin() + '/api/state', { headers });
  assert.equal(afterRestart.status, 200, 'device session persists across restart');
  assert.deepEqual(afterRestart.data, beforeRestart, 'ledger persists across restart');
});
