import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../server/ledger.mjs';

const actor = { id: 'device-test', label: 'Telefonul casierului' };
function fixture(t, disk = false) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'casierul-ledger-')) : null;
  const path = directory ? join(directory, 'ledger.sqlite') : ':memory:';
  const ledger = new Ledger(path);
  t.after(() => { try { ledger.close(); } catch {} if (directory) rmSync(directory, { recursive: true, force: true }); });
  const post = (op, fields = {}, current = ledger) => current.dispatch(op, { requestId: randomUUID(), expectedRevision: current.getState().revision, ...fields }, actor);
  const child = (firstName = 'Ana', lastName = 'Popescu') => {
    const before = new Set(ledger.getState().children.map(c => c.id));
    return post('child.create', { firstName, lastName }).state.children.find(c => !before.has(c.id)).id;
  };
  const expense = (children, amountMinor = 2500, type = 'fixed', extra = {}) => post('expense.create', {
    title: 'Caiete', type, amountMinor, participants: children.map(childId => ({ childId })), ...extra,
  }).state.expenses[0].id;
  return { ledger, path, post, child, expense };
}

function status(code) { return error => error.status === code; }

test('empty real state has no sample records and settings persist across reopen', t => {
  const { ledger, path, post } = fixture(t, true);
  assert.equal(ledger.getState().revision, 0);
  assert.deepEqual(ledger.getState().children, []);
  assert.deepEqual(ledger.getState().transactions, []);
  assert.equal(ledger.getState().summary.balanceMinor, 0);
  post('settings.update', { schoolName: 'Școala 1', className: 'III B', schoolYear: '2026–2027', openingBalanceMinor: 12345 });
  const state = ledger.getState();
  ledger.close();
  const reopened = new Ledger(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getState(), state);
  const exported = reopened.exportData();
  assert.equal(exported.format, 'casierul-clasei');
  assert.deepEqual(exported.state, state);
  assert.equal(JSON.stringify(exported).includes('device-test'), false);
});

test('expenses freeze exact fixed, split and quantity contributions with opt-out', t => {
  const { ledger, post, child, expense } = fixture(t);
  const a = child('Ana', 'Zamfir');
  const b = child('Bogdan', 'Avram');
  const c = child('Carmen', 'Cernat');
  const fixed = expense([a, b], 1200);
  const split = expense([c, a, b], 10000, 'split');
  const quantity = expense([], 1550, 'quantity', { participants: [{ childId: a, quantity: 2 }, { childId: c, quantity: 3 }] });
  const state = ledger.getState();
  assert.deepEqual(state.children.map(c => c.lastName), ['Avram', 'Cernat', 'Zamfir']);
  assert.equal(state.expenses.find(e => e.id === fixed).totalMinor, 2400);
  const divided = state.expenses.find(e => e.id === split);
  assert.deepEqual(divided.contributions.map(c => c.amountMinor), [3334, 3333, 3333]);
  assert.equal(divided.contributions[0].childId, [a, b, c].sort()[0]);
  assert.equal(divided.totalMinor, 10000);
  assert.equal(state.expenses.find(e => e.id === quantity).totalMinor, 7750);
  const tiny = expense([a, b, c], 1, 'split');
  assert.deepEqual(ledger.getState().expenses.find(e => e.id === tiny).contributions.map(c => c.amountMinor), [1, 0, 0]);
  post('child.update', { childId: a, lastName: 'Abc', active: false });
  assert.deepEqual(ledger.getState().expenses.find(e => e.id === split).contributions, divided.contributions);
  assert.throws(() => expense([a], 100), status(400));
});

test('expenses can be edited while active financial links protect established contributions', t => {
  const { ledger, post, child, expense } = fixture(t);
  const a = child('Ana', 'Avram');
  const b = child('Bogdan', 'Bălan');
  const id = expense([a, b], 3000);
  post('expense.update', { expenseId: id, title: 'Muzeu', type: 'quantity', amountMinor: 1250,
    participants: [{ childId: a, quantity: 2 }], dueDate: '2026-11-12',
    occurredAt: '2026-10-01T09:30:00+03:00', comment: 'Două bilete' });
  let changed = ledger.getState().expenses.find(item => item.id === id);
  assert.equal(changed.title, 'Muzeu');
  assert.equal(changed.type, 'quantity');
  assert.equal(changed.totalMinor, 2500);
  assert.deepEqual(changed.contributions, [{ childId: a, amountMinor: 2500, quantity: 2 }]);
  assert.equal(ledger.getState().children.find(item => item.id === b).dueMinor, 0);
  const collection = post('collection.create', { childId: a, receivedMinor: 2000, changeMinor: 0,
    allocations: [{ expenseId: id, amountMinor: 2000 }] }).transactionId;
  post('expense.update', { expenseId: id, title: 'Muzeu', type: 'quantity', amountMinor: 1250,
    participants: [{ childId: a, quantity: 3 }], dueDate: '2026-11-12',
    occurredAt: '2026-10-01T09:30:00+03:00', comment: 'Cantitate corectată' });
  assert.equal(ledger.getState().expenses.find(item => item.id === id).totalMinor, 3750);
  assert.throws(() => post('expense.update', { expenseId: id, title: 'Muzeu', type: 'quantity', amountMinor: 1250,
    participants: [{ childId: a, quantity: 1 }], dueDate: '2026-11-12',
    occurredAt: '2026-10-01T09:30:00+03:00', comment: 'Prea puțin' }), status(409));
  post('expense.update', { expenseId: id, title: 'Vizită la muzeu', type: 'quantity', amountMinor: 1250,
    participants: [{ childId: a, quantity: 3 }], dueDate: null,
    occurredAt: '2026-10-02T09:30:00+03:00', comment: 'Titlu corectat' });
  changed = ledger.getState().expenses.find(item => item.id === id);
  assert.equal(changed.title, 'Vizită la muzeu');
  assert.equal(changed.dueDate, null);
  assert.throws(() => post('expense.update', { expenseId: id, title: changed.title, type: 'fixed', amountMinor: 1000,
    participants: [{ childId: a }], occurredAt: changed.occurredAt, comment: changed.comment }), status(409));
  post('transaction.reverse', { transactionId: collection, comment: 'Încasare greșită' });
  post('expense.update', { expenseId: id, title: changed.title, type: 'fixed', amountMinor: 1000,
    participants: [{ childId: a }, { childId: b }], occurredAt: changed.occurredAt, comment: changed.comment });
  assert.equal(ledger.getState().expenses.find(item => item.id === id).totalMinor, 2000);
});

test('an unpaid participant can be removed after other participants paid', t => {
  const { ledger, post, child, expense } = fixture(t);
  const paid = child('Ana', 'Avram');
  const removed = child('Bogdan', 'Bălan');
  const stays = child('Carmen', 'Cernat');
  const id = expense([paid, removed, stays], 3000);
  post('collection.create', { childId: paid, receivedMinor: 3000, changeMinor: 0,
    allocations: [{ expenseId: id, amountMinor: 3000 }] });
  const current = ledger.getState().expenses.find(item => item.id === id);
  post('expense.update', { expenseId: id, title: current.title, type: current.type,
    amountMinor: current.amountMinor, participants: [{ childId: paid }, { childId: stays }],
    occurredAt: current.occurredAt, dueDate: current.dueDate, comment: current.comment });
  const changed = ledger.getState().expenses.find(item => item.id === id);
  assert.equal(changed.totalMinor, 6000);
  assert.equal(ledger.getState().children.find(item => item.id === removed).dueMinor, 0);
  assert.throws(() => post('expense.update', { expenseId: id, title: changed.title, type: changed.type,
    amountMinor: changed.amountMinor, participants: [{ childId: stays }], occurredAt: changed.occurredAt,
    dueDate: changed.dueDate, comment: changed.comment }), status(409));
});

test('PDF reports are immutable, idempotent and keep correction history', async t => {
  const { ledger, post, child, expense } = fixture(t);
  post('settings.update', { schoolName: 'Școala 1', className: 'IX A', schoolYear: '2026–2027', openingBalanceMinor: 1000 });
  const ana = child('Ana', 'Avram');
  const books = expense([ana], 3000, 'fixed', { title: 'Poze carnet' });
  post('collection.create', { childId: ana, receivedMinor: 3000, changeMinor: 0,
    allocations: [{ expenseId: books, amountMinor: 3000 }] });
  const requestId = randomUUID();
  const first = await ledger.createReport({ requestId, type: 'class' }, actor);
  assert.equal(first.report.code, 'R-0001');
  assert.equal(first.report.type, 'class');
  assert.equal(first.report.stateRevision, ledger.getState().revision);
  assert.match(first.report.sha256, /^[a-f0-9]{64}$/u);
  const pdf = ledger.getReportPdf(first.report.id);
  assert.equal(pdf.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdf.filename, first.report.filename);
  const retried = await ledger.createReport({ requestId, type: 'class' }, actor);
  assert.equal(retried.report.id, first.report.id);
  assert.equal(retried.reports.length, 1);
  post('payment.create', { amountMinor: 1000, destination: 'Fotograf', expenseId: books });
  assert.deepEqual(ledger.getReportPdf(first.report.id).pdf, pdf.pdf, 'later ledger changes cannot alter an issued PDF');
  const expenseReport = await ledger.createReport({ requestId: randomUUID(), type: 'expense', subjectId: books }, actor);
  assert.equal(expenseReport.report.subjectLabel, 'Poze carnet');
  assert.equal(ledger.getReportPdf(expenseReport.report.id).pdf.subarray(0, 5).toString(), '%PDF-');
  const childReport = await ledger.createReport({ requestId: randomUUID(), type: 'child', subjectId: ana }, actor);
  assert.equal(childReport.report.subjectLabel, 'Avram Ana');
  assert.equal(ledger.getReportPdf(childReport.report.id).pdf.subarray(0, 5).toString(), '%PDF-');
  const matrixReport = await ledger.createReport({ requestId: randomUUID(), type: 'matrix' }, actor);
  assert.equal(matrixReport.report.subjectLabel, 'IX A');
  assert.equal(ledger.getReportPdf(matrixReport.report.id).pdf.subarray(0, 5).toString(), '%PDF-');
  const correction = await ledger.createReport({ requestId: randomUUID(), type: 'class', replacesId: first.report.id }, actor);
  assert.equal(correction.report.code, 'R-0005');
  assert.equal(correction.report.replacesId, first.report.id);
  assert.equal(correction.reports.find(report => report.id === first.report.id).replacedById, correction.report.id);
  await assert.rejects(ledger.createReport({ requestId: randomUUID(), type: 'class', replacesId: first.report.id }, actor), status(409));
});

test('collection can earmark one expense and retain excess; applying credit has no cash movement', t => {
  const { ledger, post, child, expense } = fixture(t);
  const id = child();
  const books = expense([id], 2500);
  const trip = expense([id], 6000, 'fixed', { title: 'Excursie' });
  post('settings.update', { openingBalanceMinor: 1000 });
  post('collection.create', { childId: id, receivedMinor: 10000, changeMinor: 1500,
    allocations: [{ expenseId: books, amountMinor: 2500 }] });
  let state = ledger.getState();
  assert.equal(state.children[0].creditMinor, 6000);
  assert.equal(state.children[0].dueMinor, 6000);
  assert.equal(state.children[0].contributions.find(c => c.expenseId === trip).paidMinor, 0);
  assert.equal(state.summary.balanceMinor, 9500);
  assert.equal(state.summary.totalReceivedMinor, 8500);
  post('credit.apply', { childId: id, allocations: [{ expenseId: trip, amountMinor: 4000 }] });
  state = ledger.getState();
  assert.equal(state.children[0].creditMinor, 2000);
  assert.equal(state.children[0].dueMinor, 2000);
  assert.equal(state.summary.balanceMinor, 9500);
  assert.equal(state.summary.totalReceivedMinor, 8500);
  post('refund.create', { childId: id, amountMinor: 1500 });
  post('payment.create', { expenseId: books, amountMinor: 2500, destination: 'Librăria', occurredAt: '2026-09-28T10:00:00+03:00', comment: 'Bon nr. 24' });
  state = ledger.getState();
  assert.equal(state.children[0].creditMinor, 500);
  assert.equal(state.summary.balanceMinor, 5500);
  assert.equal(state.summary.totalPaidMinor, 4000);
  assert.equal(state.expenses.find(e => e.id === books).paidOutMinor, 2500);
  assert.equal(state.transactions[0].occurredAt, '2026-09-28T07:00:00.000Z');
  assert.equal(state.transactions[0].destination, 'Librăria');
  assert.equal(state.transactions[0].comment, 'Bon nr. 24');
  assert.throws(() => post('settings.update', { openingBalanceMinor: 2000 }), status(409));
});

test('installments and explicit change record exact allocations and no phantom credit', t => {
  const { ledger, post, child, expense } = fixture(t);
  const id = child();
  const book = expense([id], 2575);
  post('collection.create', { childId: id, receivedMinor: 2000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 2000 }] });
  post('collection.create', { childId: id, receivedMinor: 1000, changeMinor: 425, allocations: [{ expenseId: book, amountMinor: 575 }] });
  assert.equal(ledger.getState().summary.balanceMinor, 2575);
  assert.equal(ledger.getState().children[0].dueMinor, 0);
  assert.equal(ledger.getState().children[0].creditMinor, 0);
});

test('invalid money, allocations, dates and partial bulk import roll back atomically', t => {
  const { ledger, post, child, expense } = fixture(t);
  const id = child();
  const outsider = child('Ion', 'Georgescu');
  const book = expense([id], 2500);
  const before = ledger.getState();
  const invalid = [
    { receivedMinor: 1.5, changeMinor: 0, allocations: [] },
    { receivedMinor: -1, changeMinor: 0, allocations: [] },
    { receivedMinor: 100, changeMinor: 101, allocations: [] },
    { receivedMinor: 100, changeMinor: 100, allocations: [] },
    { receivedMinor: 100, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 101 }] },
    { receivedMinor: 3000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 2501 }] },
    { receivedMinor: 1000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 100 }, { expenseId: book, amountMinor: 100 }] },
    { receivedMinor: 1000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 0 }] },
    { receivedMinor: 1000, changeMinor: 0, allocations: [], occurredAt: '2026-02-30T10:00:00Z' },
    { childId: outsider, receivedMinor: 1000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 100 }] },
  ];
  for (const values of invalid) assert.throws(() => post('collection.create', { childId: id, ...values }), status(400));
  assert.throws(() => post('children.create', { children: [{ firstName: 'Valid', lastName: 'First' }, { firstName: '', lastName: 'Invalid' }] }), status(400));
  assert.throws(() => expense([id], 1000, 'fixed', { dueDate: '2026-02-30' }), status(400));
  assert.throws(() => expense([id, id], 1000), status(400));
  assert.throws(() => post('credit.apply', { childId: id, allocations: [{ expenseId: book, amountMinor: 100 }] }), status(400));
  assert.throws(() => post('refund.create', { childId: id, amountMinor: 100 }), status(400));
  assert.deepEqual(ledger.getState(), before);
});

test('same request returns original identity with current state across revisions and reopen', t => {
  const { ledger, path, post, child } = fixture(t, true);
  const id = child();
  const body = { requestId: randomUUID(), expectedRevision: ledger.getState().revision, childId: id, receivedMinor: 3000, changeMinor: 0, allocations: [] };
  const first = ledger.dispatch('collection.create', body, actor);
  post('payment.create', { amountMinor: 1000, destination: 'Magazin' });
  const replay = ledger.dispatch('collection.create', { ...body }, actor);
  assert.equal(replay.transactionId, first.transactionId);
  assert.deepEqual(replay.state, ledger.getState());
  assert.equal(replay.state.revision, first.state.revision + 1);
  assert.throws(() => ledger.dispatch('collection.create', { ...body, receivedMinor: 4000 }, actor), status(409));
  assert.throws(() => ledger.dispatch('collection.create', { ...body, requestId: randomUUID() }, actor), status(409));
  ledger.close();
  const reopened = new Ledger(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.dispatch('collection.create', body, actor), replay);
  assert.equal(reopened.getState().transactions.length, 2);
  assert.equal(reopened.getState().summary.balanceMinor, 2000);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM requests WHERE id = ?').get(body.requestId).response), { transactionId: first.transactionId });
});

test('two database connections enforce revision conflict without duplicate financial writes', t => {
  const { ledger, path, child } = fixture(t, true);
  const id = child();
  const second = new Ledger(path);
  t.after(() => second.close());
  const fields = { expectedRevision: second.getState().revision, childId: id, receivedMinor: 1000, changeMinor: 0, allocations: [] };
  ledger.dispatch('collection.create', { ...fields, requestId: randomUUID() }, actor);
  assert.throws(() => second.dispatch('collection.create', { ...fields, requestId: randomUUID() }, actor), status(409));
  assert.equal(second.getState().transactions.length, 1);
});

test('reversals append history and block consuming already applied or refunded credit', t => {
  const { ledger, post, child, expense } = fixture(t);
  const id = child();
  const book = expense([id], 2500);
  const collection = post('collection.create', { childId: id, receivedMinor: 5000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 1000 }] }).transactionId;
  const applied = post('credit.apply', { childId: id, allocations: [{ expenseId: book, amountMinor: 1500 }] }).transactionId;
  const refund = post('refund.create', { childId: id, amountMinor: 1000 }).transactionId;
  const before = ledger.getState();
  assert.throws(() => post('transaction.reverse', { transactionId: collection, comment: 'Greșeală' }), status(409));
  assert.deepEqual(ledger.getState(), before);
  post('transaction.reverse', { transactionId: applied, comment: 'Corectare alocare' });
  assert.throws(() => post('transaction.reverse', { transactionId: collection, comment: 'Greșeală' }), status(409));
  post('transaction.reverse', { transactionId: refund, comment: 'Restituire introdusă greșit' });
  const reversed = post('transaction.reverse', { transactionId: collection, comment: 'Copil greșit' });
  const state = reversed.state;
  assert.equal(state.transactions.length, 6);
  assert.equal(state.transactions.find(tx => tx.id === collection).reversed, true);
  assert.equal(state.transactions.find(tx => tx.id === reversed.transactionId).reversesId, collection);
  assert.equal(state.summary.balanceMinor, 0);
  assert.equal(state.children[0].creditMinor, 0);
  assert.equal(state.children[0].dueMinor, 2500);
  assert.throws(() => post('transaction.reverse', { transactionId: collection, comment: 'Din nou' }), status(409));
  assert.throws(() => post('transaction.reverse', { transactionId: reversed.transactionId, comment: 'Din nou' }), status(409));
  assert.throws(() => post('settings.update', { openingBalanceMinor: 10 }), status(409));
});

test('expense cancellation requires reversing allocations and linked payouts, then leaves history', t => {
  const { ledger, post, child, expense } = fixture(t);
  const id = child();
  const book = expense([id], 2500);
  post('collection.create', { childId: id, receivedMinor: 3000, changeMinor: 0, allocations: [] });
  const applied = post('credit.apply', { childId: id, allocations: [{ expenseId: book, amountMinor: 2500 }] }).transactionId;
  const payment = post('payment.create', { amountMinor: 2500, destination: 'Librărie', expenseId: book }).transactionId;
  assert.throws(() => post('expense.cancel', { expenseId: book }), status(409));
  post('transaction.reverse', { transactionId: applied, comment: 'Anulare' });
  assert.throws(() => post('expense.cancel', { expenseId: book }), status(409));
  post('transaction.reverse', { transactionId: payment, comment: 'Anulare' });
  post('expense.cancel', { expenseId: book, comment: 'Comandă anulată' });
  assert.equal(ledger.getState().expenses[0].cancelled, true);
  assert.equal(ledger.getState().children[0].dueMinor, 0);
  assert.equal(ledger.getState().children[0].creditMinor, 3000);
  assert.equal(ledger.getState().summary.balanceMinor, 3000);
  assert.throws(() => post('payment.create', { amountMinor: 500, destination: 'Librărie', expenseId: book }), status(409));
});

test('database forbids altering or deleting confirmed financial history and enforces foreign keys', t => {
  const { path, post, child, expense } = fixture(t, true);
  const id = child();
  const book = expense([id], 1000);
  post('collection.create', { childId: id, receivedMinor: 1000, changeMinor: 0, allocations: [{ expenseId: book, amountMinor: 1000 }] });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  assert.throws(() => db.exec('UPDATE transactions SET amount = 2'), /immutable/u);
  assert.throws(() => db.exec('DELETE FROM transactions'), /immutable/u);
  assert.throws(() => db.exec('UPDATE allocations SET amount = 2'), /immutable/u);
  assert.throws(() => db.exec('DELETE FROM allocations'), /immutable/u);
  assert.throws(() => db.exec('UPDATE contributions SET amount = 2'), /immutable/u);
  assert.throws(() => db.exec('DELETE FROM children'), /FOREIGN KEY/u);
});
