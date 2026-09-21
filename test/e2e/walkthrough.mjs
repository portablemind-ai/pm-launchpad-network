#!/usr/bin/env node
// End-to-end lifecycle test against a REAL PortableMind environment (use staging, never production).
//
// Starts this app in-process (temporary data dir, throwaway secret key), then drives it the way the
// browser does — through /lp/* and /api/v1/* — as three people: the network operator, a new
// accelerator's admin, and two founders. It creates ONE accelerator and deletes it at the end.
//
//   PM_API=https://dev.dsiloed.com PM_APP_URL=https://app-dev.portablemind.ai NETWORK_WORKSPACE=launchpad-net \
//   E2E_OPERATOR_EMAIL=... E2E_OPERATOR_PASSWORD=... [E2E_SOURCE_AGENT=Cohort-Intake-Analyst] \
//     node test/e2e/walkthrough.mjs
//
// Needs: an Enterprise network workspace with an active agreement and a free allowance slot, some
// PURCHASED tokens, and an agent to snapshot as a template.

import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createApp } = require('../../server.js');
const { load } = require('../../lib/config.js');

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`✗ ${k} is required`); process.exit(2); } return v; };
const OP_EMAIL = need('E2E_OPERATOR_EMAIL'), OP_PASSWORD = need('E2E_OPERATOR_PASSWORD');
const SOURCE_AGENT = process.env.E2E_SOURCE_AGENT || 'Cohort-Intake-Analyst';

const E2E_ENV = {
  ...process.env,
  SECRET_STORE_KEY: crypto.randomBytes(32).toString('hex'),
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e2e-')),
  PORT: '1', PUBLIC_URL: '',
};
// The main run signs founders straight in (email verification OFF) so it can go on to test them;
// a second instance over the same data checks the default, verification ON, further down.
const config = load({ ...E2E_ENV, FOUNDER_EMAIL_VERIFICATION: 'off' });
const { server, deps } = createApp(config);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- a tiny cookie-carrying client, one per person ----
function client(name) {
  let cookie = '';
  return {
    name,
    async req(method, p, body) {
      const res = await fetch(BASE + p, {
        method, headers: { 'X-Requested-With': 'launchpad', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      let data = {}; try { data = await res.json(); } catch (_) { /* empty */ }
      return { status: res.status, body: data };
    },
    get(p) { return this.req('GET', p); }, post(p, b = {}) { return this.req('POST', p, b); },
    put(p, b) { return this.req('PUT', p, b); }, del(p) { return this.req('DELETE', p); },
  };
}

let passed = 0, failed = 0;
const results = [];
function check(label, cond, detail) {
  if (cond) { passed++; results.push(`  ✔ ${label}`); } else { failed++; results.push(`  ✖ ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
  return cond;
}
const ok = (r) => r.status >= 200 && r.status < 300 && r.body.success !== false;

const stamp = Date.now().toString(36);
const ACC = { name: `E2E Accelerator ${stamp}`, identifier: `e2e-${stamp}`, email: `admin-${stamp}@e2e-lp.test` };
const op = client('operator'), admin = client('accelerator admin'), f1 = client('founder A'), f2 = client('founder B'), anon = client('anonymous');
let acc = null, templateId = null;

try {
  // ---------------- operator ----------------
  let r = await op.post('/lp/auth/login', { workspace: config.networkWorkspace, email: OP_EMAIL, password: OP_PASSWORD });
  check('operator signs in to the network console', ok(r) && r.body.role === 'operator', r.body);
  r = await op.get('/lp/op/overview');
  check('overview shows an active agreement', ok(r) && r.body.agreement && r.body.agreement.role === 'holder', r.body);
  check('template publishing is entitled', r.body.publishing === true);
  const networkId = r.body.network.id;

  r = await anon.post('/lp/auth/login', { workspace: 'someone-elses-workspace', email: 'x@y.test', password: 'whatever-123' });
  check('sign-in to a workspace outside the network is refused before any credential is sent', r.status === 403, r);

  r = await op.post('/lp/op/accelerators', { name: ACC.name, identifier: ACC.identifier, first_name: 'Eve', last_name: 'Tester', email: ACC.email, plan: 'starter', activation: 'direct' });
  check('operator creates an accelerator (activation skipped)', r.status === 201 && r.body.state === 'created', r.body);
  acc = r.body.accelerator; const adminPassword = r.body.initial_password;
  check('the assigned identifier is read back', acc && acc.identifier && acc.id, r.body);

  r = await op.put(`/api/v1/tenants/${acc.id}/white_label`, { enabled: true, auto_provision: false, app_name: 'E2E Branch', default_role: 'basic', return_url_allowlist: ['localhost'] });
  check('operator switches on white-label for the accelerator', ok(r) && r.body.white_label.enabled === true, r.body);
  r = await op.post(`/api/v1/tenants/${acc.id}/white_label/sso_key`);
  check('the sign-on key endpoint is NOT reachable through the API pipe', r.status === 403);
  r = await op.post(`/lp/op/accelerators/${acc.id}/sso-key`, {});
  check('sign-on key is created and stored server-side (never returned)', ok(r) && r.body.stored && !JSON.stringify(r.body).match(/[0-9a-f]{64}/), r.body);
  check('the secret store holds the key', deps.secrets.get(acc.identifier, 'sso_key').length >= 32);

  const reference = `lp-${acc.id}-e2e-${stamp}`;
  r = await op.post(`/lp/op/accelerators/${acc.id}/transfer`, { amount: 100000, reference, confirm: 'wrong' });
  check('a transfer without the typed confirmation is refused', r.status === 400, r.body);
  r = await op.post(`/lp/op/accelerators/${acc.id}/transfer`, { amount: 100000, reference, confirm: acc.identifier });
  check('operator transfers purchased tokens', ok(r) && r.body.idempotent === false && r.body.amount === 100000, r.body);
  r = await op.post(`/lp/op/accelerators/${acc.id}/transfer`, { amount: 100000, reference, confirm: acc.identifier });
  check('replaying the same reference moves nothing (idempotent)', ok(r) && r.body.idempotent === true, r.body);
  r = await op.post(`/api/v1/tenants/${acc.id}/transfer_tokens`, { amount: 1, reference: `lp-x-${stamp}-pipe` });
  check('transfer_tokens is NOT reachable through the API pipe', r.status === 403);
  for (const sneaky of [`//tenants/${acc.id}/transfer_tokens`, `/tenants/${acc.id}/transfer_tokens.json`, `/tenants/${acc.id}%2ftransfer_tokens`]) {
    r = await op.post('/api/v1' + sneaky, { amount: 1, reference: `lp-x-${stamp}-sneak` });
    check(`…nor as ${sneaky}`, r.status === 403 || r.status === 400, r.status);
  }

  r = await op.post(`/lp/op/accelerators/${acc.id}/snapshot`);
  check('metrics snapshot (counts only) is stored', ok(r) && r.body.snapshot && typeof r.body.snapshot.counts.agents === 'number', r.body);
  r = await op.post(`/lp/op/accelerators/${acc.id}/snapshot`);
  check('a second snapshot within the hour is served from storage', ok(r) && r.body.throttled === true);

  r = await op.get('/api/v1/llm_agents?limit=-1');
  const source = (r.body.llm_agents || []).find((a) => a.name === SOURCE_AGENT);
  check(`source agent "${SOURCE_AGENT}" exists in the network workspace`, !!source);
  r = await op.post('/api/v1/agent_templates', { source_llm_agent_id: source.id, name: `E2E Template ${stamp}`, release_notes: 'v1', memory_ids: [] });
  check('operator snapshots the agent as a template (v1)', ok(r) && r.body.agent_template && r.body.agent_template.id, r.body);
  templateId = r.body.agent_template.id;
  r = await op.put(`/api/v1/agent_templates/${templateId}/sharing`, { sharing: { mode: 'selected', grantee_tenant_ids: [acc.id] } });
  check('operator shares the template with the new accelerator only', ok(r), r.body);

  // ---------------- accelerator admin ----------------
  r = await admin.post('/lp/auth/login', { workspace: acc.identifier, email: ACC.email, password: adminPassword });
  check('the accelerator admin signs in with the initial password', ok(r) && r.body.role === 'accelerator_admin', r.body);
  check('…and must replace it: the network chose it (requires_password_change)', r.body.requires_password_change === true, r.body);
  r = await admin.put('/api/v1/users/current/update_password', { password: 'x' });
  check('a password change is NOT reachable through the pipe (it returns a session token)', r.status === 403);
  const adminNewPassword = `Own-${stamp}-Pass-26!`;
  r = await admin.post('/lp/auth/password', { password: adminNewPassword });
  check('the admin sets their own password through the server lane', ok(r), r.body);
  r = await admin.get('/api/v1/users/current');
  check('…and the session carries on with the new token', ok(r) && r.body.user && r.body.user.email === ACC.email, r.status);
  const relog = await client('admin again').post('/lp/auth/login', { workspace: acc.identifier, email: ACC.email, password: adminNewPassword });
  check('…the new password signs in, no longer temporary', ok(relog) && !relog.body.requires_password_change, relog.body);
  r = await admin.get('/lp/op/overview');
  check('an accelerator admin cannot reach the network console', r.status === 403);
  r = await admin.post('/lp/acc/setup/founder-role');
  check('admin imports the external founder role (and the built-in external_member baseline exists)', ok(r) && r.body.founder_role.external === true, r.body);
  r = await admin.get('/lp/acc/setup');
  check('set-up status shows the built-in external_member role, flagged external', ok(r) && r.body.baseline_role && r.body.baseline_role.external === true, r.body);
  r = await admin.post('/lp/acc/setup/provisioning-key');
  check('admin creates the provisioning key (stored, never returned)', ok(r) && r.body.stored && !JSON.stringify(r.body).includes('pmk_'), r.body);
  r = await admin.post('/api/v1/api_keys', { api_key: { description: 'x', active: true } });
  check('API-key creation is NOT reachable through the pipe', r.status === 403);
  r = await admin.post('/api/v1/api_keys.json', { api_key: { description: 'x', active: true } });
  check('…nor as /api_keys.json', r.status === 403);
  r = await admin.post('/lp/acc/setup/invite-code', {});
  const invite = r.body.invite_code;
  check('admin generates an invite code', ok(r) && invite && invite.length >= 8);

  r = await admin.get('/api/v1/agent_template_catalog');
  const entry = (r.body.agent_template_catalog || []).find((t) => t.id === templateId);
  check('the shared template is in the accelerator catalog', !!entry, r.body);
  r = await admin.get(`/api/v1/agent_template_catalog/${templateId}`);
  const v1 = r.body.agent_template_catalog_entry.current_version;
  const needsConsent = !!v1.manifest.requires_consent;
  const agentName = `E2E-Agent-${stamp}`;
  r = await admin.post(`/api/v1/agent_template_catalog/${templateId}/install`, { name: agentName, expected_version_id: v1.id });
  if (needsConsent) check('install without consent is refused (code_not_accepted)', r.status === 422 && r.body.code === 'code_not_accepted', r.body);
  r = await admin.post(`/api/v1/agent_template_catalog/${templateId}/install`, { name: agentName, accept_code: needsConsent || undefined, expected_version_id: v1.id });
  check('admin installs the template, consent bound to the reviewed version', r.status === 201 && r.body.llm_agent, r.body);
  const installedAgentId = r.body.llm_agent && r.body.llm_agent.id;
  r = await admin.post(`/api/v1/agent_template_catalog/${templateId}/install`, { name: agentName, accept_code: needsConsent || undefined, expected_version_id: v1.id });
  check('a second install with the same name is refused (name_taken)', r.status === 422 && r.body.code === 'name_taken', r.body);

  r = await op.post(`/api/v1/agent_templates/${templateId}/publish`, { release_notes: 'v2', memory_ids: [] });
  check('operator publishes v2', ok(r) && r.body.version.version === 2, r.body);
  r = await admin.post(`/api/v1/agent_template_catalog/${templateId}/install`, { name: `${agentName}-b`, accept_code: needsConsent || undefined, expected_version_id: v1.id });
  check('installing against the stale version is refused (version_changed)', r.status === 422 && r.body.code === 'version_changed', r.body);
  r = await admin.get('/api/v1/agent_template_installs');
  const inst = (r.body.agent_template_installs || []).find((i) => i.agent_template_id === templateId);
  check('the install shows an upgrade to v2', inst && inst.upgrade_available && inst.latest_version === 2, inst);
  r = await admin.post(`/api/v1/agent_template_installs/${inst.id}/upgrade`, { expected_version_id: inst.latest_version_id, accept_code: inst.upgrade_requires_consent || undefined });
  check('admin upgrades the agent to v2', ok(r), r.body);

  r = await admin.get('/api/v1/tenants/subscription_status');
  check('the accelerator sees itself as covered by the network', ok(r) && r.body.billing_agreement && r.body.billing_agreement.role === 'covered', r.body.billing_agreement);

  // ---------------- founders ----------------
  const fA = { email: `ana-${stamp}@e2e-lp.test`, password: 'Founder-A-Pass-26!' };
  r = await anon.post('/lp/founders/signup', { workspace: acc.identifier, invite_code: 'not-the-code', startup_name: 'Nope', first_name: 'No', last_name: 'Pe', email: `no-${stamp}@e2e-lp.test`, password: 'Whatever-Pass-26!' });
  check('sign-up with a wrong invite code is refused', r.status === 403, r.body);
  r = await f1.post('/lp/founders/signup', { workspace: acc.identifier, invite_code: invite, startup_name: `Alpha ${stamp}`, first_name: 'Ana', last_name: 'Alpha', ...fA });
  check('founder A registers a startup and is signed in', ok(r) && r.body.role === 'founder', r.body);
  r = await f2.post('/lp/founders/signup', { workspace: acc.identifier, invite_code: invite, startup_name: `Beta ${stamp}`, first_name: 'Ben', last_name: 'Beta', email: `ben-${stamp}@e2e-lp.test`, password: 'Founder-B-Pass-26!' });
  check('founder B registers a second startup', ok(r) && r.body.role === 'founder', r.body);

  const meA = await f1.get('/lp/founders/me'); const meB = await f2.get('/lp/founders/me');
  check('each founder sees exactly their own startup', ok(meA) && meA.body.teams.length === 1 && meA.body.teams[0].name === `Alpha ${stamp}` && meB.body.teams[0].name === `Beta ${stamp}`, { a: meA.body, b: meB.body });
  r = await f1.post('/lp/founders/join-link', { team_id: meB.body.teams[0].id });
  check('founder A cannot get a join link for founder B’s startup', r.status === 403, r.body);
  r = await f1.post('/lp/founders/join-link', { team_id: meA.body.teams[0].id });
  check('founder A gets a join link for their own startup', ok(r) && r.body.token, r.body);
  const joinToken = r.body.token;
  r = await anon.get('/lp/founders/join-info?token=' + encodeURIComponent(joinToken));
  check('the join link names the team it is for', ok(r) && r.body.valid && r.body.team_name === `Alpha ${stamp}`, r.body);
  const tampered = joinToken.replace(/^./, (c) => (c === 'e' ? 'f' : 'e'));
  r = await anon.post('/lp/founders/signup', { workspace: acc.identifier, join: tampered, first_name: 'Ta', last_name: 'Mper', email: `tamper-${stamp}@e2e-lp.test`, password: 'Tamper-Pass-2026!' });
  check('a tampered join link is refused', r.status === 403, r.body);
  const fC = client('colleague');
  r = await fC.post('/lp/founders/signup', { workspace: acc.identifier, join: joinToken, first_name: 'Cy', last_name: 'Alpha', email: `cy-${stamp}@e2e-lp.test`, password: 'Colleague-Pass-26!' });
  check('the colleague registers themselves through the join link', ok(r) && r.body.role === 'founder', r.body);
  const meC = await fC.get('/lp/founders/me');
  check('…and lands in founder A’s team (no duplicate team)', ok(meC) && meC.body.teams.length === 1 && meC.body.teams[0].id === meA.body.teams[0].id && meC.body.teams[0].members.length === 2, meC.body);

  // ---- the startup's own workspace: chat, files, runs ----
  r = await f1.get('/api/v1/users/current');
  const founderRoles = ((r.body.user || {}).security_roles || []).map((x) => x.internal_identifier);
  check('a founder holds the scoped role, the baseline and the app-section roles', ok(r)
    && founderRoles.includes('lp_founder') && founderRoles.includes('external_member')
    && ['app_chat', 'app_files', 'app_projects'].every((x) => founderRoles.includes(x)), founderRoles);

  r = await f1.post('/lp/founders/channel', { team_id: meA.body.teams[0].id });
  check('founder A opens their startup’s private team channel', ok(r) && r.body.conversation_id, r.body);
  const chanA = r.body.conversation_id;
  r = await f1.post('/lp/founders/channel', { team_id: meA.body.teams[0].id });
  check('…re-opening returns the SAME channel (not a second one)', ok(r) && r.body.conversation_id === chanA, r.body);
  r = await f1.post('/lp/founders/channel', { team_id: meB.body.teams[0].id });
  check('founder A cannot open founder B’s channel', r.status === 403, r.body);

  r = await f1.post('/api/v1/llm_messages', { llm_message: { llm_conversation_id: chanA, message: { role: 'user', content: 'runway is 7 months' } } });
  check('founder A posts into their own channel', ok(r), r.body);
  r = await fC.get(`/api/v1/llm_conversations/${chanA}/llm_messages?limit=10`);
  check('their colleague (same startup) reads it', ok(r) && (r.body.llm_messages || []).length === 1, { n: (r.body.llm_messages || []).length });

  // The cross-startup hole this app + platform release closed: a founder of ANOTHER startup must
  // not see the channel, read it, or post into it.
  r = await f2.get(`/api/v1/llm_conversations/${chanA}`);
  check('another startup cannot fetch the private channel', !ok(r), { status: r.status });
  r = await f2.get(`/api/v1/llm_conversations/${chanA}/llm_messages?limit=10`);
  check('…cannot read its messages', !ok(r) || (r.body.llm_messages || []).length === 0, r.body);
  r = await f2.post('/api/v1/llm_messages', { llm_message: { llm_conversation_id: chanA, message: { role: 'user', content: 'intruder' } } });
  check('…and cannot post into it', !ok(r), { status: r.status, body: r.body.message });

  r = await f1.get('/api/v1/llm_files?limit=10');
  check('a founder can list files (their own and their startup’s)', ok(r), r.body.message);
  r = await f1.get('/api/v1/orchestration_executions?limit=10');
  check('a founder can list their own programme runs', ok(r), r.body.message);
  r = await f1.get('/api/v1/orchestration_templates?limit=10');
  check('a founder can list published templates', ok(r), r.body.message);

  r = await admin.post('/lp/acc/setup/app-access');
  check('the admin can sync founder app access', ok(r) && typeof r.body.founders === 'number', r.body);

  r = await f1.get('/lp/op/overview');
  check('a founder cannot reach the network console', r.status === 403);
  r = await f1.post('/lp/acc/setup/invite-code', {});
  check('a founder cannot change accelerator set-up', r.status === 403);
  r = await f1.post('/api/v1/users', { user: { email: 'x@y.test' }, security_role_iids: 'tenant_admin' });
  check('a founder cannot create users through the pipe', r.status === 403);
  r = await f1.get('/api/v1/communication_events?limit=5');
  check('founders hold the external_member baseline (their own notifications load)', ok(r), { status: r.status, body: r.body.message });
  r = await f1.get('/api/v1/teams?limit=-1');
  check('the scoped founder role cannot list the accelerator’s teams', !ok(r), r.status);
  r = await f1.get('/api/v1/projects?limit=-1&tenant_id=1');
  check('a top-level tenant_id is refused by the pipe', r.status === 400);

  // Founders never see the platform behind this app: no sign-on for them, only for accelerator staff.
  r = await f1.post('/lp/sso/go', { dest: '/app/welcome' });
  check('a founder is refused sign-on into the platform app', r.status === 403, r.body);
  r = await f1.get('/lp/founders/me');
  check('…and is never told it is available', ok(r) && r.body.sso_available === false && !r.body.app_url, r.body);
  r = await admin.post('/lp/sso/go', { dest: '/app/welcome' });
  check('sign-on URL is issued for the verified accelerator admin', ok(r) && r.body.url.startsWith(`${config.pmAppUrl}/sso?`), r.body);
  if (ok(r)) {
    const assertion = new URL(r.body.url).searchParams.get('assertion');
    const [h, p, sig] = assertion.split('.');
    const expected = crypto.createHmac('sha256', deps.secrets.get(acc.identifier, 'sso_key')).update(`${h}.${p}`).digest('base64url');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    check('…signed with THAT accelerator’s key, for that admin, ≤120 s', sig === expected && payload.sub === ACC.email && payload.tenant_enterprise_identifier === acc.identifier && payload.exp - payload.iat <= 120, payload);
    // Exchange it for real — proves the platform accepts the assertion.
    const ex = await deps.pm.call('/sso/exchange', { method: 'POST', workspace: acc.identifier, body: { assertion } });
    check('the platform exchanges the assertion for a session', ex.ok && !!(ex.body.token || ex.body.jwt), { status: ex.status, body: ex.body.message || ex.body.error });
    const replay = await deps.pm.call('/sso/exchange', { method: 'POST', workspace: acc.identifier, body: { assertion } });
    check('…and refuses to exchange it twice', replay.status === 401, replay.status);
  }

  // Assistants: the admin picks which agents founders may use; each founder talks to one privately.
  r = await f1.get('/lp/founders/assistants');
  check('no assistants until the admin makes one available', ok(r) && r.body.assistants.length === 0, r.body);
  r = await f1.post('/lp/acc/founder-agents', { agent_id: installedAgentId, enabled: true });
  check('a founder cannot choose assistants', r.status === 403);
  r = await admin.get('/lp/acc/founder-agents');
  check('the admin lists the workspace’s agents', ok(r) && r.body.agents.some((a) => a.id === installedAgentId), r.body);
  r = await admin.post('/lp/acc/founder-agents', { agent_id: installedAgentId, enabled: true });
  check('the admin makes the installed agent available to founders', ok(r), r.body);
  r = await f1.get('/lp/founders/assistants');
  check('the founder now sees it', ok(r) && r.body.assistants.some((a) => a.id === installedAgentId), r.body);
  r = await f1.post(`/lp/founders/assistants/${installedAgentId}/open`);
  const chatA = r.body.conversation_id;
  check('the founder opens a private conversation with it', ok(r) && chatA && r.body.mention === `@${agentName}`, r.body);
  r = await f1.get(`/api/v1/llm_conversations/${chatA}`);
  check('…whose AI context (system_prompt) names the founder’s startup, not in any message', ok(r) && /of the startup /.test(r.body.llm_conversation.system_prompt || ''), { sp: r.body.llm_conversation && r.body.llm_conversation.system_prompt });
  r = await f1.post(`/lp/founders/assistants/${installedAgentId}/send`, { message: 'Hello' });
  check('…and messages it (the server adds the @mention)', ok(r) && r.body.conversation_id === chatA, r.body);
  r = await f2.post(`/lp/founders/assistants/${installedAgentId}/open`);
  check('another founder gets their OWN conversation', ok(r) && r.body.conversation_id && r.body.conversation_id !== chatA, r.body);
  r = await f2.get(`/api/v1/llm_conversations/${chatA}/llm_messages?limit=5`);
  check('…and cannot read the first founder’s', !ok(r) || !(r.body.llm_messages || []).length, { status: r.status });
  r = await f1.post('/lp/founders/assistants/999999999/open');
  check('an assistant the admin did not enable is refused', r.status === 404);
  r = await admin.get('/lp/founders/assistants');
  check('assistant lanes are for founders only', r.status === 403);

  // Founder forms: the accelerator's own custom objects, filled in by founders through this server.
  r = await admin.post('/api/v1/dynamic_model_types', { dynamic_model_type: { internal_identifier: 'e2e_profile', description: 'E2E profile' } });
  const typeId = r.body.dynamic_model_type && r.body.dynamic_model_type.id;
  check('the admin creates a custom object type (as in Administration → Custom Objects)', ok(r) && typeId, r.body);
  r = await admin.put(`/api/v1/dynamic_model_types/${typeId}`, { dynamic_model_type: { field_definitions: {
    sections: [{ key: 'main', label: 'Main', display_order: 1 }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', section: 'main', display_order: 1, validation: { required: true } },
      { key: 'stage', label: 'Stage', type: 'select', section: 'main', display_order: 2, options: ['seed', 'series_a'] },
      { key: 'score', label: 'Score', type: 'number', section: 'main', display_order: 3, read_only: true },
      { key: 'notes', label: 'Notes', type: 'textarea', section: 'main', display_order: 4, visible: false },
    ] } } });
  check('…and designs its fields', ok(r), r.body);
  r = await f1.get('/lp/founders/forms');
  check('founders see no forms until the admin chooses some', ok(r) && r.body.forms.length === 0, r.body);
  r = await admin.post('/lp/acc/forms/setup');
  check('the admin connects forms (a key that can only read/write custom objects)', ok(r) && r.body.key_id, r.body);
  r = await admin.post('/lp/acc/forms/config', { iid: 'e2e_profile', enabled: true, mode: 'single' });
  check('the admin shows the form to founders', ok(r), r.body);
  r = await f1.get('/lp/founders/forms');
  const f1form = ok(r) && r.body.forms.find((x) => x.iid === 'e2e_profile');
  check('the founder gets the form without the hidden field, with the read-only one locked', !!f1form && !f1form.fields.some((x) => x.key === 'notes') && f1form.fields.find((x) => x.key === 'score').read_only === true, r.body);
  r = await f1.post('/lp/founders/forms/e2e_profile', { values: { stage: 'unicorn' } });
  check('required and option checks refuse a bad submission', r.status === 422 && r.body.field_errors && r.body.field_errors.name && r.body.field_errors.stage, r.body);
  r = await f1.post('/lp/founders/forms/e2e_profile', { values: { name: 'Alpha', stage: 'seed', score: 5, notes: 'x' } });
  const recId = r.body.record && r.body.record.id;
  check('the founder saves; read-only and hidden fields are ignored', ok(r) && recId && r.body.record.values.score === undefined && r.body.record.values.notes === undefined, r.body);
  r = await admin.post(`/lp/acc/forms/records/${recId}`, { values: { name: 'Hijacked', score: 'not-a-number' } });
  check('staff values are validated too', r.status === 422 && r.body.field_errors && r.body.field_errors.score, r.body);
  r = await admin.post(`/lp/acc/forms/records/${recId}`, { values: { name: 'Hijacked', score: 4, notes: 'staff only' } });
  check('the admin sets the staff fields — and only those (the founder’s answer is untouched)', ok(r) && r.body.record.values.score === 4 && r.body.record.values.name === 'Alpha', r.body);
  r = await f1.post('/lp/acc/forms/records/' + recId, { values: { score: 5 } });
  check('a founder cannot use the staff lane', r.status === 403);
  r = await f1.get('/lp/founders/forms');
  const vals = (r.body.forms.find((x) => x.iid === 'e2e_profile').records[0] || {}).values || {};
  check('the founder sees the score but never the notes', vals.name === 'Alpha' && vals.score === 4 && vals.notes === undefined, vals);
  r = await f2.get('/lp/founders/forms');
  check('another startup sees the form empty (not the first startup’s answers)', ok(r) && r.body.forms.find((x) => x.iid === 'e2e_profile').records.length === 0, r.body);
  r = await f1.get('/api/v1/dynamic_models?limit=5');
  check('founders cannot reach custom objects through the API pipe', !ok(r) || !(r.body.dynamic_models || []).length, { status: r.status });
  r = await admin.get('/lp/acc/forms/e2e_profile/responses');
  check('the admin sees every startup’s answers, including staff fields', ok(r) && r.body.records.some((x) => x.id === recId && x.values.notes === 'staff only'), r.body);
  r = await f1.post('/lp/acc/forms/config', { iid: 'e2e_profile', enabled: false });
  check('a founder cannot change which forms are shown', r.status === 403);
  // A log (many entries per startup): exercises reads of several owned records at once.
  r = await admin.post('/api/v1/dynamic_model_types', { dynamic_model_type: { internal_identifier: 'e2e_log', description: 'E2E log' } });
  const logTypeId = r.body.dynamic_model_type && r.body.dynamic_model_type.id;
  r = await admin.put(`/api/v1/dynamic_model_types/${logTypeId}`, { dynamic_model_type: { field_definitions: { sections: [], fields: [
    { key: 'note', label: 'Note', type: 'text', validation: { required: true } }] } } });
  r = await admin.post('/lp/acc/forms/config', { iid: 'e2e_log', enabled: true, mode: 'multiple' });
  for (const note of ['first', 'second']) r = await f1.post('/lp/founders/forms/e2e_log', { values: { note } });
  r = await f1.get('/lp/founders/forms');
  const log = ok(r) && r.body.forms.find((x) => x.iid === 'e2e_log');
  check('a log keeps every entry, newest first', !!log && log.records.length === 2 && log.records[0].values.note === 'second', r.body);
  r = await f1.get('/lp/founders/forms');
  check('…and the profile still reads alongside it', ok(r) && r.body.forms.find((x) => x.iid === 'e2e_profile').records.length === 1, r.body);

  // Default configuration: founders must confirm their email before they can sign in.
  {
    const { server: server2 } = createApp(load(E2E_ENV));
    await new Promise((res2) => server2.listen(0, '127.0.0.1', res2));
    const v = await fetch(`http://127.0.0.1:${server2.address().port}/lp/founders/signup`, {
      method: 'POST', headers: { 'X-Requested-With': 'launchpad', 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: acc.identifier, invite_code: invite, startup_name: `Gamma ${stamp}`, first_name: 'Gia', last_name: 'Gamma', email: `gia-${stamp}@e2e-lp.test`, password: 'Founder-G-Pass-26!' }),
    }).then(async (x) => ({ status: x.status, body: await x.json() }));
    check('with verification ON (the default), sign-up asks the founder to confirm their email', v.status === 201 && v.body.verify_email === true && !v.body.signed_in, v.body);
    const pre = await deps.pm.call('/authenticate', { method: 'POST', workspace: acc.identifier, body: { email: `gia-${stamp}@e2e-lp.test`, password: 'Founder-G-Pass-26!' } });
    check('…and cannot sign in before activating', !pre.ok && !pre.body.jwt, pre.status);
    server2.close();
  }

  r = await f1.post('/lp/auth/logout');
  r = await f1.get('/lp/founders/me');
  check('after sign-out the session is gone', r.status === 401);

  void networkId;
} catch (e) {
  check('walkthrough ran to completion', false, e.stack || String(e));
} finally {
  // ---------------- cleanup ----------------
  if (templateId) {
    const r = await op.del(`/api/v1/agent_templates/${templateId}`);
    check('cleanup: template deleted', ok(r), r.body);
  }
  if (acc) {
    const r = await op.post(`/lp/op/accelerators/${acc.id}/delete`, { confirm: acc.identifier });
    check('cleanup: accelerator deletion queued and its secrets destroyed', ok(r) && !deps.secrets.get(acc.identifier, 'sso_key'), r.body);
  }
  server.close();
  console.log(`\n  Launchpad Network — end-to-end walkthrough against ${config.pmApi}\n`);
  console.log(results.join('\n'));
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
