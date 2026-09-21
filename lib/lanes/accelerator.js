'use strict';

// /lp/acc/*  — accelerator set-up. Caller: an admin of one accelerator sub-workspace.
//
// The network has NO administrative back door into an accelerator (guide §3.5). Everything that
// must exist inside it — the founder role, the provisioning key, the founder invite code — is set
// up here by the accelerator's OWN admin, with their own session. Templates, installs, upgrades,
// teams and usage are plain API reads/writes and go through the /api/v1 pipe from the browser.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, sendJson, readJson, str } = require('../http');
const { messageOf } = require('../pm');

const FOUNDER_ROLE = 'lp_founder';
// Built-in, platform-provided external baseline (notifications, preferences, saved views — no
// business data). Granted next to the founder role so the PortableMind app loads cleanly for them.
const BASELINE_ROLE = 'external_member';
// What a founder is granted, always explicitly (without it they would get the broad default role).
const FOUNDER_ROLES = `${BASELINE_ROLE},${FOUNDER_ROLE}`;
// The app's navigation gates on these role NAMES (they carry no business data). Granted so a
// founder can open Team Chat, Files and Projects in the PortableMind app; what they can read
// there still comes only from the scoped founder role.
const APP_SECTION_ROLES = ['app_chat', 'app_files', 'app_projects'];
const FOUNDER_ROLES_WITH_APPS = [FOUNDER_ROLES, ...APP_SECTION_ROLES].join(',');
const roleExport = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'setup', 'lp-founder.role.export.json'), 'utf8'));

function createAcceleratorLane({ sessions, secrets, store }) {
  function requireAdmin(req) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    if (s.role !== 'accelerator_admin') throw new HttpError(403, 'Accelerator administrators only');
    const acc = store.acceleratorByIdentifier(s.workspace);
    if (!acc || acc.departed_at) throw new HttpError(403, 'This workspace is no longer part of the network');
    return s;
  }
  const call = (s, p, o) => sessions.callAs(s, p, o);

  // Before a privileged action the platform is asked again: the role was fixed at sign-in, and an
  // admin demoted since then must not keep control of sign-ups (guide §7.2).
  async function reverifyAdmin(s) {
    const me = await call(s, '/users/current');
    const user = me.ok && (me.body.user || me.body);
    if (!user || String(user.tenant_enterprise_identifier) !== s.workspace || !user.is_admin) {
      sessions.destroy(s);
      throw new HttpError(403, 'You are no longer an administrator of this workspace — sign in again');
    }
  }
  const keyLocks = new Map(); // workspace -> in-flight key creation

  async function roles(s) {
    const r = await call(s, '/security_roles', { query: { limit: -1 } });
    if (!r.ok) throw new HttpError(r.status || 502, messageOf(r, 'Could not read security roles'));
    return r.body.security_roles || [];
  }

  async function status(req, res) {
    const s = requireAdmin(req);
    const [list, wl] = await Promise.all([roles(s), call(s, '/white_label')]);
    const founder = list.find((r) => r.internal_identifier === FOUNDER_ROLE);
    const baseline = list.find((r) => r.internal_identifier === BASELINE_ROLE);
    const appAccess = await founderAppAccess(s, list).catch(() => null);
    sendJson(res, 200, {
      success: true,
      founder_role: founder ? { id: founder.id, external: !!founder.external } : null,
      baseline_role: baseline ? { id: baseline.id, external: !!baseline.external } : null,
      secrets: secrets.presence(s.workspace),
      app_access: appAccess,
      white_label: wl.ok ? wl.body.white_label : null,
    });
  }

  // Import the scoped, EXTERNAL founder role. A provisioning key may grant only external roles
  // (guide §7.3), and this one reaches only records owned by the founder or their team.
  async function importFounderRole(req, res) {
    const s = requireAdmin(req);
    const r = await call(s, '/security_roles/import', { method: 'POST', body: { data: roleExport(), overwrite: true } });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'Role import failed'));
    const all = await roles(s);
    const role = all.find((x) => x.internal_identifier === FOUNDER_ROLE);
    if (!role || !role.external) throw new HttpError(502, 'The founder role was imported but is not flagged external — founders could not be provisioned');
    const baseline = all.find((x) => x.internal_identifier === BASELINE_ROLE);
    if (!baseline || !baseline.external) throw new HttpError(502, `This workspace has no built-in “${BASELINE_ROLE}” role — ask PortableMind to run the role seeder`);
    sendJson(res, 200, { success: true, founder_role: { id: role.id, external: true } });
  }

  // Create THIS accelerator's provisioning key: an API key holding only the built-in `provisioner`
  // role. The plaintext is returned exactly once by the platform — it goes straight into the
  // secret store and never to the browser.
  async function createProvisioningKey(req, res) {
    const s = requireAdmin(req);
    if (keyLocks.has(s.workspace)) throw new HttpError(409, 'A key is already being created — wait a moment');
    keyLocks.set(s.workspace, true);
    try { return await createKeyLocked(s, res); } finally { keyLocks.delete(s.workspace); }
  }

  async function createKeyLocked(s, res) {
    const provisioner = (await roles(s)).find((r) => r.internal_identifier === 'provisioner');
    if (!provisioner) throw new HttpError(422, 'This workspace has no built-in provisioner role');

    const k = await call(s, '/api_keys', { method: 'POST', body: { api_key: { description: 'Launchpad Network — founder sign-up', active: true } } });
    const key = k.ok && k.body.api_key;
    if (!key || !key.key) throw new HttpError(k.status >= 400 ? k.status : 422, messageOf(k, 'Could not create the API key'));

    const a = await call(s, '/security_role_assignments', {
      method: 'POST',
      body: { security_role_assignment: { accessor_record_type: 'APIKey', accessor_record_id: key.id, security_role_id: provisioner.id } },
    });
    if (!a.ok) {
      // A key with no role can do nothing; switch it off rather than leave a stray credential.
      await call(s, `/api_keys/${key.id}`, { method: 'PUT', body: { api_key: { active: false } } });
      throw new HttpError(a.status >= 400 ? a.status : 422, messageOf(a, 'Could not give the key the provisioner role'));
    }

    const previous = secrets.get(s.workspace, 'provisioning_key_id');
    secrets.set(s.workspace, 'provisioning_key', key.key);
    secrets.set(s.workspace, 'provisioning_key_id', key.id);
    // Retire the key it replaces (API keys count against the plan's active-key limit, guide §6.4).
    let retired = null;
    if (previous && String(previous) !== String(key.id)) {
      const off = await call(s, `/api_keys/${previous}`, { method: 'PUT', body: { api_key: { active: false } } });
      retired = off.ok ? Number(previous) : null;
    }
    sendJson(res, 200, { success: true, stored: true, key_id: key.id, retired_key_id: retired });
  }

  // Which founders are missing an app-section role — the Set-up card reports it, and
  // syncAppAccess() fixes it. Founders who signed up on a platform that lets a provisioning key
  // grant these already have them; this covers older ones and any that were removed by hand.
  async function founderAppAccess(s, roleList) {
    const missing = APP_SECTION_ROLES.filter((iid) => !roleList.some((r) => r.internal_identifier === iid));
    if (missing.length) return { roles_missing: missing, founders: 0, founders_without_access: 0 };
    const founders = await founderUsers(s);
    const without = founders.filter((u) => !APP_SECTION_ROLES.every((iid) => u.role_iids.includes(iid)));
    return { roles_missing: [], founders: founders.length, founders_without_access: without.length };
  }

  // Everyone holding the founder role, with the roles each one has.
  async function founderUsers(s) {
    const r = await call(s, '/users', { query: { limit: -1 } });
    if (!r.ok) throw new HttpError(r.status || 502, messageOf(r, 'Could not list members'));
    return (r.body.users || [])
      .map((u) => ({ id: u.id, email: u.email, role_iids: (u.security_roles || []).map((x) => x.internal_identifier) }))
      .filter((u) => u.role_iids.includes(FOUNDER_ROLE));
  }

  // Grant the app sections to every founder that is missing one.
  async function syncAppAccess(req, res) {
    const s = requireAdmin(req);
    await reverifyAdmin(s);
    const roleList = await roles(s);
    const ids = new Map(APP_SECTION_ROLES.map((iid) => [iid, (roleList.find((r) => r.internal_identifier === iid) || {}).id]));
    const missing = APP_SECTION_ROLES.filter((iid) => !ids.get(iid));
    if (missing.length) throw new HttpError(422, `This workspace has no ${missing.join(', ')} role`);

    const founders = await founderUsers(s);
    let granted = 0;
    for (const u of founders) {
      for (const iid of APP_SECTION_ROLES) {
        if (u.role_iids.includes(iid)) continue;
        const a = await call(s, '/security_role_assignments', {
          method: 'POST',
          body: { security_role_assignment: { accessor_record_type: 'User', accessor_record_id: u.id, security_role_id: ids.get(iid) } },
        });
        if (a.ok) granted += 1;
      }
    }
    sendJson(res, 200, { success: true, founders: founders.length, granted });
  }

  // The code founders need to sign up. Generated here, shown to the admin once; stored server-side.
  async function setInviteCode(req, res) {
    const s = requireAdmin(req);
    await reverifyAdmin(s);
    const b = await readJson(req);
    let code = str(b.code, 64);
    if (code && code.length < 8) throw new HttpError(400, 'Use at least 8 characters, or leave it blank to generate one');
    if (!code) code = crypto.randomBytes(9).toString('base64url');
    secrets.set(s.workspace, 'invite_code', code);
    sendJson(res, 200, { success: true, invite_code: code });
  }

  async function clearInviteCode(req, res) {
    const s = requireAdmin(req);
    await reverifyAdmin(s);
    secrets.remove(s.workspace, 'invite_code');
    sendJson(res, 200, { success: true });
  }

  // Which of this workspace's agents founders may talk to, in this app. Stored here (non-secret):
  // a founder cannot list agents themselves, and the admin decides what founders get.
  const agentSummary = (a) => ({ id: a.id, name: a.name, party_id: a.party_id, description: str(a.description || '', 300) || '' });

  async function founderAgents(req, res) {
    const s = requireAdmin(req);
    const r = await call(s, '/llm_agents', { query: { limit: -1 } });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 502, messageOf(r, 'Could not read your agents'));
    const on = (store.state.founderAgents || {})[s.workspace] || {};
    const agents = (r.body.llm_agents || []).filter((a) => a.party_id).map((a) => ({ ...agentSummary(a), enabled: !!on[String(a.id)] }));
    sendJson(res, 200, { success: true, agents });
  }

  async function setFounderAgent(req, res) {
    const s = requireAdmin(req);
    const b = await readJson(req);
    const id = Number(b.agent_id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which agent?');
    if (b.enabled) {
      const r = await call(s, `/llm_agents/${id}`);
      const a = r.ok && (r.body.llm_agent || r.body);
      if (!a || !a.party_id) throw new HttpError(404, 'That agent is not in your workspace');
      store.update((st) => { st.founderAgents ||= {}; (st.founderAgents[s.workspace] ||= {})[String(id)] = agentSummary(a); });
    } else {
      store.update((st) => { if (st.founderAgents && st.founderAgents[s.workspace]) delete st.founderAgents[s.workspace][String(id)]; });
    }
    sendJson(res, 200, { success: true, enabled: !!b.enabled });
  }

  return { status, importFounderRole, createProvisioningKey, setInviteCode, clearInviteCode, syncAppAccess, founderAgents, setFounderAgent, FOUNDER_ROLE };
}

module.exports = { createAcceleratorLane, FOUNDER_ROLE, BASELINE_ROLE, FOUNDER_ROLES, FOUNDER_ROLES_WITH_APPS, APP_SECTION_ROLES };
