'use strict';
/* node test/run.js  -  no test framework needed */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const Guard = R('lib/guard'), Mcp = R('lib/mcp'), Tools = R('lib/tools'), Demo = R('lib/demo'), Backups = R('lib/backups'), Ha = R('lib/ha');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-' + p + '-'));
const BLOCK = Guard.DEFAULT_BLOCKED;

function toolsWith(access, world) {
  const a = Object.assign({ edit: false, services: false, delete: false, restart: false, blocked: BLOCK }, access);
  const ha = Demo.client(world);
  const backups = Backups.create({ dir: tmp('bk'), keep: 3 });
  return { t: Tools.create({ ha, backups, access: () => a, settleMs: 5 }), ha, backups, a };
}
const parse = (r) => JSON.parse(r.text);

// ---------- a fake Home Assistant over real HTTP + WebSocket ----------
function fakeHa(opts = {}) {
  const world = Demo.createWorld();
  const TOKEN = opts.token || 'good-token';
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"401: Unauthorized"}'); }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const r = world.rest(req.method, req.url, raw ? JSON.parse(raw) : undefined);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      res.writeHead(r.status, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json' });
      res.end(text);
    });
  });
  // minimal WebSocket server (RFC 6455 text frames) speaking Home Assistant's auth + command protocol
  const upgraded = new Set();
  server.on('upgrade', (req, sock) => {
    if (req.url !== '/api/websocket') return sock.destroy();
    upgraded.add(sock); sock.on('close', () => upgraded.delete(sock));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const send = (obj) => {
      const p = Buffer.from(JSON.stringify(obj));
      const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
      sock.write(Buffer.concat([head, p]));
    };
    let buf = Buffer.alloc(0), authed = false;
    send({ type: 'auth_required', ha_version: '2026.10.2' });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        if (op !== 1) continue;
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'auth') { authed = m.access_token === TOKEN; send({ type: authed ? 'auth_ok' : 'auth_invalid', ha_version: '2026.10.2', message: 'Invalid access token' }); if (!authed) sock.end(); continue; }
        if (!authed) continue;
        if (m.type === 'ping') { send({ id: m.id, type: 'pong' }); continue; }
        const r = world.ws(m);
        send(Object.assign({ id: m.id, type: 'result' }, r));
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ world, server, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { upgraded.forEach((x) => x.destroy()); server.closeAllConnections(); server.close(() => r()); setTimeout(r, 1000).unref(); }) })));
}

// ---------- safety rules ----------
test('guard: blocked domains and generic calls', () => {
  assert.ok(Guard.checkCall('lock', 'unlock', {}, BLOCK));
  assert.ok(Guard.checkCall('cover', 'open_cover', {}, BLOCK));
  assert.strictEqual(Guard.checkCall('light', 'turn_on', { target: { entity_id: 'light.kitchen' } }, BLOCK), null);
  assert.ok(Guard.checkCall('homeassistant', 'turn_on', { target: { entity_id: ['light.a', 'cover.garage_door'] } }, BLOCK), 'generic call aimed at a cover');
  assert.ok(Guard.checkCall('homeassistant', 'toggle', { target: { area_id: 'garage' } }, BLOCK), 'generic call by area');
  assert.ok(Guard.checkCall('homeassistant', 'turn_off', {}, BLOCK), 'generic call with no target');
  assert.ok(Guard.checkCall('light', 'turn_on', { data: { entity_id: 'lock.front_door, light.a' } }, BLOCK), 'comma list in data');
  assert.strictEqual(Guard.checkCall('homeassistant', 'turn_on', { target: { area_id: 'garage' } }, []), null, 'nothing blocked: allowed');
  assert.deepStrictEqual(Guard.cleanDomains('Lock, cover;x  alarm_control_panel bad-name'), ['lock', 'alarm_control_panel']);
});

test('guard: automation and script configs', () => {
  const ok = { alias: 'x', triggers: [{ trigger: 'state', entity_id: 'lock.front_door', to: 'unlocked' }], conditions: [{ condition: 'state', entity_id: 'cover.garage_door', state: 'open' }], actions: [{ action: 'notify.phone', data: { message: "{{ states('lock.front_door') }}" } }] };
  assert.strictEqual(Guard.checkConfig(ok, BLOCK), null, 'reading blocked entities in triggers, conditions and messages is fine');
  assert.ok(Guard.checkConfig({ actions: [{ choose: [{ conditions: [], sequence: [{ service: 'lock.unlock', target: { entity_id: 'lock.front_door' } }] }] }] }, BLOCK), 'nested old-style service');
  assert.ok(Guard.checkConfig({ sequence: [{ action: 'homeassistant.turn_on', target: { entity_id: 'cover.garage_door' } }] }, BLOCK));
  assert.ok(Guard.checkConfig({ actions: [{ device_id: 'd4', domain: 'lock', type: 'unlock' }] }, BLOCK), 'device action');
  assert.strictEqual(Guard.checkConfig({ actions: [{ condition: 'device', device_id: 'd4', domain: 'lock', type: 'is_locked' }] }, BLOCK), null, 'device condition only reads');
  assert.ok(Guard.checkConfig({ actions: [{ action: '{{ svc }}' }] }, BLOCK), 'templated service name');
});

// ---------- MCP protocol ----------
test('mcp: handshake, discover, tools, errors', async () => {
  const m = Mcp.create({ serverInfo: { name: 's', version: '1' }, instructions: 'hi', listTools: () => [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }], callTool: async (n, a) => ({ text: 'got ' + JSON.stringify(a), isError: false }) });
  let r = await m.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(r.result.protocolVersion, '2025-06-18');
  r = await m.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.strictEqual(r.result.protocolVersion, '2025-11-25', 'unknown version falls back');
  assert.strictEqual(await m.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  r = await m.handle({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.ok(r.result.supportedVersions.includes('2026-07-28') && r.result.cacheScope && r.result.ttlMs >= 0);
  r = await m.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-protocol-version': '2026-07-28' });
  assert.strictEqual(r.result.tools[0].name, 'a'); assert.strictEqual(r.result.resultType, 'complete');
  r = await m.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'a', arguments: { x: 1 } } });
  assert.strictEqual(r.result.content[0].text, 'got {"x":1}');
  r = await m.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.strictEqual(r.error.code, -32602);
  r = await m.handle({ jsonrpc: '2.0', id: 6, method: 'bogus' });
  assert.strictEqual(r.error.code, -32601);
  r = await m.handle([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  assert.strictEqual(r.length, 1);
});

// ---------- tools against the pretend Home Assistant ----------
test('tools: read-only by default, write tools hidden', async () => {
  const { t } = toolsWith({});
  const names = t.list().map((x) => x.name);
  assert.ok(names.includes('get_traces') && !names.includes('save_automation') && !names.includes('call_service'));
  const r = await t.call('call_service', { domain: 'light', service: 'turn_on' });
  assert.ok(r.isError && /not allowed/.test(r.text));
});

test('tools: overview, entity, traces, logs find the freezer problem', async () => {
  const { t } = toolsWith({});
  const o = parse(await t.call('get_overview', {}));
  assert.strictEqual(o.integrations.problems[0].domain, 'tuya');
  assert.strictEqual(o.entities.unavailable_or_unknown, 1);
  const e = parse(await t.call('get_entity', { entity_id: 'sensor.garage_freezer_temperature' }));
  assert.strictEqual(e.area, 'Garage'); assert.deepStrictEqual(e.related.automation, ['automation.freezer_alert']);
  const runs = parse(await t.call('get_traces', { entity_id: 'automation.freezer_alert' }));
  assert.strictEqual(runs.runs[0].result, 'error');
  const run = parse(await t.call('get_traces', { entity_id: 'automation.freezer_alert', run_id: runs.runs[0].run_id }));
  assert.ok(run.steps.some((s) => /unavailable/.test(s.error || '')));
  const logs = parse(await t.call('get_logs', { level: 'error', search: 'tuya' }));
  assert.strictEqual(logs.total, 1);
  const raw = (await t.call('get_logs', { raw_lines: 5, search: 'tuya' })).text;
  assert.ok(/Connection timed out/.test(raw));
  const se = parse(await t.call('search_entities', { area: 'garage', domain: 'sensor' }));
  assert.strictEqual(se.total, 1);
  const yaml = await t.call('get_automation', { entity_id: 'automation.yaml_only_example' });
  assert.ok(yaml.isError && /YAML/.test(yaml.text));
  const tpl = await t.call('render_template', { template: "{{ states('light.kitchen') }}" });
  assert.strictEqual(tpl.text, 'on');
});

test('tools: save_automation backs up, refuses blocked actions', async () => {
  const { t, ha, backups } = toolsWith({ edit: true });
  const before = parse(await t.call('get_automation', { entity_id: 'automation.freezer_alert' }));
  const fixed = JSON.parse(JSON.stringify(before.config));
  fixed.actions[0].data.message = "Freezer is at {{ states('sensor.garage_freezer_temperature') | float(0) }}°F";
  const r = parse(await t.call('save_automation', { id: before.id, config: fixed }));
  assert.ok(r.saved && !r.created && r.backup);
  assert.strictEqual(backups.list()[0].reason, 'before-change');
  assert.strictEqual(backups.read('automation', before.id, r.backup).config.actions[0].data.message, before.config.actions[0].data.message, 'backup holds the old version');
  assert.ok(/float\(0\)/.test(ha.world.w.automations[before.id].actions[0].data.message));
  const bad = await t.call('save_automation', { id: before.id, config: Object.assign({}, fixed, { actions: [{ action: 'lock.unlock', target: { entity_id: 'lock.front_door' } }] }) });
  assert.ok(bad.isError && /blocked/.test(bad.text));
  const created = parse(await t.call('save_automation', { config: { alias: 'Hall light', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' } }] } }));
  assert.ok(created.created && created.entity_id === 'automation.hall_light' && !created.backup);
  const invalid = await t.call('save_automation', { config: { alias: 'No triggers', actions: [] } });
  assert.ok(invalid.isError && /400/.test(invalid.text), 'Home Assistant validation errors come back to Claude');
});

test('tools: backups are pruned to the keep count', async () => {
  const { t, backups } = toolsWith({ edit: true });
  const cfg = parse(await t.call('get_automation', { id: '1700000000001' })).config;
  for (let i = 0; i < 5; i++) { cfg.description = 'v' + i; await t.call('save_automation', { id: '1700000000001', config: cfg }); }
  assert.strictEqual(backups.list().filter((b) => b.id === '1700000000001').length, 3);
});

test('tools: delete needs its own switch and makes a backup', async () => {
  const { t, ha, backups } = toolsWith({ edit: true });
  assert.ok((await t.call('delete_automation', { id: '1700000000003' })).isError);
  const { t: t2, ha: ha2, backups: b2 } = toolsWith({ delete: true });
  const r = parse(await t2.call('delete_automation', { entity_id: 'automation.morning_coffee' }));
  assert.ok(r.deleted && r.backup);
  assert.ok(!ha2.world.w.automations['1700000000003']);
  assert.strictEqual(b2.read('automation', '1700000000003', r.backup).config.alias, 'Morning coffee');
  void ha; void backups;
});

test('tools: call_service guarded, restart only after a valid config check', async () => {
  const { t, ha } = toolsWith({ services: true, restart: true });
  assert.ok((await t.call('call_service', { domain: 'lock', service: 'unlock', target: { entity_id: 'lock.front_door' } })).isError);
  assert.ok((await t.call('call_service', { domain: 'homeassistant', service: 'turn_on', target: { area_id: 'garage' } })).isError);
  assert.ok((await t.call('call_service', { domain: 'homeassistant', service: 'restart' })).isError, 'restart has its own tool');
  const ok = parse(await t.call('call_service', { domain: 'switch', service: 'turn_on', target: { entity_id: 'switch.coffee_maker' } }));
  assert.deepStrictEqual(ok.changed, [{ entity_id: 'switch.coffee_maker', state: 'on' }]);
  assert.ok(!ha.world.w.calls.some((c) => c.domain === 'lock'), 'nothing reached Home Assistant for the lock');
  ha.world.w.configValid = false;
  const no = await t.call('restart_home_assistant', { reason: 'test' });
  assert.ok(no.isError && /check failed/.test(no.text) && ha.world.w.restarts === 0);
  ha.world.w.configValid = true;
  assert.ok(!(await t.call('restart_home_assistant', { reason: 'test' })).isError);
  assert.strictEqual(ha.world.w.restarts, 1);
});

test('tools: big answers are cut to size', () => {
  const big = { list: Array.from({ length: 20000 }, (_, i) => ({ entity_id: 'sensor.s' + i, state: 'x'.repeat(10) })) };
  const text = Tools.fit(big);
  assert.ok(text.length < 61000 && /cut:/.test(text));
});

// ---------- health ----------
test('health: storage, mounts and memory', async () => {
  const Health = R('lib/health');
  const ok = await Health.checkStorage(tmp('h'));
  assert.ok(ok.writable && ok.level !== 'bad' && ok.free, JSON.stringify(ok));
  const file = path.join(tmp('h2'), 'not-a-folder'); fs.writeFileSync(file, 'x');
  const bad = await Health.checkStorage(path.join(file, 'data'));
  assert.ok(!bad.writable && bad.level === 'bad' && bad.problems.length, JSON.stringify(bad));
  const mi = [
    '20 1 0:30 / / rw,relatime - overlay overlay rw',
    '21 20 0:40 / /data rw,relatime - nfs4 10.0.0.5:/mnt/Ulicki/x rw',
    '22 20 0:41 / /ro rw,relatime - zfs Ulicki/y ro'
  ].join('\n');
  const m = Health.mountFor('/data', mi);
  assert.strictEqual(m.fsType, 'nfs4');
  assert.strictEqual(Health.describeMount(m, '/data').kind, 'network');
  assert.strictEqual(Health.describeMount(Health.mountFor('/app/data', mi), '/app/data').kind, 'container');
  assert.ok(Health.mountFor('/ro/z', mi).readOnly);
  const mem = Health.checkMemory({ cgroupRoot: tmp('cg') });
  assert.ok(mem.used > 0 && mem.level);
  const cg = tmp('cg2'); fs.writeFileSync(cg + '/memory.max', String(100 * 1024 * 1024)); fs.writeFileSync(cg + '/memory.current', String(97 * 1024 * 1024));
  assert.strictEqual(Health.checkMemory({ cgroupRoot: cg }).level, 'bad');
});

// ---------- the real Home Assistant client over HTTP + WebSocket ----------
test('ha client: REST and WebSocket against a fake Home Assistant', async () => {
  const f = await fakeHa();
  try {
    let token = 'good-token';
    const ha = Ha.create({ getUrl: () => f.url + '/', getToken: () => token, timeoutMs: 4000 });
    const c = await ha.rest('GET', '/api/config');
    assert.strictEqual(c.version, '2026.10.2');
    assert.strictEqual(await ha.command({ type: 'ping' }), true);
    const entries = await ha.command({ type: 'config_entries/get' });
    assert.strictEqual(entries.length, 4);
    const [a, b] = await Promise.all([ha.command({ type: 'system_log/list' }), ha.command({ type: 'config/area_registry/list' })]);
    assert.ok(a.length === 3 && b.length === 3, 'parallel commands are matched by id');
    await assert.rejects(ha.command({ type: 'trace/get', domain: 'automation', item_id: 'x', run_id: 'y' }), (e) => e.status === 404);
    await assert.rejects(ha.rest('GET', '/api/states/sensor.none'), (e) => e.status === 404);
    // tools through the real client
    const t = Tools.create({ ha, backups: Backups.create({ dir: tmp('bk'), keep: 5 }), access: () => ({ blocked: BLOCK }), settleMs: 5 });
    const ov = JSON.parse((await t.call('get_overview', {})).text);
    assert.strictEqual(ov.integrations.problems.length, 1);
    // wrong token
    token = 'bad'; ha.reset();
    await assert.rejects(ha.rest('GET', '/api/config'), (e) => e.status === 401 && /refused the access token/.test(e.message));
    await assert.rejects(ha.command({ type: 'ping' }), /token was refused/);
    // not set up
    const none = Ha.create({ getUrl: () => '', getToken: () => '' });
    await assert.rejects(none.rest('GET', '/api/'), /not set up/);
    // nothing listening
    const dead = Ha.create({ getUrl: () => 'http://127.0.0.1:1', getToken: () => 'x', timeoutMs: 2000 });
    await assert.rejects(dead.rest('GET', '/api/'), /Could not reach Home Assistant/);
    await assert.rejects(dead.command({ type: 'ping' }), /WebSocket/);
    ha.reset();
  } finally { await f.close(); }
});

// ---------- the whole server, over HTTP ----------
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function req(port, method, p, body, headers) {
  if (process.env.DEBUG) console.log('  ->', method, p);
  const res = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, j, text };
}

// ---------- security ----------
const Net = R('lib/netsec'), OAuth = R('lib/oauth'), Secrets = R('lib/secrets');
const b64sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');

test('security: private addresses, client address, rate limits', () => {
  ['10.1.2.3', '192.168.1.5', '172.20.0.1', '127.0.0.1', '::1', '::ffff:192.168.0.9', '100.101.1.1', 'fd12::1', 'fe80::1'].forEach((ip) => assert.ok(Net.isPrivate(ip), ip));
  ['8.8.8.8', '172.32.0.1', '2606:4700::1', '', 'nonsense'].forEach((ip) => assert.ok(!Net.isPrivate(ip), ip));
  const req = (h, peer) => ({ headers: h, socket: { remoteAddress: peer || '172.17.0.1' } });
  assert.strictEqual(Net.clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), true), '5.6.7.8', 'the proxy-added (last) entry, not the made-up first one');
  assert.strictEqual(Net.clientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }), true), '9.9.9.9');
  assert.strictEqual(Net.clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), false), '172.17.0.1', 'ignored off the public port');
  assert.ok(Net.cameThroughProxy(req({ forwarded: 'for=1.2.3.4' })) && !Net.cameThroughProxy(req({})));
  const l = Net.limiter({ max: 3, windowMs: 60000, lockMs: 60000 });
  assert.ok(!l.hit('a') && !l.hit('a') && l.hit('a'), 'third failure locks');
  assert.ok(l.locked('a') > 0 && !l.locked('b'));
  const h = Net.inlineHashes('<style>a{}</style><script>x()</script>');
  assert.ok(/^'sha256-/.test(h.scripts[0]) && h.styles.length === 1);
});

test('security: master key moves tokens off the volume', () => {
  const d = tmp('key'), kf = path.join(d, 'secret.key');
  const a = Secrets.create(kf);
  const blob = a.enc('ha-token'), check = a.makeCheck();
  assert.ok(blob.startsWith('enc1:') && fs.existsSync(kf));
  const b = Secrets.create(kf, { masterKey: 'correct horse battery staple' });
  const moved = b.migrate({ ha: blob, check });
  assert.ok(moved.ha.startsWith('enc2:') && b.dec(moved.ha) === 'ha-token' && b.checkOk(moved.check));
  assert.ok(b.dropFileKey() && !fs.existsSync(kf));
  const wrong = Secrets.create(kf, { masterKey: 'wrong' });
  assert.strictEqual(wrong.dec(moved.ha), '', 'wrong master key decrypts nothing');
  assert.ok(!wrong.checkOk(moved.check), 'and the mismatch is detected');
});

function oauthWith(extra) {
  let store = {};
  const events = [];
  const o = OAuth.create(Object.assign({ load: () => store, save: (db) => { store = JSON.parse(JSON.stringify(db)); }, base: () => 'https://hc.example.com', event: (t, d) => events.push(t) }, extra || {}));
  return { o, events, store: () => store };
}
async function signIn(o, opts) {
  opts = opts || {};
  const reg = o.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const cid = reg.body.client_id, verifier = crypto.randomBytes(32).toString('base64url');
  const a = await o.authorize({ response_type: 'code', client_id: cid, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 'xyz', resource: 'https://hc.example.com/mcp' }, '203.0.113.5');
  assert.strictEqual(a.status, 200, JSON.stringify(a));
  const data = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(a.html)[1]);
  const shown = /<div class="code"[^>]*>([A-Z0-9-]+)<\/div>/.exec(a.html)[1];
  const p = o.listPending()[0];
  assert.strictEqual(p.code, shown, 'the home page shows the same code as the sign-in page');
  assert.strictEqual(o.status(data.id, data.s).body.status, 'waiting');
  assert.strictEqual(o.status(data.id, 'wrong-secret').status, 404, 'only the sign-in page can poll');
  assert.ok(o.decide(p.id, true, opts.scope || 'read', '192.168.1.5', opts.span || 'none').ok);
  const red = new URL(o.status(data.id, data.s).body.redirect);
  assert.strictEqual(red.searchParams.get('state'), 'xyz'); assert.strictEqual(red.searchParams.get('iss'), 'https://hc.example.com');
  return { cid, verifier, code: red.searchParams.get('code') };
}

test('oauth: approval at home, PKCE, one-time codes, rotation, theft detection', async () => {
  const { o, events } = oauthWith();
  assert.strictEqual(o.resourceMetadata().resource, 'https://hc.example.com/mcp');
  assert.deepStrictEqual(o.serverMetadata().code_challenge_methods_supported, ['S256']);
  // bad requests
  assert.strictEqual(o.register({ redirect_uris: ['http://evil.example/cb'] }).status, 400, 'plain http redirect refused');
  const reg = o.register({ client_name: 'x', redirect_uris: ['https://claude.ai/cb'] });
  const noPkce = await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb', state: 's' }, 'ip');
  assert.ok(noPkce.status === 302 && /error=invalid_request/.test(noPkce.location), 'PKCE required');
  const wrongRedirect = await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.ok(wrongRedirect.status === 400 && wrongRedirect.html, 'never redirects to an unregistered address');
  assert.strictEqual((await o.authorize({ response_type: 'code', client_id: 'nobody', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }, 'ip')).status, 400);
  // the happy path
  const s1 = await signIn(o, { scope: 'build' });
  const badPkce = await o.token({ grant_type: 'authorization_code', client_id: s1.cid, code: s1.code, code_verifier: 'wrong'.repeat(10), redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.strictEqual(badPkce.body.error, 'invalid_grant');
  const s2 = await signIn(o, { scope: 'build' });
  const t = await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: 'https://hc.example.com/mcp' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  const g = o.verify(t.body.access_token, '1.2.3.4');
  assert.ok(g && g.scope === 'build');
  assert.strictEqual(o.verify('hca_made_up'), null);
  // codes work once; using one twice cuts off what it made
  const again = await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier });
  assert.strictEqual(again.body.error, 'invalid_grant');
  assert.strictEqual(o.verify(t.body.access_token), null, 'reused code revoked the connection');
  // refresh rotation and reuse detection
  const s3 = await signIn(o);
  const t3 = (await o.token({ grant_type: 'authorization_code', client_id: s3.cid, code: s3.code, code_verifier: s3.verifier })).body;
  const r1 = (await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t3.refresh_token })).body;
  assert.ok(r1.access_token && r1.refresh_token !== t3.refresh_token, 'refresh token rotates');
  assert.ok(o.verify(r1.access_token));
  const stolen = await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t3.refresh_token });
  assert.strictEqual(stolen.body.error, 'invalid_grant');
  assert.strictEqual(o.verify(r1.access_token), null, 'old refresh token used again: whole connection revoked');
  assert.ok(events.includes('connection-revoked'));
  // another client cannot use someone else's refresh token
  const s4 = await signIn(o);
  const t4 = (await o.token({ grant_type: 'authorization_code', client_id: s4.cid, code: s4.code, code_verifier: s4.verifier })).body;
  assert.strictEqual((await o.token({ grant_type: 'refresh_token', client_id: s3.cid, refresh_token: t4.refresh_token })).body.error, 'invalid_grant');
  // revoke from home
  const c = o.connections().find((x) => x.scope === 'read');
  assert.ok(o.revokeGrant(c.id) && !o.verify(t4.access_token));
  // tokens are stored only as hashes
  assert.ok(!JSON.stringify(oauthWith().store()).includes('hca_'));
});

test('oauth: access time ends a connection, and can be extended', async () => {
  const { o, events } = oauthWith();
  const s1 = await signIn(o, { span: '1h' });
  const t = (await o.token({ grant_type: 'authorization_code', client_id: s1.cid, code: s1.code, code_verifier: s1.verifier })).body;
  const c = o.connections()[0];
  assert.ok(c.expiresAt > Date.now() + 3590e3 && c.expiresAt <= Date.now() + 3600e3, 'one hour');
  assert.ok(t.expires_in <= 3600);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 3600e3; // two hours later
    assert.strictEqual(o.verify(t.access_token), null, 'no longer works');
    assert.strictEqual((await o.token({ grant_type: 'refresh_token', client_id: s1.cid, refresh_token: t.refresh_token })).body.error, 'invalid_grant', 'cannot refresh past it either');
  } finally { Date.now = realNow; }
  assert.ok(events.includes('connection-revoked'));
  // extending
  const s2 = await signIn(o, { span: '1h' });
  const t2 = (await o.token({ grant_type: 'authorization_code', client_id: s2.cid, code: s2.code, code_verifier: s2.verifier })).body;
  const g2 = o.connections().find((x) => x.expiresAt);
  assert.ok(o.setSpan(g2.id, 'none') && o.connections().find((x) => x.id === g2.id).expiresAt === null);
  try { Date.now = () => realNow() + 2 * 3600e3; assert.ok((await o.token({ grant_type: 'refresh_token', client_id: s2.cid, refresh_token: t2.refresh_token })).body.access_token, 'extended connection refreshes'); } finally { Date.now = realNow; }
  // an unknown access time is refused
  const reg = o.register({ client_name: 'x', redirect_uris: ['https://claude.ai/cb'] });
  await o.authorize({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: 'f'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.ok(!o.decide(o.listPending()[0].id, true, 'read', 'ip', '99y').ok);
});

test('oauth: client metadata documents (how claude.ai identifies itself)', async () => {
  const doc = { client_id: 'https://claude.ai/oauth/claude-client', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };
  const { o } = oauthWith({ fetchDoc: async (u) => (u === doc.client_id ? doc : { client_id: 'https://other.example/x', redirect_uris: ['https://x/cb'] }) });
  const c = await o.resolveClient(doc.client_id);
  assert.ok(c && c.name === 'Claude' && c.kind === 'metadata');
  assert.strictEqual(await o.resolveClient('https://evil.example/claimed'), null, 'document must name itself');
  assert.strictEqual(await o.resolveClient('http://claude.ai/x'), null, 'https only');
  const a = await o.authorize({ response_type: 'code', client_id: doc.client_id, redirect_uri: doc.redirect_uris[0], code_challenge: 'b'.repeat(43), code_challenge_method: 'S256' }, 'ip');
  assert.strictEqual(a.status, 200);
  assert.ok(OAuth.redirectMatches('http://localhost/cb', 'http://localhost:4567/cb'), 'loopback port may change');
  assert.ok(!OAuth.redirectMatches('https://a.example/cb', 'https://a.example/cb2'));
});

test('server: exposed mode keeps the settings page private and the public port narrow', async () => {
  const port = await freePort(), pub = await freePort(), dir = tmp('exp');
  // an exposed install as it would be saved (PIN 2468, public address set)
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ controlPinHash: 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync('2468', salt, 32).toString('hex'), publicUrl: 'https://hc.example.com', security: { mode: 'exposed' }, setup: { completed: true, marks: {} } }));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1' });
  delete env.HOMECLAUDE_TEST_INSECURE_PUBLIC;
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'hc.example.com' }, extra || {});
  try {
    for (let i = 0; i < 50 && !/Public port/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    // the private port refuses anything that came through a proxy
    assert.strictEqual((await req(port, 'GET', '/', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/api/state')).status, 200, 'still fine from this network');
    const page = await fetch('http://127.0.0.1:' + port + '/');
    assert.ok(/script-src 'sha256-/.test(page.headers.get('content-security-policy')) && !/unsafe-inline'[^;]*script/.test(page.headers.get('content-security-policy')), 'strict CSP on the page');
    // the public port: nothing of the settings page, https and the right host only
    assert.strictEqual((await req(pub, 'GET', '/', undefined, H())).status, 404);
    assert.strictEqual((await req(pub, 'GET', '/api/state', undefined, H())).status, 404);
    assert.strictEqual((await req(pub, 'POST', '/api/access', { enabled: true }, H())).status, 404);
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-proto': 'http' }))).status, 403, 'https only');
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-host': 'evil.example' }))).status, 421, 'right host only');
    const prm = await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H());
    assert.strictEqual(prm.j.resource, 'https://hc.example.com/mcp');
    const r401 = await fetch('http://127.0.0.1:' + pub + '/mcp', { method: 'POST', headers: H({ 'content-type': 'application/json' }), body: '{}' });
    assert.strictEqual(r401.status, 401);
    assert.ok(/resource_metadata="https:\/\/hc\.example\.com\/\.well-known\/oauth-protected-resource"/.test(r401.headers.get('www-authenticate')));
    assert.ok(r401.headers.get('strict-transport-security'));
    // the plain access token does not work from outside unless allowed
    const tok = (await req(port, 'POST', '/api/token', {}, { 'x-pin': '2468' })).j.token;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    assert.strictEqual((await req(pub, 'POST', '/mcp', init, H({ authorization: 'Bearer ' + tok }))).status, 401);
    assert.strictEqual((await req(pub, 'POST', '/mcp/' + tok, init, H())).status, 404, 'no token-in-the-address on the public port');
    // wrong tokens get an address locked out
    for (let i = 0; i < 10; i++) await req(pub, 'POST', '/mcp', init, H({ 'x-forwarded-for': '198.51.100.7', authorization: 'Bearer hca_guess' + i }));
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-for': '198.51.100.7' }))).status, 429);
    assert.strictEqual((await req(pub, 'GET', '/.well-known/oauth-protected-resource', undefined, H({ 'x-forwarded-for': '198.51.100.8' }))).status, 200, 'others unaffected');
    // PIN guessing locks out too
    for (let i = 0; i < 5; i++) await req(port, 'POST', '/api/access', { enabled: true }, { 'x-pin': '000' + i });
    assert.strictEqual((await req(port, 'POST', '/api/access', { enabled: true }, { 'x-pin': '2468' })).status, 429, 'locked even with the right PIN');
    // events recorded, local mode switches the public port off
    const st = (await req(port, 'GET', '/api/state')).j.security;
    assert.ok(st.events.some((e) => e.type === 'address-locked') && st.events.some((e) => e.type === 'pin-lockout') && st.events.some((e) => e.type === 'admin-refused'));
  } finally { proc.kill(); }
});

const Totp = R('lib/totp'), QR = R('lib/qr');
test('authenticator codes: RFC 6238 values, clock drift, no replay; QR codes', () => {
  const key = Buffer.from('12345678901234567890');
  [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']].forEach(([t, w]) => assert.strictEqual(Totp.hotp(key, Math.floor(t / 30), 8), w));
  const sec = Totp.base32Encode(key), now = 1793000000000, c = Totp.counterAt(now);
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c), null, now), c);
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c - 1), null, now), c - 1, 'previous 30 s still accepted');
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c - 2), null, now), null, 'older is not');
  assert.strictEqual(Totp.verify(sec, Totp.hotp(key, c), c, now), null, 'a used code never works again');
  assert.strictEqual(Totp.verify(sec, 'abcdef', null, now), null);
  assert.ok(/^otpauth:\/\/totp\/HomeClaude:x\?secret=[A-Z2-7]+&issuer=HomeClaude/.test(Totp.uri(Totp.newSecret(), 'x', 'HomeClaude')));
  const q = QR.encode(Totp.uri(Totp.newSecret(), 'homeclaude.example.com', 'HomeClaude'));
  assert.ok(q.size === q.version * 4 + 17 && q.modules[0][0] && q.modules[0][6] && !q.modules[1][1], 'finder pattern in the corner');
  assert.ok(/^<svg[\s\S]*<\/svg>$/.test(QR.svg('hello')));
});

test('server: approving with an authenticator code from outside', async () => {
  const port = await freePort(), pub = await freePort(), dir = tmp('totp');
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ controlPinHash: 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync('2468', salt, 32).toString('hex'), publicUrl: 'https://hc.example.com', security: { mode: 'exposed' }, setup: { completed: true, marks: {} } }));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(pub), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1' });
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const H = (extra) => Object.assign({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20', 'x-forwarded-host': 'hc.example.com' }, extra || {});
  const PIN = { 'x-pin': '2468' };
  const codeFor = (secret, offset) => Totp.hotp(Totp.base32Decode(secret.replace(/\s/g, '')), Totp.counterAt(Date.now()) + (offset || 0));
  async function newRequest(ip) {
    const reg = (await req(pub, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, H({ 'x-forwarded-for': ip }))).j;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64sha(verifier), code_challenge_method: 'S256', state: 's' });
    const page = (await req(pub, 'GET', '/oauth/authorize?' + q, undefined, H({ 'x-forwarded-for': ip }))).text;
    const d = JSON.parse(/<script type="application\/json" id="d">(.*?)<\/script>/.exec(page)[1]);
    return { d, page, cid: reg.client_id, verifier };
  }
  try {
    for (let i = 0; i < 50 && !/Public port/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    // not set up: no code box, and the endpoint refuses
    const r0 = await newRequest('203.0.113.20');
    assert.ok(!r0.d.totp && !/id="c"/.test(r0.page));
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r0.d.id, s: r0.d.s, code: '123456', scope: 'read' }, H())).status, 403);
    // set up at home: needs the PIN, then a code from the app to switch on
    assert.strictEqual((await req(port, 'POST', '/api/totp', { action: 'setup' })).status, 401);
    const setup = (await req(port, 'POST', '/api/totp', { action: 'setup' }, PIN)).j;
    assert.ok(setup.ok && /<svg/.test(setup.svg) && /^otpauth:\/\/totp\//.test(setup.uri));
    assert.ok(!(await req(port, 'POST', '/api/totp', { action: 'confirm', code: '000000' }, PIN)).j.ok);
    assert.ok((await req(port, 'POST', '/api/totp', { action: 'confirm', code: codeFor(setup.secret) }, PIN)).j.ok);
    assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes(setup.secret.replace(/\s/g, '')), 'the secret is stored encrypted');
    // now the sign-in page has the code box; approve with a code, then sign in
    const r1 = await newRequest('203.0.113.21');
    assert.ok(r1.d.totp && /id="c"/.test(r1.page));
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r1.d.id, s: r1.d.s, code: codeFor(setup.secret, 1), scope: 'hands' }, H())).status, 400, 'above the code limit (Help build)');
    const ok = await req(pub, 'POST', '/oauth/approve', { id: r1.d.id, s: r1.d.s, code: codeFor(setup.secret, 1), scope: 'build' }, H());
    assert.ok(ok.j.ok, JSON.stringify(ok.j));
    const st = (await req(pub, 'GET', '/oauth/status?id=' + r1.d.id + '&s=' + r1.d.s, undefined, H())).j;
    assert.strictEqual(st.status, 'approved');
    const code = new URL(st.redirect).searchParams.get('code');
    const tok = await req(pub, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: r1.cid, code, code_verifier: r1.verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }, H());
    assert.ok(tok.j.access_token);
    // the same code cannot approve a second request
    const r2 = await newRequest('203.0.113.22');
    assert.strictEqual((await req(pub, 'POST', '/oauth/approve', { id: r2.d.id, s: r2.d.s, code: codeFor(setup.secret, 1), scope: 'read' }, H())).status, 401, 'replay refused');
    // five wrong codes cancel a request, and pause code approvals for the hour
    for (let i = 0; i < 4; i++) await req(pub, 'POST', '/oauth/approve', { id: r2.d.id, s: r2.d.s, code: '00000' + i, scope: 'read' }, H({ 'x-forwarded-for': '198.51.100.' + (30 + i) }));
    assert.ok((await req(pub, 'GET', '/oauth/status?id=' + r2.d.id + '&s=' + r2.d.s, undefined, H())).j.status === 'denied', 'request cancelled');
    const r3 = await newRequest('203.0.113.23');
    const paused = await req(pub, 'POST', '/oauth/approve', { id: r3.d.id, s: r3.d.s, code: codeFor(setup.secret), scope: 'read' }, H({ 'x-forwarded-for': '198.51.100.50' }));
    assert.strictEqual(paused.status, 429, 'paused for the hour, even with the right code');
    const sec = (await req(port, 'GET', '/api/state')).j.security;
    assert.ok(sec.totp.enabled && sec.totp.paused && sec.events.some((e) => e.type === 'codes-paused') && sec.events.some((e) => e.via === 'authenticator code'));
    // approving at home still works while paused
    const pend = sec.pending.find((p) => p.ip === '203.0.113.23');
    assert.ok((await req(port, 'POST', '/api/connections/decide', { id: pend.id, approve: true, scope: 'read' }, PIN)).j.ok);
  } finally { proc.kill(); }
});

test('server: keep or revert Claude\'s changes', async () => {
  const f = await fakeHa();
  const port = await freePort(), dir = tmp('rev');
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(await freePort()), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1', HOMECLAUDE_REVIEW_TICK_MS: '200' });
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const W = f.world.w;
  try {
    for (let i = 0; i < 50 && !/HomeClaude v/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    await req(port, 'POST', '/api/ha', { url: f.url, token: 'good-token' });
    await req(port, 'POST', '/api/access', { edit: true, delete: true });
    const tok = (await req(port, 'POST', '/api/token', {})).j.token, auth = { authorization: 'Bearer ' + tok };
    const call = async (name, args) => JSON.parse((await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, auth)).j.result.content[0].text);
    const reviews = async () => (await req(port, 'GET', '/api/state')).j.reviews;
    const original = JSON.parse(JSON.stringify(W.automations['1700000000001']));
    // two edits in a row: one review item, and Revert goes back to the original
    let cfg = (await call('get_automation', { id: '1700000000001' })).config;
    cfg.alias = 'Porch light v2'; let r = await call('save_automation', { id: '1700000000001', config: cfg });
    assert.ok(/keep or revert/.test(r.review), 'Claude is told about the review');
    cfg.alias = 'Porch light v3'; await call('save_automation', { id: '1700000000001', config: cfg });
    let rv = await reviews();
    assert.strictEqual(rv.filter((x) => x.status === 'waiting').length, 1);
    assert.ok(rv[0].changes === 2 && rv[0].action === 'changed' && rv[0].before.alias === original.alias && rv[0].after.alias === 'Porch light v3');
    assert.strictEqual(W.automations['1700000000001'].alias, 'Porch light v3', 'the change is live right away');
    assert.ok((await req(port, 'POST', '/api/review', { rid: rv[0].rid, keep: false })).j.ok);
    assert.strictEqual(W.automations['1700000000001'].alias, original.alias, 'reverted to the original');
    // Claude sees the revert
    const ov = await call('get_overview', {});
    assert.strictEqual(ov.homeclaude.change_reviews.recently_reverted[0].id, '1700000000001');
    // created, then reverted: it is deleted again
    const made = await call('save_automation', { config: { alias: 'New one', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' } }] } });
    rv = await reviews();
    const ci = rv.find((x) => x.status === 'waiting' && x.id === made.id);
    assert.strictEqual(ci.action, 'created');
    assert.ok((await req(port, 'POST', '/api/review', { rid: ci.rid, keep: false })).j.ok);
    assert.ok(!W.automations[made.id], 'the new automation is gone');
    // deleted, then reverted: it comes back
    await call('delete_automation', { id: '1700000000003' });
    assert.ok(!W.automations['1700000000003']);
    const di = (await reviews()).find((x) => x.status === 'waiting' && x.id === '1700000000003');
    assert.strictEqual(di.action, 'deleted');
    assert.ok((await req(port, 'POST', '/api/review', { rid: di.rid, keep: false })).j.ok);
    assert.strictEqual(W.automations['1700000000003'].alias, 'Morning coffee', 'back again');
    // keep
    cfg = (await call('get_automation', { id: '1700000000002' })).config; cfg.description = 'kept change';
    await call('save_automation', { id: '1700000000002', config: cfg });
    const ki = (await reviews()).find((x) => x.status === 'waiting');
    assert.ok((await req(port, 'POST', '/api/review', { rid: ki.rid, keep: true })).j.ok);
    assert.strictEqual(W.automations['1700000000002'].description, 'kept change');
    assert.ok(!(await req(port, 'POST', '/api/review', { rid: ki.rid, keep: false })).j.ok, 'answered once only');
    // no answer in time: decided for you
    assert.ok((await req(port, 'POST', '/api/review', { timeoutMin: 15, ifNoAnswer: 'revert' })).j.ok);
    cfg = (await call('get_automation', { id: '1700000000002' })).config; cfg.description = 'nobody answered';
    await call('save_automation', { id: '1700000000002', config: cfg });
    // pretend 15 minutes passed by pulling the deadline in
    assert.ok((await reviews()).find((x) => x.status === 'waiting').autoAt > Date.now() + 14 * 60e3, 'deadline set 15 minutes out');
    assert.ok(!(await req(port, 'POST', '/api/review', { timeoutMin: 7 })).j.ok, 'only the offered times');
    // review off: changes just apply
    assert.ok((await req(port, 'POST', '/api/review', { enabled: false })).j.ok);
    cfg.description = 'no review'; r = await call('save_automation', { id: '1700000000002', config: cfg });
    assert.ok(!r.review);
  } finally { proc.kill(); await f.close(); }
});

test('server: an unanswered change is reverted when its time runs out', async () => {
  const f = await fakeHa();
  const port = await freePort(), dir = tmp('rev2');
  // a saved install with a 15-minute limit and one waiting change whose deadline has passed
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ reviews: [{ rid: 'r1', kind: 'automation', id: '1700000000001', before: { alias: 'Before', triggers: [{ trigger: 'time', at: '06:00:00' }], actions: [] }, after: { alias: 'After' }, alias: 'After', action: 'changed', status: 'waiting', at: Date.now() - 20 * 60e3, updatedAt: Date.now() - 20 * 60e3, autoAt: Date.now() - 1000, changes: 1 }] }));
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(await freePort()), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1', HOMECLAUDE_REVIEW_TICK_MS: '200' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ review: { enabled: true, timeoutMin: 15, ifNoAnswer: 'revert' } }));
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !/HomeClaude v/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    await req(port, 'POST', '/api/ha', { url: f.url, token: 'good-token' });
    let rv;
    for (let i = 0; i < 30; i++) { rv = (await req(port, 'GET', '/api/state')).j.reviews[0]; if (rv.status !== 'waiting') break; await new Promise((r) => setTimeout(r, 200)); }
    assert.strictEqual(rv.status, 'reverted'); assert.strictEqual(rv.by, 'no answer in time');
    assert.strictEqual(f.world.w.automations['1700000000001'].alias, 'Before');
  } finally { proc.kill(); await f.close(); }
});

test('server: token, origin, access switch, PIN, live Home Assistant settings', async () => {
  const f = await fakeHa();
  const port = await freePort(), dir = tmp('srv');
  const env = Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(await freePort()), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1' });
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !/HomeClaude v/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    if (process.env.DEBUG) console.log('server up:', /HomeClaude v/.test(log));
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    assert.strictEqual((await req(port, 'POST', '/mcp', init)).status, 401);
    // the page hands out the token (no PIN set yet)
    const tok = (await req(port, 'POST', '/api/token', {})).j.token;
    assert.ok(tok && tok.length > 20);
    const auth = { authorization: 'Bearer ' + tok };
    assert.strictEqual((await req(port, 'POST', '/mcp', init, { authorization: 'Bearer wrong' })).status, 401);
    assert.strictEqual((await req(port, 'POST', '/mcp', init, auth)).j.result.serverInfo.name, 'homeclaude');
    assert.strictEqual((await req(port, 'POST', '/mcp/' + tok, init)).status, 200, 'token in the path');
    assert.strictEqual((await req(port, 'POST', '/mcp', init, Object.assign({ origin: 'http://evil.example' }, auth))).status, 403);
    assert.strictEqual((await req(port, 'GET', '/mcp', undefined, auth)).status, 405);
    assert.strictEqual((await req(port, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
    // not set up yet: tools say so
    let call = await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_overview', arguments: {} } }, auth);
    assert.ok(call.j.result.isError && /not set up/.test(call.j.result.content[0].text));
    // set up Home Assistant from the page; the token is stored encrypted
    assert.ok((await req(port, 'POST', '/api/ha', { url: f.url, token: 'good-token' })).j.ok);
    assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('good-token'), 'token not stored in plain text');
    assert.ok((await req(port, 'POST', '/api/ha-test', {})).j.ok);
    call = await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_integrations', arguments: { problems_only: true } } }, auth);
    assert.strictEqual(JSON.parse(call.j.result.content[0].text).integrations[0].domain, 'tuya');
    // switch on editing, change an automation, find the backup, restore it
    assert.ok((await req(port, 'POST', '/api/access', { edit: true })).j.ok);
    const list = await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, auth);
    assert.ok(list.j.result.tools.some((x) => x.name === 'save_automation'));
    const cfg = JSON.parse((await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_automation', arguments: { id: '1700000000001' } } }, auth)).j.result.content[0].text).config;
    cfg.alias = 'Porch light at dusk';
    const saved = await req(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'save_automation', arguments: { id: '1700000000001', config: cfg } } }, auth);
    assert.ok(!saved.j.result.isError, saved.text);
    assert.strictEqual(f.world.w.automations['1700000000001'].alias, 'Porch light at dusk');
    const bks = (await req(port, 'GET', '/api/backups')).j.backups;
    assert.strictEqual(bks.length, 1);
    assert.ok((await req(port, 'POST', '/api/restore', bks[0])).j.ok);
    assert.strictEqual(f.world.w.automations['1700000000001'].alias, 'Porch light at sunset', 'restored');
    // activity is recorded
    const st = (await req(port, 'GET', '/api/state')).j;
    assert.ok(st.activity.some((a) => a.tool === 'save_automation' && a.write && a.ok));
    assert.ok(!JSON.stringify(st).includes(tok), 'the page state never carries the token');
    // switch Claude off
    assert.ok((await req(port, 'POST', '/api/access', { enabled: false })).j.ok);
    assert.strictEqual((await req(port, 'POST', '/mcp', init, auth)).status, 503);
    // with a PIN, changes and the token need it
    assert.ok((await req(port, 'POST', '/api/settings', { newPin: '2468' })).j.ok);
    assert.strictEqual((await req(port, 'POST', '/api/access', { enabled: true })).status, 401);
    assert.strictEqual((await req(port, 'POST', '/api/token', {})).status, 401);
    assert.ok((await req(port, 'POST', '/api/access', { enabled: true }, { 'x-pin': '2468' })).j.ok);
    // a new token replaces the old one
    const tok2 = (await req(port, 'POST', '/api/token', { regenerate: true }, { 'x-pin': '2468' })).j.token;
    assert.notStrictEqual(tok2, tok);
    assert.strictEqual((await req(port, 'POST', '/mcp', init, auth)).status, 401);
    assert.strictEqual((await req(port, 'POST', '/mcp', init, { authorization: 'Bearer ' + tok2 })).status, 200);
    // the page itself
    const hs = (await req(port, 'GET', '/api/state')).j.health;
    assert.ok(hs && hs.storage.writable, 'health is reported');
    const page = await req(port, 'GET', '/');
    assert.ok(page.status === 200 && /<title>HomeClaude<\/title>/.test(page.text));
  } finally {
    proc.kill();
    await f.close();
  }
});

// ---------- run ----------
module.exports = { fakeHa };
if (require.main === module) process.on('beforeExit', () => { if (!process.exitCode) { console.log('A test stopped without finishing (nothing left to wait for)'); process.exit(1); } });
if (require.main === module) (async () => {
  let failed = 0;
  const only = process.env.ONLY;
  for (const t of tests.filter((x) => !only || x.name.startsWith(only))) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  const n = tests.filter((x) => !only || x.name.startsWith(only)).length;
  console.log('\n' + (n - failed) + ' of ' + n + ' passed');
  process.exit(failed ? 1 : 0);
})();
