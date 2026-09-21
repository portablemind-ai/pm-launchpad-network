'use strict';

// Server-side sessions.
//
// The browser holds only an opaque, HttpOnly, SameSite=Strict cookie. The platform session token
// (JWT) stays on this server, so no script on the page can read it (guide §11 #8), and this server
// attaches it to every call it forwards.
//
// Token lifetime (guide §7.1): platform sessions last ~24 h and are revoked by a password change.
//   - refresh on a timer while the session is in use (every REFRESH_EVERY_MINUTES, default 6 h);
//   - on a 401, refresh ONCE and retry ONCE — concurrent 401s share one refresh;
//   - a failed refresh means "signed out", never a retry loop.
// Note the response keys differ: sign-in returns `jwt`, refresh returns `token`.

const crypto = require('crypto');

const COOKIE = 'lp_sid';
const SIGNED_OUT = Object.freeze({ status: 401, ok: false, body: { success: false, message: 'Signed out' }, headers: new Headers() });

function createSessions({ pm, idleMs, refreshEveryMs, cookieSecure }) {
  const sessions = new Map();

  function create({ workspace, jwt, user, role }) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const s = { sid, workspace, jwt, jwtAt: Date.now(), user, role, lastSeen: Date.now(), refreshing: null };
    sessions.set(sid, s);
    return s;
  }

  function fromRequest(req) {
    const sid = parseCookies(req.headers.cookie || '')[COOKIE];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.lastSeen > idleMs) { sessions.delete(sid); return null; }
    s.lastSeen = Date.now();
    return s;
  }

  function destroy(s) { if (s) sessions.delete(s.sid); }

  // Coalesced refresh: every caller that needs a new token while one refresh is in flight awaits
  // the same promise. Resolves true (token replaced) or false (session is over).
  function refresh(s) {
    if (!s.refreshing) {
      s.refreshing = (async () => {
        const r = await pm.call('/auth/refresh', { method: 'POST', workspace: s.workspace, jwt: s.jwt });
        if (r.ok && r.body.token) { s.jwt = r.body.token; s.jwtAt = Date.now(); return true; }
        // Only a definitive refusal ends the session. An outage, a 429 or a 5xx fails THIS request
        // (closed) but keeps the session, so a platform blip does not sign everyone out.
        if (r.status === 401 || r.status === 403) destroy(s);
        return false;
      })().finally(() => { s.refreshing = null; });
    }
    return s.refreshing;
  }

  // Call the platform AS the session's user, with the timer refresh and the 401 refresh-once rule.
  async function callAs(s, path, opts = {}) {
    if (Date.now() - s.jwtAt > refreshEveryMs) await refresh(s);
    if (!sessions.has(s.sid)) return SIGNED_OUT;
    const used = s.jwt;
    let r = await pm.call(path, { ...opts, workspace: s.workspace, jwt: used });
    if (r.status === 401 && sessions.has(s.sid)) {
      // Another request may already have refreshed while this one was in flight.
      if (s.jwt !== used || await refresh(s)) r = await pm.call(path, { ...opts, workspace: s.workspace, jwt: s.jwt });
    }
    return r;
  }

  function setCookie(res, s) {
    const parts = [`${COOKIE}=${s.sid}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (cookieSecure) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }
  function clearCookie(res) {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? '; Secure' : ''}`);
  }

  // Drop idle sessions periodically so memory does not grow without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.lastSeen > idleMs) sessions.delete(sid);
  }, 10 * 60 * 1000);
  sweeper.unref();

  return { create, fromRequest, destroy, refresh, callAs, setCookie, clearCookie, get size() { return sessions.size; } };
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { createSessions, parseCookies };
