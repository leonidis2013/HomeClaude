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
    st('script.movie_mode', 'off', { friendly_name: 'Movie mode', last_triggered: ago(1440), mode: 'single' }, 1440),
    st('sensor.hallway_motion_battery_level', '100', { friendly_name: 'Hallway Motion Battery level', unit_of_measurement: '%', device_class: 'battery' }, 600),
    st('binary_sensor.hallway_motion_motion_detection', 'off', { friendly_name: 'Hallway Motion Motion detection', device_class: 'motion' }, 3)
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
    { entry_id: 'e4', domain: 'mobile_app', title: 'Phone', source: 'registration', state: 'loaded', disabled_by: null, reason: null },
    { entry_id: 'e5', domain: 'zwave_js', title: 'Z-Wave JS', source: 'user', state: 'loaded', disabled_by: null, reason: null }
  ];
  const areas = [{ area_id: 'kitchen', name: 'Kitchen' }, { area_id: 'garage', name: 'Garage' }, { area_id: 'front_porch', name: 'Front Porch' }];
  const devices = [
    { id: 'd1', name: 'Hue Bridge', manufacturer: 'Signify', model: 'BSB002', sw_version: '1.66', area_id: null, disabled_by: null },
    { id: 'd2', name: 'Kitchen Light', manufacturer: 'Signify', model: 'LCA001', sw_version: '1.104', area_id: 'kitchen', disabled_by: null, via_device_id: 'd1' },
    { id: 'd3', name: 'Garage Freezer Sensor', manufacturer: 'Tuya', model: 'TH01', area_id: 'garage', disabled_by: null },
    { id: 'd4', name: 'Front Door Lock', manufacturer: 'Yale', model: 'Assure 2', area_id: 'front_porch', disabled_by: null, identifiers: [['zwave_js', '3487522698-57']], config_entries: ['e5'] },
    { id: 'd5', name: 'TriSensor 8', name_by_user: 'Hallway Motion', manufacturer: 'Aeotec Ltd.', model: 'ZWA045', sw_version: '2.8.4', area_id: null, disabled_by: null, identifiers: [['zwave_js', '3487522698-13']], config_entries: ['e5'] }
  ];
  const reg = [
    { entity_id: 'light.kitchen', device_id: 'd2', area_id: null, platform: 'hue', config_entry_id: 'e1' },
    { entity_id: 'light.porch', device_id: null, area_id: 'front_porch', platform: 'hue', config_entry_id: 'e1' },
    { entity_id: 'sensor.garage_freezer_temperature', device_id: 'd3', area_id: null, platform: 'tuya', config_entry_id: 'e3' },
    { entity_id: 'lock.front_door', device_id: 'd4', area_id: null, platform: 'zwave_js' },
    { entity_id: 'cover.garage_door', device_id: null, area_id: 'garage', platform: 'myq' },
    { entity_id: 'sensor.hallway_motion_battery_level', device_id: 'd5', area_id: null, platform: 'zwave_js', config_entry_id: 'e5' },
    { entity_id: 'binary_sensor.hallway_motion_motion_detection', device_id: 'd5', area_id: null, platform: 'zwave_js', config_entry_id: 'e5' },
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
  // Z-Wave JS nodes: a battery sensor that sleeps on a wake-up interval, and a FLiRS lock
  const cp = (node, property, label, value, meta, propertyKey) => [node + '-112-0-' + property + (propertyKey != null ? '-' + propertyKey : ''),
    { property, property_key: propertyKey == null ? null : propertyKey, endpoint: 0, configuration_value_type: 'manual_entry', metadata: Object.assign({ description: null, label, type: 'number', min: 0, max: 255, unit: null, writeable: true, readable: true, default: 0 }, meta), value }];
  const zwave = {
    d5: { nodeId: 13, status: 1, isListening: false, isFrequentListening: false,
      wake: { value: 3600, min: 600, max: 86400, steps: 600, default: 43200 },
      stats: { commandsTX: 412, commandsRX: 1980, commandsDroppedTX: 0, commandsDroppedRX: 3, timeoutResponse: 1, rtt: 38.2, rssi: -72 },
      params: Object.fromEntries([
        cp(13, 3, 'Motion Untrigger Time', 60, { min: 30, max: 3600, unit: 'seconds', default: 30, description: 'Time after the last motion before motion is cleared' }),
        cp(13, 13, 'Motion Sensitivity', 11, { min: 0, max: 11, default: 11 }),
        cp(13, 2, 'Report on: temperature', 1, { max: 1, default: 1 }, 255),
        cp(13, 2, 'Report on: illuminance', 1, { max: 1, default: 1 }, 65280),
        cp(13, 40, 'Periodic Reports Interval', 3600, { min: 60, max: 86400, unit: 'seconds', default: 3600 }),
        cp(13, 99, 'Firmware Build', 5, { writeable: false }),
        cp(13, 101, 'LED Indicator', 1, { max: 1, default: 1, states: { 0: 'Disable', 1: 'Enable' } })
      ]) },
    d4: { nodeId: 57, status: 4, isListening: false, isFrequentListening: '1000ms', stats: { commandsTX: 90, commandsRX: 160 },
      params: Object.fromEntries([cp(57, 3, 'Beeper', 255, { states: { 0: 'Disable', 255: 'Enable' }, default: 255 })]) }
  };
  return { states, automations, scripts, traces, logs, entries, areas, devices, reg, services, labels, categories, dashboards, lovelace, zwave, configValid: true, calls: [], restarts: 0 };
}

function createWorld() {
  const w = world();
  // the ESPHome Device Builder app behind Home Assistant's ingress
  Object.assign(w, { ingressToken: 'ingtok', sessions: new Set(), sessionCount: 0, builder: deviceBuilder() });
  const stateOf = (id) => w.states.find((s) => s.entity_id === id);
  const slug = (s) => String(s || 'automation').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'automation';

  // helpers: the UI kind kept in .storage, and one template sensor (a config entry)
  const nowIso = () => new Date().toISOString();
  w.helpers = { input_datetime: [{ id: 'furnace_filter_changed', name: 'Furnace filter changed', has_date: true, has_time: false, icon: 'mdi:air-filter' }], input_number: [], input_boolean: [], input_text: [], input_select: [], input_button: [], counter: [], timer: [], schedule: [] };
  const helperState = (d, it) => (d === 'input_datetime' ? (it.initial || '2026-09-01') : d === 'input_number' ? String(it.initial != null ? it.initial : it.min) : d === 'input_boolean' ? 'off' : d === 'counter' ? String(it.initial || 0) : d === 'timer' ? 'idle' : 'unknown');
  function addHelperEntity(d, it) {
    const eid = d + '.' + it.id;
    w.states.push({ entity_id: eid, state: helperState(d, it), attributes: Object.assign({ friendly_name: it.name, editable: true }, it.icon ? { icon: it.icon } : {}), last_changed: nowIso(), last_updated: nowIso() });
    w.reg.push({ entity_id: eid, device_id: null, area_id: null, platform: d, unique_id: it.id, config_entry_id: null, labels: [], categories: {} });
  }
  function dropEntity(eid) {
    const s = stateOf(eid); if (s) w.states.splice(w.states.indexOf(s), 1);
    const e = w.reg.find((x) => x.entity_id === eid); if (e) w.reg.splice(w.reg.indexOf(e), 1);
  }
  w.helpers.input_datetime.forEach((it) => addHelperEntity('input_datetime', it));
  w.flows = new Map(); w.flowCount = 0;
  w.entries.push({ entry_id: 'e6', domain: 'template', title: 'Furnace filter days left', source: 'user', state: 'loaded', disabled_by: null, reason: null, options: { template_type: 'sensor', state: '{{ 34 }}', unit_of_measurement: 'd' } });
  w.states.push({ entity_id: 'sensor.furnace_filter_days_left', state: '34', attributes: { friendly_name: 'Furnace filter days left', unit_of_measurement: 'd' }, last_changed: nowIso(), last_updated: nowIso() });
  w.reg.push({ entity_id: 'sensor.furnace_filter_days_left', device_id: null, area_id: null, platform: 'template', unique_id: 'e6', config_entry_id: 'e6', labels: [], categories: {} });
  // the template config flow's form, as Home Assistant serializes it (sensor or binary_sensor)
  function templateForm(type, withName, values) {
    values = values || {};
    const f = (name, required, extra) => Object.assign({ name, required: !!required, selector: {} }, values[name] !== undefined ? { description: { suggested_value: values[name] } } : {}, extra || {});
    const schema = (withName ? [f('name', true)] : []).concat([f('state', true), f('device_class', false)]);
    if (type === 'sensor') schema.push(f('state_class', false), f('unit_of_measurement', false));
    schema.push(f('device_id', false));
    const adv = values.advanced_options || {};
    schema.push({ name: 'advanced_options', type: 'expandable', required: false, expanded: false, schema: [Object.assign({ name: 'availability', required: false, selector: {} }, adv.availability !== undefined ? { description: { suggested_value: adv.availability } } : {})] });
    return schema;
  }
  function checkTemplateInput(type, data, withName) {
    if (withName && !data.name) return "required key not provided @ data['name']";
    if (!data.state) return "required key not provided @ data['state']";
    const known = templateForm(type, withName).map((x) => x.name);
    const extra = Object.keys(data).find((k) => !known.includes(k));
    if (extra) return 'extra keys not allowed @ data[\'' + extra + '\']';
    return null;
  }

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
    if (method === 'GET' && (m = /^\/api\/diagnostics\/config_entry\/([^/]+)\/device\/([^/]+)$/.exec(p))) {
      const z = w.zwave[decodeURIComponent(m[2])];
      if (!z || m[1] !== 'e5') return J({ message: 'Not found' }, 404);
      const values = {};
      if (z.wake) values[z.nodeId + '-132-0-wakeUpInterval'] = { endpoint: 0, commandClass: 132, commandClassName: 'Wake Up', property: 'wakeUpInterval', propertyName: 'wakeUpInterval', ccVersion: 2,
        metadata: { type: 'number', readable: false, writeable: true, label: 'Wake Up interval', min: z.wake.min, max: z.wake.max, steps: z.wake.steps, default: z.wake.default }, value: z.wake.value };
      return J({ home_assistant: { version: '2026.10.2' }, data: { versionInfo: { driverVersion: '15.0.0' }, entities: [], state: { nodeId: z.nodeId, status: z.status, isListening: z.isListening, isFrequentListening: z.isFrequentListening, statistics: z.stats, values } } });
    }
    // config flows (template helpers)
    if (method === 'POST' && p === '/api/config/config_entries/flow') {
      if (!body || body.handler !== 'template') return J({ message: 'Invalid handler specified' }, 404);
      const id = 'f' + (++w.flowCount); w.flows.set(id, { kind: 'config' });
      return J({ type: 'menu', flow_id: id, handler: 'template', step_id: 'user', menu_options: ['binary_sensor', 'button', 'image', 'number', 'select', 'sensor', 'switch'] });
    }
    if (method === 'POST' && p === '/api/config/config_entries/options/flow') {
      const en = w.entries.find((x) => x.entry_id === (body || {}).handler);
      if (!en || en.domain !== 'template') return J({ message: 'Invalid handler specified' }, 404);
      const id = 'o' + (++w.flowCount); w.flows.set(id, { kind: 'options', entry: en, step: en.options.template_type });
      return J({ type: 'form', flow_id: id, handler: en.entry_id, step_id: en.options.template_type, data_schema: templateForm(en.options.template_type, false, en.options), errors: null });
    }
    if ((m = /^\/api\/config\/config_entries\/(options\/)?flow\/([^/]+)$/.exec(p))) {
      const fl = w.flows.get(m[2]);
      if (!fl) return J({ message: 'Invalid flow specified' }, 404);
      if (method === 'DELETE') { w.flows.delete(m[2]); return J({ message: 'Flow aborted' }); }
      if (method !== 'POST') return J({ message: 'Method not allowed' }, 405);
      if (fl.kind === 'config' && !fl.step) {
        if (!['sensor', 'binary_sensor'].includes((body || {}).next_step_id)) return J({ message: 'Invalid step' }, 400);
        fl.step = body.next_step_id;
        return J({ type: 'form', flow_id: m[2], handler: 'template', step_id: fl.step, data_schema: templateForm(fl.step, true), errors: null });
      }
      const bad = checkTemplateInput(fl.step, body || {}, fl.kind === 'config');
      if (bad) return J({ message: 'Message malformed: ' + bad }, 400);
      w.flows.delete(m[2]);
      if (fl.kind === 'options') { fl.entry.options = Object.assign({ template_type: fl.step }, body); const s = w.states.find((x) => x.entity_id === (w.reg.find((r) => r.config_entry_id === fl.entry.entry_id) || {}).entity_id); if (s) s.state = render(body.state); return J({ type: 'create_entry', flow_id: m[2], handler: fl.entry.entry_id, result: true }); }
      const entryId = 't' + w.flowCount, opts = Object.assign({ template_type: fl.step }, body); delete opts.name;
      const entry = { entry_id: entryId, domain: 'template', title: body.name, source: 'user', state: 'loaded', disabled_by: null, reason: null, options: opts };
      w.entries.push(entry);
      let eid = fl.step + '.' + slug(body.name); for (let n = 2; stateOf(eid); n++) eid = fl.step + '.' + slug(body.name) + '_' + n;
      w.states.push({ entity_id: eid, state: render(body.state), attributes: Object.assign({ friendly_name: body.name }, body.unit_of_measurement ? { unit_of_measurement: body.unit_of_measurement } : {}), last_changed: nowIso(), last_updated: nowIso() });
      w.reg.push({ entity_id: eid, device_id: null, area_id: null, platform: 'template', unique_id: entryId, config_entry_id: entryId, labels: [], categories: {} });
      return J({ type: 'create_entry', flow_id: m[2], handler: 'template', title: body.name, result: { entry_id: entryId, domain: 'template', title: body.name } });
    }
    if (method === 'DELETE' && (m = /^\/api\/config\/config_entries\/entry\/([^/]+)$/.exec(p))) {
      const en = w.entries.find((x) => x.entry_id === decodeURIComponent(m[1]));
      if (!en) return J({ message: 'Invalid entry specified' }, 404);
      w.entries.splice(w.entries.indexOf(en), 1);
      w.reg.filter((x) => x.config_entry_id === en.entry_id).forEach((x) => dropEntity(x.entity_id));
      return J({ require_restart: false });
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

  function helperCommand(d, op, msg) {
    const list = w.helpers[d], key = d + '_id';
    const fields = Object.assign({}, msg); delete fields.type; delete fields.id; delete fields[key];
    const bad = (m) => ({ success: false, error: { code: 'invalid_format', message: m } });
    const check = () => {
      if (!fields.name) return "required key not provided @ data['name']";
      if (d === 'input_number' && (fields.min == null || fields.max == null)) return "required key not provided @ data['" + (fields.min == null ? 'min' : 'max') + "']";
      if (d === 'input_number' && Number(fields.min) >= Number(fields.max)) return 'Maximum (' + fields.max + ') is not greater than minimum (' + fields.min + ') @ data';
      return null;
    };
    if (op === 'list') return { success: true, result: list };
    if (op === 'create') {
      const why = check(); if (why) return bad(why);
      let id = slug(fields.name); for (let n = 2; list.some((x) => x.id === id) || stateOf(d + '.' + id); n++) id = slug(fields.name) + '_' + n;
      const it = Object.assign({ id }, fields); list.push(it); addHelperEntity(d, it);
      return { success: true, result: it };
    }
    const it = list.find((x) => x.id === msg[key]);
    if (!it) return { success: false, error: { code: 'not_found', message: 'Unable to find ' + key + ' ' + msg[key] } };
    if (op === 'update') {
      const why = check(); if (why) return bad(why);
      Object.keys(it).forEach((k) => { if (k !== 'id') delete it[k]; }); Object.assign(it, fields);
      const s = stateOf(d + '.' + it.id); if (s) s.attributes.friendly_name = it.name;
      return { success: true, result: it };
    }
    list.splice(list.indexOf(it), 1); dropEntity(d + '.' + it.id);
    return { success: true, result: null };
  }

  /** -> { success, result } or { success: false, error } like the WebSocket API */
  function ws(msg) {
    const OK = (result) => ({ success: true, result });
    switch (msg.type) {
      // the Supervisor, as far as finding the ESPHome app goes (the newer supervisor/ingress/info is left out on purpose: HomeClaude falls back)
      case 'supervisor/api': {
        if (msg.endpoint === '/addons' && msg.method === 'get') return OK({ addons: [{ slug: 'core_mosquitto', name: 'Mosquitto broker', state: 'started' }, { slug: '5c53de3b_esphome', name: 'ESPHome Device Builder', state: 'started' }] });
        if (msg.endpoint === '/addons/5c53de3b_esphome/info') return OK({ slug: '5c53de3b_esphome', name: 'ESPHome Device Builder', state: 'started', ingress_url: '/api/hassio_ingress/' + w.ingressToken + '/' });
        if (msg.endpoint === '/ingress/session' && msg.method === 'post') { const id = 'sess' + (++w.sessionCount); w.sessions.add(id); return OK({ session: id }); }
        return { success: false, error: { code: 'unknown_error', message: 'Supervisor: not found' } };
      }
      case 'supervisor/ingress/session': {
        if (msg.slug !== '5c53de3b_esphome') return { success: false, error: { code: 'unknown_error', message: 'No such app' } };
        const id = 'sess' + (++w.sessionCount); w.sessions.add(id); return OK({ session: id });
      }
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
        if (msg.icon !== undefined) e.icon = msg.icon;
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
      case 'zwave_js/node_status': {
        const z = w.zwave[msg.device_id];
        return z ? OK({ node_id: z.nodeId, is_routing: true, status: z.status, is_secure: true, ready: true, zwave_plus_version: 2, highest_security_class: 1, is_controller_node: false, has_firmware_update_cc: true }) : { success: false, error: { code: 'not_found', message: 'Device not found' } };
      }
      case 'zwave_js/get_config_parameters': {
        const z = w.zwave[msg.device_id];
        return z ? OK(z.params) : { success: false, error: { code: 'not_found', message: 'Device not found' } };
      }
      case 'zwave_js/set_config_parameter': {
        const z = w.zwave[msg.device_id];
        if (!z) return { success: false, error: { code: 'not_found', message: 'Device not found' } };
        const key = Object.keys(z.params).find((k) => { const x = z.params[k]; return x.property === msg.property && (x.endpoint || 0) === (msg.endpoint || 0) && (x.property_key == null ? msg.property_key == null : x.property_key === msg.property_key); });
        if (!key) return { success: false, error: { code: 'not_found', message: 'Configuration parameter ' + msg.property + ' does not exist' } };
        z.params[key].value = msg.value;
        return OK({ value_id: key, status: z.status === 1 ? 'queued' : 'accepted' });
      }
      case 'call_service': {
        w.calls.push({ domain: msg.domain, service: msg.service, body: msg.service_data, ws: true });
        if (msg.domain === 'zwave_js' && msg.service === 'set_value') {
          const d = msg.service_data || {}, z = w.zwave[d.device_id];
          if (!z) return { success: false, error: { code: 'service_validation_error', message: 'No Z-Wave node found' } };
          if (Number(d.command_class) === 132 && d.property === 'wakeUpInterval') { if (!z.wake) return { success: false, error: { code: 'home_assistant_error', message: 'Wake Up CC is not supported' } }; z.wake.value = d.value; }
        }
        return OK({ context: { id: 'ctx' + w.calls.length } });
      }
      case 'config_entries/update': {
        const en = w.entries.find((x) => x.entry_id === msg.entry_id);
        if (!en) return { success: false, error: { code: 'not_found', message: 'Config entry not found' } };
        if (msg.title != null) en.title = msg.title;
        return OK({ config_entry: en, require_restart: false });
      }
      case 'search/related': return OK(msg.item_id === 'sensor.garage_freezer_temperature' ? { automation: ['automation.freezer_alert'], device: ['d3'], config_entry: ['e3'] } : {});
      case 'trace/list': return OK((w.traces[msg.domain + '/' + msg.item_id] || []).map((t) => { const c = Object.assign({}, t); delete c.trace; return c; }));
      case 'trace/get': {
        const t = (w.traces[msg.domain + '/' + msg.item_id] || []).find((x) => x.run_id === msg.run_id);
        return t ? OK(Object.assign({ config: w.automations[msg.item_id] || null }, t)) : { success: false, error: { code: 'not_found', message: 'The trace could not be found' } };
      }
      default: {
        const hm = /^(input_[a-z]+|counter|timer|schedule)\/(list|create|update|delete)$/.exec(msg.type || '');
        if (hm && w.helpers[hm[1]]) return helperCommand(hm[1], hm[2], msg);
        return { success: false, error: { code: 'unknown_command', message: 'Unknown command.' } };
      }
    }
  }

  /** <ha>/api/hassio_ingress/<token>/<path>: needs a live ingress_session cookie, like the Supervisor */
  function ingress(method, url, cookie, body) {
    const m = String(url).match(/^\/api\/hassio_ingress\/([^/]+)\/(.*)$/);
    if (!m || m[1] !== w.ingressToken) return { status: 404, body: 'Not found' };
    const sess = (String(cookie || '').match(/(?:^|;\s*)ingress_session=([^;]+)/) || [])[1];
    if (!sess || !w.sessions.has(sess)) return { status: 401, body: '401: Unauthorized' };
    if (m[2] !== 'api/mcp') return { status: 200, body: '<html>Device Builder</html>' };
    if (method !== 'POST') return { status: 405, body: '' };
    return w.builder.handle(body);
  }
  return { w, rest, ws, ingress };
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

// ---------- a pretend ESPHome Device Builder (its MCP endpoint), for demo mode and the tests ----------
function deviceBuilder() {
  const files = {
    'ro-water.yaml': 'esphome:\n  name: ro-water\n  friendly_name: RO Water\n\nesp32:\n  board: esp32dev\n\napi:\n  encryption:\n    key: "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c="\n\nota:\n  - platform: esphome\n    password: "0123456789abcdef"\n\nwifi:\n  ssid: !secret wifi_ssid\n  password: !secret wifi_password\n\nsensor:\n  - platform: pulse_meter\n    pin: GPIO27\n    name: "RO flow"\n',
    'garage-sensor.yaml': 'esphome:\n  name: garage-sensor\n\nesp8266:\n  board: d1_mini\n\napi:\n  encryption:\n    key: !secret garage_api_key\n\nwifi:\n  ssid: !secret wifi_ssid\n  password: !secret wifi_password\n',
    'secrets.yaml': 'wifi_ssid: "Home"\nwifi_password: "not-for-claude"\ngarage_api_key: "abc"\n'
  };
  const res = (text, isError) => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }], isError: !!isError });
  function check(content) {
    const out = ['INFO Reading configuration ' + '...'];
    if (/\t/.test(content)) return { ok: false, out: out.concat(['ERROR Error while reading config: found character \'\\t\' that cannot start any token']) };
    if (!/^esphome:/m.test(content)) return { ok: false, out: out.concat(['Failed config', '', 'esphome: [source <unicode string>:1]', '  ', '  Component esphome is required.']) };
    const bad = content.match(/^\s*-?\s*platform:\s*(nonsense\w*)/m);
    if (bad) return { ok: false, out: out.concat(['Failed config', '', 'sensor.' + bad[1] + ': [source x.yaml]', '  Platform not found: \'sensor.' + bad[1] + '\'.']) };
    return { ok: true, out: out.concat(['INFO Configuration is valid!']) };
  }
  function call(name, a) {
    const cfg = a.configuration;
    if (cfg != null && !/^[\w.-]+\.ya?ml$/.test(cfg)) return res('invalid_args: configuration must be a bare .yaml file name', true);
    if (cfg && /^secrets\./i.test(cfg) && name !== 'get_config') return res('invalid_args: secrets.yaml is read with get_config and changed with set_secret', true);
    switch (name) {
      case 'list_devices': return res(Object.keys(files).filter((f) => !/^secrets/.test(f)).map((f) => ({ name: f.replace(/\.ya?ml$/, ''), configuration: f, address: f.replace(/\.ya?ml$/, '') + '.local', online: f === 'ro-water.yaml', deployed_version: '2026.10.1', current_version: '2026.10.2', target_platform: f === 'ro-water.yaml' ? 'ESP32' : 'ESP8266' })));
      case 'list_secret_names': return res(['wifi_ssid', 'wifi_password', 'garage_api_key']);
      case 'get_config': return files[cfg] == null ? res('not_found: ' + cfg, true) : res(files[cfg]);
      case 'update_config':
        if (files[cfg] == null) return res('not_found: ' + cfg, true);
        if (a.expected !== files[cfg]) return res('precondition_failed: ' + cfg + ' changed since it was read', true);
        files[cfg] = a.content; return res('Saved ' + cfg);
      case 'validate_config': {
        if (files[cfg] == null) return res('not_found: ' + cfg, true);
        const r = check(files[cfg]);
        return res({ success: r.ok, exit_code: r.ok ? 0 : 2, output: r.out.map((l) => '\u001b[32m' + l + '\u001b[0m'), truncated: false });
      }
      default: return null;
    }
  }
  /** One JSON-RPC request -> { status, body } */
  function handle(body) {
    let m;
    try { m = JSON.parse(body); } catch (e) { return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
    if (m.method === 'initialize') return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'ESPHome Device Builder', version: '2026.10.2' } } } };
    if (m.method !== 'tools/call') return { status: 200, body: { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } } };
    const r = call(m.params.name, m.params.arguments || {});
    if (!r) return { status: 200, body: { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: ' + m.params.name } } };
    return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: r } };
  }
  return { files, handle };
}

/** Demo mode: lib/esphome.js talking to the pretend Device Builder without a network. */
function esphome() {
  const db = deviceBuilder();
  const fake = async (url, init) => {
    await new Promise((r) => setTimeout(r, 15));
    const r = db.handle(init.body);
    return { status: r.status, ok: r.status < 400, text: async () => JSON.stringify(r.body) };
  };
  const e = require('./esphome.js').create({ ha: { base: () => '', command: async () => { throw new HaError('no'); } }, settings: () => ({ enabled: true, url: 'http://esphome.demo:6052' }), fetch: fake });
  e.builder = db;
  return e;
}

module.exports = { createWorld, client, deviceBuilder, esphome };
