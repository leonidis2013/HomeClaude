/*
 * Helpers (Settings > Devices & services > Helpers), through Home Assistant's own APIs:
 *  - the UI helpers kept in .storage (input_boolean, input_number, input_text, input_select,
 *    input_datetime, input_button, counter, timer, schedule): WebSocket <type>/list, /create,
 *    /update and /delete, the same commands the Helpers page uses
 *  - template sensors and binary sensors: the template integration's config flow (REST
 *    /api/config/config_entries/flow) to make one, its options flow to change one, and
 *    DELETE /api/config/config_entries/entry/<id> to remove one
 * Other helper integrations (utility meter, derivative, group, ...) are listed but not changed.
 * Every change is reviewed like the rest: Revert undoes it with the steps recorded here,
 * which runStep() carries out (a plain WebSocket message, or one of the steps below).
 */
'use strict';

const COLLECTION = ['input_boolean', 'input_number', 'input_text', 'input_select', 'input_datetime', 'input_button', 'counter', 'timer', 'schedule'];
const TEMPLATE_TYPES = { template_sensor: 'sensor', template_binary_sensor: 'binary_sensor' };
// helper integrations that live in config entries (shown by list_helpers, changed in Home Assistant)
const ENTRY_HELPERS = ['template', 'group', 'utility_meter', 'derivative', 'integration', 'min_max', 'threshold', 'tod', 'statistics', 'trend', 'filter', 'switch_as_x', 'random', 'history_stats', 'mold_indicator', 'generic_thermostat', 'generic_hygrostat'];
const FIELDS = {
  input_boolean: 'initial (true/false)',
  input_number: 'min and max (required), step, initial, mode (box or slider), unit_of_measurement, device_class',
  input_text: 'min, max (length), initial, mode (text or password), pattern',
  input_select: 'options (list, required), initial',
  input_datetime: 'has_date, has_time (at least one true), initial',
  input_button: '(only name and icon)',
  counter: 'initial, minimum, maximum, step, restore',
  timer: 'duration ("01:30:00"), restore',
  schedule: 'monday ... sunday: lists of { from: "07:00:00", to: "09:00:00" }',
  template_sensor: 'state (template, required), unit_of_measurement, device_class, state_class, device_id, availability',
  template_binary_sensor: 'state (template, required), device_class, device_id, availability, delay_on, delay_off'
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

// ---------- config-flow forms (as Home Assistant serializes them) ----------
/** The values a form shows: suggested values first, then defaults, nested into its sections. */
function formValues(schema) {
  const out = {};
  (schema || []).forEach((f) => {
    if (f.type === 'expandable') { const v = formValues(f.schema); if (Object.keys(v).length) out[f.name] = v; return; }
    const d = f.description || {};
    if (d.suggested_value !== undefined && d.suggested_value !== null) out[f.name] = d.suggested_value;
    else if (f.default !== undefined) out[f.name] = f.default;
  });
  return out;
}
function formNames(schema, prefix) {
  return (schema || []).flatMap((f) => (f.type === 'expandable' ? formNames(f.schema, f.name + '.') : [(prefix || '') + f.name]));
}
/**
 * Puts flat options into the form's shape: a key that lives in a section goes into that section.
 * null removes a value. Unknown keys are an error, with the ones the form has.
 */
function placeIn(schema, base, opts, fail) {
  const out = clone(base) || {};
  const sections = (schema || []).filter((f) => f.type === 'expandable');
  Object.entries(opts || {}).forEach(([k, v]) => {
    const top = (schema || []).find((f) => f.name === k);
    if (top && top.type === 'expandable') {
      if (!isObj(v)) fail(k + ' is a section; give it as an object');
      out[k] = placeIn(top.schema, out[k] || {}, v, fail);
      return;
    }
    if (top) { if (v === null) delete out[k]; else out[k] = v; return; }
    const sec = sections.find((s) => (s.schema || []).some((f) => f.name === k));
    if (sec) { out[sec.name] = out[sec.name] || {}; if (v === null) delete out[sec.name][k]; else out[sec.name][k] = v; return; }
    fail('"' + k + '" is not a setting of this helper. It has: ' + formNames(schema).join(', '));
  });
  return out;
}
function formErrors(r) {
  const e = (r && r.errors) || {};
  const list = Object.entries(e).map(([k, v]) => (k === 'base' ? v : k + ': ' + v));
  return list.length ? list.join('; ') : 'Home Assistant did not accept it';
}

module.exports = function helpers(h) {
  const { fail, str, registries, states, Guard } = h;
  const forget = (ctx) => { ctx.cache.reg = null; ctx.cache.labels = null; ctx.cache.states = null; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function collection(ctx, d) {
    try { return (await ctx.ha.command({ type: d + '/list' })) || []; }
    catch (e) { return null; } // that integration is not loaded
  }
  const itemFields = (item) => { const o = clone(item); delete o.id; return o; };

  /** Template config flow: start, go to the type's step, fill it, finish. Throws with Home Assistant's errors. */
  async function templateCreate(ha, type, values) {
    let r = await ha.rest('POST', '/api/config/config_entries/flow', { handler: 'template', show_advanced_options: false });
    const id = r.flow_id;
    const abort = () => ha.rest('DELETE', '/api/config/config_entries/flow/' + id).catch(() => {});
    try {
      if (r.type === 'menu') r = await ha.rest('POST', '/api/config/config_entries/flow/' + id, { next_step_id: type });
      if (r.type !== 'form' || r.step_id !== type) throw new Error('the template helper flow did not offer ' + type + ' (it went to ' + (r.step_id || r.type) + ')');
      const data = placeIn(r.data_schema, {}, values, (m) => { throw new Error(m); });
      r = await ha.rest('POST', '/api/config/config_entries/flow/' + id, data);
      if (r.type !== 'create_entry') throw new Error(formErrors(r));
      return r.result || {};
    } catch (e) { await abort(); throw e; }
  }
  /** Template options flow: open it, read what the helper is set to now, and (if given changes) save them. */
  async function templateOptions(ha, entryId, changes) {
    const r = await ha.rest('POST', '/api/config/config_entries/options/flow', { handler: entryId });
    const id = r.flow_id;
    const abort = () => ha.rest('DELETE', '/api/config/config_entries/options/flow/' + id).catch(() => {});
    if (r.type !== 'form') { await abort(); throw new Error('this helper has no settings form (' + r.type + ')'); }
    const now = formValues(r.data_schema);
    if (!changes) { await abort(); return { step: r.step_id, values: now, names: formNames(r.data_schema) }; }
    let data;
    try { data = changes.replace ? placeIn(r.data_schema, {}, changes.values, (m) => { throw new Error(m); }) : placeIn(r.data_schema, now, changes.values, (m) => { throw new Error(m); }); }
    catch (e) { await abort(); throw e; }
    const done = await ha.rest('POST', '/api/config/config_entries/options/flow/' + id, data);
    if (done.type !== 'create_entry') { await abort(); throw new Error(formErrors(done)); }
    return { step: r.step_id, values: data, before: now };
  }

  /** One revert step. Plain WebSocket messages go straight to Home Assistant. */
  async function runStep(ha, m) {
    if (!m || !m.homeclaude) return ha.command(m);
    if (m.homeclaude === 'rest') return ha.rest(m.method, m.path, m.body);
    if (m.homeclaude === 'template_options') return templateOptions(ha, m.entry_id, { values: m.values, replace: true });
    if (m.homeclaude === 'template_create') return templateCreate(ha, m.template_type, m.values);
    throw new Error('unknown revert step ' + m.homeclaude);
  }

  async function entryOf(ctx, entryId) {
    const all = (await ctx.ha.command({ type: 'config_entries/get' })) || [];
    return all.find((e) => e.entry_id === entryId) || null;
  }

  /** entity_id (or a collection helper's id) -> what it is */
  async function findHelper(ctx, q) {
    const w = str(q, 160);
    if (!w) fail('Give the helper\'s entity_id, for example input_number.filter_interval.');
    const reg = await registries(ctx);
    let e = reg.ents.get(w);
    if (!e && /^[a-z_]+\.[a-z0-9_]+$/.test(w)) {
      const [d, oid] = w.split('.');
      if (COLLECTION.includes(d)) e = { entity_id: w, platform: d, unique_id: oid };
    }
    if (!e) fail('There is no helper ' + w + '. Use list_helpers to see them.');
    if (COLLECTION.includes(e.platform) && e.unique_id) {
      const items = await collection(ctx, e.platform);
      const item = (items || []).find((x) => x.id === e.unique_id);
      if (!item) fail(e.entity_id + ' is defined in YAML (configuration.yaml or a package), so it cannot be changed here. Say which file the person needs to edit.');
      return { kind: 'collection', domain: e.platform, id: item.id, item, entity_id: e.entity_id, key: e.platform + '.' + item.id };
    }
    if (e.config_entry_id) {
      const entry = await entryOf(ctx, e.config_entry_id);
      if (entry && entry.domain === 'template') return { kind: 'template', entry, entity_id: e.entity_id, key: 'template-' + entry.entry_id, entityReg: e };
      if (entry && ENTRY_HELPERS.includes(entry.domain)) fail(e.entity_id + ' is a ' + entry.domain + ' helper. HomeClaude changes UI helpers (input_*, counter, timer, schedule) and template sensors; change this one in Home Assistant (Settings > Devices & services > Helpers).');
    }
    fail(e.entity_id + ' is not a helper made in Home Assistant\'s UI, so it cannot be changed here.');
  }

  function checkBlocked(ctx, domain) {
    const blocked = ctx.blocked();
    if (blocked.includes(domain)) fail('Not saved: ' + domain + ' is a blocked domain in HomeClaude. A person can make this helper in Home Assistant, or unblock the domain in HomeClaude\'s permissions.');
  }
  const review = (ctx, info) => (ctx.onChange ? ctx.onChange(Object.assign({ kind: 'helper' }, info)) : null);

  const RO = { readOnlyHint: true, openWorldHint: false };
  const read = [
    {
      name: 'list_helpers', title: 'Helpers', annotations: RO,
      description: 'Helpers from Settings > Devices & services > Helpers: the UI ones (input_boolean, input_number, input_text, input_select, input_datetime, input_button, counter, timer, schedule) with their settings, template sensors, and other helper integrations (utility meter, derivative, group, ...). Give helper (an entity_id) for one helper\'s full settings, including a template sensor\'s template.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words in the name or entity_id' },
        type: { type: 'string', description: 'Only this kind, for example input_number or template' },
        helper: { type: 'string', description: 'One helper\'s entity_id, for its full settings' }
      } },
      async run(args, ctx) {
        if (args.helper) {
          const hp = await findHelper(ctx, args.helper);
          const s = (await states(ctx)).find((x) => x.entity_id === hp.entity_id);
          if (hp.kind === 'collection') return { entity_id: hp.entity_id, type: hp.domain, id: hp.id, state: s ? s.state : null, settings: itemFields(hp.item), editable: true };
          const o = await templateOptions(ctx.ha, hp.entry.entry_id);
          return { entity_id: hp.entity_id, type: 'template_' + o.step, entry_id: hp.entry.entry_id, name: hp.entry.title, state: s ? s.state : null, settings: o.values, icon: hp.entityReg.icon || undefined, editable: true };
        }
        const q = str(args.query, 100).toLowerCase(), only = str(args.type, 40).toLowerCase();
        const fit = (...hay) => !q || q.split(/\s+/).every((w) => hay.join(' ').toLowerCase().includes(w));
        const reg = await registries(ctx), st = await states(ctx);
        const stateOf = (id) => { const s = st.find((x) => x.entity_id === id); return s ? s.state : null; };
        const out = [];
        for (const d of COLLECTION) {
          if (only && only !== d && !(only === 'input' && d.startsWith('input_'))) continue;
          const items = await collection(ctx, d);
          (items || []).forEach((it) => {
            const e = [...reg.ents.values()].find((x) => x.platform === d && x.unique_id === it.id);
            const eid = e ? e.entity_id : d + '.' + it.id;
            if (fit(eid, it.name || '')) out.push({ entity_id: eid, type: d, name: it.name, state: stateOf(eid), settings: itemFields(it), editable: true });
          });
        }
        const entries = ((await ctx.ha.command({ type: 'config_entries/get' })) || []).filter((x) => ENTRY_HELPERS.includes(x.domain) && (!only || only === x.domain || only.startsWith('template') && x.domain === 'template'));
        entries.forEach((en) => {
          const ents = [...reg.ents.values()].filter((x) => x.config_entry_id === en.entry_id).map((x) => x.entity_id);
          if (fit(en.title || '', ents.join(' '))) out.push({ entity_ids: ents, type: en.domain, name: en.title, entry_id: en.entry_id, state: ents.length === 1 ? stateOf(ents[0]) : undefined, editable: en.domain === 'template' && ents.every((x) => /^(binary_)?sensor\./.test(x)) });
        });
        return { total: out.length, helpers: out, note: 'YAML helpers (from configuration.yaml or packages) are not listed here and cannot be changed through the API.' };
      }
    }
  ];

  const write = [
    {
      name: 'save_helper', title: 'Create or change a helper', needs: 'edit',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: 'Creates a helper (Settings > Devices & services > Helpers), or changes one (give helper: its entity_id; only what you give changes). Types and their settings: ' +
        Object.entries(FIELDS).map(([k, v]) => k + ': ' + v).join('; ') +
        '. All take name and icon. The entity_id comes from the name (input_number.<name>), so pick the name with that in mind. Test a template with render_template first. The person can keep or revert it.',
      inputSchema: { type: 'object', properties: {
        type: { type: 'string', enum: COLLECTION.concat(Object.keys(TEMPLATE_TYPES)), description: 'For a new helper' },
        helper: { type: 'string', description: 'entity_id of an existing helper to change' },
        name: { type: 'string' },
        icon: { type: 'string', description: 'mdi:... ' },
        options: { type: 'object', description: 'The type\'s settings, for example { "min": 7, "max": 365, "step": 1, "mode": "box", "unit_of_measurement": "days", "initial": 90 }. null removes a setting' }
      } },
      async run(args, ctx) {
        const opts = isObj(args.options) ? clone(args.options) : args.options == null ? {} : fail('options must be an object');
        ['id', 'type', 'entry_id', 'template_type'].concat(COLLECTION.map((d) => d + '_id')).forEach((k) => { if (k in opts) fail(k + ' cannot be set in options'); });
        const name = args.name == null ? null : str(args.name, 120);
        if (args.name != null && !name) fail('name cannot be empty');
        const icon = args.icon == null ? null : str(args.icon, 100);
        if (icon && !/^[a-z0-9-]+:[a-z0-9-]+$/.test(icon)) fail('icon should look like mdi:water');

        // ----- change an existing one -----
        if (args.helper) {
          const hp = await findHelper(ctx, args.helper);
          if (args.type && hp.kind === 'collection' && args.type !== hp.domain) fail(hp.entity_id + ' is a ' + hp.domain + ' helper; its type cannot be changed. Make a new one instead.');
          if (hp.kind === 'collection') {
            checkBlocked(ctx, hp.domain);
            const before = itemFields(hp.item), fields = Object.assign({}, opts);
            if (name) fields.name = name;
            if (icon) fields.icon = icon;
            Object.keys(fields).forEach((k) => { if (fields[k] === null) fields[k] = undefined; });
            if (!Object.keys(fields).length) fail('Say what to change: name, icon or options');
            const next = Object.assign({}, before, fields);
            Object.keys(next).forEach((k) => { if (next[k] === undefined) delete next[k]; });
            const saved = await ctx.ha.command(Object.assign({ type: hp.domain + '/update', [hp.domain + '_id']: hp.id }, next));
            forget(ctx);
            const rv = review(ctx, { id: hp.key, alias: (next.name || hp.id), action: 'changed', before: { helper: before }, after: { helper: itemFields(saved || next) },
              revert: [Object.assign({ type: hp.domain + '/update', [hp.domain + '_id']: hp.id }, before)] });
            return { saved: true, entity_id: hp.entity_id, type: hp.domain, settings: itemFields(saved || next), review: rv || undefined };
          }
          // template sensor / binary sensor
          checkBlocked(ctx, hp.entity_id.split('.')[0]);
          const en = hp.entry, revert = [];
          let result = null;
          if (Object.keys(opts).length) {
            result = await templateOptions(ctx.ha, en.entry_id, { values: opts }).catch((e) => fail('Not saved: ' + e.message));
            revert.push({ homeclaude: 'template_options', entry_id: en.entry_id, values: result.before });
          }
          if (name && name !== en.title) {
            await ctx.ha.command({ type: 'config_entries/update', entry_id: en.entry_id, title: name });
            revert.push({ type: 'config_entries/update', entry_id: en.entry_id, title: en.title });
          }
          if (icon && icon !== hp.entityReg.icon) {
            await ctx.ha.command({ type: 'config/entity_registry/update', entity_id: hp.entity_id, icon });
            revert.push({ type: 'config/entity_registry/update', entity_id: hp.entity_id, icon: hp.entityReg.icon || null });
          }
          if (!revert.length) fail('Say what to change: name, icon or options');
          forget(ctx);
          const rv = review(ctx, { id: hp.key, alias: (name || en.title), action: 'changed', before: { helper: { name: en.title, settings: result ? result.before : undefined } }, after: { helper: { name: name || en.title, settings: result ? result.values : undefined } }, revert });
          return { saved: true, entity_id: hp.entity_id, entry_id: en.entry_id, settings: result ? result.values : undefined, review: rv || undefined };
        }

        // ----- a new one -----
        const type = str(args.type, 40);
        if (!type) fail('Give type for a new helper, or helper (an entity_id) to change one');
        if (!name) fail('Give the helper a name');
        if (COLLECTION.includes(type)) {
          checkBlocked(ctx, type);
          const fields = Object.assign({}, opts, { name });
          if (icon) fields.icon = icon;
          Object.keys(fields).forEach((k) => { if (fields[k] === null) delete fields[k]; });
          if (type === 'input_number' && (fields.min == null || fields.max == null)) fail('input_number needs min and max');
          if (type === 'input_select' && !(Array.isArray(fields.options) && fields.options.length)) fail('input_select needs options: a list of choices');
          if (type === 'input_datetime' && !fields.has_date && !fields.has_time) fail('input_datetime needs has_date and/or has_time set to true');
          const made = await ctx.ha.command(Object.assign({ type: type + '/create' }, fields));
          forget(ctx);
          await sleep(ctx.settleMs);
          const reg = await registries(ctx);
          const e = [...reg.ents.values()].find((x) => x.platform === type && x.unique_id === made.id);
          const eid = e ? e.entity_id : type + '.' + made.id;
          const rv = review(ctx, { id: type + '.' + made.id, alias: name, action: 'created', before: {}, after: { helper: itemFields(made) },
            revert: [{ type: type + '/delete', [type + '_id']: made.id }] });
          return { created: true, entity_id: eid, type, id: made.id, settings: itemFields(made), review: rv || undefined };
        }
        if (TEMPLATE_TYPES[type]) {
          const t = TEMPLATE_TYPES[type];
          checkBlocked(ctx, t);
          if (!opts.state) fail(type + ' needs options.state: the template, for example "{{ states(\'sensor.x\') | int + 1 }}". Test it with render_template first.');
          let entry;
          try { entry = await templateCreate(ctx.ha, t, Object.assign({ name }, opts)); }
          catch (e) { fail('Not created: ' + e.message); }
          forget(ctx);
          await sleep(ctx.settleMs);
          const reg = await registries(ctx);
          const e = [...reg.ents.values()].find((x) => x.config_entry_id === entry.entry_id);
          const revert = [{ homeclaude: 'rest', method: 'DELETE', path: '/api/config/config_entries/entry/' + encodeURIComponent(entry.entry_id) }];
          if (icon && e) { await ctx.ha.command({ type: 'config/entity_registry/update', entity_id: e.entity_id, icon }).catch(() => {}); forget(ctx); }
          const rv = review(ctx, { id: 'template-' + entry.entry_id, alias: name, action: 'created', before: {}, after: { helper: Object.assign({ type, name }, opts) }, revert });
          const s = e ? (await states(ctx)).find((x) => x.entity_id === e.entity_id) : null;
          return { created: true, entity_id: e ? e.entity_id : null, type, entry_id: entry.entry_id, state: s ? s.state : undefined, review: rv || undefined,
            note: e ? undefined : 'Created, but its entity did not show up yet. Check list_helpers in a moment.' };
        }
        fail('type must be one of ' + COLLECTION.concat(Object.keys(TEMPLATE_TYPES)).join(', '));
      }
    },
    {
      name: 'delete_helper', title: 'Delete a helper', needs: 'delete',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: 'Deletes a UI helper or template sensor (give its entity_id). Automations and dashboards that use it stop working, so check with get_entity (related) first and ask the person. Revert makes it again with the same settings.',
      inputSchema: { type: 'object', required: ['helper'], properties: { helper: { type: 'string', description: 'entity_id' } } },
      async run(args, ctx) {
        const hp = await findHelper(ctx, args.helper);
        if (hp.kind === 'collection') {
          const before = itemFields(hp.item);
          await ctx.ha.command({ type: hp.domain + '/delete', [hp.domain + '_id']: hp.id });
          forget(ctx);
          const rv = review(ctx, { id: hp.key, alias: (before.name || hp.id), action: 'deleted', before: { helper: before }, after: null,
            revert: [Object.assign({ type: hp.domain + '/create' }, before)] });
          return { deleted: true, entity_id: hp.entity_id, review: rv || undefined };
        }
        const o = await templateOptions(ctx.ha, hp.entry.entry_id);
        await ctx.ha.rest('DELETE', '/api/config/config_entries/entry/' + encodeURIComponent(hp.entry.entry_id));
        forget(ctx);
        const rv = review(ctx, { id: hp.key, alias: hp.entry.title, action: 'deleted', before: { helper: Object.assign({ name: hp.entry.title }, o.values) }, after: null,
          revert: [{ homeclaude: 'template_create', template_type: o.step, values: Object.assign({ name: hp.entry.title }, o.values) }] });
        return { deleted: true, entity_id: hp.entity_id, review: rv || undefined };
      }
    }
  ];

  return { read, write, runStep };
};

module.exports.COLLECTION = COLLECTION;
module.exports.formValues = formValues;
module.exports.placeIn = placeIn;
