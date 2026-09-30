export const collator = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });
export const name = child => `${child.lastName} ${child.firstName}`;
export const sortChildren = children => [...children].sort((a, b) => collator.compare(a.lastName, b.lastName) || collator.compare(a.firstName, b.firstName) || a.id.localeCompare(b.id));
const formatter = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
const fractionalFormatter = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = minor => `${(minor % 100 ? fractionalFormatter : formatter).format(minor / 100)} lei`;
export const decimal = minor => (minor / 100).toFixed(2).replace('.', ',');
export function parseMoney(value) {
  const normalized = String(value).trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const roundUp = (minor, unitLei) => Math.ceil(minor / (unitLei * 100)) * unitLei * 100;
export const unpaid = child => [...child.contributions].filter(e => e.remainingMinor > 0).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.expenseId.localeCompare(b.expenseId));
const reminderDate = value => new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
export function whatsappReminder(child, className = '') {
  const contributions = unpaid(child);
  const context = className ? ` din ${className}` : '';
  const lines = contributions.length
    ? contributions.map(item => `• ${item.title}: ${money(item.remainingMinor)}${item.dueDate ? ` (termen ${reminderDate(item.dueDate)})` : ''}`)
    : ['• Toate contribuțiile înregistrate sunt achitate.'];
  return ['Bună ziua,', '', `Vă trimit situația contribuțiilor pentru ${name(child)}${context}:`, ...lines, '',
    `Total de achitat: ${money(child.dueMinor)}`, child.creditMinor ? `Avans disponibil: ${money(child.creditMinor)}` : '', '', 'Mulțumesc!']
    .filter((line, index, values) => line || values[index - 1] !== '').join('\n');
}
export function whatsappUrl(phone, message) {
  const digits = String(phone).replace(/^\+/u, '');
  if (!/^[1-9]\d{7,14}$/u.test(digits)) return '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
export function reportShareMessage(report, className = '') {
  const classSuffix = className ? ` pentru ${className}` : '';
  const description = report.type === 'class' ? `situația fondului clasei${className ? ` ${className}` : ''}`
    : report.type === 'expense' ? `situația cheltuielii „${report.subjectLabel}”${classSuffix}`
      : report.type === 'matrix' ? `tabelul contribuțiilor${classSuffix}, pentru verificare`
        : `fișa individuală pentru ${report.subjectLabel}`;
  return `Bună ziua,\n\nVă trimit ${description}.\nRaport ${report.code}. Documentul reflectă situația de la momentul emiterii.\n\nMulțumesc!`;
}
export function automaticAllocations(contributions, available, target = 'all') {
  return contributions.map(e => {
    const amountMinor = target === 'all' || target === e.expenseId ? Math.min(available, e.remainingMinor) : 0;
    available -= amountMinor;
    return { expenseId: e.expenseId, amountMinor };
  }).filter(e => e.amountMinor > 0);
}
export function collectionResult(child, draft) {
  const receivedMinor = parseMoney(draft.amount);
  if (receivedMinor === null || receivedMinor <= 0) return { error: 'Introdu o sumă mai mare decât zero, cu cel mult două zecimale.' };
  const contributions = unpaid(child);
  if (!draft.manual && draft.target !== 'all' && !contributions.some(e => e.expenseId === draft.target)) return { error: 'Cheltuiala selectată nu mai are restanță. Alege din nou totalul sau o cheltuială.' };
  if (draft.manual && Object.entries(draft.allocations).some(([id, value]) => parseMoney(value) > 0 && !contributions.some(e => e.expenseId === id))) return { error: 'O contribuție repartizată nu mai are restanță. Selectează din nou totalul sau o cheltuială și verifică repartizarea.' };
  const allocations = draft.manual ? contributions.map(e => ({ expenseId: e.expenseId, amountMinor: parseMoney(draft.allocations[e.expenseId] || '0') })) : automaticAllocations(contributions, receivedMinor, draft.target);
  if (allocations.some(a => a.amountMinor === null || a.amountMinor > contributions.find(e => e.expenseId === a.expenseId).remainingMinor)) return { error: 'Verifică repartizarea: fiecare sumă trebuie să fie validă și să nu depășească restanța.' };
  const coveredMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  if (coveredMinor > receivedMinor) return { error: 'Repartizarea depășește suma primită.' };
  const excessMinor = receivedMinor - coveredMinor;
  const changeMinor = draft.excess === 'change' ? excessMinor : 0;
  return { receivedMinor, allocations: allocations.filter(a => a.amountMinor > 0), coveredMinor, excessMinor, changeMinor, creditMinor: excessMinor - changeMinor, netMinor: receivedMinor - changeMinor, dueMinor: child.dueMinor - coveredMinor };
}
export function smallSettlement(child, draft, result = collectionResult(child, draft)) {
  if (result.error || result.netMinor <= 0) return null;
  const paidByExpense = new Map(result.allocations.map(item => [item.expenseId, item.amountMinor]));
  const candidates = unpaid(child).filter(item => draft.target === 'all' || item.expenseId === draft.target);
  const allocations = candidates.map(item => ({
    expenseId: item.expenseId,
    amountMinor: item.remainingMinor - (paidByExpense.get(item.expenseId) || 0),
  })).filter(item => item.amountMinor > 0);
  const amountMinor = allocations.reduce((sum, item) => sum + item.amountMinor, 0);
  return amountMinor > 0 && amountMinor <= 100 ? { amountMinor, allocations } : null;
}
export function expensePreview(type, amountMinor, participants) {
  const ordered = [...participants].sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
  return ordered.map((p, i) => ({ ...p, amountMinor: type === 'split' ? Math.floor(amountMinor / ordered.length) + (i < amountMinor % ordered.length ? 1 : 0) : amountMinor * (type === 'quantity' ? p.quantity : 1) }));
}
