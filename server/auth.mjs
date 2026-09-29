import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = '__Host-casierul';
export const DEVELOPMENT_COOKIE_NAME = 'casierul-dev';
export const SESSION_SECONDS = 400 * 86400;
export const INVITE_TTL_DAYS = 7;
export const INVITE_MAX_USES = 2;
export const DEFAULT_CLASSROOM_ID = 'default';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEVICE_ROLES = new Set(['treasurer', 'parent', 'auditor']);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function validLabel(value, fallback = 'Telefon') {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f]/u.test(value)) {
    throw httpError(400, 'Eticheta dispozitivului nu este validă.');
  }
  return value.trim() || fallback;
}

export function adminTokenMatches(supplied, expected) {
  if (typeof expected !== 'string' || !expected.trim() || typeof supplied !== 'string') return false;
  // Hash both sides so timingSafeEqual always compares fixed-length buffers.
  return timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(expected), 'hex'));
}

export function sessionCookie(token, secure = true) {
  return `${secure ? COOKIE_NAME : DEVELOPMENT_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure = true) {
  return `${secure ? COOKIE_NAME : DEVELOPMENT_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readSessionCookie(header, secure = true) {
  if (typeof header !== 'string') return null;
  const name = secure ? COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export class AuthStore {
  constructor(dbPath, { publicBaseUrl = '', now = Date.now } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/u, '');
    this.now = now;
    this.failures = [];
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        code TEXT,
        url TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1)),
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS classrooms (
        id TEXT PRIMARY KEY,
        ledger_file TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        request_id TEXT UNIQUE,
        request_fingerprint TEXT,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
      );
      INSERT OR IGNORE INTO classrooms (id, ledger_file, created_at, request_id, archived)
        VALUES ('${DEFAULT_CLASSROOM_ID}', 'ledger.sqlite', '1970-01-01T00:00:00.000Z', NULL, 0);
    `);
    const ownerAdded = this.#addColumn('devices', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
    this.#addColumn('devices', 'role', "TEXT NOT NULL DEFAULT 'treasurer'");
    this.#addColumn('devices', 'child_id', 'TEXT');
    this.#addColumn('devices', 'access_expires_at', 'TEXT');
    this.#addColumn('invites', 'role', "TEXT NOT NULL DEFAULT 'treasurer'");
    this.#addColumn('invites', 'child_id', 'TEXT');
    this.#addColumn('invites', 'access_expires_at', 'TEXT');
    this.#addColumn('invites', 'classroom_id', `TEXT NOT NULL DEFAULT '${DEFAULT_CLASSROOM_ID}'`);
    // Preserve consumed legacy codes as closed; unused codes gain the second slot.
    // Keep the schema change and backfill atomic across restarts.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.#addColumn('invites', 'max_uses', `INTEGER NOT NULL DEFAULT ${INVITE_MAX_USES} CHECK(max_uses BETWEEN 1 AND ${INVITE_MAX_USES})`);
      const countAdded = this.#addColumn('invites', 'use_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(use_count BETWEEN 0 AND max_uses)');
      if (countAdded) this.db.exec('UPDATE invites SET max_uses = 1, use_count = 1 WHERE used_at IS NOT NULL');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_permissions (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('treasurer', 'parent', 'auditor')),
        child_id TEXT,
        access_expires_at TEXT,
        PRIMARY KEY (device_id, classroom_id),
        CHECK((role = 'parent') = (child_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS permissions_classroom ON device_permissions(classroom_id);
      UPDATE invites SET classroom_id = '${DEFAULT_CLASSROOM_ID}' WHERE classroom_id IS NULL OR classroom_id = '';
      INSERT OR IGNORE INTO device_permissions (device_id, classroom_id, role, child_id, access_expires_at)
        SELECT id, '${DEFAULT_CLASSROOM_ID}', role, child_id, access_expires_at FROM devices;
    `);
    if (ownerAdded) this.db.exec("UPDATE devices SET is_owner = 1 WHERE role = 'treasurer'");
  }

  #addColumn(table, column, definition) {
    if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  }

  createInvite(label, { role = 'treasurer', childId = null, accessExpiresAt = null, classroomId = DEFAULT_CLASSROOM_ID } = {}) {
    label = validLabel(label, '');
    if (!DEVICE_ROLES.has(role)) throw httpError(400, 'Tipul de acces nu este valid.');
    if (role === 'parent' && (typeof childId !== 'string' || !childId)) throw httpError(400, 'Alege copilul pentru accesul părintelui.');
    if (role !== 'parent' && childId != null) throw httpError(400, 'Copilul poate fi ales doar pentru accesul unui părinte.');
    if (accessExpiresAt != null && (typeof accessExpiresAt !== 'string' || Number.isNaN(Date.parse(accessExpiresAt)))) {
      throw httpError(400, 'Data expirării accesului nu este validă.');
    }
    if (typeof classroomId !== 'string' || !this.db.prepare('SELECT 1 FROM classrooms WHERE id = ? AND archived = 0').get(classroomId)) {
      throw httpError(400, 'Clasa selectată nu este validă.');
    }
    const raw = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const code = raw.match(/.{4}/gu).join('-');
    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/?invite=${encodeURIComponent(code)}` : null;
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + INVITE_TTL_DAYS * 86400000).toISOString();
    const result = this.db.prepare(`INSERT INTO invites
      (code_hash, code, url, label, created_at, expires_at, role, child_id, access_expires_at, classroom_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash(raw), code, url, label || null, createdAt, expiresAt,
      role, childId, accessExpiresAt, classroomId);
    return { id: Number(result.lastInsertRowid), code, url, expires_at: expiresAt, expires_in_days: INVITE_TTL_DAYS,
      max_uses: INVITE_MAX_USES, use_count: 0,
      role, child_id: childId, access_expires_at: accessExpiresAt, classroom_id: classroomId };
  }

  listInvites() {
    const invites = this.db.prepare(`SELECT id, label, code, url, created_at, expires_at, used_at, revoked, device_id,
      role, child_id, access_expires_at, classroom_id, max_uses, use_count
      FROM invites ORDER BY id DESC`).all().map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
    return { invites, ttl_days: INVITE_TTL_DAYS };
  }

  revokeInvite(id) {
    const result = this.db.prepare('UPDATE invites SET revoked = 1, code = NULL, url = NULL WHERE id = ?').run(id);
    if (!result.changes) throw httpError(404, 'Invitația nu a fost găsită.');
  }

  // Called inside the activation transaction, so failed device/permission writes
  // never spend a slot and concurrent requests cannot exceed the limit.
  #claimInvite(inviteId, deviceId, nowIso) {
    const claimed = this.db.prepare(`UPDATE invites SET
      use_count = use_count + 1, device_id = ?,
      used_at = CASE WHEN use_count + 1 = max_uses THEN ? ELSE NULL END,
      code = CASE WHEN use_count + 1 = max_uses THEN NULL ELSE code END,
      url = CASE WHEN use_count + 1 = max_uses THEN NULL ELSE url END
      WHERE id = ? AND use_count < max_uses AND used_at IS NULL AND revoked = 0 AND expires_at > ?`)
      .run(deviceId, nowIso, inviteId, nowIso);
    if (claimed.changes !== 1) throw httpError(409, 'Invitația nu mai are activări disponibile. Cere un cod nou.');
  }

  redeemInvite(rawCode, initialLabel) {
    const now = this.now();
    this.failures = this.failures.filter((at) => at > now - 10 * 60000);
    if (this.failures.length >= 25) throw httpError(429, 'Prea multe încercări. Încearcă din nou peste câteva minute.');
    const fail = (status, message) => {
      this.failures.push(now);
      return httpError(status, message);
    };
    if (typeof rawCode !== 'string' || rawCode.length > 64) throw fail(400, 'Codul invitației nu este valid.');
    const code = rawCode.toUpperCase().replace(/[-\s]/gu, '');
    if (!/^[A-Z2-9]{16}$/u.test(code)) throw fail(400, 'Codul invitației nu este valid.');
    const label = validLabel(initialLabel, '');
    const codeHash = hash(code);
    const nowIso = new Date(now).toISOString();
    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(codeHash);
      if (!invite || invite.revoked) throw fail(404, 'Invitația nu este disponibilă. Cere un cod nou.');
      if (invite.used_at || invite.use_count >= invite.max_uses) throw fail(404, 'Codul a atins limita de dispozitive. Cere o invitație nouă.');
      if (invite.expires_at <= nowIso) throw fail(410, 'Invitația a expirat.');
      if (invite.access_expires_at && invite.access_expires_at <= nowIso) throw fail(410, 'Dreptul de acces din invitație a expirat.');
      const deviceLabel = label || invite.label || 'Telefon';
      const sessionExpiry = new Date(now + SESSION_SECONDS * 1000).toISOString();
      const expiresAt = invite.access_expires_at && invite.access_expires_at < sessionExpiry
        ? invite.access_expires_at : sessionExpiry;
      const isOwner = (invite.role || 'treasurer') === 'treasurer'
        && !this.db.prepare('SELECT 1 FROM devices WHERE is_owner = 1 LIMIT 1').get();
      this.db.prepare(`INSERT INTO devices
        (id, token_hash, label, created_at, last_seen, expires_at, role, child_id, access_expires_at, is_owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(deviceId, hash(token), deviceLabel, nowIso, nowIso,
        expiresAt, invite.role || 'treasurer', invite.child_id, invite.access_expires_at, Number(isOwner));
      this.db.prepare(`INSERT INTO device_permissions
        (device_id, classroom_id, role, child_id, access_expires_at) VALUES (?, ?, ?, ?, ?)`).run(
        deviceId, invite.classroom_id || DEFAULT_CLASSROOM_ID, invite.role || 'treasurer', invite.child_id, invite.access_expires_at);
      this.#claimInvite(invite.id, deviceId, nowIso);
      this.db.exec('COMMIT');
      return { token, device: { id: deviceId, label: deviceLabel, created_at: nowIso, last_seen: nowIso,
        role: invite.role || 'treasurer', child_id: invite.child_id, access_expires_at: invite.access_expires_at,
        is_owner: isOwner } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addAccess(rawCode, deviceId) {
    const now = this.now();
    this.failures = this.failures.filter((at) => at > now - 10 * 60000);
    if (this.failures.length >= 25) throw httpError(429, 'Prea multe încercări. Încearcă din nou peste câteva minute.');
    const fail = (status, message) => {
      this.failures.push(now);
      return httpError(status, message);
    };
    if (typeof rawCode !== 'string' || rawCode.length > 64) throw fail(400, 'Codul invitației nu este valid.');
    const code = rawCode.toUpperCase().replace(/[-\s]/gu, '');
    if (!/^[A-Z2-9]{16}$/u.test(code)) throw fail(400, 'Codul invitației nu este valid.');
    const nowIso = new Date(now).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(hash(code));
      if (!invite || invite.revoked) throw fail(404, 'Invitația nu este disponibilă. Cere un cod nou.');
      if (invite.used_at || invite.use_count >= invite.max_uses) throw fail(404, 'Codul a atins limita de dispozitive. Cere o invitație nouă.');
      if (invite.expires_at <= nowIso) throw fail(410, 'Invitația a expirat.');
      if (invite.access_expires_at && invite.access_expires_at <= nowIso) throw fail(410, 'Dreptul de acces din invitație a expirat.');
      const classroomId = invite.classroom_id || DEFAULT_CLASSROOM_ID;
      if (this.db.prepare('SELECT 1 FROM device_permissions WHERE device_id = ? AND classroom_id = ?').get(deviceId, classroomId)) {
        throw httpError(409, 'Acest dispozitiv are deja acces la clasa aleasă.');
      }
      this.db.prepare(`INSERT INTO device_permissions
        (device_id, classroom_id, role, child_id, access_expires_at) VALUES (?, ?, ?, ?, ?)`).run(
        deviceId, classroomId, invite.role || 'treasurer', invite.child_id, invite.access_expires_at);
      this.#claimInvite(invite.id, deviceId, nowIso);
      this.db.exec('COMMIT');
      return this.resolvePermission(deviceId, classroomId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDevice(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const nowIso = new Date(this.now()).toISOString();
    const row = this.db.prepare(`SELECT id, label, created_at, last_seen, role, child_id, access_expires_at, is_owner FROM devices
      WHERE token_hash = ? AND revoked = 0 AND expires_at > ?
        AND EXISTS (SELECT 1 FROM device_permissions p WHERE p.device_id = devices.id
          AND (p.access_expires_at IS NULL OR p.access_expires_at > ?))`).get(hash(token), nowIso, nowIso);
    if (!row) return null;
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowIso, row.id);
    return { ...row, is_owner: Boolean(row.is_owner), last_seen: nowIso };
  }

  logout(token) {
    if (typeof token === 'string') this.db.prepare('UPDATE devices SET revoked = 1 WHERE token_hash = ?').run(hash(token));
  }

  listDevices() {
    return { devices: this.db.prepare(`SELECT id, label, created_at, last_seen, revoked, role, child_id, access_expires_at, is_owner
      FROM devices ORDER BY created_at DESC`)
      .all().map((row) => ({ ...row, revoked: Boolean(row.revoked), is_owner: Boolean(row.is_owner), has_push: false,
        permissions: this.listPermissions(row.id, { includeExpired: true }) })) };
  }

  listClassrooms() {
    return this.db.prepare('SELECT id, ledger_file, created_at, archived FROM classrooms ORDER BY created_at, id')
      .all().map(row => ({ ...row, archived: Boolean(row.archived) }));
  }

  getClassroom(id) {
    return this.db.prepare('SELECT id, ledger_file, created_at, archived FROM classrooms WHERE id = ?').get(id) || null;
  }

  getClassroomByRequest(requestId) {
    return this.db.prepare('SELECT id, ledger_file, created_at, archived, request_fingerprint FROM classrooms WHERE request_id = ?').get(requestId) || null;
  }

  createClassroom({ id, ledgerFile, requestId, requestFingerprint, ownerDeviceId }) {
    const nowIso = new Date(this.now()).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO classrooms (id, ledger_file, created_at, request_id, request_fingerprint, archived)
        VALUES (?, ?, ?, ?, ?, 0)`).run(id, ledgerFile, nowIso, requestId, requestFingerprint);
      this.db.prepare(`INSERT INTO device_permissions (device_id, classroom_id, role, child_id, access_expires_at)
        VALUES (?, ?, 'treasurer', NULL, NULL)`).run(ownerDeviceId, id);
      this.db.exec('COMMIT');
      return this.getClassroom(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listPermissions(deviceId, { includeExpired = false } = {}) {
    const nowIso = new Date(this.now()).toISOString();
    return this.db.prepare(`SELECT classroom_id, role, child_id, access_expires_at FROM device_permissions
      WHERE device_id = ? ${includeExpired ? '' : 'AND (access_expires_at IS NULL OR access_expires_at > ?)'}
      ORDER BY classroom_id`).all(...(includeExpired ? [deviceId] : [deviceId, nowIso]));
  }

  resolvePermission(deviceId, classroomId = null) {
    const permissions = this.listPermissions(deviceId);
    if (!permissions.length) throw httpError(403, 'Acest dispozitiv nu mai are acces la nicio clasă.');
    const permission = classroomId ? permissions.find(item => item.classroom_id === classroomId)
      : permissions.find(item => item.classroom_id === DEFAULT_CLASSROOM_ID) || permissions[0];
    if (!permission) throw httpError(403, 'Acest dispozitiv nu are acces la clasa selectată.');
    return permission;
  }

  setDeviceRevoked(id, revoked) {
    if (typeof revoked !== 'boolean') throw httpError(400, 'Starea dispozitivului nu este validă.');
    if (!this.db.prepare('UPDATE devices SET revoked = ? WHERE id = ?').run(Number(revoked), id).changes) {
      throw httpError(404, 'Dispozitivul nu a fost găsit.');
    }
  }

  setDeviceLabel(id, label) {
    if (typeof label !== 'string') throw httpError(400, 'Eticheta dispozitivului nu este validă.');
    if (!this.db.prepare('UPDATE devices SET label = ? WHERE id = ?').run(validLabel(label), id).changes) {
      throw httpError(404, 'Dispozitivul nu a fost găsit.');
    }
  }

  deleteDevice(id) {
    if (!this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes) throw httpError(404, 'Dispozitivul nu a fost găsit.');
  }

  close() { this.db.close(); }
}
