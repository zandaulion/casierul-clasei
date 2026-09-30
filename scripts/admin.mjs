#!/usr/bin/env node
// Command-line access to the admin API: invitations for every role, devices, revocations.
// Reads ~/.config/casierul-clasei/app.env (or $CASIERUL_ENV); ADMIN_TOKEN, ADMIN_HOST and
// ADMIN_PORT in the environment take precedence, so it also works inside the Docker image.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const USAGE = `Usage:
  node scripts/admin.mjs options                    classrooms and children an invitation can target
  node scripts/admin.mjs invite [label] [--role treasurer|parent|auditor] [--for <option id>] [--expires YYYY-MM-DD]
  node scripts/admin.mjs invites                    list invitations
  node scripts/admin.mjs revoke-invite <id>
  node scripts/admin.mjs devices                    list activated devices
  node scripts/admin.mjs revoke-device <device id> | restore-device <device id> | delete-device <device id>

Examples:
  node scripts/admin.mjs invite "Telefonul meu"                        cashier for the default classroom
  node scripts/admin.mjs invite --role auditor --for classroom:<id>
  node scripts/admin.mjs invite --role parent --for child:<classroom id>:<child id> --expires 2027-06-30
Option ids come from "options"; a parent invitation needs a child, the other roles take a classroom.`;

const file = process.env.CASIERUL_ENV || path.join(homedir(), '.config/casierul-clasei/app.env');
const config = existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }))
  : {};
const setting = name => process.env[name] || config[name];
const token = setting('ADMIN_TOKEN');
if (!token) fail(`ADMIN_TOKEN is not set and ${file} does not provide it.`);
const base = `http://${setting('ADMIN_HOST') || '127.0.0.1'}:${setting('ADMIN_PORT') || '8118'}/api/admin`;

const [action, ...rest] = process.argv.slice(2);
const flags = {}, positional = [];
for (let index = 0; index < rest.length; index++) {
  if (rest[index].startsWith('--')) flags[rest[index].slice(2)] = rest[++index] ?? '';
  else positional.push(rest[index]);
}

function fail(message) { console.error(message); process.exit(1); }

async function call(route, method = 'GET', body) {
  let response;
  try {
    response = await fetch(base + route, { method, headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    fail(`The admin API is not reachable at ${base}: ${error.cause?.message || error.message}`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) fail(result.error || `HTTP ${response.status}`);
  return result;
}

const print = value => console.log(JSON.stringify(value, null, 2));

switch (action) {
  case 'options': {
    const { children } = await call('/invite-options');
    for (const option of children) console.log(`${option.id}\t${option.name}`);
    break;
  }
  case 'invite': {
    const role = flags.role || 'treasurer';
    if (!['treasurer', 'parent', 'auditor'].includes(role)) fail('--role must be treasurer, parent or auditor.');
    if (role === 'parent' && !/^child:/u.test(flags.for || '')) fail('A parent invitation needs --for child:<classroom id>:<child id>; see "options".');
    if (flags.for && !/^(?:classroom|child):/u.test(flags.for)) fail('--for takes an option id from "options" (classroom:… or child:…).');
    const body = { label: positional.join(' ') || (role === 'treasurer' ? 'Casier' : ''), role, childId: flags.for || null,
      accessExpiresAt: flags.expires || null, classroomId: null };
    const invite = await call('/invites', 'POST', body);
    console.log(`Invitation ${invite.id} · ${role}${invite.child_id ? ' · child ' + invite.child_id : ''} · classroom ${invite.classroom_id}`);
    console.log(`Code: ${invite.code}`);
    if (invite.url) console.log(`Link: ${invite.url}`);
    console.log(`Valid until ${invite.expires_at} for ${invite.max_uses} device activations${invite.access_expires_at ? `; access ends ${invite.access_expires_at.slice(0, 10)}` : ''}.`);
    break;
  }
  case 'invites': print(await call('/invites')); break;
  case 'devices': print(await call('/devices')); break;
  case 'revoke-invite':
    if (!positional[0]) fail(USAGE);
    await call(`/invites/${encodeURIComponent(positional[0])}/revoke`, 'POST', {});
    console.log('Invitation revoked.'); break;
  case 'revoke-device':
  case 'restore-device':
    if (!positional[0]) fail(USAGE);
    await call(`/devices/${encodeURIComponent(positional[0])}/revoke`, 'POST', { revoked: action === 'revoke-device' });
    console.log(action === 'revoke-device' ? 'Device revoked.' : 'Device restored.'); break;
  case 'delete-device':
    if (!positional[0]) fail(USAGE);
    await call(`/devices/${encodeURIComponent(positional[0])}`, 'DELETE');
    console.log('Device deleted.'); break;
  default: fail(USAGE);
}
