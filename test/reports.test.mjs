import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Ledger } from '../server/ledger.mjs';
import { renderReportPdf } from '../server/reports.mjs';

const execute = promisify(execFile);
const previewDirectory = process.env.CASIERUL_REPORT_PREVIEW_DIR;
const actor = { id: 'report-design-test', label: 'Verificare cu date sintetice' };
const normalize = value => value.normalize('NFC').replace(/\s+/gu, ' ').replace(/-\s+(?=\p{L})/gu, '-').trim();
const money = minor => `${new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)} lei`;
const commentEnd = 'ÎNCHEIERE COMENTARIU EXCURSIE';
const paymentEnd = 'ÎNCHEIERE NOTĂ PLATĂ';
const historyEnd = 'ÎNCHEIERE ISTORIC PRIVAT';
const expenseEnd = 'FINAL TITLU EXCURSIE';

async function fixture(t, stress = false) {
  const ledger = new Ledger(':memory:');
  t.after(() => ledger.close());
  const post = (operation, fields) => ledger.dispatch(operation, {
    requestId: randomUUID(), expectedRevision: ledger.getState().revision, ...fields,
  }, actor);
  const png = await readFile(new URL('../web/icons/icon-192.png', import.meta.url));
  const logo = `data:image/png;base64,${png.toString('base64')}`;
  post('settings.update', { schoolName: 'Școala demonstrativă pentru explorare și învățare împreună',
    className: 'III A', schoolYear: '2026–2027', openingBalanceMinor: 12345, schoolLogo: logo, classLogo: logo,
    paymentRevolutUrl: 'https://revolut.me/exampleclass', paymentBeneficiary: 'Ana Popescu', paymentIban: 'RO49AAAA1B31007593840000' });
  const children = [
    { lastName: stress ? 'Constantinescu-Popescu-Ionescu-Petrescu-Șerbănescu' : 'Avram',
      firstName: stress ? 'Ana-Maria-Alexandra-Gabriela-Ștefania' : 'Ana' },
    { lastName: 'Bălan', firstName: 'David' }, { lastName: 'Șerban', firstName: 'Ioana' },
    { lastName: 'Țepeș', firstName: 'Vlad' },
  ];
  if (stress) for (let index = 5; index <= 36; index++) children.push({ lastName: `Familie${String(index).padStart(2, '0')}`, firstName: `Copil${index}` });
  post('children.create', { children });
  const state = ledger.getState();
  const own = state.children.find(child => child.firstName === children[0].firstName);
  const other = state.children.find(child => child.firstName === 'David');
  const participants = state.children.map(child => ({ childId: child.id }));
  const title = stress ? `Excursie educativă pentru descoperirea patrimoniului cultural și științific al comunității, cu ateliere interactive pentru toți copiii clasei — ${expenseEnd}` : 'Fotografii de clasă';
  const comment = stress ? `${'Activitățile sunt pregătite împreună, cu materiale pentru observare, desen și lucru în echipă. '.repeat(18)}${commentEnd}` : 'Activitate comună a clasei.';
  const expense = fields => {
    post('expense.create', { participants, ...fields });
    return ledger.getState().expenses.find(item => item.title === fields.title).id;
  };
  const primary = expense({ title, type: 'fixed', amountMinor: 3000, dueDate: '2026-10-10', comment });
  const museum = expense({ title: 'Vizită la muzeu', type: 'split', amountMinor: participants.length * 6000, dueDate: '2026-10-25' });
  const materials = expense({ title: 'Materiale pentru atelier', type: 'quantity', amountMinor: 3750,
    participants: participants.map(item => ({ ...item, quantity: 1 })), dueDate: '2026-11-01' });
  if (stress) for (let index = 4; index <= 10; index++) expense({
    title: `Atelier ${index}: materiale și activități de explorare pentru proiectul comun al clasei`,
    type: 'fixed', amountMinor: index * 100,
  });
  post('collection.create', { childId: other.id, receivedMinor: 15000, changeMinor: 0,
    allocations: [{ expenseId: primary, amountMinor: 3000 }, { expenseId: museum, amountMinor: 6000 }, { expenseId: materials, amountMinor: 3750 }],
    comment: 'NOTĂ PRIVATĂ DAVID' });
  post('collection.create', { childId: own.id, receivedMinor: 2500, changeMinor: 0,
    allocations: [{ expenseId: primary, amountMinor: 2500 }], comment: `Notă individuală. ${historyEnd}` });
  const payment = post('payment.create', { amountMinor: 2000, expenseId: primary, destination: 'Furnizorul activității',
    comment: stress ? `${'Plată pentru materiale pregătite și livrate, verificată împreună cu documentele justificative. '.repeat(8)}${paymentEnd}` : 'Prima tranșă' });
  const advance = post('fund_advance.create', { amountMinor: 4500, person: 'Casier demonstrativ', expenseId: primary });
  post('fund_advance.repay', { advanceId: advance.transactionId, amountMinor: 1500 });
  for (const [filename, visibility] of [['Factură-publică.pdf', 'class'], ['Notă-internă.pdf', 'internal']]) {
    ledger.createAttachment({ requestId: randomUUID(), expectedRevision: ledger.getState().revision,
      entityType: 'expense', entityId: primary, filename, mimeType: 'application/pdf', visibility,
      data: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF') }, actor);
  }
  if (stress) {
    // Many small real transactions force both individual and expense reports to
    // paginate, without relying on fabricated summary or contribution objects.
    for (let index = 1; index <= 22; index++) {
      post('collection.create', { childId: own.id, receivedMinor: 100, changeMinor: 0,
        allocations: [], comment: `Avans individual ${index}. ${'Notă pentru verificarea încasării. '.repeat(4)}${index === 22 ? historyEnd : ''}` });
      post('payment.create', { amountMinor: 100, expenseId: primary, destination: `Furnizor demonstrativ ${index}`,
        comment: `Tranșă ${index}. ${'Materialele sunt primite și verificate. '.repeat(5)}${index === 22 ? paymentEnd : ''}` });
    }
  }
  return { ledger, post, own, other, primary, title, paymentId: payment.transactionId };
}

async function inspectPdf(fixture, type, prefix, { replacesId } = {}) {
  const request = { requestId: randomUUID(), type, ...(replacesId ? { replacesId } : {}) };
  if (type === 'child') request.subjectId = fixture.own.id;
  if (type === 'expense') request.subjectId = fixture.primary;
  const { report } = await fixture.ledger.createReport(request, actor);
  const { pdf, filename } = fixture.ledger.getReportPdf(report.id);
  return inspectBytes(pdf, report, filename, type, prefix);
}

async function inspectBytes(pdf, report, filename, type, prefix) {
  const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const pages = [];
    if (previewDirectory) {
      await mkdir(previewDirectory, { recursive: true });
      const pdfPath = path.join(previewDirectory, `${prefix}-${type}.pdf`);
      await writeFile(pdfPath, pdf);
      for (const pageNumber of new Set([1, document.numPages])) {
        await execute('pdftoppm', ['-f', String(pageNumber), '-singlefile', '-r', '110', '-png', pdfPath,
          path.join(previewDirectory, `${prefix}-${type}-page-${pageNumber}`)], { timeout: 30000 });
      }
    }
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const items = content.items.filter(item => typeof item.str === 'string' && item.str.trim());
      pages.push({ number: index, width: viewport.width, height: viewport.height, items,
        text: normalize(items.map(item => item.str).join(' ')),
        imageCount: operators.fnArray.filter(operator => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].includes(operator)).length });
      page.cleanup();
    }
    return { report, filename, pages, text: normalize(pages.map(page => page.text).join(' ')) };
  } finally {
    await document.destroy();
  }
}

function assertLayout(result, type) {
  assert.ok(result.pages.length > 0);
  for (const page of result.pages) {
    assert.equal(page.width > page.height, type === 'matrix', `${type}: orientation`);
    if (type === 'matrix') assert.ok(page.text.includes('Acoperire totală'), 'matrix pages keep a table header instead of an isolated closing note');
    assert.ok(page.text.includes(`${result.report.code} · pagina ${page.number}/${result.pages.length}`), `${type}: numbered footer on page ${page.number}`);
    const offPage = page.items.filter(item => item.transform[4] < -1 || item.transform[4] + item.width > page.width + 1
      || item.transform[5] < 1 || item.transform[5] + item.height > page.height + 1);
    assert.deepEqual(offPage.map(item => item.str), [], `${type}: all text remains on page ${page.number}`);
    // Different columns can share a baseline; different rows must not paint on
    // top of each other when a title, label or comment wraps to extra lines.
    const overlapping = [];
    for (let index = 0; index < page.items.length; index++) {
      const a = page.items[index];
      for (const b of page.items.slice(index + 1)) {
        const horizontal = Math.min(a.transform[4] + a.width, b.transform[4] + b.width) - Math.max(a.transform[4], b.transform[4]);
        const vertical = Math.min(a.transform[5] + a.height, b.transform[5] + b.height) - Math.max(a.transform[5], b.transform[5]);
        if (horizontal > 2 && vertical > Math.min(a.height, b.height) * .45) overlapping.push([a.str, b.str]);
      }
    }
    assert.deepEqual(overlapping, [], `${type}: text rows do not overlap on page ${page.number}`);
  }
  assert.ok(result.pages[0].imageCount >= 2, `${type}: both configured logos appear`);
}
function assertText(result, expected, label) {
  assert.ok(result.text.includes(normalize(expected)), `${label}: missing ${JSON.stringify(expected)}`);
}
function assertMetric(result, label, value) {
  assertText(result, `${label} ${value}`, `financial metric in ${result.report.type}`);
}
function assertPrivacy(result, fixture, type) {
  assert.equal(result.text.includes('Notă-internă.pdf'), false, `${type}: internal document metadata stays private`);
  if (type === 'expense') assertText(result, 'Factură-publică.pdf', 'shared document remains listed');
  if (type === 'class' || type === 'expense') {
    for (const child of fixture.ledger.getState().children) assert.equal(result.text.includes(`${child.lastName} ${child.firstName}`), false, `${type}: child identities stay private`);
    assert.equal(result.text.includes(historyEnd), false, `${type}: private child history stays private`);
  }
  if (type === 'child') {
    assertText(result, `${fixture.own.lastName} ${fixture.own.firstName}`, 'own child full name');
    assert.equal(result.text.includes(`${fixture.other.lastName} ${fixture.other.firstName}`), false, 'individual report excludes other children');
    assert.equal(result.text.includes('NOTĂ PRIVATĂ DAVID'), false, 'individual report excludes another child’s comment');
    assertText(result, historyEnd, 'individual report includes own history');
  }
  if (type === 'matrix') {
    assertText(result, `${fixture.other.lastName} ${fixture.other.firstName}`, 'internal matrix contains child identities');
    assert.equal(result.text.includes('NOTĂ PRIVATĂ DAVID'), false, 'matrix excludes individual transaction comments');
  }
}

test('all four PDF reports preserve financial values, privacy, branding and readable page layout', async t => {
  const data = await fixture(t);
  const state = data.ledger.getState();
  assert.equal(state.summary.balanceMinor, 30845);
  assert.equal(state.summary.totalAdvanceOutstandingMinor, 3000);
  assert.equal(state.summary.netBalanceMinor, 27845);
  assert.equal(state.summary.totalDueMinor, 35750);
  for (const type of ['class', 'expense', 'child', 'matrix']) {
    const result = await inspectPdf(data, type, 'compact');
    assertLayout(result, type);
    assertPrivacy(result, data, type);
    assertText(result, 'Școala demonstrativă pentru explorare și învățare împreună', `${type}: school identity`);
    if (type === 'matrix') assert.equal(result.text.includes('RO49AAAA1B31007593840000'), false, 'internal matrix omits payment instructions');
    else {
      assertText(result, 'Cum poți plăti', `${type}: payment section`);
      assertText(result, 'https://revolut.me/exampleclass', `${type}: Revolut link`);
      assertText(result, 'Beneficiar: Ana Popescu', `${type}: bank beneficiary`);
      assertText(result, 'IBAN: RO49AAAA1B31007593840000', `${type}: bank account`);
      assertText(result, 'Detalii plată: numele elevului', `${type}: transfer reference guidance`);
    }
    if (type === 'class') {
      assertMetric(result, 'Numerar disponibil în fond', money(30845));
      assertMetric(result, 'De restituit pentru sume avansate', money(3000));
      assertMetric(result, 'Sold după restituirea sumelor avansate', money(27845));
      assertMetric(result, 'Total de încasat', money(35750));
      assertMetric(result, 'Acoperire totală', '45,8%');
      assertText(result, `Contribuție per copil ${money(3000)}`, 'class report states equal per-child contribution');
    } else if (type === 'expense') {
      assertMetric(result, 'Necesar total', money(12000));
      assertMetric(result, 'Contribuție per copil', money(3000));
      assertMetric(result, 'Încasat în fond de la părinți', money(5500));
      assertMetric(result, 'Bani dați mai departe', money(2000));
      assertMetric(result, 'De achitat', `3 copii · ${money(6500)}`);
      assertMetric(result, 'Acoperire totală', '45,8%');
    } else if (type === 'child') {
      assertMetric(result, 'Total de achitat', money(10250));
      assertMetric(result, 'Avans disponibil', money(0));
      assertText(result, `Încasat în fond ${money(2500)} · De achitat ${money(500)}`, 'partial individual contribution');
    } else {
      assertText(result, 'Total de plată', 'matrix labels the amount remaining beside each child');
      assertText(result, '102,5 lei', 'matrix shows the selected child total remaining');
      assertText(result, '0 lei', 'matrix shows a fully paid child total');
      assertText(result, '25 / 30', 'partial matrix contribution');
      assertText(result, '30 / 30', 'paid matrix contribution');
      assertText(result, '0 / 30', 'unpaid matrix contribution');
      assertText(result, '45,8%', 'expense collection percentage in matrix header');
      assert.match(result.filename, /^raport-exhaustiv-/u, 'published matrix filename convention remains unchanged');
    }
  }
});

test('reports use the common amount or the lower base amount of a one-ban split', async t => {
  const data = await fixture(t);
  const equalReport = await inspectPdf(data, 'expense', 'equal-per-child');
  assertMetric(equalReport, 'Contribuție per copil', money(3000));

  data.post('expense.create', { title: 'Împărțire cu diferență de un ban', type: 'split', amountMinor: 100,
    participants: data.ledger.getState().children.slice(0, 3).map(child => ({ childId: child.id })) });
  const roundedSplit = data.ledger.getState().expenses.find(expense => expense.title === 'Împărțire cu diferență de un ban');
  assert.deepEqual(roundedSplit.contributions.map(contribution => contribution.amountMinor).toSorted((a, b) => a - b), [33, 33, 34]);
  const roundedSplitReport = await inspectPdf({ ...data, primary: roundedSplit.id }, 'expense', 'rounded-split-per-child');
  assertMetric(roundedSplitReport, 'Contribuție per copil', money(33));

  data.post('expense.create', { title: 'Cantități diferite', type: 'quantity', amountMinor: 100,
    participants: data.ledger.getState().children.slice(0, 2).map((child, index) => ({ childId: child.id, quantity: index + 1 })) });
  const unequal = data.ledger.getState().expenses.find(expense => expense.title === 'Cantități diferite');
  const unequalReport = await inspectPdf({ ...data, primary: unequal.id }, 'expense', 'unequal-quantity-per-child');
  assert.equal(unequalReport.text.includes('Contribuție per copil'), false,
    'genuinely different contributions are not described as one common amount');
});

test('multipage PDFs keep long titles, comments and histories without clipping or overlap', async t => {
  const data = await fixture(t, true);
  for (const type of ['class', 'expense', 'child', 'matrix']) {
    const result = await inspectPdf(data, type, 'long');
    assert.ok(result.pages.length > 1, `${type}: fixture exercises pagination`);
    assertLayout(result, type);
    assertPrivacy(result, data, type);
    if (type !== 'matrix') assertText(result, expenseEnd, `${type}: long expense title is complete`);
    if (type === 'class' || type === 'expense') {
      assertText(result, commentEnd, `${type}: long expense comment is complete`);
      assertText(result, paymentEnd, `${type}: long payment comment is complete`);
      assertText(result, 'Furnizor demonstrativ 22', `${type}: final payment survives pagination`);
    }
    if (type === 'child') assertText(result, 'Avans individual 22.', 'final child transaction survives pagination');
    if (type === 'matrix') {
      assertText(result, 'Familie36 Copil36', 'last child appears in multipage matrix');
      assertText(result, 'Total de plată', 'total remaining column repeats on matrix pages');
      assertText(result, 'Atelier 10:', 'last expense group appears in multipage matrix');
    }
    if (type === 'class' || type === 'matrix') assert.ok((result.text.match(/(?:<)?\d+(?:,\d+)?%/gu) || []).length >= data.ledger.getState().expenses.length,
      `${type}: coverage remains present across expense rows or repeated matrix headers`);
    if (type === 'expense') assertText(result, 'Acoperire totală', 'coverage remains present with long titles and comments');
  }
});

test('a corrective PDF visibly identifies its predecessor and preserves its amounts', async t => {
  const data = await fixture(t);
  const original = await inspectPdf(data, 'class', 'original');
  const correction = await inspectPdf(data, 'class', 'correction', { replacesId: original.report.id });
  assertLayout(correction, 'class');
  assertText(correction, `Raport corectiv: înlocuiește ${original.report.code}.`, 'visible correction reference');
  assertMetric(correction, 'Numerar disponibil în fond', money(30845));
  assert.equal(correction.report.replacesId, original.report.id);
});

test('expense coverage counts allocated contributions, with honest zero, tiny, near-complete and complete percentages', async t => {
  const data = await fixture(t);
  const createExpense = (title, totalMinor) => {
    data.post('expense.create', { title, type: 'fixed', amountMinor: totalMinor,
      participants: [{ childId: data.own.id }] });
    return data.ledger.getState().expenses.find(expense => expense.title === title).id;
  };
  const uncovered = createExpense('Plătită furnizorului din finanțare temporară', 12000);
  data.post('fund_advance.create', { amountMinor: 12000, person: 'Finanțator demonstrativ', expenseId: uncovered });
  data.post('payment.create', { amountMinor: 12000, destination: 'Furnizor demonstrativ', expenseId: uncovered });
  // Cash held in advance is deliberately larger than all test expenses. It must
  // never make an unallocated expense look funded by children’s contributions.
  data.post('collection.create', { childId: data.own.id, receivedMinor: 50000, changeMinor: 0, allocations: [] });
  const cases = [{ id: uncovered, expected: '0%' }];
  for (const [title, collectedMinor, expected] of [
    ['Contribuție completă', 10000, '100%'],
    ['Un ban rămas de achitat', 9999, '99,9%'],
    ['Primul ban încasat', 1, '<0,1%'],
  ]) {
    const id = createExpense(title, 10000);
    data.post('collection.create', { childId: data.own.id, receivedMinor: collectedMinor, changeMinor: 0,
      allocations: [{ expenseId: id, amountMinor: collectedMinor }] });
    cases.push({ id, expected });
  }
  const state = data.ledger.getState();
  assert.equal(state.expenses.find(expense => expense.id === uncovered).paidOutMinor, 12000);
  assert.equal(state.expenses.find(expense => expense.id === uncovered).collectedMinor, 0);
  assert.ok(state.summary.totalCreditMinor >= 50000);
  for (const [index, { id, expected }] of cases.entries()) {
    const result = await inspectPdf({ ...data, primary: id }, 'expense', `coverage-edge-${index}`);
    assertLayout(result, 'expense');
    assertMetric(result, 'Acoperire totală', expected);
    if (expected !== '100%') assert.equal(result.text.includes('100%'), false, `${expected}: incomplete coverage never says 100%`);
  }
  for (const type of ['class', 'matrix']) {
    const result = await inspectPdf(data, type, 'coverage-edges');
    assertLayout(result, type);
    const percentages = result.text.match(/(?:<)?\d+(?:,\d+)?%/gu) || [];
    assert.deepEqual(percentages.toSorted(), ['45,8%', '25%', '25%', ...cases.map(item => item.expected)].toSorted(),
      `${type}: every expense uses its own allocated contribution total`);
    if (type === 'matrix') assert.match(result.text, /acoperire totală/iu, 'matrix legend explains what the percentages measure');
  }
});

test('reports separate rounding adjustments from cash while showing the contribution as settled', async t => {
  const data = await fixture(t);
  data.post('expense.create', { title: 'Diferență de numerar', type: 'fixed', amountMinor: 1414,
    participants: [{ childId: data.own.id }] });
  const expense = data.ledger.getState().expenses.find(item => item.title === 'Diferență de numerar');
  data.post('collection.create', { childId: data.own.id, receivedMinor: 1400, changeMinor: 0,
    allocations: [{ expenseId: expense.id, amountMinor: 1400 }],
    settlement: { type: 'rounding', allocations: [{ expenseId: expense.id, amountMinor: 14 }] } });

  const classReport = await inspectPdf(data, 'class', 'rounding-adjustment-class');
  assertMetric(classReport, 'Ajustări de rotunjire', money(14));
  assertText(classReport, `Încasat în fond ${money(1400)} · Plătit direct ${money(0)} · Acoperit din fond ${money(0)} · Ajustări ${money(14)}`, 'class expense row separates cash and adjustment');
  const expenseReport = await inspectPdf({ ...data, primary: expense.id }, 'expense', 'rounding-adjustment-expense');
  assertMetric(expenseReport, 'Încasat în fond de la părinți', money(1400));
  assertMetric(expenseReport, 'Ajustări de rotunjire', money(14));
  assertMetric(expenseReport, 'De achitat', `0 copii · ${money(0)}`);
  assertMetric(expenseReport, 'Acoperire totală', '99%');
  const childReport = await inspectPdf(data, 'child', 'rounding-adjustment-child');
  assertText(childReport, `Încasat în fond ${money(1400)} · Ajustare de rotunjire ${money(14)} · De achitat ${money(0)}`,
    'individual report explains the non-cash settlement');
  const matrixReport = await inspectPdf(data, 'matrix', 'rounding-adjustment-matrix');
  assertText(matrixReport, '14,14 / 14,14', 'matrix treats the adjusted contribution as settled');
  assert.match(matrixReport.text, /ajustările de rotunjire.*încasările, plățile directe și acoperirile din fond/iu);
});

test('reports distinguish a contribution covered from a personal advance from money paid by the parent', async t => {
  const data = await fixture(t);
  const advance = data.ledger.getState().advances.find(item => item.expenseId === data.primary && item.outstandingMinor > 0);
  data.post('fund_advance.waive', { advanceId: advance.id, childId: data.own.id, expenseId: data.primary,
    amountMinor: 500, comment: 'Contribuția nu se mai colectează' });

  const childReport = await inspectPdf(data, 'child', 'covered-from-fund-child');
  assertMetric(childReport, 'Total de achitat', money(9750));
  assertText(childReport, `Încasat în fond ${money(2500)} · Acoperit din fond ${money(500)} · De achitat ${money(0)}`,
    'individual report keeps the source of settlement explicit');
  assertText(childReport, 'Acoperire din fond', 'individual history names the waiver');

  const expenseReport = await inspectPdf(data, 'expense', 'covered-from-fund-expense');
  assertMetric(expenseReport, 'Încasat în fond de la părinți', money(5500));
  assertMetric(expenseReport, 'Acoperit din fond', money(500));
  assertMetric(expenseReport, 'Acoperire totală', '50%');
  assertMetric(expenseReport, 'De achitat', `2 copii · ${money(6000)}`);

  const classReport = await inspectPdf(data, 'class', 'covered-from-fund-class');
  assertMetric(classReport, 'Contribuții acoperite din fond', money(500));
  assertMetric(classReport, 'De restituit pentru sume avansate', money(2500));

  const matrixReport = await inspectPdf(data, 'matrix', 'covered-from-fund-matrix');
  assertText(matrixReport, '30 / 30', 'matrix treats money plus fund coverage as settled');
});

test('reports separate direct beneficiary payments from money received into the class fund', async t => {
  const data = await fixture(t);
  const balanceBefore = data.ledger.getState().summary.balanceMinor;
  data.post('direct_payment.create', { childId: data.own.id, expenseId: data.primary,
    amountMinor: 500, destination: 'Doamna dirigintă', comment: 'Predat direct pentru fotografii' });
  const state = data.ledger.getState();
  assert.equal(state.summary.balanceMinor, balanceBefore);
  assert.equal(state.summary.totalDirectMinor, 500);

  const childReport = await inspectPdf(data, 'child', 'direct-payment-child');
  assertMetric(childReport, 'Total de achitat', money(9750));
  assertText(childReport, `Încasat în fond ${money(2500)} · Plătit direct beneficiarului ${money(500)} · De achitat ${money(0)}`,
    'individual report separates fund cash from direct payment');
  assertText(childReport, 'Plată directă beneficiarului', 'individual history names direct payment');
  assertText(childReport, 'Beneficiar: Doamna dirigintă', 'individual history names the recipient');

  const expenseReport = await inspectPdf(data, 'expense', 'direct-payment-expense');
  assertMetric(expenseReport, 'Încasat în fond de la părinți', money(5500));
  assertMetric(expenseReport, 'Plătit direct beneficiarilor', money(500));
  assertMetric(expenseReport, 'Acoperire totală', '50%');
  assertMetric(expenseReport, 'De achitat', `2 copii · ${money(6000)}`);

  const classReport = await inspectPdf(data, 'class', 'direct-payment-class');
  assertMetric(classReport, 'Plăți directe către beneficiari', money(500));
  assertText(classReport, `Încasat în fond ${money(5500)} · Plătit direct ${money(500)}`,
    'class expense row distinguishes direct payment');

  const matrixReport = await inspectPdf(data, 'matrix', 'direct-payment-matrix');
  assertText(matrixReport, '30 / 30', 'matrix treats cash plus direct payment as settled');
  assert.match(matrixReport.text, /plățile directe către beneficiari/iu);
});

test('a zero-total expense has no misleading percentage or non-finite financial text', async t => {
  const data = await fixture(t);
  // The ledger disallows creating a zero-valued expense. Exercise the renderer
  // directly so imported/legacy snapshots still have a defined empty state.
  const state = data.ledger.getState();
  const expense = state.expenses.find(item => item.id === data.primary);
  state.expenses = [{ ...expense, totalMinor: 0, collectedMinor: 0, paidOutMinor: 0,
    contributions: expense.contributions.map(item => ({ ...item, amountMinor: 0 })) }];
  state.children = state.children.map(child => ({ ...child, dueMinor: 0, creditMinor: 0,
    contributions: [{ expenseId: expense.id, title: expense.title, amountMinor: 0, paidMinor: 0, remainingMinor: 0 }] }));
  state.summary = { ...state.summary, totalDueMinor: 0, totalCreditMinor: 0 };
  state.transactions = []; state.advances = []; state.attachments = [];
  const branding = Object.fromEntries(['school', 'class'].map(kind => [kind, data.ledger.getBrandingImage(kind).data]));
  for (const type of ['class', 'expense', 'matrix']) {
    const report = { id: randomUUID(), serial: 1, code: 'R-0001', type, subjectId: type === 'expense' ? expense.id : null,
      subjectLabel: type === 'expense' ? expense.title : state.settings.className,
      createdAt: '2026-09-29T10:00:00.000Z', stateRevision: state.revision };
    const pdf = await renderReportPdf(report, state, branding);
    const result = await inspectBytes(pdf, report, `${type}-zero.pdf`, type, 'coverage-zero');
    assertLayout(result, type);
    assert.doesNotMatch(result.text, /(?:NaN|Infinity|\d+(?:,\d+)?%)/u, `${type}: zero total has no invented percentage`);
    if (type === 'matrix') assertText(result, '—', 'zero-total matrix header uses a dash');
    else assertText(result, 'Fără sumă de acoperit', `${type}: zero-total expense is explicitly described`);
  }
});
