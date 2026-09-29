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
export function expensePreview(type, amountMinor, participants) {
  const ordered = [...participants].sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
  return ordered.map((p, i) => ({ ...p, amountMinor: type === 'split' ? Math.floor(amountMinor / ordered.length) + (i < amountMinor % ordered.length ? 1 : 0) : amountMinor * (type === 'quantity' ? p.quantity : 1) }));
}
