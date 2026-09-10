'use strict';

/*
 * Reads .env next to this file into process.env (simple KEY=VALUE lines).
 * The shell always wins, so an explicitly exported variable is never replaced.
 *
 * server.js has the same few lines inlined so that it keeps working as a single
 * self-contained file; the scripts around it use this.
 */

const fs = require('fs');
const path = require('path');

module.exports = function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file || path.join(__dirname, '.env'), 'utf8'); }
  catch (e) { return false; }
  txt.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  });
  return true;
};
