import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGULAR = path.resolve(HERE, '../assets/fonts/DejaVuSans.ttf');
const BOLD = path.resolve(HERE, '../assets/fonts/DejaVuSans-Bold.ttf');
const locale = 'ro-RO';
const zone = 'Europe/Bucharest';
const moneyFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: zone });
const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
const compactMoneyFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const REPORT_TYPES = new Set(['class', 'expense', 'child', 'matrix']);
export const reportCode = serial => `R-${String(serial).padStart(4, '0')}`;
const money = minor => `${moneyFormat.format(minor / 100)} lei`;
const personName = child => `${child.lastName} ${child.firstName}`;
const activeTransactions = state => state.transactions.filter(tx => tx.type !== 'reversal' && !tx.reversed);
const sum = values => values.reduce((total, value) => total + value, 0);

function expenseStatus(state, expense) {
  const contributions = state.children.map(child => child.contributions.find(item => item.expenseId === expense.id)).filter(Boolean);
  const outstanding = contributions.filter(item => item.remainingMinor > 0);
  return { count: outstanding.length, amountMinor: sum(outstanding.map(item => item.remainingMinor)) };
}

export function reportSubject(state, type, subjectId) {
  if (type === 'class' || type === 'matrix') return { id: null, label: state.settings.className || 'Clasa' };
  if (type === 'expense') {
    const expense = state.expenses.find(item => item.id === subjectId && !item.cancelled);
    if (!expense) throw Object.assign(new Error('Cheltuiala pentru raport nu există.'), { status: 404 });
    return { id: expense.id, label: expense.title };
  }
  const child = state.children.find(item => item.id === subjectId);
  if (!child) throw Object.assign(new Error('Copilul pentru raport nu există.'), { status: 404 });
  return { id: child.id, label: personName(child) };
}

export function reportFilename(report) {
  const type = { class: 'situatia-clasei', expense: 'cheltuiala', child: 'fisa-copil', matrix: 'raport-exhaustiv' }[report.type];
  const subject = report.subjectLabel.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase();
  return `${type}-${subject || 'raport'}-${report.code}.pdf`;
}

function documentTitle(report) {
  if (report.type === 'class') return 'Situația clasei';
  if (report.type === 'matrix') return 'Raport exhaustiv';
  if (report.type === 'expense') return `Situația cheltuielii „${report.subjectLabel}”`;
  return `Fișa individuală — ${report.subjectLabel}`;
}

export async function renderReportPdf(report, state) {
  const doc = new PDFDocument({ size: 'A4', layout: report.type === 'matrix' ? 'landscape' : 'portrait', margins: { top: 46, right: 42, bottom: 58, left: 42 }, bufferPages: true,
    info: { Title: `${report.code} · ${documentTitle(report)}`, Author: 'Casierul clasei', CreationDate: new Date(report.createdAt) } });
  doc.registerFont('Regular', REGULAR).registerFont('Bold', BOLD);
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const green = '#205d42', dark = '#1d3027', muted = '#58665f', line = '#dce3dd', soft = '#edf4ef';

  const ensure = height => { if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
  const rule = () => { doc.moveDown(.3).strokeColor(line).lineWidth(.7).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().moveDown(.5); };
  const section = title => { ensure(48); doc.moveDown(.5).font('Bold').fontSize(14).fillColor(dark).text(title, doc.page.margins.left, doc.y, { width }); rule(); };
  const note = text => { ensure(35); doc.font('Regular').fontSize(8.5).fillColor(muted).text(text, doc.page.margins.left, doc.y, { width, lineGap: 2 }); doc.moveDown(.4); };
  const metric = (label, value) => {
    ensure(25); const y = doc.y;
    doc.font('Regular').fontSize(9.5).fillColor(muted).text(label, doc.page.margins.left, y, { width: width * .58 });
    doc.font('Bold').fontSize(10).fillColor(dark).text(value, doc.page.margins.left + width * .58, y, { width: width * .42, align: 'right' });
    doc.y = Math.max(doc.y, y + 17); doc.x = doc.page.margins.left;
  };
  const item = (title, amount, details, comment = '') => {
    ensure(comment ? 70 : 52); const y = doc.y;
    doc.font('Bold').fontSize(10).fillColor(dark).text(title, doc.page.margins.left, y, { width: width * .72 });
    doc.font('Bold').fontSize(10).fillColor(dark).text(amount, doc.page.margins.left + width * .72, y, { width: width * .28, align: 'right' });
    doc.font('Regular').fontSize(8.5).fillColor(muted).text(details, doc.page.margins.left, Math.max(doc.y, y + 16), { width, lineGap: 2 });
    if (comment) doc.font('Regular').fontSize(8.5).fillColor(dark).text(comment, { width, lineGap: 2 });
    doc.moveDown(.4); doc.strokeColor(line).lineWidth(.4).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().moveDown(.45);
  };
  const matrixReport = () => {
    const expenses = state.expenses.filter(entry => !entry.cancelled).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.title.localeCompare(b.title, locale));
    if (!expenses.length) { note('Nu există cheltuieli active pentru tabel.'); return; }
    const children = state.children;
    const left = doc.page.margins.left, nameWidth = 145, minimumCellWidth = 92;
    const columnsPerGroup = Math.max(1, Math.floor((width - nameWidth) / minimumCellWidth));
    const groups = Array.from({ length: Math.ceil(expenses.length / columnsPerGroup) }, (_, index) => expenses.slice(index * columnsPerGroup, (index + 1) * columnsPerGroup));
    const colors = { paid: '#d9f0e1', partial: '#fff0bf', unpaid: '#f7d6d2', none: '#eeeeea' };
    const rowHeight = 23, headerHeight = 48;
    const compactMoney = minor => compactMoneyFormat.format(minor / 100);
    const legend = () => {
      const entries = [['Achitat', colors.paid], ['Parțial', colors.partial], ['Neachitat', colors.unpaid], ['Nu participă', colors.none]];
      let x = left;
      doc.font('Regular').fontSize(7.5).fillColor(muted).text('Celulă: achitat / datorat, în lei', x, doc.y, { lineBreak: false });
      x += 185;
      for (const [label, color] of entries) {
        doc.rect(x, doc.y - 1, 10, 10).fillAndStroke(color, line);
        doc.fillColor(muted).text(label, x + 14, doc.y, { lineBreak: false });
        x += doc.widthOfString(label) + 31;
      }
      doc.y += 18; doc.x = left;
    };
    const groupHeading = (groupIndex, continued = false) => {
      doc.font('Bold').fontSize(10).fillColor(dark).text(`${continued ? 'Raport exhaustiv · ' : ''}cheltuieli ${groupIndex * columnsPerGroup + 1}–${Math.min(expenses.length, (groupIndex + 1) * columnsPerGroup)} din ${expenses.length}`, left, doc.y, { width });
      doc.moveDown(.3); legend();
    };
    const tableHeader = group => {
      const cellWidth = Math.min(118, (width - nameWidth) / group.length), tableWidth = nameWidth + cellWidth * group.length;
      let x = left, y = doc.y;
      doc.rect(x, y, nameWidth, headerHeight).fillAndStroke(soft, line);
      doc.font('Bold').fontSize(8).fillColor(dark).text('Copil', x + 5, y + 18, { width: nameWidth - 10, ellipsis: true, lineBreak: false });
      x += nameWidth;
      for (const expense of group) {
        doc.rect(x, y, cellWidth, headerHeight).fillAndStroke(soft, line);
        doc.font('Bold').fontSize(7.2).fillColor(dark).text(expense.title, x + 4, y + 6, { width: cellWidth - 8, height: headerHeight - 12, align: 'center', ellipsis: true });
        x += cellWidth;
      }
      doc.y = y + headerHeight; doc.x = left;
      return { cellWidth, tableWidth };
    };
    const newMatrixPage = (group, groupIndex) => {
      doc.addPage();
      groupHeading(groupIndex, true);
      return tableHeader(group);
    };
    groups.forEach((group, groupIndex) => {
      if (groupIndex) doc.addPage();
      groupHeading(groupIndex, groupIndex > 0);
      let geometry = tableHeader(group);
      for (const child of children) {
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 4) geometry = newMatrixPage(group, groupIndex);
        const y = doc.y;
        doc.rect(left, y, nameWidth, rowHeight).fillAndStroke('#ffffff', line);
        doc.font('Regular').fontSize(7.5).fillColor(dark).text(`${personName(child)}${child.active ? '' : ' · arhivat'}`, left + 5, y + 7, { width: nameWidth - 10, height: rowHeight - 8, ellipsis: true, lineBreak: false });
        group.forEach((expense, index) => {
          const contribution = child.contributions.find(entry => entry.expenseId === expense.id);
          const status = !contribution ? 'none' : contribution.paidMinor >= contribution.amountMinor ? 'paid' : contribution.paidMinor > 0 ? 'partial' : 'unpaid';
          const x = left + nameWidth + geometry.cellWidth * index;
          doc.rect(x, y, geometry.cellWidth, rowHeight).fillAndStroke(colors[status], line);
          const value = contribution ? `${compactMoney(contribution.paidMinor)} / ${compactMoney(contribution.amountMinor)}` : '—';
          doc.font(contribution ? 'Bold' : 'Regular').fontSize(7.5).fillColor(dark).text(value, x + 3, y + 7, { width: geometry.cellWidth - 6, align: 'center', lineBreak: false });
        });
        doc.y = y + rowHeight; doc.x = left;
      }
      doc.moveDown(.6);
    });
    note('Raport nominal destinat verificării interne. Culorile indică situația fiecărei contribuții la momentul emiterii.');
  };

  doc.font('Bold').fontSize(9).fillColor(green).text('CASIERUL CLASEI', { characterSpacing: 1.2 });
  doc.moveDown(.35).font('Bold').fontSize(21).fillColor(dark).text(documentTitle(report), { lineGap: 3 });
  doc.moveDown(.35).font('Regular').fontSize(9).fillColor(muted)
    .text(`${state.settings.schoolName || 'Școala'} · ${state.settings.className || 'Clasa'} · ${state.settings.schoolYear || 'An școlar nespecificat'}`)
    .text(`${report.code} · Situație la ${dateTimeFormat.format(new Date(report.createdAt))} · Revizia registrului ${report.stateRevision}`);
  if (report.replacesCode) doc.moveDown(.35).font('Bold').fillColor('#8a4b08').text(`Raport corectiv: înlocuiește ${report.replacesCode}.`);
  doc.moveDown(.55).fillColor(dark); rule();

  const transactions = activeTransactions(state);
  if (report.type === 'matrix') matrixReport();
  if (report.type === 'class') {
    section('Situația fondului');
    metric('Sold inițial', money(state.settings.openingBalanceMinor));
    metric('Bani primiți și păstrați în fond', money(state.summary.totalReceivedMinor));
    metric('Bani dați mai departe și restituiți', money(state.summary.totalPaidMinor));
    metric('Sold curent', money(state.summary.balanceMinor));
    metric('Din sold: avansuri nealocate', money(state.summary.totalCreditMinor));
    metric('Total de încasat', money(state.summary.totalDueMinor));
    metric('Copii cu cel puțin o restanță', String(state.children.filter(child => child.dueMinor > 0).length));
    note('Reconciliere: sold inițial + bani primiți și păstrați − bani dați mai departe și restituiți = sold curent. Avansurile sunt incluse în soldul curent.');

    section('Cheltuieli');
    for (const expense of state.expenses.filter(entry => !entry.cancelled).reverse()) {
      const due = expenseStatus(state, expense);
      item(expense.title, money(expense.totalMinor),
        `Încasat ${money(expense.collectedMinor)} · Dat mai departe ${money(expense.paidOutMinor)} · Restanțe: ${due.count} copii · ${money(due.amountMinor)}`,
        expense.comment);
    }
    const payments = transactions.filter(tx => tx.type === 'payment');
    section('Bani dați mai departe');
    if (!payments.length) note('Nu ai înregistrat bani dați mai departe.');
    for (const payment of payments) {
      const expense = state.expenses.find(entry => entry.id === payment.expenseId);
      item(payment.destination || 'Plată', money(payment.amountMinor),
        `${dateTimeFormat.format(new Date(payment.occurredAt))}${expense ? ` · ${expense.title}` : ' · Fără cheltuială asociată'}`, payment.comment);
    }
    const corrections = state.transactions.filter(tx => tx.type === 'reversal');
    if (corrections.length) {
      section('Corecții înregistrate');
      for (const correction of corrections) item('Corecție', money(correction.amountMinor), dateTimeFormat.format(new Date(correction.occurredAt)), correction.comment);
    }
  }

  if (report.type === 'expense') {
    const expense = state.expenses.find(entry => entry.id === report.subjectId);
    const due = expenseStatus(state, expense);
    const childContributions = state.children.map(child => child.contributions.find(entry => entry.expenseId === expense.id)).filter(Boolean);
    const fullyPaid = childContributions.filter(entry => entry.remainingMinor === 0).length;
    const partiallyPaid = childContributions.filter(entry => entry.paidMinor > 0 && entry.remainingMinor > 0).length;
    section('Rezumat');
    metric('Necesar total', money(expense.totalMinor));
    metric('Încasat', money(expense.collectedMinor));
    metric('Bani dați mai departe', money(expense.paidOutMinor));
    metric('Participanți', String(expense.contributions.length));
    metric('Contribuții achitate integral', String(fullyPaid));
    metric('Contribuții achitate parțial', String(partiallyPaid));
    metric('Restanțe', `${due.count} copii · ${money(due.amountMinor)}`);
    if (expense.dueDate) metric('Termen', dateFormat.format(new Date(`${expense.dueDate}T12:00:00Z`)));
    if (expense.comment) note(`Comentariu: ${expense.comment}`);
    note('Raportul nu publică numele copiilor cu restanțe.');
    const payments = transactions.filter(tx => tx.type === 'payment' && tx.expenseId === expense.id);
    section('Bani dați mai departe');
    if (!payments.length) note('Nu ai înregistrat bani dați mai departe pentru această cheltuială.');
    for (const payment of payments) item(payment.destination || 'Plată', money(payment.amountMinor), dateTimeFormat.format(new Date(payment.occurredAt)), payment.comment);
  }

  if (report.type === 'child') {
    const child = state.children.find(entry => entry.id === report.subjectId);
    section('Situație curentă');
    metric('Total restant', money(child.dueMinor));
    metric('Avans disponibil', money(child.creditMinor));
    section('Contribuții');
    if (!child.contributions.length) note('Copilul nu are contribuții înregistrate.');
    for (const contribution of child.contributions) item(contribution.title, money(contribution.amountMinor),
      `Achitat ${money(contribution.paidMinor)} · Restant ${money(contribution.remainingMinor)}${contribution.dueDate ? ` · Termen ${dateFormat.format(new Date(`${contribution.dueDate}T12:00:00Z`))}` : ''}`);
    const history = state.transactions.filter(tx => tx.childId === child.id);
    section('Istoric individual');
    if (!history.length) note('Nu există operațiuni pentru acest copil.');
    for (const tx of history) {
      const label = { collection: 'Încasare', credit_apply: 'Avans repartizat', refund: 'Avans restituit', reversal: 'Corecție' }[tx.type] || tx.type;
      const retained = tx.type === 'collection' ? tx.amountMinor - tx.changeMinor : tx.amountMinor;
      const allocationText = tx.allocations.map(allocation => {
        const expense = state.expenses.find(entry => entry.id === allocation.expenseId);
        return `${expense?.title || 'Cheltuială'}: ${money(allocation.amountMinor)}`;
      }).join(' · ');
      item(`${label}${tx.reversed ? ' · corectată' : ''}`, money(retained),
        `${dateTimeFormat.format(new Date(tx.occurredAt))}${tx.changeMinor ? ` · Rest returnat ${money(tx.changeMinor)}` : ''}${allocationText ? ` · ${allocationText}` : ''}`, tx.comment);
    }
  }

  note('Document generat din registrul „Casierul clasei”. Sumele sunt exprimate în lei și reflectă datele existente la momentul emiterii.');
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(index);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Regular').fontSize(7.5).fillColor(muted)
      .text(`${report.code} · pagina ${index + 1}/${pages.count}`, doc.page.margins.left, doc.page.height - 32, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return complete;
}
