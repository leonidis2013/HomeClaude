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
  assert.ok(r.isError && /switched off/.test(r.text));
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

test('server: token, origin, access switch, PIN, live Home Assistant settings', async () => {
  const f = await fakeHa();
  const port = await freePort(), dir = tmp('srv');
  const env = Object.assign({}, process.env, { PORT: String(port), CONFIG: path.join(dir, 'config.json'), HOMECLAUDE_NO_UPDATE_CHECK: '1' });
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
    const page = await req(port, 'GET', '/');
    assert.ok(page.status === 200 && /<title>HomeClaude<\/title>/.test(page.text));
  } finally {
    proc.kill();
    await f.close();
  }
});

// ---------- run ----------
process.on('beforeExit', () => { if (!process.exitCode) { console.log('A test stopped without finishing (nothing left to wait for)'); process.exit(1); } });
(async () => {
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
