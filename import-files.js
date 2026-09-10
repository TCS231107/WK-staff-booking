'use strict';

/*
 * Copy an existing file-based install into Postgres.
 *
 *   WK_DATABASE_URL="postgresql://..." node import-files.js [data-dir]
 *
 * Reads bookings.json, config.json, users.json, .session-secret and audit.log
 * from the given directory (default: ./data, or WK_DATA_DIR) and writes them to
 * the database the server would read on boot.
 *
 * Safe to re-run: it replaces whole collections rather than appending, so the
 * database ends up matching the files. It refuses to run against a database
 * that already holds bookings unless you pass --replace, so nobody wipes live
 * data by re-running an old command.
 */

const fs = require('fs');
const path = require('path');

require('./load-env')();

const store = require('./store-pg');

const args = process.argv.slice(2);
const replace = args.indexOf('--replace') !== -1;
const dirArg = args.filter((a) => a.indexOf('--') !== 0)[0];
const DATA_DIR = path.resolve(dirArg || process.env.WK_DATA_DIR || path.join(__dirname, 'data'));
const DATABASE_URL = process.env.WK_DATABASE_URL || '';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { return fallback; }
}

async function main() {
  if (!DATABASE_URL) {
    console.error('Set WK_DATABASE_URL to the database you want to import into.');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_DIR)) {
    console.error('No such data directory: ' + DATA_DIR);
    process.exit(1);
  }

  console.log('\n  Importing from  ' + DATA_DIR);
  await store.init(DATABASE_URL);

  const existing = await store.loadBookings();
  if (existing.length && !replace) {
    console.error('\n  The database already holds ' + existing.length + ' bookings.');
    console.error('  Re-run with --replace if you really mean to overwrite them.\n');
    await store.close();
    process.exit(1);
  }

  const bookings = readJson('bookings.json', []);
  const users = readJson('users.json', []);
  const config = readJson('config.json', null);

  if (bookings.length) {
    await store.saveBookings(bookings);
    console.log('  bookings        ' + bookings.length);
  }
  if (users.length) {
    await store.saveUsers(users);
    console.log('  accounts        ' + users.length + '   (password hashes carried over, everyone keeps their password)');
  }
  if (config) {
    await store.saveState('config', config);
    console.log('  field config    imported');
  }

  // Carrying the signing key over means nobody is forced to sign in again.
  try {
    const secret = fs.readFileSync(path.join(DATA_DIR, '.session-secret'), 'utf8').trim();
    if (secret) { await store.saveState('session_secret', secret); console.log('  session key     carried over (open sessions stay valid)'); }
  } catch (e) { /* a fresh key will be minted on first boot */ }

  // Activity log, newest last so ids stay in chronological order.
  let auditLines = [];
  try { auditLines = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8').trim().split(/\n/); } catch (e) {}
  let events = 0;
  for (const line of auditLines) {
    if (!line.trim()) continue;
    try { await store.appendAudit(JSON.parse(line)); events++; } catch (e) { /* skip unparseable lines */ }
  }
  if (events) console.log('  activity log    ' + events + ' entries');

  // Avatars, so profile photos survive the move.
  const avatarDir = path.join(__dirname, 'public', 'avatars');
  let avatars = 0;
  try {
    for (const file of fs.readdirSync(avatarDir)) {
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
      if (['png', 'jpg', 'jpeg', 'webp'].indexOf(ext) === -1) continue;
      await store.putAsset('/avatars/' + file, mime, fs.readFileSync(path.join(avatarDir, file)));
      avatars++;
    }
  } catch (e) { /* no avatars to move */ }
  if (avatars) console.log('  avatars         ' + avatars);

  await store.close();
  console.log('\n  Done. Start the server with the same WK_DATABASE_URL and everything should be there.\n');
}

main().catch((e) => {
  console.error('\n  Import failed: ' + ((e && e.message) || e) + '\n');
  process.exit(1);
});
