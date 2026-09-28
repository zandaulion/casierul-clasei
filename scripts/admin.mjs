#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const file = process.env.CASIERUL_ENV || path.join(homedir(), '.config/casierul-clasei/app.env');
const config = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(line => line.includes('=') && !line.startsWith('#')).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
const [action, ...args] = process.argv.slice(2);
if (!['invite', 'invites', 'devices'].includes(action)) {
  console.error('Usage: node scripts/admin.mjs invite [device label] | invites | devices');
  process.exit(1);
}
const response = await fetch(`http://127.0.0.1:${config.ADMIN_PORT || 8118}/api/admin/${action === 'invite' ? 'invites' : action}`, {
  method: action === 'invite' ? 'POST' : 'GET',
  headers: { 'X-Admin-Token': config.ADMIN_TOKEN, 'Content-Type': 'application/json' },
  ...(action === 'invite' ? { body: JSON.stringify({ label: args.join(' ') || 'Casier' }) } : {}),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
console.log(JSON.stringify(result, null, 2));
