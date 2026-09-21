'use strict';

// PortableMind API client. One function, used by every server-side lane.
//
//   - Every call has a timeout (Node's fetch has none by default).
//   - It never throws on an HTTP status: callers get { status, ok, body } and must check BOTH the
//     status and `body.success` — several endpoints answer 200 { success:false } (guide §11 #20).
//   - A network fault / timeout comes back as status 0, so every lane can fail closed on it.
//   - The workspace is always sent as the identifier in `Tenant-Id`, never a numeric id, and a
//     top-level `tenant_id` is never put in a query or body (guide §11 #30).

function createClient({ pmApi, timeoutMs }) {
  async function call(path, { method = 'GET', workspace, jwt, apiKey, body, query, rawQuery } = {}) {
    if (!workspace) throw new Error(`pm.call ${path}: workspace is required`);
    const url = new URL('/api/v1' + path, pmApi);
    if (rawQuery) for (const [k, v] of rawQuery) url.searchParams.append(k, v);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    assertNoTopLevelTenantId(url.searchParams, body);

    const headers = { 'Tenant-Id': workspace, accept: 'application/json' };
    if (jwt) headers.authorization = `Bearer ${jwt}`;
    if (apiKey) headers['api-key'] = apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { status: 0, ok: false, body: { success: false, message: `The service is unreachable: ${e.message}` }, headers: new Headers() };
    }
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { success: false, message: text.slice(0, 300) }; }
    const ok = res.status >= 200 && res.status < 300 && !(parsed && parsed.success === false);
    return { status: res.status, ok, body: parsed, headers: res.headers };
  }

  return { call, origin: pmApi };
}

function assertNoTopLevelTenantId(searchParams, body) {
  if (searchParams.has('tenant_id')) throw new Error('refusing to send a top-level tenant_id query parameter');
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'tenant_id')) {
    throw new Error('refusing to send a top-level tenant_id body field');
  }
}

// A readable message out of any PortableMind error body.
function messageOf(r, fallback = 'Request failed') {
  const b = (r && r.body) || {};
  return b.message || b.error || (Array.isArray(b.errors) ? b.errors.join(', ') : '') || `${fallback} (HTTP ${r ? r.status : '?'})`;
}

module.exports = { createClient, assertNoTopLevelTenantId, messageOf };
