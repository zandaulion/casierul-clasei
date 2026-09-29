import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../server/ledger.mjs';

const actor = { id: 'device-test', label: 'Telefonul casierului' };
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
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

test('participants can be added and unpaid participants removed after others paid', t => {
  const { ledger, post, child, expense } = fixture(t);
  const paid = child('Ana', 'Avram');
  const removed = child('Bogdan', 'Bălan');
  const stays = child('Carmen', 'Cernat');
  const added = child('Dan', 'Dobre');
  const id = expense([paid, removed, stays], 3000);
  post('collection.create', { childId: paid, receivedMinor: 3000, changeMinor: 0,
    allocations: [{ expenseId: id, amountMinor: 3000 }] });
  const current = ledger.getState().expenses.find(item => item.id === id);
  post('expense.update', { expenseId: id, title: current.title, type: current.type,
    amountMinor: current.amountMinor, participants: [{ childId: paid }, { childId: stays }, { childId: added }],
    occurredAt: current.occurredAt, dueDate: current.dueDate, comment: current.comment });
  const changed = ledger.getState().expenses.find(item => item.id === id);
  assert.equal(changed.totalMinor, 9000);
  assert.equal(ledger.getState().children.find(item => item.id === removed).dueMinor, 0);
  assert.equal(ledger.getState().children.find(item => item.id === added).dueMinor, 3000);
  assert.throws(() => post('expense.update', { expenseId: id, title: changed.title, type: changed.type,
    amountMinor: changed.amountMinor, participants: [{ childId: stays }, { childId: added }], occurredAt: changed.occurredAt,
    dueDate: changed.dueDate, comment: changed.comment }), status(409));
});

test('PDF reports are immutable, idempotent and keep correction history', async t => {
  const { ledger, post, child, expense } = fixture(t);
  post('settings.update', { schoolName: 'Școala 1', className: 'IX A', schoolYear: '2026–2027', openingBalanceMinor: 1000,
    schoolLogo: tinyPng, classLogo: tinyPng });
  assert.equal(ledger.getState().settings.hasSchoolLogo, true);
  assert.equal(ledger.getState().settings.hasClassLogo, true);
  assert.equal(ledger.getBrandingImage('school').mimeType, 'image/png');
  assert.equal(JSON.stringify(ledger.exportData()).includes(tinyPng.slice(30)), false);
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
  assert.match(pdf.pdf.toString('latin1'), /\/Subtype \/Image/u);
  assert.equal(pdf.filename, first.report.filename);
  const retried = await ledger.createReport({ requestId, type: 'class' }, actor);
  assert.equal(retried.report.id, first.report.id);
  assert.equal(retried.reports.length, 1);
  post('payment.create', { amountMinor: 1000, destination: 'Fotograf', expenseId: books });
  post('settings.update', { classLogo: null });
  assert.equal(ledger.getState().settings.hasClassLogo, false);
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
  assert.throws(() => post('settings.update', { schoolLogo: 'data:image/png;base64,invalid' }), status(400));
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

test('temporary fund advances reconcile cash, liability, vendor payment and partial repayment', t => {
  const { ledger, post, child, expense } = fixture(t);
  const pupil = child();
  const equipment = expense([pupil], 10000, 'fixed', { title: 'Echipament sportiv' });
  const advance = post('fund_advance.create', { amountMinor: 10000, person: 'Casier', expenseId: equipment,
    occurredAt: '2026-09-27T18:00:00+03:00', comment: 'Achitat personal la Decathlon' }).transactionId;
  let state = ledger.getState();
  assert.deepEqual(state.summary, { balanceMinor: 10000, netBalanceMinor: 0, totalReceivedMinor: 0,
    totalPaidMinor: 0, totalCreditMinor: 0, totalDueMinor: 10000, totalAdvancedMinor: 10000,
    totalAdvanceRepaidMinor: 0, totalAdvanceOutstandingMinor: 10000 });
  post('payment.create', { amountMinor: 10000, destination: 'Decathlon', expenseId: equipment,
    occurredAt: '2026-09-27T18:00:00+03:00' });
  state = ledger.getState();
  assert.equal(state.summary.balanceMinor, 0);
  assert.equal(state.summary.netBalanceMinor, -10000);
  post('collection.create', { childId: pupil, receivedMinor: 10000, changeMinor: 0,
    allocations: [{ expenseId: equipment, amountMinor: 10000 }] });
  state = ledger.getState();
  assert.equal(state.summary.balanceMinor, 10000);
  assert.equal(state.summary.netBalanceMinor, 0);
  const repayment = post('fund_advance.repay', { advanceId: advance, amountMinor: 4000, comment: 'Restituire parțială' }).transactionId;
  state = ledger.getState();
  assert.equal(state.summary.balanceMinor, 6000);
  assert.equal(state.summary.totalAdvanceOutstandingMinor, 6000);
  assert.equal(state.summary.netBalanceMinor, 0);
  assert.deepEqual(state.advances.find(item => item.id === advance), {
    id: advance, person: 'Casier', expenseId: equipment, occurredAt: '2026-09-27T15:00:00.000Z',
    createdAt: state.advances.find(item => item.id === advance).createdAt, comment: 'Achitat personal la Decathlon',
    amountMinor: 10000, repaidMinor: 4000, outstandingMinor: 6000, reversed: false,
  });
  assert.throws(() => post('fund_advance.repay', { advanceId: advance, amountMinor: 6001 }), status(400));
  assert.throws(() => post('transaction.reverse', { transactionId: advance, comment: 'Greșit' }), status(409));
  post('transaction.reverse', { transactionId: repayment, comment: 'Restituire greșită' });
  assert.equal(ledger.getState().summary.totalAdvanceOutstandingMinor, 10000);
  post('transaction.reverse', { transactionId: advance, comment: 'Avans greșit' });
  state = ledger.getState();
  assert.equal(state.summary.balanceMinor, 0);
  assert.equal(state.summary.totalAdvanceOutstandingMinor, 0);
  assert.equal(state.summary.netBalanceMinor, 0);
});

test('documents attach immutably to expenses and payments with scoped metadata and idempotency', t => {
  const { ledger, path, post, child, expense } = fixture(t, true);
  const pupil = child();
  const books = expense([pupil], 2500);
  const payment = post('payment.create', { amountMinor: 2500, destination: 'Librărie', expenseId: books }).transactionId;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const requestId = randomUUID();
  const first = ledger.createAttachment({ requestId, expectedRevision: ledger.getState().revision,
    entityType: 'expense', entityId: books, filename: 'Factură cărți.pdf', mimeType: 'application/pdf',
    visibility: 'internal', data: pdf }, actor);
  assert.equal(first.state.attachments.length, 1);
  assert.deepEqual(first.state.attachments[0], {
    id: first.attachmentId, entityType: 'expense', entityId: books, filename: 'Factură cărți.pdf',
    mimeType: 'application/pdf', size: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
    visibility: 'internal', createdAt: first.state.attachments[0].createdAt, createdByLabel: actor.label,
  });
  assert.deepEqual(ledger.getAttachment(first.attachmentId).data, pdf);
  post('child.update', { childId: pupil, firstName: 'Ana' });
  const replay = ledger.createAttachment({ requestId, expectedRevision: first.state.revision,
    entityType: 'expense', entityId: books, filename: 'Factură cărți.pdf', mimeType: 'application/pdf',
    visibility: 'internal', data: pdf }, actor);
  assert.equal(replay.attachmentId, first.attachmentId);
  assert.equal(replay.state.revision, ledger.getState().revision);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const receipt = ledger.createAttachment({ requestId: randomUUID(), expectedRevision: ledger.getState().revision,
    entityType: 'payment', entityId: payment, filename: 'bon.jpg', mimeType: 'image/jpeg',
    visibility: 'class', data: jpg }, actor);
  assert.equal(receipt.state.attachments[1].entityType, 'payment');
  assert.throws(() => ledger.createAttachment({ requestId: randomUUID(), expectedRevision: ledger.getState().revision,
    entityType: 'payment', entityId: payment, filename: 'fals.pdf', mimeType: 'application/pdf',
    visibility: 'class', data: Buffer.from('not a pdf') }, actor), status(415));
  assert.throws(() => ledger.createAttachment({ requestId: randomUUID(), expectedRevision: ledger.getState().revision,
    entityType: 'expense', entityId: books, filename: '../secret.pdf', mimeType: 'application/pdf',
    visibility: 'class', data: pdf }, actor), status(400));
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.throws(() => db.exec('UPDATE attachments SET filename = \'changed.pdf\''), /immutable/u);
  assert.throws(() => db.exec('DELETE FROM attachments'), /immutable/u);
});

test('existing transaction tables migrate without changing financial history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'casierul-legacy-transactions-'));
  const path = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE children (
    id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0, 1)), created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('fixed', 'split', 'quantity')),
    amount INTEGER NOT NULL CHECK(amount > 0), total INTEGER NOT NULL CHECK(total > 0),
    occurred_at TEXT NOT NULL, due_date TEXT, comment TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1)), cancel_comment TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE contributions (
    expense_id TEXT NOT NULL REFERENCES expenses(id), child_id TEXT NOT NULL REFERENCES children(id),
    amount INTEGER NOT NULL CHECK(amount >= 0), quantity INTEGER NOT NULL CHECK(quantity > 0),
    PRIMARY KEY (expense_id, child_id)
  ) STRICT;
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('collection', 'payment', 'credit_apply', 'refund', 'reversal')),
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    child_id TEXT REFERENCES children(id), expense_id TEXT REFERENCES expenses(id),
    destination TEXT NOT NULL, comment TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0), change INTEGER NOT NULL CHECK(change >= 0 AND change <= amount),
    reverses_id TEXT UNIQUE REFERENCES transactions(id), actor_id TEXT NOT NULL, actor_label TEXT NOT NULL,
    CHECK((type = 'reversal') = (reverses_id IS NOT NULL))
  ) STRICT;
  CREATE TABLE allocations (
    transaction_id TEXT NOT NULL REFERENCES transactions(id), expense_id TEXT NOT NULL REFERENCES expenses(id),
    amount INTEGER NOT NULL CHECK(amount > 0), PRIMARY KEY(transaction_id, expense_id)
  ) STRICT;
  INSERT INTO children VALUES ('legacy-child', 'Ana', 'Pop', 1, '2026-09-01T17:00:00.000Z');
  INSERT INTO expenses VALUES ('legacy-expense', 'Caiete', 'fixed', 1000, 1000,
    '2026-09-01T17:00:00.000Z', NULL, '', 0, '');
  INSERT INTO contributions VALUES ('legacy-expense', 'legacy-child', 1000, 1);
  INSERT INTO transactions VALUES ('legacy-payment', 'payment', '2026-09-01T17:00:00.000Z',
    '2026-09-01T17:00:00.000Z', NULL, NULL, 'Profesor', '', 1200, 0, NULL, 'old-device', 'Telefon vechi');
  INSERT INTO transactions VALUES ('legacy-collection', 'collection', '2026-09-01T18:00:00.000Z',
    '2026-09-01T18:00:00.000Z', 'legacy-child', NULL, '', '', 1000, 0, NULL, 'old-device', 'Telefon vechi');
  INSERT INTO allocations VALUES ('legacy-collection', 'legacy-expense', 1000);`);
  legacy.close();
  const ledger = new Ledger(path);
  t.after(() => ledger.close());
  assert.equal(ledger.getState().transactions.find(item => item.id === 'legacy-payment').amountMinor, 1200);
  assert.equal(ledger.getState().children[0].dueMinor, 0);
  assert.equal(ledger.getState().expenses[0].collectedMinor, 1000);
  assert.equal(ledger.getState().summary.balanceMinor, -200);
  const result = ledger.dispatch('fund_advance.create', { requestId: randomUUID(), expectedRevision: 0,
    amountMinor: 1200, person: 'Casier' }, actor);
  assert.equal(result.state.summary.balanceMinor, 1000);
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  assert.match(check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get().sql, /advance_id/u);
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
