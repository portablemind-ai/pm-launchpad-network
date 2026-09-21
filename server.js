#!/usr/bin/env node
'use strict';

/*
 * Launchpad Network — reference app for PortableMind Enterprise workspaces + sub-workspaces.
 *
 * Zero dependencies (Node 20+). One process that:
 *   - serves the single-page UI from an explicit allowlist of files in ./public
 *   - forwards /api/v1/* to PortableMind as the signed-in user (server-side session)
 *   - holds every secret (provisioning keys, sign-on keys, invite codes) per workspace
 *   - exposes a handful of /lp/* lanes for the things only a server may do
 *
 *   Browser ──► this server (same origin) ──► PortableMind API
 *                 /api/v1/*         the user's own session, Tenant-Id from the session
 *                 /lp/auth/*        sign-in (incl. MFA), sign-out, who-am-I, sign-in branding
 *                 /lp/op/*          network console lanes (Enterprise admin)
 *                 /lp/acc/*         accelerator set-up lanes (sub-workspace admin)
 *                 /lp/founders/*    founder sign-up (provisioning key), roster, add teammate,
 *                                   assistants (agents) and programme runs
 *                 /lp/sso/go        white-label sign-on into the PortableMind app
 *                 /config.js        non-secret runtime config
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { load } = require('./lib/config');
const { createClient } = require('./lib/pm');
const { createSessions } = require('./lib/sessions');
const { createSecretStore } = require('./lib/secrets');
const { createStore } = require('./lib/store');
const { HttpError, sendJson, requireAppHeader, applySecurityHeaders } = require('./lib/http');
const { proxyApi } = require('./lib/lanes/proxy');
const { createAuthLane } = require('./lib/lanes/auth');
const { createOperatorLane } = require('./lib/lanes/operator');
const { createAcceleratorLane } = require('./lib/lanes/accelerator');
const { createFounderLanes } = require('./lib/lanes/founders');
const { createFounderWorkLanes } = require('./lib/lanes/founder-work');

function createApp(config) {
  const pm = createClient({ pmApi: config.pmApi, timeoutMs: config.backendTimeoutMs });
  const sessions = createSessions({ pm, idleMs: config.sessionIdleMs, refreshEveryMs: config.refreshEveryMs, cookieSecure: config.cookieSecure });
  const secrets = createSecretStore({ dataDir: config.dataDir, key: config.secretStoreKey });
  const store = createStore({ dataDir: config.dataDir });
  const deps = { pm, sessions, secrets, store, config };
  const auth = createAuthLane(deps);
  const op = createOperatorLane(deps);
  const acc = createAcceleratorLane(deps);
  const founders = createFounderLanes({ ...deps, auth });
  const work = createFounderWorkLanes({ ...deps, founders });

  // [method, pattern, handler(req, res, url, ...captures)]
  const routes = [
    ['POST', /^\/lp\/auth\/login$/, auth.login],
    ['POST', /^\/lp\/auth\/mfa$/, auth.mfa],
    ['GET', /^\/lp\/auth\/me$/, auth.me],
    ['POST', /^\/lp\/auth\/logout$/, auth.logout],
    ['POST', /^\/lp\/auth\/password$/, auth.changePassword],
    ['GET', /^\/lp\/branding$/, auth.branding],

    ['GET', /^\/lp\/op\/overview$/, op.overview],
    ['POST', /^\/lp\/op\/accelerators$/, op.create],
    ['POST', /^\/lp\/op\/accelerators\/(\d+)\/snapshot$/, op.snapshot],
    ['POST', /^\/lp\/op\/accelerators\/(\d+)\/transfer$/, op.transfer],
    ['POST', /^\/lp\/op\/accelerators\/(\d+)\/sso-key$/, op.ssoKey],
    ['POST', /^\/lp\/op\/accelerators\/(\d+)\/delete$/, op.destroy],
    ['POST', /^\/lp\/op\/accelerators\/(\d+)\/forget$/, op.forget],
    ['POST', /^\/lp\/op\/pending\/dismiss$/, op.dismissPending],

    ['GET', /^\/lp\/acc\/setup$/, acc.status],
    ['POST', /^\/lp\/acc\/setup\/founder-role$/, acc.importFounderRole],
    ['POST', /^\/lp\/acc\/setup\/provisioning-key$/, acc.createProvisioningKey],
    ['POST', /^\/lp\/acc\/setup\/app-access$/, acc.syncAppAccess],
    ['POST', /^\/lp\/acc\/setup\/invite-code$/, acc.setInviteCode],
    ['POST', /^\/lp\/acc\/setup\/invite-code\/clear$/, acc.clearInviteCode],
    ['GET', /^\/lp\/acc\/founder-agents$/, acc.founderAgents],
    ['POST', /^\/lp\/acc\/founder-agents$/, acc.setFounderAgent],

    ['POST', /^\/lp\/founders\/signup$/, founders.signup],
    ['GET', /^\/lp\/founders\/me$/, founders.me],
    ['POST', /^\/lp\/founders\/channel$/, founders.channel],
    ['POST', /^\/lp\/founders\/join-link$/, founders.joinLink],
    ['GET', /^\/lp\/founders\/join-info$/, founders.joinInfo],
    ['POST', /^\/lp\/sso\/go$/, founders.ssoGo],

    ['GET', /^\/lp\/founders\/assistants$/, work.assistants],
    ['POST', /^\/lp\/founders\/assistants\/(\d+)\/open$/, work.openAssistant],
    ['POST', /^\/lp\/founders\/assistants\/(\d+)\/send$/, work.sendToAssistant],
    ['POST', /^\/lp\/founders\/runs$/, work.startRun],
    ['GET', /^\/lp\/founders\/runs\/(\d+)\/artifacts\/(\d+)$/, work.artifact],
  ];

  async function handle(req, res) {
    applySecurityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('window.LP_CONFIG = ' + JSON.stringify({
        networkName: config.networkName, networkWorkspace: config.networkWorkspace, ssoConfigured: !!config.pmAppUrl,
      }) + ';\n');
    }
    // `/health` as well: Cloud Run's front end reserves paths ending in `z`, so `/healthz` never
    // reaches the container there.
    if (p === '/healthz' || p === '/health') return sendJson(res, 200, { ok: true });

    if (p.startsWith('/lp/') || p.startsWith('/api/')) {
      requireAppHeader(req);
      if (p.startsWith('/api/v1/')) return proxyApi(req, res, url, deps);
      for (const [method, re, fn] of routes) {
        const m = p.match(re);
        if (m && method === req.method) return fn(req, res, url, ...m.slice(1));
      }
      throw new HttpError(404, 'No such endpoint');
    }
    return serveStatic(res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return sendJson(res, e.status, { success: false, message: e.message, ...e.extra });
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}:`, e && e.stack ? e.stack : e);
      sendJson(res, 500, { success: false, message: 'Internal error' });
    });
  });
  server.requestTimeout = 60_000;
  return { server, deps };
}

// ---- static files: an explicit allowlist, nothing else (guide §11 #12) ----
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/app.css': 'text/css; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
};
function serveStatic(res, p) {
  const file = STATIC[p] ? p : '/index.html';            // unknown paths → the SPA shell (client routing)
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': STATIC[file], 'cache-control': file === '/index.html' ? 'no-store' : 'public, max-age=300' });
    res.end(data);
  });
}

if (require.main === module) {
  let config;
  try { config = load(); } catch (e) {
    console.error(`\n  ✗ Configuration error: ${e.message}\n    See .env.example.\n`);
    process.exit(1);
  }
  const { server } = createApp(config);
  server.listen(config.port, () => {
    console.log(`\n  ${config.networkName} — reference app`);
    console.log(`  ▸ http://localhost:${config.port}`);
    console.log(`  ▸ PortableMind API  ${config.pmApi}   network workspace: ${config.networkWorkspace}`);
    console.log(`  ▸ Sign-on target    ${config.pmAppUrl || '(not configured — "Open in PortableMind" disabled)'}\n`);
  });
}

module.exports = { createApp };
