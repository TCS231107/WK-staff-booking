'use strict';

/*
 * Postgres storage for weKnow Staff Bookings.
 *
 * Active only when WK_DATABASE_URL is set; without it the server keeps using
 * the JSON files it always used, so the standalone install is unchanged.
 *
 * The app keeps everything in memory and re-reads from storage only at boot,
 * so this module is deliberately shaped the same way: one bulk read on start,
 * then whole-collection writes on change. At this size (tens of bookings, a
 * handful of accounts) writing the whole collection is cheaper to reason about
 * than diffing, and it keeps the file and database paths behaving identically.
 *
 * Everything lives in the "wk" schema rather than "public": Supabase exposes
 * public over its REST API, where the publishable key would be enough to read
 * the users table — which holds password hashes. A non-exposed schema keeps
 * these tables off that API entirely. Row-level security is enabled on top of
 * that as a second lock; the owning role we connect as is unaffected by it.
 */

const { Pool } = require('pg');

// Overridable so the test suite can work in a throwaway schema instead of the
// live one. Validated because it is interpolated straight into SQL below.
const SCHEMA = process.env.WK_PG_SCHEMA || 'wk';
if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) {
  throw new Error('WK_PG_SCHEMA must be a plain identifier, got: ' + SCHEMA);
}
const AUDIT_KEEP = 5000;   // trim the activity log so it can't grow forever
const BACKUP_KEEP = 40;    // matches the file backend's per-file snapshot count

const DDL = `
create schema if not exists ${SCHEMA};

create table if not exists ${SCHEMA}.bookings (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ${SCHEMA}.users (
  username   text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- config blob and the session-signing key
create table if not exists ${SCHEMA}.state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ${SCHEMA}.audit (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  action text,
  actor  text,
  detail jsonb
);

create table if not exists ${SCHEMA}.backups (
  id      bigserial primary key,
  name    text not null,
  at      timestamptz not null default now(),
  payload jsonb not null
);

-- avatars and invite preview emails; on a disk-less host these would otherwise
-- disappear on the next deploy
create table if not exists ${SCHEMA}.assets (
  path       text primary key,
  mime       text not null,
  bytes      bytea not null,
  updated_at timestamptz not null default now()
);

create index if not exists audit_recent_idx  on ${SCHEMA}.audit (id desc);
create index if not exists backups_name_idx  on ${SCHEMA}.backups (name, id desc);

alter table ${SCHEMA}.bookings enable row level security;
alter table ${SCHEMA}.users    enable row level security;
alter table ${SCHEMA}.state    enable row level security;
alter table ${SCHEMA}.audit    enable row level security;
alter table ${SCHEMA}.backups  enable row level security;
alter table ${SCHEMA}.assets   enable row level security;

-- A flattened, read-only view for browsing bookings in the Supabase table
-- editor. The app never reads it; drop it and nothing breaks.
create or replace view ${SCHEMA}.bookings_readable as
select
  id,
  data->>'name'                        as employee,
  data->>'client'                      as client,
  data->>'status'                      as status,
  nullif(data->>'start', '')::date     as starts,
  nullif(data->>'end',   '')::date     as ends,
  data->>'mainPM'                      as main_pm,
  data->>'deliveryManager'             as delivery_manager,
  (data->>'billable')::boolean         as billable,
  data->>'notes'                       as notes,
  updated_at
from ${SCHEMA}.bookings;
`;

let pool = null;

function connect(connectionString) {
  // TLS on by default - hosted Postgres requires it - but off for a local
  // database that doesn't offer it, via ?sslmode=disable in the URL. Supabase
  // presents a certificate that doesn't chain to a public root, so verification
  // is relaxed; the connection is still encrypted.
  const noSsl = /[?&]sslmode=disable\b/.test(connectionString);
  pool = new Pool({
    connectionString: connectionString,
    ssl: noSsl ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  // A dropped idle connection must not take the process down with it.
  pool.on('error', (err) => console.error('  Postgres pool error:', err.message));
  return pool;
}

async function init(connectionString) {
  connect(connectionString);
  await pool.query(DDL);
}

function q(text, params) { return pool.query(text, params); }

// ------------------------------------------------------------------ reading
// One round trip per collection at boot; the server caches all of it.
async function loadBookings() {
  const r = await q(`select data from ${SCHEMA}.bookings order by id`);
  return r.rows.map((row) => row.data);
}

async function loadUsers() {
  const r = await q(`select data from ${SCHEMA}.users order by username`);
  return r.rows.map((row) => row.data);
}

async function loadState(key) {
  const r = await q(`select value from ${SCHEMA}.state where key = $1`, [key]);
  return r.rows.length ? r.rows[0].value : null;
}

async function saveState(key, value) {
  await q(
    `insert into ${SCHEMA}.state (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// ------------------------------------------------------------------ writing
// Replace a whole collection: upsert everything present, delete what's gone,
// in one transaction so a failure can't leave a half-written roster behind.
async function replaceCollection(table, idColumn, rows, idOf) {
  const ids = rows.map(idOf);
  const payloads = rows.map((r) => JSON.stringify(r));
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (ids.length) {
      await client.query(
        `insert into ${SCHEMA}.${table} (${idColumn}, data, updated_at)
         select t.id, t.data, now()
           from unnest($1::text[], $2::jsonb[]) as t(id, data)
         on conflict (${idColumn}) do update
           set data = excluded.data, updated_at = now()`,
        [ids, payloads]
      );
      await client.query(
        `delete from ${SCHEMA}.${table} where not (${idColumn} = any($1::text[]))`,
        [ids]
      );
    } else {
      await client.query(`delete from ${SCHEMA}.${table}`);
    }
    await client.query('commit');
  } catch (e) {
    try { await client.query('rollback'); } catch (x) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

function saveBookings(list) {
  return replaceCollection('bookings', 'id', list || [], (b) => String(b.id));
}

function saveUsers(list) {
  return replaceCollection('users', 'username', list || [], (u) => String(u.username));
}

// ------------------------------------------------------------------- audit
async function appendAudit(rec) {
  await q(
    `insert into ${SCHEMA}.audit (at, action, actor, detail) values ($1, $2, $3, $4)`,
    [rec.t || new Date().toISOString(), rec.action || null, rec.actor || null, JSON.stringify(rec)]
  );
  // Cheap opportunistic trim; the log is read newest-first and capped anyway.
  if (Math.random() < 0.02) {
    await q(
      `delete from ${SCHEMA}.audit where id <= (
         select id from ${SCHEMA}.audit order by id desc offset $1 limit 1
       )`,
      [AUDIT_KEEP]
    ).catch(() => {});
  }
}

async function readAudit(limit) {
  const r = await q(
    `select detail from ${SCHEMA}.audit order by id desc limit $1`,
    [limit || 300]
  );
  return r.rows.map((row) => row.detail);
}

// ----------------------------------------------------------------- backups
async function snapshot(name, payload) {
  await q(
    `insert into ${SCHEMA}.backups (name, payload) values ($1, $2)`,
    [name, JSON.stringify(payload)]
  );
  await q(
    `delete from ${SCHEMA}.backups
      where name = $1
        and id <= (select id from ${SCHEMA}.backups where name = $1
                    order by id desc offset $2 limit 1)`,
    [name, BACKUP_KEEP]
  ).catch(() => {});
}

// ------------------------------------------------------------------ assets
async function putAsset(assetPath, mime, bytes) {
  await q(
    `insert into ${SCHEMA}.assets (path, mime, bytes, updated_at) values ($1, $2, $3, now())
     on conflict (path) do update
       set mime = excluded.mime, bytes = excluded.bytes, updated_at = now()`,
    [assetPath, mime, bytes]
  );
}

async function getAsset(assetPath) {
  const r = await q(`select mime, bytes from ${SCHEMA}.assets where path = $1`, [assetPath]);
  return r.rows.length ? r.rows[0] : null;
}

async function deleteAssets(paths) {
  if (!paths || !paths.length) return;
  await q(`delete from ${SCHEMA}.assets where path = any($1::text[])`, [paths]);
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = {
  init,
  loadBookings,
  loadUsers,
  loadState,
  saveState,
  saveBookings,
  saveUsers,
  appendAudit,
  readAudit,
  snapshot,
  putAsset,
  getAsset,
  deleteAssets,
  close,
  SCHEMA,
};
