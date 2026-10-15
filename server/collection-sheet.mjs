import PDFDocument from 'pdfkit';

const names = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });
const moneyFormat = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
const amount = minor => moneyFormat.format(minor / 100);
const personName = child => `${child.lastName} ${child.firstName}${child.active ? '' : ' (arhivat)'}`;
const tooLarge = () => Object.assign(new Error('Fișa nu încape lizibil pe o singură pagină A4. Selectează o singură cheltuială sau folosește Tabelul contribuțiilor pentru lista completă.'), { status: 400 });

function contributionStatus(contribution, single) {
  if (!contribution) return { label: single ? 'NU PARTICIPĂ' : '—', writable: false };
  if (contribution.amountMinor === 0) return { label: single ? 'FĂRĂ SUMĂ' : '0', writable: false };
  if (contribution.remainingMinor === 0) return { label: single ? 'ACHITAT' : 'OK', writable: false };
  const partial = contribution.remainingMinor < contribution.amountMinor;
  return { label: `${partial ? single ? 'PARȚIAL · rest ' : 'P ' : single ? 'Rest ' : ''}${amount(contribution.remainingMinor)}`, writable: true };
}

// One portrait worksheet. Existing payments are compact text marks; separate
// empty cells are reserved for handwriting new receipts. No financial writes.
export async function renderCollectionSheetPdf(report, state, fonts) {
  const expenses = state.expenses.filter(expense => !expense.cancelled && (!report.subjectId || expense.id === report.subjectId))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || names.compare(a.title, b.title) || a.id.localeCompare(b.id));
  const single = expenses.length === 1;
  const selectedIds = new Set(expenses.map(expense => expense.id));
  const children = state.children.filter(child => child.active || child.contributions.some(contribution => selectedIds.has(contribution.expenseId) && contribution.remainingMinor > 0))
    .sort((a, b) => names.compare(a.lastName, b.lastName) || names.compare(a.firstName, b.firstName) || a.id.localeCompare(b.id));
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', bufferPages: true,
    margins: { top: 26, right: 26, bottom: 28, left: 26 },
    info: { Title: `${report.code} · Fișă de încasări`, Author: 'Casierul clasei', CreationDate: new Date(report.createdAt) } });
  doc.registerFont('Regular', fonts.regular).registerFont('Bold', fonts.bold);
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 26, width = doc.page.width - 52;
  const line = (text, size = 7.5, bold = false, gap = 3) => {
    doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor('black').text(text, left, doc.y, { width, lineGap: 0 });
    doc.y += gap;
  };
  line('Fișă de încasări · alb-negru', 13, true, 3);
  line(`${state.settings.className || 'Clasa'} · ${state.settings.schoolName || 'Școala'} · ${state.settings.schoolYear || ''}`, 8, false, 2);
  const timestamp = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Bucharest' }).format(new Date(report.createdAt));
  line(`${report.code} · ${timestamp} · Revizia ${report.stateRevision}${report.replacesCode ? ` · Înlocuiește ${report.replacesCode}` : ''}`, 7, false, 4);
  line('Data foii: __________________    Încasat de: ______________________________', 8, false, 4);
  expenses.forEach((expense, index) => line(`${index + 1}. ${expense.title}`, expenses.length > 5 ? 6.5 : 7.5, false, 1));
  line('OK / ACHITAT = contribuție stinsă; P = parțial (rest); suma = rest de achitat; — = nu participă; 0 = fără sumă.', 6.5, false, 1);
  line('Stins inclusiv prin avans, plată directă, acoperire sau ajustare. Toate sumele sunt în lei.', 6.5, false, 1);
  line('Notează numai cash primit acum; introdu ulterior încasările în aplicație. Foaia nu actualizează registrul.', 6.5, true, 5);
  const finish = async () => {
    doc.page.margins.bottom = 0;
    doc.font('Regular').fontSize(6.5).text(`${report.code} · pagina 1/1 · Foaie de lucru nominală, pentru uz intern`, left, doc.page.height - 23, { width, lineBreak: false });
    if (doc.bufferedPageRange().count !== 1) { doc.end(); await complete; throw tooLarge(); }
    doc.end();
    return complete;
  };
  if (!expenses.length || !children.length) {
    line(!expenses.length ? 'Nu există cheltuieli active pentru fișă.' : 'Nu există copii pentru această fișă.');
    return finish();
  }

  const numberWidth = 20;
  const nameWidth = single ? 172 : expenses.length <= 4 ? 150 : 110;
  const dateWidth = single ? 110 : expenses.length <= 4 ? 42 : 0;
  const expenseWidth = single ? width - numberWidth - nameWidth - dateWidth : (width - numberWidth - nameWidth - dateWidth) / Math.max(1, expenses.length);
  if (!single && expenseWidth < 36) { doc.end(); await complete; throw tooLarge(); }
  const statusWidth = single ? expenseWidth * .53 : expenseWidth * .48;
  const cashWidth = expenseWidth - statusWidth;
  const tableY = doc.y, headerHeight = single ? 25 : 31;
  const available = doc.page.height - 52 - tableY - headerHeight - 22;
  let fontSize, rowHeights;
  for (const size of [8.5, 8, 7.5, 7, 6.5, 6, 5.5]) {
    doc.font('Regular').fontSize(size);
    const heights = children.map(child => Math.max(11, doc.heightOfString(personName(child), { width: nameWidth - 8, lineGap: 0 }) + 4));
    if (heights.reduce((total, height) => total + height, 0) <= available) {
      fontSize = size;
      const extra = Math.max(0, (available - heights.reduce((total, height) => total + height, 0)) / Math.max(1, children.length));
      rowHeights = heights.map(height => Math.max(height, Math.min(24, height + extra)));
      break;
    }
  }
  if (!fontSize || available < 24) { doc.end(); await complete; throw tooLarge(); }

  const grid = (x, y, cellWidth, height) => doc.lineWidth(.5).strokeColor('black').rect(x, y, cellWidth, height).stroke();
  const cell = (text, x, y, cellWidth, height, { bold = false, size = fontSize, wrap = false } = {}) => {
    doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor('black');
    if (!wrap) {
      while (doc.widthOfString(text) > cellWidth - 6 && size > 4.5) { size -= .25; doc.fontSize(size); }
      if (doc.widthOfString(text) > cellWidth - 6) { doc.end(); throw tooLarge(); }
    }
    const textHeight = doc.heightOfString(text, { width: cellWidth - (wrap ? 8 : 6), lineGap: 0 });
    doc.text(text, x + (wrap ? 4 : 3), y + (height - textHeight) / 2, { width: cellWidth - (wrap ? 8 : 6), lineGap: 0 });
  };
  const expenseStart = left + numberWidth + nameWidth;
  grid(left, tableY, numberWidth, headerHeight); cell('Nr.', left, tableY, numberWidth, headerHeight, { bold: true, size: 7 });
  grid(left + numberWidth, tableY, nameWidth, headerHeight); cell('Copil', left + numberWidth, tableY, nameWidth, headerHeight, { bold: true, size: 8 });
  expenses.forEach((_, index) => {
    const x = expenseStart + index * expenseWidth;
    if (!single) { grid(x, tableY, expenseWidth, 15); cell(expenseWidth < 60 ? `#${index + 1}` : `Cheltuiala ${index + 1}`, x, tableY, expenseWidth, 15, { bold: true, size: 7 }); }
    const y = tableY + (single ? 0 : 15), height = single ? headerHeight : 16;
    grid(x, y, statusWidth, height); cell(single ? 'Situație / rest' : statusWidth < 40 ? 'Rest' : 'Rest / stare', x, y, statusWidth, height, { bold: true, size: 7 });
    grid(x + statusWidth, y, cashWidth, height); cell(single ? 'Cash primit (lei)' : cashWidth < 35 ? 'Cash' : 'Cash nou', x + statusWidth, y, cashWidth, height, { bold: true, size: 7 });
  });
  const dateX = expenseStart + expenses.length * expenseWidth;
  if (dateWidth) { grid(dateX, tableY, dateWidth, headerHeight); cell(single ? 'Data / observații' : 'Data', dateX, tableY, dateWidth, headerHeight, { bold: true, size: 7 }); }
  let y = tableY + headerHeight;
  children.forEach((child, index) => {
    const height = rowHeights[index];
    grid(left, y, numberWidth, height); cell(String(index + 1), left, y, numberWidth, height);
    grid(left + numberWidth, y, nameWidth, height); cell(personName(child), left + numberWidth, y, nameWidth, height, { wrap: true });
    let writable = false;
    expenses.forEach((expense, expenseIndex) => {
      const status = contributionStatus(child.contributions.find(entry => entry.expenseId === expense.id), single);
      const x = expenseStart + expenseIndex * expenseWidth;
      grid(x, y, statusWidth, height); cell(status.label, x, y, statusWidth, height, { bold: true, size: Math.min(fontSize, 8) });
      grid(x + statusWidth, y, cashWidth, height);
      if (!status.writable) cell('—', x + statusWidth, y, cashWidth, height);
      writable ||= status.writable;
    });
    if (dateWidth) { grid(dateX, y, dateWidth, height); if (!writable) cell('—', dateX, y, dateWidth, height); }
    y += height;
  });
  doc.font('Bold').fontSize(8).text('Total cash primit: __________________ lei', left, y + 7, { width });
  return finish();
}
