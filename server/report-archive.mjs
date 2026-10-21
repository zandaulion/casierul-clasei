import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const REPORT_PDF_HOT_LIMIT = 10;
export const ARCHIVED_REPORT_PLACEHOLDER = Buffer.from('CASIERUL_REPORT_ARCHIVE_V1\n');

function validSha256(sha256) {
  if (!/^[a-f0-9]{64}$/u.test(sha256 || '')) throw new Error('Amprenta PDF-ului arhivat nu este validă.');
  return sha256;
}

export function reportArchiveDirectory(databasePath) {
  const absolute = path.resolve(databasePath);
  return path.join(path.dirname(absolute), 'report-archive', path.basename(absolute, '.sqlite'));
}

export function reportArchivePath(databasePath, sha256) {
  return path.join(reportArchiveDirectory(databasePath), `${validSha256(sha256)}.pdf`);
}

function verifiedPdf(data, sha256, expectedSize) {
  if (!Buffer.isBuffer(data) || data.length !== expectedSize || data.subarray(0, 5).toString() !== '%PDF-'
    || createHash('sha256').update(data).digest('hex') !== validSha256(sha256)) {
    throw new Error('PDF-ul arhivat nu corespunde amprentei din registru.');
  }
  return data;
}

export function readArchivedReport(databasePath, sha256, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('Dimensiunea PDF-ului arhivat nu este validă.');
  let data;
  try { data = fs.readFileSync(reportArchivePath(databasePath, sha256)); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('PDF-ul arhivat lipsește din directorul privat de date.');
    throw error;
  }
  return verifiedPdf(data, sha256, expectedSize);
}

export function storeArchivedReport(databasePath, sha256, pdf) {
  verifiedPdf(pdf, sha256, pdf.length);
  const directory = reportArchiveDirectory(databasePath);
  const destination = reportArchivePath(databasePath, sha256);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(directory), 0o700);
  fs.chmodSync(directory, 0o700);
  if (fs.existsSync(destination)) {
    readArchivedReport(databasePath, sha256, pdf.length);
    return destination;
  }
  const temporary = path.join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, pdf);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    const directoryDescriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  readArchivedReport(databasePath, sha256, pdf.length);
  return destination;
}
