import test from 'node:test';
import assert from 'node:assert/strict';
import { money, parseMoney, roundUp, collectionResult, creditSettlement, smallSettlement, expensePreview, sortChildren, unpaid, whatsappReminder, whatsappUrl, whatsappShareUrl, paymentShareItems, reportShareMessage } from '../web/helpers.mjs';
const child = { dueMinor: 8500, contributions: [
  { expenseId: 'books', title: 'Culegeri', dueDate: '2026-10-02', remainingMinor: 6000 },
  { expenseId: 'trip', title: 'Excursie', dueDate: '2026-10-01', remainingMinor: 2500 },
] };
const draft = extras => ({ amount: '100', target: 'all', excess: 'change', manual: false, allocations: {}, ...extras });

test('Romanian money converts exactly to bani and rejects ambiguous or imprecise inputs', () => {
  assert.equal(money(114750), '1.147,50 lei');
  assert.equal(money(3000), '30 lei');
  assert.equal(money(1), '0,01 lei');
  assert.equal(money(-50), '-0,50 lei');
  assert.equal(parseMoney('75,55'), 7555);
  assert.equal(parseMoney(' 0,01 '), 1);
  assert.equal(parseMoney('75.5'), 7550);
  for (const text of ['', '-1', '1.000,25', '1,999', '1e2', 'Infinity']) assert.equal(parseMoney(text), null, text);
});
test('rounding uses the selected original amount and preserves exact multiples', () => {
  assert.equal(roundUp(1414, 5), 1500);
  assert.equal(roundUp(1500, 5), 1500);
  assert.equal(roundUp(8550, 10), 9000);
  assert.equal(roundUp(8550, 50), 10000);
  assert.equal(roundUp(10000, 100), 10000);
  assert.equal(roundUp(7555, 10), 8000);
});
test('automatic collections use earliest deadline and handle partial payment', () => {
  const result = collectionResult(child, draft({ amount: '40' }));
  assert.deepEqual(result.allocations, [{ expenseId: 'trip', amountMinor: 2500 }, { expenseId: 'books', amountMinor: 1500 }]);
  assert.equal(result.dueMinor, 4500);
  assert.equal(result.netMinor, 4000);
});
test('small settlement closes at most one leu on the selected scope', () => {
  const tiny = { dueMinor: 1414, contributions: [{ expenseId: 'sport', title: 'Echipament', dueDate: null, remainingMinor: 1414 }] };
  const result = collectionResult(tiny, draft({ amount: '14' }));
  assert.deepEqual(smallSettlement(tiny, draft({ amount: '14' }), result), {
    amountMinor: 14, allocations: [{ expenseId: 'sport', amountMinor: 14 }],
  });
  assert.equal(smallSettlement(tiny, draft({ amount: '13' })), null);
  const scoped = collectionResult(child, draft({ amount: '59,50', target: 'books' }));
  assert.deepEqual(smallSettlement(child, draft({ amount: '59,50', target: 'books' }), scoped), {
    amountMinor: 50, allocations: [{ expenseId: 'books', amountMinor: 50 }],
  });
});
test('existing child credit can cover all or part of the selected amount alongside cash', () => {
  const withCredit = { ...child, creditMinor: 2000 };
  const mixedDraft = draft({ amount: '65', useCredit: true });
  const mixed = collectionResult(withCredit, mixedDraft);
  assert.deepEqual(creditSettlement(withCredit, mixedDraft, mixed), {
    amountMinor: 2000, allocations: [{ expenseId: 'books', amountMinor: 2000 }],
  });
  const creditOnlyDraft = draft({ amount: '0', target: 'trip', useCredit: true });
  const creditOnly = collectionResult({ ...withCredit, creditMinor: 3000 }, creditOnlyDraft);
  assert.equal(creditOnly.netMinor, 0);
  assert.deepEqual(creditSettlement({ ...withCredit, creditMinor: 3000 }, creditOnlyDraft, creditOnly), {
    amountMinor: 2500, allocations: [{ expenseId: 'trip', amountMinor: 2500 }],
  });
});
test('earmarked rounded amount never covers another expense and supports change or credit', () => {
  const change = collectionResult(child, draft({ target: 'books' }));
  assert.deepEqual(change.allocations, [{ expenseId: 'books', amountMinor: 6000 }]);
  assert.equal(change.changeMinor, 4000);
  assert.equal(change.netMinor, 6000);
  const credit = collectionResult(child, draft({ target: 'books', excess: 'credit' }));
  assert.equal(credit.creditMinor, 4000);
  assert.equal(credit.netMinor, 10000);
  assert.equal(credit.dueMinor, 2500);
});
test('manual allocation may split funds but rejects overspending and overpayment', () => {
  assert.ok(collectionResult(child, draft({ amount: '50', manual: true, allocations: { books: '40', trip: '20' } })).error);
  assert.ok(collectionResult(child, draft({ manual: true, allocations: { books: '70' } })).error);
  assert.equal(collectionResult(child, draft({ manual: true, allocations: { books: '40', trip: '20' }, excess: 'credit' })).creditMinor, 4000);
});
test('concurrent removal of earmarked debt forces review, never silently switches to all', () => {
  const changed = { dueMinor: 2500, contributions: [child.contributions[1]] };
  assert.ok(collectionResult(changed, draft({ target: 'books' })).error);
  assert.ok(collectionResult(changed, draft({ manual: true, allocations: { books: '60' } })).error);
});
test('exact split distributes every ban by lexical child ID independent of input order', () => {
  const allocations = expensePreview('split', 10000, [{ childId: 'c' }, { childId: 'a' }, { childId: 'b' }]);
  assert.deepEqual(allocations.map(p => [p.childId, p.amountMinor]), [['a', 3334], ['b', 3333], ['c', 3333]]);
  assert.equal(allocations.reduce((sum, p) => sum + p.amountMinor, 0), 10000);
  assert.equal(expensePreview('quantity', 1555, [{ childId: 'a', quantity: 3 }])[0].amountMinor, 4665);
});
test('surname order uses Romanian collation and paid contributions are excluded', () => {
  assert.deepEqual(sortChildren([{ id:'1',lastName:'Șerban',firstName:'Ana' },{ id:'2',lastName:'Avram',firstName:'Dan' },{ id:'3',lastName:'Bălan',firstName:'Ioana' }]).map(c => c.id), ['2','3','1']);
  assert.equal(unpaid({ contributions: [{expenseId:'paid',remainingMinor:0}, ...child.contributions] }).length, 2);
});
test('WhatsApp reminders contain only the selected child situation and use a direct conversation URL', () => {
  const pupil = { ...child, firstName: 'Ana', lastName: 'Popescu', creditMinor: 500 };
  const message = whatsappReminder(pupil, 'III B', { paymentRevolutUrl: 'https://revolut.me/exampleclass',
    paymentBeneficiary: 'Ana Popescu', paymentIban: 'RO49AAAA1B31007593840000' });
  assert.match(message, /Popescu Ana din III B/u);
  assert.match(message, /Excursie: 25 lei \(termen 1 oct\. 2026\)/u);
  assert.match(message, /Total de achitat: 85 lei/u);
  assert.match(message, /Avans disponibil: 5 lei/u);
  assert.match(message, /Poți plăti și cu cardul direct din link, fără cont Revolut/u);
  assert.match(message, /Beneficiar: Ana Popescu/u);
  assert.match(message, /IBAN: RO49AAAA1B31007593840000/u);
  assert.match(message, /Detalii plată: numele elevului/u);
  assert.equal(whatsappUrl('+40722111222', message), `https://wa.me/40722111222?text=${encodeURIComponent(message)}`);
  assert.equal(whatsappUrl('număr invalid', message), '');
});
test('payment details become three separate WhatsApp messages for easy links and copying', () => {
  const items = paymentShareItems({ className: 'IX A', paymentRevolutUrl: 'https://revolut.me/exampleclass',
    paymentBeneficiary: 'Ana Popescu', paymentIban: 'RO49AAAA1B31007593840000' });
  assert.deepEqual(items.map(item => item.key), ['revolut', 'beneficiary', 'iban']);
  assert.equal(items[0].message, 'Detalii de plată – IX A\nRevolut: https://revolut.me/exampleclass\nNu ai nevoie de cont Revolut: poți plăti și cu cardul direct din link.\nDetalii plată: numele elevului');
  assert.equal(items[1].message, 'Ana Popescu');
  assert.equal(items[2].message, 'RO49AAAA1B31007593840000');
  assert.equal(whatsappShareUrl(items[2].message), `https://wa.me/?text=${encodeURIComponent(items[2].message)}`);
  assert.deepEqual(paymentShareItems({ className: 'IX A' }), []);
});
test('report sharing messages describe aggregate and private PDFs without inventing live values', () => {
  assert.equal(reportShareMessage({ type: 'class', code: 'R-0012', subjectLabel: 'III B' }, 'III B'),
    'Bună ziua,\n\nVă trimit situația fondului clasei III B.\nRaport R-0012. Documentul reflectă situația de la momentul emiterii.\n\nMulțumesc!');
  assert.match(reportShareMessage({ type: 'expense', code: 'R-0013', subjectLabel: 'Echipament sportiv' }, 'III B'),
    /situația cheltuielii „Echipament sportiv” pentru III B/u);
  assert.match(reportShareMessage({ type: 'matrix', code: 'R-0014', subjectLabel: 'III B' }, 'III B'),
    /tabelul contribuțiilor pentru III B, pentru verificare/u);
  assert.match(reportShareMessage({ type: 'child', code: 'R-0015', subjectLabel: 'Avram Ana' }, 'III B'),
    /fișa individuală pentru Avram Ana/u);
});
