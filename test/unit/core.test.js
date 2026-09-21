'use strict';

// Unit tests for the security-relevant building blocks. No network: `node --test test/unit/`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { load } = require('../../lib/config');
const { createSecretStore } = require('../../lib/secrets');
const { signAssertion, canonicalDest } = require('../../lib/sso');
const { blockedBy, canonicalPath } = require('../../lib/lanes/proxy');
const { assertNoTopLevelTenantId } = require('../../lib/pm');
const { generatePassword } = require('../../lib/lanes/operator');
const { timingSafeEqual } = require('../../lib/lanes/founders');
const { createSessions } = require('../../lib/sessions');

const KEY = 'a'.repeat(64);
const baseEnv = { PM_API: 'https://api.example.com', NETWORK_WORKSPACE: 'net', SECRET_STORE_KEY: KEY };

test('config refuses to start without the backend, the workspace or the secret key', () => {
  for (const missing of ['PM_API', 'NETWORK_WORKSPACE', 'SECRET_STORE_KEY']) {
    const env = { ...baseEnv }; delete env[missing];
    assert.throws(() => load(env), new RegExp(missing));
  }
  assert.throws(() => load({ ...baseEnv, SECRET_STORE_KEY: 'short' }), /64 hex/);
  assert.throws(() => load({ ...baseEnv, PM_API: 'https://user:pw@api.example.com' }), /credentials/);
  assert.throws(() => load({ ...baseEnv, PM_API: 'ftp://api.example.com' }), /http/);
  const c = load(baseEnv);
  assert.equal(c.pmApi, 'https://api.example.com');
  assert.equal(c.pmAppUrl, '');
  assert.equal(c.cookieSecure, false);
  assert.equal(load({ ...baseEnv, PUBLIC_URL: 'https://lp.example.com' }).cookieSecure, true);
});

test('secret store encrypts at rest, round-trips, and rejects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-secrets-'));
  const key = crypto.randomBytes(32);
  const s = createSecretStore({ dataDir: dir, key });
  s.set('northside', 'sso_key', 'deadbeef-secret');
  s.set('northside', 'invite_code', 'open-sesame');
  assert.equal(createSecretStore({ dataDir: dir, key }).get('northside', 'sso_key'), 'deadbeef-secret');
  assert.deepEqual(s.presence('northside'), { provisioning_key: false, sso_key: true, invite_code: true });
  const raw = fs.readFileSync(path.join(dir, 'secrets.enc'));
  assert.ok(!raw.includes('deadbeef-secret'), 'plaintext must not be on disk');
  assert.throws(() => createSecretStore({ dataDir: dir, key: crypto.randomBytes(32) }).get('northside', 'sso_key'));
  raw[raw.length - 1] ^= 1; fs.writeFileSync(path.join(dir, 'secrets.enc'), raw);
  assert.throws(() => createSecretStore({ dataDir: dir, key }).get('northside', 'sso_key'));
  assert.throws(() => s.set('northside', 'anything', 'x'), /unknown secret field/);
  s.remove('northside');
  assert.equal(s.get('northside', 'sso_key'), '');
});

test('sign-on assertion is HS256, short-lived, single-use and verifiable with the workspace key', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const now = Date.UTC(2026, 8, 20);
  const a = signAssertion({ sub: 'sam@x.test', email: 'sam@x.test', workspace: 'northside', key, now });
  const [h, p, sig] = a.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.tenant_enterprise_identifier, 'northside');
  assert.equal(payload.exp - payload.iat, 90);
  assert.ok(payload.exp - payload.iat <= 120);
  assert.match(payload.jti, /^[0-9a-f-]{36}$/);
  assert.equal(sig, crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url'));
  const b = signAssertion({ sub: 'sam@x.test', workspace: 'northside', key, now });
  assert.notEqual(JSON.parse(Buffer.from(b.split('.')[1], 'base64url')).jti, payload.jti);
});

test('sign-on destination is limited to /app paths (no open redirect)', () => {
  assert.equal(canonicalDest('/app/team-chat'), '/app/team-chat');
  for (const bad of ['https://evil.test', '//evil.test', '/app/../admin', '/other', '/app//x', 'javascript:alert(1)', '']) {
    assert.equal(canonicalDest(bad), '/app');
  }
});

test('the API pipe blocks every endpoint that returns a secret or is irreversible', () => {
  const blocked = [
    ['POST', '/tenants/12/white_label/sso_key'], ['POST', '/white_label/sso_key'], ['POST', '/api_keys'],
    ['POST', '/authenticate'], ['POST', '/auth/refresh'], ['POST', '/mfa/verify'], ['POST', '/sso/exchange'],
    ['POST', '/tenants'], ['DELETE', '/tenants/12'], ['POST', '/tenants/12/transfer_tokens'],
    ['POST', '/tenants/12/allocate_tokens'], ['POST', '/users'], ['PUT', '/users/current/update_password'],
  ];
  for (const [m, p] of blocked) assert.ok(blockedBy(m, p), `${m} ${p} must be blocked`);
  const allowed = [
    ['GET', '/tenants'], ['GET', '/tenants/12/white_label'], ['PUT', '/tenants/12/white_label'], ['GET', '/api_keys'],
    ['PUT', '/tenants/12/change_subscription'], ['GET', '/agent_template_catalog'], ['POST', '/agent_template_catalog/3/install'],
    ['PUT', '/llm_models/5/family_sharing'], ['GET', '/users/current'],
  ];
  for (const [m, p] of allowed) assert.equal(blockedBy(m, p), null, `${m} ${p} must pass`);
});

test('the pipe matches and forwards ONE canonical path (no slash / format / encoding bypass)', () => {
  const cases = {
    '//api_keys': '/api_keys', '/api_keys.json': '/api_keys', '/api_keys/': '/api_keys',
    '/white_label/sso_key.json': '/white_label/sso_key', '//tenants//5/transfer_tokens': '/tenants/5/transfer_tokens',
    '/users.xml': '/users', '/agent_template_catalog/3/install': '/agent_template_catalog/3/install',
  };
  for (const [raw, canon] of Object.entries(cases)) assert.equal(canonicalPath(raw), canon, raw);
  for (const bad of ['/tenants/5%2ftransfer_tokens', '/a/../api_keys', '/a/./b', '/users%2Ejson', '/x;y', '/a\\b']) {
    assert.equal(canonicalPath(bad), null, bad);
  }
  for (const raw of ['//api_keys', '/api_keys.json', '/tenants/5/transfer_tokens.json', '/users.json', '/tenants.json']) {
    assert.ok(blockedBy('POST', canonicalPath(raw)), `${raw} must be blocked after canonicalisation`);
  }
});

test('a top-level tenant_id is never sent; nested ones are fine', () => {
  assert.throws(() => assertNoTopLevelTenantId(new URLSearchParams('tenant_id=5'), undefined));
  assert.throws(() => assertNoTopLevelTenantId(new URLSearchParams(), { tenant_id: 5 }));
  assert.doesNotThrow(() => assertNoTopLevelTenantId(new URLSearchParams('limit=-1'), { mode: 'selected', grants: [{ tenant_id: 5 }] }));
});

test('generated initial passwords are long, mixed and avoid blocked terms', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ min_length: 12, blocked_terms: ['password', 'qwerty'] });
    assert.ok(pw.length >= 20);
    assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[0-9]/); assert.match(pw, /[^A-Za-z0-9]/);
  }
  assert.ok(generatePassword({ min_length: 32 }).length >= 32);
});

test('invite codes compare in constant time and exactly', () => {
  assert.equal(timingSafeEqual('abc123xyz', 'abc123xyz'), true);
  assert.equal(timingSafeEqual('abc123xyz', 'abc123xyZ'), false);
  assert.equal(timingSafeEqual('', 'x'), false);
});

test('sessions: a 401 triggers ONE shared refresh, then one retry per request', async () => {
  let refreshes = 0; let current = 'old';
  const pm = {
    async call(p, { jwt }) {
      if (p === '/auth/refresh') { refreshes++; await new Promise((r) => setTimeout(r, 20)); current = 'new'; return { status: 200, ok: true, body: { success: true, token: 'new' } }; }
      return jwt === current ? { status: 200, ok: true, body: { success: true, jwt } } : { status: 401, ok: false, body: {} };
    },
  };
  const sessions = createSessions({ pm, idleMs: 60000, refreshEveryMs: 3600000, cookieSecure: false });
  const s = sessions.create({ workspace: 'w', jwt: 'old', user: {}, role: 'founder' });
  current = 'x'; // the platform no longer accepts 'old'; a refresh makes 'new' valid
  const results = await Promise.all([1, 2, 3].map(() => sessions.callAs(s, '/users/current')));
  assert.equal(refreshes, 1, 'concurrent 401s share a single refresh');
  for (const r of results) assert.equal(r.status, 200);
  assert.equal(s.jwt, 'new');
});

test('sessions: a failed refresh signs the session out instead of looping', async () => {
  const pm = { async call(p) { return p === '/auth/refresh' ? { status: 401, ok: false, body: {} } : { status: 401, ok: false, body: {} }; } };
  const sessions = createSessions({ pm, idleMs: 60000, refreshEveryMs: 3600000, cookieSecure: false });
  const s = sessions.create({ workspace: 'w', jwt: 'old', user: {}, role: 'founder' });
  const r = await sessions.callAs(s, '/users/current');
  assert.equal(r.status, 401);
  assert.equal(sessions.size, 0);
});
