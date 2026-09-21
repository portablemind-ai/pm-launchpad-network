'use strict';

// /lp/op/*  — the network console. Caller: an admin of the network's Enterprise workspace.
//
// Everything that is a plain read or a reversible write (templates, sharing, model sharing,
// white-label settings, plan changes) goes straight through the /api/v1 pipe from the browser.
// This lane holds only the operations that need the SERVER:
//   overview     reconcile GET /tenants against our registry and pending list
//   create       POST /tenants returns nothing usable — register it as pending, read it back
//   snapshot     GET /tenants/:id/stats is heavy — throttle it and store the result
//   transfer     irreversible — confirmation + idempotency reference + our own audit trail
//   sso-key      the key is shown ONCE — capture it into the secret store, never return it
//   delete       permanent — typed confirmation, then destroy the secrets we hold for it

const crypto = require('crypto');
const { HttpError, sendJson, readJson, str, posInt, EMAIL_RE } = require('../http');
const { messageOf } = require('../pm');

const TIERS = ['free', 'starter', 'professional', 'business'];
const IDENT_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const REF_RE = /^lp-[a-z0-9-]{8,120}$/;
const MAX_TRANSFER = 1_000_000_000;

function createOperatorLane({ sessions, store, secrets, config }) {
  function requireOperator(req) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    if (s.role !== 'operator') throw new HttpError(403, 'Network administrators only');
    return s;
  }
  const call = (s, path, opts) => sessions.callAs(s, path, opts);

  function known(id, { allowDeparted = false } = {}) {
    const acc = store.acceleratorById(id);
    if (acc && acc.departed_at && !allowDeparted) throw new HttpError(409, 'This accelerator has left the network');
    if (!acc) throw new HttpError(404, 'Not one of this network’s accelerators (refresh the overview if it was just created)');
    return acc;
  }

  // Fold a listing of our sub-workspaces into the registry.
  //   - A row NOT in the listing is marked `departed_at`, never deleted, and its secrets are KEPT: a
  //     platform glitch that returns a short list must not destroy keys we cannot get back. A
  //     departed accelerator can no longer sign in here; it comes back on the next listing that
  //     includes it. Destroying its secrets is an explicit operator action ("Forget").
  //   - A pending request is resolved only by a row that is NEW to the registry and whose first
  //     admin has the requested email — the identifier may have been changed silently (guide §3.1).
  function reconcile(rows) {
    return store.update((st) => {
      const known = new Set(Object.keys(st.accelerators).filter((k) => !st.accelerators[k].departed_at));
      const fresh = rows.filter((t) => !known.has(String(t.id)));
      st.pending = st.pending.filter((p) => !fresh.some((t) => String((t.root_user && t.root_user.email) || '').toLowerCase() === p.email.toLowerCase()));
      const listed = new Set(rows.map((t) => String(t.id)));
      for (const t of rows) st.accelerators[String(t.id)] = { id: t.id, identifier: t.enterprise_identifier, name: t.description || t.name };
      const departed = [];
      for (const [k, a] of Object.entries(st.accelerators)) {
        if (!listed.has(k) && !a.departed_at) { a.departed_at = new Date().toISOString(); departed.push(a); }
      }
      return { fresh, departed };
    });
  }

  async function overview(req, res) {
    const s = requireOperator(req);
    const [status, entitlement, tenants, current] = await Promise.all([
      call(s, '/tenants/subscription_status'),
      call(s, '/agent_templates/entitlement'),
      call(s, '/tenants', { query: { view: 'dashboard', limit: -1 } }),
      call(s, '/users/current'),
    ]);
    if (!tenants.ok) throw new HttpError(tenants.status || 502, messageOf(tenants, 'Could not list accelerators'));
    const rows = tenants.body.tenants || [];

    // Only a COMPLETE listing may mark anything departed.
    if (Number(tenants.body.total_count) === rows.length) reconcile(rows);

    const st = store.state;
    const accelerators = rows.map((t) => ({
      id: t.id, identifier: t.enterprise_identifier, name: t.description || t.name,
      plan: t.subscription_plan && t.subscription_plan.internal_identifier,
      subscription_status: t.subscription_status, agreement_billed: !!t.agreement_billed,
      token_balance: t.token_balance, root_user: t.root_user || null, created_at: t.created_at,
      stats: t.stats || {}, spend: t.spend || {},
      snapshot: st.snapshots[String(t.id)] || null,
      secrets: secrets.presence(t.enterprise_identifier),
    }));
    const user = (current.body && current.body.user) || {};
    sendJson(res, 200, {
      success: true,
      network: { id: user.tenant_id || null, identifier: config.networkWorkspace, name: config.networkName },
      agreement: status.ok ? status.body.billing_agreement : null,
      plan: status.ok && status.body.product_type ? status.body.product_type : null,
      publishing: entitlement.ok ? !!entitlement.body.publishing : false,
      accelerators, pending: st.pending,
      departed: Object.values(st.accelerators).filter((a) => a.departed_at)
        .map((a) => ({ ...a, secrets: secrets.presence(a.identifier) })),
      transfers: st.transfers.slice(-25).reverse(),
    });
  }

  async function create(req, res) {
    const s = requireOperator(req);
    const b = await readJson(req);
    const name = str(b.name, 120);
    const identifier = str(b.identifier, 50).toLowerCase();
    const first = str(b.first_name, 80), last = str(b.last_name, 80), email = str(b.email, 200).toLowerCase();
    const plan = str(b.plan, 20);
    const direct = b.activation === 'direct';
    if (!name || !first || !last || !EMAIL_RE.test(email)) throw new HttpError(400, 'Name, first admin’s name and a valid email are required');
    if (identifier && !IDENT_RE.test(identifier)) throw new HttpError(400, 'Identifier: 3–50 lowercase letters, digits and dashes');
    if (!TIERS.includes(plan)) throw new HttpError(400, 'Choose free, starter, professional or business');

    // Refuse a plan above the contract tier before asking the platform (it would say outside_contract).
    const status = await call(s, '/tenants/subscription_status');
    const agreement = status.ok ? status.body.billing_agreement : null;
    if (!agreement || agreement.role !== 'holder') throw new HttpError(422, 'No active billing agreement — ask PortableMind to record one (guide §2)', { code: 'sub_tenant_agreement_required' });
    if (TIERS.indexOf(plan) > TIERS.indexOf(agreement.contract_tier)) throw new HttpError(422, `Your contract allows plans up to ${agreement.contract_tier}`, { code: 'outside_contract' });

    // The first admin's initial password is generated here and shown to the operator ONCE, to hand
    // over. It must satisfy the NETWORK's password policy (guide §3.1).
    const policy = await call(s, '/password_policy/effective');
    const password = generatePassword(policy.ok ? policy.body : {});

    const body = {
      name, user_first_name: first, user_last_name: last, user_email: email, user_password: password,
      subscription_plan: plan,
    };
    if (identifier) body.enterprise_identifier = identifier;
    if (direct) body.skip_activation_needed_email = true;
    const r = await call(s, '/tenants', { method: 'POST', body });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'The platform refused to create the accelerator'), { code: r.body.code });

    // `{ success: true }` and nothing else. Record it, then look for it.
    store.update((st) => { st.pending.push({ name, email, plan, requested_identifier: identifier || null, mode: direct ? 'direct' : 'email', requested_at: new Date().toISOString() }); });
    let found = null;
    if (direct) {
      const list = await call(s, '/tenants', { query: { limit: -1 } });
      const rows = (list.ok && list.body.tenants) || [];
      if (Number(list.body.total_count) === rows.length) {
        const { fresh } = reconcile(rows);
        found = fresh.find((t) => String((t.root_user && t.root_user.email) || '').toLowerCase() === email) || null;
      }
    }
    sendJson(res, 201, {
      success: true,
      state: found ? 'created' : 'pending_activation',
      accelerator: found ? { id: found.id, identifier: found.enterprise_identifier, name: found.description } : null,
      // The identifier actually assigned can differ from the one requested (guide §3.1).
      identifier_changed: !!(found && identifier && found.enterprise_identifier !== identifier),
      initial_password: password,
    });
  }

  const snapshotsInFlight = new Map(); // accelerator id -> promise (one heavy stats call at a time)

  async function snapshot(req, res, _url, id) {
    const s = requireOperator(req);
    const acc = known(id);
    const prev = store.state.snapshots[String(acc.id)];
    if (prev && Date.now() - Date.parse(prev.at) < config.snapshotMinIntervalMs) {
      return sendJson(res, 200, { success: true, throttled: true, snapshot: prev });
    }
    if (!snapshotsInFlight.has(acc.id)) {
      snapshotsInFlight.set(acc.id, takeSnapshot(s, acc).finally(() => snapshotsInFlight.delete(acc.id)));
    }
    const snap = await snapshotsInFlight.get(acc.id);
    sendJson(res, 200, { success: true, throttled: false, snapshot: snap });
  }

  async function takeSnapshot(s, acc) {
    const end = new Date(); const start = new Date(end.getTime() - 30 * 86400 * 1000);
    const day = (d) => d.toISOString().slice(0, 10);
    const [stats, cost] = await Promise.all([
      call(s, `/tenants/${acc.id}/stats`),
      call(s, `/tenants/${acc.id}/llm_cost_stats`, { query: { start_date: day(start), end_date: day(end) } }),
    ]);
    if (!stats.ok) throw new HttpError(stats.status || 502, messageOf(stats, 'Could not read metrics'));
    const st = stats.body.stats || {};
    const rows = (k) => (st[k] && st[k].rows) || 0;
    // Counts and totals only. llm_cost_stats also carries conversation and people NAMES; this app
    // keeps those out of anything stored or shown across accelerators (guide §3.6).
    const snap = {
      at: new Date().toISOString(),
      counts: {
        agents: rows('llm_agents'), agent_runs: rows('llm_agent_runs'), orchestration_runs: rows('orchestration_executions'),
        conversations: rows('llm_conversations'), messages: rows('llm_messages'), people: rows('human_users'),
        projects: rows('projects'), tasks: rows('tasks'), files: rows('llm_files'),
      },
      storage_bytes: stats.body.stats && stats.body.stats.total_storage ? stats.body.stats.total_storage.storage_bytes || null : null,
      activity: st.activity || {},
      active_users: (st.usage_ledger && st.usage_ledger.active_users) || {},
      ai_cost_30d_cents: cost.ok && cost.body.summary ? Number(cost.body.summary.total_cost_cents) || 0 : null,
    };
    store.update((state) => { state.snapshots[String(acc.id)] = snap; });
    return snap;
  }

  async function transfer(req, res, _url, id) {
    const s = requireOperator(req);
    const acc = known(id);
    const b = await readJson(req);
    const amount = posInt(b.amount);
    const reference = str(b.reference, 130);
    if (!amount || amount > MAX_TRANSFER) throw new HttpError(400, `Amount must be a whole number between 1 and ${MAX_TRANSFER.toLocaleString('en-US')}`);
    if (!REF_RE.test(reference)) throw new HttpError(400, 'Missing or malformed transfer reference');
    // The operator must type the accelerator's identifier: a transfer cannot be undone (guide §6.2).
    if (str(b.confirm, 60) !== acc.identifier) throw new HttpError(400, `Type ${acc.identifier} to confirm`);

    const r = await call(s, `/tenants/${acc.id}/transfer_tokens`, { method: 'POST', body: { amount, reference } });
    // transfer_tokens answers a REAL 404 where its siblings answer 200 success:false — check both.
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'Transfer refused'), { code: r.body.code });
    const entry = {
      at: new Date().toISOString(), accelerator_id: acc.id, identifier: acc.identifier, amount: r.body.amount ?? amount,
      reference, idempotent: !!r.body.idempotent, by: s.user.email,
    };
    if (!entry.idempotent) store.update((st) => { st.transfers.push(entry); });
    sendJson(res, 200, { success: true, ...entry, new_balance: r.body.new_balance, source_purchased_balance: r.body.source_purchased_balance });
  }

  async function ssoKey(req, res, _url, id) {
    const s = requireOperator(req);
    const acc = known(id);
    const b = await readJson(req);
    const rotate = b.rotate === true;
    const r = await call(s, `/tenants/${acc.id}/white_label/sso_key`, { method: 'POST', body: rotate ? { rotate: true } : {} });
    if (!r.ok || !r.body.sso_shared_key) {
      throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'Could not create the sign-on key'), { code: r.body.code });
    }
    // Store it the moment it is returned — it can never be read again.
    secrets.set(acc.identifier, 'sso_key', r.body.sso_shared_key);
    sendJson(res, 200, { success: true, stored: true, rotated: rotate });
  }

  async function destroy(req, res, _url, id) {
    const s = requireOperator(req);
    const acc = known(id);
    const b = await readJson(req);
    if (str(b.confirm, 60) !== acc.identifier) throw new HttpError(400, `Type ${acc.identifier} to confirm`);
    const r = await call(s, `/tenants/${acc.id}`, { method: 'DELETE' });
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'Delete refused'));
    secrets.remove(acc.identifier);
    store.update((st) => { delete st.accelerators[String(acc.id)]; delete st.snapshots[String(acc.id)]; });
    sendJson(res, 200, { success: true, job_id: r.body.job_id || null });
  }

  // Explicitly destroy what we hold for an accelerator that has left the network.
  async function forget(req, res, _url, id) {
    requireOperator(req);
    const acc = known(id, { allowDeparted: true });
    if (!acc.departed_at) throw new HttpError(409, 'Only an accelerator that has left the network can be forgotten');
    const b = await readJson(req);
    if (str(b.confirm, 60) !== acc.identifier) throw new HttpError(400, `Type ${acc.identifier} to confirm`);
    secrets.remove(acc.identifier);
    store.update((st) => { delete st.accelerators[String(acc.id)]; delete st.snapshots[String(acc.id)]; });
    sendJson(res, 200, { success: true });
  }

  async function dismissPending(req, res) {
    requireOperator(req);
    const email = str((await readJson(req)).email, 200).toLowerCase();
    store.update((st) => { st.pending = st.pending.filter((p) => p.email !== email); });
    sendJson(res, 200, { success: true });
  }

  return { overview, create, snapshot, transfer, ssoKey, destroy, forget, dismissPending };
}

// A password that satisfies any reasonable policy: long, all four character classes, random.
function generatePassword(policy) {
  const len = Math.max(20, Number(policy.min_length) || 0);
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-=?@^_'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick);
  while (out.length < len) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  const pw = out.join('');
  const blocked = (policy.blocked_terms || []).some((t) => pw.toLowerCase().includes(String(t).toLowerCase()));
  return blocked ? generatePassword(policy) : pw;
}

module.exports = { createOperatorLane, generatePassword, TIERS };
