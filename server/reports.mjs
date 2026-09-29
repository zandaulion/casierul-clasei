import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawReportNotebook, drawReportPlane } from './report-art.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGULAR = path.resolve(HERE, '../assets/fonts/DejaVuSans.ttf');
const BOLD = path.resolve(HERE, '../assets/fonts/DejaVuSans-Bold.ttf');
const locale = 'ro-RO';
const zone = 'Europe/Bucharest';
const moneyFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: zone });
const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
const compactMoneyFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const coverageFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

export const REPORT_TYPES = new Set(['class', 'expense', 'child', 'matrix']);
export const reportCode = serial => `R-${String(serial).padStart(4, '0')}`;
const money = minor => `${moneyFormat.format(minor / 100)} lei`;
const personName = child => `${child.lastName} ${child.firstName}`;
const activeTransactions = state => state.transactions.filter(tx => tx.type !== 'reversal' && !tx.reversed);
const sum = values => values.reduce((total, value) => total + value, 0);
const sharedAttachments = (state, entityType, entityId) => (state.attachments || [])
  .filter(item => item.visibility === 'class' && item.entityType === entityType && item.entityId === entityId);

function expenseCoverage(expense) {
  if (expense.totalMinor <= 0) return { ratio: 0, label: 'Fără sumă de acoperit', shortLabel: '—' };
  const collected = Math.max(0, Math.min(expense.totalMinor, expense.collectedMinor));
  const ratio = collected / expense.totalMinor;
  // Keep 100% reserved for a fully covered expense, even with just one ban due.
  const percent = Number(BigInt(collected) * 1000n / BigInt(expense.totalMinor)) / 10;
  const label = ratio > 0 && percent === 0 ? '<0,1%' : `${coverageFormat.format(percent)}%`;
  return { ratio, label, shortLabel: label };
}

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
  if (report.type === 'matrix') return 'Tabelul contribuțiilor';
  if (report.type === 'expense') return `Situația cheltuielii „${report.subjectLabel}”`;
  return `Fișa copilului — ${report.subjectLabel}`;
}

export async function renderReportPdf(report, state, branding = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: report.type === 'matrix' ? 'landscape' : 'portrait', margins: { top: 46, right: 42, bottom: 58, left: 42 }, bufferPages: true,
    info: { Title: `${report.code} · ${documentTitle(report)}`, Author: 'Casierul clasei', CreationDate: new Date(report.createdAt) } });
  doc.registerFont('Regular', REGULAR).registerFont('Bold', BOLD);
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const green = '#23634d', dark = '#243c32', muted = '#59665f', line = '#dce3dd';
  const paper = {
    class: { fill: '#edf4e9', ink: '#356048', tab: '#c4ddba' },
    matrix: { fill: '#eaf3f8', ink: '#3a6378', tab: '#bedae7' },
    expense: { fill: '#fff0e6', ink: '#85513b', tab: '#edc1a7' },
    child: { fill: '#efebf7', ink: '#63517d', tab: '#d5c8e6' },
  }[report.type];
  const tones = {
    positive: { ink: '#17623b', fill: '#e3f3e8' },
    warning: { ink: '#8a5a00', fill: '#fff1c7' },
    negative: { ink: '#9b2c25', fill: '#f9dfdc' },
    info: { ink: '#245c7a', fill: '#e2f0f7' },
    correction: { ink: '#8a4b08', fill: '#f8e7d2' },
  };

  const ensure = height => { if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
  const rule = () => { doc.moveDown(.3).strokeColor(line).lineWidth(.7).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().moveDown(.5); };
  const section = title => {
    ensure(76); const y = doc.y + 7, left = doc.page.margins.left;
    doc.roundedRect(left, y + 1, 6, 16, 2).fill(paper.tab);
    doc.font('Bold').fontSize(12).fillColor(dark).text(title, left + 15, y, { width: width - 15 });
    doc.x = left; rule();
  };
  const note = text => {
    doc.font('Regular').fontSize(8.5);
    ensure(doc.heightOfString(text, { width, lineGap: 2 }) + 8);
    doc.fillColor(muted).text(text, doc.page.margins.left, doc.y, { width, lineGap: 2 }); doc.moveDown(.4);
  };
  const metric = (label, value, tone = null) => {
    const color = tones[tone];
    const inset = color ? 10 : 0, labelWidth = width * .58 - inset - 8;
    doc.font('Regular').fontSize(9.5);
    const labelHeight = doc.heightOfString(label, { width: labelWidth });
    doc.font('Bold').fontSize(10);
    const valueHeight = doc.heightOfString(value, { width: width * .40 });
    const height = Math.max(24, labelHeight + 9, valueHeight + 9);
    ensure(height); const y = doc.y;
    if (color) {
      doc.roundedRect(doc.page.margins.left, y - 3, width, height - 3, 5).fill(color.fill);
      doc.roundedRect(doc.page.margins.left, y - 3, 3, height - 3, 1).fill(color.ink);
    }
    doc.font('Regular').fontSize(9.5).fillColor(color?.ink || muted).text(label, doc.page.margins.left + inset, y, { width: labelWidth });
    doc.font('Bold').fontSize(10).fillColor(color?.ink || dark).text(value, doc.page.margins.left + width * .58, y, { width: width * .40, align: 'right' });
    doc.y = y + height; doc.x = doc.page.margins.left;
  };
  const coverageHeight = 33;
  const coverage = (expense, left = doc.page.margins.left, availableWidth = width) => {
    ensure(coverageHeight); const y = doc.y;
    const { ratio, label } = expenseCoverage(expense);
    doc.font('Regular').fontSize(8).fillColor(muted).text('Acoperire din contribuții', left, y, { width: availableWidth * .55 });
    doc.font('Bold').fontSize(8.5).fillColor(ratio === 1 ? green : dark).text(label, left + availableWidth * .55, y,
      { width: availableWidth * .45, align: 'right' });
    drawCoverageBar(left, y + 15, availableWidth, 6, ratio);
    doc.y = y + coverageHeight; doc.x = doc.page.margins.left;
  };
  const drawCoverageBar = (left, top, barWidth, height, ratio) => {
    doc.save();
    doc.roundedRect(left, top, barWidth, height, height / 2).fill('#e7ece5');
    if (ratio > 0) {
      doc.roundedRect(left, top, barWidth, height, height / 2).clip();
      doc.rect(left, top, barWidth * ratio, height).fill(ratio === 1 ? green : '#bd8a32');
    }
    doc.restore();
  };
  const item = (title, amount, details, comment = '', tone = null, expense = null) => {
    const color = tones[tone];
    const inset = color ? 9 : 0;
    const titleWidth = width * .72 - inset - 8, textWidth = width - inset;
    doc.font('Bold').fontSize(10);
    const titleHeight = Math.max(doc.heightOfString(title, { width: titleWidth }), doc.heightOfString(amount, { width: width * .28 }));
    doc.font('Regular').fontSize(8.5);
    const detailsHeight = doc.heightOfString(details, { width: textWidth, lineGap: 2 });
    const commentHeight = comment ? doc.heightOfString(comment, { width: textWidth, lineGap: 2 }) : 0;
    // Keep ordinary entries together; very long comments may flow over a page.
    const progressHeight = expense ? coverageHeight : 0;
    ensure(Math.min(titleHeight + progressHeight + detailsHeight + commentHeight + 19, doc.page.height - doc.page.margins.top - doc.page.margins.bottom));
    const y = doc.y;
    if (color) doc.roundedRect(doc.page.margins.left, y, 3, Math.min(titleHeight + progressHeight + detailsHeight, doc.page.height - y - doc.page.margins.bottom), 1).fill(color.ink);
    doc.font('Bold').fontSize(10).fillColor(color?.ink || dark).text(title, doc.page.margins.left + inset, y, { width: titleWidth });
    doc.font('Bold').fontSize(10).fillColor(color?.ink || dark).text(amount, doc.page.margins.left + width * .72, y, { width: width * .28, align: 'right' });
    doc.y = y + titleHeight + 3;
    if (expense) coverage(expense, doc.page.margins.left + inset, textWidth);
    doc.font('Regular').fontSize(8.5).fillColor(muted).text(details, doc.page.margins.left + inset, doc.y, { width: textWidth, lineGap: 2 });
    if (comment) doc.font('Regular').fontSize(8.5).fillColor(dark).text(comment, doc.page.margins.left + inset, doc.y, { width: textWidth, lineGap: 2 });
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
    const rowHeight = 23, headerHeight = 68;
    const closingNote = `Raport nominal pentru verificare internă, generat din registrul „Casierul clasei”. Sumele sunt în lei. Culorile și procentele reflectă situația la emitere; barele arată contribuțiile încasate / necesarul cheltuielii.${expenses.some(expense => expense.totalMinor === 0) ? ' „—” în antet: fără sumă de acoperit.' : ''}`;
    doc.font('Regular').fontSize(8.5);
    const closingHeight = doc.heightOfString(closingNote, { width, lineGap: 2 }) + 16;
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
      doc.font('Bold').fontSize(10).fillColor(dark).text(`${continued ? 'Tabelul contribuțiilor · ' : ''}Cheltuieli ${groupIndex * columnsPerGroup + 1}–${Math.min(expenses.length, (groupIndex + 1) * columnsPerGroup)} din ${expenses.length}`, left, doc.y, { width });
      doc.moveDown(.3); legend();
    };
    const tableHeader = group => {
      const cellWidth = Math.min(118, (width - nameWidth) / group.length), tableWidth = nameWidth + cellWidth * group.length;
      let x = left, y = doc.y;
      doc.rect(x, y, nameWidth, headerHeight).fillAndStroke(paper.fill, line);
      doc.font('Bold').fontSize(8).fillColor(dark).text('Copil', x + 5, y + 18, { width: nameWidth - 10, ellipsis: true, lineBreak: false });
      doc.font('Regular').fontSize(7).fillColor(muted).text('Acoperire din contribuții', x + 5, y + 48, { width: nameWidth - 10 });
      x += nameWidth;
      for (const expense of group) {
        doc.rect(x, y, cellWidth, headerHeight).fillAndStroke(paper.fill, line);
        doc.font('Bold').fontSize(7.2).fillColor(dark).text(expense.title, x + 4, y + 6, { width: cellWidth - 8, height: 36, align: 'center', ellipsis: true });
        const { ratio, shortLabel } = expenseCoverage(expense);
        doc.font('Bold').fontSize(7.5).fillColor(ratio === 1 ? green : dark).text(shortLabel, x + 4, y + 47, { width: cellWidth - 8, align: 'center' });
        drawCoverageBar(x + 10, y + 60, cellWidth - 20, 5, ratio);
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
      for (const [childIndex, child] of children.entries()) {
        const isLastRow = groupIndex === groups.length - 1 && childIndex === children.length - 1;
        // Keep the explanation with the final row instead of creating a note-only page.
        if (doc.y + rowHeight + (isLastRow ? closingHeight : 0) > doc.page.height - doc.page.margins.bottom - 4) geometry = newMatrixPage(group, groupIndex);
        const y = doc.y;
        doc.rect(left, y, nameWidth, rowHeight).fillAndStroke('#fffdf7', line);
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
    note(closingNote);
  };

  const headerY = doc.y, logoSize = 42, centerInset = logoSize + 14;
  if (branding.school) doc.image(branding.school, doc.page.margins.left, headerY, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
  if (branding.class) doc.image(branding.class, doc.page.width - doc.page.margins.right - logoSize, headerY, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
  doc.font('Bold').fontSize(9).fillColor(green).text('CASIERUL CLASEI', doc.page.margins.left + centerInset, headerY + 5,
    { width: width - centerInset * 2, align: 'center', characterSpacing: 1.2 });
  doc.font('Regular').fontSize(9).fillColor(muted)
    .text(`${state.settings.schoolName || 'Școala'} · ${state.settings.className || 'Clasa'}`, doc.page.margins.left + centerInset, headerY + 23,
      { width: width - centerInset * 2, align: 'center' })
    .text(state.settings.schoolYear || 'An școlar nespecificat', { width: width - centerInset * 2, align: 'center' });
  const titleY = Math.max(headerY + logoSize, doc.y) + 16;
  const titleWidth = width - 104;
  doc.font('Bold').fontSize(19);
  const titleHeight = doc.heightOfString(documentTitle(report), { width: titleWidth, lineGap: 2 });
  const panelHeight = Math.max(76, titleHeight + 40);
  doc.roundedRect(doc.page.margins.left, titleY, width, panelHeight, 10).fill(paper.fill);
  // A little strip of paper tape and a notebook sit clear of all report data.
  doc.save().translate(doc.page.margins.left + 22, titleY - 4).rotate(-4)
    .roundedRect(0, 0, 37, 9, 1).fill('#f4dda7').restore();
  drawReportNotebook(doc, doc.page.width - doc.page.margins.right - 72, titleY + (panelHeight - 58) / 2);
  doc.font('Bold').fontSize(7).fillColor(paper.ink).text('DIN CAIETUL CLASEI', doc.page.margins.left + 16, titleY + 13,
    { width: titleWidth, characterSpacing: 1.1 });
  doc.font('Bold').fontSize(19).fillColor(dark).text(documentTitle(report), doc.page.margins.left + 16, titleY + 29,
    { width: titleWidth, lineGap: 2 });
  doc.y = titleY + panelHeight + 11; doc.x = doc.page.margins.left;
  doc.font('Regular').fontSize(8).fillColor(muted)
    .text(`${report.code} · Situație la ${dateTimeFormat.format(new Date(report.createdAt))} · Revizia registrului ${report.stateRevision}`, { width });
  if (report.replacesCode) doc.moveDown(.35).font('Bold').fillColor('#8a4b08').text(`Raport corectiv: înlocuiește ${report.replacesCode}.`);
  doc.moveDown(.7).fillColor(dark);

  const transactions = activeTransactions(state);
  if (report.type === 'matrix') matrixReport();
  if (report.type === 'class') {
    section('Situația fondului');
    metric('Sold inițial', money(state.settings.openingBalanceMinor));
    metric('Bani primiți și păstrați în fond', money(state.summary.totalReceivedMinor));
    metric('Sume avansate temporar fondului', money(state.summary.totalAdvancedMinor ?? 0));
    metric('Bani dați mai departe și restituiți', money(state.summary.totalPaidMinor));
    metric('Numerar disponibil în fond', money(state.summary.balanceMinor), 'info');
    metric('De restituit pentru sume avansate', money(state.summary.totalAdvanceOutstandingMinor ?? 0),
      state.summary.totalAdvanceOutstandingMinor ? 'warning' : 'positive');
    metric('Sold după restituirea sumelor avansate', money(state.summary.netBalanceMinor ?? state.summary.balanceMinor),
      (state.summary.netBalanceMinor ?? state.summary.balanceMinor) < 0 ? 'negative' : 'info');
    metric('Din sold: avansuri nealocate', money(state.summary.totalCreditMinor));
    metric('Total de încasat', money(state.summary.totalDueMinor), state.summary.totalDueMinor ? 'negative' : 'positive');
    metric('Copii cu sume de achitat', String(state.children.filter(child => child.dueMinor > 0).length), state.summary.totalDueMinor ? 'negative' : 'positive');
    note('Reconciliere: sold inițial + bani primiți de la copii + sume avansate temporar − bani dați și restituiți = numerar disponibil. Sumele avansate rămase apar separat ca datorie a clasei.');

    const advances = (state.advances || []).filter(entry => !entry.reversed);
    section('Sume avansate fondului');
    if (!advances.length) note('Nu există sume avansate temporar fondului.');
    for (const advance of advances) {
      const expense = state.expenses.find(entry => entry.id === advance.expenseId);
      item(advance.person, money(advance.amountMinor),
        `${dateTimeFormat.format(new Date(advance.occurredAt))} · Restituit ${money(advance.repaidMinor)} · De restituit ${money(advance.outstandingMinor)}${expense ? ` · ${expense.title}` : ''}`,
        advance.comment, advance.outstandingMinor ? 'warning' : 'positive');
    }

    section('Cheltuieli');
    for (const expense of state.expenses.filter(entry => !entry.cancelled).reverse()) {
      const due = expenseStatus(state, expense);
      const tone = due.amountMinor === 0 ? 'positive' : expense.collectedMinor > 0 ? 'warning' : 'negative';
      item(expense.title, money(expense.totalMinor),
        `Încasat ${money(expense.collectedMinor)} · Dat mai departe ${money(expense.paidOutMinor)} · De achitat: ${due.count} copii · ${money(due.amountMinor)} · Documente partajate: ${sharedAttachments(state, 'expense', expense.id).length}`,
        expense.comment, tone, expense);
    }
    const payments = transactions.filter(tx => tx.type === 'payment');
    section('Bani dați mai departe');
    if (!payments.length) note('Nu ai înregistrat bani dați mai departe.');
    for (const payment of payments) {
      const expense = state.expenses.find(entry => entry.id === payment.expenseId);
      item(payment.destination || 'Plată', money(payment.amountMinor),
        `${dateTimeFormat.format(new Date(payment.occurredAt))}${expense ? ` · ${expense.title}` : ' · Fără cheltuială asociată'} · Documente partajate: ${sharedAttachments(state, 'payment', payment.id).length}`, payment.comment, 'info');
    }
    const corrections = state.transactions.filter(tx => tx.type === 'reversal');
    if (corrections.length) {
      section('Corecții înregistrate');
      for (const correction of corrections) item('Corecție', money(correction.amountMinor), dateTimeFormat.format(new Date(correction.occurredAt)), correction.comment, 'correction');
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
    metric('Încasat', money(expense.collectedMinor), expense.collectedMinor >= expense.totalMinor ? 'positive' : expense.collectedMinor ? 'warning' : 'negative');
    coverage(expense);
    metric('Bani dați mai departe', money(expense.paidOutMinor), expense.paidOutMinor ? 'info' : null);
    const relatedAdvances = (state.advances || []).filter(entry => !entry.reversed && entry.expenseId === expense.id);
    metric('Sume avansate temporar pentru cheltuială', money(sum(relatedAdvances.map(entry => entry.amountMinor))), relatedAdvances.length ? 'warning' : null);
    metric('Participanți', String(expense.contributions.length));
    metric('Contribuții achitate integral', String(fullyPaid), 'positive');
    metric('Contribuții achitate parțial', String(partiallyPaid), partiallyPaid ? 'warning' : null);
    metric('De achitat', `${due.count} copii · ${money(due.amountMinor)}`, due.amountMinor ? 'negative' : 'positive');
    if (expense.dueDate) metric('Termen', dateFormat.format(new Date(`${expense.dueDate}T12:00:00Z`)));
    if (expense.comment) note(`Comentariu: ${expense.comment}`);
    note('Raportul nu publică numele copiilor cu sume de achitat.');
    const payments = transactions.filter(tx => tx.type === 'payment' && tx.expenseId === expense.id);
    section('Bani dați mai departe');
    if (!payments.length) note('Nu ai înregistrat bani dați mai departe pentru această cheltuială.');
    for (const payment of payments) item(payment.destination || 'Plată', money(payment.amountMinor), dateTimeFormat.format(new Date(payment.occurredAt)), payment.comment, 'info');
    const documents = [...sharedAttachments(state, 'expense', expense.id),
      ...payments.flatMap(payment => sharedAttachments(state, 'payment', payment.id))];
    section('Documente justificative partajate');
    if (!documents.length) note('Nu există documente justificative vizibile părinților pentru această cheltuială.');
    for (const document of documents) item(document.filename, `${Math.max(1, Math.round(document.size / 1024))} KB`,
      `${dateTimeFormat.format(new Date(document.createdAt))} · SHA-256 ${document.sha256}`, '', 'info');
    if (relatedAdvances.length) {
      section('Finanțare temporară');
      for (const advance of relatedAdvances) item(advance.person, money(advance.amountMinor),
        `${dateTimeFormat.format(new Date(advance.occurredAt))} · Restituit ${money(advance.repaidMinor)} · De restituit ${money(advance.outstandingMinor)}`,
        advance.comment, advance.outstandingMinor ? 'warning' : 'positive');
    }
  }

  if (report.type === 'child') {
    const child = state.children.find(entry => entry.id === report.subjectId);
    section('Situație curentă');
    metric('Total de achitat', money(child.dueMinor), child.dueMinor ? 'negative' : 'positive');
    metric('Avans disponibil', money(child.creditMinor), child.creditMinor ? 'info' : null);
    section('Contribuții');
    if (!child.contributions.length) note('Copilul nu are contribuții înregistrate.');
    for (const contribution of child.contributions) item(contribution.title, money(contribution.amountMinor),
      `Achitat ${money(contribution.paidMinor)} · De achitat ${money(contribution.remainingMinor)}${contribution.dueDate ? ` · Termen ${dateFormat.format(new Date(`${contribution.dueDate}T12:00:00Z`))}` : ''}`, '',
      contribution.remainingMinor === 0 ? 'positive' : contribution.paidMinor ? 'warning' : 'negative');
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
        `${dateTimeFormat.format(new Date(tx.occurredAt))}${tx.changeMinor ? ` · Rest returnat ${money(tx.changeMinor)}` : ''}${allocationText ? ` · ${allocationText}` : ''}`, tx.comment,
        tx.reversed || tx.type === 'reversal' ? 'correction' : tx.type === 'collection' ? 'positive' : tx.type === 'credit_apply' ? 'info' : 'warning');
    }
  }

  if (report.type !== 'matrix') note('Document generat din registrul „Casierul clasei”. Sumele sunt exprimate în lei și reflectă datele existente la momentul emiterii.');
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(index);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (index > 0) {
      doc.font('Bold').fontSize(7).fillColor(green).text('CASIERUL CLASEI', doc.page.margins.left, 24, { width: width / 2, lineBreak: false, characterSpacing: .8 });
      doc.font('Regular').fontSize(7).fillColor(muted).text(report.code, doc.page.margins.left + width / 2, 24, { width: width / 2, align: 'right', lineBreak: false, characterSpacing: 0 });
    }
    const footerY = doc.page.height - 34;
    doc.strokeColor(line).lineWidth(.6).moveTo(doc.page.margins.left, footerY - 10).lineTo(doc.page.width - doc.page.margins.right, footerY - 10).stroke();
    doc.strokeColor(paper.tab).lineWidth(2).moveTo(doc.page.margins.left, footerY - 10).lineTo(doc.page.margins.left + 32, footerY - 10).stroke();
    drawReportPlane(doc, doc.page.margins.left, footerY - 3, 15);
    doc.font('Regular').fontSize(7.5).fillColor(muted)
      .text('Cu grijă pentru clasa noastră.', doc.page.margins.left + 22, footerY, { width: width / 2 - 22, lineBreak: false });
    doc.font('Regular').fontSize(7.5).fillColor(muted)
      .text(`${report.code} · pagina ${index + 1}/${pages.count}`, doc.page.margins.left + width / 2, footerY, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return complete;
}
