/*
 * The safety rules between Claude and Home Assistant. They are checked here in
 * HomeClaude before anything is sent, so they hold whatever Claude asks for.
 *
 * Blocked domains (lock, alarm_control_panel and cover by default):
 *  - no service calls in those domains (lock.unlock, cover.open_cover, ...)
 *  - no service calls aimed at their entities (homeassistant.turn_on on cover.garage_door)
 *  - no automations or scripts saved with actions that do either, or device actions for them
 *  - no dashboard buttons whose tap, hold or double-tap runs such a service
 *  - no scenes that set an entity in those domains
 * Reading their state, history and traces is still allowed, and so is showing them on a dashboard.
 */
'use strict';

const DEFAULT_BLOCKED = ['lock', 'alarm_control_panel', 'cover'];
const DOMAIN_RE = /^[a-z0-9_]{1,40}$/;
const GENERIC = new Set(['turn_on', 'turn_off', 'toggle']);
const WIDE_TARGETS = ['area_id', 'device_id', 'label_id', 'floor_id'];

function cleanDomains(list) {
  const arr = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\s,]+/);
  return [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter((s) => DOMAIN_RE.test(s)))].slice(0, 40);
}

function entityIds(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(entityIds);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
const domainOf = (id) => String(id).split('.')[0].toLowerCase();

/**
 * Checks one service call. Returns null when it is allowed, otherwise the reason.
 * call: { target, data, entity_id } as they appear in a call or an automation action.
 */
function checkCall(domain, service, call, blocked) {
  domain = String(domain || '').toLowerCase(); service = String(service || '').toLowerCase();
  call = call || {};
  if (blocked.includes(domain)) return domain + '.' + service + ' is in a blocked domain (' + domain + ')';
  const target = call.target && typeof call.target === 'object' ? call.target : {};
  const data = call.data && typeof call.data === 'object' ? call.data : {};
  const ids = [...entityIds(target.entity_id), ...entityIds(data.entity_id), ...entityIds(call.entity_id)];
  for (const id of ids) {
    if (id.includes('{{') || id.includes('{%')) { if (blocked.length) return domain + '.' + service + ' targets a template, which could reach a blocked domain'; continue; }
    if (blocked.includes(domainOf(id))) return domain + '.' + service + ' targets ' + id + ', which is in a blocked domain';
    if (id.toLowerCase() === 'all' && domain === 'homeassistant' && blocked.length) return domain + '.' + service + ' with entity_id: all could reach a blocked domain';
  }
  if (domain === 'homeassistant' && GENERIC.has(service) && blocked.length) {
    const wide = WIDE_TARGETS.find((k) => target[k] != null || data[k] != null || call[k] != null);
    if (wide) return domain + '.' + service + ' by ' + wide + ' could reach a blocked domain. Name the entities instead';
    if (!ids.length) return domain + '.' + service + ' without entity ids could reach a blocked domain';
  }
  return null;
}

/**
 * Looks through an automation or script config for actions HomeClaude would not run itself.
 * Returns null when it is fine, otherwise the reason.
 */
function checkConfig(config, blocked) {
  if (!blocked.length) return null;
  let hit = null;
  (function walk(v, depth) {
    if (hit || depth > 80 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    const svc = typeof v.action === 'string' ? v.action : typeof v.service === 'string' ? v.service : null;
    if (svc != null) {
      if (svc.includes('{{') || svc.includes('{%')) { hit = 'an action uses a template for its service name, which could reach a blocked domain'; return; }
      const [d, s] = svc.split('.');
      const r = checkCall(d, s, v, blocked);
      if (r) { hit = r; return; }
    }
    // device actions: { device_id, domain: lock, type: unlock } (device conditions and triggers only read)
    if (typeof v.domain === 'string' && v.device_id && v.type && v.condition == null && v.platform == null && v.trigger == null && blocked.includes(v.domain.toLowerCase())) {
      hit = 'a device action for ' + v.domain + ' (' + v.type + ') is in a blocked domain'; return;
    }
    Object.keys(v).forEach((k) => walk(v[k], depth + 1));
  })(config, 0);
  return hit;
}

/**
 * Looks through a dashboard config for card actions (tap_action, hold_action, ...) that
 * would run a service HomeClaude would not run itself. Cards that only show or open
 * a blocked entity are fine: the person still decides what to press.
 */
const UI_SERVICE = ['call-service', 'perform-action'];
function checkDashboard(config, blocked) {
  if (!blocked.length) return null;
  let hit = null;
  (function walk(v, depth) {
    if (hit || depth > 120 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    if (UI_SERVICE.includes(v.action)) {
      const svc = String(v.perform_action || v.service || '');
      if (svc.includes('{{') || svc.includes('{%')) { hit = 'a card action uses a template for its service name, which could reach a blocked domain'; return; }
      const [d, s] = svc.split('.');
      const r = checkCall(d, s, { target: v.target, data: v.data || v.service_data }, blocked);
      if (r) { hit = 'a card action runs ' + r.replace(/^[^ ]+ /, svc + ' '); return; }
    }
    Object.keys(v).forEach((k) => walk(v[k], depth + 1));
  })(config, 0);
  return hit;
}

/**
 * A scene sets every entity it lists when it is turned on, so a scene with a lock or a
 * cover in it would act on a blocked domain. Returns null when it is fine.
 */
function checkScene(config, blocked) {
  if (!blocked.length) return null;
  const ents = config && config.entities && typeof config.entities === 'object' ? Object.keys(config.entities) : [];
  const bad = ents.find((id) => blocked.includes(domainOf(id)));
  return bad ? 'the scene sets ' + bad + ', which is in a blocked domain' : null;
}

module.exports = { DEFAULT_BLOCKED, cleanDomains, checkCall, checkConfig, checkDashboard, checkScene };
