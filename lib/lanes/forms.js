'use strict';

// Founder forms: accelerator-defined extra data, stored as the platform's custom objects
// (DynamicModelType = the form, DynamicModel = one startup's answers).
//
// Each accelerator designs its own forms in the platform's admin UI (Administration → Custom
// Objects): sections, fields, types, options, required, read-only and hidden fields. Because the
// types live in the accelerator's own workspace, every accelerator can ask different questions and
// this app simply renders whatever it finds.
//
//   GET  /lp/acc/forms                 admin: the workspace's types, which are shown to founders, key state
//   POST /lp/acc/forms/setup           admin: create the forms key (role lp_forms_writer, below)
//   POST /lp/acc/forms/config          admin: show/hide a type for founders; one per startup or many
//   GET  /lp/acc/forms/:iid/responses  admin: every startup's answers (read with the admin's session)
//   POST /lp/acc/forms/records/:id     admin: set the staff fields of one record (read-only / hidden)
//   GET  /lp/founders/forms            founder: the forms, as the founder may see them, + their startup's answers
//   POST /lp/founders/forms/:iid       founder: save their startup's answers (validated here, then written)
//
// Ownership: each record is linked to the startup TEAM that owns it with the platform's own
// relationship, a DynamicModelPartyRole (party = the team, role type = the built-in `owner`). Staff
// see in the platform which startup a record belongs to, and agents or reports can query by party.
//
// Why founders go through this server instead of the API pipe: DynamicModel rows have no owner
// column, so a scoped founder role cannot express "my startup's rows", and the platform checks only
// that a linked record is in the same workspace — not that the caller can see it — so letting
// founders create party roles would let one startup attach itself to another's records. The
// founder role therefore carries NO custom-object permission. This server holds a separate API key
// (role lp_forms_writer) and only ever reads or writes records owned by the founder's verified team
// — the team comes from the server-side session, never from the browser.

const fs = require('fs');
const path = require('path');
const { HttpError, sendJson, readJson, posInt } = require('../http');
const { messageOf } = require('../pm');

const FORMS_ROLE = 'lp_forms_writer';
const OWNER_ROLE = 'owner';
const TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPES_CACHE_MS = 60 * 1000;
// A team's records are cached and dropped whenever this server changes them (founder save, staff
// save, form settings); the TTL only bounds staleness for edits made outside this app.
const TEAM_DATA_CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;
const MAX_TEXT = 5000;
const roleExport = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'setup', 'lp-forms.role.export.json'), 'utf8'));

const whereQuery = (where) => JSON.stringify({ where });

// What a founder may see and edit, from the admin's own definition flags.
const founderVisible = (f) => f && f.key && f.visible !== false && !(Array.isArray(f.security_roles) && f.security_roles.length);
const founderEditable = (f) => founderVisible(f) && !f.read_only && f.type !== 'json';
// Staff set exactly the fields founders cannot: read-only, hidden or role-gated ones.
const staffEditable = (f) => f && f.key && f.type !== 'json' && !founderEditable(f);

function publicDefinition(type, { forFounder }) {
  const defs = (type.field_definitions && type.field_definitions.fields) || [];
  const fields = defs.filter((f) => (forFounder ? founderVisible(f) : f && f.key))
    .map((f) => ({
      key: f.key, label: f.label || f.key, type: f.type, description: f.description || '', placeholder: f.placeholder || '',
      section: f.section || '', display_order: Number(f.display_order) || 0,
      required: !!(f.validation && f.validation.required), read_only: forFounder ? !founderEditable(f) : !!f.read_only,
      hidden_from_founders: !founderVisible(f),
      options: Array.isArray(f.options) ? f.options.map((o) => (o && typeof o === 'object' ? { value: String(o.value), label: String(o.label || o.value) } : { value: String(o), label: String(o) })) : undefined,
      validation: f.validation ? { min: f.validation.min, max: f.validation.max, max_length: f.validation.max_length } : undefined,
    }));
  const sections = ((type.field_definitions && type.field_definitions.sections) || [])
    .map((s) => ({ key: s.key, label: s.label || s.key, description: s.description || '', display_order: Number(s.display_order) || 0 }))
    .sort((a, b) => a.display_order - b.display_order);
  // Section order first, then the field's own order within its section (unsectioned fields last).
  const rank = (f) => { const i = sections.findIndex((x) => x.key === f.section); return i < 0 ? sections.length : i; };
  fields.sort((a, b) => rank(a) - rank(b) || a.display_order - b.display_order);
  return { iid: type.internal_identifier, name: type.description || type.internal_identifier, sections, fields };
}

// Validate and coerce one submission against the definition. Only the fields `editable` allows are
// accepted (founders by default; staff pass staffEditable); anything else in the body is ignored.
// Returns { values, errors }.
function validateSubmission(type, body, { partial, editable = founderEditable }) {
  const defs = ((type.field_definitions && type.field_definitions.fields) || []).filter(editable);
  const values = {}; const errors = {};
  for (const f of defs) {
    const has = Object.prototype.hasOwnProperty.call(body, f.key);
    let v = has ? body[f.key] : undefined;
    const v8n = f.validation || {};
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (v8n.required && (!partial || has)) errors[f.key] = 'Required';
      else if (has) values[f.key] = null;
      continue;
    }
    const optionValues = Array.isArray(f.options) ? f.options.map((o) => String(o && typeof o === 'object' ? o.value : o)) : [];
    switch (f.type) {
      case 'number': case 'integer': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
        if (!Number.isFinite(n)) { errors[f.key] = 'Enter a number'; break; }
        if (f.type === 'integer' && !Number.isInteger(n)) { errors[f.key] = 'Enter a whole number'; break; }
        if (v8n.min != null && n < Number(v8n.min)) { errors[f.key] = `At least ${v8n.min}`; break; }
        if (v8n.max != null && n > Number(v8n.max)) { errors[f.key] = `At most ${v8n.max}`; break; }
        values[f.key] = n; break;
      }
      case 'boolean':
        values[f.key] = v === true || v === 'true' || v === 'on' || v === 1; break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) { errors[f.key] = 'Enter a date'; break; }
        values[f.key] = String(v); break;
      case 'datetime':
        if (Number.isNaN(Date.parse(v))) { errors[f.key] = 'Enter a date and time'; break; }
        values[f.key] = new Date(v).toISOString(); break;
      case 'select':
        if (!optionValues.includes(String(v))) { errors[f.key] = 'Choose one of the options'; break; }
        values[f.key] = String(v); break;
      case 'multi_select': {
        const list = (Array.isArray(v) ? v : [v]).map(String);
        if (list.some((x) => !optionValues.includes(x))) { errors[f.key] = 'Choose from the options'; break; }
        values[f.key] = [...new Set(list)]; break;
      }
      case 'url':
        if (!/^https?:\/\/[^\s]+$/i.test(String(v))) { errors[f.key] = 'Enter a web address starting with https://'; break; }
        values[f.key] = String(v).slice(0, 500); break;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) { errors[f.key] = 'Enter an email address'; break; }
        values[f.key] = String(v).slice(0, 254); break;
      default: {
        const text = String(v).slice(0, MAX_TEXT);
        if (v8n.max_length && text.length > Number(v8n.max_length)) { errors[f.key] = `At most ${v8n.max_length} characters`; break; }
        if (v8n.min_length && text.length < Number(v8n.min_length)) { errors[f.key] = `At least ${v8n.min_length} characters`; break; }
        values[f.key] = text;
      }
    }
  }
  return { values, errors };
}

// A field value as a person would read it (option labels, Yes/No), or '' when empty.
function displayText(f, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  const label = (x) => { const o = (f.options || []).find((o2) => o2.value === String(x)); return o ? o.label : String(x); };
  if (f.type === 'boolean') return v ? 'Yes' : 'No';
  if (f.type === 'select') return label(v);
  if (f.type === 'multi_select') return [].concat(v).map(label).join(', ');
  return String(v).replace(/\s+/g, ' ').slice(0, 1500);
}

// A founder only ever gets back the fields they may see.
function founderValues(type, cf) {
  const out = {};
  for (const f of ((type.field_definitions && type.field_definitions.fields) || []).filter(founderVisible)) {
    if (cf && Object.prototype.hasOwnProperty.call(cf, f.key)) out[f.key] = cf[f.key];
  }
  return out;
}

function createFormsLanes({ pm, sessions, secrets, store, founders }) {
  const typeCache = new Map(); // workspace -> { at, types }
  const ownerRoleCache = new Map(); // workspace -> role type id of `owner`
  const teamCache = new Map(); // `${workspace}:${teamId}` -> { at, byType: Map<iid, rows>, brief }
  const keyLocks = new Map();
  const call = (s, p, o) => sessions.callAs(s, p, o);
  const formsConfig = (ws) => (store.state.founderForms || {})[ws] || {};
  const listOf = (body, key) => (body && (body[key] || body.data)) || [];

  function requireAdmin(req) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    if (s.role !== 'accelerator_admin') throw new HttpError(403, 'Accelerator administrators only');
    const acc = store.acceleratorByIdentifier(s.workspace);
    if (!acc || acc.departed_at) throw new HttpError(403, 'This workspace is no longer part of the network');
    return s;
  }

  // Calls made with the forms key (server-side only).
  function asKey(workspace, p, o = {}) {
    const key = secrets.get(workspace, 'forms_key');
    if (!key) throw new HttpError(409, 'Founder forms are not set up yet — ask your accelerator');
    return pm.call(p, { ...o, workspace, apiKey: key });
  }

  // ---- caches ----

  const teamKey = (workspace, teamId) => `${workspace}:${teamId}`;
  const forgetTeam = (workspace, teamId) => teamCache.delete(teamKey(workspace, teamId));
  function forgetWorkspace(workspace) {
    typeCache.delete(workspace);
    for (const k of teamCache.keys()) if (k.startsWith(`${workspace}:`)) teamCache.delete(k);
  }

  // Form definitions, cached. A failure is cached briefly too, so a broken forms key (revoked,
  // replaced elsewhere) costs one platform call per FAILURE_CACHE_MS, not one per request.
  async function typesFor(workspace) {
    const hit = typeCache.get(workspace);
    if (hit && hit.error && Date.now() - hit.at < FAILURE_CACHE_MS) throw hit.error;
    if (hit && !hit.error && Date.now() - hit.at < TYPES_CACHE_MS) return hit.types;
    const r = await asKey(workspace, '/dynamic_model_types', { query: { limit: 200 } });
    if (!r.ok) {
      const error = new HttpError(502, messageOf(r, 'Could not read the forms'));
      typeCache.set(workspace, { at: Date.now(), error });
      throw error;
    }
    const types = listOf(r.body, 'dynamic_model_types');
    typeCache.set(workspace, { at: Date.now(), types });
    return types;
  }

  async function ownerRoleTypeId(workspace, reader = (p, o) => asKey(workspace, p, o)) {
    if (ownerRoleCache.has(workspace)) return ownerRoleCache.get(workspace);
    const r = await reader('/role_types', { query: { limit: 5, search_query: whereQuery({ internal_identifier: OWNER_ROLE }) } });
    const id = r.ok && (listOf(r.body, 'role_types')[0] || {}).id;
    if (!id) throw new HttpError(502, `This workspace has no built-in “${OWNER_ROLE}” role type`);
    ownerRoleCache.set(workspace, id);
    return id;
  }

  // Every record one team owns, grouped by form, newest first. Two calls however many forms
  // there are — the team's `owner` links, then those records — and cached until something changes.
  async function teamEntry(workspace, teamId) {
    const k = teamKey(workspace, teamId);
    const hit = teamCache.get(k);
    if (hit && Date.now() - hit.at < TEAM_DATA_CACHE_MS) return hit;
    const owner = await ownerRoleTypeId(workspace);
    const links = await asKey(workspace, '/dynamic_model_party_roles', { query: { limit: 1000, search_query: whereQuery({ party_id: teamId, role_type_id: owner }) } });
    if (!links.ok) throw new HttpError(502, messageOf(links, 'Could not read your answers'));
    const ids = listOf(links.body, 'dynamic_model_party_roles')
      .filter((l) => String(l.party_id) === String(teamId) && String(l.role_type_id) === String(owner)).map((l) => l.dynamic_model_id);
    const byType = new Map();
    if (ids.length) {
      const r = await asKey(workspace, '/dynamic_models', { query: { limit: 1000, search_query: whereQuery({ id: { in: ids } }) } });
      if (!r.ok) throw new HttpError(502, messageOf(r, 'Could not read your answers'));
      // Belt and braces: only rows this team owns.
      for (const m of listOf(r.body, 'dynamic_models').filter((row) => ids.includes(row.id))) {
        if (!byType.has(m.dynamic_model_type)) byType.set(m.dynamic_model_type, []);
        byType.get(m.dynamic_model_type).push(m);
      }
      for (const rows of byType.values()) rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    const entry = { at: Date.now(), byType, brief: null };
    teamCache.set(k, entry);
    return entry;
  }

  // Create a record and link it to its owning team. A record whose owner link fails is removed
  // again, so no unowned record is ever left behind.
  async function createOwned(workspace, iid, team, customFields) {
    const r = await asKey(workspace, '/dynamic_models', {
      method: 'POST', body: { dynamic_model: { dynamic_model_type: iid, description: team.name, custom_fields: customFields } },
    });
    if (!r.ok) return r;
    const record = r.body.dynamic_model;
    const link = await asKey(workspace, '/dynamic_model_party_roles', {
      method: 'POST', body: { dynamic_model_party_role: { dynamic_model_id: record.id, party_id: team.id, role_type_id: await ownerRoleTypeId(workspace) } },
    });
    if (!link.ok) {
      await asKey(workspace, `/dynamic_models/${record.id}`, { method: 'DELETE' });
      throw new HttpError(502, messageOf(link, 'Could not save'));
    }
    return r;
  }

  async function callerTeam(s, requested) {
    const teams = await founders.callerTeams(s);
    const team = requested ? teams.find((t) => t.id === posInt(requested)) : teams[0];
    if (!team) throw new HttpError(403, 'Join a startup team first');
    return team;
  }

  // ---- admin ----

  async function adminList(req, res) {
    const s = requireAdmin(req);
    const r = await call(s, '/dynamic_model_types', { query: { limit: 200 } });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 502, messageOf(r, 'Could not read your custom objects'));
    const cfg = formsConfig(s.workspace);
    const types = listOf(r.body, 'dynamic_model_types').map((t) => {
      const fields = (t.field_definitions && t.field_definitions.fields) || [];
      return {
        iid: t.internal_identifier, name: t.description || t.internal_identifier, field_count: fields.length,
        founder_field_count: fields.filter(founderVisible).length,
        enabled: !!cfg[t.internal_identifier], mode: (cfg[t.internal_identifier] && cfg[t.internal_identifier].mode) || 'single',
      };
    });
    sendJson(res, 200, { success: true, key_ready: !!secrets.get(s.workspace, 'forms_key'), types });
  }

  // Import the key's role and create the key. Same shape as the provisioning key: plaintext goes
  // straight into the secret store; a key the role could not be attached to is switched off.
  async function adminSetup(req, res) {
    const s = requireAdmin(req);
    if (keyLocks.has(s.workspace)) throw new HttpError(409, 'Already setting up — wait a moment');
    keyLocks.set(s.workspace, true);
    try {
      const imp = await call(s, '/security_roles/import', { method: 'POST', body: { data: roleExport(), overwrite: true } });
      if (!imp.ok) throw new HttpError(imp.status >= 400 ? imp.status : 422, messageOf(imp, 'Could not import the forms role'));
      const list = await call(s, '/security_roles', { query: { limit: -1 } });
      const role = (list.ok ? listOf(list.body, 'security_roles') : []).find((x) => x.internal_identifier === FORMS_ROLE);
      if (!role) throw new HttpError(502, 'The forms role was imported but could not be found');
      const k = await call(s, '/api_keys', { method: 'POST', body: { api_key: { description: 'Launchpad Network — founder forms', active: true } } });
      const key = k.ok && k.body.api_key;
      if (!key || !key.key) throw new HttpError(k.status >= 400 ? k.status : 422, messageOf(k, 'Could not create the API key'));
      const a = await call(s, '/security_role_assignments', {
        method: 'POST', body: { security_role_assignment: { accessor_record_type: 'APIKey', accessor_record_id: key.id, security_role_id: role.id } },
      });
      if (!a.ok) {
        await call(s, `/api_keys/${key.id}`, { method: 'PUT', body: { api_key: { active: false } } });
        throw new HttpError(a.status >= 400 ? a.status : 422, messageOf(a, 'Could not give the key its role'));
      }
      const previous = secrets.get(s.workspace, 'forms_key_id');
      secrets.set(s.workspace, 'forms_key', key.key);
      secrets.set(s.workspace, 'forms_key_id', key.id);
      if (previous && String(previous) !== String(key.id)) await call(s, `/api_keys/${previous}`, { method: 'PUT', body: { api_key: { active: false } } });
      forgetWorkspace(s.workspace);
      sendJson(res, 200, { success: true, key_id: key.id });
    } finally { keyLocks.delete(s.workspace); }
  }

  async function adminConfig(req, res) {
    const s = requireAdmin(req);
    const b = await readJson(req);
    const iid = String(b.iid || '');
    if (!TYPE_RE.test(iid)) throw new HttpError(400, 'Which form?');
    const mode = b.mode === 'multiple' ? 'multiple' : 'single';
    store.update((st) => {
      st.founderForms ||= {}; st.founderForms[s.workspace] ||= {};
      if (b.enabled) st.founderForms[s.workspace][iid] = { mode };
      else delete st.founderForms[s.workspace][iid];
    });
    forgetWorkspace(s.workspace); // a newly designed form is visible to founders straight away
    sendJson(res, 200, { success: true, iid, enabled: !!b.enabled, mode });
  }

  // Every startup's answers for one form. Read with the ADMIN's session (they can see everything
  // in their own workspace, including fields hidden from founders).
  async function adminResponses(req, res, url, iid) {
    const s = requireAdmin(req);
    if (!TYPE_RE.test(iid)) throw new HttpError(400, 'Which form?');
    const types = await call(s, '/dynamic_model_types', { query: { limit: 200, internal_identifier: iid } });
    const type = (types.ok ? listOf(types.body, 'dynamic_model_types') : []).find((t) => t.internal_identifier === iid);
    if (!type) throw new HttpError(404, 'No such form');
    const r = await call(s, '/dynamic_models', { query: { limit: 500, dynamic_model_type: iid } });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 502, messageOf(r, 'Could not read the answers'));
    const rows = listOf(r.body, 'dynamic_models');
    // Which startup owns each record (owner links) and the teams' names — read in parallel.
    const owner = await ownerRoleTypeId(s.workspace, (p, o) => call(s, p, o));
    const [links, teams] = await Promise.all([
      rows.length ? call(s, '/dynamic_model_party_roles', { query: { limit: 1000, search_query: whereQuery({ dynamic_model_id: { in: rows.map((m) => m.id) }, role_type_id: owner }) } }) : null,
      call(s, '/teams', { query: { limit: -1 } }),
    ]);
    const ownerOf = new Map((links && links.ok ? listOf(links.body, 'dynamic_model_party_roles') : []).map((l) => [l.dynamic_model_id, l.party_id]));
    const teamName = new Map((teams.ok ? (teams.body.data || teams.body.teams || []) : []).map((t) => [t.id, t.name]));
    const records = rows
      .map((m) => ({ id: m.id, team_id: ownerOf.get(m.id) || null, team_name: teamName.get(ownerOf.get(m.id)) || m.description || '', created_at: m.created_at, updated_at: m.updated_at, values: m.custom_fields || {} }))
      .filter((m) => m.team_id)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    sendJson(res, 200, { success: true, form: publicDefinition(type, { forFounder: false }), records });
  }

  // Staff set the fields founders cannot (a committee score, internal notes) — validated like any
  // other submission, written with the admin's own session, and the owning team's cache dropped so
  // the startup's pages and agents see the change at once.
  async function adminStaffSave(req, res, url, recordId) {
    const s = requireAdmin(req);
    const b = await readJson(req);
    const rec = await call(s, `/dynamic_models/${recordId}`);
    const record = rec.ok && rec.body.dynamic_model;
    if (!record) throw new HttpError(404, 'No such record');
    const types = await call(s, '/dynamic_model_types', { query: { limit: 200, internal_identifier: record.dynamic_model_type } });
    const type = (types.ok ? listOf(types.body, 'dynamic_model_types') : []).find((t) => t.internal_identifier === record.dynamic_model_type);
    if (!type) throw new HttpError(404, 'No such form');
    const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values : {};
    const { values: clean, errors } = validateSubmission(type, values, { partial: true, editable: staffEditable });
    if (Object.keys(errors).length) throw new HttpError(422, 'Please check the highlighted fields', { field_errors: errors });
    const r = await call(s, `/dynamic_models/${record.id}`, { method: 'PUT', body: { dynamic_model: { custom_fields: clean } } });
    if (!r.ok) throw new HttpError(r.status >= 400 && r.status < 500 ? 422 : 502, messageOf(r, 'Could not save'));
    forgetWorkspace(s.workspace);
    sendJson(res, 200, { success: true, record: { id: record.id, values: r.body.dynamic_model.custom_fields || {} } });
  }

  // ---- founder ----

  async function founderList(req, res, url) {
    const s = founders.requireFounder(req);
    const cfg = formsConfig(s.workspace);
    const enabled = Object.keys(cfg);
    if (!enabled.length) return sendJson(res, 200, { success: true, forms: [] });
    const team = await callerTeam(s, url.searchParams.get('team_id'));
    const [types, { byType }] = await Promise.all([typesFor(s.workspace), teamEntry(s.workspace, team.id)]);
    const forms = [];
    for (const iid of enabled) {
      const type = types.find((t) => t.internal_identifier === iid);
      if (!type) continue;
      const rows = byType.get(iid) || [];
      const mode = cfg[iid].mode || 'single';
      forms.push({
        ...publicDefinition(type, { forFounder: true }), mode,
        records: (mode === 'single' ? rows.slice(0, 1) : rows).map((m) => ({ id: m.id, created_at: m.created_at, updated_at: m.updated_at, values: founderValues(type, m.custom_fields) })),
      });
    }
    sendJson(res, 200, { success: true, team: { id: team.id, name: team.name }, forms });
  }

  async function founderSave(req, res, url, iid) {
    const s = founders.requireFounder(req);
    if (!TYPE_RE.test(iid)) throw new HttpError(400, 'Which form?');
    const cfg = formsConfig(s.workspace)[iid];
    if (!cfg) throw new HttpError(404, 'That form is not available');
    const b = await readJson(req);
    const team = await callerTeam(s, b.team_id);
    const [types, { byType }] = await Promise.all([typesFor(s.workspace), teamEntry(s.workspace, team.id)]);
    const type = types.find((t) => t.internal_identifier === iid);
    if (!type) throw new HttpError(404, 'That form is not available');
    const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values : {};

    const rows = byType.get(iid) || [];
    // single: always the startup's one row. multiple: a new entry, or one of THIS team's own entries.
    let target = null;
    if (cfg.mode === 'multiple') {
      if (b.record_id) {
        target = rows.find((m) => m.id === posInt(b.record_id));
        if (!target) throw new HttpError(404, 'That entry is not yours');
      }
    } else target = rows[0] || null;

    const { values: clean, errors } = validateSubmission(type, values, { partial: !!target });
    if (Object.keys(errors).length) throw new HttpError(422, 'Please check the highlighted fields', { field_errors: errors });

    const r = target
      ? await asKey(s.workspace, `/dynamic_models/${target.id}`, { method: 'PUT', body: { dynamic_model: { custom_fields: clean, description: team.name } } })
      : await createOwned(s.workspace, iid, team, clean);
    forgetTeam(s.workspace, team.id);
    if (!r.ok) throw new HttpError(r.status >= 400 && r.status < 500 ? 422 : 502, messageOf(r, 'Could not save'));
    const saved = r.body.dynamic_model || {};
    sendJson(res, 200, { success: true, record: { id: saved.id, updated_at: saved.updated_at, values: founderValues(type, saved.custom_fields) } });
  }

  // This startup's own answers, as agents may see them: only forms shown to founders, only
  // founder-visible fields (never staff-only ones), only records THIS team owns. Self-describing,
  // so an agent needs no schema: form titles, the admin's field labels, option labels, and fields
  // the accelerator fills in (read-only for founders, e.g. a committee score) kept apart from the
  // startup's own statements. Returns { data, text } — data for a run's context, text for an
  // assistant conversation's AI context — built once per cached team entry. Empty when forms are
  // not set up or nothing is filled in.
  //
  //   data = { startup: "Orbit Labs", forms: { startup_profile: { title, kind: "one"|"many",
  //            entries: [ { answers: { "Stage": "Pre-seed", … }, from_accelerator: { "Committee score": "4" } } ] } } }
  async function startupData(workspace, team) {
    const empty = { data: {}, text: '' };
    const cfg = formsConfig(workspace);
    if (!Object.keys(cfg).length || !secrets.get(workspace, 'forms_key')) return empty;
    let types; let entry;
    // Definitions first (a cache hit in the steady state): a cached failure then short-circuits
    // before any record read.
    try { types = await typesFor(workspace); entry = await teamEntry(workspace, team.id); } catch (_) { return empty; }
    if (entry.brief) return entry.brief;
    const forms = {}; const lines = [];
    for (const [iid, c] of Object.entries(cfg)) {
      const type = types.find((t) => t.internal_identifier === iid);
      if (!type) continue;
      const def = publicDefinition(type, { forFounder: true });
      const many = c.mode === 'multiple';
      const rows = (entry.byType.get(iid) || []).slice(0, many ? 6 : 1);
      if (!rows.length) continue;
      const entries = rows.map((m) => {
        const vals = founderValues(type, m.custom_fields); const answers = {}; const fromAccelerator = {};
        for (const f of def.fields) {
          const shown = displayText(f, vals[f.key]);
          if (shown) (f.read_only ? fromAccelerator : answers)[f.label] = shown;
        }
        return Object.keys(fromAccelerator).length ? { answers, from_accelerator: fromAccelerator } : { answers };
      });
      forms[iid] = { title: def.name, kind: many ? 'many' : 'one', entries };
      lines.push(`## ${def.name}${many ? ' (most recent first)' : ''}`);
      entries.forEach((e, i) => {
        if (many) lines.push(`### Entry ${i + 1}`);
        for (const [label, v] of Object.entries(e.answers)) lines.push(`- ${label}: ${v}`);
        for (const [label, v] of Object.entries(e.from_accelerator || {})) lines.push(`- ${label} (set by the accelerator): ${v}`);
      });
    }
    entry.brief = lines.length
      ? { data: { startup: team.name, forms }, text: `Information ${team.name} has on file with the accelerator:\n${lines.join('\n')}` }
      : empty;
    return entry.brief;
  }

  // Bound memory: drop cache entries nobody has refreshed in a while.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of teamCache) if (now - v.at > TEAM_DATA_CACHE_MS) teamCache.delete(k);
    for (const [k, v] of typeCache) if (now - v.at > TYPES_CACHE_MS) typeCache.delete(k);
  }, 10 * 60 * 1000).unref();

  return { adminList, adminSetup, adminConfig, adminResponses, adminStaffSave, founderList, founderSave, startupData };
}

module.exports = { createFormsLanes, validateSubmission, publicDefinition, founderVisible, staffEditable, FORMS_ROLE };
