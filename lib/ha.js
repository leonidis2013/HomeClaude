/*
 * Talks to Home Assistant through its own official APIs only: the REST API and the
 * WebSocket API, logged in with a long-lived access token. Nothing is installed in
 * Home Assistant. Node 22 has fetch and WebSocket built in, so no packages are needed.
 */
'use strict';

class HaError extends Error {
  constructor(message, status, code) { super(message); this.status = status || 0; this.code = code || ''; }
}

function why(e, url) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
  const c = e.cause;
  if (c && c.code) return c.code === 'ECONNREFUSED' ? 'connection refused' : c.code === 'ENOTFOUND' ? 'address not found' + (/\.local\b/.test(String(url || '')) ? '. .local names usually do not resolve inside Docker; use the IP address' : '') : c.code;
  return e.message || String(e);
}

/**
 * opts.getUrl()   -> "http://homeassistant.local:8123"
 * opts.getToken() -> long-lived access token
 */
function create(opts) {
  const timeoutMs = opts.timeoutMs || 20000;
  let sock = null, ready = null, nextId = 1, haVersion = '';
  const pending = new Map();

  const base = () => String(opts.getUrl() || '').trim().replace(/\/+$/, '');
  const configured = () => !!(base() && opts.getToken());
  function needSetup() {
    if (!configured()) throw new HaError('Home Assistant is not set up yet. Enter its address and an access token in HomeClaude (Settings > Home Assistant).');
  }

  // ---------- REST ----------
  async function rest(method, path, body, o = {}) {
    needSetup();
    let res;
    try {
      res = await fetch(base() + path, {
        method,
        headers: { authorization: 'Bearer ' + opts.getToken(), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs || timeoutMs)
      });
    } catch (e) {
      throw new HaError('Could not reach Home Assistant at ' + base() + ' (' + why(e, base()) + ')');
    }
    const raw = await res.text();
    if (!res.ok) {
      let msg = '';
      try { msg = JSON.parse(raw).message || ''; } catch (e) { msg = raw.slice(0, 300); }
      if (res.status === 401) throw new HaError('Home Assistant refused the access token (401). Make a new long-lived token and enter it in HomeClaude.', 401);
      if (res.status === 403) throw new HaError('Home Assistant said this user may not do that (403). The token must belong to an administrator.', 403);
      throw new HaError('Home Assistant answered ' + res.status + (msg ? ': ' + msg : '') + ' (' + method + ' ' + path.replace(/\?.*$/, '') + ')', res.status);
    }
    if (o.text) return raw;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  // ---------- WebSocket ----------
  function dropAll(message) {
    for (const p of pending.values()) { clearTimeout(p.t); p.reject(new HaError(message)); }
    pending.clear();
  }

  function connect() {
    if (ready) return ready;
    const url = base().replace(/^http/i, 'ws') + '/api/websocket';
    ready = new Promise((resolve, reject) => {
      let ws, authed = false, failed = false;
      const fail = (reason) => {
        if (failed || authed) return;
        failed = true; clearTimeout(timer); ready = null; sock = null;
        try { ws.close(); } catch (e) { /* already closed */ }
        reject(new HaError('Could not open the WebSocket to Home Assistant (' + reason + ')'));
      };
      const timer = setTimeout(() => fail('timed out'), 10000);
      try { ws = new WebSocket(url); } catch (e) { return fail(why(e)); }
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (e) { return; }
        if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: opts.getToken() }));
        else if (m.type === 'auth_ok') { authed = true; clearTimeout(timer); sock = ws; haVersion = m.ha_version || haVersion; resolve(ws); }
        else if (m.type === 'auth_invalid') fail('the access token was refused');
        else if (m.type === 'pong' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); p.resolve(true); }
        else if (m.type === 'result' && pending.has(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
          if (m.success) p.resolve(m.result);
          else {
            const err = m.error || {};
            const code = err.code === 'unauthorized' ? 403 : err.code === 'not_found' ? 404 : 0;
            p.reject(new HaError('Home Assistant: ' + (err.message || err.code || 'command failed') + ' (' + p.type + ')', code, err.code));
          }
        }
      };
      ws.onerror = () => fail('could not connect to ' + url);
      ws.onclose = () => {
        if (!authed) return fail('the connection closed');
        if (sock === ws) { sock = null; ready = null; }
        dropAll('The connection to Home Assistant closed');
      };
    });
    ready.catch(() => {});
    return ready;
  }

  /** One WebSocket command, e.g. { type: 'config_entries/get' }. Resolves with its result. */
  async function command(msg, o = {}) {
    needSetup();
    const ws = await connect();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new HaError('Home Assistant did not answer ' + msg.type + ' in time')); }, o.timeoutMs || timeoutMs);
      pending.set(id, { resolve, reject, t, type: msg.type });
      try { ws.send(JSON.stringify(Object.assign({}, msg, { id }))); }
      catch (e) { clearTimeout(t); pending.delete(id); reject(new HaError('Could not send to Home Assistant (' + why(e) + ')')); }
    });
  }

  /** After the address or token changes. */
  function reset() {
    const ws = sock;
    sock = null; ready = null;
    dropAll('Settings changed');
    if (ws) { try { ws.close(); } catch (e) { /* fine */ } }
  }

  return { rest, command, reset, configured, base, version: () => haVersion, HaError };
}

module.exports = { create, HaError };
