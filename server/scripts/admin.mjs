#!/usr/bin/env node
// Local admin CLI — works directly on SQLite, independent of the web path.
// This is the lockout-recovery route: it always works from a shell on the box.
//
//   node scripts/admin.mjs create-user <name> [--owner]
//   node scripts/admin.mjs set-password <name>
//   node scripts/admin.mjs unban <ip-or-username|all>
//   node scripts/admin.mjs list-bans
//   node scripts/admin.mjs list-users
import { createInterface } from 'node:readline/promises';
import { db } from '../src/db.js';
import { createUser, hashPassword } from '../src/auth.js';

const [cmd, arg] = process.argv.slice(2);

async function promptPassword(label = 'Password: ') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question(label);
  rl.close();
  if (!pw || pw.length < 8) { console.error('password must be ≥ 8 chars'); process.exit(1); }
  return pw;
}

switch (cmd) {
  case 'create-user': {
    if (!arg) { console.error('usage: create-user <name> [--owner]'); process.exit(1); }
    const role = process.argv.includes('--owner') ? 'owner' : 'friend';
    const pw = await promptPassword();
    const id = await createUser(arg, pw, role);
    console.log(`created user #${id} ${arg} (${role})`);
    break;
  }
  case 'set-password': {
    if (!arg) { console.error('usage: set-password <name>'); process.exit(1); }
    const pw = await promptPassword('New password: ');
    const r = db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?')
      .run(await hashPassword(pw), arg);
    console.log(r.changes ? 'updated' : 'no such user');
    break;
  }
  case 'unban': {
    if (!arg) { console.error('usage: unban <ip-or-username|all>'); process.exit(1); }
    const r = arg === 'all'
      ? db.prepare('DELETE FROM login_attempts').run()
      : db.prepare('DELETE FROM login_attempts WHERE key IN (?, ?)')
          .run(`ip:${arg}`, `user:${arg.toLowerCase()}`);
    console.log(`cleared ${r.changes} lockout record(s)`);
    break;
  }
  case 'list-bans': {
    const rows = db.prepare('SELECT * FROM login_attempts ORDER BY updated_at DESC').all();
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      const state = r.locked_until > now ? `LOCKED ${Math.ceil((r.locked_until - now) / 60)}m` : 'counting';
      console.log(`${r.key}  fails=${r.fails}  ${state}`);
    }
    if (!rows.length) console.log('no lockout records');
    break;
  }
  case 'list-users': {
    for (const u of db.prepare('SELECT id, username, role FROM users ORDER BY id').all())
      console.log(`#${u.id}  ${u.username}  (${u.role})`);
    break;
  }
  default:
    console.log('commands: create-user, set-password, unban, list-bans, list-users');
}
