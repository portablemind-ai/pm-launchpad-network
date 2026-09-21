'use strict';
/*
 * Launchpad Network — single-page UI. No framework, no build step.
 *
 * Every request goes to THIS app's server (same origin):
 *   /lp/*       lanes that need the server (sessions, secrets, irreversible actions)
 *   /api/v1/*   PortableMind, forwarded as the signed-in user
 * The browser never holds a PortableMind token, key or secret. All data is rendered with
 * textContent (the h() helper) — never innerHTML.
 */
(() => {
  const CFG = window.LP_CONFIG || {};
  const NETWORK = CFG.networkName || 'Launchpad Network';

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

  const fmt = {
    num: (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US')),
    tokens: (n) => {
      if (n == null) return '—';
      const v = Number(n);
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 2) + 'M';
      if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + 'K';
      return String(v);
    },
    usd: (n) => (n == null ? '—' : '$' + Number(n).toFixed(2)),
    cents: (c) => (c == null ? '—' : '$' + (Number(c) / 100).toFixed(2)),
    date: (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'),
    ago: (s) => {
      if (!s) return 'never';
      const m = Math.round((Date.now() - Date.parse(s)) / 60000);
      if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
      const hrs = Math.round(m / 60); if (hrs < 48) return `${hrs} h ago`;
      return `${Math.round(hrs / 24)} days ago`;
    },
    cap: (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : ''),
  };

  // ---------- toasts, modals, drawers ----------
  function toast(msg, kind = '') {
    const t = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
  }
  function modal(title, body, actions = []) {
    const root = $('#modal-root');
    const close = () => clear(root);
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', {}, h('h2', {}, title), h('button', { class: 'ghost', onclick: close, 'aria-label': 'Close' }, '✕')),
      body,
      actions.length ? h('div', { class: 'actions' }, actions) : null);
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, box);
    clear(root).append(backdrop);
    const first = box.querySelector('input, select, textarea, button:not(.ghost)');
    if (first) first.focus();
    return { close, box };
  }
  function drawer(content) {
    closeDrawer();
    const d = h('aside', { class: 'drawer', id: 'drawer' },
      h('div', { class: 'close' }, h('button', { class: 'ghost', onclick: closeDrawer }, 'Close ✕')),
      h('div', { class: 'inner' }, content));
    document.body.append(d);
    return d;
  }
  function closeDrawer() { const d = $('#drawer'); if (d) d.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clear($('#modal-root')); closeDrawer(); } });

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, body) { super((body && (body.message || body.error)) || `Request failed (${status})`); this.status = status; this.body = body || {}; }
  }
  async function api(path, { method = 'GET', body, quiet = false } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: { 'X-Requested-With': 'launchpad', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) { if (!quiet) toast('Network error — is the server running?', 'bad'); throw new ApiError(0, { message: e.message }); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    // HTTP 200 with success:false is a failure too (guide §11 #20).
    if (res.ok && data.success !== false) return data;
    const err = new ApiError(res.status, data);
    if (res.status === 401 && data.session_expired) { onSignedOut('Your session has ended — please sign in again.'); throw err; }
    // 402: billing-only mode is handled GLOBALLY, not on whatever screen made the call (guide §7.5).
    if (res.status === 402 && data.error_type === 'billing_required') { showBillingLocked(); throw err; }
    if (res.status === 402) { toast(`Plan limit reached: ${err.message}`, 'bad'); throw err; }
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      toast(`Slow down — try again${wait ? ` in ${wait}s` : ' shortly'}.`, 'bad'); throw err;
    }
    if (!quiet) toast(err.message, 'bad');
    throw err;
  }
  const pmGet = (p, quiet) => api('/api/v1' + p, { quiet });
  const pmSend = (method, p, body, quiet) => api('/api/v1' + p, { method, body, quiet });

  // ---------- session + routing ----------
  let me = null;           // { role, workspace, user, accelerator }
  let branding = null;

  const ROUTES = {
    operator: [
      ['overview', 'Accelerators', viewOpOverview],
      ['templates', 'Agent templates', viewOpTemplates],
      ['models', 'Shared models', viewOpModels],
      ['spend', 'Spend & tokens', viewOpSpend],
    ],
    accelerator_admin: [
      ['setup', 'Set-up', viewAccSetup],
      ['catalog', 'Agent catalog', viewAccCatalog],
      ['agents', 'Installed agents', viewAccAgents],
      ['startups', 'Startups', viewAccStartups],
      ['usage', 'Usage & plan', viewAccUsage],
    ],
    founder: [
      ['startup', 'My startup', viewFounderStartup],
      ['files', 'Files', viewFounderFiles],
      ['runs', 'Programme runs', viewFounderRuns],
    ],
  };

  function currentHash() { return (location.hash || '').replace(/^#\/?/, ''); }
  function go(path) { if (currentHash() !== path) location.hash = '#/' + path; else render(); }

  async function boot() {
    try { const r = await api('/lp/auth/me', { quiet: true }); me = r.signed_in ? r : null; } catch (_) { me = null; }
    window.addEventListener('hashchange', render);
    $('#logout-btn').addEventListener('click', async () => { await api('/lp/auth/logout', { method: 'POST', quiet: true }).catch(() => {}); onSignedOut(); });
    $('#sso-btn').addEventListener('click', () => openPortableMind('/app'));
    render();
  }

  function onSignedOut(message) {
    me = null; closeDrawer(); clear($('#modal-root'));
    if (message) toast(message);
    go('signin');
  }

  function render() {
    const path = currentHash();
    closeDrawer();
    if (path.startsWith('signup')) return viewSignup();
    if (!me) return viewSignin();
    const routes = ROUTES[me.role] || [];
    const [key] = path.split('/');
    const hit = routes.find((r) => r[0] === key) || routes[0];
    if (!hit) return viewSignin();
    if (key !== hit[0]) { history.replaceState(null, '', '#/' + hit[0]); }
    shell(routes, hit[0]);
    const main = clear($('#main'));
    main.append(h('div', { class: 'empty' }, 'Loading…'));
    Promise.resolve(hit[2](main)).catch((e) => {
      clear(main).append(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message || String(e))));
    });
  }

  function shell(routes, active) {
    $('#topbar').hidden = false;
    const nav = clear($('#nav'));
    for (const [key, label] of routes) nav.append(h('a', { href: `#/${key}`, class: key === active ? 'active' : '' }, label));
    const roleLabel = { operator: 'Network console', accelerator_admin: 'Accelerator admin', founder: 'Founder' }[me.role];
    $('#role-chip').textContent = roleLabel;
    $('#brand-name').textContent = me.accelerator ? me.accelerator.name : NETWORK;
    $('#who-name').textContent = me.user.name;
    $('#sso-btn').hidden = !(CFG.ssoConfigured && me.role !== 'operator');
    applyBranding(me.workspace);
  }

  async function applyBranding(workspace) {
    if (branding && branding._ws === workspace) return paintBranding();
    try { branding = await api('/lp/branding?w=' + encodeURIComponent(workspace), { quiet: true }); branding._ws = workspace; } catch (_) { branding = { enabled: false, _ws: workspace }; }
    paintBranding();
  }
  function paintBranding() {
    const b = branding || {};
    const color = b.enabled && /^#[0-9a-f]{3,8}$/i.test(b.primary_color || '') ? b.primary_color : '';
    document.documentElement.style.setProperty('--brand', color || '#2f5bea');
    const logo = $('#brand-logo');
    if (b.enabled && b.logo_url && /^https:\/\//.test(b.logo_url)) { logo.src = b.logo_url; logo.hidden = false; $('#brand-mark').hidden = true; }
    else { logo.hidden = true; $('#brand-mark').hidden = false; }
    if (b.enabled && b.app_name) $('#brand-name').textContent = b.app_name;
    // "powered by" always has a value on the platform (guide §7.4).
    $('#powered').textContent = `${NETWORK} · powered by ${b.powered_by === 'portablemind' || !b.powered_by ? 'PortableMind' : b.powered_by}`;
  }

  function showBillingLocked() {
    const main = clear($('#main'));
    main.append(h('div', { class: 'card' },
      h('h1', {}, 'This workspace is locked for billing'),
      h('p', {}, 'Its coverage under the network’s agreement has ended and the grace period is over. Nothing has been deleted.'),
      h('p', {}, 'Only an administrator of this workspace can restore access, by choosing a plan and adding their own card in the PortableMind app (Administration → Billing).'),
      me && me.role !== 'operator' && CFG.ssoConfigured ? h('button', { onclick: () => openPortableMind('/app/admin/billing') }, 'Open billing in PortableMind ↗') : null));
  }

  async function openPortableMind(dest) {
    try {
      const r = await api('/lp/sso/go', { method: 'POST', body: { dest } });
      window.open(r.url, '_blank', 'noopener');
    } catch (_) { /* toast already shown */ }
  }

  // ---------- sign-in ----------
  function workspaceFromUrl() {
    const q = new URLSearchParams(location.search).get('w');
    if (q) return q.toLowerCase();
    try { return localStorage.getItem('lp.workspace') || ''; } catch (_) { return ''; }
  }

  function authCard(title, subtitle, body) {
    $('#topbar').hidden = true;
    const main = clear($('#main'));
    const logo = h('img', { alt: '', hidden: true });
    const mark = h('span', { class: 'brand-mark' }, '◆');
    const name = h('span', {}, NETWORK);
    const card = h('div', { class: 'card auth-card' }, h('div', { class: 'brand' }, logo, mark, name), h('h1', {}, title), h('p', { class: 'lede' }, subtitle), body);
    main.append(h('div', { class: 'auth-wrap' }, card));
    return {
      async theme(ws) {
        if (!ws) return;
        try {
          const b = await api('/lp/branding?w=' + encodeURIComponent(ws), { quiet: true });
          branding = { ...b, _ws: ws };
          name.textContent = (b.enabled && b.app_name) || b.name || NETWORK;
          if (b.enabled && b.logo_url && /^https:\/\//.test(b.logo_url)) { logo.src = b.logo_url; logo.hidden = false; mark.hidden = true; }
          document.documentElement.style.setProperty('--brand', b.enabled && /^#[0-9a-f]{3,8}$/i.test(b.primary_color || '') ? b.primary_color : '#2f5bea');
          $('#powered').textContent = `powered by ${b.powered_by === 'portablemind' || !b.powered_by ? 'PortableMind' : b.powered_by}`;
        } catch (_) { /* unthemed is fine */ }
      },
    };
  }

  function viewSignin() {
    const ws = h('input', { id: 'ws', autocomplete: 'organization', placeholder: CFG.networkWorkspace, value: workspaceFromUrl() || CFG.networkWorkspace || '' });
    const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
    const err = h('div', { class: 'notice bad', hidden: true });
    const submit = h('button', { type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: 'ws' }, 'Workspace'), ws,
        h('div', { class: 'hint' }, `Your accelerator’s workspace name — or “${CFG.networkWorkspace}” for the network console.`)),
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
      h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), pw),
      err, h('div', { class: 'row between' }, submit, h('a', { href: '#/signup' + (ws.value && ws.value !== CFG.networkWorkspace ? '?w=' + encodeURIComponent(ws.value) : '') }, 'Founder? Register your startup')));
    const card = authCard('Sign in', `${NETWORK} — accelerators, startups and their AI agents.`, form);
    card.theme(ws.value);
    ws.addEventListener('change', () => card.theme(ws.value.trim().toLowerCase()));

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; submit.disabled = true;
      const workspace = ws.value.trim().toLowerCase();
      try {
        const r = await api('/lp/auth/login', { method: 'POST', body: { workspace, email: email.value, password: pw.value }, quiet: true });
        try { localStorage.setItem('lp.workspace', workspace); } catch (_) { /* private mode */ }
        if (r.mfa_required) return viewMfa(r.challenge);
        me = r;
        if (r.requires_password_change) return viewSetPassword();
        go('');
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
      } finally { submit.disabled = false; }
    });
  }

  // Shown right after signing in on a TEMPORARY password (requires_password_change): the platform
  // would force this change in its own app too. The new session token stays on the server.
  function viewSetPassword() {
    const pw = h('input', { id: 'np', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const pw2 = h('input', { id: 'np2', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const err = h('div', { class: 'notice bad', hidden: true });
    const btn = h('button', { type: 'submit' }, 'Set password and continue');
    const form = h('form', {},
      h('div', { class: 'field' }, h('label', { for: 'np' }, 'New password'), pw, h('div', { class: 'hint' }, 'At least 8 characters. Only you will know it.')),
      h('div', { class: 'field' }, h('label', { for: 'np2' }, 'Repeat it'), pw2), err, btn);
    authCard('Choose your own password', 'You signed in with a password someone else set for you. Replace it before you continue.', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      if (pw.value !== pw2.value) { err.textContent = 'The two passwords do not match.'; err.hidden = false; return; }
      btn.disabled = true;
      try { await api('/lp/auth/password', { method: 'POST', body: { password: pw.value }, quiet: true }); toast('Password changed.', 'good'); go(''); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
    });
  }

  function viewMfa(challenge) {
    const code = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12 });
    const err = h('div', { class: 'notice bad', hidden: true });
    const form = h('form', {}, h('div', { class: 'field' }, h('label', { for: 'code' }, 'Authentication code'), code), err, h('button', { type: 'submit' }, 'Verify'));
    authCard('Two-factor authentication', 'Enter the 6-digit code from your authenticator app (or a recovery code).', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      try { me = await api('/lp/auth/mfa', { method: 'POST', body: { challenge, code: code.value }, quiet: true }); go(''); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  }

  // ---------- founder self-registration ----------
  function viewSignup() {
    const params = new URLSearchParams((currentHash().split('?')[1]) || location.search.slice(1));
    const joinToken = params.get('join') || '';
    const f = {
      workspace: h('input', { id: 'su-ws', value: params.get('w') || workspaceFromUrl() || '', required: true }),
      invite_code: h('input', { id: 'su-code', value: params.get('code') || '', required: !joinToken, autocomplete: 'off' }),
      startup_name: h('input', { id: 'su-startup', required: !joinToken }),
      first_name: h('input', { id: 'su-first', required: true, autocomplete: 'given-name' }),
      last_name: h('input', { id: 'su-last', required: true, autocomplete: 'family-name' }),
      email: h('input', { id: 'su-email', type: 'email', required: true, autocomplete: 'email' }),
      password: h('input', { id: 'su-pw', type: 'password', required: true, autocomplete: 'new-password', minlength: 8 }),
    };
    const joining = h('div', { class: 'notice', hidden: !joinToken }, 'Checking your invitation…');
    const err = h('div', { class: 'notice bad', hidden: true });
    const submit = h('button', { type: 'submit' }, joinToken ? 'Join the team' : 'Create my startup');
    const fld = (id, label, input, hint) => h('div', { class: 'field', hidden: input.dataset.hide === '1' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
    const newStartupFields = joinToken ? [] : [
      fld('su-code', 'Invite code', f.invite_code),
      fld('su-startup', 'Startup name', f.startup_name, 'Your team is created with this name. Invite colleagues from inside.'),
    ];
    const form = h('form', {},
      joining,
      h('div', { hidden: !!joinToken }, fld('su-ws', 'Accelerator workspace', f.workspace, 'Your accelerator gives you this, with the invite code.')),
      newStartupFields,
      h('div', { class: 'form-grid' }, fld('su-first', 'First name', f.first_name), fld('su-last', 'Last name', f.last_name)),
      fld('su-email', 'Work email', f.email, 'We email you a link to confirm it before you can sign in.'),
      fld('su-pw', 'Password', f.password, 'At least 8 characters.'),
      err, h('div', { class: 'row between' }, submit, h('a', { href: '#/signin' }, 'Already registered? Sign in')));
    const card = authCard(joinToken ? 'Join your startup' : 'Register your startup',
      joinToken ? 'A colleague invited you to their startup’s space.' : 'Join your accelerator on the network. Your startup gets its own private team space.', form);
    card.theme(f.workspace.value);
    f.workspace.addEventListener('change', () => card.theme(f.workspace.value.trim().toLowerCase()));
    if (joinToken) {
      api('/lp/founders/join-info?token=' + encodeURIComponent(joinToken), { quiet: true }).then((info) => {
        if (!info.valid) { joining.className = 'notice bad'; joining.textContent = 'This invitation link is invalid or has expired. Ask your colleague for a new one.'; submit.disabled = true; return; }
        f.workspace.value = info.workspace; card.theme(info.workspace);
        joining.textContent = `You are joining ${info.team_name || 'a startup team'}. The link works until ${fmt.date(info.expires_at)}.`;
      }).catch(() => {});
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; submit.disabled = true;
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
      body.workspace = body.workspace.toLowerCase(); body.password = f.password.value;
      if (joinToken) { body.join = joinToken; delete body.invite_code; delete body.startup_name; }
      try {
        const r = await api('/lp/founders/signup', { method: 'POST', body, quiet: true });
        try { localStorage.setItem('lp.workspace', body.workspace); } catch (_) { /* ignore */ }
        if (r.signed_in) { me = r; toast('Welcome aboard!', 'good'); go('startup'); return; }
        if (r.verify_email) {
          authCard('Check your email', `We sent a confirmation link to ${body.email}.`, h('div', {},
            h('p', {}, 'Click the link in that email to activate your account, then come back here and sign in with the password you just chose.'),
            h('p', { class: 'muted small' }, 'Nothing there after a few minutes? Check your spam folder, or ask your accelerator.'),
            h('a', { href: '#/signin', class: 'btn' }, 'Go to sign-in')));
          return;
        }
        toast('Account created — please sign in.', 'good'); go('signin');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { submit.disabled = false; }
    });
  }

  // =====================================================================================
  // NETWORK CONSOLE (operator = admin of the Enterprise workspace)
  // =====================================================================================
  const TIERS = ['free', 'starter', 'professional', 'business'];
  let opCache = null; // last /lp/op/overview

  function randomRef(prefix) {
    const b = new Uint8Array(12); crypto.getRandomValues(b);
    return `${prefix}-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  function kpi(label, value, sub) { return h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null); }
  function fld(id, label, input, hint) { input.id = input.id || id; return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null); }
  async function loadOverview() { opCache = await api('/lp/op/overview'); return opCache; }

  async function viewOpOverview(main) {
    const d = await loadOverview();
    const a = d.agreement;
    clear(main);
    main.append(
      h('div', { class: 'row between' },
        h('div', {}, h('h1', {}, 'Accelerators'), h('p', { class: 'lede' }, 'One sub-workspace per accelerator. Startups live inside them as teams.')),
        h('div', { class: 'row' },
          h('button', { class: 'ghost', onclick: () => render() }, 'Refresh'),
          h('button', { onclick: () => createAcceleratorModal(d), disabled: !a || a.role !== 'holder' }, '+ New accelerator'))),
    );
    if (!a || a.role !== 'holder') {
      main.append(h('div', { class: 'notice warn' }, 'No active billing agreement is recorded on this workspace, so new accelerators cannot be created. Ask PortableMind for an agreement with an allowance and a contract tier (guide §2).'));
    }
    main.append(h('div', { class: 'grid kpis' },
      kpi('Allowance in use', a ? `${a.covered_count} / ${a.sub_tenant_allowance}` : '—', 'sub-workspaces under the agreement'),
      kpi('Contract tier', a ? fmt.cap(a.contract_tier) : '—', 'highest plan you may assign'),
      kpi('Accelerators', fmt.num(d.accelerators.length), `${d.pending.length} awaiting activation`),
      kpi('People', fmt.num(d.accelerators.reduce((n, x) => n + (Number(x.stats.users) || 0), 0)), 'across all accelerators — no seat pricing'),
      kpi('Template publishing', d.publishing ? 'On' : 'Off', d.publishing ? 'Enterprise entitlement' : 'needs Enterprise'),
    ));

    const card = h('div', { class: 'card' }, h('h2', {}, 'Your accelerators'));
    if (!d.accelerators.length) card.append(h('div', { class: 'empty' }, 'No accelerators yet. Create the first one — it takes a minute.'));
    else {
      const rows = d.accelerators.map((x) => h('tr', { class: 'clickable', onclick: () => acceleratorDrawer(x.id) },
        h('td', {}, h('div', {}, x.name), h('div', { class: 'mono muted' }, x.identifier)),
        h('td', {}, h('span', { class: 'pill brand' }, fmt.cap(x.plan || '?')), ' ', x.subscription_status !== 'active' ? h('span', { class: 'pill warn' }, x.subscription_status) : null),
        h('td', { class: 'num' }, fmt.num(x.stats.users)),
        h('td', { class: 'num' }, fmt.num(x.stats.active_users_7d)),
        h('td', { class: 'num' }, fmt.num(x.snapshot ? x.snapshot.counts.agents : x.stats.agents)),
        h('td', { class: 'num' }, fmt.tokens(x.token_balance)),
        h('td', { class: 'num' }, x.snapshot ? fmt.cents(x.snapshot.ai_cost_30d_cents) : h('span', { class: 'muted' }, '—')),
        h('td', {}, x.secrets.sso_key ? h('span', { class: 'pill good' }, 'Sign-on ready') : h('span', { class: 'pill' }, 'No sign-on key')),
        h('td', { class: 'muted small' }, x.snapshot ? fmt.ago(x.snapshot.at) : 'no snapshot')));
      card.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Accelerator', 'Plan', 'People', 'Active 7d', 'Agents', 'Tokens', 'AI cost 30d', 'Sign-on', 'Metrics'].map((t, i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '' }, t)))),
        h('tbody', {}, rows))));
      card.append(h('p', { class: 'muted small' }, 'People, active users and tokens are live. Agents and AI cost come from the last metrics snapshot — the full count is heavy, so it is taken on demand at most once an hour and stored. You see names and numbers, never an accelerator’s conversations or files.'));
    }
    main.append(card);

    if (d.pending.length) {
      main.append(h('div', { class: 'card' }, h('h2', {}, 'Awaiting activation'),
        h('p', { class: 'muted' }, 'The platform builds a sub-workspace only when its first admin activates from the email. It appears above once they do.'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'First admin', 'Plan', 'Requested', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, d.pending.map((p) => h('tr', {},
            h('td', {}, p.name, p.requested_identifier ? h('div', { class: 'mono muted' }, p.requested_identifier) : null),
            h('td', {}, p.email), h('td', {}, fmt.cap(p.plan)), h('td', { class: 'muted' }, fmt.ago(p.requested_at)),
            h('td', {}, h('button', { class: 'link', onclick: async () => { await api('/lp/op/pending/dismiss', { method: 'POST', body: { email: p.email } }); render(); } }, 'Dismiss'))))))));
    }
    if (d.departed && d.departed.length) {
      main.append(h('div', { class: 'card' }, h('h2', {}, 'Left the network'),
        h('p', { class: 'muted' }, 'These no longer appear in your workspace list (offboarded, detached or deleted). Their people cannot sign in here. The secrets this app holds for them are kept until you forget them.'),
        h('table', {}, h('tbody', {}, d.departed.map((x) => h('tr', {},
          h('td', {}, x.name, h('div', { class: 'mono muted' }, x.identifier)), h('td', { class: 'muted' }, `since ${fmt.date(x.departed_at)}`),
          h('td', {}, h('button', { class: 'ghost', onclick: () => forgetModal(x) }, 'Forget…'))))))));
    }
    if (d.transfers.length) {
      main.append(h('div', { class: 'card' }, h('h2', {}, 'Recent token transfers'),
        h('table', {}, h('thead', {}, h('tr', {}, ['When', 'To', 'Amount', 'By', 'Reference'].map((t, i) => h('th', { class: i === 2 ? 'num' : '' }, t)))),
          h('tbody', {}, d.transfers.map((t) => h('tr', {}, h('td', {}, fmt.ago(t.at)), h('td', { class: 'mono' }, t.identifier), h('td', { class: 'num' }, fmt.num(t.amount)), h('td', {}, t.by), h('td', { class: 'mono muted small' }, t.reference)))))));
    }
  }

  function createAcceleratorModal(d) {
    const top = TIERS.indexOf(d.agreement.contract_tier);
    const f = {
      name: h('input', { required: true, placeholder: 'Northside Accelerator' }),
      identifier: h('input', { placeholder: 'northside (optional)', pattern: '[a-z0-9][a-z0-9\\-]{1,48}[a-z0-9]' }),
      first_name: h('input', { required: true }), last_name: h('input', { required: true }),
      email: h('input', { type: 'email', required: true }),
      plan: h('select', {}, TIERS.slice(0, top + 1).map((t) => h('option', { value: t, selected: t === (top >= 2 ? 'professional' : TIERS[top]) }, fmt.cap(t)))),
    };
    const mode = { email: h('input', { type: 'radio', name: 'act', value: 'email', checked: true }), direct: h('input', { type: 'radio', name: 'act', value: 'direct' }) };
    const err = h('div', { class: 'notice bad', hidden: true });
    const submit = h('button', { type: 'submit' }, 'Create accelerator');
    const form = h('form', {},
      fld('na-name', 'Accelerator name', f.name),
      fld('na-ident', 'Workspace identifier', f.identifier, 'Optional. If it is taken the platform silently picks another — this app reads the real one back.'),
      h('h3', {}, 'First administrator'),
      h('div', { class: 'form-grid' }, fld('na-first', 'First name', f.first_name), fld('na-last', 'Last name', f.last_name)),
      fld('na-email', 'Email', f.email),
      fld('na-plan', 'Plan', f.plan, `Up to your contract tier (${d.agreement.contract_tier}). A Free sub-workspace starts with zero AI tokens and one agent.`),
      h('div', { class: 'field' }, h('label', {}, 'Activation'),
        h('label', { class: 'check' }, mode.email, h('span', {}, h('b', {}, 'Email the admin to activate'), h('div', { class: 'muted small' }, 'The workspace is built when they click the link. It stays “awaiting activation” until then.'))),
        h('label', { class: 'check' }, mode.direct, h('span', {}, h('b', {}, 'Create it now'), h('div', { class: 'muted small' }, 'Built immediately, no email. You hand the first admin their initial password.')))),
      h('p', { class: 'muted small' }, `It counts toward your allowance (${d.agreement.covered_count}/${d.agreement.sub_tenant_allowance}) from the moment it exists, free plans included.`),
      err, h('div', { class: 'actions' }, submit));
    const m = modal('New accelerator', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; submit.disabled = true;
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
      body.activation = mode.direct.checked ? 'direct' : 'email';
      try {
        const r = await api('/lp/op/accelerators', { method: 'POST', body, quiet: true });
        m.close();
        const lines = [];
        if (r.state === 'created') lines.push(h('div', { class: 'notice good' }, `${r.accelerator.name} is live as `, h('code', {}, r.accelerator.identifier), '.'));
        else lines.push(h('div', { class: 'notice' }, `An activation email is on its way to ${body.email}. The accelerator appears in your list once they activate.`));
        if (r.identifier_changed) lines.push(h('div', { class: 'notice warn' }, `The identifier you asked for was taken; the platform assigned `, h('code', {}, r.accelerator.identifier), '.'));
        lines.push(h('p', {}, h('b', {}, 'Initial password for the first admin'), ' — shown once, hand it over securely and ask them to change it:'), h('div', { class: 'secret-once' }, r.initial_password));
        modal('Accelerator requested', h('div', {}, lines), [h('button', { onclick: () => { clear($('#modal-root')); render(); } }, 'Done')]);
      } catch (ex) { err.textContent = ex.message + (ex.body.code ? ` (${ex.body.code})` : ''); err.hidden = false; } finally { submit.disabled = false; }
    });
  }

  async function acceleratorDrawer(id) {
    const x = (opCache.accelerators || []).find((a) => a.id === id);
    if (!x) return;
    const body = h('div', {});
    drawer(body);
    const section = (title, ...kids) => h('div', { class: 'card' }, h('h2', {}, title), kids);

    // --- metrics
    const metrics = h('div', {});
    const paintMetrics = (s) => {
      clear(metrics);
      if (!s) { metrics.append(h('p', { class: 'muted' }, 'No snapshot yet.')); return; }
      metrics.append(h('div', { class: 'grid kpis' },
        kpi('Agents', fmt.num(s.counts.agents)), kpi('Agent runs', fmt.num(s.counts.agent_runs)),
        kpi('Orchestration runs', fmt.num(s.counts.orchestration_runs)), kpi('People', fmt.num(s.counts.people)),
        kpi('Conversations', fmt.num(s.counts.conversations)), kpi('Projects', fmt.num(s.counts.projects)),
        kpi('Active 30d', fmt.num(s.activity.active_users_30d)), kpi('AI cost 30d', fmt.cents(s.ai_cost_30d_cents))),
      h('p', { class: 'muted small' }, `Snapshot ${fmt.ago(s.at)} · last activity ${fmt.ago(s.activity.last_seen_at)}`));
    };
    paintMetrics(x.snapshot);
    const snapBtn = h('button', { class: 'ghost', onclick: async () => {
      snapBtn.disabled = true;
      try { const r = await api(`/lp/op/accelerators/${x.id}/snapshot`, { method: 'POST' }); x.snapshot = r.snapshot; paintMetrics(r.snapshot); if (r.throttled) toast('Showing the stored snapshot — taken less than an hour ago.'); }
      finally { snapBtn.disabled = false; }
    } }, 'Take metrics snapshot');

    // --- plan
    const planSel = h('select', {}, TIERS.slice(0, TIERS.indexOf(opCache.agreement ? opCache.agreement.contract_tier : 'business') + 1).map((t) => h('option', { value: t, selected: t === x.plan }, fmt.cap(t))));
    const planBtn = h('button', { class: 'ghost', onclick: async () => {
      const t = planSel.value; if (t === x.plan) return;
      planBtn.disabled = true;
      try { await pmSend('PUT', `/tenants/${x.id}/change_subscription`, { product_type: t, pricing_plan: `${t}_usd` }); toast(`Plan changed to ${fmt.cap(t)}`, 'good'); x.plan = t; }
      finally { planBtn.disabled = false; }
    } }, 'Change plan');

    body.append(
      h('h1', {}, x.name), h('p', { class: 'lede' }, h('code', {}, x.identifier), ` · #${x.id} · created ${fmt.date(x.created_at)}`, x.root_user ? ` · first admin ${x.root_user.name} <${x.root_user.email}>` : ''),
      section('Metrics', metrics, snapBtn),
      section('Plan', h('div', { class: 'row' }, planSel, planBtn), h('p', { class: 'muted small' }, 'Billing is covered by your agreement; the accelerator cannot change its own plan. A plan change is never a token refill.')),
      section('AI tokens', h('p', {}, 'Balance: ', h('b', {}, fmt.num(x.token_balance)), ' tokens'),
        h('button', { onclick: () => transferModal(x) }, 'Transfer tokens…'),
        h('p', { class: 'muted small' }, 'Moves tokens your network has PURCHASED. Your monthly plan allowance is never transferable. Transfers cannot be undone.')),
      await whiteLabelSection(x, section),
      section('Danger zone', h('button', { class: 'danger', onclick: () => deleteModal(x) }, 'Delete accelerator…')),
    );
  }

  function transferModal(x) {
    const reference = randomRef(`lp-${x.id}`); // one per dialog: a retry of THIS transfer is idempotent
    const amount = h('input', { type: 'number', min: 1, step: 1, max: 1000000000, placeholder: '2000000' });
    const confirm = h('input', { placeholder: x.identifier, autocomplete: 'off' });
    const err = h('div', { class: 'notice bad', hidden: true });
    const go_ = h('button', { class: 'danger', type: 'submit' }, 'Transfer — cannot be undone');
    const form = h('form', {},
      h('div', { class: 'notice warn' }, 'A transfer is permanent. There is no reversal from the API or the app, and a sub-workspace that leaves your network keeps what it was given. A mistake needs a PortableMind support ticket.'),
      fld('tx-amount', 'Tokens to move', amount, 'Whole number. Only purchased tokens can move; all or nothing.'),
      fld('tx-confirm', `Type ${x.identifier} to confirm`, confirm),
      h('p', { class: 'muted small' }, 'Reference: ', h('code', {}, reference), ' — retrying with it moves the tokens once.'),
      err, h('div', { class: 'actions' }, go_));
    const m = modal(`Transfer tokens to ${x.name}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; go_.disabled = true;
      try {
        const r = await api(`/lp/op/accelerators/${x.id}/transfer`, { method: 'POST', body: { amount: Number(amount.value), reference, confirm: confirm.value.trim() }, quiet: true });
        m.close();
        toast(r.idempotent ? 'Already transferred earlier — nothing moved this time.' : `Moved ${fmt.num(r.amount)} tokens. ${x.name} now has ${fmt.num(r.new_balance)}.`, 'good');
        x.token_balance = r.new_balance; render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { go_.disabled = false; }
    });
  }

  function forgetModal(x) {
    const confirm = h('input', { placeholder: x.identifier, autocomplete: 'off' });
    const btn = h('button', { class: 'danger', type: 'submit' }, 'Forget and destroy secrets');
    const form = h('form', {}, h('p', {}, 'Removes it from this app and destroys the sign-on key, sign-up key and invite code held for it. Nothing changes on PortableMind.'),
      fld('fg-confirm', `Type ${x.identifier} to confirm`, confirm), h('div', { class: 'actions' }, btn));
    const m = modal(`Forget ${x.name}?`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { await api(`/lp/op/accelerators/${x.id}/forget`, { method: 'POST', body: { confirm: confirm.value.trim() } }); m.close(); toast('Forgotten.', 'good'); render(); }
      finally { btn.disabled = false; }
    });
  }

  function deleteModal(x) {
    const confirm = h('input', { placeholder: x.identifier, autocomplete: 'off' });
    const btn = h('button', { class: 'danger', type: 'submit' }, 'Delete permanently');
    const form = h('form', {}, h('p', {}, 'This queues a permanent deletion of the sub-workspace and everything in it. The sign-on key and provisioning key this app holds for it are destroyed too.'),
      fld('del-confirm', `Type ${x.identifier} to confirm`, confirm), h('div', { class: 'actions' }, btn));
    const m = modal(`Delete ${x.name}?`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { await api(`/lp/op/accelerators/${x.id}/delete`, { method: 'POST', body: { confirm: confirm.value.trim() } }); m.close(); closeDrawer(); toast('Deletion queued.', 'good'); render(); }
      finally { btn.disabled = false; }
    });
  }

  async function whiteLabelSection(x, section) {
    let wl;
    try { wl = (await pmGet(`/tenants/${x.id}/white_label`, true)).white_label; } catch (ex) {
      return section('Branding & sign-on', h('p', { class: 'muted' }, ex.status === 404 ? 'Not available — this accelerator may be leaving your agreement.' : ex.message));
    }
    const st = wl.settings || {};
    const f = {
      enabled: h('input', { type: 'checkbox', checked: st.enabled }),
      app_name: h('input', { value: st.app_name || x.name, maxlength: 80 }),
      primary_color: h('input', { value: st.primary_color || '', placeholder: '#2f5bea' }),
      app_base_url: h('input', { value: st.app_base_url || '', placeholder: 'https://northside.example.com' }),
      default_role: h('input', { value: st.default_role || 'basic' }),
      auto_provision: h('input', { type: 'checkbox', checked: st.auto_provision }),
      return_url_allowlist: h('input', { value: (st.return_url_allowlist || []).join(', '), placeholder: 'launchpad.example.com' }),
    };
    const save = h('button', { class: 'ghost', type: 'submit' }, 'Save branding');
    const form = h('form', {},
      h('label', { class: 'check' }, f.enabled, 'White-label on for this accelerator'),
      h('div', { class: 'form-grid' }, fld('wl-name', 'App name', f.app_name), fld('wl-color', 'Primary colour', f.primary_color)),
      fld('wl-url', 'App base URL', f.app_base_url, 'http(s), no credentials.'),
      fld('wl-return', 'Return-URL allowlist (hosts, comma separated)', f.return_url_allowlist, 'Include this app’s host so “sign out” in PortableMind can come back here.'),
      h('div', { class: 'form-grid' },
        fld('wl-role', 'Role for people created at sign-on', f.default_role, 'Must hold no more than the built-in basic role.'),
        h('div', { class: 'field' }, h('label', {}, 'First sign-on'), h('label', { class: 'check' }, f.auto_provision, 'Create unknown people on arrival'))),
      h('p', { class: 'muted small' }, 'Leave “create unknown people” off if founders should only ever arrive through this app’s sign-up (they then keep their scoped founder role).'),
      h('div', { class: 'row' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); save.disabled = true;
      const payload = {
        enabled: f.enabled.checked, auto_provision: f.auto_provision.checked, app_name: f.app_name.value.trim(),
        default_role: f.default_role.value.trim() || 'basic', app_base_url: f.app_base_url.value.trim() || null,
        return_url_allowlist: f.return_url_allowlist.value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (f.primary_color.value.trim()) payload.primary_color = f.primary_color.value.trim();
      try { await pmSend('PUT', `/tenants/${x.id}/white_label`, payload); toast('Branding saved — the change is in the accelerator’s audit log.', 'good'); }
      catch (ex) { if (ex.status === 403) toast('Check the pinned role: it must not hold more than basic.', 'bad'); }
      finally { save.disabled = false; }
    });

    const held = x.secrets.sso_key;
    const status = h('div', { class: 'row' },
      h('span', { class: `pill ${wl.enabled ? 'good' : ''}` }, wl.enabled ? 'White-label on' : 'White-label off'),
      h('span', { class: `pill ${wl.sso_key_present ? 'good' : ''}` }, wl.sso_key_present ? 'Key exists on platform' : 'No key on platform'),
      h('span', { class: `pill ${held ? 'good' : 'warn'}` }, held ? 'Key held by this app' : 'Key not held here'),
      wl.inherited_from ? h('span', { class: 'pill' }, `Entitlement inherited from ${wl.inherited_from}`) : null);
    const keyBtn = h('button', { class: wl.sso_key_present ? 'ghost' : '', onclick: async () => {
      const rotate = wl.sso_key_present;
      if (rotate && !window.confirm('Replace the sign-on key? The old key stops working immediately.')) return;
      keyBtn.disabled = true;
      try { await api(`/lp/op/accelerators/${x.id}/sso-key`, { method: 'POST', body: { rotate } }); toast('Sign-on key created and stored on this server. It was never shown to your browser.', 'good'); x.secrets.sso_key = true; acceleratorDrawer(x.id); }
      finally { keyBtn.disabled = false; }
    } }, wl.sso_key_present ? 'Rotate sign-on key' : 'Create sign-on key');
    const mismatch = wl.sso_key_present && !held ? h('div', { class: 'notice warn' }, 'A key exists on the platform but this server does not hold it (it can never be read back). Rotate it to restore sign-on from this app.') : null;
    return section('Branding & sign-on', status, form, h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:14px 0' }),
      h('p', { class: 'small' }, 'The sign-on key lets people signed in here open the PortableMind app without a second login. Whoever holds it can sign in as anyone in that accelerator, so it lives only on this server.'),
      mismatch, keyBtn);
  }

  // ---------- templates ----------
  async function viewOpTemplates(main) {
    const [list, ov] = await Promise.all([pmGet('/agent_templates'), opCache ? Promise.resolve(opCache) : loadOverview()]);
    const templates = list.agent_templates || [];
    clear(main);
    main.append(h('div', { class: 'row between' },
      h('div', {}, h('h1', {}, 'Agent templates'), h('p', { class: 'lede' }, 'Design an agent once in your own workspace, snapshot it as a template, and share it with accelerators. Each accelerator’s admin reviews and installs it — you cannot install for them.')),
      h('button', { onclick: () => newTemplateModal(), disabled: !ov.publishing }, '+ New template from an agent')));
    if (!ov.publishing) main.append(h('div', { class: 'notice warn' }, 'Publishing needs the Enterprise plan.'));
    if (!templates.length) { main.append(h('div', { class: 'card empty' }, 'No templates yet. Build and train an agent in your workspace (AI Studio), then snapshot it here.')); return; }
    for (const t of templates) {
      const cv = t.current_version || {};
      const sharing = t.sharing || {};
      main.append(h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', {}, h('h2', {}, t.name), h('p', { class: 'muted' }, t.description || 'No description')),
          h('div', { class: 'row' },
            h('span', { class: 'pill brand' }, `v${cv.version || '?'}`), t.category ? h('span', { class: 'pill' }, t.category) : null,
            h('span', { class: `pill ${sharing.mode === 'private' ? '' : 'good'}` }, `Shared: ${sharing.mode || 'private'}`),
            h('span', { class: 'pill' }, `${fmt.num(t.installs_count || 0)} installs`),
            t.active === false ? h('span', { class: 'pill warn' }, 'inactive') : null)),
        cv.manifest && cv.manifest.requires_consent ? h('p', { class: 'small muted' }, 'Installing asks the accelerator admin for consent (this version grants tools, roles, code or schedules).') : null,
        h('div', { class: 'row' },
          h('button', { class: 'ghost', onclick: () => shareModal(t, ov) }, 'Sharing…'),
          h('button', { class: 'ghost', onclick: () => publishModal(t) }, 'Publish new version…'),
          h('button', { class: 'ghost', onclick: () => installsModal(t) }, 'Adoption'))));
    }
  }

  async function memoryPicker(agentId, container) {
    clear(container).append(h('p', { class: 'muted small' }, 'Loading memories…'));
    const r = await pmGet(`/agent_templates/memory_candidates?llm_agent_id=${encodeURIComponent(agentId)}`, true).catch(() => ({ memories: [] }));
    const boxes = (r.memories || []).map((m) => ({ id: m.id, el: h('input', { type: 'checkbox', checked: m.default_selected }), m }));
    clear(container);
    if (!boxes.length) container.append(h('p', { class: 'muted small' }, 'This agent has no shareable memories.'));
    for (const b of boxes) container.append(h('label', { class: 'check' }, b.el, h('span', {}, b.m.title, ' ', h('span', { class: 'pill' }, b.m.memory_type))));
    return () => boxes.filter((b) => b.el.checked).map((b) => b.id);
  }

  async function newTemplateModal() {
    const agents = (await pmGet('/llm_agents?limit=-1')).llm_agents || [];
    const agent = h('select', {}, h('option', { value: '' }, 'Choose an agent…'), agents.map((a) => h('option', { value: a.id }, a.name)));
    const name = h('input', { required: true }), description = h('textarea', { rows: 2 }), category = h('input', { placeholder: 'intake, mentoring, finance…' });
    const notes = h('input', { value: 'First release' }), runbooks = h('input', { type: 'checkbox', checked: true });
    const mem = h('div', {}); let selected = () => [];
    agent.addEventListener('change', async () => { if (!name.value) name.value = agent.selectedOptions[0].textContent; selected = await memoryPicker(agent.value, mem); });
    const btn = h('button', { type: 'submit' }, 'Save & publish v1');
    const form = h('form', {}, fld('nt-agent', 'Source agent (from your workspace)', agent), fld('nt-name', 'Template name', name), fld('nt-desc', 'Description', description),
      h('div', { class: 'form-grid' }, fld('nt-cat', 'Category', category), fld('nt-notes', 'Release notes', notes)),
      h('div', { class: 'field' }, h('label', {}, 'Memories that travel'), mem, h('div', { class: 'hint' }, 'Private memories never travel. Credentials are scrubbed automatically.')),
      h('label', { class: 'check' }, runbooks, 'Include runbooks'),
      h('div', { class: 'actions' }, btn));
    const m = modal('New agent template', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); if (!agent.value) return toast('Choose an agent', 'bad');
      btn.disabled = true;
      try {
        await pmSend('POST', '/agent_templates', { source_llm_agent_id: Number(agent.value), name: name.value.trim(), description: description.value.trim(), category: category.value.trim() || undefined,
          release_notes: notes.value.trim(), include_runbooks: runbooks.checked, memory_ids: selected() });
        m.close(); toast('Template saved as version 1 (private). Share it next.', 'good'); render();
      } finally { btn.disabled = false; }
    });
  }

  async function publishModal(t) {
    const srcId = t.source_llm_agent_id || (t.source_llm_agent && t.source_llm_agent.id);
    const notes = h('input', { required: true, placeholder: 'What changed?' });
    const mem = h('div', {});
    const selected = srcId ? await memoryPicker(srcId, mem) : () => undefined;
    const btn = h('button', { type: 'submit' }, 'Publish');
    const form = h('form', {}, fld('pv-notes', 'Release notes', notes),
      h('div', { class: 'field' }, h('label', {}, 'Memories for this version'), mem,
        h('div', { class: 'hint' }, 'The selection is NOT carried over from the previous version — it is sent explicitly every time.')),
      h('div', { class: 'actions' }, btn));
    const m = modal(`Publish a new version of ${t.name}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try {
        const body = { release_notes: notes.value.trim() };
        const ids = selected(); if (ids) body.memory_ids = ids;
        const r = await pmSend('POST', `/agent_templates/${t.id}/publish`, body);
        m.close(); toast(`Published v${r.version.version}. Installs upgrade when their admins accept (or automatically, if nothing new is granted and auto-upgrade is on).`, 'good'); render();
      } finally { btn.disabled = false; }
    });
  }

  function shareModal(t, ov) {
    const cur = t.sharing || { mode: 'private' };
    const granted = new Set((cur.grantees || []).map((g) => Number(g.tenant_id || g.id || g)));
    const radios = ['private', 'all_children', 'selected'].map((mode) => ({ mode, el: h('input', { type: 'radio', name: 'share-mode', value: mode, checked: cur.mode === mode }) }));
    const boxes = ov.accelerators.map((a) => ({ a, el: h('input', { type: 'checkbox', checked: granted.has(a.id) }) }));
    const labels = { private: 'Private — only your workspace', all_children: 'Every accelerator, including future ones', selected: 'Selected accelerators' };
    const btn = h('button', { type: 'submit' }, 'Save sharing');
    const form = h('form', {},
      radios.map((r) => h('label', { class: 'check' }, r.el, labels[r.mode])),
      h('div', { class: 'field', style: 'margin:8px 0 0 24px' }, boxes.length ? boxes.map((b) => h('label', { class: 'check' }, b.el, b.a.name, ' ', h('span', { class: 'mono muted' }, b.a.identifier))) : h('p', { class: 'muted' }, 'No accelerators yet.')),
      h('p', { class: 'muted small' }, 'Sharing makes the template installable. It does not install it.'),
      h('div', { class: 'actions' }, btn));
    const m = modal(`Share ${t.name}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = radios.find((r) => r.el.checked).mode;
      const sharing = { mode };
      if (mode === 'selected') {
        sharing.grantee_tenant_ids = boxes.filter((b) => b.el.checked).map((b) => b.a.id); // NUMERIC ids
        if (!sharing.grantee_tenant_ids.length) return toast('Pick at least one accelerator', 'bad');
      }
      btn.disabled = true;
      try { await pmSend('PUT', `/agent_templates/${t.id}/sharing`, { sharing }); m.close(); toast('Sharing updated.', 'good'); render(); }
      finally { btn.disabled = false; }
    });
  }

  async function installsModal(t) {
    const r = await pmGet(`/agent_templates/${t.id}/installs`);
    const rows = r.installs || r.agent_template_installs || [];
    modal(`Adoption — ${t.name}`, rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Workspace', 'Agent', 'Version', 'Auto-upgrade', 'Runs 30d', 'Cost 30d', 'Grade'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((i) => h('tr', {},
        h('td', {}, i.tenant_name || i.workspace_name || i.tenant_id), h('td', {}, i.llm_agent_name || (i.llm_agent && i.llm_agent.name) || '—'),
        h('td', {}, `v${i.version}`, i.behind ? h('span', { class: 'pill warn' }, `${i.behind} behind`) : null),
        h('td', {}, i.auto_upgrade ? 'on' : 'off'), h('td', { class: 'num' }, fmt.num(i.runs_30d)), h('td', { class: 'num' }, fmt.usd(i.cost_30d_usd)),
        h('td', {}, i.latest_grade || '—')))))) : h('p', { class: 'muted' }, 'Not installed anywhere yet.'));
  }

  // ---------- shared models ----------
  async function viewOpModels(main) {
    const ov = opCache || await loadOverview();
    const models = (await pmGet('/llm_models?limit=-1')).llm_models || [];
    const own = models.filter((m) => ov.network.id && Number(m.tenant_id) === Number(ov.network.id));
    clear(main);
    main.append(h('div', { class: 'row between' },
      h('div', {}, h('h1', {}, 'Shared models'), h('p', { class: 'lede' }, 'Let accelerators run on your provider account with a monthly spend cap each. They never see your key, and turns on your model draw none of their tokens.')),
      h('button', { onclick: () => newModelModal() }, '+ Add a model with your key')));
    const card = h('div', { class: 'card' }, h('h2', {}, 'Your models'));
    if (!own.length) card.append(h('div', { class: 'empty' }, 'No models with your own provider key yet. Platform models are paid for with tokens and cannot be shared.'));
    else card.append(h('table', {}, h('thead', {}, h('tr', {}, ['Model', 'Identifier', 'Who pays', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, own.map((m) => h('tr', {}, h('td', {}, m.description), h('td', { class: 'mono' }, m.internal_identifier),
        h('td', {}, h('span', { class: 'pill' }, m.cost_source)), h('td', {}, h('button', { class: 'ghost', onclick: () => familySharingModal(m, ov) }, 'Sharing & caps…')))))));
    main.append(card);
    main.append(h('div', { class: 'card' }, h('h3', {}, 'How the cap behaves'),
      h('p', { class: 'small' }, 'The cap is soft and monthly (UTC): it is checked before a turn and recorded after, so the turn that crosses it completes and the next one is refused. Budget for a small overshoot. Background AI (memory summaries, scorecards) never runs on your model — each accelerator still needs a few tokens of its own.')));
  }

  async function familySharingModal(m, ov) {
    const cur = (await pmGet(`/llm_models/${m.id}/family_sharing`)).family_sharing || { mode: 'private', grants: [] };
    const grants = new Map((cur.grants || []).map((g) => [Number(g.tenant_id), g]));
    const radios = ['private', 'all_children', 'selected'].map((mode) => ({ mode, el: h('input', { type: 'radio', name: 'fs-mode', value: mode, checked: cur.mode === mode }) }));
    const cap = h('input', { type: 'number', min: 0, step: '0.01', value: cur.monthly_spend_cap_usd ?? '' , placeholder: 'no cap' });
    const rows = ov.accelerators.map((a) => {
      const g = grants.get(a.id);
      return { a, on: h('input', { type: 'checkbox', checked: !!g }), cap: h('input', { type: 'number', min: 0, step: '0.01', value: g && g.own_monthly_spend_cap_usd != null ? g.own_monthly_spend_cap_usd : '', placeholder: 'default', style: 'max-width:110px' }), spend: g ? g.spend_this_month_usd : null };
    });
    const btn = h('button', { type: 'submit' }, 'Save');
    const labels = { private: 'Not shared', all_children: 'Every accelerator', selected: 'Selected accelerators' };
    const form = h('form', {},
      radios.map((r) => h('label', { class: 'check' }, r.el, labels[r.mode])),
      fld('fs-cap', 'Default monthly cap per accelerator (USD)', cap),
      h('table', {}, h('thead', {}, h('tr', {}, ['', 'Accelerator', 'Own cap', 'Spend this month'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.on), h('td', {}, r.a.name), h('td', {}, r.cap), h('td', { class: 'num' }, r.spend == null ? '—' : fmt.usd(r.spend)))))),
      h('p', { class: 'muted small' }, 'Tick accelerators for “selected”. Per-accelerator caps override the default.'),
      h('div', { class: 'actions' }, btn));
    const md = modal(`Share ${m.description}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = radios.find((r) => r.el.checked).mode;
      const body = { mode }; // NO wrapper object for model sharing (unlike templates)
      if (cap.value !== '') body.monthly_spend_cap_usd = Number(cap.value);
      if (mode === 'selected') {
        body.grants = rows.filter((r) => r.on.checked).map((r) => (r.cap.value !== '' ? { tenant_id: r.a.id, monthly_spend_cap_usd: Number(r.cap.value) } : { tenant_id: r.a.id }));
        if (!body.grants.length) return toast('Pick at least one accelerator', 'bad');
      }
      btn.disabled = true;
      try { await pmSend('PUT', `/llm_models/${m.id}/family_sharing`, body); md.close(); toast('Model sharing saved.', 'good'); }
      finally { btn.disabled = false; }
    });
  }

  async function newModelModal() {
    const types = (await pmGet('/product_types?type=LlmModelProductType&limit=-1')).product_types || [];
    const type = h('select', {}, types.map((t) => h('option', { value: t.id }, t.description || t.internal_identifier)));
    const desc = h('input', { required: true, placeholder: 'Network GPT' }), iid = h('input', { required: true, placeholder: 'network-gpt' });
    const key = h('input', { type: 'password', required: true, autocomplete: 'off' });
    const btn = h('button', { type: 'submit' }, 'Add model');
    const form = h('form', {}, fld('nm-type', 'Model type', type), h('div', { class: 'form-grid' }, fld('nm-desc', 'Name', desc), fld('nm-iid', 'Identifier', iid)),
      fld('nm-key', 'Your provider API key', key, 'Stored by PortableMind on this model; never visible to accelerators.'), h('div', { class: 'actions' }, btn));
    const m = modal('Add a model with your provider key', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try {
        await pmSend('POST', '/llm_models', { llm_model: { description: desc.value.trim(), internal_identifier: iid.value.trim(), llm_model_product_type_id: Number(type.value), custom_fields: { api_key: key.value } } });
        m.close(); toast('Model added. Share it next.', 'good'); render();
      } finally { btn.disabled = false; }
    });
  }

  // ---------- spend ----------
  async function viewOpSpend(main) {
    const ov = opCache || await loadOverview();
    const r = await pmGet(`/tenants/${ov.network.id}/llm_cost_stats?scope=all`);
    clear(main);
    main.append(h('h1', {}, 'Spend & tokens'), h('p', { class: 'lede' }, 'AI spend and token movement across the whole network, side by side. Bill your accelerators on these totals — how you charge them is your business, outside PortableMind.'));
    const alloc = r.token_allocations || [];
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Tokens by workspace'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Workspace', 'Allocated', 'Consumed', 'Transferred', 'Balance'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, alloc.map((a) => h('tr', {}, h('td', {}, a.tenant_name), h('td', { class: 'num' }, fmt.num(a.allocated_tokens)), h('td', { class: 'num' }, fmt.num(a.consumed_tokens)),
        h('td', { class: 'num' }, fmt.num(a.transferred_tokens)), h('td', { class: 'num' }, fmt.num(a.token_balance)))))))));
    const br = r.breakdown || [];
    main.append(h('div', { class: 'card' }, h('h2', {}, 'AI spend by workspace'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Workspace', 'Cost', 'Messages', 'Input tokens', 'Output tokens', 'Cache read'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, br.map((b) => h('tr', {}, h('td', {}, b.tenant_name), h('td', { class: 'num' }, fmt.cents(b.total_cost_cents)), h('td', { class: 'num' }, fmt.num(b.message_count)),
        h('td', { class: 'num' }, fmt.num(b.total_input_tokens)), h('td', { class: 'num' }, fmt.num(b.total_output_tokens)), h('td', { class: 'num' }, `${Math.round((b.cache_read_rate || 0) * 100)}%`)))))),
      h('p', { class: 'muted small' }, br[0] ? `Period: ${br[0].date_range}` : '')));
  }

  // =====================================================================================
  // ACCELERATOR ADMIN (admin of one sub-workspace)
  // =====================================================================================
  async function accBanner() {
    const b = $('#banner');
    try {
      const s = await pmGet('/tenants/subscription_status', true);
      const off = s.offboarding;
      if (off && off.grace_ends_at) {
        b.className = 'banner warn'; b.hidden = false;
        b.textContent = `${off.former_parent_name || 'The network'} no longer covers this workspace. Everything keeps working, free, until ${fmt.date(off.grace_ends_at)} — then an admin must choose a plan with their own card.`;
      } else if (s.billing_agreement && s.billing_agreement.role === 'covered') {
        b.className = 'banner info'; b.hidden = false;
        b.textContent = `Billing for this workspace is covered by ${s.billing_agreement.holder_name}’s agreement.`;
      } else b.hidden = true;
      return s;
    } catch (_) { b.hidden = true; return null; }
  }

  const MANIFEST_FIELDS = [
    ['code_bearing', 'Runs code in this workspace', 'Custom tools, skill scripts or functions that execute here'],
    ['tool_iids', 'Built-in tools'], ['custom_tools', 'Custom tools'], ['resource_iids', 'Built-in resources'], ['custom_resources', 'Custom resources'],
    ['skills', 'Skills'], ['skill_tool_iids', 'Tools granted by skills'], ['skill_custom_tools', 'Custom tools granted by skills'],
    ['schedule', 'Runs on a timer'], ['skill_schedules', 'Skill schedules'], ['skill_triggers', 'Runs when records change'],
    ['security_roles', 'Permissions the agent gets'], ['security_roles_exclusive', 'Exactly these permissions and no others'],
    ['memory_count', 'Memories included'], ['runbooks', 'Runbooks'], ['persona_present', 'Persona included'], ['daily_cost_limit', 'Daily cost limit'],
    ['required_customizations', 'Values you must supply'], ['scrubbed_keys', 'Settings removed before publishing — you configure these'],
  ];
  const isEmpty = (v) => v == null || v === false || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) || v === 0;
  const show = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? (x.title || x.name || x.key || x.iid || JSON.stringify(x)) : x)).join(', ')
    : typeof v === 'object' ? Object.entries(v).map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`).join('; ')
    : v === true ? 'Yes' : String(v));

  function manifestList(man, other) {
    const dl = h('dl', { class: 'manifest' });
    let any = false;
    for (const [key, label, hint] of MANIFEST_FIELDS) {
      const v = man ? man[key] : null;
      const before = other ? other[key] : undefined;
      if (isEmpty(v) && (other === undefined || isEmpty(before))) continue;
      any = true;
      const changed = other !== undefined && JSON.stringify(v) !== JSON.stringify(before);
      dl.append(h('dt', {}, label, changed ? h('span', { class: 'pill warn', style: 'margin-left:6px' }, 'changed') : null),
        h('dd', {}, isEmpty(v) ? h('span', { class: 'diff-removed' }, show(before)) : show(v), hint ? h('div', { class: 'muted small' }, hint) : null,
          changed && !isEmpty(before) && !isEmpty(v) ? h('div', { class: 'small' }, 'was: ', h('span', { class: 'diff-removed' }, show(before))) : null));
    }
    if (!any) dl.append(h('dd', { class: 'muted' }, 'Instructions and persona only — nothing is granted.'));
    return dl;
  }

  async function viewAccSetup(main) {
    const [s] = await Promise.all([api('/lp/acc/setup'), accBanner()]);
    clear(main);
    const signupUrl = `${location.origin}/#/signup?w=${encodeURIComponent(me.workspace)}`;
    const step = (done, title, text, action) => h('li', { class: done ? 'done' : '' }, h('div', {}, h('b', {}, title), h('p', { class: 'muted small' }, text), action));
    const wl = s.white_label || {};
    main.append(h('h1', {}, 'Set up your accelerator'),
      h('p', { class: 'lede' }, `A few one-time steps let your startups register themselves. ${NETWORK} cannot do these for you — they happen inside your workspace, with your admin account.`),
      h('div', { class: 'card' }, h('ol', { class: 'steps' },
        step(!!s.founder_role && !!s.baseline_role, 'Founder role',
          s.baseline_role
            ? 'A scoped role for founders: they see only their own startup’s projects, tasks and files. Imported into your workspace, flagged external so sign-up can grant it. Founders also get PortableMind’s built-in “External Member” baseline (notifications, preferences) so the workspace app loads for them.'
            : 'This workspace is missing PortableMind’s built-in “External Member” role, which founders need alongside the founder role. Ask PortableMind to run the role seeder.',
          h('button', { class: s.founder_role ? 'ghost' : '', onclick: async (e) => { e.target.disabled = true; try { await api('/lp/acc/setup/founder-role', { method: 'POST' }); toast('Founder role imported.', 'good'); render(); } finally { e.target.disabled = false; } } }, s.founder_role ? 'Re-import' : 'Import founder role')),
        step(s.secrets.provisioning_key, 'Sign-up key',
          'An API key with only the built-in “provisioner” role. It is created with your session and stored on this app’s server — nobody, including you, ever sees it.',
          h('button', { class: s.secrets.provisioning_key ? 'ghost' : '', disabled: !s.founder_role, onclick: async (e) => { e.target.disabled = true; try { const r = await api('/lp/acc/setup/provisioning-key', { method: 'POST' }); toast(`Sign-up key #${r.key_id} created and stored.${r.retired_key_id ? ` Key #${r.retired_key_id} switched off.` : ''}`, 'good'); render(); } finally { e.target.disabled = false; } } }, s.secrets.provisioning_key ? 'Replace key' : 'Create sign-up key')),
        step(s.app_access && !s.app_access.roles_missing.length && !s.app_access.founders_without_access, 'Founder access to the workspace app',
          s.app_access && s.app_access.roles_missing.length
            ? `This workspace is missing the ${s.app_access.roles_missing.join(', ')} role, so founders cannot open those sections.`
            : s.app_access
              ? `Team Chat, Files and Projects open for founders in the PortableMind app. ${s.app_access.founders_without_access} of ${s.app_access.founders} founders still need it — new sign-ups get it automatically.`
              : 'Could not read founder access just now.',
          h('button', { class: 'ghost', onclick: async (e) => {
            e.target.disabled = true;
            try { const r = await api('/lp/acc/setup/app-access', { method: 'POST' }); toast(r.granted ? `Granted ${r.granted} role${r.granted === 1 ? '' : 's'} across ${r.founders} founders.` : 'Every founder already has access.', 'good'); render(); }
            finally { e.target.disabled = false; }
          } }, 'Sync founder app access')),
        step(s.secrets.invite_code, 'Invite code',
          'Founders need it to register. Share it with the link below. Replace it any time; the old code stops working at once.',
          h('div', { class: 'row' },
            h('button', { class: s.secrets.invite_code ? 'ghost' : '', disabled: !s.secrets.provisioning_key, onclick: async () => {
              const r = await api('/lp/acc/setup/invite-code', { method: 'POST', body: {} });
              modal('Founder invite', h('div', {}, h('p', {}, 'Send founders this link and code. The code is shown only now.'),
                h('div', { class: 'field' }, h('label', {}, 'Sign-up link'), h('div', { class: 'secret-once' }, `${signupUrl}&code=${encodeURIComponent(r.invite_code)}`)),
                h('div', { class: 'field' }, h('label', {}, 'Invite code'), h('div', { class: 'secret-once' }, r.invite_code))),
              [h('button', { onclick: () => { clear($('#modal-root')); render(); } }, 'Done')]);
            } }, s.secrets.invite_code ? 'New invite code' : 'Generate invite code'),
            s.secrets.invite_code ? h('button', { class: 'ghost', onclick: async () => { await api('/lp/acc/setup/invite-code/clear', { method: 'POST' }); toast('Sign-ups closed.'); render(); } }, 'Close sign-ups') : null)),
        step(wl.enabled && s.secrets.sso_key, 'Open PortableMind without a second login (optional)',
          wl.enabled && s.secrets.sso_key ? 'Ready: “Open PortableMind” signs people straight into your branded workspace.'
            : `White-label sign-on is set up by the ${NETWORK} team for each accelerator. Currently: white-label ${wl.enabled ? 'on' : 'off'}, sign-on key ${s.secrets.sso_key ? 'held' : 'not set up'}.`,
          null))),
      h('div', { class: 'card' }, h('h2', {}, 'Where founders register'), h('p', {}, h('code', {}, signupUrl)),
        h('p', { class: 'muted small' }, 'Each startup that registers becomes a team in your workspace. Founders can add their own colleagues later; they never see other startups.')));
  }

  async function viewAccCatalog(main) {
    const [r] = await Promise.all([pmGet('/agent_template_catalog'), accBanner()]);
    const list = r.agent_template_catalog || [];
    clear(main);
    main.append(h('h1', {}, 'Agent catalog'), h('p', { class: 'lede' }, `Agents published by ${NETWORK}. Installing makes a copy that belongs to your workspace — you can read and edit everything it brings.`));
    if (!list.length) { main.append(h('div', { class: 'card empty' }, 'Nothing has been shared with this workspace yet.')); return; }
    const grid = h('div', { class: 'grid two' });
    for (const t of list) {
      grid.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, t.name), h('span', { class: 'pill brand' }, `v${(t.current_version && t.current_version.version) || t.current_version || '?'}`)),
        h('p', { class: 'muted' }, t.description || ''), h('p', { class: 'small muted' }, `Published by ${t.own ? 'this workspace' : t.publisher_tenant_name}`, t.installs ? ` · installed ${t.installs}×` : ''),
        h('button', { onclick: () => reviewModal(t.id) }, 'Review & install')));
    }
    main.append(grid);
  }

  async function reviewModal(id, notice) {
    const r = await pmGet(`/agent_template_catalog/${id}`);
    const entry = r.agent_template_catalog_entry || {};
    const v = entry.current_version || {};
    const man = v.manifest || {};
    // Agent names allow only letters, digits, _ and - (the platform refuses spaces).
    const name = h('input', { value: String(entry.name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-'), required: true, pattern: '[A-Za-z0-9_\\-]{1,128}' });
    const auto = h('input', { type: 'checkbox' });
    const models = ((await pmGet('/llm_models?limit=-1', true).catch(() => ({}))).llm_models || []);
    const model = h('select', {}, h('option', { value: '' }, 'The template’s model (or this workspace’s default)'),
      models.map((m) => h('option', { value: m.internal_identifier }, `${m.description}${m.family_shared ? ` — shared by ${m.shared_by_tenant_name}, no tokens` : m.cost_source === 'tokens' ? ' — uses your tokens' : ''}`)));
    const customs = (Array.isArray(man.required_customizations) ? man.required_customizations : []).map((c) => {
      const key = typeof c === 'string' ? c : (c.key || c.name);
      return { key, el: h('input', { required: true, placeholder: typeof c === 'object' && c.description ? c.description : '' }) };
    });
    const consent = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'notice bad', hidden: true });
    const btn = h('button', { type: 'submit' }, 'Install');
    const form = h('form', {},
      notice ? h('div', { class: 'notice warn' }, notice) : null,
      h('p', {}, h('span', { class: 'pill brand' }, `Version ${v.version}`), ' ', v.release_notes || ''),
      h('h3', {}, man.requires_consent ? 'This agent will be granted' : 'What arrives'), manifestList(man),
      h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:14px 0' }),
      fld('rv-name', 'Name in your workspace', name, 'Letters, digits, - and _ only.'),
      fld('rv-model', 'Model', model),
      customs.map((c) => fld(`rv-c-${c.key}`, c.key, c.el)),
      h('label', { class: 'check' }, auto, 'Upgrade automatically when a new version grants nothing new'),
      man.requires_consent ? h('label', { class: 'check', style: 'margin-top:10px' }, consent, h('b', {}, `I have reviewed what version ${v.version} grants and accept it for this workspace.`)) : null,
      err, h('div', { class: 'actions' }, btn));
    const m = modal(`Install ${entry.name}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      if (man.requires_consent && !consent.checked) { err.textContent = 'Tick the consent box to install.'; err.hidden = false; return; }
      const body = { name: name.value.trim(), auto_upgrade: auto.checked, expected_version_id: v.id }; // consent is bound to THIS version
      if (man.requires_consent) body.accept_code = true;
      if (model.value) body.llm_model_iid = model.value;
      if (customs.length) body.customizations = Object.fromEntries(customs.map((c) => [c.key, c.el.value]));
      btn.disabled = true;
      try {
        const res = await pmSend('POST', `/agent_template_catalog/${id}/install`, body, true);
        m.close();
        const scrubbed = man.scrubbed_keys || [];
        modal('Installed', h('div', {},
          h('p', {}, h('b', {}, res.llm_agent.name), ' is now an agent in your workspace.'),
          scrubbed.length ? h('div', { class: 'notice warn' }, 'Finish configuring it: these settings were removed before publishing and must be filled in by you — ', h('b', {}, show(scrubbed))) : null,
          man.runbooks && !isEmpty(man.runbooks) ? h('p', { class: 'small muted' }, `Runbooks are in the folder /Agent Runbooks/${res.llm_agent.name}.`) : null),
          [CFG.ssoConfigured ? h('button', { class: 'ghost', onclick: () => openPortableMind('/app/ai-studio') }, 'Open AI Studio ↗') : null, h('button', { onclick: () => { clear($('#modal-root')); go('agents'); } }, 'See installed agents')].filter(Boolean));
      } catch (ex) {
        const code = ex.body.code;
        if (code === 'version_changed') { m.close(); return reviewModal(id, 'A newer version was published while you were reviewing. Please review it again.'); }
        if (code === 'conflicts') err.textContent = `This workspace already has items with the same names: ${show(ex.body.conflicts || [])}. Nothing was installed.`;
        else if (code === 'name_taken') err.textContent = 'You already have an agent with that name — choose another.';
        else if (code === 'code_not_accepted') err.textContent = 'This version needs your consent.';
        else if (ex.status === 402) err.textContent = 'Your plan’s agent limit is reached. Remove an agent or ask the network for a bigger plan.';
        else if (ex.status === 404) err.textContent = 'This template is no longer shared with your workspace.';
        else err.textContent = ex.message;
        err.hidden = false;
      } finally { btn.disabled = false; }
    });
  }

  async function viewAccAgents(main) {
    const [r] = await Promise.all([pmGet('/agent_template_installs'), accBanner()]);
    const list = r.agent_template_installs || r.installs || [];
    clear(main);
    main.append(h('h1', {}, 'Installed agents'), h('p', { class: 'lede' }, 'Agents installed from the network’s templates. Upgrades are yours to accept; an upgrade never touches what the agent learned on its own.'));
    if (!list.length) { main.append(h('div', { class: 'card empty' }, 'No template installs yet — see the Agent catalog.')); return; }
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Agent', 'Template', 'Version', 'Auto-upgrade', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.map((i) => {
        const auto = h('input', { type: 'checkbox', checked: i.auto_upgrade, onchange: async () => {
          try { await pmSend('PUT', `/agent_template_installs/${i.id}`, { auto_upgrade: auto.checked }); toast(`Auto-upgrade ${auto.checked ? 'on' : 'off'}.`, 'good'); } catch (_) { auto.checked = !auto.checked; }
        } });
        return h('tr', {},
          h('td', {}, i.agent_name || `Agent #${i.llm_agent_id}`, h('div', { class: 'muted small' }, `installed ${fmt.date(i.installed_at)}`)),
          h('td', {}, i.template_name || '—', i.publisher_tenant_name ? h('div', { class: 'muted small' }, `by ${i.publisher_tenant_name}`) : null),
          h('td', {}, `v${i.version}`, i.upgrade_available ? h('span', { class: `pill ${i.upgrade_requires_consent ? 'warn' : 'good'}`, style: 'margin-left:6px' }, `v${i.latest_version} available${i.upgrade_requires_consent ? ' · needs consent' : ''}`) : h('span', { class: 'muted small' }, ' up to date')),
          h('td', {}, h('label', { class: 'check' }, auto, auto.checked ? 'on' : 'off')),
          h('td', {}, h('div', { class: 'row' },
            i.upgrade_available ? h('button', { onclick: () => upgradeModal(i) }, 'Upgrade…') : null,
            h('button', { class: 'ghost', onclick: async () => {
              if (!window.confirm('Detach this agent from the template? It stays in your workspace but stops receiving upgrades.')) return;
              await pmSend('DELETE', `/agent_template_installs/${i.id}`); toast('Detached.', 'good'); render();
            } }, 'Detach'))));
      })))));
    main.append(card);
  }

  function upgradeModal(i) {
    const needs = !!i.upgrade_requires_consent;
    const consent = h('input', { type: 'checkbox' });
    const btn = h('button', { type: 'submit' }, `Upgrade to v${i.latest_version}`);
    const form = h('form', {},
      i.latest_release_notes ? h('p', {}, h('b', {}, 'Release notes: '), i.latest_release_notes) : null,
      needs ? h('div', {}, h('div', { class: 'notice warn' }, 'This version changes what the agent is granted. Review the difference:'), manifestList(i.latest_manifest || {}, i.installed_manifest || {}))
        : h('p', { class: 'muted' }, 'Nothing new is granted — no consent needed.'),
      needs ? h('label', { class: 'check' }, consent, h('b', {}, 'I accept what this version grants.')) : null,
      h('p', { class: 'muted small' }, 'Kept as they are: the agent’s name, model, paused state, cost limits, your customizations, tool settings, credentials and its own memories.'),
      h('div', { class: 'actions' }, btn));
    const m = modal('Upgrade agent', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (needs && !consent.checked) return toast('Tick the consent box to upgrade.', 'bad');
      btn.disabled = true;
      try {
        const body = { expected_version_id: i.latest_version_id };
        if (needs) body.accept_code = true;
        await pmSend('POST', `/agent_template_installs/${i.id}/upgrade`, body, true);
        m.close(); toast('Upgraded.', 'good'); render();
      } catch (ex) {
        if (ex.body.code === 'version_changed') { m.close(); toast('Another version was published meanwhile — review again.', 'bad'); render(); }
        else if (ex.body.code === 'up_to_date') { m.close(); render(); }
        else toast(ex.message, 'bad');
      } finally { btn.disabled = false; }
    });
  }

  async function viewAccStartups(main) {
    const [teams] = await Promise.all([pmGet('/teams?limit=-1'), accBanner()]);
    const list = teams.data || teams.teams || [];
    const rosters = await Promise.all(list.map((t) => pmGet(`/teams/${t.id}/members?limit=-1`, true).then((r) => r.data || []).catch(() => [])));
    clear(main);
    main.append(h('h1', {}, 'Startups'), h('p', { class: 'lede' }, 'Each startup is a team in your workspace. Founders register themselves with your invite code (see Set-up).'));
    if (!list.length) { main.append(h('div', { class: 'card empty' }, 'No startups yet.')); return; }
    const grid = h('div', { class: 'grid two' });
    list.forEach((t, idx) => grid.append(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, t.name), h('span', { class: 'pill' }, `${rosters[idx].length} ${rosters[idx].length === 1 ? 'person' : 'people'}`)),
      rosters[idx].length ? h('ul', {}, rosters[idx].map((m) => h('li', {}, m.name, ' ', h('span', { class: 'muted small' }, m.email), m.is_lead ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'lead') : null))) : h('p', { class: 'muted' }, 'No members.'))));
    main.append(grid);
  }

  async function viewAccUsage(main) {
    const [s, bal] = await Promise.all([accBanner(), pmGet('/llm_tokens/balance', true).catch(() => null)]);
    clear(main);
    main.append(h('h1', {}, 'Usage & plan'), h('p', { class: 'lede' }, 'Your plan’s published limits, the fair-use guardrails behind them, and your AI token balance. There is no per-seat pricing — add as many founders as you like.'));
    if (!s) { main.append(h('div', { class: 'card' }, 'Could not read usage.')); return; }
    const plan = s.product_type ? (s.product_type.description || s.product_type.internal_identifier) : '—';
    main.append(h('div', { class: 'grid kpis' },
      kpi('Plan', plan, s.billing_agreement && s.billing_agreement.role === 'covered' ? `covered by ${s.billing_agreement.holder_name}` : ''),
      bal ? kpi('AI tokens', fmt.tokens(bal.balance), `${fmt.tokens(bal.subscription_balance)} monthly · ${fmt.tokens(bal.purchased_balance)} purchased or transferred`) : null,
      bal ? kpi('Allowance', fmt.tokens(bal.allowance_amount), `per month (${bal.allowance_period})`) : null));
    const lim = s.published_limits || [];
    const label = { projects: 'Projects', llm_conversations: 'Conversations', tasks: 'Tasks', agent_count: 'Agents', storage: 'Storage' };
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Published limits'), h('table', {},
      h('thead', {}, h('tr', {}, ['Limit', 'Used', 'Allowed'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, lim.map((l) => h('tr', {}, h('td', {}, label[l.limit_type] || l.limit_type), h('td', { class: 'num' }, fmt.num(l.used)), h('td', { class: 'num' }, l.limit == null || l.limit < 0 ? 'unlimited' : fmt.num(l.limit))))))));
    const fair = (s.fair_use && s.fair_use.limits) || [];
    const flagged = fair.filter((f) => f.near_limit || f.reached);
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Fair-use guardrails'),
      h('p', { class: 'muted small' }, 'Generous, unadvertised ceilings. You are warned at 80%; at 100% the action is refused. A guardrail of 0 means “not part of this plan”.'),
      flagged.length ? h('div', { class: 'notice warn' }, flagged.map((f) => h('div', {}, `${f.limit_type}: ${fmt.num(f.used)} of ${fmt.num(f.limit)} this ${f.period}${f.reached ? ' — reached' : ''}`))) : h('p', { class: 'notice good' }, 'Nothing near a guardrail.'),
      h('details', {}, h('summary', {}, `All ${fair.length} guardrails`), h('table', {}, h('tbody', {}, fair.map((f) => h('tr', {}, h('td', {}, f.limit_type), h('td', { class: 'muted' }, f.period), h('td', { class: 'num' }, `${fmt.num(f.used)} / ${f.limit === 0 ? 'not in plan' : fmt.num(f.limit)}`))))))));
  }

  // =====================================================================================
  // FOUNDER
  // =====================================================================================
  // ---------- founder: startup (team + chat) ----------
  let founderState = null; // { teams, sso_available }

  async function loadFounder() { founderState = await api('/lp/founders/me'); return founderState; }

  async function viewFounderStartup(main) {
    const r = founderState || await loadFounder();
    clear(main);
    $('#sso-btn').hidden = !r.sso_available;
    main.append(h('h1', {}, `Welcome, ${me.user.name.split(' ')[0]}`), h('p', { class: 'lede' }, `Your startup’s space at ${me.accelerator ? me.accelerator.name : 'your accelerator'}.`));
    if (!r.teams.length) { main.append(h('div', { class: 'card' }, h('p', {}, 'You are not on a startup team yet. Ask a colleague for an invite link, or contact your accelerator.'))); return; }
    for (const t of r.teams) {
      main.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, t.name), h('button', { onclick: () => addTeammateModal(t) }, '+ Invite a colleague')),
        h('table', {}, h('tbody', {}, t.members.map((m) => h('tr', {}, h('td', {}, m.name), h('td', { class: 'muted' }, m.email), h('td', {}, m.is_lead ? h('span', { class: 'pill' }, 'lead') : null)))))));
      main.append(chatCard(t));
    }
  }

  // The startup's private channel. Members see it; the accelerator's staff and the other
  // startups do not — membership is the grant, not a workspace-wide permission.
  function chatCard(team) {
    const thread = h('div', { class: 'thread' }, h('p', { class: 'muted' }, 'Opening your team channel…'));
    const input = h('input', { placeholder: `Message ${team.name}…`, autocomplete: 'off' });
    const send = h('button', { type: 'submit' }, 'Send');
    const form = h('form', { class: 'row', style: 'margin-top:10px' }, input, send);
    const card = h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, 'Team chat'), h('span', { class: 'pill' }, 'private to your startup')), thread, form);
    let convId = null;

    const paint = (messages) => {
      clear(thread);
      if (!messages.length) { thread.append(h('p', { class: 'muted' }, 'No messages yet. Say hello — only your startup can see this.')); return; }
      for (const m of messages) {
        const who = m.sender_name || (m.sender && m.sender.name) || 'Someone';
        const body = (m.message && (m.message.content || m.message.text)) || m.body || '';
        const agent = m.from_llm === true || m.sender_type === 'LlmAgent' || !!m.llm_agent || (m.message && m.message.role === 'assistant');
        thread.append(h('div', { class: 'msg' },
          h('div', { class: 'msg-who' }, who, agent ? h('span', { class: 'pill brand', style: 'margin-left:6px' }, 'agent') : null,
            h('span', { class: 'muted small', style: 'margin-left:8px' }, fmt.ago(m.created_at))),
          h('div', {}, body)));
      }
      thread.scrollTop = thread.scrollHeight;
    };

    const refresh = async () => {
      const r = await pmGet(`/llm_conversations/${convId}/llm_messages?limit=50`, true).catch(() => null);
      if (r) paint((r.llm_messages || []).slice().reverse().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)));
    };

    (async () => {
      try {
        const opened = await api('/lp/founders/channel', { method: 'POST', body: { team_id: team.id } });
        convId = opened.conversation_id;
        await refresh();
      } catch (ex) { clear(thread).append(h('p', { class: 'muted' }, `Team chat is unavailable: ${ex.message}`)); form.hidden = true; }
    })();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !convId) return;
      send.disabled = true;
      try {
        await pmSend('POST', '/llm_messages', { llm_message: { llm_conversation_id: convId, message: { role: 'user', content: text } } });
        input.value = ''; await refresh();
      } finally { send.disabled = false; }
    });
    return card;
  }

  // ---------- founder: files ----------
  async function viewFounderFiles(main) {
    const r = await pmGet('/llm_files?limit=50');
    const files = r.llm_files || [];
    clear(main);
    main.append(h('h1', {}, 'Files'), h('p', { class: 'lede' }, 'Files owned by you or your startup, and anything shared with you. Nobody else’s.'));
    const card = h('div', { class: 'card' });
    if (!files.length) card.append(h('div', { class: 'empty' }, 'No files yet.'));
    else card.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['File', 'Type', 'Size', 'Added'].map((x) => h('th', {}, x)))),
      h('tbody', {}, files.map((f) => h('tr', {},
        h('td', {}, f.title || f.filename || `File #${f.id}`), h('td', { class: 'muted' }, f.file_type || f.mime_type || '—'),
        h('td', { class: 'num' }, f.file_size ? `${Math.round(Number(f.file_size) / 1024)} KB` : '—'),
        h('td', { class: 'muted' }, fmt.date(f.created_at))))))));
    main.append(card);
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Uploading and organising'),
      h('p', {}, 'Upload, folders and previews live in the workspace app.'),
      founderState && founderState.sso_available ? h('button', { onclick: () => openPortableMind('/app/files') }, 'Open Files ↗') : h('p', { class: 'muted' }, 'Ask your accelerator to switch on single sign-on to open it from here.')));
  }

  // ---------- founder: orchestration runs ----------
  async function viewFounderRuns(main) {
    const [templates, runs] = await Promise.all([
      pmGet('/orchestration_templates?limit=-1', true).catch(() => ({})),
      pmGet('/orchestration_executions?limit=25', true).catch(() => ({})),
    ]);
    const tpl = templates.orchestration_templates || [];
    const ex = runs.orchestration_executions || [];
    clear(main);
    main.append(h('h1', {}, 'Programme runs'), h('p', { class: 'lede' }, 'Work your accelerator has published for startups to run — applications, diligence packs, reviews. You see your startup’s runs and nobody else’s.'));
    const start = h('div', { class: 'card' }, h('h2', {}, 'Start something'));
    if (!tpl.length) start.append(h('p', { class: 'muted' }, 'Your accelerator has not published anything to run yet.'));
    else start.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('tbody', {}, tpl.map((t) => h('tr', {},
        h('td', {}, h('div', {}, t.name), t.description ? h('div', { class: 'muted small' }, t.description) : null),
        h('td', {}, h('button', { class: 'ghost', onclick: () => startRunModal(t) }, 'Start'))))))));
    main.append(start);
    const card = h('div', { class: 'card' }, h('h2', {}, 'Your runs'));
    if (!ex.length) card.append(h('div', { class: 'empty' }, 'No runs yet.'));
    else card.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Run', 'Stage', 'Started', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, ex.map((r) => h('tr', {},
        h('td', {}, r.name || `Run #${r.id}`), h('td', {}, r.current_stage_name || '—'), h('td', { class: 'muted' }, fmt.ago(r.created_at)),
        h('td', {}, founderState && founderState.sso_available ? h('button', { class: 'link', onclick: () => openPortableMind(`/app/orchestration/${r.id}`) }, 'Open ↗') : null)))))));
    main.append(card);
  }

  function startRunModal(t) {
    const name = h('input', { value: `${t.name} — ${me.user.name}`, required: true });
    const btn = h('button', { type: 'submit' }, 'Start run');
    const form = h('form', {}, fld('sr-name', 'Name this run', name), h('p', { class: 'muted small' }, 'Your accelerator sees it; other startups do not.'), h('div', { class: 'actions' }, btn));
    const m = modal(`Start ${t.name}`, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true;
      try {
        await pmSend('POST', '/orchestration_executions', { orchestration_execution: { orchestration_template_id: t.id, name: name.value.trim() } });
        m.close(); toast('Run started.', 'good'); render();
      } finally { btn.disabled = false; }
    });
  }

  async function addTeammateModal(t) {
    const r = await api('/lp/founders/join-link', { method: 'POST', body: { team_id: t.id } });
    const link = `${location.origin}/#/signup?w=${encodeURIComponent(me.workspace)}&join=${encodeURIComponent(r.token)}`;
    modal(`Invite a colleague to ${t.name}`, h('div', {},
      h('p', {}, 'Send this link to your colleague. They register with their own email and password and join your startup directly.'),
      h('div', { class: 'secret-once' }, link),
      h('p', { class: 'muted small' }, `Anyone with the link can join ${t.name} until ${fmt.date(r.expires_at)}, so share it only with colleagues.`)),
      [h('button', { class: 'ghost', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copied.', 'good'); } catch (_) { toast('Select the link and copy it.'); } } }, 'Copy link'),
       h('button', { onclick: () => clear($('#modal-root')) }, 'Done')]);
  }

  boot();
})();
