'use strict';

// Founder lanes.
//
//   POST /lp/founders/signup     unauthenticated: a founder registers their startup with the
//                                accelerator's invite code (or joins one with a join link).
//                                By default the platform emails an activation link first. ONE call — POST /users with the
//                                accelerator's provisioning key, the scoped founder role and a
//                                NEW team for the startup (guide §7.3). The body is rebuilt from
//                                an allowlist; the browser's JSON is never forwarded.
//   GET  /lp/founders/me         the founder's startup team(s) and roster
//   POST /lp/founders/join-link  a signed link a founder sends a colleague, so the colleague can
//                                register themselves into the founder's OWN team (`team_id`, only
//                                after verifying the caller is on that team — team_name would
//                                create a new, empty team, guide §11 #4). No password handover.
//   GET  /lp/founders/join-info  public: which team a join link is for
//   POST /lp/sso/go              white-label sign-on into the PortableMind app, for the verified
//                                caller only (guide §7.4). NEVER for founders: this network's
//                                founders only ever see its own app, not the platform behind it.

const crypto = require('crypto');
const { HttpError, sendJson, readJson, str, posInt, EMAIL_RE } = require('../http');
const { messageOf } = require('../pm');
const { signAssertion, canonicalDest } = require('../sso');
const { FOUNDER_ROLES, FOUNDER_ROLES_WITH_APPS } = require('./accelerator');
const { clientIp } = require('./auth');

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_WINDOW = 20;
const MAX_TEAM_SCAN = 200;
const TEAM_CACHE_MS = 5 * 60 * 1000;
const JOIN_TTL_MS = 7 * 24 * 3600 * 1000;

function createFounderLanes({ pm, sessions, store, secrets, config, auth }) {
  const attempts = new Map(); // client ip -> [timestamps]
  const teamCache = new Map(); // `${workspace}:${party}` -> { at, teams }

  function rateLimit(req) {
    const ip = clientIp(req, config);
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
    if (list.length >= SIGNUP_MAX_PER_WINDOW) throw new HttpError(429, 'Too many sign-up attempts — try again later');
    list.push(now); attempts.set(ip, list);
  }

  const CLOSED = () => new HttpError(503, 'Sign-ups are not open for this accelerator');

  // A provisioning key may hand out the app-section roles (Team Chat, Files, Projects) only
  // alongside an external role, and only on a platform that has that rule. Older platforms answer
  // 403, so the first refusal per workspace falls back to the two roles that always work and the
  // accelerator's admin grants the sections from Set-up instead.
  const appRolesUnsupported = new Set();
  const roleList = (workspace) => (appRolesUnsupported.has(workspace) ? FOUNDER_ROLES : FOUNDER_ROLES_WITH_APPS);

  function activeAccelerator(workspace) {
    const acc = store.acceleratorByIdentifier(workspace);
    return acc && !acc.departed_at ? acc : null;
  }

  function keyFor(workspace) {
    const key = secrets.get(workspace, 'provisioning_key');
    // Fail closed: no key → no sign-ups, never an attempt with some other credential.
    if (!key) throw CLOSED();
    return key;
  }

  // ---- "join my startup" links: HMAC-signed { workspace, team, team name, expiry } ----
  function signJoin(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', config.linkKey).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  function readJoin(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', config.linkKey).update(body).digest('base64url');
    if (!timingSafeEqual(sig, expect)) return null;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || typeof p.w !== 'string' || !Number.isInteger(p.t) || !(p.exp > Date.now())) return null;
    return p;
  }

  async function signup(req, res) {
    rateLimit(req);
    const b = await readJson(req);
    const workspace = str(b.workspace, 100).toLowerCase();
    if (!activeAccelerator(workspace)) throw CLOSED();

    // Either an invite code (a new startup) or a join link from a founder (their startup).
    let join = null;
    if (b.join) {
      join = readJoin(b.join);
      if (!join || join.w !== workspace) throw new HttpError(403, 'This join link is invalid or has expired — ask your colleague for a new one');
    } else {
      const expected = secrets.get(workspace, 'invite_code');
      if (!expected) throw CLOSED();
      if (!timingSafeEqual(str(b.invite_code, 64), expected)) throw new HttpError(403, 'That invite code is not valid');
    }
    const key = keyFor(workspace);

    const first = str(b.first_name, 80), last = str(b.last_name, 80), email = str(b.email, 200).toLowerCase();
    const startup = str(b.startup_name, 120);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!first || !last || !EMAIL_RE.test(email) || (!join && !startup)) throw new HttpError(400, 'Name, email and startup name are required');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Choose a password of at least 8 characters');

    const verify = config.founderEmailVerification;
    const user = { email, password, first_name: first, last_name: last, skip_welcome_email: true };
    // With verification ON the platform emails an activation link and the account cannot sign in
    // until it is clicked — so nobody can register under someone else's address.
    if (!verify) user.skip_activation_needed_email = true;
    const team = join ? { team_id: join.t } : { team_name: startup };
    const createWith = (roles) => pm.call('/users', {
      method: 'POST', workspace, apiKey: key,
      // ALWAYS explicit: without it the user gets the broad default role and sees everything.
      body: { user, security_role_iids: roles, ...team },
    });

    let r = await createWith(roleList(workspace));
    if (!r.ok && r.status === 403 && !appRolesUnsupported.has(workspace)) {
      // This platform does not allow the app-section roles from a provisioning key. Remember it,
      // and fall back to the two roles that always work; Set-up → app access covers the sections.
      appRolesUnsupported.add(workspace);
      console.warn(`[founders] ${workspace}: platform refused the app-section roles — use Set-up → app access`);
      r = await createWith(FOUNDER_ROLES);
    }
    if (!r.ok) {
      if (r.status === 0) throw new HttpError(502, 'The service is unreachable — try again shortly');
      throw new HttpError(422, 'We could not create that account. If you have registered before, sign in instead.');
    }
    if (join && String(r.body.team_id) !== String(join.t)) throw new HttpError(502, 'Your account was created but not added to the team — contact your accelerator');
    if (join) teamCache.clear();

    if (verify) return sendJson(res, 201, { success: true, signed_in: false, verify_email: true });

    // Verification OFF (staging demos only): sign them straight in.
    const a = await pm.call('/authenticate', { method: 'POST', workspace, body: { email, password } });
    if (!a.ok || !a.body.jwt) return sendJson(res, 201, { success: true, signed_in: false });
    let jwt = a.body.jwt;
    // skip_activation_needed_email marks the password TEMPORARY, so the PortableMind app would force
    // a change on first visit. This founder chose it themselves: set it once, as them, which clears
    // the flag and returns a fresh session.
    if (a.body.requires_password_change) {
      const u = await pm.call('/users/current/update_password', { method: 'PUT', workspace, jwt, body: { password, current_password: password } });
      if (u.ok && u.body.jwt) jwt = u.body.jwt;
    }
    return auth.finish(req, res, workspace, jwt);
  }

  function requireAcceleratorSession(req) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    if (!activeAccelerator(s.workspace)) throw new HttpError(403, 'Only inside an accelerator');
    return s;
  }

  // A founder, inside an active accelerator. Accelerator staff sign in to the same workspace but
  // are not founders; they get the admin console instead.
  function requireFounder(req) {
    const s = requireAcceleratorSession(req);
    if (s.role !== 'founder') throw new HttpError(403, 'Founders only');
    return s;
  }

  async function roster(workspace, key, teamId) {
    const r = await pm.call(`/teams/${teamId}/members`, { workspace, apiKey: key, query: { limit: -1 } });
    if (!r.ok) throw new HttpError(502, messageOf(r, 'Could not read the team roster'));
    return r.body.data || r.body.members || [];
  }

  // Which teams is the VERIFIED caller on? A founder cannot read team membership themselves, so
  // the rosters are read with the provisioning key and matched on the caller's own party id —
  // taken from the server-side session, never from the browser. Any fault aborts (fail closed).
  // Cached per person for a few minutes: the key is metered on the accelerator's plan (guide §6.4).
  async function callerTeams(s) {
    const cacheKey = `${s.workspace}:${s.user.party_id}`;
    const hit = teamCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.teams;
    const key = keyFor(s.workspace);
    const list = await pm.call('/teams', { workspace: s.workspace, apiKey: key, query: { limit: -1 } });
    if (!list.ok) throw new HttpError(502, messageOf(list, 'Could not read teams'));
    const all = list.body.data || list.body.teams || [];
    if (all.length > MAX_TEAM_SCAN) console.warn(`[founders] ${s.workspace}: ${all.length} teams, scanning the first ${MAX_TEAM_SCAN}`);
    const mine = [];
    for (const t of all.slice(0, MAX_TEAM_SCAN)) {
      const members = await roster(s.workspace, key, t.id);
      if (members.some((m) => String(m.party_id) === String(s.user.party_id))) mine.push({ id: t.id, name: t.name, members });
    }
    teamCache.set(cacheKey, { at: Date.now(), teams: mine });
    return mine;
  }

  async function me(req, res) {
    const s = requireAcceleratorSession(req);
    const teams = await callerTeams(s);
    // The caller's own team(s) only: colleagues' names and emails, nobody else's.
    sendJson(res, 200, {
      success: true,
      teams: teams.map((t) => ({ id: t.id, name: t.name, members: t.members.map((m) => ({ name: m.name, email: m.email, is_lead: !!m.is_lead })) })),
      // Founders never get a way into the platform app (see /lp/sso/go).
      sso_available: false,
    });
  }

  // A link a founder sends a colleague so they can register themselves into the founder's team —
  // with their own email (verified) and their own password. Nobody hands a password over.
  // The startup's own private channel: created once, on demand, by a founder of that startup,
  // with every teammate added as a member. Membership — not a capability — is what makes it
  // visible, so the accelerator's staff and the other startups never see it, and a teammate who
  // joins later is added the next time anyone opens the page.
  async function channel(req, res) {
    const s = requireAcceleratorSession(req);
    const b = await readJson(req);
    const teamId = posInt(b.team_id);
    const teams = await callerTeams(s);
    const team = teams.find((t) => t.id === teamId);
    if (!team) throw new HttpError(403, 'That is not your startup');

    const key = `${s.workspace}:${team.id}`;
    let id = (store.state.channels || {})[key];
    if (id) {
      const seen = await sessions.callAs(s, `/llm_conversations/${id}`);
      if (!seen.ok) id = null;            // deleted, or no longer ours: make a fresh one
    }
    if (!id) {
      const made = await sessions.callAs(s, '/llm_conversations', {
        method: 'POST',
        body: { llm_conversation: { name: `${team.name} — team`, private: true, llm_conversation_type_id: 'channel' } },
      });
      if (!made.ok) throw new HttpError(made.status >= 400 ? made.status : 422, messageOf(made, 'Could not open your team channel'));
      id = made.body.llm_conversation.id;
      store.update((st) => { st.channels ||= {}; st.channels[key] = id; });
    }

    // Keep the roster in step with the team (the creator is added by the platform).
    const membersNow = await sessions.callAs(s, '/llm_conversation_members', { query: { llm_conversation_id: id, limit: -1 } });
    const present = new Set(((membersNow.ok && membersNow.body.llm_conversation_members) || []).map((m) => String(m.party_id)));
    let added = 0;
    for (const m of team.members) {
      if (!m.party_id || present.has(String(m.party_id))) continue;
      const a = await sessions.callAs(s, '/llm_conversation_members', {
        method: 'POST', body: { llm_conversation_member: { llm_conversation_id: id, party_id: m.party_id, active: true } },
      });
      if (a.ok) added += 1;
    }
    sendJson(res, 200, { success: true, conversation_id: id, team: { id: team.id, name: team.name }, members_added: added });
  }

  async function joinLink(req, res) {
    const s = requireAcceleratorSession(req);
    const b = await readJson(req);
    const teamId = posInt(b.team_id);
    if (!teamId) throw new HttpError(400, 'Which team?');
    const members = await roster(s.workspace, keyFor(s.workspace), teamId);
    if (!members.some((m) => String(m.party_id) === String(s.user.party_id))) throw new HttpError(403, 'You can only invite colleagues to your own startup');
    const team = (await callerTeams(s)).find((t) => t.id === teamId);
    const exp = Date.now() + JOIN_TTL_MS;
    const token = signJoin({ w: s.workspace, t: teamId, n: team ? team.name : '', exp });
    sendJson(res, 200, { success: true, token, expires_at: new Date(exp).toISOString(), team_name: team ? team.name : '' });
  }

  // Public: what a join link is for (team name + expiry), so the sign-up form can say so.
  async function joinInfo(req, res, url) {
    const p = readJoin(url.searchParams.get('token'));
    if (!p || !activeAccelerator(p.w)) return sendJson(res, 200, { success: true, valid: false });
    sendJson(res, 200, { success: true, valid: true, workspace: p.w, team_name: p.n, expires_at: new Date(p.exp).toISOString() });
  }

  async function ssoGo(req, res) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    if (s.role !== 'accelerator_admin') throw new HttpError(403, 'Not available');
    if (!activeAccelerator(s.workspace)) throw new HttpError(409, 'Sign-on is only for accelerators in the network');
    if (!config.pmAppUrl) throw new HttpError(409, 'Sign-on into PortableMind is not configured on this server');
    const key = secrets.get(s.workspace, 'sso_key');
    if (!key) throw new HttpError(409, 'Sign-on is not set up for this workspace yet');
    const b = await readJson(req);

    // Sign ONLY for the identity the platform confirms right now (guide §7.2).
    const me = await sessions.callAs(s, '/users/current');
    const user = me.ok && (me.body.user || me.body);
    if (!user || String(user.tenant_enterprise_identifier) !== s.workspace) throw new HttpError(401, 'Your session could not be verified');
    const sub = user.username || user.email;

    // The redirect shape is the one guide §7.4 prescribes: the app's /sso route exchanges the
    // assertion (single use, 90 s) at POST /sso/exchange.
    const params = new URLSearchParams({
      assertion: signAssertion({ sub, email: user.email, workspace: s.workspace, key }),
      dest: canonicalDest(b.dest), source_app: 'launchpad-network',
    });
    if (config.publicUrl) params.set('return_url', config.publicUrl + '/');
    sendJson(res, 200, { success: true, url: `${config.pmAppUrl}/sso?${params}` });
  }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, l] of attempts) if (!l.some((t) => now - t < SIGNUP_WINDOW_MS)) attempts.delete(ip);
    for (const [k, v] of teamCache) if (now - v.at > TEAM_CACHE_MS) teamCache.delete(k);
  }, 10 * 60 * 1000).unref();

  return { signup, me, channel, joinLink, joinInfo, ssoGo, requireFounder, callerTeams };
}

function timingSafeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = { createFounderLanes, timingSafeEqual };
