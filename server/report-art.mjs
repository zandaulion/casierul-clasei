// Small vector stationery drawings keep reports sharp and light when printed.
export function drawReportNotebook(doc, x, y, size = 58) {
  doc.save().translate(x, y).scale(size / 64);
  doc.circle(33, 33, 27).fill('#fff0bf');
  doc.save().rotate(-8, { origin: [28, 35] });
  doc.roundedRect(10, 14, 34, 43, 4).fillAndStroke('#fffdf6', '#3c6954');
  doc.lineWidth(1).moveTo(18, 15).lineTo(18, 56).stroke('#dba99b');
  for (const lineY of [28, 35, 42, 49]) doc.moveTo(22, lineY).lineTo(38, lineY).stroke('#bdcfd1');
  for (const ringY of [23, 34, 45]) doc.lineWidth(1.7).moveTo(7, ringY).lineTo(13, ringY).stroke('#3c6954');
  doc.restore();
  doc.save().rotate(22, { origin: [48, 43] });
  doc.roundedRect(45, 26, 6, 27, 1).fill('#e7ac51');
  doc.rect(45, 24, 6, 6).fill('#dc9484');
  doc.moveTo(45, 53).lineTo(48, 60).lineTo(51, 53).closePath().fill('#ead4ac');
  doc.moveTo(46.7, 57).lineTo(48, 60).lineTo(49.3, 57).closePath().fill('#3c6954');
  doc.restore();
  drawReportPlane(doc, 40, 1, 24);
  doc.restore();
}

export function drawReportPlane(doc, x, y, size = 26) {
  doc.save().translate(x, y).scale(size / 30).lineJoin('round').lineWidth(1);
  doc.moveTo(1, 12).lineTo(29, 2).lineTo(20, 27).lineTo(13, 18).lineTo(1, 12).closePath().fillAndStroke('#dcecf1', '#477987');
  doc.moveTo(13, 18).lineTo(29, 2).lineTo(9, 15).stroke('#477987');
  doc.restore();
}
