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
const pkg = require('./package.json');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const cfgPath = process.env.CONFIG || path.join(__dirname, 'data', 'config.json');
const dataDir = path.dirname(path.resolve(cfgPath));
const statePath = path.join(dataDir, 'state.json');
const PORT = Number(process.env.PORT || 8080);
const DEMO_TOKEN = 'demo';

// ---------- config (saved from the web page) ----------
const DEFAULTS = {
  ha: { url: '', token: '' },
  access: { enabled: true, edit: false, services: false, delete: false, restart: false, blocked: Guard.DEFAULT_BLOCKED.slice() },
  mcpToken: '',
  publicUrl: '',
  backup: { keep: 30 },
  setup: { completed: false, marks: {} }
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; console.error(file + ' could not be read: ' + e.message); process.exit(1); }
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
['ha', 'access', 'backup', 'setup'].forEach((k) => { cfg[k] = Object.assign({}, DEFAULTS[k], cfg[k] || {}); });
cfg.access.blocked = Guard.cleanDomains(cfg.access.blocked);
if (!cfg.setup.marks || typeof cfg.setup.marks !== 'object') cfg.setup.marks = {};

function changeConfig(mutator) {
  const next = JSON.parse(JSON.stringify(cfg));
  try {
    const err = mutator(next);
    if (err) return { ok: false, error: err };
    if (!DEMO) writeJson(cfgPath, next);
  } catch (e) {
    return { ok: false, status: 500, error: 'Could not save the settings (' + (e.code || e.message) + '). Is ' + dataDir + ' writable?' };
  }
  cfg = next;
  return { ok: true };
}

const state = DEMO ? {} : readJson(statePath, {});
if (!Array.isArray(state.activity)) state.activity = [];
let saveTimer = null;
function saveState() {
  if (DEMO) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeJson(statePath, state); } catch (e) { console.error('Could not save state: ' + e.message); } }, 300);
}

// ---------- secrets: the Home Assistant token and Claude's access token ----------
const secrets = Secrets.create(path.join(dataDir, 'secret.key'));
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
const tools = Tools.create({ ha, backups, access: () => cfg.access });
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
const mcp = Mcp.create({
  serverInfo: { name: 'homeclaude', title: 'HomeClaude (Home Assistant)', version: pkg.version },
  instructions: Tools.INSTRUCTIONS,
  listTools: () => tools.list(),
  async callTool(name, a) {
    const t0 = Date.now(), def = tools.all().find((x) => x.name === name);
    const r = await tools.call(name, a);
    if (def && def.needs) backupsChanged();
    logActivity({ t: t0, tool: name, args: argSummary(a), ok: !r.isError, ms: Date.now() - t0, write: !!(def && def.needs), error: r.isError ? r.text.slice(0, 300) : undefined });
    return r;
  }
});

function tokenOk(given) {
  const want = Buffer.from(mcpToken()), got = Buffer.from(String(given || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function serveMcp(req, res, pathToken) {
  const send = (code, obj, extra) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {})); res.end(obj == null ? '' : JSON.stringify(obj)); };
  // a web page in a browser must not be able to use this (DNS rebinding); Claude's apps send no Origin
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(403, { error: 'Requests from web pages are not allowed' }); } catch (e) { return send(403, { error: 'Bad Origin' }); } }
  const auth = String(req.headers.authorization || '');
  const given = pathToken || (/^Bearer\s+(.+)$/i.exec(auth) || [])[1];
  if (!tokenOk(given)) return setTimeout(() => send(401, { error: 'Missing or wrong HomeClaude access token' }, { 'www-authenticate': 'Bearer realm="HomeClaude"' }), 400);
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
      const out = await mcp.handle(body, req.headers);
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
  if (r.ok) { ha.reset(); checkHa(); }
  return r;
}

function setAccess(b) {
  return changeConfig((c) => {
    ['enabled', 'edit', 'services', 'delete', 'restart'].forEach((k) => { if (typeof b[k] === 'boolean') c.access[k] = b[k]; });
    if (b.blocked != null) c.access.blocked = Guard.cleanDomains(b.blocked);
  });
}

function changeSettings(b) {
  if (Object.prototype.hasOwnProperty.call(b, 'newPin')) {
    if (b.newPin === null) return changeConfig((c) => { delete c.controlPinHash; verified.clear(); });
    const p = String(b.newPin);
    if (p.length < 4 || p.length > 64) return { ok: false, error: 'A PIN needs 4 to 64 characters' };
    return changeConfig((c) => { c.controlPinHash = hashPin(p); verified.clear(); });
  }
  return changeConfig((c) => {
    if (b.publicUrl != null) {
      const u = clean(b.publicUrl, 300).replace(/\/+$/, '').replace(/\/mcp$/, '');
      if (u && !/^https:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i.test(u)) return 'The public address must start with https://';
      c.publicUrl = u;
    }
    if (b.backupKeep != null) c.backup.keep = Math.min(200, Math.max(1, parseInt(b.backupKeep, 10) || 30));
  });
}

function newToken() {
  if (DEMO) return { ok: false, error: 'Demo mode uses the token "demo"' };
  const t = crypto.randomBytes(24).toString('base64url');
  const r = changeConfig((c) => { c.mcpToken = secrets.enc(t); });
  return r.ok ? { ok: true, token: t } : r;
}

async function restore(b) {
  const kind = String(b.kind || ''), id = String(b.id || ''), file = String(b.file || '');
  const bk = backups.read(kind, id, file);
  if (!bk || !bk.config) return { ok: false, error: 'That backup is gone' };
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
  return tools.all().map((t) => ({ name: t.name, title: t.title, needs: t.needs || null, on: !t.needs || !!cfg.access[t.needs] }));
}
function snapshot() {
  return {
    version: pkg.version, now: Date.now(), demo: DEMO,
    ha: { url: DEMO ? ha.base() : cfg.ha.url, hasToken: DEMO || !!cfg.ha.token, status: haStatus },
    access: cfg.access,
    tools: describeTools(),
    publicUrl: cfg.publicUrl,
    backup: { keep: cfg.backup.keep },
    backupCount: backupCount(),
    activity: state.activity.slice(0, 60),
    activityTotal: state.activity.length,
    lastCallAt: state.lastCallAt || 0,
    pinRequired: pinSet(),
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
    if (needPin && !pinOk(req.headers['x-pin'])) return setTimeout(() => json(res, 401, { ok: false, error: 'Wrong or missing PIN' }), 500);
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;

  // Claude connects here: /mcp with "Authorization: Bearer <token>", or /mcp/<token> for apps that only take a URL
  const m = /^\/mcp(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/.exec(url);
  if (m) return serveMcp(req, res, m[1]);

  if (req.method === 'GET' && FILES[url]) {
    const [file, type] = FILES[url];
    return fs.readFile(path.join(PUBLIC, file), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Missing ' + file); }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
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
    if (!pinOk(u.searchParams.get('pin') || req.headers['x-pin'])) { res.writeHead(401); return res.end('Wrong or missing PIN'); }
    const p = backups.filePath(u.searchParams.get('kind') || '', u.searchParams.get('id') || '', u.searchParams.get('file') || '');
    if (!p) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="' + (u.searchParams.get('kind') + '-' + u.searchParams.get('id') + '-' + path.basename(p)).replace(/[^A-Za-z0-9_.-]/g, '_') + '"' });
    return fs.createReadStream(p).pipe(res);
  }

  if (req.method === 'POST' && url === '/api/ha') return postJson(req, res, setHa);
  if (req.method === 'POST' && url === '/api/ha-test') return postJson(req, res, () => checkHa().then((s) => ({ ok: s.ok, error: s.ok ? undefined : (s.error || 'Home Assistant is not set up yet') })), { needPin: false });
  if (req.method === 'POST' && url === '/api/access') return postJson(req, res, setAccess);
  if (req.method === 'POST' && url === '/api/token') return postJson(req, res, (b) => (b.regenerate ? newToken() : { ok: true, token: mcpToken() }));
  if (req.method === 'POST' && url === '/api/settings') return postJson(req, res, changeSettings);
  if (req.method === 'POST' && url === '/api/restore') return postJson(req, res, (b) => (DEMO ? { ok: false, error: 'Demo mode has no backups' } : restore(b)));
  if (req.method === 'POST' && url === '/api/setup') return postJson(req, res, setupAction);
  if (req.method === 'POST' && url === '/api/activity-clear') return postJson(req, res, () => { state.activity = []; saveState(); return { ok: true }; });
  if (req.method === 'POST' && url === '/api/update-check') {
    return postJson(req, res, () => (UPDATE_CHECK && !DEMO) ? checkSelfUpdate().then((ok) => ({ ok, error: ok ? undefined : 'Could not reach GitHub to check. Is this machine online?' })) : { ok: false, error: 'Update checks are turned off' }, { needPin: false });
  }

  res.writeHead(404); res.end('Not found');
});

setInterval(broadcastSoon, 1500).unref();
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => process.exit(0)));

function start() {
  mcpToken();
  if (!DEMO && UPDATE_CHECK) { setTimeout(checkSelfUpdate, 5000).unref(); setInterval(checkSelfUpdate, 6 * 3600 * 1000).unref(); }
  setTimeout(checkHa, DEMO ? 200 : 1000).unref();
  setInterval(checkHa, 60000).unref();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('HomeClaude v' + pkg.version + ' on http://localhost:' + PORT + (DEMO ? ' (demo: simulated Home Assistant, access token "demo")' : ''));
    console.log('Claude connects to http://<this machine>:' + PORT + '/mcp');
    if (!pinSet()) console.log('Note: anyone on this network can open this page and see the access token. Set a control PIN in Settings to require one.');
  });
}

if (require.main === module) start();

module.exports = { snapshot, cfgGet: () => cfg };
