/*
 * The tools Claude sees. Read tools are always on; write tools only show up when they
 * are switched on in HomeClaude's permissions, and every one of them goes through the
 * blocked-domain rules in guard.js. Automations, scripts and dashboards are backed up
 * before they are changed or deleted.
 */
'use strict';
const Guard = require('./guard.js');
const Esp = require('./esphome.js');
const crypto = require('crypto');

class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };

// ---------- small helpers ----------
const MAX_TEXT = 60000;
function fit(obj) {
  let text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n... (cut: ' + (text.length - MAX_TEXT) + ' more characters. Ask for less, for example with a filter or a lower limit.)';
  return text;
}
const str = (v, max = 300) => (v == null ? '' : String(v)).trim().slice(0, max);
function int(v, def, min, max) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
const words = (q) => str(q, 200).toLowerCase().split(/\s+/).filter(Boolean);
const matches = (ws, ...hay) => { const h = hay.join(' ').toLowerCase(); return ws.every((w) => h.includes(w)); };
const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const OBJECT_RE = /^[a-z0-9_]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

async function states(ctx) {
  const c = ctx.cache;
  if (c.states && Date.now() - c.states.at < 2000) return c.states.v;
  const v = await ctx.ha.rest('GET', '/api/states');
  c.states = { at: Date.now(), v: Array.isArray(v) ? v : [] };
  return c.states.v;
}
async function registries(ctx) {
  const c = ctx.cache;
  if (c.reg && Date.now() - c.reg.at < 30000) return c.reg.v;
  const [ents, devs, areas] = await Promise.all([
    ctx.ha.command({ type: 'config/entity_registry/list' }).catch(() => []),
    ctx.ha.command({ type: 'config/device_registry/list' }).catch(() => []),
    ctx.ha.command({ type: 'config/area_registry/list' }).catch(() => [])
  ]);
  const v = { ents: new Map(), devs: new Map(), areas: new Map() };
  (ents || []).forEach((e) => v.ents.set(e.entity_id, e));
  (devs || []).forEach((d) => v.devs.set(d.id, d));
  (areas || []).forEach((a) => v.areas.set(a.area_id, a));
  c.reg = { at: Date.now(), v };
  return v;
}
// ---------- labels and categories ----------
async function labelReg(ctx) {
  const c = ctx.cache;
  if (c.labels && Date.now() - c.labels.at < 30000) return c.labels.v;
  const v = (await ctx.ha.command({ type: 'config/label_registry/list' })) || [];
  c.labels = { at: Date.now(), v };
  return v;
}
async function categoryReg(ctx, scope) {
  return (await ctx.ha.command({ type: 'config/category_registry/list', scope })) || [];
}
const CAT_SCOPES = ['automation', 'script', 'scene', 'helpers'];
function scopeFits(scope, eid) {
  const d = String(eid).split('.')[0];
  return scope === 'helpers' ? !['automation', 'script', 'scene'].includes(d) : d === scope;
}
function findLabel(labels, q) {
  const w = str(q, 100).toLowerCase();
  return labels.find((l) => l.label_id === w) || labels.find((l) => String(l.name).toLowerCase() === w) || null;
}
function findCategory(cats, q) {
  const w = str(q, 100).toLowerCase();
  return cats.find((c) => c.category_id === w) || cats.find((c) => String(c.name).toLowerCase() === w) || null;
}
const labelNames = (labels, ids) => (ids || []).map((id) => (labels.find((l) => l.label_id === id) || {}).name || id);
/** entity_id -> { category, labels } for list output (empty when Home Assistant has none) */
async function organization(ctx, scope) {
  const [r, labels, cats] = await Promise.all([registries(ctx), labelReg(ctx).catch(() => []), categoryReg(ctx, scope).catch(() => [])]);
  return (eid) => {
    const e = r.ents.get(eid) || {}, out = {};
    const cid = (e.categories || {})[scope];
    if (cid) out.category = (cats.find((c) => c.category_id === cid) || {}).name || cid;
    if ((e.labels || []).length) out.labels = labelNames(labels, e.labels);
    return out;
  };
}
const forget = (ctx) => { ctx.cache.reg = null; ctx.cache.labels = null; };

function areaOf(reg, entityId) {
  const e = reg.ents.get(entityId);
  if (!e) return null;
  let aid = e.area_id;
  if (!aid && e.device_id) { const d = reg.devs.get(e.device_id); aid = d && d.area_id; }
  return aid || null;
}
const areaName = (reg, aid) => (aid ? (reg.areas.get(aid) || {}).name || aid : null);
function findArea(reg, q) {
  const w = str(q, 100).toLowerCase();
  for (const a of reg.areas.values()) if (a.area_id === w || String(a.name).toLowerCase() === w) return a.area_id;
  for (const a of reg.areas.values()) if (String(a.name).toLowerCase().includes(w)) return a.area_id;
  return w;
}
function onlyChanged(stateList) {
  return (Array.isArray(stateList) ? stateList : []).slice(0, 50).map((s) => ({ entity_id: s.entity_id, state: s.state }));
}

/** Automation entity or id -> { id, entity_id }. */
async function automationRef(ctx, args) {
  const all = (await states(ctx)).filter((s) => s.entity_id.startsWith('automation.'));
  const eid = str(args.entity_id, 120), id = str(args.id, 100);
  if (eid) {
    const s = all.find((x) => x.entity_id === eid);
    if (!s) fail('There is no ' + eid + '. Use list_automations to see them.');
    return { id: s.attributes && s.attributes.id ? String(s.attributes.id) : null, entity_id: eid, state: s };
  }
  if (id) {
    const s = all.find((x) => x.attributes && String(x.attributes.id) === id);
    return { id, entity_id: s ? s.entity_id : null, state: s || null };
  }
  fail('Give the automation\'s entity_id (automation.xyz) or its id.');
}
function scriptRef(args) {
  let oid = str(args.id, 100) || str(args.entity_id, 120).replace(/^script\./, '');
  if (!OBJECT_RE.test(oid)) fail('Give the script\'s entity_id (script.xyz) or its id (the part after "script.").');
  return { id: oid, entity_id: 'script.' + oid };
}
async function getConfig(ctx, kind, id) {
  try { return await ctx.ha.rest('GET', '/api/config/' + kind + '/config/' + encodeURIComponent(id)); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

// ---------- ESPHome ----------
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function esp(ctx) { if (!ctx.esphome) fail('ESPHome is not available in HomeClaude.'); return ctx.esphome; }
/** file -> hash of the version Claude was last shown, so a save never overwrites something unseen */
function seen(ctx) { return ctx.cache.espSeen || (ctx.cache.espSeen = new Map()); }
function validation(f, r) {
  if (!r) return null;
  if (r.valid) return { configuration: f, valid: true };
  // the useful part of esphome's output is the error block; the start is only "INFO Reading configuration"
  const lines = r.output.filter((l) => !/^INFO (Reading configuration|Detected timezone|Generating C\+\+|Compiling)/.test(l));
  return { configuration: f, valid: false, exit_code: r.exit_code, output: lines.join('\n'), cut: r.truncated || undefined };
}

// ---------- dashboards (Lovelace) ----------
const DEFAULT_DASH = 'lovelace';
const DASH_PATH_RE = /^[a-z0-9_-]{1,60}$/;
const dashKey = (q) => { const p = str(q, 80).toLowerCase().replace(/^\/+|\/+$/g, ''); return !p || p === 'overview' || p === DEFAULT_DASH ? DEFAULT_DASH : p; };
const urlArg = (key) => (key === DEFAULT_DASH ? null : key);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
async function dashboards(ctx) {
  const [list, info] = await Promise.all([ctx.ha.command({ type: 'lovelace/dashboards/list' }), ctx.ha.command({ type: 'lovelace/info' }).catch(() => null)]);
  const main = { url_path: DEFAULT_DASH, title: 'Overview', default: true, mode: info && info.mode ? info.mode : undefined, show_in_sidebar: true };
  return [main].concat(Array.isArray(list) ? list : []);
}
async function findDash(ctx, q) {
  const list = await dashboards(ctx), key = dashKey(q), w = str(q, 80).toLowerCase();
  const d = list.find((x) => x.url_path === key) || (w && list.find((x) => String(x.title || '').toLowerCase() === w));
  if (!d) fail('There is no dashboard "' + str(q, 80) + '". Use list_dashboards to see them. Dashboards set up in YAML (configuration.yaml > lovelace > dashboards) are not listed by Home Assistant and can only be changed in their files.');
  return d;
}
/** The stored config, or null when Home Assistant builds the dashboard by itself (auto-generated / never saved). */
async function dashConfig(ctx, key) {
  try { return await ctx.ha.command({ type: 'lovelace/config', url_path: urlArg(key), force: false }); }
  catch (e) { if (e.code === 'config_not_found' || /no config found/i.test(e.message)) return null; throw e; }
}
function countCards(v) {
  let n = 0;
  (function walk(x, depth) {
    if (depth > 60 || x == null) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (typeof x !== 'object') return;
    if (Array.isArray(x.cards)) { n += x.cards.length; x.cards.forEach((y) => walk(y, depth + 1)); }
    if (Array.isArray(x.sections)) x.sections.forEach((y) => walk(y, depth + 1));
    if (x.card && typeof x.card === 'object') { n++; walk(x.card, depth + 1); }
  })(v, 0);
  return n;
}
const viewOutline = (v, i) => ({ index: i, title: v.title, path: v.path, type: v.type || (v.sections ? 'sections' : 'masonry'), cards: countCards(v), badges: Array.isArray(v.badges) && v.badges.length ? v.badges.length : undefined, subview: v.subview || undefined });
function findView(config, q) {
  const views = (config && config.views) || [], w = str(q, 100).toLowerCase();
  let i = views.findIndex((v) => String(v.path || '').toLowerCase() === w);
  if (i < 0) i = views.findIndex((v) => String(v.title || '').toLowerCase() === w);
  if (i < 0 && /^\d+$/.test(w) && Number(w) < views.length) i = Number(w);
  return i;
}
const dashSettings = (d) => (d.default ? null : { url_path: d.url_path, title: d.title, icon: d.icon || null, show_in_sidebar: d.show_in_sidebar !== false, require_admin: !!d.require_admin });
/** Home Assistant's dashboard schema takes no null icon: leave it out instead */
const noNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const saveDashBackup = (ctx, d, config, reason) => ctx.backups.save('dashboard', d.url_path, { alias: d.title, dashboard: dashSettings(d), config }, reason);
const yamlDash = (d) => 'The ' + d.title + ' dashboard is in YAML mode, so Home Assistant keeps it in a YAML file and it cannot be changed through the API. Say which file the person needs to edit (configuration.yaml > lovelace, or the dashboard\'s own file) and what to change.';
function checkDashConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config must be the whole dashboard: { views: [ ... ] } (or { strategy: { type } })');
  if (!Array.isArray(config.views) && !(config.strategy && typeof config.strategy === 'object')) fail('config needs a views list (or a strategy)');
  if (JSON.stringify(config).length > 1000000) fail('That dashboard config is over 1 MB. Split it into more views or dashboards.');
}

const LEVELS = { CRITICAL: 50, FATAL: 50, ERROR: 40, WARNING: 30, WARN: 30, INFO: 20, DEBUG: 10 };

// ---------- the tools ----------
const RO = { readOnlyHint: true, openWorldHint: false };
const TOOLS = [
  {
    name: 'get_overview', title: 'Home Assistant overview', annotations: RO,
    description: 'Start here. Home Assistant version and state, entity counts by domain, unavailable entities, integrations that failed to set up, open repairs, and how many errors and warnings are in the log. Also says what HomeClaude lets you change.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const [config, st, entries, repairs, logs] = await Promise.allSettled([
        ctx.ha.rest('GET', '/api/config'), states(ctx),
        ctx.ha.command({ type: 'config_entries/get' }), ctx.ha.command({ type: 'repairs/list_issues' }), ctx.ha.command({ type: 'system_log/list' })
      ]);
      if (config.status === 'rejected') throw config.reason;
      const c = config.value || {}, out = {};
      out.home_assistant = { version: c.version, location_name: c.location_name, state: c.state, time_zone: c.time_zone, safe_mode: c.safe_mode, recovery_mode: c.recovery_mode, config_dir: c.config_dir, components_loaded: (c.components || []).length };
      if (st.status === 'fulfilled') {
        const by = {}, unav = [];
        st.value.forEach((s) => { const d = s.entity_id.split('.')[0]; by[d] = (by[d] || 0) + 1; if (s.state === 'unavailable' || s.state === 'unknown') unav.push(s.entity_id + ' (' + s.state + ')'); });
        out.entities = { total: st.value.length, by_domain: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1])), unavailable_or_unknown: unav.length, examples: unav.slice(0, 25) };
      }
      if (entries.status === 'fulfilled') {
        const bad = (entries.value || []).filter(problem);
        out.integrations = { total: (entries.value || []).length, problems: bad.map((e) => ({ domain: e.domain, title: e.title, state: e.state, reason: e.reason || null })) };
      } else out.integrations = { error: entries.reason.message };
      if (repairs.status === 'fulfilled') {
        const open = ((repairs.value || {}).issues || []).filter((i) => !i.ignored && !i.dismissed_version);
        out.repairs = { open: open.length, issues: open.slice(0, 20).map((i) => ({ domain: i.domain, issue_id: i.issue_id, severity: i.severity })) };
      }
      if (logs.status === 'fulfilled') {
        const l = logs.value || [];
        out.log = { errors: l.filter((x) => (LEVELS[x.level] || 0) >= 40).length, warnings: l.filter((x) => LEVELS[x.level] === 30).length };
      }
      out.homeclaude = ctx.describeAccess();
      if (ctx.reviewInfo) out.homeclaude.change_reviews = ctx.reviewInfo();
      return out;
    }
  },
  {
    name: 'search_entities', title: 'Search entities', annotations: RO,
    description: 'Find entities by words in their id or name, by domain, area or state. Returns entity_id, name, state, area and when it last changed.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to look for in the entity id or friendly name' },
      domain: { type: 'string', description: 'For example light, sensor, binary_sensor, automation' },
      area: { type: 'string', description: 'Area name or id' },
      label: { type: 'string', description: 'Only entities with this label (name or id)' },
      state: { type: 'string', description: 'Only entities in this state, for example unavailable' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 60 }
    } },
    async run(args, ctx) {
      const ws = words(args.query), dom = str(args.domain, 40).toLowerCase(), want = str(args.state, 60), limit = int(args.limit, 60, 1, 500);
      const all = await states(ctx);
      const r = await registries(ctx);
      const labels = await labelReg(ctx).catch(() => []);
      const aid = args.area ? findArea(r, args.area) : null;
      let hits = all.filter((s) => (!dom || s.entity_id.startsWith(dom + '.')) && (!want || s.state === want) && matches(ws, s.entity_id, (s.attributes || {}).friendly_name || ''));
      if (args.area) hits = hits.filter((s) => areaOf(r, s.entity_id) === aid);
      if (args.label) {
        const l = findLabel(labels, args.label);
        if (!l) fail('There is no label "' + str(args.label, 80) + '". Use list_labels to see them.');
        hits = hits.filter((s) => ((r.ents.get(s.entity_id) || {}).labels || []).includes(l.label_id));
      }
      return {
        total: hits.length, shown: Math.min(limit, hits.length),
        entities: hits.slice(0, limit).map((s) => {
          const a = s.attributes || {};
          const lb = (r.ents.get(s.entity_id) || {}).labels || [];
          return { entity_id: s.entity_id, name: a.friendly_name, state: s.state, unit: a.unit_of_measurement, area: areaName(r, areaOf(r, s.entity_id)), labels: lb.length ? labelNames(labels, lb) : undefined, last_changed: s.last_changed };
        })
      };
    }
  },
  {
    name: 'get_entity', title: 'Entity details', annotations: RO,
    description: 'Everything about one entity: state, all attributes, its registry entry (integration, device, area, disabled or hidden), the device, and the automations, scripts and scenes that use it.',
    inputSchema: { type: 'object', required: ['entity_id'], properties: { entity_id: { type: 'string' } } },
    async run(args, ctx) {
      const eid = str(args.entity_id, 120);
      if (!ENTITY_RE.test(eid)) fail('entity_id should look like light.kitchen');
      let state = null;
      try { state = await ctx.ha.rest('GET', '/api/states/' + eid); } catch (e) { if (e.status !== 404) throw e; }
      const reg = await registries(ctx);
      const entry = reg.ents.get(eid) || null;
      if (!state && !entry) fail('Home Assistant has no entity ' + eid + '. Use search_entities to find the right id.');
      const dev = entry && entry.device_id ? reg.devs.get(entry.device_id) : null;
      let related = null;
      try { related = await ctx.ha.command({ type: 'search/related', item_type: 'entity', item_id: eid }); } catch (e) { related = { note: 'Could not look up related items: ' + e.message }; }
      return {
        state,
        registry: entry && { platform: entry.platform, area: areaName(reg, entry.area_id), disabled_by: entry.disabled_by, hidden_by: entry.hidden_by, entity_category: entry.entity_category, name_override: entry.name, config_entry_id: entry.config_entry_id, unique_id: entry.unique_id },
        device: dev && { id: dev.id, name: dev.name_by_user || dev.name, manufacturer: dev.manufacturer, model: dev.model, sw_version: dev.sw_version, area: areaName(reg, dev.area_id), disabled_by: dev.disabled_by },
        area: areaName(reg, areaOf(reg, eid)),
        related
      };
    }
  },
  {
    name: 'get_history', title: 'State history', annotations: RO,
    description: 'How one or more entities changed over time (state only, no attributes). Default is the last 24 hours, up to 7 days.',
    inputSchema: { type: 'object', required: ['entity_ids'], properties: {
      entity_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      hours: { type: 'number', minimum: 0.1, maximum: 168, default: 24, description: 'How far back from now (or from end)' },
      end: { type: 'string', description: 'Optional end time, ISO 8601. Default now' },
      max_points: { type: 'integer', minimum: 10, maximum: 2000, default: 300, description: 'Per entity; the newest are kept' }
    } },
    async run(args, ctx) {
      const ids = (Array.isArray(args.entity_ids) ? args.entity_ids : [args.entity_ids]).map((x) => str(x, 120)).filter((x) => ENTITY_RE.test(x)).slice(0, 10);
      if (!ids.length) fail('Give entity_ids, for example ["sensor.outdoor_temperature"]');
      const end = args.end ? Date.parse(args.end) : Date.now();
      if (!Number.isFinite(end)) fail('end is not a valid time');
      const hours = Math.min(168, Math.max(0.1, Number(args.hours) || 24)), max = int(args.max_points, 300, 10, 2000);
      const q = '?filter_entity_id=' + encodeURIComponent(ids.join(',')) + '&end_time=' + encodeURIComponent(iso(end)) + '&minimal_response&no_attributes';
      const raw = await ctx.ha.rest('GET', '/api/history/period/' + encodeURIComponent(iso(end - hours * 3600e3)) + q);
      const out = { from: iso(end - hours * 3600e3), to: iso(end), entities: {} };
      (Array.isArray(raw) ? raw : []).forEach((series) => {
        if (!Array.isArray(series) || !series.length) return;
        const eid = series[0].entity_id;
        const pts = series.map((p) => [p.last_changed || p.last_updated, p.state]);
        out.entities[eid] = { changes: pts.length, points: pts.slice(-max) };
      });
      ids.forEach((i) => { if (!out.entities[i]) out.entities[i] = { changes: 0, points: [], note: 'No recorded history in this window (or the recorder excludes it)' }; });
      return out;
    }
  },
  {
    name: 'get_logbook', title: 'Logbook', annotations: RO,
    description: 'Logbook entries (what happened and what caused it), for one entity or everything. Default last 24 hours.',
    inputSchema: { type: 'object', properties: {
      entity_id: { type: 'string' }, hours: { type: 'number', minimum: 0.1, maximum: 168, default: 24 },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 150, description: 'Newest entries kept' }
    } },
    async run(args, ctx) {
      const eid = str(args.entity_id, 120);
      if (eid && !ENTITY_RE.test(eid)) fail('entity_id should look like light.kitchen');
      const hours = Math.min(168, Math.max(0.1, Number(args.hours) || 24)), end = Date.now();
      const q = '?end_time=' + encodeURIComponent(iso(end)) + (eid ? '&entity=' + encodeURIComponent(eid) : '');
      const raw = await ctx.ha.rest('GET', '/api/logbook/' + encodeURIComponent(iso(end - hours * 3600e3)) + q);
      const list = Array.isArray(raw) ? raw : [];
      const limit = int(args.limit, 150, 1, 1000);
      return { total: list.length, entries: list.slice(-limit).map((e) => ({ when: e.when, name: e.name, entity_id: e.entity_id, state: e.state, message: e.message, domain: e.domain, caused_by: e.context_event_type ? [e.context_event_type, e.context_domain, e.context_service, e.context_name, e.context_entity_id].filter(Boolean).join(' ') : undefined })) };
    }
  },
  {
    name: 'get_logs', title: 'Error log', annotations: RO,
    description: 'Recent errors and warnings from Home Assistant\'s system log, grouped as Home Assistant groups them (count, first and last time, source file, traceback). Filter by level and words. raw_lines returns the end of the full log file instead.',
    inputSchema: { type: 'object', properties: {
      level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], default: 'warning', description: 'This level and above' },
      search: { type: 'string', description: 'Words that must appear in the logger name, message or source' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
      raw_lines: { type: 'integer', minimum: 0, maximum: 1000, default: 0, description: 'If above 0: the last lines of home-assistant.log instead' }
    } },
    async run(args, ctx) {
      const rawN = int(args.raw_lines, 0, 0, 1000);
      if (rawN > 0) {
        const text = String(await ctx.ha.rest('GET', '/api/error_log', undefined, { text: true }) || '');
        let lines = text.split('\n');
        const ws = words(args.search);
        if (ws.length) lines = lines.filter((l) => matches(ws, l));
        return lines.slice(-rawN).join('\n') || '(nothing)';
      }
      const min = LEVELS[str(args.level, 10).toUpperCase()] || 30, ws = words(args.search), limit = int(args.limit, 40, 1, 200);
      const list = (await ctx.ha.command({ type: 'system_log/list' })) || [];
      const hits = list.filter((x) => (LEVELS[x.level] || 0) >= min && matches(ws, x.name, [].concat(x.message || []).join(' '), [].concat(x.source || []).join(':')))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return {
        total: hits.length,
        entries: hits.slice(0, limit).map((x) => ({
          level: x.level, logger: x.name, message: [].concat(x.message || []).slice(0, 5).join('\n').slice(0, 2000),
          source: [].concat(x.source || []).join(':'), count: x.count,
          first: x.first_occurred ? iso(x.first_occurred * 1000) : undefined, last: x.timestamp ? iso(x.timestamp * 1000) : undefined,
          exception: x.exception ? String(x.exception).slice(-4000) : undefined
        }))
      };
    }
  },
  {
    name: 'list_integrations', title: 'Integrations', annotations: RO,
    description: 'Configured integrations (config entries) and whether they loaded. Problems (setup_error, setup_retry, migration_error, failed_unload, not loaded) come first with the reason Home Assistant gives.',
    inputSchema: { type: 'object', properties: { problems_only: { type: 'boolean', default: false }, domain: { type: 'string' } } },
    async run(args, ctx) {
      const dom = str(args.domain, 60).toLowerCase();
      let list = ((await ctx.ha.command({ type: 'config_entries/get' })) || []).filter((e) => !dom || e.domain === dom);
      if (args.problems_only) list = list.filter(problem);
      list.sort((a, b) => Number(problem(b)) - Number(problem(a)) || String(a.domain).localeCompare(String(b.domain)));
      return { total: list.length, problems: list.filter(problem).length, integrations: list.map((e) => ({ domain: e.domain, title: e.title, state: e.state, reason: e.reason || undefined, disabled_by: e.disabled_by || undefined, source: e.source, entry_id: e.entry_id })) };
    }
  },
  {
    name: 'list_repairs', title: 'Repairs', annotations: RO,
    description: 'Open issues in Settings > Repairs (deprecations, broken config, integrations that need attention), with severity and the version they break in.',
    inputSchema: { type: 'object', properties: { include_ignored: { type: 'boolean', default: false } } },
    async run(args, ctx) {
      const all = ((await ctx.ha.command({ type: 'repairs/list_issues' })) || {}).issues || [];
      const list = all.filter((i) => args.include_ignored || (!i.ignored && !i.dismissed_version));
      return { total: list.length, issues: list.map((i) => ({ domain: i.domain, issue_domain: i.issue_domain, issue_id: i.issue_id, severity: i.severity, translation_key: i.translation_key, placeholders: i.translation_placeholders || undefined, is_fixable: i.is_fixable, breaks_in: i.breaks_in_ha_version || undefined, learn_more: i.learn_more_url || undefined, created: i.created, ignored: i.ignored || undefined })) };
    }
  },
  {
    name: 'list_automations', title: 'List automations', annotations: RO,
    description: 'All automations with their id, on/off, when they last ran, mode and whether they can be edited through the API (only automations with an id, i.e. made in the UI or kept in automations.yaml).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async run(args, ctx) {
      const ws = words(args.query);
      const list = (await states(ctx)).filter((s) => s.entity_id.startsWith('automation.') && matches(ws, s.entity_id, (s.attributes || {}).friendly_name || ''));
      const org = await organization(ctx, 'automation');
      return { total: list.length, automations: list.map((s) => { const a = s.attributes || {}; return Object.assign({ entity_id: s.entity_id, name: a.friendly_name, id: a.id || null, editable: !!a.id, state: s.state, last_triggered: a.last_triggered || null, mode: a.mode, running: a.current || 0 }, org(s.entity_id)); }).sort((x, y) => String(x.name).localeCompare(String(y.name))) };
    }
  },
  {
    name: 'list_scripts', title: 'List scripts', annotations: RO,
    description: 'All scripts with their id, whether running, when they last ran and their mode.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async run(args, ctx) {
      const ws = words(args.query);
      const list = (await states(ctx)).filter((s) => s.entity_id.startsWith('script.') && matches(ws, s.entity_id, (s.attributes || {}).friendly_name || ''));
      const org = await organization(ctx, 'script');
      return { total: list.length, scripts: list.map((s) => { const a = s.attributes || {}; return Object.assign({ entity_id: s.entity_id, name: a.friendly_name, id: s.entity_id.slice(7), state: s.state, last_triggered: a.last_triggered || null, mode: a.mode }, org(s.entity_id)); }).sort((x, y) => String(x.name).localeCompare(String(y.name))) };
    }
  },
  {
    name: 'get_automation', title: 'Automation config', annotations: RO,
    description: 'The full configuration of one automation (triggers, conditions, actions), as Home Assistant stores it.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, id: { type: 'string' } } },
    async run(args, ctx) {
      const ref = await automationRef(ctx, args);
      if (!ref.id) fail(ref.entity_id + ' has no id, so it is defined in YAML outside automations.yaml. It cannot be read or changed through the API; its YAML file has to be edited directly. Its triggers and actions can still be seen with get_traces.');
      const config = await getConfig(ctx, 'automation', ref.id);
      if (!config) fail('Home Assistant has no stored config for automation id ' + ref.id + '.');
      return { id: ref.id, entity_id: ref.entity_id, state: ref.state ? ref.state.state : null, config };
    }
  },
  {
    name: 'get_script', title: 'Script config', annotations: RO,
    description: 'The full configuration of one script (fields, sequence, mode).',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, id: { type: 'string' } } },
    async run(args, ctx) {
      const ref = scriptRef(args);
      const config = await getConfig(ctx, 'script', ref.id);
      if (!config) fail('Home Assistant has no stored config for ' + ref.entity_id + '. It may be defined in YAML outside scripts.yaml, which the API cannot read.');
      return { id: ref.id, entity_id: ref.entity_id, config };
    }
  },
  {
    name: 'get_traces', title: 'Automation and script traces', annotations: RO,
    description: 'Why an automation or script did or did not do what was expected. Without run_id: its recent runs (when, what triggered it, how it ended, errors). With run_id: that run step by step, with condition results and action errors.',
    inputSchema: { type: 'object', required: ['entity_id'], properties: {
      entity_id: { type: 'string', description: 'automation.xyz or script.xyz' },
      run_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      include_config: { type: 'boolean', default: false, description: 'Also return the config the run used' }
    } },
    async run(args, ctx) {
      const eid = str(args.entity_id, 120);
      let domain, item;
      if (eid.startsWith('automation.')) { domain = 'automation'; const ref = await automationRef(ctx, { entity_id: eid }); item = ref.id || eid.slice(11); }
      else if (eid.startsWith('script.')) { domain = 'script'; item = eid.slice(7); }
      else fail('entity_id must be an automation.xyz or script.xyz');
      const runId = str(args.run_id, 100);
      if (!runId) {
        const list = (await ctx.ha.command({ type: 'trace/list', domain, item_id: item })) || [];
        const runs = list.sort((a, b) => String((b.timestamp || {}).start).localeCompare(String((a.timestamp || {}).start)));
        return { entity_id: eid, stored_runs: runs.length, runs: runs.slice(0, int(args.limit, 10, 1, 50)).map((r) => ({ run_id: r.run_id, start: (r.timestamp || {}).start, finish: (r.timestamp || {}).finish, result: r.script_execution, state: r.state, trigger: r.trigger, last_step: r.last_step, error: r.error || undefined })),
          note: runs.length ? undefined : 'No stored runs. Home Assistant keeps the last few runs per item (stored_traces, default 5), and none since it last restarted.' };
      }
      const t = await ctx.ha.command({ type: 'trace/get', domain, item_id: item, run_id: runId });
      const steps = [];
      Object.keys((t && t.trace) || {}).forEach((p) => [].concat(t.trace[p] || []).forEach((s) => steps.push({ path: p, at: s.timestamp, result: s.result, error: s.error, variables_changed: s.changed_variables ? Object.keys(s.changed_variables) : undefined })));
      steps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { entity_id: eid, run_id: runId, start: (t.timestamp || {}).start, finish: (t.timestamp || {}).finish, result: t.script_execution, error: t.error || undefined, trigger: t.trigger, last_step: t.last_step, steps, config: args.include_config ? t.config : undefined };
    }
  },
  {
    name: 'list_services', title: 'Services', annotations: RO,
    description: 'Without domain: every domain and the service (action) names it offers. With domain: each service\'s fields, which are required, and examples.',
    inputSchema: { type: 'object', properties: { domain: { type: 'string' } } },
    async run(args, ctx) {
      const dom = str(args.domain, 60).toLowerCase();
      const all = (await ctx.ha.rest('GET', '/api/services')) || [];
      if (!dom) { const out = {}; all.forEach((d) => { out[d.domain] = Object.keys(d.services || {}); }); return out; }
      const d = all.find((x) => x.domain === dom);
      if (!d) fail('No services in domain ' + dom);
      const out = {};
      Object.entries(d.services || {}).forEach(([k, s]) => {
        const fields = {};
        Object.entries(s.fields || {}).forEach(([f, v]) => { if (v && typeof v === 'object' && v.fields) Object.assign(fields, v.fields); else fields[f] = v; });
        out[k] = { name: s.name, description: s.description, target: s.target ? true : undefined, fields: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { required: !!(v && v.required) || undefined, description: v && v.description, example: v && v.example, type: v && v.selector ? Object.keys(v.selector)[0] : undefined }])) };
      });
      return { domain: dom, services: out };
    }
  },
  {
    name: 'render_template', title: 'Test a template', annotations: RO,
    description: 'Renders a Jinja template in Home Assistant and returns the result, to test template sensors, conditions and messages before using them.',
    inputSchema: { type: 'object', required: ['template'], properties: { template: { type: 'string' }, variables: { type: 'object' } } },
    async run(args, ctx) {
      const tpl = str(args.template, 20000);
      if (!tpl) fail('template is empty');
      const body = { template: tpl };
      if (args.variables && typeof args.variables === 'object') body.variables = args.variables;
      return String(await ctx.ha.rest('POST', '/api/template', body, { text: true }));
    }
  },
  {
    name: 'check_config', title: 'Check configuration', annotations: RO,
    description: 'Runs Home Assistant\'s configuration check (like Developer tools > YAML > Check configuration). Use after YAML changes and before restarting.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) { return ctx.ha.rest('POST', '/api/config/core/check_config', {}, { timeoutMs: 120000 }); }
  },
  {
    name: 'list_devices', title: 'Devices', annotations: RO,
    description: 'Devices from the device registry: name, maker, model, firmware, area, whether disabled, and how many entities each has.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, area: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } },
    async run(args, ctx) {
      const reg = await registries(ctx), ws = words(args.query), aid = args.area ? findArea(reg, args.area) : null;
      const counts = {};
      reg.ents.forEach((e) => { if (e.device_id) counts[e.device_id] = (counts[e.device_id] || 0) + 1; });
      const list = [...reg.devs.values()].filter((d) => (!aid || d.area_id === aid) && matches(ws, d.name_by_user || '', d.name || '', d.manufacturer || '', d.model || ''));
      const limit = int(args.limit, 100, 1, 500);
      return { total: list.length, devices: list.slice(0, limit).map((d) => ({ id: d.id, name: d.name_by_user || d.name, manufacturer: d.manufacturer, model: d.model, sw_version: d.sw_version, area: areaName(reg, d.area_id), disabled_by: d.disabled_by || undefined, entities: counts[d.id] || 0, service: d.entry_type === 'service' || undefined })) };
    }
  },
  {
    name: 'list_areas', title: 'Areas', annotations: RO,
    description: 'Areas (rooms) with their ids and how many devices and entities are in each.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const reg = await registries(ctx), dev = {}, ent = {};
      reg.devs.forEach((d) => { if (d.area_id) dev[d.area_id] = (dev[d.area_id] || 0) + 1; });
      reg.ents.forEach((e) => { const a = areaOf(reg, e.entity_id); if (a) ent[a] = (ent[a] || 0) + 1; });
      return [...reg.areas.values()].map((a) => ({ area_id: a.area_id, name: a.name, floor_id: a.floor_id || undefined, devices: dev[a.area_id] || 0, entities: ent[a.area_id] || 0 }));
    }
  },

  {
    name: 'list_labels', title: 'Labels', annotations: RO,
    description: 'All labels (Settings > Areas, labels & zones > Labels) with their id, color, icon, description, and how many entities, devices and areas carry each. Filter entities by a label with search_entities.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const [labels, reg] = await Promise.all([labelReg(ctx), registries(ctx)]);
      const count = (map, id) => [...map.values()].filter((x) => (x.labels || []).includes(id)).length;
      return labels.map((l) => ({ label_id: l.label_id, name: l.name, color: l.color || undefined, icon: l.icon || undefined, description: l.description || undefined, entities: count(reg.ents, l.label_id), devices: count(reg.devs, l.label_id), areas: count(reg.areas, l.label_id) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
  },
  {
    name: 'list_categories', title: 'Categories', annotations: RO,
    description: 'Categories in one scope (automation, script, scene or helpers), as used to group them on those pages in Home Assistant, with the items in each and how many have none.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: CAT_SCOPES, default: 'automation' } } },
    async run(args, ctx) {
      const scope = CAT_SCOPES.includes(args.scope) ? args.scope : 'automation';
      const [cats, reg] = await Promise.all([categoryReg(ctx, scope), registries(ctx)]);
      const members = [...reg.ents.values()].filter((e) => scopeFits(scope, e.entity_id));
      return {
        scope,
        categories: cats.map((c) => ({ category_id: c.category_id, name: c.name, icon: c.icon || undefined, items: members.filter((e) => (e.categories || {})[scope] === c.category_id).map((e) => e.entity_id) })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        uncategorized: members.filter((e) => !(e.categories || {})[scope]).length
      };
    }
  },

  {
    name: 'list_dashboards', title: 'Dashboards', annotations: RO,
    description: 'All dashboards (Overview and the ones added under Settings > Dashboards): url_path, title, icon, sidebar, admin only, storage or YAML mode, and an outline of each one\'s views (title, path, type, card count). Auto-generated dashboards have no stored config yet.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const list = await dashboards(ctx);
      const out = await Promise.all(list.map(async (d) => {
        const o = { url_path: d.url_path, title: d.title, default: d.default || undefined, icon: d.icon || undefined, mode: d.mode, show_in_sidebar: d.show_in_sidebar !== false, require_admin: d.require_admin || undefined, editable: d.mode !== 'yaml' };
        try {
          const c = await dashConfig(ctx, d.url_path);
          if (!c) o.auto_generated = true;
          else if (c.strategy) o.strategy = c.strategy.type;
          else o.views = (c.views || []).map(viewOutline);
        } catch (e) { o.error = e.message; }
        return o;
      }));
      return { total: out.length, dashboards: out };
    }
  },
  {
    name: 'get_dashboard', title: 'Dashboard config', annotations: RO,
    description: 'The configuration of one dashboard (default Overview), as the raw configuration editor shows it. Give view (its path, title or index) to get just that view, which is better for big dashboards.',
    inputSchema: { type: 'object', properties: {
      dashboard: { type: 'string', description: 'url_path or title, for example dashboard-home. Leave out for Overview' },
      view: { type: 'string', description: 'Only this view: its path, title or index (0 is the first)' }
    } },
    async run(args, ctx) {
      const d = await findDash(ctx, args.dashboard);
      const config = await dashConfig(ctx, d.url_path);
      const head = { url_path: d.url_path, title: d.title, mode: d.mode, editable: d.mode !== 'yaml' };
      if (!config) return Object.assign(head, { auto_generated: true, note: 'Home Assistant builds this dashboard by itself from the entities and areas; there is no stored config. Saving a whole config with save_dashboard takes control of it (like "Take control" in Home Assistant), and from then on it no longer adds new entities by itself. Ask the person first.' });
      if (args.view != null && args.view !== '') {
        const i = findView(config, args.view);
        if (i < 0) fail('There is no view "' + str(args.view, 100) + '" on ' + d.title + '. Its views: ' + (config.views || []).map((v, n) => n + ' ' + (v.path || v.title || '(no title)')).join(', '));
        return Object.assign(head, { view_index: i, view: config.views[i] });
      }
      return Object.assign(head, { config });
    }
  },

  // ---------- ESPHome (only listed when ESPHome is on in HomeClaude) ----------
  {
    name: 'list_esphome_devices', title: 'ESPHome devices', annotations: RO, needs: 'esphome',
    description: 'ESPHome devices from the ESPHome Device Builder: each YAML file name (configuration), name, address, whether it is online, and the firmware version it runs versus the current one. Also the names in secrets.yaml (never their values), for use as !secret name.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, ctx) {
      const r = await esp(ctx).devices();
      const keep = ['configuration', 'name', 'friendly_name', 'comment', 'address', 'online', 'state', 'target_platform', 'deployed_version', 'current_version', 'loaded_integrations'];
      const devices = r.devices.map((d) => { const o = {}; Object.keys(d).forEach((k) => { if (keep.includes(k) || /online|version|platform|address/.test(k)) o[k] = d[k]; }); return o; });
      return { count: devices.length, devices, secret_names: r.secret_names || undefined,
        note: 'HomeClaude can read, change and validate these files. Compiling and installing firmware is done by the person in the ESPHome Device Builder.' };
    }
  },
  {
    name: 'get_esphome_config', title: 'ESPHome device config', annotations: RO, needs: 'esphome',
    description: 'The YAML of one ESPHome device (configuration from list_esphome_devices). Passwords and keys written in the file itself are shown as "' + Esp.HIDDEN + '"; leave that text as it is when you save and HomeClaude puts the real value back. secrets.yaml cannot be read. Read a file with this before changing it.',
    inputSchema: { type: 'object', required: ['configuration'], properties: { configuration: { type: 'string', description: 'YAML file name, e.g. ro-water.yaml' } } },
    async run(args, ctx) {
      const f = Esp.checkFile(args.configuration);
      const raw = await esp(ctx).read(f);
      seen(ctx).set(f, sha(raw));
      const h = Esp.hide(raw);
      return { configuration: f, lines: raw.split('\n').length, hidden_values: h.hidden || undefined, content: h.text };
    }
  },
  {
    name: 'validate_esphome_config', title: 'Validate an ESPHome config', annotations: RO, needs: 'esphome',
    description: 'Checks one ESPHome device config with esphome config (as the Device Builder\'s Validate does) and returns whether it is valid with the last lines of output. Does not compile or install anything.',
    inputSchema: { type: 'object', required: ['configuration'], properties: { configuration: { type: 'string' }, lines: { type: 'integer', minimum: 5, maximum: 300, default: 60, description: 'How many output lines to return when it is not valid' } } },
    async run(args, ctx) {
      const f = Esp.checkFile(args.configuration);
      const r = await esp(ctx).validate(f, int(args.lines, 60, 5, 300));
      return validation(f, r);
    }
  },

  // ---------- changes (only listed when switched on) ----------
  {
    name: 'save_automation', title: 'Create or update an automation', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Creates a new automation, or replaces an existing one (give its id). The config uses the same keys as automations.yaml: alias, description, mode, triggers, conditions, actions. The current version is backed up first and Home Assistant reloads automations by itself. Afterwards check it with get_traces or list_automations.',
    inputSchema: { type: 'object', required: ['config'], properties: {
      id: { type: 'string', description: 'Existing automation id to replace. Leave out to create a new one' },
      config: { type: 'object', description: 'The automation: { alias, description, mode, triggers, conditions, actions }' }
    } },
    async run(args, ctx) {
      const config = args.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config must be an object with alias, triggers and actions');
      if (!str(config.alias)) fail('Give the automation an alias (its name)');
      const blocked = Guard.checkConfig(config, ctx.blocked());
      if (blocked) fail('Not saved: ' + blocked + '. HomeClaude blocks this. A person can make this change in Home Assistant, or unblock the domain in HomeClaude\'s permissions.');
      let id = str(args.id, 100);
      if (id && !ID_RE.test(id)) fail('id may only contain letters, numbers, dots, dashes and underscores');
      const old = id ? await getConfig(ctx, 'automation', id) : null;
      const created = !old;
      if (!id) id = String(Date.now());
      const backup = old ? ctx.backups.save('automation', id, old, 'before-change') : null;
      const body = Object.assign({}, config, { id });
      await ctx.ha.rest('POST', '/api/config/automation/config/' + encodeURIComponent(id), body);
      ctx.cache.states = null;
      await sleep(ctx.settleMs);
      const s = (await states(ctx)).find((x) => x.entity_id.startsWith('automation.') && x.attributes && String(x.attributes.id) === id);
      const review = ctx.onChange ? ctx.onChange({ kind: 'automation', id, alias: config.alias, action: created ? 'created' : 'changed', backup, before: old, after: body }) : null;
      return { saved: true, created, id, entity_id: s ? s.entity_id : null, state: s ? s.state : null, backup, review: review || undefined, note: s ? undefined : 'Saved, but the automation did not show up yet. Check get_logs for a config error.' };
    }
  },
  {
    name: 'save_script', title: 'Create or update a script', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Creates or replaces a script. id is the part after "script." (lowercase, numbers, underscores). The config uses the scripts.yaml keys: alias, description, mode, fields, sequence. The current version is backed up first.',
    inputSchema: { type: 'object', required: ['id', 'config'], properties: { id: { type: 'string' }, config: { type: 'object' } } },
    async run(args, ctx) {
      const config = args.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config must be an object with alias and sequence');
      const ref = scriptRef({ id: args.id });
      const blocked = Guard.checkConfig(config, ctx.blocked());
      if (blocked) fail('Not saved: ' + blocked + '. HomeClaude blocks this. A person can make this change in Home Assistant, or unblock the domain in HomeClaude\'s permissions.');
      const old = await getConfig(ctx, 'script', ref.id);
      const backup = old ? ctx.backups.save('script', ref.id, old, 'before-change') : null;
      await ctx.ha.rest('POST', '/api/config/script/config/' + ref.id, config);
      ctx.cache.states = null;
      const review = ctx.onChange ? ctx.onChange({ kind: 'script', id: ref.id, alias: config.alias || ref.id, action: old ? 'changed' : 'created', backup, before: old, after: config }) : null;
      return { saved: true, created: !old, id: ref.id, entity_id: ref.entity_id, backup, review: review || undefined };
    }
  },
  {
    name: 'delete_automation', title: 'Delete an automation', needs: 'delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Deletes an automation. It is backed up first and can be restored from HomeClaude\'s Backups page. Ask the person before deleting.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, id: { type: 'string' } } },
    async run(args, ctx) {
      const ref = await automationRef(ctx, args);
      if (!ref.id) fail(ref.entity_id + ' has no id; it lives in a YAML file and cannot be deleted through the API.');
      const old = await getConfig(ctx, 'automation', ref.id);
      if (!old) fail('There is no automation with id ' + ref.id);
      const backup = ctx.backups.save('automation', ref.id, old, 'before-delete');
      await ctx.ha.rest('DELETE', '/api/config/automation/config/' + encodeURIComponent(ref.id));
      ctx.cache.states = null;
      const review = ctx.onChange ? ctx.onChange({ kind: 'automation', id: ref.id, alias: old.alias, action: 'deleted', backup, before: old, after: null }) : null;
      return { deleted: true, id: ref.id, entity_id: ref.entity_id, backup, review: review || undefined };
    }
  },
  {
    name: 'delete_script', title: 'Delete a script', needs: 'delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Deletes a script. It is backed up first and can be restored from HomeClaude\'s Backups page. Ask the person before deleting.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, id: { type: 'string' } } },
    async run(args, ctx) {
      const ref = scriptRef(args);
      const old = await getConfig(ctx, 'script', ref.id);
      if (!old) fail('There is no stored script ' + ref.entity_id);
      const backup = ctx.backups.save('script', ref.id, old, 'before-delete');
      await ctx.ha.rest('DELETE', '/api/config/script/config/' + ref.id);
      ctx.cache.states = null;
      const review = ctx.onChange ? ctx.onChange({ kind: 'script', id: ref.id, alias: old.alias || ref.id, action: 'deleted', backup, before: old, after: null }) : null;
      return { deleted: true, id: ref.id, entity_id: ref.entity_id, backup, review: review || undefined };
    }
  },
  {
    name: 'delete_dashboard', title: 'Delete a dashboard', needs: 'delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Deletes a dashboard (not Overview). Its settings and config are backed up first and it can be brought back with Revert or from HomeClaude\'s Backups page. Ask the person before deleting.',
    inputSchema: { type: 'object', required: ['dashboard'], properties: { dashboard: { type: 'string', description: 'url_path or title' } } },
    async run(args, ctx) {
      const d = await findDash(ctx, args.dashboard);
      if (d.default) fail('Overview cannot be deleted. To clear what Claude changed on it, the person can revert or restore it in HomeClaude.');
      if (d.mode === 'yaml' || !d.id) fail(yamlDash(d));
      const config = await dashConfig(ctx, d.url_path);
      const backup = saveDashBackup(ctx, d, config, 'before-delete');
      await ctx.ha.command({ type: 'lovelace/dashboards/delete', dashboard_id: d.id });
      const s0 = dashSettings(d);
      const revert = [Object.assign({ type: 'lovelace/dashboards/create' }, noNull(s0))];
      if (config) revert.push({ type: 'lovelace/config/save', url_path: d.url_path, config });
      const review = ctx.onChange ? ctx.onChange({ kind: 'dashboard', id: d.url_path, alias: d.title, action: 'deleted', backup, before: { dashboard: s0, config }, after: null, revert }) : null;
      return { deleted: true, dashboard: d.url_path, title: d.title, backup, review: review || undefined };
    }
  },
  {
    name: 'save_label', title: 'Create or change a label', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Creates a label, or renames/recolors one (give label_id). Colors are Home Assistant\'s names (red, pink, purple, deep-purple, indigo, blue, light-blue, cyan, teal, green, light-green, lime, yellow, amber, orange, deep-orange, brown, grey, blue-grey) and icons are mdi: names. The person can keep or revert it.',
    inputSchema: { type: 'object', required: ['name'], properties: { label_id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' }, description: { type: 'string' } } },
    async run(args, ctx) {
      const name = str(args.name, 100);
      if (!name) fail('Give the label a name');
      const labels = await labelReg(ctx);
      const fields = { name };
      ['color', 'icon', 'description'].forEach((k) => { if (args[k] != null) fields[k] = str(args[k], 200) || null; });
      if (args.label_id) {
        const old = labels.find((l) => l.label_id === str(args.label_id, 100));
        if (!old) fail('There is no label ' + args.label_id + '. Use list_labels.');
        const r = await ctx.ha.command(Object.assign({ type: 'config/label_registry/update', label_id: old.label_id }, fields));
        forget(ctx);
        const before = { name: old.name, color: old.color || null, icon: old.icon || null, description: old.description || null };
        const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'label-' + old.label_id, alias: 'Label ' + old.name, action: 'changed', before: { label: before }, after: { label: Object.assign({}, before, fields) },
          revert: [Object.assign({ type: 'config/label_registry/update', label_id: old.label_id }, before)] }) : null;
        return { saved: true, label: r, review: review || undefined };
      }
      if (findLabel(labels, name)) fail('A label called "' + name + '" already exists. Give its label_id to change it.');
      const r = await ctx.ha.command(Object.assign({ type: 'config/label_registry/create' }, fields));
      forget(ctx);
      const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'label-' + r.label_id, alias: 'Label ' + name, action: 'created', before: {}, after: { label: fields },
        revert: [{ type: 'config/label_registry/delete', label_id: r.label_id }] }) : null;
      return { created: true, label: r, review: review || undefined };
    }
  },
  {
    name: 'save_category', title: 'Create or rename a category', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Creates a category in a scope (automation, script, scene or helpers), or renames one (give category_id). The person can keep or revert it.',
    inputSchema: { type: 'object', required: ['scope', 'name'], properties: { scope: { type: 'string', enum: CAT_SCOPES }, category_id: { type: 'string' }, name: { type: 'string' }, icon: { type: 'string' } } },
    async run(args, ctx) {
      const scope = CAT_SCOPES.includes(args.scope) ? args.scope : fail('scope must be one of ' + CAT_SCOPES.join(', '));
      const name = str(args.name, 100);
      if (!name) fail('Give the category a name');
      const cats = await categoryReg(ctx, scope);
      const fields = { name };
      if (args.icon != null) fields.icon = str(args.icon, 100) || null;
      if (args.category_id) {
        const old = cats.find((c) => c.category_id === str(args.category_id, 100));
        if (!old) fail('There is no category ' + args.category_id + ' in ' + scope + '. Use list_categories.');
        const r = await ctx.ha.command(Object.assign({ type: 'config/category_registry/update', scope, category_id: old.category_id }, fields));
        const before = { name: old.name, icon: old.icon || null };
        const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'category-' + old.category_id, alias: 'Category ' + old.name + ' (' + scope + ')', action: 'changed', before: { category: before }, after: { category: Object.assign({}, before, fields) },
          revert: [Object.assign({ type: 'config/category_registry/update', scope, category_id: old.category_id }, before)] }) : null;
        return { saved: true, category: r, review: review || undefined };
      }
      if (findCategory(cats, name)) fail('A ' + scope + ' category called "' + name + '" already exists. Give its category_id to change it.');
      const r = await ctx.ha.command(Object.assign({ type: 'config/category_registry/create', scope }, fields));
      const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'category-' + r.category_id, alias: 'Category ' + name + ' (' + scope + ')', action: 'created', before: {}, after: { category: fields },
        revert: [{ type: 'config/category_registry/delete', scope, category_id: r.category_id }] }) : null;
      return { created: true, category: r, review: review || undefined };
    }
  },
  {
    name: 'set_labels', title: 'Add or remove labels', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Adds and/or removes labels (names or ids; create new ones with save_label first) on entities, devices and areas, up to 200 at once. Other labels they carry are left alone. The person can keep or revert it.',
    inputSchema: { type: 'object', properties: {
      entity_ids: { type: 'array', items: { type: 'string' } }, device_ids: { type: 'array', items: { type: 'string' } }, area_ids: { type: 'array', items: { type: 'string' } },
      add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } }
    } },
    async run(args, ctx) {
      const [labels, reg] = await Promise.all([labelReg(ctx), registries(ctx)]);
      const resolve = (list) => (Array.isArray(list) ? list : []).map((q) => { const l = findLabel(labels, q); if (!l) fail('There is no label "' + str(q, 80) + '". Create it with save_label, or check list_labels.'); return l.label_id; });
      const add = resolve(args.add), remove = resolve(args.remove);
      if (!add.length && !remove.length) fail('Say which labels to add or remove');
      const arr = (x) => (Array.isArray(x) ? x.map((v) => str(v, 120)).filter(Boolean) : []);
      const targets = [];
      arr(args.entity_ids).forEach((id) => { const e = reg.ents.get(id); if (!e) fail(id + ' is not in the entity registry (entities without a unique id cannot have labels)'); targets.push({ kind: 'entity', id, cur: e.labels || [] }); });
      arr(args.device_ids).forEach((id) => { const d = reg.devs.get(id); if (!d) fail('There is no device ' + id + '. Use list_devices.'); targets.push({ kind: 'device', id, cur: d.labels || [] }); });
      arr(args.area_ids).forEach((id) => { const a = reg.areas.get(id) || reg.areas.get(findArea(reg, id)); if (!a) fail('There is no area ' + id + '. Use list_areas.'); targets.push({ kind: 'area', id: a.area_id, cur: a.labels || [] }); });
      if (!targets.length) fail('Give entity_ids, device_ids or area_ids');
      if (targets.length > 200) fail('At most 200 at once');
      const msg = (t, lbls) => (t.kind === 'entity' ? { type: 'config/entity_registry/update', entity_id: t.id, labels: lbls } : t.kind === 'device' ? { type: 'config/device_registry/update', device_id: t.id, labels: lbls } : { type: 'config/area_registry/update', area_id: t.id, labels: lbls });
      const before = {}, after = {}, revert = [], changed = [];
      for (const t of targets) {
        const next = [...new Set(t.cur.filter((x) => !remove.includes(x)).concat(add))];
        if (next.length === t.cur.length && next.every((x) => t.cur.includes(x))) continue;
        await ctx.ha.command(msg(t, next));
        const key = t.kind + ' ' + t.id;
        before[key] = labelNames(labels, t.cur); after[key] = labelNames(labels, next);
        revert.push(msg(t, t.cur)); changed.push(t.id);
      }
      forget(ctx);
      if (!changed.length) return { changed: 0, note: 'Nothing to change: they already had those labels' };
      const what = (add.length ? 'add ' + labelNames(labels, add).join(', ') : '') + (add.length && remove.length ? '; ' : '') + (remove.length ? 'remove ' + labelNames(labels, remove).join(', ') : '');
      const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'labels-' + Date.now(), alias: 'Labels on ' + changed.length + (changed.length === 1 ? ' item' : ' items') + ' (' + what + ')', action: 'changed', before: { labels: before }, after: { labels: after }, revert }) : null;
      return { changed: changed.length, items: changed, review: review || undefined };
    }
  },
  {
    name: 'set_category', title: 'Put items in a category', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Puts automations, scripts, scenes or helpers into a category of their scope (name or id; create it with save_category first), or takes them out (category: null). The person can keep or revert it.',
    inputSchema: { type: 'object', required: ['entity_ids', 'scope'], properties: { entity_ids: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: CAT_SCOPES }, category: { type: ['string', 'null'] } } },
    async run(args, ctx) {
      const scope = CAT_SCOPES.includes(args.scope) ? args.scope : fail('scope must be one of ' + CAT_SCOPES.join(', '));
      const [cats, reg] = await Promise.all([categoryReg(ctx, scope), registries(ctx)]);
      let cid = null;
      if (args.category != null && args.category !== '') { const c = findCategory(cats, args.category); if (!c) fail('There is no ' + scope + ' category "' + str(args.category, 80) + '". Create it with save_category.'); cid = c.category_id; }
      const ids = (Array.isArray(args.entity_ids) ? args.entity_ids : []).map((x) => str(x, 120)).filter(Boolean);
      if (!ids.length) fail('Give entity_ids'); if (ids.length > 200) fail('At most 200 at once');
      const nameOf = (id) => (id ? (cats.find((c) => c.category_id === id) || {}).name || id : null);
      const before = {}, after = {}, revert = [], changed = [];
      for (const id of ids) {
        const e = reg.ents.get(id);
        if (!e) fail(id + ' is not in the entity registry');
        if (!scopeFits(scope, id)) fail(id + ' does not belong in the ' + scope + ' scope');
        const cur = (e.categories || {})[scope] || null;
        if (cur === cid) continue;
        await ctx.ha.command({ type: 'config/entity_registry/update', entity_id: id, categories: { [scope]: cid } });
        before[id] = nameOf(cur); after[id] = nameOf(cid);
        revert.push({ type: 'config/entity_registry/update', entity_id: id, categories: { [scope]: cur } }); changed.push(id);
      }
      forget(ctx);
      if (!changed.length) return { changed: 0, note: 'Nothing to change' };
      const review = ctx.onChange ? ctx.onChange({ kind: 'organize', id: 'category-set-' + Date.now(), alias: (cid ? 'Category ' + nameOf(cid) : 'No category') + ' for ' + changed.length + (changed.length === 1 ? ' item' : ' items'), action: 'changed', before: { [scope + '_category']: before }, after: { [scope + '_category']: after }, revert }) : null;
      return { changed: changed.length, items: changed, review: review || undefined };
    }
  },
  {
    name: 'save_dashboard', title: 'Change a dashboard', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Changes a dashboard\'s cards and views (storage-mode dashboards only). Either replace one view: view (path, title or index) and view_config (the whole view: { title, path, icon, type, cards or sections, badges }); view_config without view adds a new view; view_config: null removes the view; position moves or places it. Or replace the whole dashboard with config ({ views: [...] }). Read it with get_dashboard first and change only what was asked. Card actions that run services in blocked domains are refused. The current version is backed up and the person can keep or revert it.',
    inputSchema: { type: 'object', properties: {
      dashboard: { type: 'string', description: 'url_path or title. Leave out for Overview' },
      view: { type: 'string', description: 'The view to replace or remove: its path, title or index' },
      view_config: { type: ['object', 'null'], description: 'The whole new view, or null to remove the view' },
      position: { type: 'integer', minimum: 0, description: 'Where the view goes (0 is first). Default: where it was, or at the end for a new view' },
      config: { type: 'object', description: 'The whole dashboard, instead of view and view_config' }
    } },
    async run(args, ctx) {
      const d = await findDash(ctx, args.dashboard);
      if (d.mode === 'yaml') fail(yamlDash(d));
      const old = await dashConfig(ctx, d.url_path);
      const hasView = args.view != null && args.view !== '';
      let next;
      if (args.config !== undefined) {
        if (hasView || args.view_config !== undefined) fail('Give either config (the whole dashboard) or view and view_config, not both');
        checkDashConfig(args.config);
        next = args.config;
      } else if (args.view_config !== undefined) {
        if (!old) fail(d.title + ' is auto-generated, so it has no views to change yet. Ask the person whether Claude may take control of it, then save a whole config (start from the cards it should show).');
        if (old.strategy) fail(d.title + ' is made by a strategy (' + old.strategy.type + '), not by views. Save a whole config instead.');
        next = clone(old);
        if (!Array.isArray(next.views)) next.views = [];
        const views = next.views, vc = args.view_config;
        if (vc !== null && (typeof vc !== 'object' || Array.isArray(vc))) fail('view_config must be one whole view ({ title, path, type, cards or sections }), or null to remove the view');
        let i = -1;
        if (hasView) {
          i = findView(next, args.view);
          if (i < 0) fail('There is no view "' + str(args.view, 100) + '" on ' + d.title + '. Leave out view to add a new one. Its views: ' + views.map((v, n) => n + ' ' + (v.path || v.title || '(no title)')).join(', '));
        }
        if (vc === null) {
          if (i < 0) fail('Say which view to remove');
          views.splice(i, 1);
        } else {
          if (vc.path != null && views.some((v, n) => n !== i && v.path && String(v.path) === String(vc.path))) fail('Another view on ' + d.title + ' already uses the path "' + vc.path + '"');
          if (i >= 0) views.splice(i, 1);
          const at = args.position != null ? int(args.position, views.length, 0, views.length) : i >= 0 ? i : views.length;
          views.splice(at, 0, vc);
        }
        checkDashConfig(next);
      } else fail('Give view_config (with view to replace one view, without to add one), or config for the whole dashboard');
      const blocked = Guard.checkDashboard(next, ctx.blocked());
      if (blocked) fail('Not saved: ' + blocked + '. HomeClaude blocks this. Showing those entities is fine; a person can add such a button in Home Assistant, or unblock the domain in HomeClaude\'s permissions.');
      const backup = old ? saveDashBackup(ctx, d, old, 'before-change') : null;
      try { await ctx.ha.command({ type: 'lovelace/config/save', url_path: urlArg(d.url_path), config: next }); }
      catch (e) { if (/yaml|not supported/i.test(e.message)) fail(yamlDash(d)); throw e; }
      const review = ctx.onChange ? ctx.onChange({ kind: 'dashboard', id: d.url_path, alias: d.title, action: 'changed', backup, before: old, after: next,
        revert: [old ? { type: 'lovelace/config/save', url_path: urlArg(d.url_path), config: old } : { type: 'lovelace/config/delete', url_path: urlArg(d.url_path) }] }) : null;
      return { saved: true, dashboard: d.url_path, title: d.title, took_control: old ? undefined : true, views: Array.isArray(next.views) ? next.views.map(viewOutline) : undefined, backup, review: review || undefined };
    }
  },
  {
    name: 'create_dashboard', title: 'Create a dashboard or change its settings', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Creates a new dashboard (Settings > Dashboards) with a title, and optionally its url_path (needs a dash, e.g. dashboard-garage; made from the title if left out), icon (mdi:...), show_in_sidebar, require_admin and a first config ({ views: [...] }). Given the url_path of an existing dashboard, changes its title, icon, sidebar and admin settings instead. The person can keep or revert it.',
    inputSchema: { type: 'object', required: ['title'], properties: {
      title: { type: 'string' }, url_path: { type: 'string' }, icon: { type: 'string' },
      show_in_sidebar: { type: 'boolean', default: true }, require_admin: { type: 'boolean', default: false },
      config: { type: 'object', description: 'Optional first config for a new dashboard: { views: [...] }' }
    } },
    async run(args, ctx) {
      const title = str(args.title, 100);
      if (!title) fail('Give the dashboard a title');
      const list = await dashboards(ctx);
      let url = str(args.url_path, 60).toLowerCase().replace(/^\/+/, '');
      if (url === DEFAULT_DASH || url === 'overview') fail('The Overview dashboard\'s title and icon cannot be changed here. Change its cards with save_dashboard.');
      const existing = url ? list.find((x) => x.url_path === url) : null;
      if (existing) {
        if (args.config !== undefined) fail('To change the cards of an existing dashboard, use save_dashboard');
        const before = dashSettings(existing), fields = { title };
        if (args.icon != null && str(args.icon, 100)) fields.icon = str(args.icon, 100);
        if (typeof args.show_in_sidebar === 'boolean') fields.show_in_sidebar = args.show_in_sidebar;
        if (typeof args.require_admin === 'boolean') fields.require_admin = args.require_admin;
        const r = await ctx.ha.command(Object.assign({ type: 'lovelace/dashboards/update', dashboard_id: existing.id }, fields));
        const back = { title: before.title, icon: before.icon, show_in_sidebar: before.show_in_sidebar, require_admin: before.require_admin };
        const review = ctx.onChange ? ctx.onChange({ kind: 'dashboard', id: existing.url_path, alias: 'Settings of ' + existing.title, action: 'changed', before: { dashboard: before }, after: { dashboard: Object.assign({}, before, fields) },
          revert: [Object.assign({ type: 'lovelace/dashboards/update', dashboard_id: existing.id }, noNull(back))] }) : null;
        return { saved: true, dashboard: r || Object.assign({}, before, fields), review: review || undefined };
      }
      if (!url) {
        url = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'dashboard';
        if (!url.includes('-')) url = 'dashboard-' + url;
        for (let n = 2, base = url; list.some((x) => x.url_path === url); n++) url = base + '-' + n;
      }
      if (!DASH_PATH_RE.test(url) || !url.includes('-')) fail('url_path may only use lowercase letters, numbers, dashes and underscores, and needs at least one dash (Home Assistant\'s rule), e.g. dashboard-garage');
      if (args.config !== undefined) {
        checkDashConfig(args.config);
        const blocked = Guard.checkDashboard(args.config, ctx.blocked());
        if (blocked) fail('Not created: ' + blocked + '. HomeClaude blocks this.');
      }
      const settings = { url_path: url, title, icon: args.icon != null ? str(args.icon, 100) || undefined : undefined, show_in_sidebar: args.show_in_sidebar !== false, require_admin: args.require_admin === true };
      const made = await ctx.ha.command(Object.assign({ type: 'lovelace/dashboards/create' }, noNull(settings)));
      if (args.config !== undefined) {
        try { await ctx.ha.command({ type: 'lovelace/config/save', url_path: url, config: args.config }); }
        catch (e) { await ctx.ha.command({ type: 'lovelace/dashboards/delete', dashboard_id: made.id }).catch(() => {}); throw e; }
      }
      const review = ctx.onChange ? ctx.onChange({ kind: 'dashboard', id: url, alias: title, action: 'created', before: {}, after: { dashboard: settings, config: args.config },
        revert: [{ type: 'lovelace/dashboards/delete', dashboard_id: made.id }] }) : null;
      return { created: true, dashboard: made, url: '/' + url, config: args.config ? 'saved' : 'none yet: Home Assistant shows it empty (or auto-generated) until save_dashboard gives it views', review: review || undefined };
    }
  },

  {
    name: 'save_esphome_config', title: 'Change an ESPHome config', needs: 'esphomeEdit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Replaces one ESPHome device\'s YAML (an existing device; new devices are made in the Device Builder). Read it with get_esphome_config first and send the whole file back with only what was asked changed; keep "' + Esp.HIDDEN + '" where it was. The current file is backed up, then the new one is validated: if it is not valid the old file is put back (unless keep_if_invalid) and the errors are returned. It is not compiled or installed: tell the person to install it from the ESPHome Device Builder. Actions in blocked domains are refused. The person can keep or revert it.',
    inputSchema: { type: 'object', required: ['configuration', 'content'], properties: {
      configuration: { type: 'string', description: 'YAML file name, e.g. ro-water.yaml' },
      content: { type: 'string', description: 'The whole new YAML file' },
      keep_if_invalid: { type: 'boolean', default: false, description: 'Keep the new file even if validation fails (for work in progress)' }
    } },
    async run(args, ctx) {
      const f = Esp.checkFile(args.configuration);
      if (typeof args.content !== 'string' || !args.content.trim()) fail('content must be the whole YAML file as text');
      if (args.content.length > 256000) fail('That file is too large (over 256 KB)');
      const e = esp(ctx);
      let current;
      try { current = await e.read(f); }
      catch (x) { if (x.code === 'not_found') fail('There is no ' + f + '. New devices are made in the ESPHome Device Builder; then fill them in here.'); throw x; }
      const was = seen(ctx).get(f);
      if (!was) fail('Read ' + f + ' with get_esphome_config first, then save your changed version of it.');
      if (was !== sha(current)) { seen(ctx).delete(f); fail(f + ' changed since you read it (someone edited it in the Device Builder?). Read it again with get_esphome_config and redo the change on that version.'); }
      const next = Esp.unhide(args.content.replace(/\r\n/g, '\n'), current);
      if (next === current) return { saved: false, note: 'Nothing changed: the file is already like that' };
      const blocked = Esp.blockedActions(next, ctx.blocked());
      if (blocked) fail('Not saved: "' + blocked + '" asks Home Assistant to act on a blocked domain. HomeClaude blocks this. A person can make this change in the Device Builder, or unblock the domain in HomeClaude\'s permissions.');
      const backup = ctx.backups.save('esphome', f, { alias: f, content: current }, 'before-change');
      await e.write(f, next, current);
      let v = null, putBack = false;
      try { v = await e.validate(f, 60); } catch (x) { v = { error: x.message }; }
      if (v && v.valid === false && !args.keep_if_invalid) {
        await e.write(f, current, next);
        seen(ctx).set(f, sha(current));
        putBack = true;
      } else seen(ctx).set(f, sha(next));
      const out = { configuration: f, backup };
      if (putBack) return Object.assign(out, { saved: false, put_back: true, validation: validation(f, v), note: 'The new version did not validate, so the old file was put back. Fix the errors and save again (or save with keep_if_invalid).' });
      const review = ctx.onChange ? ctx.onChange({ kind: 'esphome', id: f, alias: 'ESPHome ' + f, action: 'changed', backup, before: { content: current }, after: { content: next } }) : null;
      return Object.assign(out, { saved: true, validation: v && v.error ? { error: 'Saved, but it could not be validated: ' + v.error } : validation(f, v), review: review || undefined,
        next_step: 'Not installed yet. The person installs it from the ESPHome Device Builder (Install > Wirelessly).' });
    }
  },

  {
    name: 'reload', title: 'Reload YAML', needs: 'edit',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Reloads part of the YAML configuration without a restart: automations, scripts, scenes, templates, groups, core (customize, location) or all (everything that can be reloaded).',
    inputSchema: { type: 'object', required: ['what'], properties: { what: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'templates', 'groups', 'core', 'all'] } } },
    async run(args, ctx) {
      const map = { automations: 'automation/reload', scripts: 'script/reload', scenes: 'scene/reload', templates: 'template/reload', groups: 'group/reload', core: 'homeassistant/reload_core_config', all: 'homeassistant/reload_all' };
      const svc = map[str(args.what, 20)];
      if (!svc) fail('what must be one of ' + Object.keys(map).join(', '));
      await ctx.ha.rest('POST', '/api/services/' + svc, {}, { timeoutMs: 120000 });
      ctx.cache.states = null; ctx.cache.reg = null;
      return { reloaded: args.what };
    }
  },
  {
    name: 'call_service', title: 'Call a service', needs: 'services',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: 'Runs a Home Assistant service (action), for example light.turn_on, script.turn_on, notify.mobile_app_x or input_boolean.toggle. This changes the real home. Name entities explicitly. Services in blocked domains, or aimed at entities in them, are refused.',
    inputSchema: { type: 'object', required: ['domain', 'service'], properties: {
      domain: { type: 'string' }, service: { type: 'string' },
      target: { type: 'object', description: '{ entity_id, device_id, area_id, label_id }' },
      data: { type: 'object' },
      return_response: { type: 'boolean', default: false, description: 'For services that return data, like weather.get_forecasts' }
    } },
    async run(args, ctx) {
      const d = str(args.domain, 60).toLowerCase(), s = str(args.service, 80).toLowerCase();
      if (!/^[a-z0-9_]+$/.test(d) || !/^[a-z0-9_]+$/.test(s)) fail('domain and service should look like light and turn_on');
      if (d === 'homeassistant' && ['restart', 'stop', 'reload_all'].includes(s)) fail('Use restart_home_assistant or reload for that');
      if (d === 'hassio') fail('Supervisor services (hassio.*) are not available through HomeClaude');
      const target = args.target && typeof args.target === 'object' ? args.target : undefined;
      const data = args.data && typeof args.data === 'object' ? args.data : {};
      const why = Guard.checkCall(d, s, { target, data }, ctx.blocked());
      if (why) fail('Refused: ' + why + '.');
      const body = Object.assign({}, data, target || {});
      const r = await ctx.ha.rest('POST', '/api/services/' + d + '/' + s + (args.return_response ? '?return_response' : ''), body, { timeoutMs: 60000 });
      ctx.cache.states = null;
      if (args.return_response) return r;
      return { called: d + '.' + s, changed: onlyChanged(r) };
    }
  },
  {
    name: 'restart_home_assistant', title: 'Restart Home Assistant', needs: 'restart',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Restarts Home Assistant, only after its configuration check passes. Everything in the home is unavailable for a minute or so. Ask the person first, and prefer reload when that is enough.',
    inputSchema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'Why a restart is needed; shown in HomeClaude\'s activity list' } } },
    async run(args, ctx) {
      const check = await ctx.ha.rest('POST', '/api/config/core/check_config', {}, { timeoutMs: 120000 });
      if (!check || check.result !== 'valid') fail('Not restarted: the configuration check failed: ' + fit(check));
      try { await ctx.ha.rest('POST', '/api/services/homeassistant/restart', {}, { timeoutMs: 15000 }); }
      catch (e) { if (e.status) throw e; /* the connection often drops while it restarts */ }
      ctx.ha.reset(); ctx.cache.states = null; ctx.cache.reg = null;
      return { restarting: true, config_check: 'valid', note: 'Home Assistant is restarting. Wait about a minute, then use get_overview.' };
    }
  }
];

function problem(e) {
  if (e.disabled_by) return false;
  return ['setup_error', 'setup_retry', 'migration_error', 'failed_unload', 'not_loaded'].includes(e.state);
}

const INSTRUCTIONS = [
  'HomeClaude connects you to the person\'s Home Assistant for development and troubleshooting, not for everyday control.',
  'Start with get_overview. For "why didn\'t X happen", read get_traces for the automation, then get_logs and get_history.',
  'Read an automation with get_automation before changing it, change only what was asked, and keep its id.',
  'For dashboards, read them with list_dashboards and get_dashboard first, and change one view at a time with save_dashboard (view and view_config) when you can. Ask before taking control of an auto-generated dashboard.',
  'Changes are backed up before they are saved. When change review is on, each change goes live at once and the person is asked in HomeClaude to keep or revert it; the tool result says so, and get_overview lists changes waiting for review and recent reverts. If a change of yours was reverted, do not simply make it again: ask the person what they want instead. Still ask before deleting or restarting.',
  'Some domains are blocked (see get_overview > homeclaude): you can read them but not act on them or write automations that act on them. Do not try to work around this.',
  'Automations without an id and other YAML-only config cannot be changed here; say which file the person needs to edit and what to change.',
  'ESPHome device configs can be read, validated and (when allowed) changed through the ESPHome Device Builder: read with get_esphome_config before save_esphome_config. Compiling and installing firmware is not available here; the person installs from the Device Builder.'
].join(' ');

/**
 * ctx: { ha, backups, esphome, access() -> { edit, services, delete, restart, esphome, esphomeEdit, blocked }, settleMs }
 */
function create(base) {
  const cache = {};
  const ctx = Object.assign({ cache, settleMs: 1500 }, base);
  delete ctx.onChange; // bound per call, with who is asking
  ctx.blocked = () => Guard.cleanDomains(base.access().blocked);
  const describe = (a) => ({ can_edit_automations_scripts_and_dashboards: !!a.edit, can_read_esphome: !!a.esphome, can_edit_esphome: !!a.esphomeEdit, can_call_services: !!a.services, can_delete: !!a.delete, can_restart: !!a.restart, blocked_domains: ctx.blocked() });
  ctx.describeAccess = () => describe(base.access());
  // access can be narrowed per request: a connection from outside may do less than the global settings allow
  const enabled = (t, access) => !t.needs || !!(access || base.access())[t.needs];

  function list(access) { return TOOLS.filter((t) => enabled(t, access)); }

  async function call(name, args, access, who) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) return { isError: true, text: 'Unknown tool ' + name };
    if (!enabled(t, access)) return { isError: true, text: name + ' is not allowed for this connection. The person can change that in HomeClaude.' };
    const c = Object.assign(Object.create(ctx), access ? { describeAccess: () => describe(access) } : {}, base.onChange ? { onChange: (info) => base.onChange(info, who) } : {});
    try {
      const r = await t.run(args || {}, c);
      return { isError: false, text: fit(r == null ? 'Done' : r) };
    } catch (e) {
      return { isError: true, text: e instanceof ToolError ? e.message : (e && e.message) || String(e) };
    }
  }

  return { list, call, all: () => TOOLS, ctx, INSTRUCTIONS };
}

module.exports = { create, INSTRUCTIONS, TOOLS, fit };
