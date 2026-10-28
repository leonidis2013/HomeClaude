/*
 * A small pretend Home Assistant for demo mode (node server.js --demo) and the tests.
 * handlers.rest() and handlers.ws() answer like the real APIs do; client() wraps them
 * in the same shape as lib/ha.js, and the tests also serve them over real HTTP and
 * WebSocket to test lib/ha.js itself.
 */
'use strict';
const { HaError } = require('./ha.js');

function world() {
  const now = Date.now(), ago = (min) => new Date(now - min * 60000).toISOString();
  const st = (entity_id, state, attributes, min) => ({ entity_id, state, attributes: attributes || {}, last_changed: ago(min || 30), last_updated: ago(min || 30), context: { id: 'c' + entity_id.length } });
  const states = [
    st('light.kitchen', 'on', { friendly_name: 'Kitchen Light', brightness: 200 }, 12),
    st('light.porch', 'off', { friendly_name: 'Porch Light' }, 600),
    st('switch.coffee_maker', 'off', { friendly_name: 'Coffee Maker' }, 300),
    st('sensor.outdoor_temperature', '41.2', { friendly_name: 'Outdoor Temperature', unit_of_measurement: '°F', device_class: 'temperature' }, 5),
    st('sensor.garage_freezer_temperature', 'unavailable', { friendly_name: 'Garage Freezer Temperature', unit_of_measurement: '°F' }, 95),
    st('binary_sensor.front_door', 'off', { friendly_name: 'Front Door', device_class: 'door' }, 40),
    st('lock.front_door', 'locked', { friendly_name: 'Front Door Lock' }, 40),
    st('cover.garage_door', 'closed', { friendly_name: 'Garage Door', device_class: 'garage' }, 200),
    st('sun.sun', 'below_horizon', { friendly_name: 'Sun', next_setting: ago(-900) }, 60),
    st('automation.porch_light_at_sunset', 'on', { friendly_name: 'Porch light at sunset', id: '1700000000001', last_triggered: ago(60), mode: 'single', current: 0 }, 60),
    st('automation.freezer_alert', 'on', { friendly_name: 'Freezer alert', id: '1700000000002', last_triggered: ago(95), mode: 'single', current: 0 }, 95),
    st('automation.morning_coffee', 'off', { friendly_name: 'Morning coffee', id: '1700000000003', last_triggered: null, mode: 'single', current: 0 }, 3000),
    st('automation.yaml_only_example', 'on', { friendly_name: 'YAML only example', last_triggered: null, mode: 'single', current: 0 }, 3000),
    st('script.movie_mode', 'off', { friendly_name: 'Movie mode', last_triggered: ago(1440), mode: 'single' }, 1440)
  ];
  const automations = {
    1700000000001: { id: '1700000000001', alias: 'Porch light at sunset', description: '', mode: 'single', triggers: [{ trigger: 'sun', event: 'sunset', offset: '-00:15:00' }], conditions: [], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.porch' } }] },
    1700000000002: { id: '1700000000002', alias: 'Freezer alert', description: 'Tell me when the freezer warms up', mode: 'single',
      triggers: [{ trigger: 'numeric_state', entity_id: 'sensor.garage_freezer_temperature', above: 10, for: '00:10:00' }], conditions: [],
      actions: [{ action: 'notify.mobile_app_phone', data: { message: 'Freezer is at {{ states(\'sensor.garage_freezer_temperature\') | float }}°F' } }] },
    1700000000003: { id: '1700000000003', alias: 'Morning coffee', description: '', mode: 'single', triggers: [{ trigger: 'time', at: '06:15:00' }], conditions: [{ condition: 'time', weekday: ['mon', 'tue', 'wed', 'thu', 'fri'] }], actions: [{ action: 'switch.turn_on', target: { entity_id: 'switch.coffee_maker' } }] }
  };
  const scripts = { movie_mode: { alias: 'Movie mode', mode: 'single', sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.kitchen' } }] } };
  const traces = {
    'automation/1700000000001': [{ run_id: 'r1', state: 'stopped', script_execution: 'finished', trigger: 'sunset with offset -00:15:00', last_step: 'action/0', timestamp: { start: ago(60), finish: ago(60) },
      trace: { 'trigger/0': [{ path: 'trigger/0', timestamp: ago(60) }], 'action/0': [{ path: 'action/0', timestamp: ago(60), result: { params: { domain: 'light', service: 'turn_on' } } }] } }],
    'automation/1700000000002': [{ run_id: 'r2', state: 'stopped', script_execution: 'error', trigger: 'numeric state of sensor.garage_freezer_temperature', last_step: 'action/0', error: 'Error rendering data template: ValueError: Template error: float got invalid input \'unavailable\' when rendering template', timestamp: { start: ago(95), finish: ago(95) },
      trace: { 'trigger/0': [{ path: 'trigger/0', timestamp: ago(95) }], 'action/0': [{ path: 'action/0', timestamp: ago(95), error: 'Error rendering data template: ValueError: Template error: float got invalid input \'unavailable\' when rendering template' }] } }]
  };
  const logs = [
    { name: 'homeassistant.components.tuya', message: ['Error setting up entry Garage freezer for tuya: Connection timed out'], level: 'ERROR', source: ['components/tuya/__init__.py', 88], timestamp: (now - 95 * 60000) / 1000, first_occurred: (now - 2 * 86400000) / 1000, count: 14, exception: '' },
    { name: 'homeassistant.helpers.template', message: ['Template variable warning: \'dict object\' has no attribute \'battery\' when rendering \'{{ value_json.battery }}\''], level: 'WARNING', source: ['helpers/template.py', 2731], timestamp: (now - 30 * 60000) / 1000, first_occurred: (now - 30 * 60000) / 1000, count: 3, exception: '' },
    { name: 'homeassistant.components.automation.freezer_alert', message: ['Freezer alert: Error executing script. Error rendering template for call_service at pos 1: ValueError: float got invalid input \'unavailable\''], level: 'ERROR', source: ['helpers/script.py', 520], timestamp: (now - 95 * 60000) / 1000, first_occurred: (now - 95 * 60000) / 1000, count: 1, exception: 'Traceback (most recent call last):\n  ...\nValueError: Template error: float got invalid input \'unavailable\'' }
  ];
  const entries = [
    { entry_id: 'e1', domain: 'hue', title: 'Hue Bridge', source: 'zeroconf', state: 'loaded', disabled_by: null, reason: null },
    { entry_id: 'e2', domain: 'met', title: 'Home', source: 'onboarding', state: 'loaded', disabled_by: null, reason: null },
    { entry_id: 'e3', domain: 'tuya', title: 'Garage freezer', source: 'user', state: 'setup_retry', disabled_by: null, reason: 'Connection timed out' },
    { entry_id: 'e4', domain: 'mobile_app', title: 'Phone', source: 'registration', state: 'loaded', disabled_by: null, reason: null }
  ];
  const areas = [{ area_id: 'kitchen', name: 'Kitchen' }, { area_id: 'garage', name: 'Garage' }, { area_id: 'front_porch', name: 'Front Porch' }];
  const devices = [
    { id: 'd1', name: 'Hue Bridge', manufacturer: 'Signify', model: 'BSB002', sw_version: '1.66', area_id: null, disabled_by: null },
    { id: 'd2', name: 'Kitchen Light', manufacturer: 'Signify', model: 'LCA001', sw_version: '1.104', area_id: 'kitchen', disabled_by: null, via_device_id: 'd1' },
    { id: 'd3', name: 'Garage Freezer Sensor', manufacturer: 'Tuya', model: 'TH01', area_id: 'garage', disabled_by: null },
    { id: 'd4', name: 'Front Door Lock', manufacturer: 'Yale', model: 'Assure 2', area_id: 'front_porch', disabled_by: null }
  ];
  const reg = [
    { entity_id: 'light.kitchen', device_id: 'd2', area_id: null, platform: 'hue', config_entry_id: 'e1' },
    { entity_id: 'light.porch', device_id: null, area_id: 'front_porch', platform: 'hue', config_entry_id: 'e1' },
    { entity_id: 'sensor.garage_freezer_temperature', device_id: 'd3', area_id: null, platform: 'tuya', config_entry_id: 'e3' },
    { entity_id: 'lock.front_door', device_id: 'd4', area_id: null, platform: 'zwave_js' },
    { entity_id: 'cover.garage_door', device_id: null, area_id: 'garage', platform: 'myq' },
    { entity_id: 'automation.porch_light_at_sunset', platform: 'automation', labels: ['outdoor'], categories: { automation: 'c_lights' } },
    { entity_id: 'automation.freezer_alert', platform: 'automation', labels: [], categories: {} },
    { entity_id: 'automation.morning_coffee', platform: 'automation', labels: [], categories: {} },
    { entity_id: 'script.movie_mode', platform: 'script', labels: [], categories: {} }
  ];
  reg.forEach((e) => { e.labels = e.labels || []; e.categories = e.categories || {}; });
  devices.forEach((d) => { d.labels = d.labels || []; });
  areas.forEach((a) => { a.labels = a.labels || []; });
  const labels = [{ label_id: 'outdoor', name: 'Outdoor', color: 'green', icon: 'mdi:tree', description: null }];
  const categories = { automation: [{ category_id: 'c_lights', name: 'Lights', icon: 'mdi:lightbulb' }], script: [], scene: [], helpers: [] };
  const services = [
    { domain: 'light', services: { turn_on: { name: 'Turn on', description: 'Turns on one or more lights', target: {}, fields: { brightness_pct: { description: 'Brightness 0-100', example: 50, selector: { number: {} } } } }, turn_off: { name: 'Turn off', target: {}, fields: {} }, toggle: { name: 'Toggle', target: {}, fields: {} } } },
    { domain: 'switch', services: { turn_on: { name: 'Turn on', target: {}, fields: {} }, turn_off: { name: 'Turn off', target: {}, fields: {} } } },
    { domain: 'lock', services: { lock: { name: 'Lock', target: {}, fields: {} }, unlock: { name: 'Unlock', target: {}, fields: {} } } },
    { domain: 'cover', services: { open_cover: { name: 'Open', target: {}, fields: {} }, close_cover: { name: 'Close', target: {}, fields: {} } } },
    { domain: 'automation', services: { reload: { name: 'Reload', fields: {} }, trigger: { name: 'Trigger', target: {}, fields: {} } } },
    { domain: 'script', services: { reload: { name: 'Reload', fields: {} }, turn_on: { name: 'Turn on', target: {}, fields: {} } } },
    { domain: 'homeassistant', services: { restart: { name: 'Restart', fields: {} }, reload_all: { name: 'Reload all', fields: {} }, reload_core_config: { name: 'Reload core config', fields: {} }, turn_on: { name: 'Turn on', target: {}, fields: {} }, turn_off: { name: 'Turn off', target: {}, fields: {} } } },
    { domain: 'notify', services: { mobile_app_phone: { name: 'Phone', fields: { message: { required: true, selector: { text: {} } } } } } }
  ];
  const dashboards = [{ id: 'dashboard_home', url_path: 'dashboard-home', title: 'Home', icon: 'mdi:home', mode: 'storage', show_in_sidebar: true, require_admin: false }];
  const lovelace = {
    lovelace: null, // Overview: auto-generated until someone takes control
    'dashboard-home': { views: [
      { title: 'Main', path: 'main', cards: [{ type: 'tile', entity: 'light.kitchen' }, { type: 'entities', title: 'Outside', entities: ['sensor.outdoor_temperature', 'binary_sensor.front_door'] }] },
      { title: 'Garage', path: 'garage', type: 'sections', sections: [{ type: 'grid', cards: [{ type: 'tile', entity: 'cover.garage_door' }, { type: 'tile', entity: 'sensor.garage_freezer_temperature' }] }] }
    ] }
  };
  return { states, automations, scripts, traces, logs, entries, areas, devices, reg, services, labels, categories, dashboards, lovelace, configValid: true, calls: [], restarts: 0 };
}

function createWorld() {
  const w = world();
  const stateOf = (id) => w.states.find((s) => s.entity_id === id);
  const slug = (s) => String(s || 'automation').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'automation';

  function syncAutomationState(id) {
    const c = w.automations[id];
    const old = w.states.find((s) => s.entity_id.startsWith('automation.') && String(s.attributes.id) === id);
    if (!c) { if (old) w.states.splice(w.states.indexOf(old), 1); return; }
    if (old) { old.attributes.friendly_name = c.alias; return; }
    w.states.push({ entity_id: 'automation.' + slug(c.alias), state: 'on', attributes: { friendly_name: c.alias, id, mode: c.mode || 'single', last_triggered: null, current: 0 }, last_changed: new Date().toISOString(), last_updated: new Date().toISOString() });
  }

  function render(tpl) {
    return String(tpl).replace(/\{\{\s*states\(\s*['"]([a-z0-9_.]+)['"]\s*\)\s*\}\}/g, (m, id) => (stateOf(id) || { state: 'unknown' }).state)
      .replace(/\{\{\s*(\d+)\s*\+\s*(\d+)\s*\}\}/g, (m, a, b) => String(Number(a) + Number(b)));
  }

  /** -> { status, body } like the REST API */
  function rest(method, fullPath, body) {
    const [p, qs] = fullPath.split('?');
    const q = new URLSearchParams(qs || '');
    const J = (b, status) => ({ status: status || 200, body: b });
    let m;
    if (method === 'GET' && p === '/api/') return J({ message: 'API running.' });
    if (method === 'GET' && p === '/api/config') return J({ version: '2026.10.2', location_name: 'Home', time_zone: 'America/Chicago', state: 'RUNNING', config_dir: '/config', safe_mode: false, recovery_mode: false, unit_system: { temperature: '°F' }, components: ['hue', 'met', 'automation', 'script', 'tuya', 'mobile_app'] });
    if (method === 'GET' && p === '/api/states') return J(w.states);
    if (method === 'GET' && (m = /^\/api\/states\/(.+)$/.exec(p))) { const s = stateOf(decodeURIComponent(m[1])); return s ? J(s) : J({ message: 'Entity not found.' }, 404); }
    if (method === 'GET' && p === '/api/services') return J(w.services);
    if (method === 'GET' && p === '/api/error_log') return J('2026-10-26 12:00:00.000 ERROR (MainThread) [homeassistant.components.tuya] Error setting up entry Garage freezer for tuya: Connection timed out\n2026-10-26 13:00:00.000 WARNING (MainThread) [homeassistant.helpers.template] Template variable warning\n');
    if (method === 'GET' && (m = /^\/api\/history\/period\/(.+)$/.exec(p))) {
      const ids = String(q.get('filter_entity_id') || '').split(',').filter(Boolean);
      return J(ids.filter(stateOf).map((id) => [0, 1, 2].map((i) => ({ entity_id: id, state: i === 2 ? stateOf(id).state : String(38 + i), last_changed: new Date(Date.now() - (3 - i) * 3600e3).toISOString() }))));
    }
    if (method === 'GET' && (m = /^\/api\/logbook\/(.+)$/.exec(p))) {
      const e = q.get('entity');
      const list = [{ when: new Date(Date.now() - 3600e3).toISOString(), name: 'Porch Light', entity_id: 'light.porch', state: 'on', message: 'turned on', context_event_type: 'automation_triggered', context_name: 'Porch light at sunset' }];
      return J(list.filter((x) => !e || x.entity_id === e));
    }
    if (method === 'POST' && p === '/api/template') return J(render(body && body.template));
    if (method === 'POST' && p === '/api/config/core/check_config') return J(w.configValid ? { result: 'valid', errors: null, warnings: null } : { result: 'invalid', errors: 'Invalid config for \'template\' at configuration.yaml, line 12', warnings: null });
    if ((m = /^\/api\/config\/(automation|script)\/config\/([^/]+)$/.exec(p))) {
      const kind = m[1], id = decodeURIComponent(m[2]), store = kind === 'automation' ? w.automations : w.scripts;
      if (method === 'GET') return store[id] ? J(store[id]) : J({ message: 'Resource not found' }, 404);
      if (method === 'POST') {
        if (!body || typeof body !== 'object') return J({ message: 'Message format incorrect' }, 400);
        if (kind === 'automation' && !(body.triggers || body.trigger)) return J({ message: 'Message malformed: required key not provided @ data[\'triggers\']' }, 400);
        store[id] = Object.assign({}, body, kind === 'automation' ? { id } : {});
        if (kind === 'automation') syncAutomationState(id);
        else if (!stateOf('script.' + id)) w.states.push({ entity_id: 'script.' + id, state: 'off', attributes: { friendly_name: body.alias || id, mode: body.mode || 'single' } });
        return J({ result: 'ok' });
      }
      if (method === 'DELETE') {
        if (!store[id]) return J({ message: 'Resource not found' }, 404);
        delete store[id];
        if (kind === 'automation') syncAutomationState(id);
        else { const s = stateOf('script.' + id); if (s) w.states.splice(w.states.indexOf(s), 1); }
        return J({ result: 'ok' });
      }
    }
    if (method === 'POST' && (m = /^\/api\/services\/([a-z0-9_]+)\/([a-z0-9_]+)$/.exec(p))) {
      w.calls.push({ domain: m[1], service: m[2], body });
      if (m[1] === 'homeassistant' && m[2] === 'restart') { w.restarts++; return J([]); }
      const ids = [].concat((body || {}).entity_id || []);
      const changed = [];
      ids.forEach((id) => {
        const s = stateOf(id);
        if (!s) return;
        if (m[2] === 'turn_on') s.state = 'on'; else if (m[2] === 'turn_off') s.state = 'off'; else if (m[2] === 'toggle') s.state = s.state === 'on' ? 'off' : 'on';
        s.last_changed = new Date().toISOString(); changed.push(s);
      });
      return J(changed);
    }
    return J({ message: 'Not found' }, 404);
  }

  /** -> { success, result } or { success: false, error } like the WebSocket API */
  function ws(msg) {
    const OK = (result) => ({ success: true, result });
    switch (msg.type) {
      case 'config/entity_registry/list': return OK(w.reg);
      case 'config/device_registry/list': return OK(w.devices);
      case 'config/area_registry/list': return OK(w.areas);
      case 'config_entries/get': return OK(w.entries);
      case 'repairs/list_issues': return OK({ issues: [{ domain: 'homeassistant', issue_domain: 'tuya', issue_id: 'deprecated_yaml_tuya', severity: 'warning', translation_key: 'deprecated_yaml', is_fixable: false, breaks_in_ha_version: '2027.1.0', created: new Date().toISOString(), ignored: false, dismissed_version: null }] });
      case 'system_log/list': return OK(w.logs);
      case 'config/label_registry/list': return OK(w.labels);
      case 'config/label_registry/create': {
        const id = String(msg.name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (w.labels.some((l) => l.label_id === id)) return { success: false, error: { code: 'invalid_info', message: 'Label name already in use' } };
        const l = { label_id: id, name: msg.name, color: msg.color || null, icon: msg.icon || null, description: msg.description || null };
        w.labels.push(l); return OK(l);
      }
      case 'config/label_registry/update': {
        const l = w.labels.find((x) => x.label_id === msg.label_id);
        if (!l) return { success: false, error: { code: 'not_found', message: 'Label ID doesn\'t exist' } };
        ['name', 'color', 'icon', 'description'].forEach((k) => { if (k in msg) l[k] = msg[k]; }); return OK(l);
      }
      case 'config/label_registry/delete': {
        const i = w.labels.findIndex((x) => x.label_id === msg.label_id);
        if (i < 0) return { success: false, error: { code: 'not_found', message: 'Label ID doesn\'t exist' } };
        w.labels.splice(i, 1); [w.reg, w.devices, w.areas].forEach((list) => list.forEach((x) => { x.labels = (x.labels || []).filter((y) => y !== msg.label_id); })); return OK(null);
      }
      case 'config/category_registry/list': return OK(w.categories[msg.scope] || []);
      case 'config/category_registry/create': {
        const c = { category_id: 'c_' + String(msg.name).toLowerCase().replace(/[^a-z0-9]+/g, '_'), name: msg.name, icon: msg.icon || null };
        (w.categories[msg.scope] = w.categories[msg.scope] || []).push(c); return OK(c);
      }
      case 'config/category_registry/update': {
        const c = (w.categories[msg.scope] || []).find((x) => x.category_id === msg.category_id);
        if (!c) return { success: false, error: { code: 'not_found', message: 'Category ID doesn\'t exist' } };
        ['name', 'icon'].forEach((k) => { if (k in msg) c[k] = msg[k]; }); return OK(c);
      }
      case 'config/category_registry/delete': {
        const list = w.categories[msg.scope] || [], i = list.findIndex((x) => x.category_id === msg.category_id);
        if (i < 0) return { success: false, error: { code: 'not_found', message: 'Category ID doesn\'t exist' } };
        list.splice(i, 1); w.reg.forEach((e) => { if (e.categories[msg.scope] === msg.category_id) delete e.categories[msg.scope]; }); return OK(null);
      }
      case 'config/entity_registry/update': {
        const e = w.reg.find((x) => x.entity_id === msg.entity_id);
        if (!e) return { success: false, error: { code: 'not_found', message: 'Entity not found' } };
        if (msg.labels) e.labels = [...new Set(msg.labels)];
        if (msg.categories) Object.entries(msg.categories).forEach(([sc, id]) => { if (id == null) delete e.categories[sc]; else e.categories[sc] = id; });
        return OK({ entity_entry: e });
      }
      case 'config/device_registry/update': {
        const d = w.devices.find((x) => x.id === msg.device_id);
        if (!d) return { success: false, error: { code: 'not_found', message: 'Device not found' } };
        if (msg.labels) d.labels = [...new Set(msg.labels)]; return OK(d);
      }
      case 'config/area_registry/update': {
        const a = w.areas.find((x) => x.area_id === msg.area_id);
        if (!a) return { success: false, error: { code: 'not_found', message: 'Area not found' } };
        if (msg.labels) a.labels = [...new Set(msg.labels)]; return OK(a);
      }
      case 'lovelace/info': return OK({ mode: 'storage', resource_mode: 'storage' });
      case 'lovelace/dashboards/list': return OK(w.dashboards);
      case 'lovelace/dashboards/create': {
        if (!/^[a-z0-9_-]+$/.test(msg.url_path || '') || !String(msg.url_path).includes('-')) return { success: false, error: { code: 'invalid_format', message: 'Url path needs to contain a hyphen (-)' } };
        if (w.dashboards.some((d) => d.url_path === msg.url_path)) return { success: false, error: { code: 'home_assistant_error', message: 'Url path is already in use' } };
        const d = { id: msg.url_path.replace(/-/g, '_'), url_path: msg.url_path, title: msg.title, icon: msg.icon || null, mode: 'storage', show_in_sidebar: msg.show_in_sidebar !== false, require_admin: !!msg.require_admin };
        w.dashboards.push(d); w.lovelace[d.url_path] = null; return OK(d);
      }
      case 'lovelace/dashboards/update': {
        const d = w.dashboards.find((x) => x.id === msg.dashboard_id);
        if (!d) return { success: false, error: { code: 'not_found', message: 'Unable to find dashboard_id ' + msg.dashboard_id } };
        ['title', 'icon', 'show_in_sidebar', 'require_admin'].forEach((k) => { if (k in msg) d[k] = msg[k]; }); return OK(d);
      }
      case 'lovelace/dashboards/delete': {
        const i = w.dashboards.findIndex((x) => x.id === msg.dashboard_id);
        if (i < 0) return { success: false, error: { code: 'not_found', message: 'Unable to find dashboard_id ' + msg.dashboard_id } };
        delete w.lovelace[w.dashboards[i].url_path]; w.dashboards.splice(i, 1); return OK(null);
      }
      case 'lovelace/config': {
        const key = msg.url_path || 'lovelace';
        if (!(key in w.lovelace)) return { success: false, error: { code: 'home_assistant_error', message: 'Unknown config specified: ' + key } };
        return w.lovelace[key] ? OK(w.lovelace[key]) : { success: false, error: { code: 'config_not_found', message: 'No config found.' } };
      }
      case 'lovelace/config/save': {
        const key = msg.url_path || 'lovelace';
        if (!(key in w.lovelace)) return { success: false, error: { code: 'home_assistant_error', message: 'Unknown config specified: ' + key } };
        w.lovelace[key] = msg.config; return OK(null);
      }
      case 'lovelace/config/delete': {
        const key = msg.url_path || 'lovelace';
        if (!(key in w.lovelace)) return { success: false, error: { code: 'home_assistant_error', message: 'Unknown config specified: ' + key } };
        w.lovelace[key] = null; return OK(null);
      }
      case 'search/related': return OK(msg.item_id === 'sensor.garage_freezer_temperature' ? { automation: ['automation.freezer_alert'], device: ['d3'], config_entry: ['e3'] } : {});
      case 'trace/list': return OK((w.traces[msg.domain + '/' + msg.item_id] || []).map((t) => { const c = Object.assign({}, t); delete c.trace; return c; }));
      case 'trace/get': {
        const t = (w.traces[msg.domain + '/' + msg.item_id] || []).find((x) => x.run_id === msg.run_id);
        return t ? OK(Object.assign({ config: w.automations[msg.item_id] || null }, t)) : { success: false, error: { code: 'not_found', message: 'The trace could not be found' } };
      }
      default: return { success: false, error: { code: 'unknown_command', message: 'Unknown command.' } };
    }
  }

  return { w, rest, ws };
}

/** Same shape as lib/ha.js, without the network. */
function client(world) {
  world = world || createWorld();
  const delay = () => new Promise((r) => setTimeout(r, 15));
  return {
    world,
    configured: () => true,
    base: () => 'http://demo.local:8123',
    version: () => '2026.10.2',
    reset() {},
    async rest(method, path, body, o = {}) {
      await delay();
      const r = world.rest(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
      if (r.status >= 400) throw new HaError('Home Assistant answered ' + r.status + ': ' + (r.body.message || ''), r.status);
      return o.text ? String(r.body) : JSON.parse(JSON.stringify(r.body));
    },
    async command(msg) {
      await delay();
      const r = world.ws(msg);
      if (!r.success) throw new HaError('Home Assistant: ' + r.error.message + ' (' + msg.type + ')', r.error.code === 'not_found' ? 404 : 0, r.error.code);
      return JSON.parse(JSON.stringify(r.result));
    }
  };
}

module.exports = { createWorld, client };
