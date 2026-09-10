'use strict';

/*
 * weKnow Staff Bookings — Postgres smoke test
 *
 *   WK_DATABASE_URL="postgresql://..." node test-pg.js
 *
 * Runs the same end-to-end API checks as test.js, but with the server storing
 * everything in Postgres and nothing on disk. Then it restarts the server
 * against the same database and re-checks the data — which is the whole point
 * of the exercise: surviving a restart is what a disk-less host cannot do with
 * files.
 *
 * Works in a throwaway schema (wk_test) and drops it at the end, so it is safe
 * to point at the real database.
 */

const { spawn } = require('child_process');
const path = require('path');

require('./load-env')();

const PORT = process.env.TEST_PORT || 4197;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PW = 'testpassword123';
const SCHEMA = 'wk_test';
const DATABASE_URL = process.env.WK_DATABASE_URL || '';

if (!DATABASE_URL) {
  console.log('\n  WK_DATABASE_URL is not set — nothing to test against.');
  console.log('  Put it in staff/.env, or pass it inline:');
  console.log('    WK_DATABASE_URL="postgresql://..." npm run staff:test:pg\n');
  process.exit(0);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function req(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: Object.assign(
      body ? { 'Content-Type': 'application/json' } : {},
      cookie ? { Cookie: cookie } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const payload = ct.indexOf('application/json') >= 0 ? await res.json() : await res.text();
  return { status: res.status, ct, payload };
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status === 200) return true; } catch (e) {}
    await sleep(100);
  }
  return false;
}

let server = null;
function boot() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      WK_DATABASE_URL: DATABASE_URL,
      WK_PG_SCHEMA: SCHEMA,
      WK_ADMIN_PASSWORD: ADMIN_PW,
      WK_ADMIN_CONTACT: 'it@example.com'
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  return server;
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(resolve, 4000);
  });
}

async function dropSchema() {
  process.env.WK_PG_SCHEMA = SCHEMA;
  const store = require('./store-pg');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try { await pool.query('drop schema if exists ' + SCHEMA + ' cascade'); } finally { await pool.end(); }
  return store;
}

(async () => {
  let done = false;
  const cleanup = async () => {
    if (done) return; done = true;
    await stopServer();
    try { await dropSchema(); } catch (e) { console.log('  (could not drop ' + SCHEMA + ': ' + e.message + ')'); }
  };

  try {
    console.log('\nweKnow Staff Bookings — Postgres smoke test');
    console.log('schema: ' + SCHEMA + '  (created and dropped by this test)\n');

    // Start from a clean slate in case a previous run died mid-way.
    await dropSchema();

    boot();
    ok('server starts against Postgres', await waitForServer());

    let r = await req('GET', '/api/bookings');
    ok('unauthenticated API call is rejected', r.status === 401, 'got ' + r.status);

    r = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
    ok('admin can sign in', r.status === 200 && r.payload.user && r.payload.user.role === 'admin', 'got ' + r.status);

    r = await req('GET', '/api/bookings');
    ok('seed data was written to Postgres', r.status === 200 && r.payload.bookings.length === 17,
      'count ' + (r.payload.bookings && r.payload.bookings.length));

    r = await req('POST', '/api/bookings', {
      name: 'Durability Test', client: 'QA Client', roles: ['QA'], status: 'Safe',
      start: '2026-01-01', end: '2026-06-30', notes: 'written before a restart'
    });
    ok('create booking', r.status === 201 && r.payload.id, 'got ' + r.status);
    const id = r.payload.id;

    r = await req('PATCH', '/api/bookings/' + id, { status: 'Risk' });
    ok('patch booking', r.status === 200 && r.payload.status === 'Risk');

    r = await req('GET', '/api/config');
    ok('config round-trips through Postgres', r.status === 200 && r.payload.config.fields.length >= 13);
    ok('new client was auto-registered', (r.payload.config.clients || []).some((c) => c.name === 'QA Client'));

    // a 1x1 png, to prove avatars are stored as rows rather than files
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await req('POST', '/api/auth/avatar', { dataUrl: png });
    ok('avatar upload accepted', r.status === 200 && r.payload.user.avatar, 'got ' + r.status);
    const avatarUrl = r.payload.user && r.payload.user.avatar;

    if (avatarUrl) {
      const av = await fetch(BASE + avatarUrl, { headers: { Cookie: cookie } });
      ok('avatar is served back from Postgres', av.status === 200 && (av.headers.get('content-type') || '').indexOf('image/png') >= 0,
        'got ' + av.status);
    }

    r = await req('GET', '/api/audit');
    ok('activity log lists recent events', r.status === 200 && r.payload.events.some((e) => e.action === 'booking.create'));

    r = await req('GET', '/api/bookings/export.csv');
    ok('CSV export works', r.status === 200 && r.ct.indexOf('text/csv') >= 0 && r.payload.indexOf('Durability Test') >= 0);

    // ---- the part that files on a disk-less host cannot do ----
    console.log('\n  restarting the server against the same database...\n');
    await stopServer();
    cookie = '';
    boot();
    ok('server restarts', await waitForServer());

    r = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
    ok('the admin account survived the restart', r.status === 200, 'got ' + r.status);

    r = await req('GET', '/api/bookings');
    const survivor = (r.payload.bookings || []).find((b) => b.id === id);
    ok('the booking survived the restart', !!survivor, 'not found among ' + (r.payload.bookings || []).length);
    ok('and kept its edit', survivor && survivor.status === 'Risk', survivor && survivor.status);

    r = await req('GET', '/api/config');
    ok('the field config survived the restart', (r.payload.config.clients || []).some((c) => c.name === 'QA Client'));

    r = await req('GET', '/api/audit');
    ok('the activity log survived the restart', r.payload.events.some((e) => e.action === 'booking.create'));

    r = await req('DELETE', '/api/bookings/' + id);
    ok('delete booking', r.status === 200 && r.payload.ok);
    await sleep(300);
    r = await req('GET', '/api/bookings');
    ok('booking count back to 17', r.payload.bookings.length === 17, 'count ' + r.payload.bookings.length);

    r = await req('POST', '/api/auth/logout');
    ok('logout', r.status === 200);
    r = await req('GET', '/api/bookings');
    ok('API rejects calls after logout', r.status === 401);
  } catch (e) {
    fail++;
    console.log('\n  ! test run threw: ' + ((e && e.stack) || e));
  }

  await cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
