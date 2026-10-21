import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Ledger } from './ledger.mjs';
import { DEFAULT_CLASSROOM_ID, httpError } from './auth.mjs';

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw httpError(400, `${label} nu este validă.`);
  }
  return value.trim();
}

export class ClassroomLedgers {
  constructor(dataDir, auth, { defaultLedger = null } = {}) {
    this.dataDir = dataDir;
    this.auth = auth;
    this.ledgers = new Map();
    if (defaultLedger) this.ledgers.set(DEFAULT_CLASSROOM_ID, defaultLedger);
  }

  get(classroomId = DEFAULT_CLASSROOM_ID) {
    if (this.ledgers.has(classroomId)) return this.ledgers.get(classroomId);
    const classroom = this.auth.getClassroom(classroomId);
    if (!classroom || classroom.archived || !/^(?:ledger|classroom-[a-f0-9-]+)\.sqlite$/u.test(classroom.ledger_file)) {
      throw httpError(404, 'Clasa nu există.');
    }
    const ledger = new Ledger(path.join(this.dataDir, classroom.ledger_file));
    this.ledgers.set(classroomId, ledger);
    return ledger;
  }

  summary(classroomId) {
    const classroom = this.auth.getClassroom(classroomId);
    if (!classroom || classroom.archived) return null;
    const settings = this.get(classroomId).getState().settings || {};
    return { id: classroom.id, schoolName: settings.schoolName, className: settings.className,
      schoolYear: settings.schoolYear, createdAt: classroom.created_at };
  }

  listForDevice(deviceId) {
    return this.auth.listPermissions(deviceId).map(permission => {
      const classroom = this.summary(permission.classroom_id);
      return classroom ? { ...classroom, role: permission.role, child_id: permission.child_id,
        access_expires_at: permission.access_expires_at } : null;
    }).filter(Boolean);
  }

  create(body, device) {
    if (!device.is_owner) throw httpError(403, 'Doar proprietarul poate adăuga clase.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Datele clasei nu sunt valide.');
    const keys = Object.keys(body);
    if (keys.some(key => !['requestId', 'schoolName', 'className', 'schoolYear'].includes(key))
      || !keys.includes('requestId') || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(body.requestId || '')) {
      throw httpError(400, 'Datele clasei nu sunt valide.');
    }
    const schoolName = text(body.schoolName, 'Școala', 160);
    const className = text(body.className, 'Clasa', 80);
    const schoolYear = text(body.schoolYear, 'Anul școlar', 40);
    const fingerprint = createHash('sha256').update(JSON.stringify([schoolName, className, schoolYear])).digest('hex');
    const repeated = this.auth.getClassroomByRequest(body.requestId);
    if (repeated) {
      if (repeated.request_fingerprint !== fingerprint) throw httpError(409, 'Identificatorul cererii a fost deja folosit pentru altă clasă.');
      return this.summary(repeated.id);
    }
    const id = randomUUID(), ledgerFile = `classroom-${id}.sqlite`, ledgerPath = path.join(this.dataDir, ledgerFile);
    const ledger = new Ledger(ledgerPath);
    try {
      ledger.dispatch('settings.update', { requestId: randomUUID(), expectedRevision: 0,
        schoolName, className, schoolYear, openingBalanceMinor: 0 }, { id: device.id, label: device.label });
      this.auth.createClassroom({ id, ledgerFile, requestId: body.requestId, requestFingerprint: fingerprint, ownerDeviceId: device.id });
      this.ledgers.set(id, ledger);
      return { id, schoolName, className, schoolYear, createdAt: this.auth.getClassroom(id).created_at };
    } catch (error) {
      ledger.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${ledgerPath}${suffix}`, { force: true });
      throw error;
    }
  }

  close() {
    for (const ledger of new Set(this.ledgers.values())) ledger.close();
    this.ledgers.clear();
  }
}
