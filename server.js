'use strict';

/*
 * weKnow Staff Bookings — local server
 * Zero dependencies. Node >= 18.
 *
 *   node server.js            (then open http://localhost:4173)
 *   PORT=5000 node server.js
 *
 * Data is persisted to ./data/bookings.json  and  ./data/config.json
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// --- load .env (simple KEY=VALUE lines) before anything reads process.env ---
(function loadDotEnv() {
  let txt;
  try { txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return; }
  txt.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  });
})();

const PORT = process.env.PORT || 4173;
// Mount point. Empty => the app owns the whole origin (standalone, as before).
// Set WK_BASE_PATH=/staff to serve it under weknowinc.com/staff behind the
// main Next.js site; the prefix is stripped from requests and pushed back into
// every root-relative URL the app hands out (API calls, brand assets, avatars).
const BASE_PATH = String(process.env.WK_BASE_PATH || '').replace(/\/+$/, '');
// Bind address. 127.0.0.1 keeps the sidecar unreachable except through the proxy.
const BIND = process.env.WK_BIND || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.WK_DATA_DIR ? path.resolve(process.env.WK_DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

// --- optional HTTPS: point WK_TLS_CERT / WK_TLS_KEY at PEM files ---
function tlsOptions() {
  const cert = process.env.WK_TLS_CERT, key = process.env.WK_TLS_KEY;
  if (!cert || !key) return null;
  try { return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }; }
  catch (e) { console.error('  TLS cert/key unreadable (' + e.message + ') - starting on HTTP instead.'); return null; }
}
const TLS_OPTS = tlsOptions();
// Behind a proxy that terminates TLS (Cloudflare -> Render) this process speaks
// plain HTTP but the browser is on https, so the session cookie still needs
// Secure. WK_SECURE_COOKIES=1 forces it on.
const SECURE_COOKIES = !!TLS_OPTS || /^(1|true|yes)$/i.test(process.env.WK_SECURE_COOKIES || '');

// --- point-in-time backups: snapshot a data file before it is overwritten ---
const BACKUP_KEEP = 40;
const backupLast = {};
function backupFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const name = path.basename(file).replace(/\.json$/, '');
    const now = Date.now();
    if (backupLast[name] && now - backupLast[name] < 5 * 60 * 1000) return; // at most one snapshot / 5 min / file
    backupLast[name] = now;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(BACKUP_DIR, name + '.' + stamp + '.json'));
    const mine = fs.readdirSync(BACKUP_DIR).filter((f) => f.indexOf(name + '.') === 0).sort();
    while (mine.length > BACKUP_KEEP) { try { fs.unlinkSync(path.join(BACKUP_DIR, mine.shift())); } catch (e) {} }
  } catch (e) { /* backups are best-effort, never block a write */ }
}

// --- append-only audit trail (one JSON object per line) ---
function audit(action, actor, detail) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const rec = { t: new Date().toISOString(), action: action, actor: actor || null };
    if (detail && typeof detail === 'object') Object.assign(rec, detail);
    fs.appendFile(AUDIT_FILE, JSON.stringify(rec) + '\n', () => {});
  } catch (e) {}
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
}
function adminContact() { return process.env.WK_ADMIN_CONTACT || ''; }

// ---------------------------------------------------------------- seed data
const SEED = [
  { name: 'Camilo Vanegas', roles: ['Drupal Full Stack'], client: 'Phase2', status: 'Safe', start: '2026-06-01', end: '2026-12-31', mainPM: 'Angelia Spell', pmEmail: 'aspell@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Mastercard (MBI) 2026-2027 team project.' },
  { name: 'Diego Sabolo', roles: ['Drupal Back End'], client: 'Phase2', status: 'Risk', start: '2024-04-01', end: '2026-09-30', mainPM: 'Terri Scales', pmEmail: 'tscales@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'MSK: CMS platform team.' },
  { name: 'Gerardo Rodríguez', roles: ['Sitecore', 'Drupal Back End'], client: 'Phase2', status: 'Safe', start: '2025-07-21', end: '2026-11-15', mainPM: 'Mara Rice', pmEmail: 'mrice@phase2technology.io', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Geisinger: website modernization.' },
  { name: 'Humberto Luna', roles: ['Drupal Back End'], client: 'Phase2', status: 'Safe', start: '2024-08-03', end: '2027-03-30', mainPM: 'Tom Belliveau', pmEmail: 'tbelliveau@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'US Naval Institute: 2026 optimize project.' },
  { name: 'José Amaral', roles: ['Drupal Full Stack'], client: 'Phase2', status: 'Exit', start: '2024-04-01', end: '2026-09-30', mainPM: 'Kristy Cook', pmEmail: 'kcook@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'American Board of Anesthesiology: certification app.' },
  { name: 'Manuel Santibáñez', roles: ['Drupal Full Stack'], client: 'Phase2', status: 'Safe', start: '2025-07-19', end: '2026-12-20', mainPM: 'Ana Cosma', pmEmail: 'acosma@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Mastercard (MBI) 2026-2027 team project.' },
  { name: 'William Ranvaud', roles: ['Drupal Back End', 'Salesforce'], client: 'Phase2', status: 'Risk', start: '2025-08-05', end: '2026-10-31', mainPM: 'Ana Cosma', pmEmail: 'acosma@phase2technology.com', deliveryManager: 'Matías Vessuri', billable: false, contract: '', notes: 'New York Cares: Martech / winter wishes project.' },
  { name: 'Arturo Linares', roles: ['Drupal Back End'], client: 'Renesas', status: 'Safe', start: '2024-02-01', end: '2027-02-05', mainPM: 'Joel Pineda', pmEmail: 'joel.pineda.sx@renesas.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Renesas retained team.' },
  { name: 'Daniel Vásquez', roles: ['QA'], client: 'Renesas', status: 'Safe', start: '2023-06-28', end: '2027-02-05', mainPM: 'Joel Pineda', pmEmail: 'joel.pineda.sx@renesas.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Renesas retained team.' },
  { name: 'John Alvarez', roles: ['Drupal Front End', 'React'], client: 'Renesas', status: 'Safe', start: '2024-09-15', end: '2027-02-05', mainPM: 'Joel Pineda', pmEmail: 'joel.pineda.sx@renesas.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Renesas retained team.' },
  { name: 'Mariano Vega', roles: ['QA'], client: 'Renesas', status: 'N/A', start: '2026-08-24', end: '2027-02-05', mainPM: 'Joel Pineda', pmEmail: 'joel.pineda.sx@renesas.com', deliveryManager: 'Matías Vessuri', billable: false, contract: '', notes: 'Renesas retained team - ramp pending.' },
  { name: 'Lucas Grecco', roles: ['Drupal Full Stack', 'Cloud Architect'], client: 'World Kinect', status: 'Safe', start: '2023-05-15', end: '2026-12-31', mainPM: 'Tom Belliveau', pmEmail: 'tbelliveau@phase2technology.com', deliveryManager: 'Eduardo García', billable: true, contract: '', notes: '42-site Drupal Domain Access consolidation on Pantheon.' },
  { name: 'Ricardo Roldán', roles: ['Drupal Full Stack', 'DevOps'], client: 'World Kinect', status: 'Risk', start: '2025-08-25', end: '2026-10-15', mainPM: 'Ana Cosma', pmEmail: 'acosma@phase2technology.com', deliveryManager: 'Eduardo García', billable: true, contract: '', notes: 'Deployment pipeline hardening.' },
  { name: 'Bruno Scholtz', roles: ['Drupal Full Stack'], client: 'Mommy Poppins', status: 'Exit', start: '2025-10-20', end: '2026-09-20', mainPM: 'Matías Vessuri', pmEmail: 'mvessuri@weknowinc.com', deliveryManager: 'Matías Vessuri', billable: true, contract: '', notes: 'Support retainer FY26 - renewal in discussion.' },
  { name: 'Valentina Ortiz', roles: ['React', 'Next.js', 'UX / UI'], client: 'Propiedades.cr', status: 'Safe', start: '2025-08-01', end: '2027-01-31', mainPM: 'Andres Ávila', pmEmail: 'aavila@weknowinc.com', deliveryManager: 'Andres Ávila', billable: true, contract: '', notes: 'PropTech portal - AI search & listings platform.' },
  { name: 'Sebastián Rojas', roles: ['Python', 'Data Engineer', 'AI / ML'], client: 'Propiedades.cr', status: 'Safe', start: '2025-09-15', end: '2027-01-31', mainPM: 'Andres Ávila', pmEmail: 'aavila@weknowinc.com', deliveryManager: 'Andres Ávila', billable: true, contract: '', notes: 'Automated data aggregation from 50+ agencies.' },
  { name: 'Fernanda Castro', roles: ['GIS / ArcGIS', 'Python'], client: 'Essential Utilities', status: 'Risk', start: '2026-01-08', end: '2026-11-30', mainPM: 'Kristy Cook', pmEmail: 'kcook@phase2technology.com', deliveryManager: 'Eduardo García', billable: true, contract: '', notes: 'ArcGIS Utility Network implementation.' }
];

const STATUS_LEGACY = { 'At risk': 'Risk', 'Rolling off': 'Exit', 'On hold': 'N/A' };

const DEFAULT_ROLES = [
  'Drupal Full Stack', 'Drupal Back End', 'Drupal Front End',
  'React', 'Next.js', 'Node.js', 'PHP / Symfony', 'Python',
  'QA', 'DevOps', 'UX / UI', 'Cloud Architect', 'Data Engineer',
  'AI / ML', 'GIS / ArcGIS', 'Salesforce', 'Sitecore'
];
const DEFAULT_DMS = ['Matías Vessuri', 'Eduardo García', 'Andres Ávila', 'Kenny Abarca Coto'];

// the built-in booking fields. label/hidden/order are user-editable; key/type/builtin are fixed.
const BUILTIN_FIELDS = [
  { key: 'name', label: 'Employee', type: 'text' },
  { key: 'client', label: 'Client', type: 'select' },
  { key: 'roles', label: 'Technical profile', type: 'multiselect' },
  { key: 'status', label: 'Status', type: 'select' },
  { key: 'start', label: 'Start', type: 'date' },
  { key: 'end', label: 'End', type: 'date' },
  { key: 'toEnd', label: 'To end', type: 'calc' },
  { key: 'mainPM', label: 'Main PM', type: 'text' },
  { key: 'pmEmail', label: 'PM email', type: 'email', hidden: true },
  { key: 'deliveryManager', label: 'Delivery manager', type: 'select', hidden: true },
  { key: 'billable', label: 'Billable', type: 'checkbox', hidden: true },
  { key: 'contract', label: 'Contract', type: 'url' },
  { key: 'notes', label: 'Notes', type: 'longtext' }
];
const CUSTOM_TYPES = ['text', 'number', 'date', 'checkbox', 'select'];

function defaultConfig() {
  return {
    statuses: [
      { name: 'Extend', color: '#dd5a1e' },
      { name: 'Safe', color: '#16a34a' },
      { name: 'Risk', color: '#c92a54' },
      { name: 'Exit', color: '#414852' },
      { name: 'N/A', color: '#8b9096' }
    ],
    clients: [],
    employees: [],
    roles: DEFAULT_ROLES.map((n) => ({ name: n })),
    deliveryManagers: DEFAULT_DMS.map((n) => ({ name: n })),
    fields: BUILTIN_FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, builtin: true, hidden: !!f.hidden }))
  };
}
function customFieldDefs() {
  return (loadConfig().fields || []).filter((f) => !f.builtin && f.type !== 'calc');
}

// deterministic pleasant colour from a string (kept in sync with the client)
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return Math.abs(h); }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}
function autoColor(name) {
  let hue = hashStr(name) % 360;
  if (hue < 40) hue += 40;
  return hslToHex(hue, 55, 48);
}

// ---------------------------------------------------------------- storage
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = SEED.map((b) => normalize(b, genId()));
    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2));
    console.log('Seeded ' + seeded.length + ' bookings -> ' + DATA_FILE);
  }
}
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
let saveTimer = null;
let cache = null;
function save(list) {
  cache = list;
  backupFile(DATA_FILE);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(list, null, 2), (err) => {
      if (err) console.error('write failed', err);
    });
  }, 60);
}
function db() { return cache || (cache = load()); }

// --- config ---
let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  try { configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { configCache = defaultConfig(); }
  if (!Array.isArray(configCache.fields) || !configCache.fields.length) {
    configCache.fields = defaultConfig().fields;
  }
  if (!Array.isArray(configCache.employees)) configCache.employees = [];
  return configCache;
}
function saveConfig(cfg) {
  configCache = cfg;
  backupFile(CONFIG_FILE);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function ensureConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
    const cfg = loadConfig();
    let dirty = !Array.isArray(raw.fields) || !raw.fields.length || !Array.isArray(raw.employees);
    // migrate the primary field label to "Employee" (once)
    const nameField = cfg.fields.find((f) => f.key === 'name');
    if (nameField && (nameField.label === 'Person' || nameField.label === 'Empleado')) { nameField.label = 'Employee'; dirty = true; }
    // backfill employees roster from existing bookings
    db().forEach((b) => { if (mergeFromBooking(cfg, b)) dirty = true; });
    if (dirty) { saveConfig(cfg); console.log('Updated ' + CONFIG_FILE + ' (employees roster / field labels)'); }
    return;
  }
  const cfg = defaultConfig();
  let changed = false;
  db().forEach((b) => { if (mergeFromBooking(cfg, b)) changed = true; });
  saveConfig(cfg);
  console.log('Wrote field config -> ' + CONFIG_FILE + (changed ? ' (with clients/roles from existing data)' : ''));
}
// add unknown clients / roles / delivery managers referenced by a booking. returns true if config changed.
function mergeFromBooking(cfg, b) {
  let changed = false;
  const has = (arr, n) => arr.some((o) => o.name === n);
  if (!Array.isArray(cfg.employees)) cfg.employees = [];
  if (b.name && b.name !== 'Unnamed' && !has(cfg.employees, b.name)) { cfg.employees.push({ name: b.name }); changed = true; }
  if (b.client && !has(cfg.clients, b.client)) { cfg.clients.push({ name: b.client, color: autoColor(b.client) }); changed = true; }
  (b.roles || []).forEach((r) => { if (r && !has(cfg.roles, r)) { cfg.roles.push({ name: r }); changed = true; } });
  if (b.deliveryManager && !has(cfg.deliveryManagers, b.deliveryManager)) { cfg.deliveryManagers.push({ name: b.deliveryManager }); changed = true; }
  return changed;
}
function afterBookingWrite(rec) {
  const cfg = loadConfig();
  if (mergeFromBooking(cfg, rec)) saveConfig(cfg);
}

function genId() { return 'bk_' + crypto.randomBytes(6).toString('hex'); }

function normalize(raw, id) {
  raw = raw || {};
  const roles = Array.isArray(raw.roles) ? raw.roles.filter(Boolean).map(String)
    : (raw.roles ? [String(raw.roles)] : []);
  let start = /^\d{4}-\d{2}-\d{2}$/.test(raw.start) ? raw.start : isoToday();
  let end = /^\d{4}-\d{2}-\d{2}$/.test(raw.end) ? raw.end : start;
  if (end < start) end = start;
  let status = STATUS_LEGACY[raw.status] || raw.status;
  status = String(status || 'Safe').slice(0, 60);
  return {
    id: id,
    name: String(raw.name || 'Unnamed').slice(0, 120),
    roles: roles.slice(0, 12),
    client: String(raw.client || 'Unassigned').slice(0, 120),
    status: status,
    start: start,
    end: end,
    mainPM: String(raw.mainPM || '').slice(0, 120),
    pmEmail: String(raw.pmEmail || '').slice(0, 160),
    deliveryManager: String(raw.deliveryManager || '').slice(0, 120),
    billable: !!raw.billable,
    contract: String(raw.contract || '').slice(0, 500),
    notes: String(raw.notes || '').slice(0, 2000),
    custom: sanitizeCustom(raw.custom),
    updatedAt: new Date().toISOString()
  };
}
function sanitizeCustom(src) {
  src = (src && typeof src === 'object') ? src : {};
  const out = {};
  customFieldDefs().forEach((f) => {
    if (!(f.key in src)) return;
    let v = src[f.key];
    if (f.type === 'number') { v = (v === '' || v == null) ? null : Number(v); if (Number.isNaN(v)) v = null; }
    else if (f.type === 'checkbox') v = !!v;
    else if (f.type === 'date') v = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
    else v = String(v == null ? '' : v).slice(0, 2000);
    out[f.key] = v;
  });
  return out;
}
function isoToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------------------------------------------------------------- auth
let secretCache = null;
function sessionSecret() {
  if (secretCache) return secretCache;
  try { secretCache = fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
  catch (e) { secretCache = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SECRET_FILE, secretCache, { mode: 0o600 }); } catch (x) {} }
  return secretCache;
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function setPassword(u, pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); }
function makeUser(username, pw, extra) {
  extra = extra || {};
  const u = {
    username: username, name: extra.name || username, email: extra.email || '',
    role: extra.role === 'admin' ? 'admin' : 'member',
    status: extra.status || 'active',
    mustChangePassword: !!extra.mustChangePassword,
    invitedBy: extra.invitedBy || '',
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  setPassword(u, pw);
  return u;
}
let usersCache = null;
function loadUsers() {
  if (usersCache) return usersCache;
  try { usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { usersCache = []; }
  usersCache.forEach((u) => {
    if (!u.status) u.status = 'active';
    if (u.role !== 'admin') u.role = 'member';
  });
  return usersCache;
}
function saveUsers() { backupFile(USERS_FILE); fs.writeFileSync(USERS_FILE, JSON.stringify(loadUsers(), null, 2), { mode: 0o600 }); }
function findUser(username) {
  const uname = String(username || '').trim().toLowerCase();
  return loadUsers().find((x) => x.username.toLowerCase() === uname);
}
function ensureUsers() {
  if (fs.existsSync(USERS_FILE)) { loadUsers(); return; }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const pw = process.env.WK_ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  const users = [makeUser('admin', pw, { name: 'weKnow Admin', email: adminContact() || 'admin@weknowinc.com', role: 'admin' })];
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
  usersCache = users;
  const line = '  Sign-in ready   username: admin   password: ' + pw + '  ';
  const bar = '  ' + '-'.repeat(line.length - 4) + '  ';
  console.log('\n' + bar + '\n' + line + '\n' + bar);
  console.log('  Change it in data/users.json, or set WK_ADMIN_PASSWORD before first run.\n');
}
function publicUser(u) {
  return {
    username: u.username, name: u.name, email: u.email || '', role: u.role || 'member',
    status: u.status || 'active', mustChangePassword: !!u.mustChangePassword,
    invitedBy: u.invitedBy || '', createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
    avatar: u.avatar || null
  };
}
function verifyLogin(username, pw) {
  const u = findUser(username);
  if (!u || u.status === 'disabled') return null;
  const got = Buffer.from(hashPw(pw, u.salt), 'hex');
  const want = Buffer.from(u.hash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return u;
}
function tempPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ', b = 'abcdefghijkmnpqrstuvwxyz', n = '23456789';
  const pick = (s, k) => Array.from({ length: k }, () => s[crypto.randomInt(s.length)]).join('');
  return pick(a, 2) + pick(b, 3) + '-' + pick(n, 4);
}
function signSession(username, ttlMs) {
  const payload = username + '|' + (Date.now() + ttlMs);
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return payload + '|' + sig;
}
function verifySession(token) {
  if (!token) return null;
  const i = token.lastIndexOf('|');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1), 'hex');
  const want = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  const j = payload.lastIndexOf('|');
  const username = payload.slice(0, j);
  const exp = Number(payload.slice(j + 1));
  if (!exp || Date.now() > exp) return null;
  return loadUsers().find((x) => x.username === username) || null;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function currentUser(req) { return verifySession(getCookie(req, 'wk_session')); }

// simple brute-force throttle per IP
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > 10 * 60 * 1000) { loginAttempts.delete(ip); return false; }
  return e.count >= 10;
}
function noteFailedLogin(ip) {
  const e = loginAttempts.get(ip) || { count: 0, first: Date.now() };
  e.count++; loginAttempts.set(ip, e);
}

const cookieFlags = '; HttpOnly; Path=' + (BASE_PATH || '/') + '; SameSite=Lax' + (SECURE_COOKIES ? '; Secure' : '');

async function handleAuth(req, res, sub, ip) {
  if (sub === 'context' && req.method === 'GET') {
    return sendJson(res, 200, { adminContact: adminContact(), appUrl: process.env.WK_APP_URL || '' });
  }
  if (sub === 'login' && req.method === 'POST') {
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const body = await readBody(req);
    const u = verifyLogin(body.username, body.password);
    if (!u) {
      noteFailedLogin(ip);
      audit('auth.login_failed', String(body.username || '').slice(0, 120).toLowerCase(), { ip: ip });
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    loginAttempts.delete(ip);
    u.lastLoginAt = new Date().toISOString();
    if (u.status === 'pending') u.status = 'active';
    saveUsers();
    audit('auth.login', u.username, { ip: ip });
    const ttl = body.remember ? 30 * 864e5 : 12 * 36e5;
    const token = signSession(u.username, ttl);
    res.setHeader('Set-Cookie', 'wk_session=' + encodeURIComponent(token) + cookieFlags + '; Max-Age=' + Math.floor(ttl / 1000));
    return sendJson(res, 200, { user: publicUser(u) });
  }
  if (sub === 'logout' && req.method === 'POST') {
    const cu = currentUser(req);
    if (cu) audit('auth.logout', cu.username, {});
    res.setHeader('Set-Cookie', 'wk_session=' + cookieFlags + '; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  if (sub === 'me' && req.method === 'GET') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { user: publicUser(u) });
  }
  if (sub === 'avatar') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });
    if (req.method === 'DELETE') {
      u.avatar = null; saveUsers();
      audit('auth.avatar_cleared', u.username, {});
      return sendJson(res, 200, { user: publicUser(u) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const m = String(body.dataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return sendJson(res, 400, { error: 'Send a PNG, JPEG or WebP image.' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 400 * 1024) return sendJson(res, 400, { error: 'Image is too large (max ~400 KB after resizing).' });
      try { if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (e) {}
      const base = crypto.createHash('sha1').update(u.username).digest('hex').slice(0, 12);
      ['png', 'jpg', 'webp'].forEach((x) => { try { fs.unlinkSync(path.join(AVATAR_DIR, base + '.' + x)); } catch (e) {} });
      fs.writeFileSync(path.join(AVATAR_DIR, base + '.' + ext), buf);
      u.avatar = BASE_PATH + '/avatars/' + base + '.' + ext + '?v=' + Date.now();
      saveUsers();
      audit('auth.avatar_set', u.username, {});
      return sendJson(res, 200, { user: publicUser(u) });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (sub === 'password' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });
    const body = await readBody(req);
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (!u.mustChangePassword) {
      const got = Buffer.from(hashPw(current, u.salt), 'hex');
      const want = Buffer.from(u.hash, 'hex');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return sendJson(res, 400, { error: 'Current password is incorrect.' });
    }
    if (next.length < 8) return sendJson(res, 400, { error: 'New password must be at least 8 characters.' });
    setPassword(u, next);
    u.mustChangePassword = false;
    saveUsers();
    audit('auth.password_change', u.username, {});
    return sendJson(res, 200, { user: publicUser(u) });
  }
  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// ---------------------------------------------------------------- team / invites
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
function inviteToken() { return crypto.randomBytes(20).toString('hex'); }

function appBaseUrl(req) {
  return process.env.WK_APP_URL || ((TLS_OPTS ? 'https://' : 'http://') + (req.headers.host || ('localhost:' + PORT)));
}

async function handleTeam(req, res, parts, me) {
  const target = parts[2] ? decodeURIComponent(parts[2]) : null;
  const action = parts[3] || null;
  const isAdmin = me.role === 'admin';

  if (req.method === 'GET' && !target) {
    return sendJson(res, 200, { members: loadUsers().map(publicUser), me: publicUser(me) });
  }

  // everything below is admin-only
  if (!isAdmin) return sendJson(res, 403, { error: 'Only administrators can manage the team.' });

  if (req.method === 'POST' && !target) {                       // invite
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim() || email.split('@')[0];
    const role = body.role === 'admin' ? 'admin' : 'member';
    if (!isEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (findUser(email)) return sendJson(res, 409, { error: 'Someone with that email is already on the team.' });
    const pw = tempPassword();
    const u = makeUser(email, pw, { name: name, email: email, role: role, status: 'pending', mustChangePassword: true, invitedBy: me.username });
    u.inviteToken = inviteToken();
    loadUsers().push(u);
    saveUsers();
    audit('team.invite', me.username, { email: email, role: role });
    const info = await deliverInvite(u, pw, me, appBaseUrl(req));
    return sendJson(res, 201, { member: publicUser(u), tempPassword: pw, email: info });
  }

  const u = target && findUser(target);
  if (!u) return sendJson(res, 404, { error: 'Member not found.' });

  if (req.method === 'POST' && action === 'resend') {           // resend invite
    const pw = tempPassword();
    setPassword(u, pw);
    u.mustChangePassword = true;
    u.status = 'pending';
    u.inviteToken = inviteToken();
    saveUsers();
    audit('team.resend', me.username, { email: u.username });
    const info = await deliverInvite(u, pw, me, appBaseUrl(req));
    return sendJson(res, 200, { member: publicUser(u), tempPassword: pw, email: info });
  }

  if (req.method === 'PATCH') {                                 // change role / status
    const body = await readBody(req);
    if (body.role === 'admin' || body.role === 'member') {
      if (u.username === me.username && body.role !== 'admin') return sendJson(res, 400, { error: "You can't remove your own admin access." });
      u.role = body.role;
    }
    if (body.status === 'active' || body.status === 'disabled') {
      if (u.username === me.username) return sendJson(res, 400, { error: "You can't change your own status." });
      if (body.status === 'disabled' && u.role === 'admin' && loadUsers().filter((x) => x.role === 'admin' && x.status !== 'disabled').length <= 1)
        return sendJson(res, 400, { error: 'At least one active administrator is required.' });
      u.status = body.status;
    }
    saveUsers();
    audit('team.update', me.username, { member: u.username, role: u.role, status: u.status });
    return sendJson(res, 200, { member: publicUser(u) });
  }

  if (req.method === 'DELETE') {                                // remove member
    if (u.username === me.username) return sendJson(res, 400, { error: "You can't remove yourself." });
    if (u.role === 'admin' && loadUsers().filter((x) => x.role === 'admin' && x.status !== 'disabled').length <= 1)
      return sendJson(res, 400, { error: 'At least one active administrator is required.' });
    usersCache = loadUsers().filter((x) => x.username !== u.username);
    saveUsers();
    audit('team.remove', me.username, { member: u.username });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

// write the invite email to a preview file and send it if SMTP is configured
async function deliverInvite(u, pw, inviter, baseUrl) {
  const html = renderInviteEmail({ name: u.name, email: u.email, tempPassword: pw, inviterName: inviter.name || inviter.username, appUrl: baseUrl });
  const dir = path.join(PUBLIC_DIR, 'invites');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const file = (u.inviteToken || inviteToken()) + '.html';
  try { fs.writeFileSync(path.join(dir, file), html); } catch (e) {}
  const previewUrl = baseUrl + '/invites/' + file;
  const smtp = smtpConfig();
  let sent = false, error = null;
  if (smtp) {
    try {
      await sendMail(smtp, { to: u.email, subject: 'You have access to weKnow Staff Bookings', html: html });
      sent = true;
    } catch (e) { error = String((e && e.message) || e); }
  }
  return { sent: sent, configured: !!smtp, previewUrl: previewUrl, error: error };
}

function smtpConfig() {
  const host = process.env.WK_SMTP_HOST;
  if (!host) return null;
  return {
    host: host,
    port: Number(process.env.WK_SMTP_PORT || 465),
    user: process.env.WK_SMTP_USER || '',
    pass: process.env.WK_SMTP_PASS || '',
    from: process.env.WK_SMTP_FROM || 'weKnow Staff Bookings <no-reply@weknowinc.com>'
  };
}

// minimal SMTP-over-implicit-TLS client (port 465). No dependencies.
function sendMail(cfg, msg) {
  const tls = require('tls');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
    let buf = '';
    const b64 = (s) => Buffer.from(String(s)).toString('base64');
    const steps = [
      { send: null, expect: 220 },
      { send: 'EHLO weknow.local', expect: 250 },
      { send: 'AUTH LOGIN', expect: 334 },
      { send: b64(cfg.user), expect: 334 },
      { send: b64(cfg.pass), expect: 235 },
      { send: 'MAIL FROM:<' + (cfg.from.match(/<([^>]+)>/) ? RegExp.$1 : cfg.from) + '>', expect: 250 },
      { send: 'RCPT TO:<' + msg.to + '>', expect: 250 },
      { send: 'DATA', expect: 354 },
      { send: buildMime(cfg.from, msg) + '\r\n.', expect: 250 },
      { send: 'QUIT', expect: 221 }
    ];
    let i = 0;
    function pump() {
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!/^\d{3}[ -]/.test(line)) continue;
        if (line[3] === '-') continue; // multiline continuation
        const code = Number(line.slice(0, 3));
        const step = steps[i];
        if (code !== step.expect) { socket.destroy(); return reject(new Error('SMTP ' + (step.send || '<greeting>') + ' -> ' + line)); }
        i++;
        if (i >= steps.length) { socket.end(); return resolve(true); }
        const next = steps[i];
        if (next.send != null) socket.write(next.send + '\r\n');
      }
    }
    socket.on('data', (d) => { buf += d; pump(); });
    socket.on('error', reject);
    socket.on('end', () => { if (i < steps.length) reject(new Error('SMTP connection closed early')); });
  });
}
function buildMime(from, msg) {
  return [
    'From: ' + from,
    'To: ' + msg.to,
    'Subject: ' + msg.subject,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.html.replace(/\r?\n\./g, '\n..') // dot-stuffing
  ].join('\r\n');
}

const WK_MARK_SVG =
  '<svg width="132" height="70" viewBox="0 0 800 422" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="weKnow">' +
  '<polygon points="107.67,416.15 12.07,416.15 237.98,6.29 333.57,6.29" fill="#f6a48d"/>' +
  '<polygon points="562.02,416.15 466.43,416.15 692.33,6.29 787.93,6.29" fill="#9a9a9a"/>' +
  '<polygon points="692.33,416.15 787.93,416.15 686.48,189.27 590.88,189.27" fill="#1a1a1a"/>' +
  '<polygon points="336.04,416.15 240.44,416.15 466.35,6.29 561.94,6.29" fill="#f6a48d"/>' +
  '<rect x="12.07" y="6.29" width="95.59" height="409.86" fill="#ee4723"/>' +
  '<rect x="237.97" y="6.29" width="95.59" height="409.86" fill="#ee4723"/>' +
  '<rect x="466.43" y="6.29" width="95.59" height="409.86" fill="#1a1a1a"/></svg>';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderInviteEmail(o) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>weKnow Staff Bookings</title></head>' +
    '<body style="margin:0;padding:0;background:#f4f1ef;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ef;padding:32px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e6e0dc;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
    '<tr><td style="height:4px;background:#ee4723;"></td></tr>' +
    '<tr><td align="center" style="padding:38px 40px 8px;">' + WK_MARK_SVG + '</td></tr>' +
    '<tr><td align="center" style="padding:14px 44px 0;">' +
      '<h1 style="margin:0;font-size:21px;line-height:1.3;color:#1c1917;font-weight:800;letter-spacing:-0.01em;">You now have access to weKnow Staff Bookings</h1>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 44px 0;color:#57534e;font-size:14px;line-height:1.65;">' +
      '<p style="margin:0 0 14px;">Hi ' + esc(o.name) + ',</p>' +
      '<p style="margin:0 0 14px;"><strong style="color:#1c1917;">' + esc(o.inviterName) + '</strong> added you to the weKnow Staff Bookings workspace &mdash; the shared timeline for planning engagements across every client account.</p>' +
      '<p style="margin:0 0 8px;">Sign in with these details:</p>' +
    '</td></tr>' +
    '<tr><td style="padding:6px 44px 0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f7;border:1px solid #e6e0dc;border-radius:10px;">' +
      '<tr><td style="padding:14px 16px;font-size:13px;color:#57534e;line-height:1.9;">' +
        'Email&nbsp;&nbsp;<strong style="color:#1c1917;">' + esc(o.email) + '</strong><br>' +
        'Temporary password&nbsp;&nbsp;<span style="display:inline-block;background:#fde68a;color:#1c1917;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;font-size:14px;padding:2px 8px;border-radius:5px;letter-spacing:0.02em;">' + esc(o.tempPassword) + '</span>' +
      '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:22px 44px 4px;">' +
      '<a href="' + esc(o.appUrl) + '" style="display:inline-block;background:#ee4723;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:999px;">Open Staff Bookings &rarr;</a>' +
    '</td></tr>' +
    '<tr><td style="padding:14px 44px 0;color:#8a827c;font-size:12.5px;line-height:1.6;">' +
      '<p style="margin:0 0 10px;">For your security, you&rsquo;ll be asked to set your own password the first time you sign in.</p>' +
      '<p style="margin:0;">If you weren&rsquo;t expecting this, you can ignore this email.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:26px 44px 34px;border-top:1px solid #ece7e3;margin-top:20px;color:#a8a29e;font-size:11.5px;">' +
      'weKnow Inc. &middot; Nearshore delivery, coordinated.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------- http helpers
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2'
};

// The single-page app addresses the server with root-relative URLs ("/api/...",
// "/brand/..."). When the app is mounted under BASE_PATH those have to become
// "/staff/api/..." etc., so rewrite them on the way out. No-op when BASE_PATH
// is empty, which keeps the standalone install byte-identical.
const REBASE_RE = /(["'`])\/(api|brand|avatars|invites)\//g;
function rebaseHtml(buf) {
  if (!BASE_PATH) return buf;
  return Buffer.from(buf.toString('utf8').replace(REBASE_RE, '$1' + BASE_PATH + '/$2/'), 'utf8');
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    if (ext === '.html') buf = rebaseHtml(buf);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- config API
function cleanOptionList(arr, withColor) {
  if (!Array.isArray(arr)) return [];
  const seen = {};
  const out = [];
  arr.forEach((o) => {
    const name = String((o && o.name) || '').trim().slice(0, 80);
    if (!name || seen[name.toLowerCase()]) return;
    seen[name.toLowerCase()] = 1;
    const rec = { name: name };
    if (withColor) rec.color = /^#[0-9a-fA-F]{6}$/.test(o && o.color) ? o.color : autoColor(name);
    out.push(rec);
  });
  return out;
}

function slugKey() { return 'cf_' + crypto.randomBytes(4).toString('hex'); }

function cleanFields(arr, current) {
  const biByKey = {};
  BUILTIN_FIELDS.forEach((f) => { biByKey[f.key] = f; });
  const curByKey = {};
  (current || []).forEach((f) => { curByKey[f.key] = f; });
  const out = [];
  const seen = {};
  const desc = (f) => String((f && f.description) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  (Array.isArray(arr) ? arr : []).forEach((f) => {
    if (!f || !f.key) return;
    if (biByKey[f.key]) {
      if (seen[f.key]) return;
      seen[f.key] = 1;
      out.push({ key: f.key, label: String(f.label || biByKey[f.key].label).trim().slice(0, 60) || biByKey[f.key].label, type: biByKey[f.key].type, builtin: true, hidden: !!f.hidden, description: desc(f) });
    } else {
      let key = /^cf_[0-9a-f]{8}$/.test(f.key) ? f.key : slugKey();
      if (seen[key]) return;
      seen[key] = 1;
      const prev = curByKey[f.key];
      const type = CUSTOM_TYPES.indexOf(f.type) >= 0 ? f.type : (prev ? prev.type : 'text');
      const rec = { key: key, label: String(f.label || 'Field').trim().slice(0, 60) || 'Field', type: type, builtin: false, hidden: !!f.hidden, description: desc(f) };
      if (type === 'select') rec.options = cleanOptionList(f.options, true);
      out.push(rec);
    }
  });
  BUILTIN_FIELDS.forEach((f) => {
    if (!seen[f.key]) out.push({ key: f.key, label: f.label, type: f.type, builtin: true, hidden: !!f.hidden, description: '' });
  });
  return out;
}

// coerce existing booking values when a custom field's type changed
function recoerceCustom(list, prevFields, nextFields) {
  const prevType = {};
  prevFields.forEach((f) => { if (!f.builtin) prevType[f.key] = f.type; });
  const changed = nextFields.filter((f) => !f.builtin && prevType[f.key] && prevType[f.key] !== f.type);
  if (!changed.length) return 0;
  let n = 0;
  list.forEach((b) => {
    if (!b.custom) return;
    changed.forEach((f) => {
      if (!(f.key in b.custom)) return;
      let v = b.custom[f.key];
      if (f.type === 'number') { v = Number(v); if (Number.isNaN(v)) v = null; }
      else if (f.type === 'checkbox') v = !!v;
      else if (f.type === 'date') v = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
      else v = (v == null) ? '' : String(v);
      b.custom[f.key] = v; n++;
    });
  });
  return n;
}

function handleConfig(req, res, me) {
  if (req.method === 'GET') return sendJson(res, 200, { config: loadConfig() });

  if (req.method === 'PUT') {
    return readBody(req).then((body) => {
      const incoming = body.config || {};
      const renames = Array.isArray(body.renames) ? body.renames : [];
      const current = loadConfig();
      const next = {
        statuses: cleanOptionList(incoming.statuses, true),
        clients: cleanOptionList(incoming.clients, true),
        employees: cleanOptionList(incoming.employees, false),
        roles: cleanOptionList(incoming.roles, false),
        deliveryManagers: cleanOptionList(incoming.deliveryManagers, false),
        fields: cleanFields(incoming.fields, current.fields)
      };
      if (!next.statuses.length) next.statuses = defaultConfig().statuses;

      const list = db().slice();
      let touched = 0;

      // apply option renames to existing bookings
      const fieldKey = { status: 'status', client: 'client', employee: 'name', role: 'roles', deliveryManager: 'deliveryManager' };
      const valid = renames.filter((r) => r && fieldKey[r.field] && r.from && r.to && r.from !== r.to);
      valid.forEach((rn) => {
        const k = fieldKey[rn.field];
        list.forEach((b) => {
          if (k === 'roles') {
            if (b.roles.includes(rn.from)) { b.roles = b.roles.map((x) => (x === rn.from ? rn.to : x)); touched++; }
          } else if (b[k] === rn.from) { b[k] = rn.to; touched++; }
        });
      });

      // strip values of deleted custom fields
      const keepKeys = {};
      next.fields.forEach((f) => { keepKeys[f.key] = 1; });
      const removed = current.fields.filter((f) => !f.builtin && !keepKeys[f.key]).map((f) => f.key);
      if (removed.length) {
        list.forEach((b) => { if (b.custom) removed.forEach((k) => { if (k in b.custom) { delete b.custom[k]; touched++; } }); });
      }
      touched += recoerceCustom(list, current.fields, next.fields);
      if (touched) save(list);

      saveConfig(next);
      audit('config.update', me && me.username, { renames: valid.length, bookingsTouched: touched, fields: next.fields.length });
      return sendJson(res, 200, { config: next, bookings: db() });
    });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

// ---------------------------------------------------------------- bookings API
async function handleBookings(req, res, id, me) {
  const actor = me && me.username;
  if (req.method === 'GET' && !id) return sendJson(res, 200, { bookings: db() });

  if (req.method === 'POST' && !id) {
    const body = await readBody(req);
    const rec = normalize(body, genId());
    const list = db().slice();
    list.push(rec);
    save(list);
    afterBookingWrite(rec);
    audit('booking.create', actor, { id: rec.id, name: rec.name, client: rec.client });
    return sendJson(res, 201, rec);
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
    const body = await readBody(req);
    const list = db().slice();
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) return sendJson(res, 404, { error: 'not found' });
    if (req.method === 'PATCH' && body && body.custom) {
      body.custom = Object.assign({}, list[idx].custom, body.custom);
    }
    const merged = req.method === 'PUT' ? normalize(body, id) : normalize(Object.assign({}, list[idx], body), id);
    list[idx] = merged;
    save(list);
    afterBookingWrite(merged);
    audit('booking.update', actor, { id: id, name: merged.name, fields: Object.keys(body || {}).filter((k) => k !== 'custom' || Object.keys(body.custom || {}).length) });
    return sendJson(res, 200, merged);
  }

  if (req.method === 'DELETE' && id) {
    const gone = db().find((b) => b.id === id);
    save(db().filter((b) => b.id !== id));
    audit('booking.delete', actor, { id: id, name: gone ? gone.name : null, client: gone ? gone.client : null });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const ip = clientIp(req);

  if (parts[1] === 'auth') return handleAuth(req, res, parts[2], ip);

  // everything below requires a valid session
  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { error: 'Not signed in' });

  if (parts[1] === 'team') return handleTeam(req, res, parts, me);
  if (parts[1] === 'config') return handleConfig(req, res, me);
  if (parts[1] === 'bookings' && parts[2] === 'export.csv') return exportCsv(req, res, me);
  if (parts[1] === 'bookings') return handleBookings(req, res, parts[2], me);
  if (parts[1] === 'audit') return handleAudit(req, res, me);
  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// ---------------------------------------------------------------- CSV export
function csvCell(v) {
  if (v == null) v = '';
  if (Array.isArray(v)) v = v.join('; ');
  v = String(v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function exportCsv(req, res, me) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const cfg = loadConfig();
  const fields = (cfg.fields || []).filter((f) => f.type !== 'calc');
  const rows = db().slice().sort((a, b) => (a.client + a.start).localeCompare(b.client + b.start));
  const head = fields.map((f) => csvCell(f.label)).join(',');
  const body = rows.map((b) => fields.map((f) => {
    const v = f.builtin ? b[f.key] : (b.custom || {})[f.key];
    return csvCell(f.type === 'checkbox' ? (v ? 'Yes' : 'No') : v);
  }).join(',')).join('\r\n');
  audit('booking.export', me && me.username, { rows: rows.length });
  const csv = '﻿' + head + '\r\n' + body + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="weknow-staff-bookings-' + isoToday() + '.csv"',
    'Cache-Control': 'no-store'
  });
  res.end(csv);
}

// ---------------------------------------------------------------- audit read (admins)
function handleAudit(req, res, me) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (me.role !== 'admin') return sendJson(res, 403, { error: 'Only administrators can view the activity log.' });
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split(/\n/); } catch (e) {}
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < 300; i--) {
    if (!lines[i]) continue;
    try { out.push(JSON.parse(lines[i])); } catch (e) {}
  }
  return sendJson(res, 200, { events: out });
}

// ---------------------------------------------------------------- boot
ensureUsers();
ensureData();

(function migrateStatuses() {
  const list = load();
  let changed = false;
  list.forEach((b) => { if (STATUS_LEGACY[b.status]) { b.status = STATUS_LEGACY[b.status]; changed = true; } });
  if (changed) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
    console.log('Migrated legacy status values (At risk -> Risk, Rolling off -> Exit, On hold -> N/A)');
  }
})();

db();
ensureConfig();

// Strip the mount prefix so every route below sees the paths it always saw.
// Tolerates the proxy passing the prefix through ("/staff/api/x") or stripping
// it itself ("/api/x"), and accepts "/staff" with or without a trailing slash.
function stripBase(reqUrl) {
  if (!BASE_PATH) return reqUrl;
  if (reqUrl === BASE_PATH) return '/';
  if (reqUrl.indexOf(BASE_PATH + '/') === 0) return reqUrl.slice(BASE_PATH.length) || '/';
  if (reqUrl.indexOf(BASE_PATH + '?') === 0) return '/' + reqUrl.slice(BASE_PATH.length);
  return reqUrl;
}

const requestHandler = (req, res) => {
  req.url = stripBase(req.url);
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendJson(res, 400, { error: String((e && e.message) || e) }));
    return;
  }
  serveStatic(req, res);
};
const server = TLS_OPTS ? https.createServer(TLS_OPTS, requestHandler) : http.createServer(requestHandler);
const scheme = TLS_OPTS ? 'https' : 'http';

server.listen(PORT, BIND, () => {
  console.log('\n  weKnow Staff Bookings');
  console.log('  ---------------------');
  console.log('  Running at  ' + scheme + '://' + (BIND === '0.0.0.0' ? 'localhost' : BIND) + ':' + PORT + BASE_PATH + (TLS_OPTS ? '   (TLS)' : ''));
  if (BASE_PATH) console.log('  Mounted at  ' + BASE_PATH + '   (behind the weknowinc.com Next.js site)');
  console.log('  Data dir    ' + DATA_DIR);
  console.log('  Backups     ' + BACKUP_DIR + '   (auto, keeps ' + BACKUP_KEEP + ')');
  console.log('  Activity    ' + AUDIT_FILE);
  if (!smtpConfig()) console.log('  Email       not configured - invites show the temp password on screen');
  console.log('  Stop with   Ctrl+C\n');
});
