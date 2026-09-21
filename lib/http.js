'use strict';

// Small HTTP helpers shared by every lane.

const MAX_BODY = 256 * 1024;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (_) { throw new HttpError(400, 'Malformed JSON body'); }
}

// Every state-changing or data-returning lane requires this header. A cross-site form or <img>
// cannot set a custom header, and this server sends no CORS headers, so a cross-origin page
// cannot make the browser attach our session cookie to a request that passes this check.
function requireAppHeader(req) {
  if (req.headers['x-requested-with'] !== 'launchpad') throw new HttpError(403, 'Missing X-Requested-With header');
}

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

// Validate a value against an allowlist shape; returns only the listed keys.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { HttpError, sendJson, readBody, readJson, requireAppHeader, applySecurityHeaders, pick, str, posInt, EMAIL_RE };
