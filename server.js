#!/usr/bin/env node
/*
 * HomeClaude
 * A bridge between Claude and Home Assistant for development and troubleshooting.
 * It logs in to Home Assistant with a long-lived token through Home Assistant's own
 * REST and WebSocket APIs (nothing is installed in Home Assistant) and offers Claude
 * a Model Context Protocol endpoint at /mcp. Read tools are always on; changes are
 * off until switched on here, blocked domains are never touched, and automations and
 * scripts are backed up before they change. Everything is set up from the web page
 * and saved in the data folder. No packages to install: Node 22 or newer.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ha = require('./lib/ha.js');
const Secrets = require('./lib/secrets.js');
const Backups = require('./lib/backups.js');
const Guard = require('./lib/guard.js');
const Mcp = require('./lib/mcp.js');
const Tools = require('./lib/tools.js');
const Esp = require('./lib/esphome.js');
const Health = require('./lib/health.js');
const Net = require('./lib/netsec.js');
const OAuth = require('./lib/oauth.js');
const Totp = require('./lib/totp.js');
const QR = require('./lib/qr.js');
const pkg = require('./package.json');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
let lastWriteError = null;
const cfgPath = process.env.CONFIG || path.join(__dirname, 'data', 'config.json');
const dataDir = path.dirname(path.resolve(cfgPath));
const statePath = path.join(dataDir, 'state.json');
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 8081);
// tests only: lets the public side run on plain http on this machine
const INSECURE_PUBLIC = process.env.HOMECLAUDE_TEST_INSECURE_PUBLIC === '1';
const DEMO_TOKEN = 'demo';
const IN_DOCKER = fs.existsSync('/.dockerenv');

// ---------- config (saved from the web page) ----------
const DEFAULTS = {
  ha: { url: '', token: '' },
  // one scale of levels: read < build < hands < full. local: Claude on your network; outsideMax: ceiling for every connection from outside
  access: { enabled: true, local: 'read', outsideMax: 'hands', blocked: Guard.DEFAULT_BLOCKED.slice() },
  mcpToken: '',
  publicUrl: '',
  backup: { keep: 30 },
  review: { enabled: true, timeoutMin: 0, ifNoAnswer: 'revert' },
  // ESPHome device configs through the ESPHome Device Builder. url: a standalone Device Builder; empty = the Home Assistant app
  esphome: { enabled: true, url: '' },
  security: { mode: 'local', allowTokenRemote: false, tokenScope: 'read', keyCheck: '', accessDefault: 'none', totp: { enabled: false, secret: '', pending: '', since: 0, lastCounter: 0, maxScope: 'build', off: false } },
  setup: { completed: false, marks: {} }
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // storage problems: start anyway so the page can show what is wrong (instead of a silent restart loop)
    if (['EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'ESTALE', 'ENOTCONN', 'EHOSTDOWN'].includes(e.code)) {
      console.error(file + ' could not be read (' + e.code + '). Starting with defaults; see System on the page.');
      lastWriteError = { at: Date.now(), message: 'could not read ' + path.basename(file) + ' (' + e.code + ')' };
      return fallback;
    }
    console.error(file + ' could not be read: ' + e.message); process.exit(1);
  }
}
function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } fs.writeFileSync(file, text, { mode: 0o600 }); }
}

const savedCfg = DEMO ? {} : readJson(cfgPath, {});
let cfg = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), savedCfg);
// installs from before the setup guide already went through setup
if (!savedCfg.setup && savedCfg.ha && savedCfg.ha.url) cfg.setup = { completed: true, marks: {} };
['ha', 'access', 'backup', 'setup', 'security', 'review', 'esphome'].forEach((k) => { cfg[k] = Object.assign({}, DEFAULTS[k], cfg[k] || {}); });
cfg.access.blocked = Guard.cleanDomains(cfg.access.blocked);
// ---------- permission levels ----------
const LEVELS = ['read', 'build', 'hands', 'full'];
const LEVEL_FLAGS = { read: {}, build: { edit: true }, hands: { edit: true, services: true }, full: { edit: true, services: true, delete: true, restart: true } };
const levelFromFlags = (f) => (f.delete || f.restart ? 'full' : f.services ? 'hands' : f.edit ? 'build' : 'read');
const lowerLevel = (a, b) => LEVELS[Math.min(LEVELS.indexOf(a), LEVELS.indexOf(b))];
// settings saved before levels existed: the four switches become the level for your network
if (savedCfg.access && savedCfg.access.local == null) cfg.access.local = levelFromFlags(savedCfg.access);
['edit', 'services', 'delete', 'restart'].forEach((k) => { delete cfg.access[k]; });
if (!LEVELS.includes(cfg.access.local)) cfg.access.local = 'read';
if (!['read', 'build', 'hands'].includes(cfg.access.outsideMax)) cfg.access.outsideMax = 'hands';
/** What a level allows. From outside: never above the outside ceiling, never above Hands on (no delete or restart). */
function accessFor(level, remote) {
  let l = LEVELS.includes(level) ? level : 'read';
  if (remote) l = lowerLevel(lowerLevel(l, cfg.access.outsideMax), 'hands');
  const f = LEVEL_FLAGS[l];
  // ESPHome: reading and validating come with every level while ESPHome is on; changing configs with Help build and up
  const esp = !!cfg.esphome.enabled;
  return { enabled: cfg.access.enabled, blocked: cfg.access.blocked, level: l, edit: !!f.edit, services: !!f.services, delete: !!f.delete, restart: !!f.restart, esphome: esp, esphomeEdit: esp && !!f.edit };
}
const localAccess = () => accessFor(cfg.access.local, false);
if (!cfg.setup.marks || typeof cfg.setup.marks !== 'object') cfg.setup.marks = {};
cfg.security.totp = Object.assign({}, DEFAULTS.security.totp, cfg.security.totp || {});

function changeConfig(mutator) {
  const next = JSON.parse(JSON.stringify(cfg));
  try {
    const err = mutator(next);
    if (err) return { ok: false, error: err };
    if (!DEMO) writeJson(cfgPath, next);
  } catch (e) {
    lastWriteError = { at: Date.now(), message: e.code || e.message };
    setTimeout(runHealth, 10);
    return { ok: false, status: 500, error: 'Could not save the settings (' + (e.code || e.message) + '). See System on the dashboard.' };
  }
  cfg = next;
  return { ok: true };
}

const state = DEMO ? {} : readJson(statePath, {});
if (!Array.isArray(state.activity)) state.activity = [];
if (!Array.isArray(state.security)) state.security = [];
if (!Array.isArray(state.reviews)) state.reviews = [];
const oauthPath = path.join(dataDir, 'oauth.json');
let saveTimer = null;
function saveState() {
  if (DEMO) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeJson(statePath, state); }
    catch (e) { console.error('Could not save state: ' + e.message); lastWriteError = { at: Date.now(), message: e.code || e.message }; runHealth(); }
  }, 300);
}

// ---------- secrets: the Home Assistant token and Claude's access token ----------
const secrets = Secrets.create(path.join(dataDir, 'secret.key'), { masterKey: DEMO ? '' : process.env.HOMECLAUDE_MASTER_KEY });
let keyMismatch = false;
if (!DEMO) {
  // a master key from the environment: move everything over to it and delete the key file from the volume
  const moved = secrets.migrate({ ha: cfg.ha.token, mcp: cfg.mcpToken, check: cfg.security.keyCheck });
  if (moved) {
    const r = changeConfig((c) => { c.ha.token = moved.ha; c.mcpToken = moved.mcp; c.security.keyCheck = moved.check; });
    if (r.ok && secrets.dropFileKey()) console.log('Tokens are now encrypted with the master key; secret.key was removed from the data folder.');
  }
  if (!cfg.security.keyCheck) changeConfig((c) => { c.security.keyCheck = secrets.makeCheck(); });
  else if (!secrets.checkOk(cfg.security.keyCheck)) {
    keyMismatch = true;
    console.error('The encryption key does not match the one the saved tokens were encrypted with. Check HOMECLAUDE_MASTER_KEY, or enter the tokens again.');
  }
}

// ---------- security events (what happened at the doors) ----------
function securityEvent(type, detail) {
  state.security.unshift(Object.assign({ t: Date.now(), type }, detail || {}));
  if (state.security.length > 300) state.security.length = 300;
  saveState(); broadcastSoon();
}
function mcpToken() {
  if (DEMO) return DEMO_TOKEN;
  let t = secrets.dec(cfg.mcpToken);
  if (!t) {
    t = crypto.randomBytes(24).toString('base64url');
    const r = changeConfig((c) => { c.mcpToken = secrets.enc(t); });
    if (!r.ok) console.error(r.error);
  }
  return t;
}

// ---------- optional control PIN (stored hashed) ----------
const verified = new Set();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pinSet = () => !!cfg.controlPinHash;
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
const pinLimit = Net.limiter({ max: 5, windowMs: 10 * 60e3, lockMs: 10 * 60e3 });
function pinOk(given) {
  if (!pinSet()) return true;
  given = String(given == null ? '' : given);
  const key = sha(given);
  if (verified.has(key)) return true;
  const [alg, salt, hash] = String(cfg.controlPinHash).split(':');
  let good = false;
  if (alg === 'scrypt' && salt && hash) {
    const h = crypto.scryptSync(given, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
    good = h.length === b.length && crypto.timingSafeEqual(h, b);
  }
  if (good) verified.add(key);
  return good;
}

// ---------- Home Assistant ----------
const ha = DEMO ? require('./lib/demo.js').client() : Ha.create({ getUrl: () => cfg.ha.url, getToken: () => secrets.dec(cfg.ha.token) });
const backups = Backups.create({ dir: path.join(dataDir, 'backups'), keep: () => cfg.backup.keep });
const esphome = DEMO ? require('./lib/demo.js').esphome() : Esp.create({ ha, settings: () => cfg.esphome, version: pkg.version });
const tools = Tools.create({ ha, backups, esphome, access: localAccess, onChange: (info, who) => recordChange(info, who), reviewInfo: () => reviewInfo() });

// ---------- keep or revert: every change Claude makes goes live, and you decide afterwards ----------
const REVIEW_TIMES = [0, 15, 60, 240, 1440];
const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
function recordChange(info, who) {
  if (!cfg.review.enabled) return null;
  const now = Date.now();
  // a second change to the same thing while you have not answered: Revert still goes back to the very first version
  let r = state.reviews.find((x) => x.status === 'waiting' && x.kind === info.kind && x.id === String(info.id));
  if (!r) {
    r = { rid: crypto.randomBytes(6).toString('hex'), kind: info.kind, id: String(info.id), before: clone(info.before), backup: info.backup || null, at: now, status: 'waiting', changes: 0 };
    // labels and categories: undone by the recorded steps of the first change
    if (info.revert) { r.revert = clone(info.revert); r.firstAction = info.action; }
    state.reviews.unshift(r);
  }
  r.alias = String(info.alias || r.alias || r.id).slice(0, 160);
  r.after = clone(info.after); r.who = who && who.remote ? who.label : 'Claude'; r.where = who && who.remote ? 'outside' : 'home'; r.updatedAt = now; r.changes++;
  r.action = r.revert ? r.firstAction : r.before ? (r.after ? 'changed' : 'deleted') : (r.after ? 'created' : null);
  if (!r.action) { r.status = 'withdrawn'; r.decidedAt = now; } // made and deleted again: nothing left to review
  r.autoAt = cfg.review.timeoutMin ? now + cfg.review.timeoutMin * 60e3 : null;
  trimReviews(); saveState(); broadcastSoon();
  if (!r.action) return null;
  return 'Applied now. The person is asked in HomeClaude to keep or revert this change' +
    (r.autoAt ? '; if they do not answer within ' + cfg.review.timeoutMin + ' minutes it is ' + (cfg.review.ifNoAnswer === 'revert' ? 'reverted' : 'kept') + ' automatically' : '') + '.';
}
function trimReviews() {
  const waiting = state.reviews.filter((x) => x.status === 'waiting');
  const done = state.reviews.filter((x) => x.status !== 'waiting').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 60);
  state.reviews = waiting.concat(done);
}
function reviewInfo() {
  const day = Date.now() - 86400e3;
  return {
    waiting: state.reviews.filter((x) => x.status === 'waiting').map((x) => ({ kind: x.kind, id: x.id, alias: x.alias, action: x.action, since: new Date(x.at).toISOString() })),
    recently_reverted: state.reviews.filter((x) => x.status === 'reverted' && x.decidedAt > day).map((x) => ({ kind: x.kind, id: x.id, alias: x.alias, action: x.action, reverted: new Date(x.decidedAt).toISOString() }))
  };
}
async function decideReview(rid, keep, by) {
  const r = state.reviews.find((x) => x.rid === rid);
  if (!r || r.status !== 'waiting') return { ok: false, error: 'That change was already answered' };
  if (!keep && r.kind === 'esphome') {
    try { await putEsphome(r.id, r.before && r.before.content, 'before-revert'); backupsChanged(); }
    catch (e) { return { ok: false, error: 'Could not revert: ' + e.message }; }
  } else if (!keep && r.revert) {
    try {
      if (r.kind === 'dashboard') await backupDashboardNow(r.id, r.alias, 'before-revert');
      // something already gone (deleted in Home Assistant meanwhile) is not a reason to stop
      for (const m of r.revert) { try { await ha.command(m); } catch (e) { if (e.status !== 404) throw e; } }
      if (r.kind === 'dashboard') backupsChanged();
    }
    catch (e) { return { ok: false, error: 'Could not revert: ' + e.message }; }
  } else if (!keep) {
    try {
      let current = null;
      try { current = await ha.rest('GET', '/api/config/' + r.kind + '/config/' + encodeURIComponent(r.id)); } catch (e) { if (e.status !== 404) throw e; }
      if (current) backups.save(r.kind, r.id, current, 'before-revert');
      if (r.action === 'created') { if (current) await ha.rest('DELETE', '/api/config/' + r.kind + '/config/' + encodeURIComponent(r.id)); }
      else await ha.rest('POST', '/api/config/' + r.kind + '/config/' + encodeURIComponent(r.id), r.before);
      backupsChanged();
    } catch (e) { return { ok: false, error: 'Could not revert: ' + e.message }; }
  }
  r.status = keep ? 'kept' : 'reverted'; r.decidedAt = Date.now(); r.by = by;
  logActivity({ t: r.decidedAt, tool: (keep ? 'kept' : 'reverted') + ' (' + by + ')', args: r.kind + ' ' + r.alias + ' (' + r.action + ')', ok: true, ms: 0, write: !keep });
  trimReviews(); saveState(); broadcastSoon();
  return { ok: true };
}
let reviewTimerBusy = false;
async function reviewTimer() {
  if (reviewTimerBusy) return;
  reviewTimerBusy = true;
  try {
    for (const r of state.reviews.filter((x) => x.status === 'waiting' && x.autoAt && x.autoAt <= Date.now())) {
      const res = await decideReview(r.rid, cfg.review.ifNoAnswer !== 'revert', 'no answer in time');
      if (!res.ok) { r.autoAt = Date.now() + 5 * 60e3; saveState(); } // Home Assistant away: try again later
    }
  } finally { reviewTimerBusy = false; }
}
function setReview(b) {
  return changeConfig((c) => {
    if (typeof b.enabled === 'boolean') c.review.enabled = b.enabled;
    if (b.timeoutMin != null) { const m = Number(b.timeoutMin); if (!REVIEW_TIMES.includes(m)) return 'Unknown time'; c.review.timeoutMin = m; }
    if (b.ifNoAnswer != null) { if (!['keep', 'revert'].includes(b.ifNoAnswer)) return 'Choose keep or revert'; c.review.ifNoAnswer = b.ifNoAnswer; }
  });
}
let haStatus = { ok: false, configured: false, checking: false, checkedAt: 0, error: '', version: '', name: '', ms: 0 };

async function checkHa() {
  if (!ha.configured()) { haStatus = { ok: false, configured: false, checkedAt: Date.now(), error: '', version: '', name: '' }; broadcastSoon(); return haStatus; }
  haStatus = Object.assign({}, haStatus, { checking: true }); broadcastSoon();
  const t0 = Date.now();
  try {
    const c = await ha.rest('GET', '/api/config', undefined, { timeoutMs: 8000 });
    await ha.command({ type: 'ping' }).catch((e) => { if (!/unknown/i.test(e.message)) throw e; });
    // logs, traces and configs are only open to administrators: find out now rather than at Claude's first question
    let admin = null;
    try { await ha.command({ type: 'system_log/list' }); admin = true; } catch (e) { if (e.status === 403 || /unauthor/i.test(e.message)) admin = false; }
    haStatus = { ok: true, configured: true, checking: false, checkedAt: Date.now(), error: '', version: c.version || '', name: c.location_name || '', state: c.state || '', ms: Date.now() - t0, admin };
  } catch (e) {
    haStatus = { ok: false, configured: true, checking: false, checkedAt: Date.now(), error: e.message, version: haStatus.version, name: haStatus.name, ms: 0 };
  }
  broadcastSoon();
  return haStatus;
}

// ---------- is HomeClaude itself healthy (storage, free space, memory, load) ----------
let health = null, healthRunning = false;
async function runHealth() {
  if (healthRunning) return health;
  healthRunning = true;
  try {
    const before = health && health.level;
    health = await Health.check({ dataDir, inDocker: IN_DOCKER && !DEMO, lastWriteError });
    if (health.storage.writable) lastWriteError = null;
    if (health.level !== 'ok' && health.level !== before) console.error('Health: ' + [health.storage, health.memory, health.load].flatMap((x) => x.problems).join(' '));
  } catch (e) { console.error('Health check failed: ' + e.message); }
  healthRunning = false;
  broadcastSoon();
  return health;
}

// ---------- the MCP endpoint ----------
function logActivity(entry) {
  state.activity.unshift(entry);
  if (state.activity.length > 300) state.activity.length = 300;
  state.lastCallAt = entry.t;
  saveState(); broadcastSoon();
}
function argSummary(a) {
  try { const s = JSON.stringify(a || {}); return s === '{}' ? '' : s.length > 220 ? s.slice(0, 217) + '...' : s; } catch (e) { return ''; }
}
/** A connection from outside: the level it was given, under the outside ceiling, never delete or restart. */
const capAccess = (scope) => accessFor(scope, true);
const callLimit = Net.limiter({ max: 120, windowMs: 60e3, lockMs: 60e3 });

/*
 * Claude's apps keep the tool list they loaded. When permissions change, the next answer to that
 * connection says so, once, so Claude can tell the person to reconnect instead of thinking it cannot do something.
 */
const listed = new Map(); // who.key -> { names: Set, told: string }
const LVL_TEXT = { read: 'Look only', build: 'Help build', hands: 'Hands on', full: 'Full' };
function noteListed(who, names) { if (who && who.key) listed.set(who.key, { names: new Set(names), told: '' }); }
function toolsNotice(who) {
  const seen = who && who.key && listed.get(who.key);
  if (!seen) return '';
  const now = tools.list(who.access).map((t) => t.name);
  const added = now.filter((n) => !seen.names.has(n)), removed = [...seen.names].filter((n) => !now.includes(n));
  if (!added.length && !removed.length) return '';
  const sig = added.join(',') + '|' + removed.join(',');
  if (seen.told === sig) return '';
  seen.told = sig;
  const level = (who.access && who.access.level) || cfg.access.local;
  return '[HomeClaude: this connection\'s permissions changed since your tool list was loaded. It is now ' + (LVL_TEXT[level] || level) + '.' +
    (added.length ? ' Now allowed, but not in your current tool list: ' + added.join(', ') + '.' : '') +
    (removed.length ? ' No longer allowed: ' + removed.join(', ') + '.' : '') +
    (added.length ? ' To use the new tools, the person needs to reload the HomeClaude connector (reconnect it, or start a new chat). Tell them so if they ask for something these tools do.' : '') + ']\n\n';
}
const mcp = Mcp.create({
  serverInfo: { name: 'homeclaude', title: 'HomeClaude (Home Assistant)', version: pkg.version },
  instructions: Tools.INSTRUCTIONS,
  listTools: (who) => tools.list(who && who.access),
  onListed: noteListed,
  async callTool(name, a, who) {
    const t0 = Date.now(), def = tools.all().find((x) => x.name === name);
    if (who && who.remote && callLimit.locked(who.key)) return { isError: true, text: 'Too many requests from this connection. Wait a minute.' };
    if (who && who.remote) callLimit.hit(who.key);
    const r = await tools.call(name, a, who && who.access, who);
    const notice = toolsNotice(who);
    if (notice) r.text = notice + r.text;
    if (def && def.needs) backupsChanged();
    logActivity({ t: t0, tool: name, args: argSummary(a), ok: !r.isError, ms: Date.now() - t0, write: !!(def && def.needs), error: r.isError ? r.text.slice(0, 300) : undefined, who: who ? who.label : undefined, remote: !!(who && who.remote), ip: who ? who.ip : undefined });
    return r;
  }
});

function tokenOk(given) {
  const want = Buffer.from(mcpToken()), got = Buffer.from(String(given || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const bearerOf = (req) => (/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')) || [])[1];

/** /mcp on the private port: the access token, from the header or the address. */
function serveMcpLocal(req, res, pathToken) {
  const send = (code, obj, extra) => { res.writeHead(code, Net.securityHeaders(Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {}))); res.end(obj == null ? '' : JSON.stringify(obj)); };
  if (!tokenOk(pathToken || bearerOf(req))) return setTimeout(() => send(401, { error: 'Missing or wrong HomeClaude access token' }, { 'www-authenticate': 'Bearer realm="HomeClaude"' }), 400);
  runMcp(req, res, { label: 'This network', access: null, remote: false, ip: Net.clientIp(req, false), key: 'lan' });
}

function runMcp(req, res, who) {
  const send = (code, obj, extra) => { res.writeHead(code, Net.securityHeaders(Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {}))); res.end(obj == null ? '' : JSON.stringify(obj)); };
  // a web page in a browser must not be able to use this (DNS rebinding); Claude's apps send no Origin
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return send(403, { error: 'Requests from web pages are not allowed' }); } catch (e) { return send(403, { error: 'Bad Origin' }); } }
  if (req.method === 'GET' || req.method === 'DELETE') return send(405, { error: 'Use POST' }, { allow: 'POST' });
  if (req.method !== 'POST') return send(405, { error: 'Use POST' }, { allow: 'POST' });
  if (!cfg.access.enabled) return send(503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Claude access is switched off in HomeClaude' } });

  const chunks = []; let size = 0, tooBig = false;
  req.on('data', (d) => { size += d.length; if (size > 2 * 1024 * 1024) tooBig = true; else chunks.push(d); });
  req.on('end', async () => {
    if (tooBig) return send(413, { error: 'Request too large' });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, Mcp.parseError()); }
    try {
      const out = await mcp.handle(body, req.headers, who);
      if (out == null) { res.writeHead(202); return res.end(); }
      send(200, out);
    } catch (e) {
      send(500, { jsonrpc: '2.0', id: body && body.id !== undefined ? body.id : null, error: { code: -32603, message: 'Internal error: ' + e.message } });
    }
  });
}

// ---------- settings from the web page ----------
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function setHa(b) {
  if (DEMO) return { ok: false, error: 'Demo mode: Home Assistant is simulated' };
  const url = clean(b.url, 300).replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i.test(url)) return { ok: false, error: 'The address should look like http://192.168.1.10:8123' };
  const r = changeConfig((c) => {
    c.ha.url = url;
    if (b.token != null && String(b.token).trim()) c.ha.token = secrets.enc(String(b.token).trim().slice(0, 1000));
    if (b.clearToken) c.ha.token = '';
  });
  if (r.ok) { ha.reset(); esphome.forget(); checkHa(); }
  return r;
}

function setEsphome(b) {
  const url = clean(b.url == null ? cfg.esphome.url : b.url, 300).replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i.test(url)) return { ok: false, error: 'The address should look like http://192.168.1.10:6052, or leave it empty to use the ESPHome app in Home Assistant' };
  const r = changeConfig((c) => {
    if (typeof b.enabled === 'boolean') c.esphome.enabled = b.enabled;
    c.esphome.url = url;
  });
  if (r.ok) { esphome.forget(); if (cfg.esphome.enabled) esphome.check().then(broadcastSoon); else broadcastSoon(); }
  return r;
}

function setAccess(b) {
  return changeConfig((c) => {
    if (typeof b.enabled === 'boolean') c.access.enabled = b.enabled;
    if (b.local != null) { if (!LEVELS.includes(b.local)) return 'Unknown level'; c.access.local = b.local; }
    if (b.outsideMax != null) { if (!['read', 'build', 'hands'].includes(b.outsideMax)) return 'From outside the highest level is Hands on'; c.access.outsideMax = b.outsideMax; }
    // the older switch names still work (setup guide, scripts): they adjust the level for your network
    if (['edit', 'services', 'delete', 'restart'].some((k) => typeof b[k] === 'boolean')) {
      const f = Object.assign({}, LEVEL_FLAGS[c.access.local]);
      ['edit', 'services', 'delete', 'restart'].forEach((k) => { if (typeof b[k] === 'boolean') f[k] = b[k]; });
      if (!f.edit) { f.services = false; f.delete = false; f.restart = false; }
      c.access.local = levelFromFlags(f);
    }
    if (b.blocked != null) c.access.blocked = Guard.cleanDomains(b.blocked);
  });
}

function changeSettings(b) {
  if (Object.prototype.hasOwnProperty.call(b, 'newPin')) {
    if (b.newPin === null && exposed()) return { ok: false, error: 'Exposed mode needs a PIN. Switch to local only first.' };
    if (b.newPin === null) return changeConfig((c) => { delete c.controlPinHash; verified.clear(); });
    const p = String(b.newPin);
    if (p.length < 4 || p.length > 64) return { ok: false, error: 'A PIN needs 4 to 64 characters' };
    return changeConfig((c) => { c.controlPinHash = hashPin(p); verified.clear(); });
  }
  return changeConfig((c) => {
    if (b.publicUrl != null) {
      const u = clean(b.publicUrl, 300).replace(/\/+$/, '').replace(/\/mcp$/, '');
      if (u && !(INSECURE_PUBLIC ? /^https?:\/\/[^\s/]+(:\d+)?$/i : /^https:\/\/[^\s/]+(:\d+)?$/i).test(u)) return 'The public address must be https://, just the host name (for example https://homeclaude.example.com)';
      if (u !== c.publicUrl && c.security.mode === 'exposed' && !u) return 'Switch to local mode before removing the public address';
      c.publicUrl = u;
    }
    if (b.backupKeep != null) c.backup.keep = Math.min(200, Math.max(1, parseInt(b.backupKeep, 10) || 30));
  });
}

function newToken() {
  if (DEMO) return { ok: false, error: 'Demo mode uses the token "demo"' };
  const t = crypto.randomBytes(24).toString('base64url');
  const r = changeConfig((c) => { c.mcpToken = secrets.enc(t); });
  if (r.ok) securityEvent('token-replaced', {});
  return r.ok ? { ok: true, token: t } : r;
}

// ---------- dashboards: backed up and restored through Home Assistant's WebSocket API ----------
const dashUrl = (id) => (id === 'lovelace' ? null : id);
async function dashboardNow(id) {
  const list = (await ha.command({ type: 'lovelace/dashboards/list' })) || [];
  const d = id === 'lovelace' ? { url_path: 'lovelace', title: 'Overview' } : list.find((x) => x.url_path === id) || null;
  if (!d) return null;
  let config = null;
  try { config = await ha.command({ type: 'lovelace/config', url_path: dashUrl(id), force: false }); }
  catch (e) { if (!(e.code === 'config_not_found' || /no config found/i.test(e.message))) throw e; }
  return { d, config };
}
async function backupDashboardNow(id, alias, reason) {
  const now = await dashboardNow(id);
  if (!now) return;
  const d = now.d;
  backups.save('dashboard', id, { alias: d.title || alias, dashboard: id === 'lovelace' ? null : { url_path: d.url_path, title: d.title, icon: d.icon || null, show_in_sidebar: d.show_in_sidebar !== false, require_admin: !!d.require_admin }, config: now.config }, reason);
}
async function restoreDashboard(id, bk) {
  const body = bk.config || {};
  const now = await dashboardNow(id);
  if (now) await backupDashboardNow(id, body.alias, 'before-restore');
  if (!now && id !== 'lovelace') {
    if (!body.dashboard) throw new Error('The backup does not say how the dashboard was set up');
    const s = body.dashboard;
    await ha.command({ type: 'lovelace/dashboards/create', url_path: s.url_path, title: s.title, icon: s.icon || undefined, show_in_sidebar: s.show_in_sidebar !== false, require_admin: !!s.require_admin });
  }
  if (body.config) await ha.command({ type: 'lovelace/config/save', url_path: dashUrl(id), config: body.config });
  else if (now && now.config) await ha.command({ type: 'lovelace/config/delete', url_path: dashUrl(id) });
}

/** Puts an ESPHome file back to the given text, backing up what is there now. */
async function putEsphome(file, content, reason) {
  if (typeof content !== 'string') throw new Error('Nothing to put back');
  const now = await esphome.read(file);
  if (now === content) return;
  backups.save('esphome', file, { alias: file, content: now }, reason);
  await esphome.write(file, content, now);
}

async function restore(b) {
  const kind = String(b.kind || ''), id = String(b.id || ''), file = String(b.file || '');
  const bk = backups.read(kind, id, file);
  if (!bk || (!bk.config && kind !== 'dashboard')) return { ok: false, error: 'That backup is gone' };
  if (kind === 'esphome') {
    try {
      await putEsphome(id, (bk.config || {}).content, 'before-restore');
      backupsChanged();
      logActivity({ t: Date.now(), tool: 'restore (HomeClaude page)', args: kind + ' ' + id + ' from ' + file, ok: true, ms: 0, write: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (kind === 'dashboard') {
    try {
      await restoreDashboard(id, bk);
      backupsChanged();
      logActivity({ t: Date.now(), tool: 'restore (HomeClaude page)', args: kind + ' ' + id + ' from ' + file, ok: true, ms: 0, write: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  try {
    let current = null;
    try { current = await ha.rest('GET', '/api/config/' + kind + '/config/' + encodeURIComponent(id)); } catch (e) { if (e.status !== 404) throw e; }
    if (current) backups.save(kind, id, current, 'before-restore');
    await ha.rest('POST', '/api/config/' + kind + '/config/' + encodeURIComponent(id), bk.config);
    backupsChanged();
    logActivity({ t: Date.now(), tool: 'restore (HomeClaude page)', args: kind + ' ' + id + ' from ' + file, ok: true, ms: 0, write: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- exposed mode: Claude's sign-in from outside ----------
let oauthSaveTimer = null;
// ---------- approving with an authenticator code ----------
// Wrong codes: 5 in an hour pause code approvals for the rest of the hour; 20 in a day switch
// them off until they are switched back on at home. So no one gets more than 20 guesses.
if (!Array.isArray(state.totpFails)) state.totpFails = [];
function totpAvailable() {
  const t = cfg.security.totp;
  return { ok: !!(t.enabled && t.secret && !t.off && exposed()), maxScope: t.maxScope, span: cfg.security.accessDefault };
}
function totpCheck(code, ip) {
  const t = cfg.security.totp, now = Date.now();
  if (t.off) return 'off';
  state.totpFails = state.totpFails.filter((x) => x > now - 86400e3);
  if (state.totpFails.filter((x) => x > now - 3600e3).length >= 5) return 'paused';
  const step = Totp.verify(secrets.dec(t.secret), code, t.lastCounter, now);
  if (step != null) { changeConfig((c) => { c.security.totp.lastCounter = step; }); return 'ok'; }
  state.totpFails.push(now); saveState();
  securityEvent('code-wrong', { ip });
  if (state.totpFails.length >= 20) {
    changeConfig((c) => { c.security.totp.off = true; });
    securityEvent('codes-switched-off', { why: '20 wrong codes in 24 hours' });
  } else if (state.totpFails.filter((x) => x > now - 3600e3).length >= 5) securityEvent('codes-paused', { why: '5 wrong codes in an hour' });
  return 'wrong';
}
function totpAction(b) {
  const t = cfg.security.totp;
  if (b.action === 'setup') {
    const secret = Totp.newSecret();
    const r = changeConfig((c) => { c.security.totp.pending = secrets.enc(secret); });
    if (!r.ok) return r;
    let account = 'HomeClaude';
    try { if (cfg.publicUrl) account = new URL(cfg.publicUrl).host; } catch (e) { /* keep */ }
    const uri = Totp.uri(secret, account, 'HomeClaude');
    return { ok: true, secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, svg: QR.svg(uri, 5) };
  }
  if (b.action === 'confirm') {
    const secret = secrets.dec(t.pending);
    if (!secret) return { ok: false, error: 'Start the setup again' };
    const step = Totp.verify(secret, b.code, null, Date.now());
    if (step == null) return { ok: false, error: 'That code does not match. Check the app shows HomeClaude, and that the phone\'s clock is right.' };
    const r = changeConfig((c) => { Object.assign(c.security.totp, { enabled: true, secret: c.security.totp.pending, pending: '', since: Date.now(), lastCounter: step, off: false }); });
    if (r.ok) { state.totpFails = []; saveState(); securityEvent('codes-enabled', {}); }
    return r;
  }
  if (b.action === 'disable') {
    const r = changeConfig((c) => { Object.assign(c.security.totp, { enabled: false, secret: '', pending: '', since: 0, lastCounter: 0, off: false }); });
    if (r.ok) securityEvent('codes-disabled', {});
    return r;
  }
  if (b.action === 'resume') {
    const r = changeConfig((c) => { c.security.totp.off = false; });
    if (r.ok) { state.totpFails = []; saveState(); securityEvent('codes-resumed', {}); }
    return r;
  }
  if (b.maxScope != null) {
    if (!OAuth.SCOPES.includes(b.maxScope)) return { ok: false, error: 'Unknown permission level' };
    return changeConfig((c) => { c.security.totp.maxScope = b.maxScope; });
  }
  return { ok: false, error: 'Unknown action' };
}

const oauth = OAuth.create({
  totp: { available: totpAvailable, check: totpCheck },
  load: () => (DEMO ? {} : readJson(oauthPath, {})),
  save: (db) => {
    if (DEMO) return;
    clearTimeout(oauthSaveTimer);
    oauthSaveTimer = setTimeout(() => { try { writeJson(oauthPath, db); } catch (e) { lastWriteError = { at: Date.now(), message: e.code || e.message }; runHealth(); } }, 100);
  },
  base: () => cfg.publicUrl,
  event: (type, d) => securityEvent(type, d)
});
const exposed = () => cfg.security.mode === 'exposed';

function setSecurity(b) {
  let changedMode = null;
  const r = changeConfig((c) => {
    if (b.mode != null) {
      if (!['local', 'exposed'].includes(b.mode)) return 'Unknown mode';
      if (b.mode === 'exposed') {
        if (!c.controlPinHash) return 'Set a control PIN first. In exposed mode this page must not be open to anyone on your network.';
        if (!c.publicUrl) return 'Enter the public https address first.';
      }
      if (c.security.mode !== b.mode) changedMode = b.mode;
      c.security.mode = b.mode;
    }
    if (typeof b.allowTokenRemote === 'boolean') c.security.allowTokenRemote = b.allowTokenRemote;
    if (b.accessDefault != null) { if (!(b.accessDefault in OAuth.SPANS)) return 'Unknown access time'; c.security.accessDefault = b.accessDefault; }
    if (b.tokenScope != null) { if (!OAuth.SCOPES.includes(b.tokenScope)) return 'Unknown permission level'; c.security.tokenScope = b.tokenScope; }
  });
  if (r.ok && changedMode) securityEvent('mode-changed', { mode: changedMode });
  if (r.ok && b.allowTokenRemote != null) securityEvent('token-remote', { allowed: !!b.allowTokenRemote });
  return r;
}

/** From inside: can the public address reach the public port, and does it hide this page? */
let selfTest = null, selfNonce = '';
async function runSelfTest() {
  if (!cfg.publicUrl) return { ok: false, error: 'Enter the public address first' };
  selfNonce = crypto.randomBytes(12).toString('hex');
  const base = cfg.publicUrl, checks = [];
  const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-store' } }); return { status: r.status, text: await r.text() }; };
  try {
    const h = await get('/healthz?n=' + selfNonce);
    let j = null; try { j = JSON.parse(h.text); } catch (e) { /* not ours */ }
    checks.push({ name: 'The public address reaches HomeClaude\'s public port', ok: !!(j && j.match), detail: j && j.match ? 'Yes' : j && j.mode === 'local' ? 'It reaches HomeClaude, but exposed mode is off' : j ? 'It reaches a different HomeClaude' : 'Got ' + h.status + ' from something else. Point the proxy at port ' + PUBLIC_PORT + ' of this container' });
    const root = await get('/');
    checks.push({ name: 'This settings page is not reachable from outside', ok: root.status === 404 && !/<title>HomeClaude<\/title>/.test(root.text), detail: root.status === 404 ? 'Hidden' : 'Got ' + root.status + '. The proxy may point at the private port ' + PORT + ' instead of ' + PUBLIC_PORT });
    const st = await get('/api/state');
    checks.push({ name: 'Settings and tokens are not reachable from outside', ok: st.status === 404, detail: st.status === 404 ? 'Hidden' : 'Got ' + st.status });
    const prm = await get('/.well-known/oauth-protected-resource');
    let pj = null; try { pj = JSON.parse(prm.text); } catch (e) { /* no */ }
    checks.push({ name: 'Claude can find the sign-in', ok: !!(pj && pj.resource === base + '/mcp'), detail: pj ? (pj.resource === base + '/mcp' ? 'Yes' : 'It reports ' + pj.resource) : 'Got ' + prm.status });
    const mcpNoAuth = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
    checks.push({ name: 'Claude\'s endpoint refuses requests without sign-in', ok: mcpNoAuth.status === 401, detail: 'Got ' + mcpNoAuth.status });
    selfTest = { at: Date.now(), ok: checks.every((c) => c.ok), checks };
  } catch (e) {
    selfTest = { at: Date.now(), ok: false, checks, error: 'Could not reach ' + base + ' from inside HomeClaude (' + (e.cause && e.cause.code || e.message) + '). Some networks cannot loop back to their own public address; try it from your phone on mobile data.' };
  }
  selfNonce = '';
  return { ok: true };
}

function securitySnapshot() {
  return {
    mode: cfg.security.mode, publicUrl: cfg.publicUrl, accessDefault: cfg.security.accessDefault, publicPort: PUBLIC_PORT, adminPort: PORT,
    allowTokenRemote: cfg.security.allowTokenRemote, tokenScope: cfg.security.tokenScope,
    keyWhere: DEMO ? 'demo' : secrets.where(), keyFileOnVolume: !DEMO && secrets.hasFileKey(), keyMismatch,
    pending: oauth.listPending(), connections: oauth.connections().map((c) => Object.assign(c, { effective: accessFor(c.scope, true).level })), events: state.security.slice(0, 80), selfTest,
    totp: (() => { const t = cfg.security.totp, now = Date.now(); return { enabled: !!t.enabled, since: t.since, maxScope: t.maxScope, off: !!t.off, failsToday: state.totpFails.filter((x) => x > now - 86400e3).length, paused: state.totpFails.filter((x) => x > now - 3600e3).length >= 5 }; })()
  };
}

// ---------- the setup guide's progress ----------
const SETUP_MARKS = ['welcome', 'user', 'token', 'perms', 'pin', 'claude'];
function setupAction(b) {
  return changeConfig((c) => {
    if (b.reset) { c.setup = { completed: false, marks: {} }; return; }
    if (b.mark != null) {
      if (!SETUP_MARKS.includes(b.mark)) return 'Unknown step';
      if (b.value === false || b.value == null) delete c.setup.marks[b.mark];
      else c.setup.marks[b.mark] = b.value === 'skip' ? 'skip' : true;
    }
    if (typeof b.completed === 'boolean') c.setup.completed = b.completed;
  });
}

// ---------- what the page sees ----------
let bkCache = { n: 0, at: 0 };
function backupCount() {
  if (DEMO) return 0;
  if (Date.now() - bkCache.at > 5000) { try { bkCache = { n: backups.list().length, at: Date.now() }; } catch (e) { bkCache.at = Date.now(); } }
  return bkCache.n;
}
const backupsChanged = () => { bkCache.at = 0; };
function describeTools() {
  const a = localAccess();
  return tools.all().map((t) => ({ name: t.name, title: t.title, needs: t.needs || null, on: !t.needs || !!a[t.needs] }));
}
function snapshot() {
  return {
    version: pkg.version, now: Date.now(), demo: DEMO,
    ha: { url: DEMO ? ha.base() : cfg.ha.url, hasToken: DEMO || !!cfg.ha.token, status: haStatus },
    access: Object.assign({}, cfg.access, localAccess()),
    tools: describeTools(),
    publicUrl: cfg.publicUrl,
    backup: { keep: cfg.backup.keep },
    backupCount: backupCount(),
    activity: state.activity.slice(0, 60),
    activityTotal: state.activity.length,
    lastCallAt: state.lastCallAt || 0,
    pinRequired: pinSet(),
    review: cfg.review,
    esphome: { enabled: !!cfg.esphome.enabled, url: cfg.esphome.url, status: esphome.status() },
    reviews: state.reviews.slice(0, 40),
    health,
    security: securitySnapshot(),
    setup: cfg.setup,
    everConnected: !!(state.lastCallAt || state.activity.length),
    update: { latest: upd.latest, available: !!upd.latest && newer(upd.latest, pkg.version), checkedAt: upd.checkedAt, failed: upd.failed, enabled: UPDATE_CHECK && !DEMO, image: IMAGE + ':' + upd.latest }
  };
}

// ---------- is there a newer HomeClaude? (reads a version number from GitHub; changes nothing) ----------
const UPDATE_URL = process.env.HOMECLAUDE_UPDATE_URL || 'https://raw.githubusercontent.com/leonidis2013/HomeClaude/main/package.json';
const UPDATE_CHECK = process.env.HOMECLAUDE_NO_UPDATE_CHECK !== '1';
const IMAGE = 'ghcr.io/leonidis2013/homeclaude';
let upd = { latest: '', checkedAt: 0, failed: false };

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function checkSelfUpdate() {
  return new Promise((resolve) => {
    let done = false;
    const end = (latest) => {
      if (done) return; done = true;
      upd = latest ? { latest, checkedAt: Date.now(), failed: false } : { latest: upd.latest, checkedAt: Date.now(), failed: true };
      broadcastSoon();
      resolve(!!latest);
    };
    try {
      const lib = UPDATE_URL.startsWith('https:') ? https : http;
      const req = lib.get(UPDATE_URL, { timeout: 6000, headers: { 'user-agent': 'HomeClaude/' + pkg.version } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return end(null); }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        res.on('end', () => { try { const v = String(JSON.parse(raw).version || ''); end(/^\d+\.\d+\.\d+$/.test(v) ? v : null); } catch (e) { end(null); } });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => end(null));
    } catch (e) { end(null); }
  });
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, 'public');
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'] };
const clients = new Set();

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function postJson(req, res, fn, { needPin = true, limit = 16384 } = {}) {
  let raw = '', tooBig = false;
  req.on('data', (d) => { if (tooBig) return; raw += d; if (raw.length > limit) { tooBig = true; raw = ''; } });
  req.on('end', () => {
    if (needPin && pinSet()) {
      const ip = Net.clientIp(req, false), left = pinLimit.locked(ip);
      if (left) return json(res, 429, { ok: false, error: 'Too many wrong PINs. Try again in ' + Math.ceil(left / 60) + ' min.' });
      if (!pinOk(req.headers['x-pin'])) {
        if (req.headers['x-pin'] && pinLimit.hit(ip)) securityEvent('pin-lockout', { ip });
        return setTimeout(() => json(res, 401, { ok: false, error: 'Wrong or missing PIN' }), 500);
      }
      pinLimit.reset(ip);
    }
    if (tooBig) return json(res, 413, { ok: false, error: 'That is too large' });
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'Bad JSON' }); }
    Promise.resolve().then(() => fn(body)).then((r) => {
      r = r || { ok: false, error: 'Nothing happened' };
      json(res, r.ok ? 200 : (r.status || 400), Object.assign({}, r, { status: undefined }));
      broadcastSoon();
    }).catch((e) => json(res, 500, { ok: false, error: 'Something went wrong: ' + e.message }));
  });
}

let broadcastTimer = null;
function broadcastSoon() {
  if (!clients.size || broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const c of clients) c.write(msg);
  }, 150);
}

/**
 * The private port: settings page, its API, and /mcp for Claude Code on your network.
 * In exposed mode it refuses anything that came through a reverse proxy or from
 * outside the private address ranges, so even a wrongly pointed proxy cannot reach it.
 */
function adminRefusal(req) {
  if (!exposed()) return null;
  if (Net.cameThroughProxy(req)) return 'This is HomeClaude\'s private settings port. Point your reverse proxy at port ' + PUBLIC_PORT + ' (the public port) instead.';
  if (!Net.isPrivate(req.socket.remoteAddress)) return 'In exposed mode the settings page only opens from your home network.';
  return null;
}
let pageHashes = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;
  const refused = adminRefusal(req);
  if (refused) {
    securityEvent('admin-refused', { ip: Net.clientIp(req, Net.cameThroughProxy(req)), path: url.slice(0, 60) });
    res.writeHead(403, Net.securityHeaders({ 'content-type': 'text/plain; charset=utf-8' })); return res.end(refused);
  }

  // Claude Code on your network: /mcp with "Authorization: Bearer <token>", or /mcp/<token> for apps that only take a URL
  const m = /^\/mcp(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/.exec(url);
  if (m) return serveMcpLocal(req, res, m[1]);

  if (req.method === 'GET' && FILES[url]) {
    const [file, type] = FILES[url];
    return fs.readFile(path.join(PUBLIC, file), 'utf8', (err, data) => {
      if (err) { res.writeHead(500); return res.end('Missing ' + file); }
      if (!pageHashes || pageHashes.len !== data.length) pageHashes = Object.assign(Net.inlineHashes(data), { len: data.length });
      res.writeHead(200, Net.securityHeaders({ 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': Net.pageCsp(pageHashes) }));
      res.end(data);
    });
  }
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, snapshot());

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url === '/api/backups') return json(res, 200, { backups: DEMO ? [] : backups.list() });
  if (req.method === 'GET' && url === '/api/backup') {
    const bip = Net.clientIp(req, false);
    if (pinLimit.locked(bip)) { res.writeHead(429); return res.end('Too many wrong PINs'); }
    if (!pinOk(u.searchParams.get('pin') || req.headers['x-pin'])) { pinLimit.hit(bip); res.writeHead(401); return res.end('Wrong or missing PIN'); }
    const p = backups.filePath(u.searchParams.get('kind') || '', u.searchParams.get('id') || '', u.searchParams.get('file') || '');
    if (!p) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="' + (u.searchParams.get('kind') + '-' + u.searchParams.get('id') + '-' + path.basename(p)).replace(/[^A-Za-z0-9_.-]/g, '_') + '"' });
    return fs.createReadStream(p).pipe(res);
  }

  if (req.method === 'POST' && url === '/api/ha') return postJson(req, res, setHa);
  if (req.method === 'POST' && url === '/api/ha-test') return postJson(req, res, () => checkHa().then((s) => ({ ok: s.ok, error: s.ok ? undefined : (s.error || 'Home Assistant is not set up yet') })), { needPin: false });
  if (req.method === 'POST' && url === '/api/access') return postJson(req, res, setAccess);
  if (req.method === 'POST' && url === '/api/esphome') return postJson(req, res, setEsphome);
  if (req.method === 'POST' && url === '/api/esphome-test') return postJson(req, res, () => esphome.check().then((s) => { broadcastSoon(); return { ok: s.ok, error: s.ok ? undefined : s.error, devices: s.devices }; }), { needPin: false });
  if (req.method === 'POST' && url === '/api/token') return postJson(req, res, (b) => (b.regenerate ? newToken() : { ok: true, token: mcpToken() }));
  if (req.method === 'POST' && url === '/api/settings') return postJson(req, res, changeSettings);
  if (req.method === 'POST' && url === '/api/restore') return postJson(req, res, (b) => (DEMO ? { ok: false, error: 'Demo mode has no backups' } : restore(b)));
  if (req.method === 'POST' && url === '/api/health-check') return postJson(req, res, () => runHealth().then((h) => ({ ok: !!h })), { needPin: false });
  if (req.method === 'POST' && url === '/api/setup') return postJson(req, res, setupAction);
  if (req.method === 'POST' && url === '/api/security') return postJson(req, res, setSecurity);
  if (req.method === 'POST' && url === '/api/security/selftest') return postJson(req, res, runSelfTest);
  if (req.method === 'POST' && url === '/api/connections/decide') return postJson(req, res, (b) => oauth.decide(b.id, !!b.approve, b.scope, Net.clientIp(req, false), b.span == null ? cfg.security.accessDefault : b.span));
  if (req.method === 'POST' && url === '/api/connections/span') return postJson(req, res, (b) => (oauth.setSpan(String(b.id || ''), b.span) ? { ok: true } : { ok: false, error: 'Could not change it' }));
  if (req.method === 'POST' && url === '/api/connections/revoke') return postJson(req, res, (b) => {
    if (b.all) { const n = oauth.revokeAll('all connections revoked on the HomeClaude page'); return { ok: true, revoked: n }; }
    return oauth.revokeGrant(String(b.id || ''), 'revoked on the HomeClaude page') ? { ok: true } : { ok: false, error: 'That connection is gone' };
  });
  if (req.method === 'POST' && url === '/api/connections/scope') return postJson(req, res, (b) => (oauth.setScope(String(b.id || ''), b.scope) ? { ok: true } : { ok: false, error: 'Could not change it' }));
  if (req.method === 'POST' && url === '/api/review') return postJson(req, res, (b) => (b.rid ? decideReview(String(b.rid), !!b.keep, 'you') : setReview(b)), { limit: 4096 });
  if (req.method === 'POST' && url === '/api/totp') return postJson(req, res, totpAction);
  if (req.method === 'POST' && url === '/api/security/clear') return postJson(req, res, () => { state.security = []; saveState(); return { ok: true }; });
  if (req.method === 'POST' && url === '/api/activity-clear') return postJson(req, res, () => { state.activity = []; saveState(); return { ok: true }; });
  if (req.method === 'POST' && url === '/api/update-check') {
    return postJson(req, res, () => (UPDATE_CHECK && !DEMO) ? checkSelfUpdate().then((ok) => ({ ok, error: ok ? undefined : 'Could not reach GitHub to check. Is this machine online?' })) : { ok: false, error: 'Update checks are turned off' }, { needPin: false });
  }

  res.writeHead(404); res.end('Not found');
});

// ---------- the public port: only Claude's endpoint and the sign-in ----------
const failLimit = Net.limiter({ max: 10, windowMs: 10 * 60e3, lockMs: 30 * 60e3 });     // per address
const failGlobal = Net.limiter({ max: 300, windowMs: 10 * 60e3, lockMs: 10 * 60e3 });   // everyone together
const regLimit = Net.limiter({ max: 5, windowMs: 60 * 60e3, lockMs: 60 * 60e3 });
const authzLimit = Net.limiter({ max: 6, windowMs: 10 * 60e3, lockMs: 20 * 60e3 });

function publicFail(ip, why) {
  if (failLimit.hit(ip)) securityEvent('address-locked', { ip, why });
  if (failGlobal.hit('all')) securityEvent('public-paused', { why: 'too many failed attempts from many addresses' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '', big = false;
    req.on('data', (d) => { if (big) return; raw += d; if (raw.length > limit) { big = true; raw = ''; } });
    req.on('end', () => (big ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(raw)));
    req.on('error', reject);
  });
}
function parseForm(req, raw) {
  if (/application\/json/i.test(req.headers['content-type'] || '')) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}
function basicAuth(req) {
  const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const t = Buffer.from(m[1], 'base64').toString('utf8'), i = t.indexOf(':');
  return i < 0 ? null : { id: decodeURIComponent(t.slice(0, i)), secret: decodeURIComponent(t.slice(i + 1)) };
}

const publicServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname, ip = Net.clientIp(req, true);
  const base = () => Net.securityHeaders({ 'cache-control': 'no-store', 'strict-transport-security': 'max-age=31536000' });
  const send = (code, obj, extra) => { res.writeHead(code, Object.assign(base(), { 'content-type': 'application/json' }, extra || {})); res.end(obj == null ? '' : JSON.stringify(obj)); };
  const html = (code, page) => {
    const h = Net.inlineHashes(page);
    res.writeHead(code, Object.assign(base(), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src " + h.scripts.join(' ') + '; style-src ' + h.styles.join(' ') + "; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }));
    res.end(page);
  };
  try {
    // checks that hold for everything on this port
    if (url === '/healthz' && req.method === 'GET') return send(200, { ok: true, mode: cfg.security.mode, match: !!selfNonce && u.searchParams.get('n') === selfNonce });
    if (!exposed()) return send(404, { error: 'HomeClaude is in local mode. Nothing is served on the public port.' });
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto !== 'https' && !INSECURE_PUBLIC) return send(403, { error: 'HomeClaude only answers over https. The reverse proxy must send X-Forwarded-Proto: https.' });
    const want = (() => { try { return new URL(cfg.publicUrl).host.toLowerCase(); } catch (e) { return ''; } })();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    if (want && host !== want && !INSECURE_PUBLIC) return send(421, { error: 'This address is not the one HomeClaude is set up for (' + want + ').' });
    const left = Math.max(failLimit.locked(ip), failGlobal.locked('all'));
    if (left) return send(429, { error: 'Too many failed attempts. Try again later.' }, { 'retry-after': String(left) });

    // discovery
    if (req.method === 'GET' && (url === '/.well-known/oauth-protected-resource' || url === '/.well-known/oauth-protected-resource/mcp')) return send(200, oauth.resourceMetadata(), { 'cache-control': 'max-age=300' });
    if (req.method === 'GET' && url === '/.well-known/oauth-authorization-server') return send(200, oauth.serverMetadata(), { 'cache-control': 'max-age=300' });

    // sign-in
    if (req.method === 'POST' && url === '/oauth/register') {
      if (regLimit.locked(ip)) return send(429, { error: 'too_many_requests' });
      regLimit.hit(ip);
      const r = oauth.register(parseForm(req, await readBody(req, 16384)));
      return send(r.status, r.body);
    }
    if (req.method === 'GET' && url === '/oauth/authorize') {
      if (authzLimit.locked(ip)) return html(429, oauth.errorPage(429, 'Too many requests', 'Wait a while before trying to connect again.').html);
      authzLimit.hit(ip);
      const r = await oauth.authorize(Object.fromEntries(u.searchParams), ip);
      if (r.location) { res.writeHead(302, Object.assign(base(), { location: r.location })); return res.end(); }
      return html(r.status, r.html);
    }
    if (req.method === 'POST' && url === '/oauth/approve') {
      const b = parseForm(req, await readBody(req, 4096));
      const r = oauth.approveWithCode(b.id, b.s, b.code, b.scope, ip);
      if (r.status === 401) publicFail(ip, 'wrong authenticator code');
      return send(r.status, r.body);
    }
    if (req.method === 'GET' && url === '/oauth/status') { const r = oauth.status(u.searchParams.get('id'), u.searchParams.get('s')); return send(r.status, r.body); }
    if (req.method === 'POST' && url === '/oauth/token') {
      const r = await oauth.token(parseForm(req, await readBody(req, 16384)), basicAuth(req));
      if (r.status >= 400) publicFail(ip, 'token: ' + r.body.error);
      return send(r.status, r.body, { pragma: 'no-cache' });
    }
    if (req.method === 'POST' && url === '/oauth/revoke') { const r = await oauth.revokeToken(parseForm(req, await readBody(req, 16384)), basicAuth(req)); return send(r.status, r.body); }

    // Claude's endpoint
    if (url === '/mcp' || url === '/mcp/') {
      const tok = bearerOf(req);
      const challenge = 'Bearer resource_metadata="' + cfg.publicUrl + '/.well-known/oauth-protected-resource", scope="homeclaude"';
      const grant = oauth.verify(tok, ip);
      let who = null;
      if (grant) who = { label: grant.clientName, access: capAccess(grant.scope), remote: true, ip, key: grant.id };
      else if (tok && cfg.security.allowTokenRemote && tokenOk(tok)) who = { label: 'Access token (outside)', access: capAccess(cfg.security.tokenScope), remote: true, ip, key: 'token' };
      if (!who) {
        if (tok) publicFail(ip, 'bad token on /mcp');
        return setTimeout(() => send(401, { error: tok ? 'invalid_token' : 'Sign-in required' }, { 'www-authenticate': challenge + (tok ? ', error="invalid_token"' : '') }), tok ? 300 : 0);
      }
      if (!cfg.access.enabled) return send(503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Claude access is switched off in HomeClaude' } });
      return runMcp(req, res, who);
    }
    return send(404, { error: 'Not found' });
  } catch (e) {
    return send(e.status || 500, { error: e.status === 413 ? 'Request too large' : 'Something went wrong' });
  }
});
publicServer.headersTimeout = 20000; publicServer.requestTimeout = 60000;
server.headersTimeout = 20000;

setInterval(broadcastSoon, 1500).unref();
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => process.exit(0)));

function start() {
  mcpToken();
  if (!DEMO && UPDATE_CHECK) { setTimeout(checkSelfUpdate, 5000).unref(); setInterval(checkSelfUpdate, 6 * 3600 * 1000).unref(); }
  setTimeout(checkHa, DEMO ? 200 : 1000).unref();
  runHealth(); setInterval(runHealth, 60000).unref();
  setInterval(reviewTimer, Number(process.env.HOMECLAUDE_REVIEW_TICK_MS) || 15000).unref();
  setInterval(checkHa, 60000).unref();
  // ESPHome: find the Device Builder once Home Assistant answers, then look again now and then (the page shows it)
  const espCheck = () => { if (cfg.esphome.enabled && ha.configured()) esphome.check().then(broadcastSoon).catch(() => {}); };
  setTimeout(espCheck, 8000).unref(); setInterval(espCheck, 10 * 60e3).unref();
  publicServer.on('error', (e) => console.error('Public port ' + PUBLIC_PORT + ': ' + e.message));
  publicServer.listen(PUBLIC_PORT, '0.0.0.0', () => console.log('Public port ' + PUBLIC_PORT + ': ' + (exposed() ? 'exposed mode, Claude sign-in and /mcp only' : 'local mode, serves nothing')));
  server.listen(PORT, '0.0.0.0', () => {
    console.log('HomeClaude v' + pkg.version + ' on http://localhost:' + PORT + (DEMO ? ' (demo: simulated Home Assistant, access token "demo")' : ''));
    console.log('Claude connects to http://<this machine>:' + PORT + '/mcp');
    if (!pinSet()) console.log('Note: anyone on this network can open this page and see the access token. Set a control PIN in Settings to require one.');
  });
}

if (require.main === module) start();

module.exports = { snapshot, cfgGet: () => cfg };
