# AGENTS.md — instructions for AI coding assistants working in this repository

This repository is **Launchpad Network**, a reference app for PortableMind Enterprise workspaces and
sub-workspaces. It was built from the partner guide and the companion prompt below, exactly as a new
customer would. When you change it:

- Follow the companion prompt below. It is the platform contract. Where this app needed something the
  prompt does not list, it is called out in the README. Do not add further unlisted endpoints
  without noting them there too.
- Keep the app zero-dependency (Node 20+ built-ins only). Never add a default for `PM_API`,
  `NETWORK_WORKSPACE` or `SECRET_STORE_KEY`.
- Secrets live only in `lib/secrets.js`. Never return one to the browser or log it. Any platform call
  that RETURNS a secret must be blocked in `lib/lanes/proxy.js` and given its own server lane.
- The UI renders data with the `h()` helper (textContent only). Never use `innerHTML`.
- Run `npm test` (unit) and, against staging, `npm run e2e` (see README) before you finish.

App-specific names: the founder role is `lp_founder` (`setup/lp-founder.role.export.json`), and custom
items this app would ship are prefixed `lp_`. In the prompt below, "the network" is the Enterprise
workspace (here: Launchpad Network) and each accelerator is one of its sub-workspaces.

---

# An accelerator network on PortableMind — companion prompt for an AI coding assistant

Paste this whole file into your assistant's system prompt or project instructions (or keep it in the
repository as `AGENTS.md` / `CLAUDE.md`). It is the condensed, rule-first version of the human guide
**"Building an accelerator network on PortableMind"** (the Enterprise partner guide). When the two disagree, the human guide wins; when neither
covers something, **say so and ask — do not guess.**

---

## Your role

You are helping developers build **the network app**, an accelerator-management application, on the
PortableMind platform. The network is an **Enterprise workspace**. It operates **one sub-workspace per
startup accelerator**, publishes **agent templates** down to them, may **share an AI model** down to
them, and has **its own UI** that talks to the PortableMind API through the network's own server.

## Ground rules for you

1. **Never invent an endpoint, parameter, field or error code.** Everything you may use is listed
   below. If a task needs something that is not here, say "this is not covered by the verified
   reference" and ask the developer to confirm with PortableMind.
2. Everything in this reference was read in platform code, exercised end to end on staging, and is
   live in production (released 2026-09-20).
   If the API answers differently from what is written here, stop and tell the developer — do not adapt silently.
3. Items tagged **[not available]** do not exist. Do not design around them. Do not simulate them.
4. The product word is **workspace**; the API word is **tenant**. Use "workspace" in UI copy and
   comments for humans; use the API's spelling in code.
5. **Check `success` in every response body, even on HTTP 200.** Several endpoints report failure as
   `200 { "success": false, "message": "..." }`.
6. Never put a credential in a URL, in browser-delivered config, in logs, or in the repository.
7. Secrets (provisioning keys, sign-on keys, invite codes) live **only on the network's server**.

## Request basics

- Base path: `$PM_API/api/v1`. JSON in, JSON out.
- **Every request carries the workspace identifier (slug), never the numeric id:**
  `Tenant-Id: <identifier>`. Missing/unknown → `400 {"message":"invalid tenant"}`.
- Production origin: `https://www.dsiloed.com`.
- User session: `Authorization: Bearer <jwt>`. API key: `API-KEY: <key>`.
- A user, a session and an API key each belong to **exactly one workspace**. A session sent with
  another workspace's `Tenant-Id` is rejected (`403`).
- URL parameters are not uniform: HTTP reads `?jwt=` / `?apikey=`; the WebSocket `/cable` reads
  `?token=`. Prefer headers; fetch file bytes with the header and save client-side.

## Hard facts about the model

- The workspace tree is **exactly two levels**: the network → accelerator sub-workspaces. A
  sub-workspace can never have sub-workspaces. **Model each startup as a Team inside its
  accelerator's sub-workspace**, founders as users on that team, with a *scoped* security role.
- A sub-workspace is always on `free`, `starter`, `professional` or `business`. **Never
  `enterprise`.** It can never publish templates, share models, or create sub-workspaces.
- Each sub-workspace has its **own plan limits and its own AI token balance**.
- **The parent has no access to a sub-workspace's content**, and no administrative back door.
  It DOES have its **metrics** (parent admin JWT + the parent's `Tenant-Id`; own sub-workspaces only, else 404):
  `GET /tenants?view=dashboard` → per row `stats{users,users_new,agents,active_users_7d,active_users_30d,storage_bytes}`,
  `token_balance`, plan, `spend{token_purchases_30d_cents,…lifetime_cents}` ·
  `GET /tenants/:id/stats` → `{rows,storage_bytes}` for ~80 record kinds (`llm_agents`, `orchestration_executions`,
  `llm_agent_runs`, `llm_conversations`, `users`, `human_users`, `projects`, `llm_files`…) + `activity{last_seen_at,
  active_users_7d/30d, human_messages_30d, agent_runs_30d, ai_cost_cents_30d, ai_cost_cents_total}` + `usage_ledger` ·
  `GET /tenants/:id/llm_cost_stats?start_date=&end_date=` (by model/user/agent/orchestration/conversation) ·
  `GET /tenants/<parent id>/llm_cost_stats?scope=all` → `breakdown[]` + `token_allocations[]{allocated,consumed,
  transferred_tokens, token_balance}`. **`stats` is heavy (counts ~80 tables): run it on a schedule and store
  it, never per page view.** The line is deliberate: NAMES AND NUMBERS, NEVER CONTENT — `llm_cost_stats`
  rows carry the sub-workspace's conversation names and people's names/emails; never show one accelerator's
  labels to another. There is NO call for a sub-workspace's conversations, files,
  members, agent configuration, audit trail or per-person sign-ins: do not invent one.
  Anything that happens *inside* a sub-workspace needs a credential that belongs to it.
- Installing a template is **copy-on-install**: the agent becomes the sub-workspace's own.

## Prerequisites that are NOT self-service

`POST /tenants` creates nothing unless: (1) the network is on Enterprise; (2) PortableMind has recorded
an **active billing agreement** on the network with an **allowance** (how many sub-workspaces) and a
**contract tier** (highest plan allowed); only PortableMind staff can set or change it. The network's own
admins get `403` on the agreement endpoints — do not write code that calls them.

Read-only checks the network may call:

```
GET /tenants/subscription_status      → .billing_agreement  (null | {role:"holder", sub_tenant_allowance,
                                         covered_count, contract_tier, billing_method, ...}
                                         | {role:"covered", holder_name})
                                        .offboarding  (null | {state, grace_ends_at, former_parent_name})
                                        .published_limits [{limit_type, used, limit}]
                                        .fair_use {limits:[{limit_type, period, used, limit, near_limit, reached}], warnings}
GET /agent_templates/entitlement      → {publishing: bool, has_children: bool}   (never 403)
```

## Verified endpoint reference

### Sub-workspaces (caller: network admin, `Tenant-Id: <network>`)

```
POST /tenants
  body: { name*, user_first_name*, user_last_name*, user_email*, user_password*,
          enterprise_identifier?, subscription_plan? ("free"|"starter"|"professional"|"business";
          default = contract tier), activation_needed_email_subject?, activation_needed_email_template?
          (must contain {{token}}), skip_activation_needed_email? (true = built at once, no email; the parent
          then knows the first admin's password — force a change or use a service admin) }
  → 200 { "success": true }            ← NOTHING ELSE. No id.
  → 422 code: sub_tenant_agreement_required | sub_tenant_allowance_reached | outside_contract | plan_not_offered
  → 403 code: feature_not_in_plan      (caller not on Enterprise)

GET  /tenants?limit=-1                 → { tenants: [ { id, enterprise_identifier, description, root_user,
                                                        token_balance, agreement_billed, ... } ] }
GET  /tenants/:id                      (id or identifier)
GET  /tenants/:id/stats
GET  /tenants/:id/llm_cost_stats?start_date=&end_date=
PUT  /tenants/:id/change_subscription  body: { product_type, pricing_plan }   ← signed-in ADMIN USER only, not an API key
                                       → 422 outside_contract | plan_not_offered | billing_managed_by_agreement
DELETE /tenants/:id                    → { job_id }   (background, permanent)
```

Behaviour you must code for:

- By default the call **stages** a signup and emails the named admin. **The sub-workspace does not
  exist until that person activates.** It will not appear in `GET /tenants` until then. Write a
  "pending activation" state; poll gently.
- A requested `enterprise_identifier` that is already taken is **silently replaced**. Always read it
  back from `GET /tenants`. Store **both** numeric `id` and `enterprise_identifier`. Match a pending
  create on `root_user.email` among rows NEW since the request — never on the identifier alone.
- With `skip_activation_needed_email: true` the first admin IS flagged `requires_password_change` (the
  parent chose and knows the password): generate a strong one; your UI must let them replace it.
- Your own numeric workspace id = `tenant_id` on `GET /users/current`. `llm_cost_stats` totals:
  `summary.total_cost_cents`, a STRING. New sub-workspaces show 2 default agents in `stats` that do not
  count toward `agent_count`.
- Every sub-workspace counts toward the allowance at creation, free ones included.
- `pricing_plan` is `free_usd`, `starter_usd`, `professional_usd` or `business_usd` (matching the tier).

### Agent templates — publisher side (network admin)

```
GET  /agent_templates/memory_candidates?llm_agent_id=ID → { memories:[{id,title,memory_type,default_selected}] }
POST /agent_templates          body: { source_llm_agent_id*, name*, description?, category?, memory_ids?,
                                       include_runbooks?, release_notes?, sharing? }   → 201 { agent_template }
POST /agent_templates/:id/publish   body: { release_notes?, memory_ids?, include_runbooks?, source_llm_agent_id? }
                                    → 200 { agent_template, version:{id,version,manifest} }
PUT  /agent_templates/:id/sharing   body: { "sharing": { "mode": "private"|"all_children"|"selected",
                                                         "grantee_tenant_ids": [NUMERIC ids] } }
GET  /agent_templates               GET /agent_templates/:id        GET /agent_templates/:id/installs
PUT  /agent_templates/:id  { name?, description?, category?, active? }      DELETE /agent_templates/:id
```

- A template is a **snapshot of a real agent**. There is no template editor. List source agents with
  `GET /llm_agents?limit=-1`; automation may create one with `POST /llm_agents/wizard { wizard:{ name,
  description, llm_model_id, system_prompt_body, persona_body, tool_iids } }`.
- **Agent names: letters, digits, `-`, `_` only (1–128). No spaces** — this applies to the install
  `name` too (`"Intake Analyst"` → 422). Omit `name` to use the source agent's name; if you pre-fill
  from the template's display name, replace spaces with `-`.
- `memory_ids` omitted = portable default set; `[]` = none. **It is NOT remembered between
  versions — send it on every publish.**
- The `sharing` wrapper is required; a bare `{mode}` is ignored.
- **Sharing ≠ installing.** The parent cannot install for a sub-workspace — by design; do not work around it.

### Agent templates — installer side (sub-workspace admin, `Tenant-Id: <sub-workspace>`)

```
GET  /agent_template_catalog            → { agent_template_catalog:[{id,name,own,publisher_tenant_name,current_version,installs}] }
GET  /agent_template_catalog/:id        → { agent_template_catalog_entry:{ current_version:{id,version,release_notes,manifest} } }
POST /agent_template_catalog/:id/install
     body: { name?, accept_code?, expected_version_id?, auto_upgrade?, llm_model_iid?, customizations? }
     → 201 { install:{id,version,...}, llm_agent:{id,name} }
     → 422 code: code_not_accepted | version_changed | name_taken | conflicts (+ conflicts:[...])
     → 404 not shared with this workspace      → 402 agent limit of the plan reached
GET  /agent_template_installs           → { agent_template_installs: [{ id, agent_template_id, template_name,
                                             publisher_tenant_name, llm_agent_id, agent_name, version,
                                             latest_version, latest_version_id, upgrade_available,
                                             upgrade_requires_consent, latest_release_notes, installed_manifest,
                                             latest_manifest, auto_upgrade, installed_at, upgraded_at }] }
POST /agent_template_installs/:id/upgrade   body: { accept_code?, expected_version_id? }  → { install, changes }
                                            → 422 code: up_to_date | not_found | code_not_accepted | version_changed
PUT  /agent_template_installs/:id           body: { auto_upgrade: bool }
DELETE /agent_template_installs/:id         (detach: agent stays, upgrades stop)
```

Consent rules to implement in the UI:

- If `manifest.requires_consent` is true: show the manifest (`code_bearing`, `tool_iids`,
  `resource_iids`, `custom_tools`, `custom_resources`, `skills`, `skill_tool_iids`,
  `skill_custom_tools`, `schedule`, `skill_schedules`, `skill_triggers`, `security_roles`,
  `security_roles_exclusive`, `required_customizations`, `scrubbed_keys`, `memory_count`, `runbooks`),
  get an explicit confirmation from a sub-workspace admin, then send `accept_code: true` **and**
  `expected_version_id` = the version that was shown.
- `version_changed` is a normal outcome. Re-fetch, re-show, re-confirm. Never auto-retry with a new id.
- Upgrades need consent again only when `upgrade_requires_consent` is true; diff the two manifests.
  Auto-upgrade skips versions that need consent.
- `scrubbed_keys` = settings removed before publishing. **Credentials never travel.** Build a
  "finish configuring this agent" step.
- Prefix the names of every custom tool, skill and function the network ships (`lp_…`) to avoid
  `conflicts`.

### Shared models (network admin)

```
GET /llm_models/:id/family_sharing
PUT /llm_models/:id/family_sharing   body (NO wrapper): { mode*, monthly_spend_cap_usd?,
                                                          grants?: [ { tenant_id (NUMERIC), monthly_spend_cap_usd? } ] }
→ { family_sharing: { mode, monthly_spend_cap_usd, grants:[{tenant_id, tenant_name, monthly_spend_cap_usd,
                                                            own_monthly_spend_cap_usd, spend_this_month_usd}] } }
```

- Only a model the network **owns**; Enterprise only. The provider key is never visible downstream.
- The cap is **soft**: checked before a turn, recorded after. Expect a small overshoot; the *next*
  turn is refused. Period = calendar month, UTC. Unpriced models are effectively uncapped.
- Background AI for a sub-workspace never runs on the shared model; it uses that sub-workspace's own tokens.
- Create the model in the app or over REST: `GET /product_types?type=LlmModelProductType&limit=-1`, then
  `POST /llm_models { llm_model:{ description, internal_identifier, llm_model_product_type_id,
  custom_fields:{ api_key } } }`. Every model carries `cost_source`: `own_key` | `tokens` | `parent_key`.

### Sign-in, sessions, users

```
POST /authenticate     headers: Tenant-Id   body: { email|username, password }
   → { success, jwt, user }  OR  { mfa_required, mfa_token, expires_in }  OR  { mfa_enrollment_required, ... }
POST /mfa/verify       body: { mfa_token, code }   → { success, token, user }        ← `token`, not `jwt`
POST /auth/refresh     headers: Authorization, Tenant-Id   → 200 { success, token, expires_at } | 401
PUT  /users/current/update_password  body: { password, current_password? }  → { jwt }
                       (current_password not needed while the account is on a temporary password)
GET  /users/current    → { user: { ..., tenant_enterprise_identifier, party_id } }
GET  /password_policy/effective   (no auth; Tenant-Id required)
POST /users            (server-side, provisioning API key)
   body: { user:{ email, password, first_name, last_name, skip_activation_needed_email, skip_welcome_email },
           security_role_iids: "role_a,role_b",  team_name? | team_id? }   → user + team_id
POST /api_keys         body: { api_key:{ description, active } }  → key plaintext returned ONCE (.api_key.key)
PUT  /api_keys/:id     body: { api_key:{ active:false } }         (retire a replaced key — active keys are capped per plan)
GET  /security_roles?limit=-1   → { security_roles:[{ id, internal_identifier, external }] }   (find `provisioner`'s id)
POST /security_roles/import     body: { data:<role export incl. "external": true>, overwrite:true }   (sub-workspace admin)
GET  /teams?limit=-1            → { data:[{ id, name }] }                         (provisioner key can read)
GET  /teams/:id/members?limit=-1 → { data:[{ party_id, user_id, name, email, is_lead }] }
POST /security_role_assignments  body: { security_role_assignment:{ accessor_record_type:"APIKey"|"User",
                                          accessor_record_id, security_role_id } }
```

- Sign-in returns `jwt`; refresh and MFA verify return `token`. Handle the MFA shapes — a response
  without `jwt` is not necessarily a failure. Sign-in may carry `requires_password_change: true`
  (temporary password): make the person set one.
- Sessions last ~24 h and are all revoked on password change. Implement: refresh on load, refresh on
  a timer, and on `401` refresh once + retry once (coalesce concurrent refreshes).
- **Always send `security_role_iids`** when creating end users; without it the user gets a broad
  default role and sees everything. A provisioning key may grant roles flagged *external*, PLUS the
  app-section roles `app_chat` / `app_files` / `app_projects` / `app_tickets` when the same call also
  grants an external role (`app_admin` is refused — Administration + AI Studio). Grant
  **`"external_member,<your role>,app_chat,app_files,app_projects"`**: `external_member` is the built-in external baseline (what the
  PortableMind app needs to load — notifications, preferences, saved views; no business data); every
  other built-in role (`applicant`, `basic`, `app_*`) is `external:false` → 403. Import your own role
  per sub-workspace with `POST /security_roles/import`, `"external": true`, business data only, every
  read scoped `{ "where": { "owner_party_id": { "in": "current_party_and_team_ids" } } }` (an unscoped
  read beats every scoped one). Prefix it (`lp_…`). An unknown role name is SKIPPED SILENTLY —
  verify both exist via `GET /security_roles` before opening sign-ups.
- **Public sign-up: do NOT send `skip_activation_needed_email`.** Without it the account is `pending`
  until the emailed link is clicked (proves the address) and the password is not flagged. With it the
  account is active unproven AND its password is temporary (`requires_password_change`). Skip only for
  operator-driven provisioning.
- Adding a colleague: never generate-and-hand-over a password. Issue a server-signed, expiring join
  link naming `team_id` to a verified member; the colleague registers with their own email + password.
- **`team_name` ALWAYS creates a new team.** To join an existing team use `team_id`, and only after
  the server has verified the caller is a member of that team.
- Before any privileged server-side action, call `GET /users/current` with the caller's session and
  compare `tenant_enterprise_identifier` to the expected workspace. Never trust a browser-sent header.
  Verify team membership by matching the SESSION's `party_id` against the roster.

### Branding and sign-on (white-label)

A sub-workspace **inherits** white-label from its Enterprise parent, so all of this works per
accelerator. Each workspace has its own switch, its own branding and its own sign-on key.

```
GET  /white_label                       → { white_label:{ entitled, enabled, gate_open, inherited_from,
PUT  /white_label                                          sso_key_present, settings:{...} } }   (never the key)
POST /white_label/sso_key  { rotate? }  → 201 { sso_shared_key, tenant_enterprise_identifier }   ← shown ONCE
     same three under  /tenants/:id_or_identifier/white_label[/sso_key]   (parent admin → its DIRECT sub-workspace)
PUT body (flat): enabled, auto_provision, default_role, visible_apps[], app_name, primary_color, app_base_url,
                 powered_by, custom_section{label,nav_items[{label,url}]}, return_url_allowlist[]
→ 403 code feature_not_in_plan | 404 not yours / sponsored account / sub-workspace being offboarded
  | 422 code invalid | sso_key_exists | 503 code audit_unavailable | temporarily_unavailable (nothing changed; retry)
GET  /public/branding?tenant=<identifier>   (no auth) → { enabled:false, powered_by } | { enabled:true, app_name,
        logo_url, logo_dark_url, primary_color, theme?, visible_apps, custom_section, return_url_allowlist, powered_by }
POST /sso/exchange   body: { assertion }    assertion = HS256 JWT signed with THAT workspace's sso_shared_key:
        { sub, email?, tenant_enterprise_identifier, jti (unique), iat, exp ≤ iat+120 }  → { token, user, ... }
```

- Admin **users** only for `/white_label` (never an API key). `default_role` must exist in the target
  workspace and is refused if it holds more than the built-in `basic` role on users / roles / permissions /
  configuration / API keys / workspaces, can create or run functions, or is named like an admin role.
  Re-checked at sign-in: an unusable pinned role makes `/sso/exchange` answer 403 for NEW people (never a
  silent fallback to a broader role) — surface that as "check the pinned role".
- URLs (`app_base_url`, nav item `url`) must be http(s) with no credentials. `custom_section` is replaced
  whole. `visible_apps: null` clears. `GET` never writes.
- A sub-workspace that leaves the family has white-label switched off and ITS KEY REMOVED — delete your
  stored key for it when you see `offboarding` resolve.
- PortableMind support can flip a workspace's white-label SWITCH on request (audit: `platform_operator`) — never
  a key, never settings. `PUT … { enabled: false }` always works, even off-plan; it stops NEW sign-ins only.
- The sign-on key is NOT an API key and is never sent on an API call. It signs the one-time assertion
  that carries an already-signed-in user of the network's app into the PortableMind app without a second login.
  If the network's UI never sends people into the PortableMind app, no sign-on key is needed — do not
  create one "just in case".
- Store each sign-on key server-side, keyed by workspace, the moment it is returned. It cannot be read
  again; `rotate: true` kills the old key instantly.
- A section of the app opens on a ROLE NAME (`app_chat`, `app_files`, `app_projects`, `app_tickets`),
  not on capabilities. Grant them and your end users get real chat/files/projects, showing only what
  their scoped role admits; withhold them and they land on "no access". `app_admin` = AI Studio +
  Administration: never for end users — they use agents by CHATTING with one.
- **Whoever holds a workspace's sign-on key can sign in as anyone in it.** Sign assertions only for a
  user the server verified via `GET /users/current`, never for a browser-supplied identity.
- Logo / theme / email templates: `/tenant_branding/*`, by the workspace's OWN admin. Logos PNG/JPEG/WebP
  ≤ 5 MB, square. `powered_by` always has a value.

## What your end users do in the workspace

- **Chat**: one PRIVATE channel per customer team; membership is the grant (members see it, staff and
  other teams do not). Scope every conversation read by membership —
  `{"joins":["llm_conversation_members"],"where":{"llm_conversation_members.party_id":"current_party_id"}}`
  for view/chat/link_entity, and `{"joins":["llm_conversation.llm_conversation_members"],…}` for
  `view LlmMessages`. `create LlmConversations` / `LlmMessages` / `LlmConversationMembers` unscoped.
  `POST /llm_conversations {llm_conversation:{name, private:true, llm_conversation_type_id:"channel"}}`
  — the type takes its NAME, not a number. `POST /llm_conversation_members
  {llm_conversation_member:{llm_conversation_id, party_id, active:true}}`. Message body is an OBJECT:
  `POST /llm_messages {llm_message:{llm_conversation_id, message:{role:"user", content:"…"}}}`.
  Read: `GET /llm_conversations/:id/llm_messages`.
- **Keep the platform behind your app.** Sign-on (7.4) is for your STAFF. End users get no button, no
  "powered by", and your server refuses the sign-on lane for their role. Everything below works via the API.
- **Agents**: one private `ai-agent` conversation per end user per agent, created AS the user, name
  `[A-Za-z0-9_-]{1,128}`, unique per type (build it: `<agent>_founder-<party_id>`), the agent added as a
  member. Wake it with an `@<AgentName>` prefix your SERVER adds (strip it on display); post with
  `POST /llm_conversations/:id/chat {message}`. Context for the agent = the conversation's
  `system_prompt` (set on create; refresh with `PUT … {llm_conversation:{system_prompt}}`, owner-scoped
  `update LlmConversations`) — platform v2026.73.0+. Never put context inside the user's message; never
  give agents a tool that reads end users' records directly. Agent replies have `role:"user"` — detect
  them by `llm_agent`. Message lists are oldest-first.
- **Runs (end-user side)**: `POST /orchestration_executions` with TOP-LEVEL fields
  `{orchestration_template_id, name, owner_party_id: <team party>, context: {feature_request, …}}` — a
  nested object is ignored. Extra `context` keys reach every step; tell the steps in the template's stage
  prompts. Read `GET /orchestration_executions/:id` (stages, artifacts) or `/status`. Artifact content:
  `GET …/artifacts/:aid/download` = 302 to a signed URL — fetch server-side, never give it to the
  browser. `approve_stage {notes}` / `reject_stage {reason}` (reason required). Templates must be
  published: `PATCH /orchestration_templates/:id/publish`.
- **Custom objects (your own forms/data)**: types are defined per workspace in Administration →
  Custom Objects (`GET /dynamic_model_types` → `field_definitions.fields/sections`; honour `read_only`
  and `visible:false`). End users get NO custom-object permission (rows have no owner column). Your
  server uses a key whose role is exactly `view DynamicModelTypes`, `view/create/update DynamicModels`,
  `view/create DynamicModelPartyRoles`, `view RoleTypes` (+ `destroy DynamicModels` for rollback only).
  Own each row with a `DynamicModelPartyRole` (team party, role type `owner`); find a team's rows via
  its owner links then `search_query {"where":{"id":{"in":[…]}}}`. The platform rejects unknown keys and
  bad options but NOT a missing `required` — validate on your server.
- **Customer teams must be open or closed, never hidden**: a hidden team is invisible to API keys (and
  to non-members) on every API; team export needs a workspace admin or the team lead.
- **Files**: `create LlmFiles` + `view` scoped `{"where":{"owner_party_id":{"in":"current_party_and_team_ids"}}}`.
- **Projects / tasks / runs**: same owner-or-team scope + create. Runs mirror the platform's
  participant shape: `create OrchestrationExecutions`, owner-or-team `view`, `approve_stage`,
  `reject_stage`, and `view OrchestrationTemplates` scoped `{"published":true,"private":false}`.
- **NEVER give an external role an UNSCOPED read on a model with a `private` flag** (conversations,
  files, directories): an unscoped read is a workspace-wide class grant. The platform now keeps such
  a grant away from private records of an external member, but write the scoped shape anyway.
- **`owner_party_id` / `owning_team_id` are always the creator** and cannot be supplied. "The team
  owns it" needs an explicit share — or a channel, where membership already covers the team.

## Errors to handle centrally

| Status | Shape | Meaning → action |
|---|---|---|
| 400 | `message: "invalid tenant"` | Missing/wrong `Tenant-Id` — a bug in your routing |
| 401 | `token expired` / `Invalid Access` | Refresh once, retry once, else sign out |
| 402 | `error_type: "billing_required"` | Workspace is in billing-only mode → route to a billing screen. Only `GET /users/current` and the billing endpoints still work |
| 402 | other `error_type` (+ upgrade links) | Plan limit, fair-use guardrail, or empty token balance → show the named limit |
| 402 | `error: "billing_managed_by_parent"` | Token purchase refused for a workspace on its parent's card |
| 403 | `code: "feature_not_in_plan"` | Needs Enterprise |
| 422 | `code: ...` | Business-rule refusal — switch on `code`, show `message` |
| 429 | `error_type: "api_requests_per_minute"` + `Retry-After` / `"api_requests_daily"` | Back off; honour `Retry-After` |

## Limits that shape the design

- **No per-seat pricing, no user limit.** Never build seat counting.
- Published limits (free / starter / professional / business): storage 10 MB / 100 MB / 1 GB / 5 GB;
  projects 1 / 5 / 25 / 50; conversations 5 / 25 / 50 / 100; tasks 25 / 75 / ∞ / ∞;
  agents 1 / 3 / 10 / 25; tokens 1M once* / 5M / 20M / 60M per month.
  *Sub-workspaces do **not** get the one-time Free grant — a Free sub-workspace starts at **zero**.
- Tokens are drawn only on **platform models** (and platform-key images/video, background AI).
  Turns on a **parent-shared model** or the workspace's **own key** draw nothing.
- **Funding a sub-workspace:** `POST /tenants/:id/transfer_tokens { amount, reference? }` (parent admin)
  → `{ new_balance (the sub-workspace's), source_balance, source_purchased_balance }`. **Live in
  production.** It moves tokens the network has BOUGHT; the plan's monthly allowance is never transferable
  — a permanent rule, not a missing feature (`422 insufficient_purchased_tokens`); all-or-nothing;
  `reference` (≤ 200 chars) is an idempotency key — always send one; a replay answers 200 with
  `idempotent: true`, moves nothing, and reports the ORIGINAL amount. Statuses: 404 target not yours /
  unknown (ambiguous on purpose), 422 `not_own_sub_tenant` | `insufficient_purchased_tokens` |
  `invalid_transfer_amount` (also over the 1,000,000,000 ceiling) | `invalid_transfer_reference`, 403 no
  permission, 400 missing field. **IRREVERSIBLE** — no transfer back, none between siblings, a departing
  sub-workspace keeps its tokens: always put a human confirmation in front of it.
  `POST /tenants/:id/allocate_tokens` is staff-only (`403`) — never call it. Alternatives: share a model
  with a cap; a bigger plan; the sub-workspace buys its own pack (`POST /llm_token_purchases
  { product_type_identifier, payment_method_id }`) — a covered sub-workspace can, and stays covered; only one
  on the PARENT's card gets `402 billing_managed_by_parent`. A wrong transfer is fixed by a SUPPORT TICKET.
- People signed in through the network's own UI (password or sign-on exchange) are **not** rate-limited.
- **API keys are metered on the owning workspace's plan** (per day / per minute / max active keys):
  free 1,000 / 60 / 2; starter 10,000 / 120 / 5; professional 50,000 / 300 / 20; business
  250,000 / 600 / 50. Do not poll with keys. Use `/cable` for live updates and per-user sessions for
  per-user traffic.

## Offboarding (code the states, do not fight them)

Triggered when the network leaves Enterprise, the agreement ends, or the allowance drops below the count.
- Sub-workspace on **Free** or paying for itself → **independent immediately**; shares withdrawn.
- Otherwise → **14-day free grace** (`offboarding.grace_ends_at`), everything works; reversible if
  the network restores coverage.
- After grace → **billing-only mode**: every call `402 billing_required`; agents halted; nothing deleted.
- Recovery: **only an admin of that sub-workspace**, with **their own card**, via
  `PUT /tenants/<its id>/change_subscription` + `stripe_token` (a payment-method id). A plan change by
  the former parent does not unlock it. It never returns under the network's agreement.

## Server architecture to follow

```
Browser → network server (same origin) → PortableMind API
  /api/*, /cable   forward as-is with the signed-in user's own session (must pass WebSocket upgrades)
  one privileged lane: POST /users only, body REBUILT from an allowlist, key attached server-side
  /config.js       non-secret runtime config only
  file lane        takes IDs, never a URL; resolves the record's signed `url` server-side and streams bytes
```

- **Resolve the workspace per request.** Provisioning key, sign-on key and invite settings are all
  **per workspace**; load them from a secret store keyed by workspace. The reference ticket portal is
  single-workspace — do not copy that assumption.
- No default values for backend URL, workspace or keys: **fail at start-up** if missing.
- Every outbound call has a **timeout**. Every gate you cannot read **fails closed**.
- Serve static files from an explicit allowlist. Never serve the repository root.
- If your server blocks API paths, match the CANONICAL path: the platform collapses `//` and accepts
  `.json`, so `//api_keys` and `/api_keys.json` = `/api_keys`. Collapse slashes, strip the suffix,
  refuse `%2f`/`%2e`, and forward the canonical path. Block every call that RETURNS a secret
  (`POST /api_keys`, `POST …/sso_key`) from any browser-facing pipe; handle them server-side.
- Workspace configuration keys ending in `_token`, `_key`, `_secret` are encrypted and **not
  readable by an API key** — name server-read settings accordingly (e.g. `invite_code`).
- `custom_fields` on records is replaced wholesale on update: read, merge, write.
- Identify an agent's chat messages by any of `role=="assistant"`, `from_llm==true`,
  `sender_type=="LlmAgent"`, or a present `llm_agent` — never by `sender_name` alone.

## Do NOT

- Do not create a workspace per startup.
- Do not copy the six-call "create user, delete default role, assign role, create team" chain from
  the older accelerator reference app, or expose role/team/user-deletion endpoints on an
  unauthenticated lane. Use the single `POST /users` call.
- Do not call `GET /llm_files/:id/download` — it does not exist.
- Do not call the billing-agreement endpoints or `allocate_tokens`.
- Do not send a top-level `tenant_id` field in any query string or JSON body: the platform reads it as
  the CALLING workspace, ahead of the `Tenant-Id` header. Nested ones (`grants[].tenant_id`) are fine.
- Do not store a session token anywhere it cannot be refreshed (static config, cron). Use an API key.
- Do not treat a missing `jwt` on sign-in as a wrong password.
- Do not assume `POST /tenants` returned a usable workspace.
- Do not name an agent (or an install) with spaces.
- Do not grant `applicant` or `basic` from a provisioning key; `app_admin` is refused too. The other
  `app_*` section roles are fine alongside an external role.
- Do not leave a conversation/file read unscoped on an external role.
- Do not send a message body as a string, or a conversation type as a number.
- Do not use `skip_activation_needed_email` on an internet-facing sign-up.
- Do not give end users a way into the PortableMind app if your product hides the platform.
- Do not hide agent context in a user's message; do not nest the run-start body.
- Do not grant end users custom-object permissions; do not trust the platform to enforce `required`.
- Do not send a plain list in `search_query` (`{"id":[1,2]}`) — use `{"in":[…]}`.
- Do not make customer teams hidden.

## Settled — do not re-open

- The parent **cannot** install a template for a sub-workspace, by design. Consent belongs to the
  sub-workspace's admin. Build a good "review and install" screen instead.
- The parent MAY manage a sub-workspace's white-label (switch, settings, sign-on key) without asking it;
  each key change lands in that sub-workspace's audit log. Sponsored partner accounts do not inherit white-label.
- Token transfer (parent → its own sub-workspace, purchased tokens) is LIVE — build on it. There is no
  transfer back and none between sub-workspaces.
- A token transfer cannot be reversed by the customer: support ticket. Do not build a "reverse" button.
- Everything listed here is live in production.
