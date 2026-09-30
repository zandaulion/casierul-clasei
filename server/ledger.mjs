import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPORT_TYPES, renderReportPdf, reportCode, reportFilename, reportSubject } from './reports.mjs';

const MAX_MONEY = 1_000_000_000_000;
const MAX_CHILDREN = 500;
const MAX_LOGO_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ENTITY = 25;
const MAX_ATTACHMENT_STORAGE_BYTES = 200 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const names = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function object(value, label = 'Datele') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} nu sunt valide.`);
  return value;
}

function text(value, label, max = 200, required = true) {
  if ((value === undefined || value === null) && !required) return '';
  if (typeof value !== 'string') fail(`${label}: introduceți un text valid.`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) {
    fail(`${label}: textul este gol, prea lung sau conține caractere nepermise.`);
  }
  return result;
}

function integer(value, label, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label}: valoarea trebuie să fie un număr întreg între ${min} și ${max}.`);
  }
  return value;
}

function whatsappPhone(value) {
  const raw = text(value, 'Numărul de telefon', 40);
  if (!/^[+\d().\s-]+$/u.test(raw)) fail('Numărul de telefon conține caractere nepermise.');
  let compact = raw.replace(/[().\s-]/gu, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  else if (compact.startsWith('0')) compact = `+40${compact.slice(1)}`;
  else if (!compact.startsWith('+')) compact = `+${compact}`;
  if (!/^\+[1-9]\d{7,14}$/u.test(compact)) fail('Introdu un număr complet, de exemplu 07xx xxx xxx sau +40 7xx xxx xxx.');
  return compact;
}

function revolutLink(value) {
  const raw = text(value, 'Linkul Revolut.me', 240, false);
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`); }
  catch { fail('Linkul Revolut.me nu este valid.'); }
  if (parsed.protocol !== 'https:' || !['revolut.me', 'www.revolut.me'].includes(parsed.hostname.toLowerCase())
    || parsed.port || parsed.username || parsed.password || !parsed.pathname || parsed.pathname === '/') {
    fail('Folosește un link complet de forma https://revolut.me/nume.');
  }
  parsed.hash = '';
  return parsed.toString();
}

function iban(value) {
  const raw = text(value, 'IBAN-ul', 64, false);
  if (!raw) return '';
  const compact = raw.replace(/[\s-]+/gu, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) fail('IBAN-ul nu are un format valid.');
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  if (remainder !== 1) fail('IBAN-ul nu trece verificarea de siguranță. Verifică fiecare caracter.');
  return compact;
}

function withoutPrivateContacts(state) {
  const { contacts: _contacts, ...safeState } = state;
  return safeState;
}

function add(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail('Totalul depășește limita acceptată.', 422);
  return result;
}

function sum(values) { return values.reduce(add, 0); }

function compareTransactionTime(a, b) {
  return a.occurredAt.localeCompare(b.occurredAt)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function dateOnly(value, label = 'Data') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${label} nu este validă.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} nu este validă.`);
  return value;
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (typeof value !== 'string' || value.length > 40) fail('Data și ora nu sunt valide.');
  dateOnly(value.slice(0, 10), 'Data operațiunii');
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) {
    fail('Data și ora trebuie să includă fusul orar.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || /T24:/u.test(value)) fail('Data și ora nu sunt valide.');
  return parsed.toISOString();
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function logo(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) fail(`${label}: folosește o imagine validă.`);
  const encoded = value.slice('data:image/png;base64,'.length);
  if (!encoded || encoded.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    fail(`${label}: imaginea este prea mare sau nu este validă.`);
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_LOGO_BYTES || data.toString('base64') !== encoded
    || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.length < 24) {
    fail(`${label}: imaginea PNG nu este validă.`);
  }
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 1024 || height > 1024) fail(`${label}: dimensiunile maxime sunt 1024 × 1024 px.`);
  return data;
}

function attachmentData(value, mimeType) {
  if (!Buffer.isBuffer(value) || !value.length || value.length > MAX_ATTACHMENT_BYTES) {
    fail(`Documentul trebuie să aibă între 1 octet și ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`, 413);
  }
  if (!ATTACHMENT_TYPES.has(mimeType)) fail('Folosește un fișier PDF, JPG, PNG sau WebP.', 415);
  const valid = mimeType === 'application/pdf' ? value.subarray(0, 5).toString() === '%PDF-'
    : mimeType === 'image/png' ? value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg' ? value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff
        : value.length >= 12 && value.subarray(0, 4).toString() === 'RIFF' && value.subarray(8, 12).toString() === 'WEBP';
  if (!valid) fail('Conținutul documentului nu corespunde tipului de fișier.', 415);
  return value;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  school_name TEXT NOT NULL, class_name TEXT NOT NULL, school_year TEXT NOT NULL,
  opening_balance INTEGER NOT NULL CHECK(opening_balance >= 0),
  payment_revolut_url TEXT NOT NULL DEFAULT '', payment_beneficiary TEXT NOT NULL DEFAULT '',
  payment_iban TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT OR IGNORE INTO metadata (singleton, revision, school_name, class_name, school_year, opening_balance)
  VALUES (1, 0, '', '', '', 0);
CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0, 1)), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS child_contacts (
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position IN (1, 2)),
  label TEXT NOT NULL, phone TEXT NOT NULL,
  PRIMARY KEY (child_id, position), UNIQUE (child_id, phone)
) STRICT;
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('fixed', 'split', 'quantity')),
  amount INTEGER NOT NULL CHECK(amount > 0), total INTEGER NOT NULL CHECK(total > 0),
  occurred_at TEXT NOT NULL, due_date TEXT, comment TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0, 1)),
  cancel_comment TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS contributions (
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  amount INTEGER NOT NULL CHECK(amount >= 0), quantity INTEGER NOT NULL CHECK(quantity > 0),
  PRIMARY KEY (expense_id, child_id)
) STRICT;
CREATE TABLE IF NOT EXISTS contribution_edit_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1)
) STRICT;
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('collection', 'direct_payment', 'payment', 'credit_apply', 'rounding_adjustment', 'refund', 'fund_advance', 'advance_repayment', 'advance_waiver', 'reversal')),
  occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
  child_id TEXT REFERENCES children(id), expense_id TEXT REFERENCES expenses(id),
  destination TEXT NOT NULL, comment TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0), change INTEGER NOT NULL CHECK(change >= 0 AND change <= amount),
  reverses_id TEXT UNIQUE REFERENCES transactions(id), advance_id TEXT REFERENCES transactions(id),
  actor_id TEXT NOT NULL, actor_label TEXT NOT NULL,
  CHECK((type = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK((type IN ('advance_repayment', 'advance_waiver')) = (advance_id IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS allocations (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  expense_id TEXT NOT NULL REFERENCES expenses(id), amount INTEGER NOT NULL CHECK(amount > 0),
  PRIMARY KEY(transaction_id, expense_id)
) STRICT;
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reports (
  serial INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('class', 'expense', 'child', 'matrix')),
  subject_id TEXT,
  subject_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK(state_revision >= 0),
  created_by_label TEXT NOT NULL,
  replaces_id TEXT UNIQUE REFERENCES reports(id),
  replaced_by_id TEXT REFERENCES reports(id),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  pdf BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS branding (
  kind TEXT PRIMARY KEY CHECK(kind IN ('school', 'class')),
  mime_type TEXT NOT NULL CHECK(mime_type = 'image/png'),
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL,
  expense_id TEXT REFERENCES expenses(id), transaction_id TEXT REFERENCES transactions(id),
  filename TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0), sha256 TEXT NOT NULL,
  data BLOB NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('internal', 'class')),
  created_at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_label TEXT NOT NULL,
  CHECK((expense_id IS NOT NULL) <> (transaction_id IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS allocations_expense ON allocations(expense_id);
CREATE INDEX IF NOT EXISTS transactions_child ON transactions(child_id);
CREATE INDEX IF NOT EXISTS child_contacts_child ON child_contacts(child_id);
CREATE INDEX IF NOT EXISTS transactions_expense ON transactions(expense_id);
CREATE INDEX IF NOT EXISTS reports_created ON reports(serial DESC);
CREATE INDEX IF NOT EXISTS attachments_expense ON attachments(expense_id);
CREATE INDEX IF NOT EXISTS attachments_transaction ON attachments(transaction_id);
CREATE TRIGGER IF NOT EXISTS transactions_no_update BEFORE UPDATE ON transactions BEGIN
  SELECT RAISE(ABORT, 'Financial history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS transactions_no_delete BEFORE DELETE ON transactions BEGIN
  SELECT RAISE(ABORT, 'Financial history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS allocations_no_update BEFORE UPDATE ON allocations BEGIN
  SELECT RAISE(ABORT, 'Financial allocations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS allocations_no_delete BEFORE DELETE ON allocations BEGIN
  SELECT RAISE(ABORT, 'Financial allocations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS attachments_no_update BEFORE UPDATE ON attachments BEGIN
  SELECT RAISE(ABORT, 'Attached documents are immutable');
END;
CREATE TRIGGER IF NOT EXISTS attachments_no_delete BEFORE DELETE ON attachments BEGIN
  SELECT RAISE(ABORT, 'Attached documents are immutable');
END;
DROP TRIGGER IF EXISTS contributions_no_update;
DROP TRIGGER IF EXISTS contributions_no_delete;
CREATE TRIGGER contributions_no_update BEFORE UPDATE ON contributions
WHEN NOT EXISTS (SELECT 1 FROM contribution_edit_guard WHERE singleton = 1) BEGIN
  SELECT RAISE(ABORT, 'Confirmed contributions are immutable');
END;
CREATE TRIGGER contributions_no_delete BEFORE DELETE ON contributions
WHEN NOT EXISTS (SELECT 1 FROM contribution_edit_guard WHERE singleton = 1) BEGIN
  SELECT RAISE(ABORT, 'Confirmed contributions are immutable');
END;
`;

function migratePaymentSettings(db) {
  const columns = new Set(db.prepare("PRAGMA table_info('metadata')").all().map(column => column.name));
  if (!columns.has('payment_revolut_url')) db.exec("ALTER TABLE metadata ADD COLUMN payment_revolut_url TEXT NOT NULL DEFAULT ''");
  if (!columns.has('payment_beneficiary')) db.exec("ALTER TABLE metadata ADD COLUMN payment_beneficiary TEXT NOT NULL DEFAULT ''");
  if (!columns.has('payment_iban')) db.exec("ALTER TABLE metadata ADD COLUMN payment_iban TEXT NOT NULL DEFAULT ''");
}

function migrateTransactions(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get();
  if (!table?.sql || (table.sql.includes("'rounding_adjustment'") && table.sql.includes("'advance_waiver'") && table.sql.includes("'direct_payment'"))) return;
  const hasAdvanceId = table.sql.includes('advance_id');
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    db.exec(`DROP TRIGGER IF EXISTS transactions_no_update;
      DROP TRIGGER IF EXISTS transactions_no_delete;
      CREATE TABLE transactions_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('collection', 'direct_payment', 'payment', 'credit_apply', 'rounding_adjustment', 'refund', 'fund_advance', 'advance_repayment', 'advance_waiver', 'reversal')),
        occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
        child_id TEXT REFERENCES children(id), expense_id TEXT REFERENCES expenses(id),
        destination TEXT NOT NULL, comment TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0), change INTEGER NOT NULL CHECK(change >= 0 AND change <= amount),
        reverses_id TEXT UNIQUE REFERENCES transactions_new(id), advance_id TEXT REFERENCES transactions_new(id),
        actor_id TEXT NOT NULL, actor_label TEXT NOT NULL,
        CHECK((type = 'reversal') = (reverses_id IS NOT NULL)),
        CHECK((type IN ('advance_repayment', 'advance_waiver')) = (advance_id IS NOT NULL))
      ) STRICT;
      INSERT INTO transactions_new (id, type, occurred_at, created_at, child_id, expense_id, destination,
        comment, amount, change, reverses_id, advance_id, actor_id, actor_label)
        SELECT id, type, occurred_at, created_at, child_id, expense_id, destination,
          comment, amount, change, reverses_id, ${hasAdvanceId ? 'advance_id' : 'NULL'}, actor_id, actor_label FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_new RENAME TO transactions;
      CREATE INDEX transactions_child ON transactions(child_id);
      CREATE INDEX transactions_expense ON transactions(expense_id);
      CREATE INDEX transactions_advance ON transactions(advance_id);
      CREATE TRIGGER transactions_no_update BEFORE UPDATE ON transactions BEGIN
        SELECT RAISE(ABORT, 'Financial history is immutable');
      END;
      CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions BEGIN
        SELECT RAISE(ABORT, 'Financial history is immutable');
      END;`);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Migrarea operațiunilor a produs referințe invalide.');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Transaction may already be closed. */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateReports(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get();
  if (!table?.sql || table.sql.includes("'matrix'")) return;
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE reports RENAME TO reports_legacy;
      CREATE TABLE reports (
        serial INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('class', 'expense', 'child', 'matrix')),
        subject_id TEXT,
        subject_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state_revision INTEGER NOT NULL CHECK(state_revision >= 0),
        created_by_label TEXT NOT NULL,
        replaces_id TEXT UNIQUE REFERENCES reports(id),
        replaced_by_id TEXT REFERENCES reports(id),
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        pdf BLOB NOT NULL
      ) STRICT;
      INSERT INTO reports SELECT * FROM reports_legacy;
      DROP TABLE reports_legacy;
      CREATE INDEX reports_created ON reports(serial DESC);
      COMMIT;`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Transaction may already be closed. */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Persistent treasury ledger. All public operations are synchronous SQLite transactions. */
export class Ledger {
  #db;

  constructor(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath) throw new TypeError('A database path is required.');
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.#db.exec(SCHEMA);
    migratePaymentSettings(this.#db);
    migrateTransactions(this.#db);
    this.#db.exec('CREATE INDEX IF NOT EXISTS transactions_advance ON transactions(advance_id)');
    migrateReports(this.#db);
  }

  close() { this.#db.close(); }

  #all(sql, ...params) { return this.#db.prepare(sql).all(...params); }
  #one(sql, ...params) { return this.#db.prepare(sql).get(...params); }
  #run(sql, ...params) { return this.#db.prepare(sql).run(...params); }

  getState() {
    this.#db.exec('BEGIN');
    try {
      const state = this.#state();
      this.#db.exec('COMMIT');
      return state;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  exportData() {
    return { format: 'casierul-clasei', version: 1, exportedAt: new Date().toISOString(), state: withoutPrivateContacts(this.getState()) };
  }

  getBrandingImage(kind) {
    if (!['school', 'class'].includes(kind)) fail('Sigla nu este validă.', 404);
    const row = this.#one('SELECT mime_type, data, updated_at FROM branding WHERE kind = ?', kind);
    return row ? { mimeType: row.mime_type, data: Buffer.from(row.data), updatedAt: row.updated_at } : null;
  }

  #attachments() {
    return this.#all(`SELECT id, expense_id, transaction_id, filename, mime_type, size, sha256,
      visibility, created_at, actor_label FROM attachments ORDER BY rowid`).map(row => ({
      id: row.id, entityType: row.expense_id ? 'expense' : 'payment',
      entityId: row.expense_id ?? row.transaction_id, filename: row.filename, mimeType: row.mime_type,
      size: row.size, sha256: row.sha256, visibility: row.visibility,
      createdAt: row.created_at, createdByLabel: row.actor_label,
    }));
  }

  createAttachment(body, actor) {
    object(body);
    const requestId = text(body.requestId, 'Identificatorul cererii', 128);
    const expectedRevision = integer(body.expectedRevision, 'Versiunea datelor', 0, Number.MAX_SAFE_INTEGER);
    if (!['expense', 'payment'].includes(body.entityType)) fail('Tipul înregistrării nu este valid.');
    const entityId = text(body.entityId, 'Înregistrarea', 128);
    const filename = text(body.filename, 'Numele documentului', 240);
    if (/[\\/]/u.test(filename) || filename === '.' || filename === '..') fail('Numele documentului nu este valid.');
    const mimeType = text(body.mimeType, 'Tipul documentului', 100).toLowerCase();
    const data = attachmentData(body.data, mimeType);
    if (!['internal', 'class'].includes(body.visibility)) fail('Vizibilitatea documentului nu este validă.');
    const who = object(actor, 'Dispozitivul');
    const actorId = text(who.id, 'Dispozitivul', 128), actorLabel = text(who.label, 'Numele dispozitivului', 160);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const fingerprint = createHash('sha256').update(canonical({ entityType: body.entityType, entityId,
      filename, mimeType, size: data.length, sha256, visibility: body.visibility })).digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const repeated = this.#one('SELECT id, request_fingerprint FROM attachments WHERE request_id = ?', requestId);
      if (repeated) {
        if (repeated.request_fingerprint !== fingerprint) fail('Identificatorul cererii a fost deja folosit pentru alt document.', 409);
        const state = this.#state();
        this.#db.exec('COMMIT');
        return { state, attachmentId: repeated.id };
      }
      const state = this.#state();
      if (state.revision !== expectedRevision) fail('Datele s-au schimbat pe alt dispozitiv. Reîncărcați și verificați documentul.', 409);
      if (body.entityType === 'expense') {
        if (!state.expenses.some(item => item.id === entityId)) fail('Cheltuiala nu există.', 404);
      } else {
        const transaction = state.transactions.find(item => item.id === entityId);
        if (!transaction || transaction.type !== 'payment') fail('Plata nu există.', 404);
      }
      if (state.attachments.filter(item => item.entityType === body.entityType && item.entityId === entityId).length >= MAX_ATTACHMENTS_PER_ENTITY) {
        fail(`O înregistrare poate avea cel mult ${MAX_ATTACHMENTS_PER_ENTITY} de documente.`, 409);
      }
      const storedBytes = Number(this.#one('SELECT COALESCE(SUM(size), 0) AS total FROM attachments').total);
      if (storedBytes + data.length > MAX_ATTACHMENT_STORAGE_BYTES) fail('Spațiul alocat documentelor clasei este plin.', 413);
      const id = randomUUID(), createdAt = new Date().toISOString();
      this.#run(`INSERT INTO attachments (id, request_id, request_fingerprint, expense_id, transaction_id,
        filename, mime_type, size, sha256, data, visibility, created_at, actor_id, actor_label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, requestId, fingerprint,
      body.entityType === 'expense' ? entityId : null, body.entityType === 'payment' ? entityId : null,
      filename, mimeType, data.length, sha256, data, body.visibility, createdAt, actorId, actorLabel);
      this.#run('UPDATE metadata SET revision = revision + 1 WHERE singleton = 1');
      const next = this.#state();
      this.#db.exec('COMMIT');
      return { state: next, attachmentId: id };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  getAttachment(attachmentId) {
    const id = text(attachmentId, 'Documentul', 128);
    const row = this.#one(`SELECT id, expense_id, transaction_id, filename, mime_type, size, sha256,
      visibility, created_at, actor_label, data FROM attachments WHERE id = ?`, id);
    if (!row) fail('Documentul nu există.', 404);
    return { id: row.id, entityType: row.expense_id ? 'expense' : 'payment', entityId: row.expense_id ?? row.transaction_id,
      filename: row.filename, mimeType: row.mime_type, size: row.size, sha256: row.sha256,
      visibility: row.visibility, createdAt: row.created_at, createdByLabel: row.actor_label, data: Buffer.from(row.data) };
  }

  #reports() {
    return this.#all(`SELECT serial, id, type, subject_id, subject_label, created_at, state_revision,
      created_by_label, replaces_id, replaced_by_id, filename, sha256, length(pdf) AS size
      FROM reports ORDER BY serial DESC`).map(row => ({
      id: row.id, serial: row.serial, code: reportCode(row.serial), type: row.type,
      subjectId: row.subject_id, subjectLabel: row.subject_label, createdAt: row.created_at,
      stateRevision: row.state_revision, createdByLabel: row.created_by_label,
      replacesId: row.replaces_id, replacedById: row.replaced_by_id,
      filename: row.filename, sha256: row.sha256, size: row.size,
    }));
  }

  async createReport(body, actor) {
    object(body);
    const requestId = text(body.requestId, 'Identificatorul cererii', 128);
    const type = text(body.type, 'Tipul raportului', 20);
    if (!REPORT_TYPES.has(type)) fail('Tipul raportului nu este valid.');
    const subjectId = ['class', 'matrix'].includes(type) ? null : text(body.subjectId, 'Subiectul raportului', 128);
    const replacesId = body.replacesId == null || body.replacesId === '' ? null : text(body.replacesId, 'Raportul înlocuit', 128);
    const who = object(actor, 'Dispozitivul');
    const actorLabel = text(who.label, 'Numele dispozitivului', 160);
    const fingerprint = createHash('sha256').update(canonical({ type, subjectId, replacesId })).digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const repeated = this.#one('SELECT id, request_fingerprint FROM reports WHERE request_id = ?', requestId);
      if (repeated) {
        if (repeated.request_fingerprint !== fingerprint) fail('Identificatorul cererii a fost deja folosit pentru alt raport.', 409);
        const report = this.#reports().find(item => item.id === repeated.id);
        this.#db.exec('COMMIT');
        return { report, reports: this.#reports() };
      }
      const stateWithReports = this.#state();
      const { reports: _reports, ...reportState } = stateWithReports;
      const state = withoutPrivateContacts(reportState);
      const subject = reportSubject(state, type, subjectId);
      let replaced = null;
      if (replacesId) {
        replaced = this.#one('SELECT * FROM reports WHERE id = ?', replacesId);
        if (!replaced) fail('Raportul care trebuie înlocuit nu există.', 404);
        if (replaced.replaced_by_id) fail('Raportul a fost deja înlocuit.', 409);
        if (replaced.type !== type || (replaced.subject_id ?? null) !== subject.id) fail('Raportul corectiv trebuie să aibă același tip și subiect.', 409);
      }
      const serial = Number(this.#one('SELECT COALESCE(MAX(serial), 0) + 1 AS value FROM reports').value);
      const id = randomUUID(), createdAt = new Date().toISOString();
      const report = { id, serial, code: reportCode(serial), type, subjectId: subject.id, subjectLabel: subject.label,
        createdAt, stateRevision: state.revision, createdByLabel: actorLabel,
        replacesId: replaced?.id ?? null, replacesCode: replaced ? reportCode(replaced.serial) : null };
      const branding = Object.fromEntries(['school', 'class'].map((kind) => {
        const image = this.getBrandingImage(kind);
        return [kind, image?.data ?? null];
      }));
      const pdf = await renderReportPdf(report, state, branding);
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const filename = reportFilename(report);
      this.#run(`INSERT INTO reports (serial, id, request_id, request_fingerprint, type, subject_id, subject_label,
        created_at, state_revision, created_by_label, replaces_id, replaced_by_id, filename, sha256, snapshot, pdf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      serial, id, requestId, fingerprint, type, subject.id, subject.label, createdAt, state.revision,
      actorLabel, replaced?.id ?? null, filename, sha256, JSON.stringify(state), pdf);
      if (replaced) this.#run('UPDATE reports SET replaced_by_id = ? WHERE id = ?', id, replaced.id);
      const saved = this.#reports().find(item => item.id === id);
      const reports = this.#reports();
      this.#db.exec('COMMIT');
      return { report: saved, reports };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  getReportPdf(reportId) {
    const id = text(reportId, 'Raportul', 128);
    const row = this.#one('SELECT filename, pdf FROM reports WHERE id = ?', id);
    if (!row) fail('Raportul nu există.', 404);
    return { filename: row.filename, pdf: Buffer.from(row.pdf) };
  }

  #state() {
    const meta = this.#one('SELECT * FROM metadata WHERE singleton = 1');
    const childRows = this.#all('SELECT * FROM children');
    const contacts = this.#all('SELECT child_id, position, label, phone FROM child_contacts ORDER BY child_id, position').map(row => ({
      childId: row.child_id, position: row.position, label: row.label, phone: row.phone,
    }));
    const expenseRows = this.#all('SELECT * FROM expenses ORDER BY rowid DESC');
    const contributionRows = this.#all('SELECT * FROM contributions ORDER BY child_id');
    const transactionRows = this.#all('SELECT * FROM transactions ORDER BY rowid');
    const allocationRows = this.#all('SELECT * FROM allocations ORDER BY expense_id');
    const reversed = new Set(transactionRows.map(row => row.reverses_id).filter(Boolean));
    const allocationsByTransaction = new Map();
    for (const row of allocationRows) {
      if (!allocationsByTransaction.has(row.transaction_id)) allocationsByTransaction.set(row.transaction_id, []);
      allocationsByTransaction.get(row.transaction_id).push({ expenseId: row.expense_id, amountMinor: row.amount });
    }
    const childCredit = new Map(childRows.map(row => [row.id, 0]));
    const contributionPaid = new Map();
    const contributionDirect = new Map();
    const contributionAdjusted = new Map();
    const contributionCovered = new Map();
    const expenseCollected = new Map();
    const expenseDirect = new Map();
    const expenseAdjusted = new Map();
    const expenseCovered = new Map();
    const expensePaid = new Map();
    const advanceRepaid = new Map();
    const advanceWaived = new Map();
    let totalReceivedMinor = 0;
    let totalDirectMinor = 0;
    let totalPaidMinor = 0;
    let totalAdvancedMinor = 0;
    let totalAdvanceRepaidMinor = 0;
    const bump = (map, key, amount) => map.set(key, add(map.get(key) ?? 0, amount));
    const transactions = transactionRows.map(row => ({
      id: row.id, type: row.type, occurredAt: row.occurred_at, createdAt: row.created_at,
      childId: row.child_id, expenseId: row.expense_id, destination: row.destination,
      comment: row.comment, amountMinor: row.amount, changeMinor: row.change,
      advanceId: row.advance_id,
      allocations: allocationsByTransaction.get(row.id) ?? [],
      reversed: reversed.has(row.id), reversesId: row.reverses_id, actorLabel: row.actor_label,
    }));
    for (const tx of transactions) {
      if (tx.type === 'reversal' || tx.reversed) continue;
      if (tx.type === 'collection') {
        const retained = tx.amountMinor - tx.changeMinor;
        totalReceivedMinor = add(totalReceivedMinor, retained);
        bump(childCredit, tx.childId, retained - sum(tx.allocations.map(a => a.amountMinor)));
      } else if (tx.type === 'direct_payment') {
        totalDirectMinor = add(totalDirectMinor, tx.amountMinor);
      } else if (tx.type === 'credit_apply') {
        bump(childCredit, tx.childId, -tx.amountMinor);
      } else if (tx.type === 'rounding_adjustment') {
        // This closes a deliberately waived remainder without moving cash.
      } else if (tx.type === 'refund') {
        bump(childCredit, tx.childId, -tx.amountMinor);
        totalPaidMinor = add(totalPaidMinor, tx.amountMinor);
      } else if (tx.type === 'payment') {
        totalPaidMinor = add(totalPaidMinor, tx.amountMinor);
        if (tx.expenseId) bump(expensePaid, tx.expenseId, tx.amountMinor);
      } else if (tx.type === 'fund_advance') {
        totalAdvancedMinor = add(totalAdvancedMinor, tx.amountMinor);
      } else if (tx.type === 'advance_repayment') {
        totalAdvanceRepaidMinor = add(totalAdvanceRepaidMinor, tx.amountMinor);
        totalPaidMinor = add(totalPaidMinor, tx.amountMinor);
        bump(advanceRepaid, tx.advanceId, tx.amountMinor);
      } else if (tx.type === 'advance_waiver') {
        bump(advanceWaived, tx.advanceId, tx.amountMinor);
      }
      if (tx.type === 'collection' || tx.type === 'direct_payment' || tx.type === 'credit_apply' || tx.type === 'rounding_adjustment' || tx.type === 'advance_waiver') {
        for (const allocation of tx.allocations) {
          const key = `${tx.childId}:${allocation.expenseId}`;
          if (tx.type === 'rounding_adjustment') {
            bump(contributionAdjusted, key, allocation.amountMinor);
            bump(expenseAdjusted, allocation.expenseId, allocation.amountMinor);
          } else if (tx.type === 'direct_payment') {
            bump(contributionDirect, key, allocation.amountMinor);
            bump(expenseDirect, allocation.expenseId, allocation.amountMinor);
          } else if (tx.type === 'advance_waiver') {
            bump(contributionCovered, key, allocation.amountMinor);
            bump(expenseCovered, allocation.expenseId, allocation.amountMinor);
          } else {
            bump(contributionPaid, key, allocation.amountMinor);
            bump(expenseCollected, allocation.expenseId, allocation.amountMinor);
          }
        }
      }
    }
    const activeTransactions = transactions.filter(tx => tx.type !== 'reversal' && !tx.reversed);
    const latestExpensePayment = new Map();
    for (const tx of activeTransactions) {
      if (tx.type !== 'payment' || !tx.expenseId) continue;
      const previous = latestExpensePayment.get(tx.expenseId);
      if (!previous || compareTransactionTime(tx, previous) > 0) latestExpensePayment.set(tx.expenseId, tx);
    }
    const collectedAfterPayment = new Map();
    const directAfterPayment = new Map();
    for (const tx of activeTransactions) {
      if (!['collection', 'direct_payment'].includes(tx.type)) continue;
      for (const allocation of tx.allocations) {
        const latestPayment = latestExpensePayment.get(allocation.expenseId);
        if (!latestPayment || compareTransactionTime(tx, latestPayment) <= 0) continue;
        bump(tx.type === 'collection' ? collectedAfterPayment : directAfterPayment, allocation.expenseId, allocation.amountMinor);
      }
    }
    const expenses = expenseRows.map(row => ({
      id: row.id, title: row.title, type: row.type, amountMinor: row.amount, totalMinor: row.total,
      collectedMinor: expenseCollected.get(row.id) ?? 0, adjustedMinor: expenseAdjusted.get(row.id) ?? 0,
      directMinor: expenseDirect.get(row.id) ?? 0, coveredMinor: expenseCovered.get(row.id) ?? 0,
      paidOutMinor: expensePaid.get(row.id) ?? 0,
      latestPayment: latestExpensePayment.has(row.id) ? {
        id: latestExpensePayment.get(row.id).id, amountMinor: latestExpensePayment.get(row.id).amountMinor,
        destination: latestExpensePayment.get(row.id).destination, occurredAt: latestExpensePayment.get(row.id).occurredAt,
      } : null,
      collectedAfterLatestPaymentMinor: collectedAfterPayment.get(row.id) ?? 0,
      directAfterLatestPaymentMinor: directAfterPayment.get(row.id) ?? 0,
      occurredAt: row.occurred_at, dueDate: row.due_date, comment: row.comment,
      cancelled: Boolean(row.cancelled),
      contributions: contributionRows.filter(c => c.expense_id === row.id).map(c => ({
        childId: c.child_id, amountMinor: c.amount, quantity: c.quantity,
      })),
    }));
    const expensesById = new Map(expenses.map(expense => [expense.id, expense]));
    const children = childRows.map(row => {
      const contributions = contributionRows.filter(c => c.child_id === row.id && !expensesById.get(c.expense_id).cancelled).map(c => {
        const expense = expensesById.get(c.expense_id);
        const paidMinor = contributionPaid.get(`${row.id}:${c.expense_id}`) ?? 0;
        const directMinor = contributionDirect.get(`${row.id}:${c.expense_id}`) ?? 0;
        const adjustedMinor = contributionAdjusted.get(`${row.id}:${c.expense_id}`) ?? 0;
        const coveredMinor = contributionCovered.get(`${row.id}:${c.expense_id}`) ?? 0;
        return { expenseId: c.expense_id, title: expense.title, dueDate: expense.dueDate,
          amountMinor: c.amount, paidMinor, directMinor, adjustedMinor, coveredMinor,
          remainingMinor: c.amount - paidMinor - directMinor - adjustedMinor - coveredMinor };
      }).sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || names.compare(a.title, b.title) || a.expenseId.localeCompare(b.expenseId));
      return { id: row.id, firstName: row.first_name, lastName: row.last_name, active: Boolean(row.active),
        creditMinor: childCredit.get(row.id), dueMinor: sum(contributions.map(c => c.remainingMinor)), contributions };
    }).sort((a, b) => names.compare(a.lastName, b.lastName) || names.compare(a.firstName, b.firstName) || a.id.localeCompare(b.id));
    for (const expense of expenses) {
      expense.dueMinor = sum(children.map(child => child.contributions.find(contribution => contribution.expenseId === expense.id)?.remainingMinor ?? 0));
    }
    const advances = transactions.filter(tx => tx.type === 'fund_advance').map(tx => {
      const repaidMinor = advanceRepaid.get(tx.id) ?? 0;
      const waivedMinor = advanceWaived.get(tx.id) ?? 0;
      return { id: tx.id, person: tx.destination, expenseId: tx.expenseId, occurredAt: tx.occurredAt,
        createdAt: tx.createdAt, comment: tx.comment, amountMinor: tx.amountMinor, repaidMinor, waivedMinor,
        outstandingMinor: tx.reversed ? 0 : tx.amountMinor - repaidMinor - waivedMinor, reversed: tx.reversed };
    });
    const totalAdvanceOutstandingMinor = sum(advances.map(item => item.outstandingMinor));
    const balanceMinor = add(meta.opening_balance, totalReceivedMinor + totalAdvancedMinor - totalPaidMinor);
    const branding = new Map(this.#all('SELECT kind, updated_at FROM branding').map(row => [row.kind, row.updated_at]));
    return {
      revision: meta.revision,
      settings: { schoolName: meta.school_name, className: meta.class_name, schoolYear: meta.school_year,
        openingBalanceMinor: meta.opening_balance, paymentRevolutUrl: meta.payment_revolut_url,
        paymentBeneficiary: meta.payment_beneficiary, paymentIban: meta.payment_iban,
        hasSchoolLogo: branding.has('school'), hasClassLogo: branding.has('class'),
        schoolLogoVersion: branding.get('school') ?? null, classLogoVersion: branding.get('class') ?? null },
      children, contacts, expenses, advances, attachments: this.#attachments(), transactions: transactions.reverse(),
      summary: { balanceMinor, netBalanceMinor: balanceMinor - totalAdvanceOutstandingMinor,
        totalReceivedMinor, totalDirectMinor, totalPaidMinor, totalCreditMinor: sum(children.map(child => child.creditMinor)),
        totalDueMinor: sum(children.map(child => child.dueMinor)),
        totalAdjustedMinor: sum(expenses.map(expense => expense.adjustedMinor)),
        totalCoveredMinor: sum(expenses.map(expense => expense.coveredMinor)), totalAdvancedMinor,
        totalAdvanceRepaidMinor, totalAdvanceOutstandingMinor },
      reports: this.#reports(),
    };
  }

  dispatch(operation, body, actor) {
    object(body);
    let serialized;
    try { serialized = JSON.stringify(body); } catch { fail('Datele cererii nu sunt valide.'); }
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) fail('Cererea este prea mare.', 413);
    const requestId = text(body.requestId, 'Identificatorul cererii', 128);
    const expectedRevision = integer(body.expectedRevision, 'Versiunea datelor', 0, Number.MAX_SAFE_INTEGER);
    const fingerprint = createHash('sha256').update(canonical({ operation, body })).digest('hex');
    const who = object(actor, 'Dispozitivul');
    const actorRecord = { id: text(who.id, 'Dispozitivul', 128), label: text(who.label, 'Numele dispozitivului', 160) };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#one('SELECT fingerprint, response FROM requests WHERE id = ?', requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('Identificatorul cererii a fost deja folosit pentru alte date.', 409);
        const { transactionId } = JSON.parse(previous.response);
        const current = this.#state();
        const response = transactionId ? { state: current, transactionId } : { state: current };
        this.#db.exec('COMMIT');
        return response;
      }
      const state = this.#state();
      if (state.revision !== expectedRevision) fail('Datele s-au schimbat pe alt dispozitiv. Reîncărcați și verificați operațiunea.', 409);
      const transactionId = this.#mutate(operation, body, actorRecord, state);
      this.#run('UPDATE metadata SET revision = revision + 1 WHERE singleton = 1');
      const next = this.#state();
      if (next.children.some(child => child.creditMinor < 0)) fail('Corecția ar consuma un avans deja folosit. Corectați mai întâi utilizările sau restituirile acelui avans.', 409);
      if (next.children.some(child => child.contributions.some(c => c.remainingMinor < 0))) fail('Operațiunea ar depăși contribuția stabilită.', 409);
      if (next.advances.some(item => item.outstandingMinor < 0)) fail('Restituirea depășește suma avansată rămasă.', 409);
      const response = transactionId ? { state: next, transactionId } : { state: next };
      // Keep the result identity, not a snapshot of the ever-growing history.
      // A network retry receives current state while preserving the original transaction.
      this.#run('INSERT INTO requests (id, fingerprint, response, created_at) VALUES (?, ?, ?, ?)', requestId, fingerprint, JSON.stringify(transactionId ? { transactionId } : {}), new Date().toISOString());
      this.#db.exec('COMMIT');
      return response;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #child(state, childId) {
    const id = text(childId, 'Copilul', 128);
    const child = state.children.find(c => c.id === id);
    if (!child) fail('Copilul nu există.', 404);
    return child;
  }

  #expense(state, expenseId) {
    const id = text(expenseId, 'Cheltuiala', 128);
    const expense = state.expenses.find(e => e.id === id);
    if (!expense) fail('Cheltuiala nu există.', 404);
    if (expense.cancelled) fail('Cheltuiala este anulată.', 409);
    return expense;
  }

  #allocations(state, child, raw, required = false) {
    if (!Array.isArray(raw) || raw.length > 500 || (required && !raw.length)) fail('Selectați contribuțiile care se achită.');
    const seen = new Set();
    return raw.map(item => {
      object(item, 'Alocarea');
      const expense = this.#expense(state, item.expenseId);
      if (seen.has(expense.id)) fail('O cheltuială apare de mai multe ori în alocare.');
      seen.add(expense.id);
      const contribution = child.contributions.find(c => c.expenseId === expense.id);
      if (!contribution) fail('Copilul nu participă la această cheltuială.');
      const amountMinor = integer(item.amountMinor, 'Suma alocată', 1);
      if (amountMinor > contribution.remainingMinor) fail('Suma alocată depășește contribuția rămasă.');
      return { expenseId: expense.id, amountMinor };
    });
  }

  #transaction(type, body, actor, values = {}) {
    const id = randomUUID();
    const record = { childId: null, expenseId: null, destination: '', comment: text(body.comment, 'Comentariul', 2000, false),
      amountMinor: 0, changeMinor: 0, reversesId: null, advanceId: null, allocations: [], ...values };
    this.#run(`INSERT INTO transactions (id, type, occurred_at, created_at, child_id, expense_id,
      destination, comment, amount, change, reverses_id, advance_id, actor_id, actor_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, type, timestamp(body.occurredAt), new Date().toISOString(), record.childId, record.expenseId,
    record.destination, record.comment, record.amountMinor, record.changeMinor, record.reversesId, record.advanceId, actor.id, actor.label);
    for (const allocation of record.allocations) {
      this.#run('INSERT INTO allocations (transaction_id, expense_id, amount) VALUES (?, ?, ?)', id, allocation.expenseId, allocation.amountMinor);
    }
    return id;
  }

  #mutate(operation, body, actor, state) {
    if (operation === 'settings.update') {
      const old = state.settings;
      const schoolName = body.schoolName === undefined ? old.schoolName : text(body.schoolName, 'Școala', 160, false);
      const className = body.className === undefined ? old.className : text(body.className, 'Clasa', 80, false);
      const schoolYear = body.schoolYear === undefined ? old.schoolYear : text(body.schoolYear, 'Anul școlar', 40, false);
      const opening = body.openingBalanceMinor === undefined ? old.openingBalanceMinor : integer(body.openingBalanceMinor, 'Soldul inițial');
      const paymentRevolutUrl = body.paymentRevolutUrl === undefined ? old.paymentRevolutUrl : revolutLink(body.paymentRevolutUrl);
      const paymentBeneficiary = body.paymentBeneficiary === undefined ? old.paymentBeneficiary : text(body.paymentBeneficiary, 'Numele beneficiarului', 160, false);
      const paymentIban = body.paymentIban === undefined ? old.paymentIban : iban(body.paymentIban);
      if (state.transactions.length && opening !== old.openingBalanceMinor) fail('Soldul inițial nu se mai poate modifica după prima operațiune financiară.', 409);
      this.#run(`UPDATE metadata SET school_name = ?, class_name = ?, school_year = ?, opening_balance = ?,
        payment_revolut_url = ?, payment_beneficiary = ?, payment_iban = ? WHERE singleton = 1`,
      schoolName, className, schoolYear, opening, paymentRevolutUrl, paymentBeneficiary, paymentIban);
      for (const [field, kind, label] of [['schoolLogo', 'school', 'Sigla școlii'], ['classLogo', 'class', 'Sigla clasei']]) {
        if (!Object.hasOwn(body, field)) continue;
        const data = logo(body[field], label);
        if (data === null) this.#run('DELETE FROM branding WHERE kind = ?', kind);
        else this.#run(`INSERT INTO branding (kind, mime_type, data, updated_at) VALUES (?, 'image/png', ?, ?)
          ON CONFLICT(kind) DO UPDATE SET mime_type = excluded.mime_type, data = excluded.data, updated_at = excluded.updated_at`,
        kind, data, new Date().toISOString());
      }
      return;
    }
    if (operation === 'child.create' || operation === 'children.create') {
      const items = operation === 'child.create' ? [body] : body.children;
      if (!Array.isArray(items) || !items.length || items.length > MAX_CHILDREN || state.children.length + items.length > MAX_CHILDREN) {
        fail(`Clasa poate avea cel mult ${MAX_CHILDREN} de copii. Adăugați cel puțin un copil.`);
      }
      for (const item of items) {
        object(item, 'Copilul');
        this.#run('INSERT INTO children (id, first_name, last_name, active, created_at) VALUES (?, ?, ?, 1, ?)',
          randomUUID(), text(item.firstName, 'Prenumele', 80), text(item.lastName, 'Numele', 80), new Date().toISOString());
      }
      return;
    }
    if (operation === 'child.update') {
      const child = this.#child(state, body.childId);
      const firstName = body.firstName === undefined ? child.firstName : text(body.firstName, 'Prenumele', 80);
      const lastName = body.lastName === undefined ? child.lastName : text(body.lastName, 'Numele', 80);
      if (body.active !== undefined && typeof body.active !== 'boolean') fail('Starea copilului nu este validă.');
      this.#run('UPDATE children SET first_name = ?, last_name = ?, active = ? WHERE id = ?', firstName, lastName, Number(body.active ?? child.active), child.id);
      return;
    }
    if (operation === 'child.contacts.update') {
      const child = this.#child(state, body.childId);
      if (!Array.isArray(body.contacts) || body.contacts.length > 2) fail('Poți salva cel mult două contacte pentru un copil.');
      const seen = new Set();
      const contacts = body.contacts.map((item, index) => {
        object(item, 'Contactul');
        const phone = whatsappPhone(item.phone);
        if (seen.has(phone)) fail('Același număr de telefon apare de mai multe ori.');
        seen.add(phone);
        return { position: index + 1, label: text(item.label, 'Numele contactului', 80), phone };
      });
      this.#run('DELETE FROM child_contacts WHERE child_id = ?', child.id);
      for (const contact of contacts) {
        this.#run('INSERT INTO child_contacts (child_id, position, label, phone) VALUES (?, ?, ?, ?)',
          child.id, contact.position, contact.label, contact.phone);
      }
      return;
    }
    if (operation === 'expense.create') {
      const title = text(body.title, 'Denumirea cheltuielii');
      if (!['fixed', 'split', 'quantity'].includes(body.type)) fail('Tipul cheltuielii nu este valid.');
      const amount = integer(body.amountMinor, 'Valoarea cheltuielii', 1);
      if (!Array.isArray(body.participants) || !body.participants.length || body.participants.length > MAX_CHILDREN) fail('Selectați cel puțin un participant.');
      const seen = new Set();
      const participants = body.participants.map(item => {
        object(item, 'Participantul');
        const child = this.#child(state, item.childId);
        if (!child.active) fail('Un copil arhivat nu poate fi inclus într-o cheltuială nouă.');
        if (seen.has(child.id)) fail('Un copil apare de mai multe ori în lista participanților.');
        seen.add(child.id);
        const quantity = body.type === 'quantity' ? integer(item.quantity ?? 1, 'Cantitatea', 1, 10_000) : 1;
        return { childId: child.id, quantity };
      }).sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
      const contributions = participants.map((participant, index) => ({ ...participant,
        amount: body.type === 'split' ? Math.floor(amount / participants.length) + Number(index < amount % participants.length) : amount * participant.quantity }));
      const total = integer(sum(contributions.map(c => c.amount)), 'Totalul cheltuielii', 1);
      const id = randomUUID();
      const dueDate = body.dueDate === undefined || body.dueDate === null || body.dueDate === '' ? null : dateOnly(body.dueDate, 'Termenul');
      this.#run('INSERT INTO expenses (id, title, type, amount, total, occurred_at, due_date, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, title, body.type, amount, total, timestamp(body.occurredAt), dueDate, text(body.comment, 'Comentariul', 2000, false));
      for (const contribution of contributions) this.#run('INSERT INTO contributions (expense_id, child_id, amount, quantity) VALUES (?, ?, ?, ?)', id, contribution.childId, contribution.amount, contribution.quantity);
      return;
    }
    if (operation === 'expense.update') {
      const expense = this.#expense(state, body.expenseId);
      const title = text(body.title, 'Denumirea cheltuielii');
      if (!['fixed', 'split', 'quantity'].includes(body.type)) fail('Tipul cheltuielii nu este valid.');
      const amount = integer(body.amountMinor, 'Valoarea cheltuielii', 1);
      if (!Array.isArray(body.participants) || !body.participants.length || body.participants.length > MAX_CHILDREN) fail('Selectați cel puțin un participant.');
      const existing = new Set(expense.contributions.map(item => item.childId));
      const seen = new Set();
      const participants = body.participants.map(item => {
        object(item, 'Participantul');
        const child = this.#child(state, item.childId);
        if (!child.active && !existing.has(child.id)) fail('Un copil arhivat nu poate fi adăugat la o cheltuială.');
        if (seen.has(child.id)) fail('Un copil apare de mai multe ori în lista participanților.');
        seen.add(child.id);
        const quantity = body.type === 'quantity' ? integer(item.quantity ?? 1, 'Cantitatea', 1, 10_000) : 1;
        return { childId: child.id, quantity };
      }).sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0);
      const contributions = participants.map((participant, index) => ({ ...participant,
        amount: body.type === 'split' ? Math.floor(amount / participants.length) + Number(index < amount % participants.length) : amount * participant.quantity }));
      const total = integer(sum(contributions.map(c => c.amount)), 'Totalul cheltuielii', 1);
      const formulaChanged = expense.type !== body.type || expense.amountMinor !== amount
        || expense.contributions.length !== contributions.length
        || contributions.some(next => {
          const old = expense.contributions.find(item => item.childId === next.childId);
          return !old || old.quantity !== next.quantity || old.amountMinor !== next.amount;
        });
      const hasActiveLinks = state.transactions.some(tx => !tx.reversed && tx.type !== 'reversal'
        && (tx.expenseId === expense.id || tx.allocations.some(allocation => allocation.expenseId === expense.id)));
      const safeContributionCorrection = body.type === expense.type
        && expense.amountMinor === amount
        && (body.type === 'split' ? expense.collectedMinor === 0 && expense.directMinor === 0 && expense.adjustedMinor === 0 && expense.coveredMinor === 0
          : ['fixed', 'quantity'].includes(body.type)
          && contributions.every(next => {
            const child = state.children.find(item => item.id === next.childId);
            const previous = child?.contributions.find(item => item.expenseId === expense.id);
            const settled = (previous?.paidMinor ?? 0) + (previous?.directMinor ?? 0) + (previous?.adjustedMinor ?? 0) + (previous?.coveredMinor ?? 0);
            return next.amount >= settled;
          })
          && expense.contributions.filter(old => !contributions.some(next => next.childId === old.childId)).every(old => {
            const child = state.children.find(item => item.id === old.childId);
            const previous = child?.contributions.find(item => item.expenseId === expense.id);
            return (previous?.paidMinor ?? 0) + (previous?.directMinor ?? 0) + (previous?.adjustedMinor ?? 0) + (previous?.coveredMinor ?? 0) === 0;
          }))
        && total >= expense.paidOutMinor;
      if (formulaChanged && hasActiveLinks && !safeContributionCorrection) {
        if (body.type === 'split' && expense.type === 'split' && expense.collectedMinor + expense.directMinor > 0) {
          fail('Participanții unei cheltuieli împărțite nu mai pot fi schimbați după prima contribuție încasată.', 409);
        }
        fail('După încasări sau plăți, puteți adăuga participanți, elimina doar participanții fără sume achitate și corecta cantitățile fără a coborî contribuția sub suma deja achitată.', 409);
      }
      const dueDate = body.dueDate === undefined || body.dueDate === null || body.dueDate === '' ? null : dateOnly(body.dueDate, 'Termenul');
      this.#run(`UPDATE expenses SET title = ?, type = ?, amount = ?, total = ?, occurred_at = ?, due_date = ?, comment = ?
        WHERE id = ?`, title, body.type, amount, total, timestamp(body.occurredAt), dueDate,
      text(body.comment, 'Comentariul', 2000, false), expense.id);
      if (formulaChanged) {
        this.#run('INSERT INTO contribution_edit_guard (singleton) VALUES (1)');
        this.#run('DELETE FROM contributions WHERE expense_id = ?', expense.id);
        for (const contribution of contributions) this.#run('INSERT INTO contributions (expense_id, child_id, amount, quantity) VALUES (?, ?, ?, ?)',
          expense.id, contribution.childId, contribution.amount, contribution.quantity);
        this.#run('DELETE FROM contribution_edit_guard WHERE singleton = 1');
      }
      return;
    }
    if (operation === 'expense.cancel') {
      const expense = this.#expense(state, body.expenseId);
      if (state.transactions.some(tx => !tx.reversed && tx.type !== 'reversal' && (tx.expenseId === expense.id || tx.allocations.some(a => a.expenseId === expense.id)))) {
        fail('Corectați mai întâi încasările, avansurile utilizate și plățile legate de această cheltuială.', 409);
      }
      this.#run('UPDATE expenses SET cancelled = 1, cancel_comment = ? WHERE id = ?', text(body.comment, 'Motivul anulării', 2000, false), expense.id);
      return;
    }
    if (operation === 'collection.create') {
      const child = this.#child(state, body.childId);
      const receivedMinor = integer(body.receivedMinor, 'Suma primită', 1);
      const changeMinor = integer(body.changeMinor, 'Restul dat');
      if (changeMinor >= receivedMinor) fail('Suma păstrată trebuie să fie mai mare decât zero.');
      const allocations = this.#allocations(state, child, body.allocations);
      if (sum(allocations.map(a => a.amountMinor)) > receivedMinor - changeMinor) fail('Sumele alocate depășesc suma păstrată după rest.');
      let settlement = null;
      if (body.settlement !== undefined && body.settlement !== null) {
        const raw = object(body.settlement, 'Închiderea diferenței');
        if (!['credit', 'rounding'].includes(raw.type)) fail('Metoda de închidere a diferenței nu este validă.');
        const settlementAllocations = this.#allocations(state, child, raw.allocations, true);
        const collectedByExpense = new Map(allocations.map(item => [item.expenseId, item.amountMinor]));
        for (const allocation of settlementAllocations) {
          const contribution = child.contributions.find(item => item.expenseId === allocation.expenseId);
          const remainingAfterCash = contribution.remainingMinor - (collectedByExpense.get(allocation.expenseId) ?? 0);
          if (allocation.amountMinor > remainingAfterCash) fail('Suma acoperită depășește contribuția rămasă după încasare.');
          if (raw.type === 'rounding' && allocation.amountMinor !== remainingAfterCash) fail('Ajustarea de rotunjire trebuie să închidă exact contribuția rămasă.');
        }
        const amountMinor = sum(settlementAllocations.map(item => item.amountMinor));
        if (raw.type === 'rounding' && amountMinor > 100) fail('Doar diferențele de cel mult 1 leu pot fi închise prin rotunjire la încasare.');
        if (raw.type === 'credit' && amountMinor > child.creditMinor) fail('Avansul disponibil nu acoperă diferența.');
        settlement = { type: raw.type, amountMinor, allocations: settlementAllocations };
      }
      const transactionId = this.#transaction('collection', body, actor, { childId: child.id, amountMinor: receivedMinor, changeMinor, allocations });
      if (settlement) this.#transaction(settlement.type === 'credit' ? 'credit_apply' : 'rounding_adjustment', body, actor,
        { childId: child.id, amountMinor: settlement.amountMinor, allocations: settlement.allocations });
      return transactionId;
    }
    if (operation === 'credit.apply') {
      const child = this.#child(state, body.childId);
      const allocations = this.#allocations(state, child, body.allocations, true);
      const amountMinor = sum(allocations.map(a => a.amountMinor));
      if (amountMinor > child.creditMinor) fail('Avansul disponibil nu acoperă sumele selectate.');
      return this.#transaction('credit_apply', body, actor, { childId: child.id, amountMinor, allocations });
    }
    if (operation === 'rounding_adjustment.create') {
      const child = this.#child(state, body.childId);
      const expense = this.#expense(state, body.expenseId);
      const contribution = child.contributions.find(item => item.expenseId === expense.id);
      if (!contribution) fail('Copilul nu are o contribuție la această cheltuială.', 404);
      if (contribution.remainingMinor <= 0) fail('Contribuția este deja închisă.', 409);
      if (contribution.paidMinor <= 0) fail('Ajustarea de rotunjire este disponibilă numai după o încasare parțială.', 409);
      if (contribution.remainingMinor > 100) fail('Doar diferențele de cel mult 1 leu pot fi închise prin ajustare de rotunjire.');
      const amountMinor = contribution.remainingMinor;
      return this.#transaction('rounding_adjustment', body, actor, {
        childId: child.id, amountMinor, allocations: [{ expenseId: expense.id, amountMinor }],
      });
    }
    if (operation === 'direct_payment.create') {
      const child = this.#child(state, body.childId);
      const expense = this.#expense(state, body.expenseId);
      const contribution = child.contributions.find(item => item.expenseId === expense.id);
      if (!contribution) fail('Copilul nu participă la această cheltuială.');
      const amountMinor = integer(body.amountMinor, 'Suma plătită direct', 1);
      if (amountMinor > contribution.remainingMinor) fail('Suma plătită direct depășește contribuția rămasă de achitat.');
      const destination = text(body.destination, 'Beneficiarul');
      return this.#transaction('direct_payment', body, actor, { childId: child.id, expenseId: expense.id,
        amountMinor, destination, allocations: [{ expenseId: expense.id, amountMinor }] });
    }
    if (operation === 'refund.create') {
      const child = this.#child(state, body.childId);
      const amountMinor = integer(body.amountMinor, 'Suma restituită', 1);
      if (amountMinor > child.creditMinor) fail('Suma restituită depășește avansul disponibil.');
      return this.#transaction('refund', body, actor, { childId: child.id, amountMinor });
    }
    if (operation === 'payment.create') {
      const amountMinor = integer(body.amountMinor, 'Suma plătită', 1);
      const destination = text(body.destination, 'Destinația plății');
      const expenseId = body.expenseId === undefined || body.expenseId === null || body.expenseId === '' ? null : this.#expense(state, body.expenseId).id;
      return this.#transaction('payment', body, actor, { amountMinor, destination, expenseId });
    }
    if (operation === 'fund_advance.create') {
      const amountMinor = integer(body.amountMinor, 'Suma avansată', 1);
      const destination = text(body.person, 'Persoana care a avansat banii');
      const expenseId = body.expenseId === undefined || body.expenseId === null || body.expenseId === '' ? null : this.#expense(state, body.expenseId).id;
      return this.#transaction('fund_advance', body, actor, { amountMinor, destination, expenseId });
    }
    if (operation === 'fund_advance.repay') {
      const advanceId = text(body.advanceId, 'Suma avansată', 128);
      const advance = state.advances.find(item => item.id === advanceId && !item.reversed);
      if (!advance) fail('Suma avansată nu există sau a fost corectată.', 404);
      const amountMinor = integer(body.amountMinor, 'Suma restituită', 1);
      if (amountMinor > advance.outstandingMinor) fail('Suma restituită depășește suma rămasă de restituit.');
      return this.#transaction('advance_repayment', body, actor, { amountMinor, destination: advance.person,
        advanceId: advance.id, expenseId: advance.expenseId });
    }
    if (operation === 'fund_advance.waive') {
      const advanceId = text(body.advanceId, 'Suma avansată', 128);
      const advance = state.advances.find(item => item.id === advanceId && !item.reversed);
      if (!advance) fail('Suma avansată nu există sau a fost corectată.', 404);
      const child = this.#child(state, body.childId);
      const expense = this.#expense(state, body.expenseId);
      if (advance.expenseId && advance.expenseId !== expense.id) {
        fail('Suma avansată este asociată altei cheltuieli.', 409);
      }
      const contribution = child.contributions.find(item => item.expenseId === expense.id);
      if (!contribution) fail('Copilul nu participă la această cheltuială.');
      const amountMinor = integer(body.amountMinor, 'Suma acoperită', 1);
      if (amountMinor > advance.outstandingMinor) fail('Suma depășește avansul rămas de restituit.');
      if (amountMinor > contribution.remainingMinor) fail('Suma depășește contribuția rămasă de achitat.');
      return this.#transaction('advance_waiver', body, actor, { childId: child.id, expenseId: expense.id,
        amountMinor, destination: advance.person, advanceId: advance.id,
        allocations: [{ expenseId: expense.id, amountMinor }] });
    }
    if (operation === 'transaction.reverse') {
      const transactionId = text(body.transactionId, 'Operațiunea', 128);
      const original = state.transactions.find(tx => tx.id === transactionId);
      if (!original) fail('Operațiunea nu există.', 404);
      if (original.type === 'reversal') fail('O corecție nu poate fi anulată. Înregistrați o operațiune nouă.', 409);
      if (original.reversed) fail('Operațiunea a fost deja corectată.', 409);
      if (original.type === 'fund_advance') {
        const advance = state.advances.find(item => item.id === original.id);
        if (advance?.repaidMinor || advance?.waivedMinor) {
          fail('Corectați mai întâi restituirile și acoperirile legate de această sumă avansată.', 409);
        }
      }
      const comment = text(body.comment, 'Motivul corecției', 2000);
      return this.#transaction('reversal', { comment }, actor, { childId: original.childId, expenseId: original.expenseId,
        destination: original.destination, amountMinor: original.amountMinor, changeMinor: original.changeMinor,
        reversesId: original.id, allocations: original.allocations });
    }
    fail('Operațiunea nu există.', 404);
  }
}
