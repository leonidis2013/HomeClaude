/*
 * ESPHome device configs, through the ESPHome Device Builder's own MCP endpoint (POST /api/mcp).
 *
 * With the Device Builder app installed in Home Assistant, it is reached through Home
 * Assistant's ingress, the same way the Home Assistant web page opens it: an ingress session
 * is asked for over the WebSocket API with HomeClaude's access token, and requests go to
 * <Home Assistant>/api/hassio_ingress/<token>/api/mcp with that session as a cookie. Nothing
 * extra is opened on the network. A standalone Device Builder (Docker, no password) can be
 * given by its address instead.
 *
 * Only reading, writing and validating YAML is used here. HomeClaude never asks the Device
 * Builder to compile or install firmware, and never reads or changes secrets.yaml.
 */
'use strict';

class EspError extends Error {
  constructor(message, code) { super(message); this.code = code || ''; }
}

const SESSION_MS = 10 * 60e3; // the Supervisor ends an unused ingress session after 15 minutes
const FILE_RE = /^[a-z0-9][a-z0-9_.-]{0,100}\.ya?ml$/i;
const isSecrets = (f) => /^secrets\.ya?ml$/i.test(String(f || '').trim());

/** A device YAML file name HomeClaude may touch, or an error saying why not. */
function checkFile(name) {
  const f = String(name == null ? '' : name).trim();
  if (isSecrets(f)) throw new EspError('secrets.yaml is not available through HomeClaude. Use !secret names (list_esphome_devices shows them); a person adds or changes secrets in the ESPHome Device Builder.');
  if (!FILE_RE.test(f)) throw new EspError('Give the device\'s YAML file name, for example ro-water.yaml (from list_esphome_devices). No folders.');
  return f;
}

/*
 * Values that are written inline instead of as !secret (API encryption keys, OTA and Wi-Fi
 * passwords) are hidden before a config is shown to Claude, and put back when it is saved.
 */
const HIDDEN = '<hidden by HomeClaude>';
const SENSITIVE_KEY = /^(\s*(?:-\s+)?)(key|psk|password|[a-z0-9_]*_password|api_key|access_token|token)(\s*:\s*)(.+?)\s*$/i;
function isPlain(v) { return v && !/^!(secret|lambda|include)\b/.test(v) && !/^\$\{?[a-z_]/i.test(v) && !/^["']?\s*["']?$/.test(v) && v !== '|' && v !== '>'; }

function hide(text) {
  let n = 0;
  const out = String(text).split('\n').map((line) => {
    if (/^\s*#/.test(line)) return line;
    const m = line.match(SENSITIVE_KEY);
    if (!m || !isPlain(m[4].replace(/\s+#.*$/, ''))) return line;
    n++;
    return m[1] + m[2] + m[3] + '"' + HIDDEN + '"';
  }).join('\n');
  return { text: out, hidden: n };
}

/** Puts hidden values back from the current file. The n-th hidden "key:" gets the n-th such value. */
function unhide(next, current) {
  if (!String(next).includes(HIDDEN)) return String(next);
  const vals = {};
  String(current || '').split('\n').forEach((line) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(SENSITIVE_KEY);
    if (m && isPlain(m[4].replace(/\s+#.*$/, ''))) (vals[m[2].toLowerCase()] = vals[m[2].toLowerCase()] || []).push(m[4]);
  });
  const used = {};
  return String(next).split('\n').map((line) => {
    if (!line.includes(HIDDEN)) return line;
    const m = line.match(SENSITIVE_KEY);
    const k = m && m[2].toLowerCase();
    const i = k ? (used[k] = (used[k] || 0) + 1) - 1 : -1;
    if (!m || !vals[k] || i >= vals[k].length) throw new EspError('The text "' + HIDDEN + '" stands for a value HomeClaude hid, and there is no matching value in the current file to put back (for "' + (k || line.trim()) + '"). Use a !secret name instead, for example key: !secret ' + (k === 'key' ? 'api_key' : k || 'name') + '.');
    return m[1] + m[2] + m[3] + vals[k][i];
  }).join('\n');
}

/** Actions a device would ask Home Assistant to run in a blocked domain (homeassistant.action / service). */
function blockedActions(text, blocked) {
  if (!blocked || !blocked.length) return null;
  const re = new RegExp('^\\s*(?:-\\s+)?(?:action|service)\\s*:\\s*["\']?(' + blocked.map((d) => d.replace(/[^a-z0-9_]/g, '')).join('|') + ')\\.[a-z0-9_]+', 'im');
  const m = String(text).match(re);
  return m ? m[0].trim().replace(/^-\s+/, '') : null;
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/**
 * opts.ha             lib/ha.js client (command, base)
 * opts.settings()     -> { enabled, url }   url: a standalone Device Builder, '' = the Home Assistant app
 * opts.timeoutMs      default 30 s; validation gets longer
 * opts.fetch          only for the demo and tests
 */
function create(opts) {
  const ha = opts.ha;
  let found = null;   // { slug, name, entry }
  let session = null; // { id, at }
  let making = null;  // a session being asked for (requests at the same time share it)
  let lastStatus = { ok: false, checkedAt: 0, error: '', via: '', version: '' };

  const settings = () => Object.assign({ enabled: true, url: '' }, opts.settings ? opts.settings() : {});
  const own = () => String(settings().url || '').trim().replace(/\/+$/, '');
  function forget() { found = null; session = null; }

  async function sup(endpoint, method) {
    return ha.command({ type: 'supervisor/api', endpoint, method: method || 'get' }, { timeoutMs: 20000 });
  }
  async function findApp() {
    if (found) return found;
    let list;
    try { list = await sup('/addons'); }
    catch (e) {
      if (e.code === 'unknown_command') throw new EspError('This Home Assistant has no apps (no Supervisor), so the ESPHome Device Builder cannot be found through it. Enter the Device Builder\'s address in HomeClaude (Settings > Home Assistant > ESPHome).');
      if (e.status === 403) throw new EspError('Finding the ESPHome Device Builder app needs an administrator token.');
      throw e;
    }
    const apps = (list && list.addons) || [];
    const score = (a) => (/(^|_)esphome$/.test(a.slug) ? 3 : /esphome/i.test(a.slug + ' ' + a.name) ? 2 : 0) + (a.state === 'started' ? 1 : 0) - (/beta|dev/i.test(a.slug) ? 0.5 : 0);
    const best = apps.filter((a) => score(a) >= 2).sort((a, b) => score(b) - score(a))[0];
    if (!best) throw new EspError('The ESPHome Device Builder app is not installed in Home Assistant (Settings > Apps).');
    if (best.state && best.state !== 'started') throw new EspError('The ESPHome Device Builder app (' + best.name + ') is ' + best.state + '. Start it in Home Assistant (Settings > Apps).');
    let entry = '';
    try { entry = (await ha.command({ type: 'supervisor/ingress/info', slug: best.slug })).ingress_url; }
    catch (e) { if (e.code !== 'unknown_command') throw e; }
    if (!entry) entry = ((await sup('/addons/' + best.slug + '/info')) || {}).ingress_url;
    if (!entry) throw new EspError('The ESPHome Device Builder app has no web page (ingress) to reach.');
    found = { slug: best.slug, name: best.name, entry: entry.replace(/\/*$/, '/') };
    return found;
  }
  async function ingressSession(slug) {
    if (session && Date.now() - session.at < SESSION_MS) return session.id;
    if (!making) {
      making = (async () => {
        let r;
        try { r = await ha.command({ type: 'supervisor/ingress/session', slug }); }
        catch (e) { if (e.code !== 'unknown_command') throw e; r = await sup('/ingress/session', 'post'); }
        if (!r || !r.session) throw new EspError('Home Assistant did not give HomeClaude a session for the ESPHome app.');
        session = { id: r.session, at: Date.now() };
        return session.id;
      })().finally(() => { making = null; });
    }
    return making;
  }

  async function target() {
    if (!settings().enabled) throw new EspError('ESPHome is switched off in HomeClaude (Settings > Home Assistant > ESPHome).');
    if (own()) return { url: own() + '/api/mcp', headers: {}, via: own() };
    const app = await findApp();
    const id = await ingressSession(app.slug);
    return { url: ha.base() + app.entry + 'api/mcp', headers: { cookie: 'ingress_session=' + id }, via: app.name, sid: id };
  }

  let rpcId = 1;
  async function rpc(method, params, o = {}, retried) {
    const t = await target();
    let res;
    try {
      res = await (opts.fetch || fetch)(t.url, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, t.headers),
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: AbortSignal.timeout(o.timeoutMs || opts.timeoutMs || 30000)
      });
    } catch (e) {
      forget();
      const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
      throw new EspError('Could not reach the ESPHome Device Builder via ' + t.via + ' (' + why + ')');
    }
    const raw = await res.text();
    if ((res.status === 401 || res.status === 403) && !own() && !retried) {
      if (session && session.id === t.sid) session = null; // ended by the Supervisor: ask for a new one (once)
      return rpc(method, params, o, true);
    }
    if (res.status === 401) throw new EspError('The ESPHome Device Builder at ' + t.via + ' asks for a password. HomeClaude reaches a standalone Device Builder only without one; with the Home Assistant app, leave the address empty.');
    if (res.status === 404 || res.status === 405 || res.status === 415 || /<html/i.test(raw.slice(0, 200))) {
      forget();
      throw new EspError('The ESPHome Device Builder at ' + t.via + ' has no MCP endpoint (HTTP ' + res.status + '). Update the ESPHome Device Builder app.');
    }
    if (res.status === 502 || res.status === 503) { forget(); throw new EspError('The ESPHome Device Builder did not answer (HTTP ' + res.status + '). It may be starting or stopped.'); }
    let m;
    try { m = JSON.parse(raw); } catch (e) { throw new EspError('The ESPHome Device Builder answered HTTP ' + res.status + ': ' + raw.slice(0, 200)); }
    if (m.error) throw new EspError('ESPHome Device Builder: ' + (m.error.message || 'error ' + m.error.code));
    return m.result;
  }

  /** Runs one of the Device Builder's tools. Returns its text, parsed when it is JSON. */
  async function tool(name, args, o) {
    const r = await rpc('tools/call', { name, arguments: args || {} }, o);
    const text = ((r && r.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r && r.isError) {
      const code = (text.match(/^([a-z_]+):/) || [])[1] || '';
      throw new EspError('ESPHome: ' + text, code);
    }
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  async function devices() {
    const [list, secrets] = await Promise.all([tool('list_devices'), tool('list_secret_names').catch(() => null)]);
    return { devices: Array.isArray(list) ? list : [], secret_names: Array.isArray(secrets) ? secrets : null };
  }
  async function read(file) {
    const f = checkFile(file);
    const text = await tool('get_config', { configuration: f });
    return typeof text === 'string' ? text : String(text == null ? '' : JSON.stringify(text));
  }
  async function write(file, content, expected) {
    return tool('update_config', { configuration: checkFile(file), content, expected });
  }
  async function validate(file, tail) {
    const r = await tool('validate_config', { configuration: checkFile(file), tail_lines: tail || 60 }, { timeoutMs: 150000 });
    if (!r || typeof r !== 'object') throw new EspError('Unexpected answer from validate_config');
    const lines = (Array.isArray(r.output) ? r.output : String(r.output || '').split('\n')).map(strip).filter((l) => l.trim());
    return { valid: !!r.success, exit_code: r.exit_code, output: lines, truncated: !!r.truncated };
  }

  async function check() {
    try {
      const t = await target();
      const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'HomeClaude', version: opts.version || '0' } }, { timeoutMs: 10000 });
      const list = await tool('list_devices', {}, { timeoutMs: 15000 });
      lastStatus = { ok: true, checkedAt: Date.now(), error: '', via: t.via, version: ((init && init.serverInfo) || {}).version || '', devices: Array.isArray(list) ? list.length : 0 };
    } catch (e) {
      lastStatus = { ok: false, checkedAt: Date.now(), error: e.message, via: own() || (found && found.name) || '', version: '' };
    }
    return lastStatus;
  }

  return { devices, read, write, validate, check, status: () => lastStatus, forget, tool };
}

module.exports = { create, EspError, checkFile, hide, unhide, blockedActions, HIDDEN };
