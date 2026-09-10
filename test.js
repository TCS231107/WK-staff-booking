'use strict';

/*
 * weKnow Staff Bookings — smoke test
 * Zero dependencies. Node >= 18.
 *
 *   node test.js
 *
 * Boots the real server against a throwaway data directory on a spare port,
 * exercises the API end to end, then shuts it down and cleans up.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.TEST_PORT || 4199;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PW = 'testpassword123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-test-'));

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
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status === 200) return true; } catch (e) {}
    await sleep(100);
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      WK_DATA_DIR: dataDir,
      WK_ADMIN_PASSWORD: ADMIN_PW,
      WK_ADMIN_CONTACT: 'it@example.com'
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  let done = false;
  const cleanup = () => {
    if (done) return; done = true;
    try { server.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', cleanup);

  try {
    console.log('\nweKnow Staff Bookings — smoke test');
    console.log('data dir: ' + dataDir + '\n');

    ok('server starts and serves the app', await waitForServer());

    let r = await req('GET', '/api/bookings');
    ok('unauthenticated API call is rejected', r.status === 401, 'got ' + r.status);

    r = await req('GET', '/api/auth/context');
    ok('/api/auth/context is public', r.status === 200 && r.payload.adminContact === 'it@example.com');

    r = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    ok('bad password is rejected', r.status === 401);

    r = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
    ok('admin can sign in', r.status === 200 && r.payload.user && r.payload.user.role === 'admin', 'got ' + r.status);
    ok('session cookie was set', /wk_session=/.test(cookie));

    r = await req('GET', '/api/bookings');
    ok('seed data is present', r.status === 200 && Array.isArray(r.payload.bookings) && r.payload.bookings.length === 17,
      'count ' + (r.payload.bookings && r.payload.bookings.length));

    r = await req('POST', '/api/bookings', {
      name: 'Test Person', client: 'QA Client', roles: ['QA'], status: 'Safe',
      start: '2026-01-01', end: '2026-06-30', notes: 'created by test.js'
    });
    ok('create booking', r.status === 201 && r.payload.id, 'got ' + r.status);
    const id = r.payload.id;

    r = await req('PATCH', '/api/bookings/' + id, { status: 'Risk' });
    ok('patch booking', r.status === 200 && r.payload.status === 'Risk');

    r = await req('GET', '/api/config');
    ok('config has field list', r.status === 200 && Array.isArray(r.payload.config.fields) && r.payload.config.fields.length >= 13);
    ok('new client was auto-registered', (r.payload.config.clients || []).some((c) => c.name === 'QA Client'));

    r = await req('GET', '/api/bookings/export.csv');
    ok('CSV export returns text/csv', r.status === 200 && r.ct.indexOf('text/csv') >= 0);
    ok('CSV has a header row and the test booking', typeof r.payload === 'string' && r.payload.indexOf('Employee') >= 0 && r.payload.indexOf('Test Person') >= 0);

    r = await req('GET', '/api/audit');
    ok('audit log lists recent events', r.status === 200 && r.payload.events.some((e) => e.action === 'booking.create'));

    r = await req('DELETE', '/api/bookings/' + id);
    ok('delete booking', r.status === 200 && r.payload.ok);
    r = await req('GET', '/api/bookings');
    ok('booking count back to 17', r.payload.bookings.length === 17);

    // backups should have been written for bookings.json
    const backups = fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')) : [];
    ok('a data backup was written', backups.some((f) => f.indexOf('bookings.') === 0));

    r = await req('POST', '/api/auth/logout');
    ok('logout', r.status === 200);
    r = await req('GET', '/api/bookings');
    ok('API rejects calls after logout', r.status === 401);
  } catch (e) {
    fail++;
    console.log('\n  ! test run threw: ' + (e && e.stack || e));
  }

  cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
