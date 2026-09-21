'use strict';

// /api/v1/*  →  PortableMind, as the signed-in user (guide §7.3: "forwarded as-is, carrying the
// signed-in user's own session").
//
// What this lane adds on top of a dumb pipe:
//   - the session token and the Tenant-Id come from the SERVER-SIDE session, never the browser —
//     anything the browser sends in Authorization / Tenant-Id / API-KEY is ignored;
//   - refresh-on-timer and refresh-once-on-401 (lib/sessions.js);
//   - a top-level `tenant_id` in the query or body is refused, because the platform would read it
//     as the CALLING workspace ahead of the header (guide §11 #30);
//   - a short list of endpoints is NOT reachable through the pipe, because each either returns a
//     secret the browser must never see, or is irreversible / needs server-side bookkeeping. Those
//     have dedicated lanes (see server.js).

const { HttpError, sendJson, readJson } = require('../http');

const BLOCKED = [
  // returns the sign-on key in the response body → /lp/op/accelerators/:id/sso-key stores it instead
  { method: '*', re: /\/white_label\/sso_key(\/|$)/, lane: 'the sign-on key lane' },
  // returns an API key's plaintext → /lp/acc/setup/provisioning-key stores it instead
  { method: 'POST', re: /^\/api_keys\/?$/, lane: 'the provisioning-key lane' },
  // sessions are handled by /lp/auth/* (a password change returns a new session token)
  { method: '*', re: /^\/(authenticate|auth\/refresh|mfa\/verify|sso\/exchange)\/?$/, lane: '/lp/auth' },
  { method: '*', re: /^\/users\/current\/update_password\/?$/, lane: '/lp/auth/password' },
  // creating a sub-workspace registers it as pending → /lp/op/accelerators
  { method: 'POST', re: /^\/tenants\/?$/, lane: '/lp/op/accelerators' },
  // deleting one must also destroy the secrets we hold for it
  { method: 'DELETE', re: /^\/tenants\/[^/]+\/?$/, lane: '/lp/op/accelerators/:id' },
  // irreversible: needs a confirmation and an idempotency reference
  { method: 'POST', re: /^\/tenants\/[^/]+\/transfer_tokens\/?$/, lane: '/lp/op/accelerators/:id/transfer' },
  // staff-only; never call it (guide §6.2)
  { method: '*', re: /^\/tenants\/[^/]+\/allocate_tokens\/?$/, lane: null },
  // end users are created only by the provisioning lane, which always sends security_role_iids
  { method: 'POST', re: /^\/users\/?$/, lane: '/lp/founders/signup' },
];

function blockedBy(method, subpath) {
  return BLOCKED.find((b) => (b.method === '*' || b.method === method) && b.re.test(subpath)) || null;
}

// The platform (Rails) collapses repeated slashes and accepts a format suffix, so `//api_keys` and
// `/api_keys.json` reach the same action as `/api_keys`. Match — and FORWARD — only one canonical
// spelling: collapse slashes, drop a trailing slash and any `.format` suffix, and refuse encoded
// separators or dot segments outright. Returns null for a path that is refused.
function canonicalPath(raw) {
  if (/%2f|%5c|%2e|%00|[\\;]/i.test(raw)) return null;
  const segments = raw.split('/').filter(Boolean);
  if (segments.some((seg) => seg === '.' || seg === '..')) return null;
  const clean = segments.map((seg) => seg.replace(/\.[A-Za-z0-9]+$/, ''));
  if (clean.some((seg) => !seg)) return null;
  return '/' + clean.join('/');
}

async function proxyApi(req, res, url, { sessions }) {
  const s = sessions.fromRequest(req);
  if (!s) throw new HttpError(401, 'Not signed in', { session_expired: true });

  const subpath = canonicalPath(url.pathname.slice('/api/v1'.length) || '/');
  if (!subpath) throw new HttpError(400, 'Malformed API path');
  const hit = blockedBy(req.method, subpath);
  if (hit) {
    throw new HttpError(403, hit.lane ? `Not available through the API pipe — use ${hit.lane}` : 'This endpoint is never called by this app');
  }
  if (url.searchParams.has('tenant_id')) throw new HttpError(400, 'A top-level tenant_id parameter is never sent (guide §11 #30)');

  let body;
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    body = await readJson(req);
    if (Object.prototype.hasOwnProperty.call(body, 'tenant_id')) throw new HttpError(400, 'A top-level tenant_id field is never sent (guide §11 #30)');
  }
  // Pass the query through as-is (repeated keys like ids[]= survive).
  const r = await sessions.callAs(s, subpath, { method: req.method, body, rawQuery: url.searchParams });
  if (r.status === 0) return sendJson(res, 502, r.body);
  if (r.status === 401) { sessions.destroy(s); sessions.clearCookie(res); return sendJson(res, 401, { success: false, session_expired: true, message: 'Your session has ended — please sign in again.' }); }
  const retryAfter = r.headers.get('retry-after');
  if (retryAfter) res.setHeader('retry-after', retryAfter);
  sendJson(res, r.status, r.body);
}

module.exports = { proxyApi, blockedBy, canonicalPath };
