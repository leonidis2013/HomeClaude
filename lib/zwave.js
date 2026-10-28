/*
 * Z-Wave JS devices: what each one is set to (wake-up interval, configuration parameters,
 * how it is powered, its radio statistics) and changing those settings. Everything goes
 * through Home Assistant's own Z-Wave JS API:
 *  - zwave_js/node_status and zwave_js/get_config_parameters (WebSocket)
 *  - the device's diagnostics (REST), the only place Home Assistant shows the wake-up interval
 *  - zwave_js/set_config_parameter (WebSocket) and the zwave_js.set_value service for wake-up
 * Changes are reviewed like any other: Revert sends the old values back to the device.
 */
'use strict';

const STATUS = { 0: 'unknown', 1: 'asleep', 2: 'awake', 3: 'dead', 4: 'alive' };
const WAKE_UP = 132;

function dur(s) {
  if (s == null || !Number.isFinite(Number(s))) return null;
  s = Number(s);
  if (s === 0) return 'off (only wakes when you press its button)';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [d && d + ' d', h && h + ' h', m && m + ' min', r && r + ' s'].filter(Boolean).join(' ');
}

module.exports = function zwave(h) {
  const { fail, str, int, words, matches, registries, states, areaName, Guard } = h;

  const isZwave = (d) => (d.identifiers || []).some((i) => Array.isArray(i) && i[0] === 'zwave_js');
  const devName = (d) => d.name_by_user || d.name || d.id;

  async function findDevice(ctx, q) {
    const w = str(q, 200);
    if (!w) fail('Give the device: its name, its device id, or one of its entity ids.');
    const reg = await registries(ctx);
    let d = reg.devs.get(w);
    if (!d && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(w)) { const e = reg.ents.get(w); if (e && e.device_id) d = reg.devs.get(e.device_id); }
    if (!d) {
      const l = w.toLowerCase(), all = [...reg.devs.values()].filter(isZwave);
      const exact = all.filter((x) => String(x.name_by_user || '').toLowerCase() === l || String(x.name || '').toLowerCase() === l);
      const near = exact.length ? exact : all.filter((x) => (String(x.name_by_user || '') + ' ' + String(x.name || '')).toLowerCase().includes(l));
      if (near.length > 1) fail('"' + w + '" matches more than one Z-Wave device: ' + near.slice(0, 10).map(devName).join(', ') + '. Use the device id.');
      d = near[0];
    }
    if (!d) fail('There is no Z-Wave device "' + w + '". Use list_zwave_devices to see them.');
    if (!isZwave(d)) fail(devName(d) + ' is not a Z-Wave JS device.');
    return { d, reg };
  }

  async function zwaveEntries(ctx) {
    const c = ctx.cache;
    if (c.zwEntries && Date.now() - c.zwEntries.at < 60000) return c.zwEntries.v;
    const v = new Set(((await ctx.ha.command({ type: 'config_entries/get' })) || []).filter((e) => e.domain === 'zwave_js').map((e) => e.entry_id));
    c.zwEntries = { at: Date.now(), v };
    return v;
  }

  /** The node as Z-Wave JS knows it (values, listening, statistics), from the device's diagnostics. */
  async function nodeState(ctx, d) {
    const ids = await zwaveEntries(ctx);
    const entry = (d.config_entries || []).find((x) => ids.has(x)) || d.primary_config_entry;
    if (!entry) throw new Error('no Z-Wave JS integration entry for this device');
    const r = await ctx.ha.rest('GET', '/api/diagnostics/config_entry/' + encodeURIComponent(entry) + '/device/' + encodeURIComponent(d.id), undefined, { timeoutMs: 30000 });
    const data = r && r.data ? r.data : r;
    if (!data || !data.state) throw new Error('the diagnostics had no node state');
    return data.state;
  }
  const valuesOf = (s) => { const v = s && s.values; return Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []; };
  function wakeUp(s) {
    const v = valuesOf(s).find((x) => x.commandClass === WAKE_UP && x.property === 'wakeUpInterval' && !x.endpoint);
    if (!v) return null;
    const m = v.metadata || {};
    return { interval_s: v.value == null ? null : Number(v.value), readable: dur(v.value), min_s: m.min, max_s: m.max, step_s: m.steps != null ? m.steps : m.step, default_s: m.default };
  }
  function power(s, status) {
    if (s) {
      if (s.isListening) return 'always listening (mains powered)';
      if (s.isFrequentListening) return 'FLiRS: listens every ' + (typeof s.isFrequentListening === 'string' ? s.isFrequentListening : 'second or so') + ' (battery, like a lock), no wake-up interval';
      return 'sleeps between wake-ups (battery)';
    }
    return status === 'asleep' || status === 'awake' ? 'sleeps between wake-ups (battery)' : null;
  }
  function radio(s) {
    const st = s && s.statistics;
    if (!st || typeof st !== 'object') return undefined;
    const pick = ['commandsTX', 'commandsRX', 'commandsDroppedTX', 'commandsDroppedRX', 'timeoutResponse', 'rtt', 'rssi'];
    const out = {};
    pick.forEach((k) => { if (st[k] != null) out[k] = st[k]; });
    if (st.lastSeen || s.lastSeen) out.lastSeen = st.lastSeen || s.lastSeen;
    if (!Object.keys(out).length) return undefined;
    out.note = 'Counts since Z-Wave JS last started';
    return out;
  }
  function params(raw) {
    return Object.entries(raw || {}).map(([key, p]) => {
      const m = p.metadata || {}, options = m.states && Object.keys(m.states).length ? m.states : undefined;
      return {
        parameter: p.property, property_key: p.property_key == null ? undefined : p.property_key, endpoint: p.endpoint || undefined,
        label: m.label, value: p.value, value_label: options ? options[String(p.value)] : undefined,
        default: m.default, min: m.min, max: m.max, unit: m.unit || undefined, options,
        writeable: m.writeable !== false, description: m.description || undefined, key
      };
    }).sort((a, b) => a.parameter - b.parameter || (a.property_key == null ? -1 : a.property_key) - (b.property_key == null ? -1 : b.property_key) || (a.endpoint || 0) - (b.endpoint || 0));
  }
  async function batteryOf(ctx, reg, d) {
    const st = await states(ctx);
    const s = st.find((x) => x.attributes && x.attributes.device_class === 'battery' && x.entity_id.startsWith('sensor.') && (reg.ents.get(x.entity_id) || {}).device_id === d.id);
    return s ? { entity_id: s.entity_id, level: s.state === 'unavailable' || s.state === 'unknown' ? s.state : Number(s.state) } : null;
  }
  async function status(ctx, d) {
    const r = await ctx.ha.command({ type: 'zwave_js/node_status', device_id: d.id });
    return { node_id: r.node_id, status: STATUS[r.status] || String(r.status), ready: r.ready, is_routing: r.is_routing, security: r.highest_security_class == null ? undefined : r.highest_security_class };
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }

  /** Why HomeClaude will not change this device's settings, or null. */
  function blockedDevice(reg, d, blocked) {
    if (blocked.includes('zwave_js')) return 'the zwave_js domain is blocked';
    const doms = [...new Set([...reg.ents.values()].filter((e) => e.device_id === d.id).map((e) => e.entity_id.split('.')[0]))];
    const hit = doms.find((x) => blocked.includes(x));
    return hit ? devName(d) + ' is a ' + hit + ' device and ' + hit + ' is blocked' : null;
  }

  const RO = { readOnlyHint: true, openWorldHint: false };
  const read = [
    {
      name: 'list_zwave_devices', title: 'Z-Wave devices', annotations: RO,
      description: 'Every Z-Wave JS device with its node id, status (alive, asleep, awake, dead), how it is powered (always listening, sleeping on a wake-up interval, or FLiRS like a lock), battery level and wake-up interval. Use it to review battery devices; get_zwave_device shows one device\'s configuration parameters.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Words in the name, maker or model' },
        battery_only: { type: 'boolean', default: false, description: 'Only devices that run on batteries' }
      } },
      async run(args, ctx) {
        const reg = await registries(ctx), ws = words(args.query);
        const devs = [...reg.devs.values()].filter((d) => isZwave(d) && !d.disabled_by && matches(ws, devName(d), d.name || '', d.manufacturer || '', d.model || ''));
        const rows = await pool(devs, 6, async (d) => {
          const o = { id: d.id, name: devName(d), manufacturer: d.manufacturer, model: d.model, firmware: d.sw_version, area: areaName(reg, d.area_id) || undefined };
          try { Object.assign(o, await status(ctx, d)); } catch (e) { o.status_error = e.message; }
          const bat = await batteryOf(ctx, reg, d).catch(() => null);
          if (bat) o.battery = bat.level;
          if (o.node_id === 1 || /controller/i.test(String(d.model || ''))) o.controller = true;
          try { const s = await nodeState(ctx, d); o.power = power(s, o.status); const wu = wakeUp(s); if (wu) o.wake_up = wu.readable + (wu.interval_s ? ' (' + wu.interval_s + ' s)' : ''); }
          catch (e) { o.power = power(null, o.status) || undefined; o.diagnostics_error = e.message; }
          return o;
        });
        const list = rows.filter((o) => !args.battery_only || o.battery != null || /battery/.test(o.power || '')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return { total: list.length, devices: list };
      }
    },
    {
      name: 'get_zwave_device', title: 'Z-Wave device settings', annotations: RO,
      description: 'One Z-Wave JS device in detail: node status, how it is powered, battery, wake-up interval (with the device\'s allowed range and step), radio statistics, and every configuration parameter with its current value, default, range, unit and named options. Give query to show only parameters whose label or description has those words.',
      inputSchema: { type: 'object', required: ['device'], properties: {
        device: { type: 'string', description: 'Device name, device id, or one of its entity ids' },
        query: { type: 'string', description: 'Only parameters matching these words, e.g. "report interval"' }
      } },
      async run(args, ctx) {
        const { d, reg } = await findDevice(ctx, args.device);
        const [st, raw, node, bat] = await Promise.allSettled([status(ctx, d), ctx.ha.command({ type: 'zwave_js/get_config_parameters', device_id: d.id }), nodeState(ctx, d), batteryOf(ctx, reg, d)]);
        const out = { device: { id: d.id, name: devName(d), manufacturer: d.manufacturer, model: d.model, firmware: d.sw_version, area: areaName(reg, d.area_id) || undefined } };
        if (st.status === 'fulfilled') Object.assign(out, st.value); else out.status_error = st.reason.message;
        const s = node.status === 'fulfilled' ? node.value : null;
        out.power = power(s, out.status) || undefined;
        if (bat.status === 'fulfilled' && bat.value) out.battery = bat.value;
        if (s) { out.wake_up = wakeUp(s) || 'none: this device does not use wake-up'; out.radio = radio(s); }
        else out.wake_up_error = 'Could not read the device diagnostics (' + node.reason.message + '), which is where Home Assistant keeps the wake-up interval.';
        if (raw.status === 'fulfilled') {
          const ws = words(args.query);
          const all = params(raw.value);
          out.parameters = all.filter((p) => matches(ws, p.label || '', p.description || '', String(p.parameter))).map((p) => { const c = Object.assign({}, p); delete c.key; return c; });
          if (ws.length) out.parameters_total = all.length;
          if (!all.length) out.parameters_note = 'Z-Wave JS knows no configuration parameters for this device (it may not have any, or its interview is not finished).';
        } else out.parameters_error = raw.reason.message;
        return out;
      }
    }
  ];

  const write = [
    {
      name: 'set_zwave_config', title: 'Change Z-Wave device settings', needs: 'edit',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Changes one Z-Wave JS device\'s configuration parameters and/or its wake-up interval. Read the device with get_zwave_device first and name parameters by number (plus property_key for parameters split into parts). A value can be a number or one of the parameter\'s named options. Everything is checked against the device\'s allowed ranges before anything is sent. Battery devices that are asleep get the change when they next wake up (status "queued"). Devices in blocked domains (locks by default) are refused. The person is asked in HomeClaude to keep or revert; Revert sends the old values back.',
      inputSchema: { type: 'object', required: ['device'], properties: {
        device: { type: 'string', description: 'Device name, device id, or one of its entity ids' },
        parameters: { type: 'array', items: { type: 'object', required: ['parameter', 'value'], properties: {
          parameter: { type: 'integer' }, value: { type: ['integer', 'string'], description: 'Number, or a named option like "Disable"' },
          property_key: { type: 'integer', description: 'Only for parameters split into parts (bitmask)' }, endpoint: { type: 'integer', default: 0 }
        } } },
        wake_up_interval: { type: 'integer', minimum: 0, description: 'Seconds between wake-ups, within the device\'s range and step' }
      } },
      async run(args, ctx) {
        const { d, reg } = await findDevice(ctx, args.device);
        const name = devName(d);
        const why = blockedDevice(reg, d, ctx.blocked());
        if (why) fail('Not changed: ' + why + '. A person can change it in Home Assistant or Z-Wave JS UI, or unblock the domain in HomeClaude\'s permissions.');
        const asked = Array.isArray(args.parameters) ? args.parameters : [];
        const wakeAsked = args.wake_up_interval != null && args.wake_up_interval !== '';
        if (!asked.length && !wakeAsked) fail('Give parameters to change, a wake_up_interval, or both.');
        if (asked.length > 30) fail('At most 30 parameters at a time.');

        // ---- check everything before sending anything ----
        const plan = [], skipped = [];
        if (asked.length) {
          const all = params(await ctx.ha.command({ type: 'zwave_js/get_config_parameters', device_id: d.id }));
          const seen = new Set();
          for (const c of asked) {
            const num = Number(c && c.parameter), pk = c.property_key == null || c.property_key === '' ? null : Number(c.property_key), ep = c.endpoint == null || c.endpoint === '' ? 0 : Number(c.endpoint);
            if (!Number.isInteger(num) || (pk != null && !Number.isInteger(pk)) || !Number.isInteger(ep)) fail('parameter, property_key and endpoint must be whole numbers');
            const tag = 'parameter ' + num + (pk != null ? ' (part ' + pk + ')' : '') + (ep ? ' on endpoint ' + ep : '');
            const hits = all.filter((p) => p.parameter === num && (p.endpoint || 0) === ep);
            if (!hits.length) fail(name + ' has no ' + tag + '. Use get_zwave_device to see its parameters.');
            const p = pk == null ? hits.find((x) => x.property_key == null) : hits.find((x) => x.property_key === pk);
            if (!p) fail(pk == null ? 'Parameter ' + num + ' on ' + name + ' is split into parts; give property_key: ' + hits.map((x) => x.property_key + ' (' + x.label + ')').join(', ') : name + ' has no ' + tag + '.');
            if (seen.has(p.key)) fail(tag + ' is listed twice');
            seen.add(p.key);
            if (!p.writeable) fail(tag + ' (' + p.label + ') is read-only.');
            let v = c.value;
            if (typeof v === 'string' && p.options) { const k = Object.keys(p.options).find((x) => String(p.options[x]).toLowerCase() === v.trim().toLowerCase()); if (k != null) v = Number(k); }
            v = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            if (!Number.isInteger(v)) fail('The value for ' + tag + ' (' + p.label + ') must be a whole number' + (p.options ? ' or one of: ' + Object.entries(p.options).map(([k, l]) => k + ' = ' + l).join(', ') : '') + '.');
            if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) fail(tag + ' (' + p.label + ') takes ' + p.min + ' to ' + p.max + (p.unit ? ' ' + p.unit : '') + ', not ' + v + '.');
            if (p.value == null) fail('The current value of ' + tag + ' (' + p.label + ') is not known yet, so it could not be put back on Revert. Wake the device (or wait for it to report) and try again.');
            if (v === p.value) { skipped.push(tag + ' (' + p.label + ') is already ' + v); continue; }
            plan.push({ p, v, pk, ep, tag, key: 'Parameter ' + num + (pk != null ? ' part ' + pk : '') + (ep ? ' endpoint ' + ep : '') + ': ' + (p.label || '') + (p.unit ? ' (' + p.unit + ')' : '') });
          }
        }
        let wake = null;
        if (wakeAsked) {
          const s = Number(args.wake_up_interval);
          if (!Number.isInteger(s) || s < 0) fail('wake_up_interval is a whole number of seconds');
          let node;
          try { node = await nodeState(ctx, d); }
          catch (e) { fail('Could not read ' + name + '\'s current wake-up interval (' + e.message + '), so it could not be put back on Revert. Change it in Z-Wave JS UI instead.'); }
          const wu = wakeUp(node);
          if (!wu) fail(name + ' does not use wake-up (' + (power(node) || 'it is not a sleeping device') + '), so it has no wake-up interval.');
          if (wu.interval_s == null) fail('Z-Wave JS does not know ' + name + '\'s current wake-up interval yet, so it could not be put back on Revert.');
          const lo = wu.min_s, hi = wu.max_s, step = Number(wu.step_s) || 0;
          if (s === 0 && lo !== 0 && lo != null) fail(name + ' does not allow a wake-up interval of 0 (off); its range is ' + lo + ' to ' + hi + ' s.');
          if (s !== 0 && ((lo != null && s < lo) || (hi != null && s > hi))) fail(name + '\'s wake-up interval must be ' + lo + ' to ' + hi + ' s (' + dur(lo) + ' to ' + dur(hi) + '), not ' + s + '.');
          if (s !== 0 && step > 0 && (s - (lo || 0)) % step !== 0) {
            const down = s - ((s - (lo || 0)) % step), up = down + step;
            fail(name + '\'s wake-up interval goes in steps of ' + step + ' s from ' + (lo || 0) + '; the nearest are ' + down + ' (' + dur(down) + ') and ' + up + ' (' + dur(up) + ').');
          }
          if (s === wu.interval_s) skipped.push('wake-up interval is already ' + s + ' s (' + dur(s) + ')');
          else wake = { from: wu.interval_s, to: s };
        }
        if (!plan.length && !wake) return { device: name, changed: [], unchanged: skipped, note: 'Nothing to change.' };

        // ---- send ----
        const done = [], before = {}, after = {}, revert = [], revertKeys = [];
        let failed = null;
        for (const c of plan) {
          const msg = { type: 'zwave_js/set_config_parameter', device_id: d.id, property: c.p.parameter, value: c.v };
          if (c.pk != null) msg.property_key = c.pk;
          if (c.ep) msg.endpoint = c.ep;
          try {
            const r = await ctx.ha.command(msg, { timeoutMs: 60000 });
            done.push({ parameter: c.p.parameter, property_key: c.pk == null ? undefined : c.pk, label: c.p.label, from: c.p.value, to: c.v, status: r && r.status != null ? r.status : 'sent' });
            before[c.key] = c.p.value; after[c.key] = c.v;
            revert.push(Object.assign({}, msg, { value: c.p.value })); revertKeys.push(c.key);
          } catch (e) { failed = { what: c.tag, error: e.message }; break; }
        }
        if (wake && !failed) {
          const set = (value) => ({ type: 'call_service', domain: 'zwave_js', service: 'set_value', service_data: { device_id: d.id, command_class: WAKE_UP, property: 'wakeUpInterval', value } });
          try {
            await ctx.ha.command(set(wake.to), { timeoutMs: 60000 });
            done.push({ wake_up_interval: true, from: wake.from, to: wake.to, readable: dur(wake.from) + ' -> ' + dur(wake.to) });
            const k = 'Wake-up interval (s)';
            before[k] = wake.from; after[k] = wake.to; revert.push(set(wake.from)); revertKeys.push(k);
          } catch (e) { failed = { what: 'wake-up interval', error: e.message }; }
        }
        ctx.cache.states = null;
        const review = done.length && ctx.onChange ? ctx.onChange({ kind: 'zwave', id: d.id, alias: name, action: 'changed', before, after, revert, revertKeys, merge: true }) : null;
        const out = { device: name, changed: done };
        if (skipped.length) out.unchanged = skipped;
        if (failed) out.failed = failed.what + ': ' + failed.error + (done.length ? '. The changes listed above were made; nothing after this was sent.' : '. Nothing was changed.');
        if (done.some((x) => x.status === 'queued') || (wake && done.some((x) => x.wake_up_interval))) out.note = 'A sleeping device gets queued changes the next time it wakes up (at its current interval, or right away if someone presses its button). get_zwave_device shows the new values once it has.';
        if (review) out.review = review;
        return out;
      }
    }
  ];

  return { read, write, dur };
};
