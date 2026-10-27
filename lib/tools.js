/*
 * The tools Claude sees. Read tools are always on; write tools only show up when they
 * are switched on in HomeClaude's permissions, and every one of them goes through the
 * blocked-domain rules in guard.js. Automations and scripts are backed up before they
 * are changed or deleted.
 */
'use strict';
const Guard = require('./guard.js');

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
      state: { type: 'string', description: 'Only entities in this state, for example unavailable' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 60 }
    } },
    async run(args, ctx) {
      const ws = words(args.query), dom = str(args.domain, 40).toLowerCase(), want = str(args.state, 60), limit = int(args.limit, 60, 1, 500);
      const all = await states(ctx);
      const reg = args.area ? await registries(ctx) : null;
      const aid = reg ? findArea(reg, args.area) : null;
      let hits = all.filter((s) => (!dom || s.entity_id.startsWith(dom + '.')) && (!want || s.state === want) && matches(ws, s.entity_id, (s.attributes || {}).friendly_name || ''));
      if (reg) hits = hits.filter((s) => areaOf(reg, s.entity_id) === aid);
      const r = reg || await registries(ctx);
      return {
        total: hits.length, shown: Math.min(limit, hits.length),
        entities: hits.slice(0, limit).map((s) => {
          const a = s.attributes || {};
          return { entity_id: s.entity_id, name: a.friendly_name, state: s.state, unit: a.unit_of_measurement, area: areaName(r, areaOf(r, s.entity_id)), last_changed: s.last_changed };
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
      return { total: list.length, automations: list.map((s) => { const a = s.attributes || {}; return { entity_id: s.entity_id, name: a.friendly_name, id: a.id || null, editable: !!a.id, state: s.state, last_triggered: a.last_triggered || null, mode: a.mode, running: a.current || 0 }; }).sort((x, y) => String(x.name).localeCompare(String(y.name))) };
    }
  },
  {
    name: 'list_scripts', title: 'List scripts', annotations: RO,
    description: 'All scripts with their id, whether running, when they last ran and their mode.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async run(args, ctx) {
      const ws = words(args.query);
      const list = (await states(ctx)).filter((s) => s.entity_id.startsWith('script.') && matches(ws, s.entity_id, (s.attributes || {}).friendly_name || ''));
      return { total: list.length, scripts: list.map((s) => { const a = s.attributes || {}; return { entity_id: s.entity_id, name: a.friendly_name, id: s.entity_id.slice(7), state: s.state, last_triggered: a.last_triggered || null, mode: a.mode }; }).sort((x, y) => String(x.name).localeCompare(String(y.name))) };
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
      return { saved: true, created, id, entity_id: s ? s.entity_id : null, state: s ? s.state : null, backup, note: s ? undefined : 'Saved, but the automation did not show up yet. Check get_logs for a config error.' };
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
      return { saved: true, created: !old, id: ref.id, entity_id: ref.entity_id, backup };
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
      return { deleted: true, id: ref.id, entity_id: ref.entity_id, backup };
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
      return { deleted: true, id: ref.id, entity_id: ref.entity_id, backup };
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
  'Changes are backed up before they are saved, and the person can restore them in HomeClaude. Still ask before deleting or restarting.',
  'Some domains are blocked (see get_overview > homeclaude): you can read them but not act on them or write automations that act on them. Do not try to work around this.',
  'Automations without an id and other YAML-only config cannot be changed here; say which file the person needs to edit and what to change.'
].join(' ');

/**
 * ctx: { ha, backups, access() -> { edit, services, delete, restart, blocked }, settleMs }
 */
function create(base) {
  const cache = {};
  const ctx = Object.assign({ cache, settleMs: 1500 }, base);
  ctx.blocked = () => Guard.cleanDomains(base.access().blocked);
  const describe = (a) => ({ can_edit_automations_and_scripts: !!a.edit, can_call_services: !!a.services, can_delete: !!a.delete, can_restart: !!a.restart, blocked_domains: ctx.blocked() });
  ctx.describeAccess = () => describe(base.access());
  // access can be narrowed per request: a connection from outside may do less than the global settings allow
  const enabled = (t, access) => !t.needs || !!(access || base.access())[t.needs];

  function list(access) { return TOOLS.filter((t) => enabled(t, access)); }

  async function call(name, args, access) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) return { isError: true, text: 'Unknown tool ' + name };
    if (!enabled(t, access)) return { isError: true, text: name + ' is not allowed for this connection. The person can change that in HomeClaude.' };
    const c = access ? Object.assign(Object.create(ctx), { describeAccess: () => describe(access) }) : ctx;
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
