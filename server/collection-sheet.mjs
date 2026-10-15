import PDFDocument from 'pdfkit';

const names = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });
const moneyFormat = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
const amount = minor => moneyFormat.format(minor / 100);
const personName = child => `${child.lastName} ${child.firstName}${child.active ? '' : ' (arhivat)'}`;

function contributionStatus(contribution) {
  if (!contribution) return { label: 'NU PARTICIPĂ', detail: '', writable: false };
  if (contribution.amountMinor === 0) return { label: 'FĂRĂ SUMĂ', detail: '', writable: false };
  const settled = contribution.amountMinor - contribution.remainingMinor;
  return {
    label: contribution.remainingMinor === 0 ? 'ACHITAT' : settled > 0 ? 'PARȚIAL' : 'NEACHITAT',
    detail: `${amount(settled)} / ${amount(contribution.amountMinor)} lei${contribution.remainingMinor ? ` · rest ${amount(contribution.remainingMinor)}` : ''}`,
    writable: contribution.remainingMinor > 0,
  };
}

// A separate monochrome document: no decorative artwork, logos, colored status
// fills, bank details, contacts or transaction comments reach the paper sheet.
export async function renderCollectionSheetPdf(report, state, fonts) {
  const expenses = state.expenses.filter(expense => !expense.cancelled && (!report.subjectId || expense.id === report.subjectId))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || names.compare(a.title, b.title) || a.id.localeCompare(b.id));
  const single = expenses.length === 1;
  const selectedIds = new Set(expenses.map(expense => expense.id));
  const children = state.children.filter(child => child.active || child.contributions.some(contribution => selectedIds.has(contribution.expenseId) && contribution.remainingMinor > 0))
    .sort((a, b) => names.compare(a.lastName, b.lastName) || names.compare(a.firstName, b.firstName) || a.id.localeCompare(b.id));
  const doc = new PDFDocument({ size: 'A4', layout: single ? 'portrait' : 'landscape', bufferPages: true,
    margins: { top: 32, right: 32, bottom: 38, left: 32 },
    info: { Title: `${report.code} · Fișă de încasări`, Author: 'Casierul clasei', CreationDate: new Date(report.createdAt) } });
  doc.registerFont('Regular', fonts.regular).registerFont('Bold', fonts.bold);
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 32, width = doc.page.width - 64, bottom = doc.page.height - 38;
  const groups = Array.from({ length: Math.ceil(expenses.length / 4) }, (_, index) => expenses.slice(index * 4, index * 4 + 4));
  if (!groups.length) groups.push([]);
  const cell = (text, x, y, cellWidth, { bold = false, size = 8, align = 'left' } = {}) => {
    doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor('black')
      .text(text, x + 5, y, { width: cellWidth - 10, align, lineGap: 1 });
  };
  const grid = (x, y, cellWidth, height) => doc.lineWidth(.6).strokeColor('black').rect(x, y, cellWidth, height).stroke();
  const heading = (group, groupIndex) => {
    doc.font('Bold').fontSize(15).fillColor('black').text('Fișă de încasări · alb-negru', left, 32, { width });
    doc.moveDown(.3).font('Regular').fontSize(9).text(`${state.settings.className || 'Clasa'} · ${state.settings.schoolName || 'Școala'} · ${state.settings.schoolYear || ''}`, { width });
    const timestamp = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Bucharest' }).format(new Date(report.createdAt));
    doc.moveDown(.3).fontSize(7.5).text(`${report.code} · Situație la ${timestamp} · Revizia registrului ${report.stateRevision}${report.replacesCode ? ` · Înlocuiește ${report.replacesCode}` : ''}`, { width });
    doc.moveDown(.6).fontSize(9).text('Data foii: __________________    Încasat de: ______________________________', { width });
    doc.moveDown(.6).fontSize(7.5).text('ACHITAT = contribuție stinsă; PARȚIAL = rest de achitat; NU PARTICIPĂ = fără contribuție.', { width });
    doc.moveDown(.2).text('Sumele stinse includ încasări, avans repartizat, plată directă, acoperire și ajustări. Toate sumele sunt în lei.', { width });
    doc.moveDown(.2).font('Bold').text('Notează numai cash primit acum. Introdu ulterior încasările în aplicație; foaia nu actualizează registrul.', { width });
    doc.moveDown(.5).font('Regular');
    group.forEach((expense, index) => {
      doc.fontSize(8).text(`${groupIndex * 4 + index + 1}. ${expense.title}`, left, doc.y, { width, lineGap: 1 });
      doc.moveDown(.2);
    });
    doc.moveDown(.4);
    const y = doc.y, headerHeight = 30;
    const sizes = single ? [25, 165, 112, 92, width - 394] : [25, 185, ...group.map(() => (width - 210) / group.length)];
    const labels = single ? ['Nr.', 'Copil', 'Situație în registru\nstins / datorat', 'Cash primit\n(lei)', 'Data / observații']
      : ['Nr.', 'Copil', ...group.map((_, index) => `Cheltuiala ${groupIndex * 4 + index + 1}\nSituație / cash primit` )];
    let x = left;
    labels.forEach((label, index) => { grid(x, y, sizes[index], headerHeight); cell(label, x, y + 5, sizes[index], { bold: true, size: 7.5 }); x += sizes[index]; });
    doc.y = y + headerHeight; doc.x = left;
    return sizes;
  };
  groups.forEach((group, groupIndex) => {
    if (groupIndex) doc.addPage();
    let sizes = heading(group, groupIndex);
    if (!expenses.length || !children.length) {
      doc.moveDown().font('Regular').fontSize(9).text(!expenses.length ? 'Nu există cheltuieli active pentru fișă.' : 'Nu există copii pentru această fișă.', left, doc.y, { width });
      return;
    }
    children.forEach((child, childIndex) => {
      doc.font('Regular').fontSize(8.5);
      const rowHeight = Math.max(38, doc.heightOfString(personName(child), { width: sizes[1] - 10, lineGap: 1 }) + 14);
      if (doc.y + rowHeight + (childIndex === children.length - 1 ? 25 : 0) > bottom) { doc.addPage(); sizes = heading(group, groupIndex); }
      const y = doc.y;
      let x = left;
      sizes.forEach(cellWidth => { grid(x, y, cellWidth, rowHeight); x += cellWidth; });
      cell(String(childIndex + 1), left, y + 7, sizes[0], { size: 8 });
      cell(personName(child), left + sizes[0], y + 7, sizes[1], { size: 8.5 });
      group.forEach((expense, index) => {
        const contribution = child.contributions.find(entry => entry.expenseId === expense.id);
        const status = contributionStatus(contribution);
        const columnWidth = single ? sizes[2] : sizes[index + 2];
        const columnX = left + sizes[0] + sizes[1] + (single ? 0 : index * columnWidth);
        cell(status.label, columnX, y + 5, columnWidth, { bold: true, size: 7.5 });
        if (status.detail) cell(status.detail, columnX, y + 16, columnWidth, { size: 6.5 });
        if (!single && status.writable) cell('Cash: __________  Data: _______', columnX, y + rowHeight - 13, columnWidth, { size: 7 });
        if (single && !status.writable) {
          cell('—', columnX + sizes[2], y + 13, sizes[3]);
        }
      });
      doc.y = y + rowHeight; doc.x = left;
    });
    // A blank total is for handwriting only, never a second ledger balance.
    doc.font('Bold').fontSize(9).text('Total cash primit pe această parte a fișei: __________________ lei', left, doc.y + 9, { width });
  });
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index++) {
    doc.switchToPage(index);
    doc.page.margins.bottom = 0;
    doc.font('Regular').fontSize(7).fillColor('black').text(`${report.code} · pagina ${index + 1}/${pages.count} · Foaie de lucru nominală, pentru uz intern`,
      left, doc.page.height - 24, { width, lineBreak: false });
  }
  doc.end();
  return complete;
}
