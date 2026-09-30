import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AuthStore, adminTokenMatches, clearSessionCookie, httpError, readSessionCookie, sessionCookie } from './auth.mjs';
import { ClassroomLedgers } from './classrooms.mjs';
import { MAX_ATTACHMENT_BYTES } from './ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

function port(value, fallback) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/u.test(String(value)) || Number(value) > 65535) throw new Error('Port invalid.');
  return Number(value);
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const publicPort = port(env.PORT, 8018);
  if (env.COOKIE_SECURE != null && !['true', 'false'].includes(env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE trebuie să fie true sau false.');
  return {
    host, port: publicPort, adminHost: '127.0.0.1', adminPort: port(env.ADMIN_PORT, 8118),
    dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
    publicBaseUrl: env.PUBLIC_BASE_URL || `http://${host}:${publicPort}`,
    adminToken: env.ADMIN_TOKEN || '', cookieSecure: env.COOKIE_SECURE !== 'false', webDir: path.join(ROOT, 'web'),
  };
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

function sendPdf(res, file) {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': file.pdf.length,
    'Content-Disposition': `attachment; filename="${file.filename}"` });
  res.end(file.pdf);
}

function sendImage(res, image) {
  res.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.data.length,
    'Last-Modified': new Date(image.updatedAt).toUTCString(), 'Cache-Control': 'private, no-cache' });
  res.end(image.data);
}

function contentDisposition(filename, disposition = 'inline') {
  const fallback = filename.normalize('NFKD').replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'document';
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sendAttachment(res, attachment, download = false) {
  res.writeHead(200, { 'Content-Type': attachment.mimeType, 'Content-Length': attachment.data.length,
    'Content-Disposition': contentDisposition(attachment.filename, download ? 'attachment' : 'inline'),
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-SHA256': attachment.sha256 });
  res.end(attachment.data);
}

function exactKeys(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Corpul cererii trebuie să fie un obiect JSON.');
  if (Object.keys(body).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(body, key))) {
    throw httpError(400, 'Câmpurile cererii nu sunt valide.');
  }
}

async function readJson(req, { allowEmpty = false } = {}) {
  const declared = req.headers['content-length'];
  if (declared != null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw httpError(413, 'Cererea este prea mare.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Cererea este prea mare.');
    chunks.push(chunk);
  }
  if (size === 0 && allowEmpty) return {};
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] || '')) {
    throw httpError(415, 'Trimite cererea în format JSON.');
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'JSON invalid.'); }
  exactKeys(body, Object.keys(body || {}));
  return body;
}

async function readBytes(req, limit) {
  const declared = req.headers['content-length'];
  if (declared != null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) throw httpError(413, 'Documentul este prea mare.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Documentul este prea mare.');
    chunks.push(chunk);
  }
  if (!size) throw httpError(400, 'Documentul este gol.');
  return Buffer.concat(chunks);
}

function query(req, allowed) {
  let params;
  try { params = new URL(req.url || '/', 'http://localhost').searchParams; }
  catch { throw httpError(400, 'Adresa cererii nu este validă.'); }
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw httpError(400, 'Parametrii cererii nu sunt valizi.');
  return params;
}

function checkOrigin(req, publicOrigin) {
  if (req.headers.origin != null && req.headers.origin !== publicOrigin) throw httpError(403, 'Originea cererii nu este permisă.');
  const site = req.headers['sec-fetch-site'];
  if (site != null && site !== 'same-origin') throw httpError(403, 'Cererea trebuie trimisă din aplicație.');
}

// The app is meant to sit behind a local reverse proxy (Cloudflare Tunnel, Caddy), so a forwarded
// address is trusted only when the connection itself comes from this machine.
function clientAddress(req) {
  const socketAddress = req.socket?.remoteAddress || '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketAddress);
  const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return loopback && forwarded ? forwarded : socketAddress;
}

function pathnameOf(req) {
  let name;
  try { name = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { throw httpError(400, 'Adresă invalidă.'); }
  if (!name.startsWith('/') || /[\\\u0000-\u001f]/u.test(name) || name.split('/').some((part) => part === '..' || part === '.')) {
    throw httpError(404, 'Nu a fost găsit.');
  }
  return name;
}

function classroomIdOf(req) {
  let value;
  try { value = new URL(req.url || '/', 'http://localhost').searchParams.get('classroom'); }
  catch { throw httpError(400, 'Adresă invalidă.'); }
  if (value == null || value === '') return null;
  if (!/^(?:default|[a-f0-9-]{36})$/u.test(value)) throw httpError(400, 'Clasa selectată nu este validă.');
  return value;
}

function loadAssets(webDir) {
  const assets = new Map();
  const version = createHash('sha256');
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.')) continue;
      const relative = `${prefix}/${item.name}`;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, relative);
      else if (item.isFile() && CONTENT_TYPES[path.extname(item.name)]) {
        const content = fs.readFileSync(full);
        version.update(relative).update(content);
        assets.set(relative, { content, type: CONTENT_TYPES[path.extname(item.name)] });
      }
    }
  }
  walk(webDir);
  const buildVersion = version.digest('hex').slice(0, 12);
  if (assets.has('/sw.js')) {
    const asset = assets.get('/sw.js');
    asset.content = Buffer.from(asset.content.toString('utf8').replaceAll('__BUILD_VERSION__', buildVersion));
  }
  return { assets, buildVersion };
}

const BUSINESS_ROUTES = [
  [/^\/api\/settings$/u, 'settings.update', ['schoolName', 'className', 'schoolYear', 'openingBalanceMinor', 'paymentRevolutUrl', 'paymentBeneficiary', 'paymentIban', 'schoolLogo', 'classLogo']],
  [/^\/api\/children$/u, 'child.create', ['firstName', 'lastName']],
  [/^\/api\/children\/bulk$/u, 'children.create', ['children']],
  [/^\/api\/children\/([A-Za-z0-9_-]{1,100})\/contacts$/u, 'child.contacts.update', ['contacts'], 'childId'],
  [/^\/api\/children\/([A-Za-z0-9_-]{1,100})$/u, 'child.update', ['firstName', 'lastName', 'active'], 'childId'],
  [/^\/api\/expenses$/u, 'expense.create', ['title', 'type', 'amountMinor', 'participants', 'occurredAt', 'dueDate', 'comment']],
  [/^\/api\/expenses\/([A-Za-z0-9_-]{1,100})$/u, 'expense.update', ['title', 'type', 'amountMinor', 'participants', 'occurredAt', 'dueDate', 'comment'], 'expenseId'],
  [/^\/api\/expenses\/([A-Za-z0-9_-]{1,100})\/cancel$/u, 'expense.cancel', ['comment'], 'expenseId'],
  [/^\/api\/collections$/u, 'collection.create', ['childId', 'receivedMinor', 'changeMinor', 'allocations', 'settlement', 'occurredAt', 'comment']],
  [/^\/api\/direct-payments$/u, 'direct_payment.create', ['childId', 'expenseId', 'amountMinor', 'destination', 'occurredAt', 'comment']],
  [/^\/api\/rounding-adjustments$/u, 'rounding_adjustment.create', ['childId', 'expenseId', 'occurredAt', 'comment']],
  [/^\/api\/credit\/apply$/u, 'credit.apply', ['childId', 'allocations', 'occurredAt', 'comment']],
  [/^\/api\/refunds$/u, 'refund.create', ['childId', 'amountMinor', 'occurredAt', 'comment']],
  [/^\/api\/payments$/u, 'payment.create', ['amountMinor', 'destination', 'expenseId', 'occurredAt', 'comment']],
  [/^\/api\/fund-advances$/u, 'fund_advance.create', ['amountMinor', 'person', 'expenseId', 'occurredAt', 'comment']],
  [/^\/api\/fund-advances\/([A-Za-z0-9_-]{1,100})\/repayments$/u, 'fund_advance.repay', ['amountMinor', 'occurredAt', 'comment'], 'advanceId'],
  [/^\/api\/fund-advances\/([A-Za-z0-9_-]{1,100})\/waivers$/u, 'fund_advance.waive', ['childId', 'expenseId', 'amountMinor', 'occurredAt', 'comment'], 'advanceId'],
  [/^\/api\/transactions\/([A-Za-z0-9_-]{1,100})\/reverse$/u, 'transaction.reverse', ['comment'], 'transactionId'],
];

function validateMutation(body, fields) {
  exactKeys(body, ['requestId', 'expectedRevision', ...fields], ['requestId', 'expectedRevision']);
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(body.requestId)
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw httpError(400, 'Identificatorul cererii sau revizia nu este validă.');
  for (const key of ['schoolName', 'className', 'schoolYear', 'firstName', 'lastName', 'title', 'type', 'childId', 'destination', 'person']) {
    if (Object.hasOwn(body, key) && typeof body[key] !== 'string') throw httpError(400, `Câmpul ${key} trebuie să fie text.`);
  }
  for (const key of ['openingBalanceMinor', 'amountMinor', 'receivedMinor', 'changeMinor']) {
    if (Object.hasOwn(body, key) && !Number.isSafeInteger(body[key])) throw httpError(400, `Câmpul ${key} trebuie să fie un număr întreg de bani.`);
  }
  for (const key of ['occurredAt', 'dueDate', 'comment', 'expenseId']) {
    if (Object.hasOwn(body, key) && body[key] !== null && typeof body[key] !== 'string') throw httpError(400, `Câmpul ${key} trebuie să fie text.`);
  }
  for (const key of ['schoolLogo', 'classLogo']) {
    if (Object.hasOwn(body, key) && body[key] !== null && typeof body[key] !== 'string') {
      throw httpError(400, `Câmpul ${key} trebuie să fie o imagine sau gol.`);
    }
  }
  if (Object.hasOwn(body, 'active') && typeof body.active !== 'boolean') throw httpError(400, 'Starea copilului nu este validă.');
  for (const [key, nestedFields, required] of [
    ['children', ['firstName', 'lastName'], ['firstName', 'lastName']],
    ['participants', ['childId', 'quantity'], ['childId']],
    ['allocations', ['expenseId', 'amountMinor'], ['expenseId', 'amountMinor']],
    ['contacts', ['label', 'phone'], ['label', 'phone']],
  ]) {
    if (!Object.hasOwn(body, key)) continue;
    if (!Array.isArray(body[key]) || body[key].length > 1000) throw httpError(400, `Lista ${key} nu este validă.`);
    for (const entry of body[key]) {
      exactKeys(entry, nestedFields, required);
      for (const name of nestedFields) {
        if (!Object.hasOwn(entry, name)) continue;
        const valid = ['quantity', 'amountMinor'].includes(name) ? Number.isSafeInteger(entry[name]) : typeof entry[name] === 'string';
        if (!valid) throw httpError(400, `Lista ${key} conține o valoare invalidă.`);
      }
    }
  }
  if (Object.hasOwn(body, 'settlement')) {
    if (!body.settlement || typeof body.settlement !== 'object' || Array.isArray(body.settlement)) {
      throw httpError(400, 'Închiderea diferenței nu este validă.');
    }
    exactKeys(body.settlement, ['type', 'allocations'], ['type', 'allocations']);
    if (!['credit', 'rounding'].includes(body.settlement.type) || !Array.isArray(body.settlement.allocations)
      || !body.settlement.allocations.length || body.settlement.allocations.length > 1000) {
      throw httpError(400, 'Închiderea diferenței nu este validă.');
    }
    for (const allocation of body.settlement.allocations) {
      exactKeys(allocation, ['expenseId', 'amountMinor'], ['expenseId', 'amountMinor']);
      if (typeof allocation.expenseId !== 'string' || !Number.isSafeInteger(allocation.amountMinor)) {
        throw httpError(400, 'Închiderea diferenței conține o repartizare invalidă.');
      }
    }
  }
}

function requireMethod(req, method) {
  if (req.method !== method) throw Object.assign(httpError(405, 'Metodă nepermisă.'), { allow: method });
}

function requireTreasurer(device) {
  if (device.role !== 'treasurer') throw httpError(403, 'Acest dispozitiv are acces doar pentru citire.');
}

function canReadReport(report, device) {
  if (device.role === 'treasurer' || device.role === 'auditor') return true;
  return device.role === 'parent' && (['class', 'expense'].includes(report.type)
    || (report.type === 'child' && report.subjectId === device.child_id));
}

export function projectState(state, device) {
  if (device.role === 'treasurer') return state;
  const { contacts: _contacts, ...safeState } = state;
  if (device.role !== 'parent') return safeState;
  const ownChild = safeState.children.find((child) => child.id === device.child_id);
  if (!ownChild) throw httpError(403, 'Copilul asociat acestui acces nu mai este disponibil.');
  const expenses = safeState.expenses.map((expense) => ({
    ...expense,
    comment: '',
    participantCount: expense.contributions.length,
    contributions: expense.contributions.filter((contribution) => contribution.childId === device.child_id),
  }));
  const transactions = safeState.transactions.filter((transaction) =>
    ['payment', 'fund_advance', 'advance_repayment'].includes(transaction.type) || transaction.childId === device.child_id).map((transaction) => ({
    ...transaction,
    ...(transaction.childId === device.child_id ? {} : { comment: '' }),
  }));
  return {
    ...safeState,
    children: [ownChild],
    expenses,
    advances: (safeState.advances || []).map((advance) => ({ ...advance, comment: '' })),
    attachments: (safeState.attachments || []).filter((attachment) => attachment.visibility === 'class'),
    transactions,
    reports: (safeState.reports || []).filter((report) => canReadReport(report, device)),
  };
}

export function createApp(options = {}) {
  const config = { ...loadConfig(), ...options };
  const base = new URL(config.publicBaseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('PUBLIC_BASE_URL trebuie să fie originea publică a aplicației.');
  }
  config.publicBaseUrl = base.origin;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const auth = options.auth || new AuthStore(path.join(config.dataDir, 'auth.sqlite'), { publicBaseUrl: config.publicBaseUrl });
  const ledgers = options.ledgers || new ClassroomLedgers(config.dataDir, auth, { defaultLedger: options.ledger || null });
  const ledger = ledgers.get();
  const { assets, buildVersion } = loadAssets(config.webDir);

  const accessContext = (req, device) => {
    const permission = auth.resolvePermission(device.id, classroomIdOf(req));
    return { permission, ledger: ledgers.get(permission.classroom_id), scopedDevice: { ...device, ...permission } };
  };
  const classroomsFor = device => ledgers.listForDevice(device.id);
  const decorateRecord = record => {
    const classroomId = record.classroom_id || 'default';
    const classroom = ledgers.summary(classroomId);
    const state = classroom ? ledgers.get(classroomId).getState() : { children: [] };
    const child = record.child_id ? state.children.find(item => item.id === record.child_id) : null;
    const classroomLabel = classroom ? [classroom.schoolName, classroom.className, classroom.schoolYear].filter(Boolean).join(' · ') || 'Clasă neconfigurată' : null;
    const permissions = record.permissions?.map(permission => decorateRecord(permission));
    const accessLabel = permissions
      ? permissions.map(permission => permission.child_label).filter(Boolean).join(' · ')
      : classroomLabel && child ? `${classroomLabel} — ${child.lastName} ${child.firstName}` : classroomLabel;
    return { ...record, classroom_label: classroomLabel, child_label: accessLabel, ...(permissions ? { permissions } : {}) };
  };

  async function handlePublic(req, res, pathname) {
    if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) throw httpError(404, 'Nu a fost găsit.');
    if (pathname === '/api/health') {
      requireMethod(req, 'GET');
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/redeem') {
      requireMethod(req, 'POST');
      checkOrigin(req, config.publicBaseUrl);
      const body = await readJson(req);
      exactKeys(body, ['code', 'label'], ['code']);
      if (Object.hasOwn(body, 'label') && typeof body.label !== 'string') throw httpError(400, 'Eticheta dispozitivului trebuie să fie text.');
      const result = auth.redeemInvite(body.code, body.label, clientAddress(req));
      res.setHeader('Set-Cookie', sessionCookie(result.token, config.cookieSecure));
      return sendJson(res, 200, { device: result.device });
    }
    if (pathname.startsWith('/api/')) {
      const route = BUSINESS_ROUTES.find(([pattern]) => pattern.test(pathname));
      const reportPdf = pathname.match(/^\/api\/reports\/([A-Za-z0-9_-]{1,100})\/pdf$/u);
      const brandingImage = pathname.match(/^\/api\/branding\/(school|class)$/u);
      const attachmentFile = pathname.match(/^\/api\/attachments\/([A-Za-z0-9_-]{1,100})$/u);
      const attachmentUpload = pathname.match(/^\/api\/(expenses|payments)\/([A-Za-z0-9_-]{1,100})\/attachments$/u);
      if (!route && !reportPdf && !brandingImage && !attachmentFile && !attachmentUpload && !['/api/auth/me', '/api/auth/access', '/api/auth/logout', '/api/state', '/api/export', '/api/reports', '/api/classrooms'].includes(pathname)) throw httpError(404, 'Nu a fost găsit.');
      const token = readSessionCookie(req.headers.cookie, config.cookieSecure);
      const device = auth.getDevice(token);
      if (!device) throw httpError(401, 'Activează acest dispozitiv cu o invitație.');
      if (pathname === '/api/auth/me') {
        requireMethod(req, 'GET');
        return sendJson(res, 200, { device, classrooms: classroomsFor(device) });
      }
      if (pathname === '/api/auth/access') {
        requireMethod(req, 'POST');
        checkOrigin(req, config.publicBaseUrl);
        const body = await readJson(req);
        exactKeys(body, ['code'], ['code']);
        const permission = auth.addAccess(body.code, device.id, clientAddress(req));
        return sendJson(res, 200, { device: auth.getDevice(token), classrooms: classroomsFor(device), classroomId: permission.classroom_id });
      }
      if (pathname === '/api/auth/logout') {
        requireMethod(req, 'POST');
        checkOrigin(req, config.publicBaseUrl);
        exactKeys(await readJson(req), []);
        auth.logout(token);
        res.setHeader('Set-Cookie', clearSessionCookie(config.cookieSecure));
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/classrooms') {
        if (req.method === 'GET') return sendJson(res, 200, { classrooms: classroomsFor(device) });
        requireMethod(req, 'POST');
        checkOrigin(req, config.publicBaseUrl);
        const classroom = ledgers.create(await readJson(req), device);
        return sendJson(res, 201, { classroom, classrooms: classroomsFor(device), state: ledgers.get(classroom.id).getState() });
      }
      const context = accessContext(req, device);
      if (pathname === '/api/state') {
        requireMethod(req, 'GET');
        return sendJson(res, 200, projectState(context.ledger.getState(), context.scopedDevice));
      }
      if (brandingImage) {
        requireMethod(req, 'GET');
        const image = context.ledger.getBrandingImage(brandingImage[1]);
        if (!image) throw httpError(404, 'Sigla nu a fost configurată.');
        return sendImage(res, image);
      }
      if (attachmentFile) {
        requireMethod(req, 'GET');
        const params = query(req, ['classroom', 'download']);
        if (params.get('download') != null && params.get('download') !== '1') throw httpError(400, 'Parametrul de descărcare nu este valid.');
        const attachment = context.ledger.getAttachment(attachmentFile[1]);
        if (context.scopedDevice.role === 'parent' && attachment.visibility !== 'class') throw httpError(404, 'Documentul nu a fost găsit.');
        return sendAttachment(res, attachment, params.get('download') === '1');
      }
      if (pathname === '/api/export') {
        requireMethod(req, 'GET');
        requireTreasurer(context.scopedDevice);
        return sendJson(res, 200, context.ledger.exportData(), {
          'Content-Disposition': `attachment; filename="casierul-clasei-${new Date().toISOString().slice(0, 10)}.json"`,
        });
      }
      if (reportPdf) {
        requireMethod(req, 'GET');
        const report = (context.ledger.getState().reports || []).find((entry) => entry.id === reportPdf[1]);
        if (!report || !canReadReport(report, context.scopedDevice)) throw httpError(404, 'Raportul nu a fost găsit.');
        return sendPdf(res, context.ledger.getReportPdf(reportPdf[1]));
      }
      if (pathname === '/api/reports') {
        requireMethod(req, 'POST');
        requireTreasurer(context.scopedDevice);
        checkOrigin(req, config.publicBaseUrl);
        const body = await readJson(req);
        exactKeys(body, ['requestId', 'type', 'subjectId', 'replacesId'], ['requestId', 'type']);
        for (const key of ['requestId', 'type', 'subjectId', 'replacesId']) {
          if (Object.hasOwn(body, key) && body[key] !== null && typeof body[key] !== 'string') throw httpError(400, `Câmpul ${key} trebuie să fie text.`);
        }
        if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(body.requestId)) throw httpError(400, 'Identificatorul cererii nu este valid.');
        return sendJson(res, 201, await context.ledger.createReport(body, { id: device.id, label: device.label }));
      }
      if (attachmentUpload) {
        requireMethod(req, 'POST');
        requireTreasurer(context.scopedDevice);
        checkOrigin(req, config.publicBaseUrl);
        query(req, ['classroom']);
        const requestId = req.headers['x-request-id'], expectedRevision = req.headers['x-expected-revision'];
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(requestId)
          || typeof expectedRevision !== 'string' || !/^\d+$/u.test(expectedRevision) || !Number.isSafeInteger(Number(expectedRevision))) {
          throw httpError(400, 'Identificatorul cererii sau revizia nu este validă.');
        }
        const encodedFilename = req.headers['x-filename'], visibility = req.headers['x-visibility'];
        let filename;
        try { filename = typeof encodedFilename === 'string' ? decodeURIComponent(encodedFilename) : null; }
        catch { throw httpError(400, 'Numele documentului nu este valid.'); }
        if (!filename || typeof visibility !== 'string') throw httpError(400, 'Datele documentului sunt incomplete.');
        const mimeType = (req.headers['content-type'] || '').toLowerCase();
        const data = await readBytes(req, MAX_ATTACHMENT_BYTES);
        return sendJson(res, 201, context.ledger.createAttachment({ requestId, expectedRevision: Number(expectedRevision),
          entityType: attachmentUpload[1] === 'expenses' ? 'expense' : 'payment', entityId: attachmentUpload[2], filename,
          visibility, mimeType, data }, { id: device.id, label: device.label }));
      }
      requireTreasurer(context.scopedDevice);
      requireMethod(req, 'POST');
      checkOrigin(req, config.publicBaseUrl);
      const body = await readJson(req);
      const [pattern, operation, fields, idField] = route;
      validateMutation(body, fields);
      if (idField) body[idField] = pathname.match(pattern)[1];
      return sendJson(res, 200, context.ledger.dispatch(operation, body, { id: device.id, label: device.label }));
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw Object.assign(httpError(405, 'Metodă nepermisă.'), { allow: 'GET, HEAD' });
    const asset = assets.get(pathname === '/' ? '/index.html' : pathname === '/bust' ? '/bust.html' : pathname);
    if (!asset) throw httpError(404, 'Nu a fost găsit.');
    if (pathname === '/bust') res.setHeader('Clear-Site-Data', '"cache"');
    res.writeHead(200, {
      'Content-Type': asset.type, 'Content-Length': asset.content.length,
      'Cache-Control': pathname === '/sw.js' || pathname === '/bust' ? 'no-store' : 'no-cache, must-revalidate',
    });
    res.end(req.method === 'HEAD' ? undefined : asset.content);
  }

  async function handleAdmin(req, res, pathname) {
    if (!adminTokenMatches(req.headers['x-admin-token'], config.adminToken)) throw httpError(404, 'Nu a fost găsit.');
    if (pathname === '/api/admin/devices') {
      requireMethod(req, 'GET');
      const result = auth.listDevices();
      return sendJson(res, 200, { ...result, devices: result.devices.map(decorateRecord) });
    }
    if (pathname === '/api/admin/invite-options') {
      requireMethod(req, 'GET');
      const children = [];
      for (const classroom of auth.listClassrooms().filter(item => !item.archived)) {
        const summary = ledgers.summary(classroom.id);
        if (!summary) continue;
        const label = [summary.schoolName, summary.className, summary.schoolYear].filter(Boolean).join(' · ') || 'Clasă neconfigurată';
        children.push({ id: `classroom:${classroom.id}`, name: `${label} — întreaga clasă` });
        for (const child of ledgers.get(classroom.id).getState().children.filter(item => item.active)) {
          children.push({ id: `child:${classroom.id}:${child.id}`, name: `${label} — ${child.lastName} ${child.firstName}` });
        }
      }
      return sendJson(res, 200, { children });
    }
    if (pathname === '/api/admin/invites') {
      if (req.method === 'GET') {
        const result = auth.listInvites();
        return sendJson(res, 200, { ...result, invites: result.invites.map(decorateRecord) });
      }
      requireMethod(req, 'POST');
      const body = await readJson(req);
      exactKeys(body, ['label', 'role', 'childId', 'accessExpiresAt', 'classroomId']);
      const role = body.role ?? 'treasurer';
      if (!['treasurer', 'parent', 'auditor'].includes(role)) throw httpError(400, 'Tipul de acces nu este valid.');
      let classroomId = body.classroomId || null, childId = body.childId || null;
      const classScope = typeof childId === 'string' ? childId.match(/^classroom:(default|[a-f0-9-]{36})$/u) : null;
      const childScope = typeof childId === 'string' ? childId.match(/^child:(default|[a-f0-9-]{36}):([A-Za-z0-9_-]{1,100})$/u) : null;
      if (classScope) { classroomId = classScope[1]; childId = null; }
      else if (childScope) { classroomId = childScope[1]; childId = childScope[2]; }
      classroomId ||= 'default';
      const selectedLedger = ledgers.get(classroomId);
      if (role === 'parent' && !selectedLedger.getState().children.some((child) => child.active && child.id === childId)) {
        throw httpError(400, 'Copilul ales nu este activ în clasă.');
      }
      if (role !== 'parent') childId = null;
      let accessExpiresAt = null;
      if (body.accessExpiresAt != null) {
        if (typeof body.accessExpiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(body.accessExpiresAt)) {
          throw httpError(400, 'Data expirării accesului nu este validă.');
        }
        accessExpiresAt = `${body.accessExpiresAt}T23:59:59.999Z`;
        if (accessExpiresAt <= new Date().toISOString()) throw httpError(400, 'Data expirării trebuie să fie în viitor.');
      }
      return sendJson(res, 201, auth.createInvite(body.label, {
        role, childId, accessExpiresAt, classroomId,
      }));
    }
    const device = pathname.match(/^\/api\/admin\/devices\/([A-Za-z0-9_-]{1,100})(?:\/(revoke|label))?$/u);
    if (device) {
      if (!device[2]) {
        requireMethod(req, 'DELETE');
        exactKeys(await readJson(req, { allowEmpty: true }), []);
        auth.deleteDevice(device[1]);
      } else {
        requireMethod(req, 'POST');
        const body = await readJson(req);
        if (device[2] === 'revoke') {
          exactKeys(body, ['revoked'], ['revoked']);
          auth.setDeviceRevoked(device[1], body.revoked);
        } else {
          exactKeys(body, ['label'], ['label']);
          auth.setDeviceLabel(device[1], body.label);
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    const invite = pathname.match(/^\/api\/admin\/invites\/(\d+)\/revoke$/u);
    if (invite) {
      requireMethod(req, 'POST');
      exactKeys(await readJson(req, { allowEmpty: true }), []);
      if (!Number.isSafeInteger(Number(invite[1]))) throw httpError(400, 'Identificator invalid.');
      auth.revokeInvite(Number(invite[1]));
      return sendJson(res, 200, { ok: true });
    }
    throw httpError(404, 'Nu a fost găsit.');
  }

  function handler(serve) {
    return async (req, res) => {
      securityHeaders(res);
      try { await serve(req, res, pathnameOf(req)); }
      catch (error) {
        if (res.destroyed || res.headersSent) return;
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
        if (status === 500) (options.onError || console.error)(error);
        sendJson(res, status, { error: status === 500 ? 'Eroare internă. Încearcă din nou.' : error.message }, error.allow ? { Allow: error.allow } : {});
      }
    };
  }

  const publicServer = http.createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 }, handler(handlePublic));
  const adminServer = http.createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 }, handler(handleAdmin));
  let closed = false;
  return {
    config, publicServer, adminServer, auth, ledger, ledgers, buildVersion,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([publicServer, adminServer].map((server) => server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : undefined));
      ledgers.close();
      auth.close();
    },
  };
}

export async function start(options = {}) {
  const app = createApp(options);
  const listen = (server, portNumber, host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(portNumber, host, () => { server.off('error', reject); resolve(); });
  });
  try {
    await listen(app.publicServer, app.config.port, app.config.host);
    // The admin API stays on loopback even when the public server listens on all interfaces.
    await listen(app.adminServer, app.config.adminPort, app.config.adminHost);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start();
  console.log(`Casierul clasei: ${app.config.host}:${app.config.port}; admin: ${app.config.adminHost}:${app.config.adminPort}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
