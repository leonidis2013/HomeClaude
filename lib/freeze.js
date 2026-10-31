/*
 * Service-time freeze: weekly windows (for example Sunday 07:00-13:00 and Wednesday 18:00-21:00)
 * during which Claude may only look at a site's Home Assistant, whatever level it was given.
 * Times are wall-clock times in the site's time zone. A window whose end is not after its
 * start runs past midnight into the next day (22:00-02:00), and 00:00 as the end means midnight.
 */
'use strict';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function defaultTz() {
  if (process.env.TZ) { try { new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ }); return process.env.TZ; } catch (e) { /* bad TZ */ } }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}
function tzOk(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
const effectiveTz = (f) => (f && tzOk(f.tz) ? f.tz : defaultTz());
const toMin = (s) => { const m = HHMM.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmt = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/** Day of the week (0 = Sunday) and minute of the day at `now` in time zone `tz`. */
function localParts(now, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).forEach((x) => { p[x.type] = x.value; });
  return { day: DAY_NAMES.indexOf(p.weekday), min: Number(p.hour) * 60 + Number(p.minute), sec: Number(p.second) };
}

/** Checks and tidies what the page sends. Returns { freeze } or { error }. */
function clean(input, old) {
  const f = Object.assign({ enabled: false, tz: '', windows: [] }, old || {}, input || {});
  const out = { enabled: !!f.enabled, tz: String(f.tz || '').trim().slice(0, 64), windows: [] };
  if (out.tz && !tzOk(out.tz)) return { error: 'Unknown time zone ' + out.tz + ' (use a name like America/Chicago)' };
  if (!Array.isArray(f.windows)) return { error: 'The service times are not a list' };
  if (f.windows.length > 20) return { error: 'At most 20 service times' };
  for (const w of f.windows) {
    const days = [...new Set((Array.isArray(w && w.days) ? w.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    const from = toMin(w && w.from), to = toMin(w && w.to);
    if (!days.length) return { error: 'Choose at least one day for each service time' };
    if (from == null || to == null) return { error: 'Times look like 07:30 (24-hour clock)' };
    if (from === to) return { error: 'A service time needs different start and end times' };
    out.windows.push({ days, from: fmt(from), to: fmt(to), label: String((w && w.label) || '').trim().slice(0, 40) });
  }
  if (out.enabled && !out.windows.length) return { error: 'Add at least one service time, or switch the freeze off' };
  return { freeze: out };
}

/**
 * Is a freeze on at `now`? Returns null, or { until (ms), label, window } for the window that
 * ends last among those active (back-to-back windows count as one).
 */
function active(f, now) {
  if (!f || !f.enabled || !Array.isArray(f.windows) || !f.windows.length) return null;
  now = now == null ? Date.now() : now;
  const tz = effectiveTz(f);
  const at = (t) => { const p = localParts(t, tz); return p; };
  const hit = (p) => {
    let best = null;
    for (const w of f.windows) {
      const from = toMin(w.from), to = toMin(w.to);
      if (from == null || to == null) continue;
      const over = to <= from; // runs past midnight
      for (const d of w.days) {
        let left = null;
        if (p.day === d && p.min >= from && (over || p.min < to)) left = (over ? to + 1440 : to) - p.min;
        else if (over && p.day === (d + 1) % 7 && p.min < to) left = to - p.min;
        if (left != null && (!best || left > best.left)) best = { left, w };
      }
    }
    return best;
  };
  const p = at(now);
  let b = hit(p);
  if (!b) return null;
  let until = now + b.left * 60e3 - p.sec * 1000;
  const first = b.w;
  // windows that start right where this one ends keep it frozen
  for (let i = 0; i < 14; i++) {
    const q = at(until), nb = hit(q);
    if (!nb) break;
    const next = until + nb.left * 60e3 - q.sec * 1000;
    if (next <= until) break;
    until = next; b = nb;
  }
  return { until, label: first.label || '', window: first.from + '-' + first.to };
}

/** "Sun 07:00-13:00, Wed 18:00-21:00" */
function describe(f) {
  if (!f || !f.windows || !f.windows.length) return '';
  return f.windows.map((w) => (w.label ? w.label + ': ' : '') + w.days.map((d) => DAY_NAMES[d]).join('/') + ' ' + w.from + '-' + w.to).join(', ');
}

/** "13:00" or "Sun 13:00" in the site's time zone */
function untilText(until, f, now) {
  const tz = effectiveTz(f), p = localParts(until, tz), n = localParts(now == null ? Date.now() : now, tz);
  return (p.day === n.day && until - (now || Date.now()) < 86400e3 ? '' : DAY_NAMES[p.day] + ' ') + fmt(p.min) + ' (' + tz + ')';
}

module.exports = { clean, active, describe, untilText, effectiveTz, defaultTz, tzOk, localParts, DAY_NAMES };
