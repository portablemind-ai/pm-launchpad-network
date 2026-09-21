'use strict';

// Runtime configuration. There are deliberately NO defaults for anything that decides which
// platform, which workspace or which secrets this server uses: a fork that forgets one variable
// must refuse to start, never run silently against someone else's environment (guide §11 #2).

function required(env, name, hint) {
  const v = (env[name] || '').trim();
  if (!v) throw new Error(`${name} is required${hint ? ` — ${hint}` : ''}`);
  return v;
}

function positiveInt(env, name, dflt) {
  const raw = (env[name] || '').trim();
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function originOf(env, name, { optional = false } = {}) {
  const raw = (env[name] || '').trim();
  if (!raw && optional) return '';
  const v = required(env, name);
  let u;
  try { u = new URL(v); } catch (_) { throw new Error(`${name} must be an absolute URL`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${name} must be http(s)`);
  if (u.username || u.password) throw new Error(`${name} must not carry credentials`);
  return u.origin;
}

function load(env = process.env) {
  const secretKey = required(env, 'SECRET_STORE_KEY', 'generate one with: openssl rand -hex 32');
  if (!/^[0-9a-fA-F]{64}$/.test(secretKey)) throw new Error('SECRET_STORE_KEY must be 64 hex characters (32 bytes)');

  const publicUrl = originOf(env, 'PUBLIC_URL', { optional: true });
  return Object.freeze({
    port: positiveInt(env, 'PORT', 8080),
    // The PortableMind API origin, e.g. https://www.dsiloed.com (production).
    pmApi: originOf(env, 'PM_API'),
    // Where the PortableMind web app is served — the target of white-label sign-on (/sso).
    // Optional: without it the "Open in PortableMind" lane is simply switched off.
    pmAppUrl: originOf(env, 'PM_APP_URL', { optional: true }),
    // The network's own Enterprise workspace identifier (the parent of every accelerator).
    networkWorkspace: required(env, 'NETWORK_WORKSPACE', 'your Enterprise workspace identifier (slug)'),
    networkName: (env.NETWORK_NAME || '').trim() || 'Launchpad Network',
    secretStoreKey: Buffer.from(secretKey, 'hex'),
    dataDir: (env.DATA_DIR || '').trim() || require('path').join(__dirname, '..', 'data'),
    publicUrl,
    trustProxy: /^(1|true|yes)$/i.test((env.TRUST_PROXY || '').trim()),
    // Founders confirm their email before they can sign in (platform activation email). Turn off
    // only for demos on staging: without it anyone can register under someone else's address.
    founderEmailVerification: !/^(0|false|no|off)$/i.test((env.FOUNDER_EMAIL_VERIFICATION || '').trim()),
    // Signs founder "join my startup" links (HMAC), derived from the secret-store key.
    linkKey: require('crypto').createHmac('sha256', Buffer.from(secretKey, 'hex')).update('lp-join-links-v1').digest(),
    cookieSecure: publicUrl.startsWith('https://'),
    backendTimeoutMs: positiveInt(env, 'BACKEND_TIMEOUT_MS', 15000),
    sessionIdleMs: positiveInt(env, 'SESSION_IDLE_HOURS', 12) * 3600 * 1000,
    // How often a session's platform token is refreshed while it is in use (guide §7.1).
    refreshEveryMs: positiveInt(env, 'REFRESH_EVERY_MINUTES', 360) * 60 * 1000,
    // Metrics snapshots count ~80 tables per call (guide §3.6): never more often than this.
    snapshotMinIntervalMs: positiveInt(env, 'SNAPSHOT_MIN_INTERVAL_MINUTES', 60) * 60 * 1000,
  });
}

module.exports = { load };
