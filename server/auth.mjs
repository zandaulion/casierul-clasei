import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = '__Host-casierul';
export const DEVELOPMENT_COOKIE_NAME = 'casierul-dev';
export const SESSION_SECONDS = 400 * 86400;
export const INVITE_TTL_DAYS = 7;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
    `);
  }

  createInvite(label) {
    label = validLabel(label, '');
    const raw = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const code = raw.match(/.{4}/gu).join('-');
    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/?invite=${encodeURIComponent(code)}` : null;
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + INVITE_TTL_DAYS * 86400000).toISOString();
    const result = this.db.prepare(`INSERT INTO invites (code_hash, code, url, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(hash(raw), code, url, label || null, createdAt, expiresAt);
    return { id: Number(result.lastInsertRowid), code, url, expires_at: expiresAt, expires_in_days: INVITE_TTL_DAYS };
  }

  listInvites() {
    const invites = this.db.prepare(`SELECT id, label, code, url, created_at, expires_at, used_at, revoked, device_id
      FROM invites ORDER BY id DESC`).all().map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
    return { invites, ttl_days: INVITE_TTL_DAYS };
  }

  revokeInvite(id) {
    const result = this.db.prepare('UPDATE invites SET revoked = 1, code = NULL, url = NULL WHERE id = ?').run(id);
    if (!result.changes) throw httpError(404, 'Invitația nu a fost găsită.');
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
      if (!invite || invite.revoked || invite.used_at) throw fail(404, 'Invitația nu există sau a fost deja folosită.');
      if (invite.expires_at <= nowIso) throw fail(410, 'Invitația a expirat.');
      const deviceLabel = label || invite.label || 'Telefon';
      this.db.prepare(`INSERT INTO devices (id, token_hash, label, created_at, last_seen, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(deviceId, hash(token), deviceLabel, nowIso, nowIso,
        new Date(now + SESSION_SECONDS * 1000).toISOString());
      const claimed = this.db.prepare(`UPDATE invites SET used_at = ?, device_id = ?, code = NULL, url = NULL
        WHERE id = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?`).run(nowIso, deviceId, invite.id, nowIso);
      if (claimed.changes !== 1) throw fail(409, 'Invitația a fost deja folosită.');
      this.db.exec('COMMIT');
      return { token, device: { id: deviceId, label: deviceLabel, created_at: nowIso, last_seen: nowIso } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDevice(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const nowIso = new Date(this.now()).toISOString();
    const row = this.db.prepare(`SELECT id, label, created_at, last_seen FROM devices
      WHERE token_hash = ? AND revoked = 0 AND expires_at > ?`).get(hash(token), nowIso);
    if (!row) return null;
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowIso, row.id);
    return { ...row, last_seen: nowIso };
  }

  logout(token) {
    if (typeof token === 'string') this.db.prepare('UPDATE devices SET revoked = 1 WHERE token_hash = ?').run(hash(token));
  }

  listDevices() {
    return { devices: this.db.prepare('SELECT id, label, created_at, last_seen, revoked FROM devices ORDER BY created_at DESC')
      .all().map((row) => ({ ...row, revoked: Boolean(row.revoked), has_push: false })) };
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
