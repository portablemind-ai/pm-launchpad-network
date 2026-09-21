'use strict';

// /lp/auth/*  — sign-in, MFA, sign-out, "who am I".
//
// Three kinds of people use this app, and the workspace they sign in to decides which:
//   operator            an admin of the network's own Enterprise workspace (NETWORK_WORKSPACE)
//   accelerator_admin   an admin of one of the network's accelerator sub-workspaces
//   founder             anyone else in an accelerator sub-workspace (a member of a startup team)
//
// A sign-in to any other workspace is refused BEFORE credentials are sent anywhere: the workspace
// must be the network itself or an accelerator in the registry (lib/store.js).

const crypto = require('crypto');
const { HttpError, sendJson, readJson, str } = require('../http');
const { messageOf } = require('../pm');

const WORKSPACE_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const MFA_TTL_MS = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_PER_WINDOW = 30;

function createAuthLane({ pm, sessions, store, config }) {
  const mfaChallenges = new Map(); // challenge id -> { workspace, mfa_token, at, attempts }
  const loginAttempts = new Map(); // client ip -> [timestamps]

  function limitLogins(req) {
    const ip = clientIp(req, config);
    const now = Date.now();
    const list = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (list.length >= LOGIN_MAX_PER_WINDOW) throw new HttpError(429, 'Too many sign-in attempts — wait a few minutes');
    list.push(now); loginAttempts.set(ip, list);
  }

  function workspaceKind(workspace) {
    if (workspace === config.networkWorkspace) return 'network';
    const acc = store.acceleratorByIdentifier(workspace);
    return acc && !acc.departed_at ? 'accelerator' : null;
  }

  // Turn a platform session into an app session — only after asking the platform who it is.
  async function finish(req, res, workspace, jwt, extra = {}) {
    const me = await pm.call('/users/current', { workspace, jwt });
    const user = me.ok && (me.body.user || me.body);
    if (!user || !user.id) throw new HttpError(502, 'Signed in, but could not read your profile');
    // The identity's own workspace is the authority, never what the browser asked for (guide §7.2).
    if (String(user.tenant_enterprise_identifier || '') !== workspace) throw new HttpError(403, 'That account belongs to a different workspace');

    const kind = workspaceKind(workspace);
    let role;
    if (kind === 'network') {
      if (!user.is_admin) throw new HttpError(403, `The ${config.networkName} console is for network administrators`);
      role = 'operator';
    } else {
      role = user.is_admin ? 'accelerator_admin' : 'founder';
    }
    sessions.destroy(sessions.fromRequest(req));          // a new sign-in replaces any previous session
    const s = sessions.create({ workspace, jwt, role, user: summarizeUser(user) });
    sessions.setCookie(res, s);
    sendJson(res, 200, { success: true, ...describe(s), requires_password_change: !!extra.requires_password_change });
  }

  function describe(s) {
    const acc = s.workspace === config.networkWorkspace ? null : store.acceleratorByIdentifier(s.workspace);
    return {
      signed_in: true, role: s.role, workspace: s.workspace, user: s.user,
      accelerator: acc ? { id: acc.id, identifier: acc.identifier, name: acc.name } : null,
    };
  }

  async function login(req, res) {
    limitLogins(req);
    const b = await readJson(req);
    const workspace = str(b.workspace, 100).toLowerCase();
    const login = str(b.email, 200);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!WORKSPACE_RE.test(workspace) || !login || !password) throw new HttpError(400, 'Workspace, email and password are required');
    if (!workspaceKind(workspace)) throw new HttpError(403, `“${workspace}” is not part of ${config.networkName}. Check the workspace name, or ask the network team to refresh the accelerator list.`);

    const r = await pm.call('/authenticate', {
      method: 'POST', workspace,
      body: login.includes('@') ? { email: login, password } : { username: login, password },
    });
    if (r.status === 0) throw new HttpError(502, 'PortableMind is unreachable — try again shortly');
    if (r.status === 402 && r.body.error_type === 'billing_required') {
      throw new HttpError(402, 'This workspace is locked until its billing is set up.', { error_type: 'billing_required' });
    }
    const body = r.body || {};
    // A response without `jwt` is NOT necessarily a wrong password (guide §7.1).
    if (body.jwt) return finish(req, res, workspace, body.jwt, { requires_password_change: body.requires_password_change });
    if (body.mfa_required && body.mfa_token) {
      const id = crypto.randomBytes(24).toString('base64url');
      mfaChallenges.set(id, { workspace, mfa_token: body.mfa_token, at: Date.now() });
      return sendJson(res, 200, { success: true, mfa_required: true, challenge: id });
    }
    if (body.mfa_enrollment_required) {
      throw new HttpError(403, 'Your workspace requires two-factor authentication. Set it up in the PortableMind app first, then sign in here.', { mfa_enrollment_required: true });
    }
    throw new HttpError(401, r.status === 429 ? 'Too many attempts — wait a minute and try again' : 'Email or password is incorrect');
  }

  async function mfa(req, res) {
    const b = await readJson(req);
    const ch = mfaChallenges.get(str(b.challenge, 100));
    const code = str(b.code, 20).replace(/\s/g, '');
    if (!ch || Date.now() - ch.at > MFA_TTL_MS) { mfaChallenges.delete(str(b.challenge, 100)); throw new HttpError(401, 'The sign-in attempt expired — start again'); }
    if (!code) throw new HttpError(400, 'Enter the code from your authenticator app');
    ch.attempts = (ch.attempts || 0) + 1;
    if (ch.attempts > MFA_MAX_ATTEMPTS) { mfaChallenges.delete(str(b.challenge, 100)); throw new HttpError(401, 'Too many wrong codes — start the sign-in again'); }
    const r = await pm.call('/mfa/verify', { method: 'POST', workspace: ch.workspace, body: { mfa_token: ch.mfa_token, code } });
    if (!r.ok || !r.body.token) throw new HttpError(401, messageOf(r, 'That code did not work'));
    mfaChallenges.delete(str(b.challenge, 100));
    // mfa/verify returns the session under `token` (sign-in used `jwt`).
    return finish(req, res, ch.workspace, r.body.token);
  }

  function me(req, res) {
    const s = sessions.fromRequest(req);
    if (!s) return sendJson(res, 200, { success: true, signed_in: false });
    sendJson(res, 200, { success: true, ...describe(s) });
  }

  // Change the signed-in person's password. The platform answers with a NEW session token (all
  // older sessions are revoked), which replaces the one in the server-side session — so this runs
  // here, never through the API pipe. `current_password` is not needed while the password is
  // temporary (requires_password_change).
  async function changePassword(req, res) {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });
    const b = await readJson(req);
    const password = typeof b.password === 'string' ? b.password : '';
    const current = typeof b.current_password === 'string' ? b.current_password : '';
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Choose a password of at least 8 characters');
    const body = current ? { password, current_password: current } : { password };
    const r = await sessions.callAs(s, '/users/current/update_password', { method: 'PUT', body });
    if (!r.ok || !r.body.jwt) {
      throw new HttpError(r.status === 401 ? 400 : (r.status >= 400 ? r.status : 422), messageOf(r, 'Password not changed'));
    }
    s.jwt = r.body.jwt; s.jwtAt = Date.now();
    sendJson(res, 200, { success: true });
  }

  function logout(req, res) {
    sessions.destroy(sessions.fromRequest(req));
    sessions.clearCookie(res);
    sendJson(res, 200, { success: true });
  }

  // Sign-in pages theme themselves before anyone is signed in (guide §7.4). Only for workspaces
  // this app serves.
  async function branding(req, res, url) {
    const workspace = str(url.searchParams.get('w'), 100).toLowerCase();
    if (!WORKSPACE_RE.test(workspace) || !workspaceKind(workspace)) return sendJson(res, 200, { success: true, enabled: false, known: false });
    const r = await pm.call('/public/branding', { workspace, query: { tenant: workspace } });
    const acc = store.acceleratorByIdentifier(workspace);
    sendJson(res, 200, {
      success: true, known: true, kind: workspaceKind(workspace), name: acc ? acc.name : config.networkName,
      ...(r.ok ? pickBranding(r.body) : { enabled: false }),
    });
  }

  // Expire stale MFA challenges.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of mfaChallenges) if (now - v.at > MFA_TTL_MS) mfaChallenges.delete(k);
    for (const [ip, l] of loginAttempts) if (!l.some((t) => now - t < LOGIN_WINDOW_MS)) loginAttempts.delete(ip);
  }, 60 * 1000).unref();

  return { login, mfa, me, logout, branding, finish, workspaceKind, changePassword };
}

// The client's address. Behind a reverse proxy set TRUST_PROXY=1 so X-Forwarded-For is used —
// otherwise every visitor shares the proxy's address and one rate limit.
function clientIp(req, config) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function summarizeUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.display_name || u.username || u.email;
  return { id: u.id, party_id: u.party_id, name, email: u.email || '', username: u.username || '', is_admin: !!u.is_admin };
}

function pickBranding(b) {
  const out = { enabled: !!b.enabled, powered_by: b.powered_by || 'portablemind' };
  if (b.enabled) {
    for (const k of ['app_name', 'logo_url', 'logo_dark_url', 'primary_color']) if (typeof b[k] === 'string') out[k] = b[k];
  }
  return out;
}

module.exports = { createAuthLane, WORKSPACE_RE, clientIp };
