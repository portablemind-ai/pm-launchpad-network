'use strict';

// White-label sign-on assertion (guide §7.4): an HS256 JWT signed with THAT workspace's sign-on
// key, valid for 90 s (the platform allows at most 120 s) and single use (unique jti).
// Only ever called for a user the server has just verified with GET /users/current.

const crypto = require('crypto');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signAssertion({ sub, email, workspace, key, now = Date.now() }) {
  if (!sub || !workspace || !key) throw new Error('signAssertion needs sub, workspace and key');
  const iat = Math.floor(now / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = { sub, tenant_enterprise_identifier: workspace, jti: crypto.randomUUID(), iat, exp: iat + 90 };
  if (email) payload.email = email;
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// Only same-app paths under /app may be a sign-on destination — never an open redirect.
function canonicalDest(raw) {
  const d = String(raw || '/app');
  if (!/^\/app(\/[A-Za-z0-9._~\-/]*)?$/.test(d) || d.includes('..') || d.includes('//')) return '/app';
  return d;
}

module.exports = { signAssertion, canonicalDest };
