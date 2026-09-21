'use strict';

// Founder work lanes: assistants (agents) and programme runs, inside this app.
//
// Founders never leave this app and never see the platform behind it, so everything they do with
// agents and orchestrations happens here:
//
//   GET  /lp/founders/assistants              the agents the accelerator made available to founders
//   POST /lp/founders/assistants/:id/open     the caller's own private conversation with that agent
//                                             (created once; the agent is added as a member)
//   POST /lp/founders/assistants/:id/send     post into it. The server prepends the agent's
//                                             @mention (mention-dispatch is what wakes the agent),
//                                             so the browser never composes routing text.
//   POST /lp/founders/runs                    start a published programme, owned by the startup TEAM
//                                             so teammates share it
//
// What agents know about the startup: its own answers to the accelerator's forms (lib/lanes/forms.js
// startupData — founder-visible fields of the team's own records only). They reach agents through
// the platform's own channels, never inside a founder's message:
//   - a programme run carries them as `context.startup_data`; each step's instructions say to use it;
//   - an assistant conversation carries them as its `system_prompt` (the platform's per-conversation
//     context), set when the conversation is created and refreshed when the answers change.
//   GET  /lp/founders/runs/:id/artifacts/:aid the text of one run output, fetched server-side
//                                             (the platform answers with a signed storage redirect
//                                             the browser must not see)
//
// Reads of runs, stages and gate decisions go through the /api/v1 pipe as the founder: the
// platform scopes runs to the founder's own party and team, and approve/reject to their own runs.

const crypto = require('crypto');
const { HttpError, sendJson, readJson, str, posInt } = require('../http');
const { messageOf } = require('../pm');

const MAX_MESSAGE = 8000;
const MAX_REQUEST = 20000;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|markdown|x-markdown))/i;

function createFounderWorkLanes({ sessions, store, config, founders, forms }) {
  const call = (s, p, o) => sessions.callAs(s, p, o);

  // Agents an accelerator admin switched on for founders (lib/lanes/accelerator.js).
  const agentsFor = (workspace) => Object.values((store.state.founderAgents || {})[workspace] || {});
  function agentOr404(s, id) {
    const a = ((store.state.founderAgents || {})[s.workspace] || {})[String(id)];
    if (!a) throw new HttpError(404, 'That assistant is not available');
    return a;
  }

  async function assistants(req, res) {
    const s = founders.requireFounder(req);
    sendJson(res, 200, { success: true, assistants: agentsFor(s.workspace).map((a) => ({ id: a.id, name: a.label || a.name, description: a.description || '' })) });
  }

  // The per-conversation context for an assistant chat: who the agent is talking to, and the
  // startup's own form answers. Both inputs are cached (team roster, team records), so this costs
  // no platform call in the steady state.
  async function conversationContext(s) {
    const team = (await founders.callerTeams(s))[0];
    if (!team) return '';
    const { text } = forms ? await forms.startupData(s.workspace, team) : { text: '' };
    return [`You are talking with ${s.user.name || 'a founder'} of the startup ${team.name}.`, text].filter(Boolean).join('\n\n');
  }
  const digestOf = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const chatKey = (s, agent) => `${s.workspace}:${s.user.party_id}:${agent.id}`;
  // assistantChats[key] = { id, context: <digest of the AI context last written to it> }
  const chatFor = (key) => {
    const v = (store.state.assistantChats || {})[key];
    return typeof v === 'number' ? { id: v, context: null } : v || null; // older state stored the bare id
  };
  const rememberChat = (key, chat) => store.update((st) => { st.assistantChats ||= {}; st.assistantChats[key] = chat; });

  // Conversation names are unique per type within a workspace, so the name carries the founder's
  // party id: two founders called "Sam Rivera" never collide, and the name identifies the chat
  // deterministically — the platform stays the source of truth, this app's saved id a shortcut.
  const chatName = (s, agent) => `${agent.name} · ${s.user.name || 'Founder'} #${s.user.party_id}`;

  async function findConversationByName(s, name) {
    const r = await call(s, '/llm_conversations', { query: { limit: 5, search_query: JSON.stringify({ where: { name } }) } });
    return ((r.ok && r.body.llm_conversations) || []).find((c) => c.name === name) || null;
  }

  // One private conversation per founder per agent. Membership is the grant: the founder (added
  // by the platform as creator) and the agent. Nobody else — not teammates, not the accelerator.
  // Verified (exists, agent is a member) when the founder OPENS the assistant — not per message.
  async function ensureConversation(s, agent, context) {
    const key = chatKey(s, agent);
    const known = chatFor(key);
    let id = known && known.id;
    if (id && !(await call(s, `/llm_conversations/${id}`)).ok) id = null; // deleted, or no longer ours
    if (!id) {
      const name = chatName(s, agent);
      const existing = await findConversationByName(s, name);
      if (existing) {
        id = existing.id;
        rememberChat(key, { id, context: null }); // context unknown: refreshContext rewrites it
      } else {
        const made = await call(s, '/llm_conversations', {
          method: 'POST',
          body: { llm_conversation: { name, private: true, llm_conversation_type_id: 'ai-agent', system_prompt: context || undefined } },
        });
        if (!made.ok) throw new HttpError(made.status >= 400 ? made.status : 422, messageOf(made, 'Could not open the assistant'));
        id = made.body.llm_conversation.id;
        rememberChat(key, { id, context: digestOf(context) });
      }
    }
    const members = await call(s, '/llm_conversation_members', { query: { llm_conversation_id: id, limit: -1 } });
    const present = ((members.ok && members.body.llm_conversation_members) || []).some((m) => String(m.party_id) === String(agent.party_id));
    if (!present) {
      const a = await call(s, '/llm_conversation_members', {
        method: 'POST', body: { llm_conversation_member: { llm_conversation_id: id, party_id: agent.party_id, active: true } },
      });
      if (!a.ok) throw new HttpError(a.status >= 400 ? a.status : 422, messageOf(a, 'Could not add the assistant to your conversation'));
    }
    return id;
  }

  // Keep the conversation's AI context current: written only when it differs from what this
  // server last wrote (compared by digest — no read). The founder owns the conversation, so their
  // session may update it.
  async function refreshContext(s, agent, id, context) {
    const key = chatKey(s, agent);
    const digest = digestOf(context);
    const known = chatFor(key);
    if (known && known.id === id && known.context === digest) return;
    const r = await call(s, `/llm_conversations/${id}`, { method: 'PUT', body: { llm_conversation: { system_prompt: context } } });
    if (r.ok) rememberChat(key, { id, context: digest });
  }

  async function openAssistant(req, res, url, agentId) {
    const s = founders.requireFounder(req);
    const agent = agentOr404(s, agentId);
    const context = await conversationContext(s);
    const id = await ensureConversation(s, agent, context);
    await refreshContext(s, agent, id, context);
    sendJson(res, 200, { success: true, conversation_id: id, mention: `@${agent.name}` });
  }

  // Steady state: one platform call — the message. The conversation was verified when opened;
  // if it has gone since (deleted elsewhere), it is re-created once and the message retried.
  async function sendToAssistant(req, res, url, agentId) {
    const s = founders.requireFounder(req);
    const agent = agentOr404(s, agentId);
    const b = await readJson(req);
    const text = str(b.message, MAX_MESSAGE);
    if (!text) throw new HttpError(400, 'Write a message first');
    const context = await conversationContext(s);
    const known = chatFor(chatKey(s, agent));
    let id = known ? known.id : await ensureConversation(s, agent, context);
    await refreshContext(s, agent, id, context);
    const message = { method: 'POST', body: { message: `@${agent.name} ${text}` } };
    let r = await call(s, `/llm_conversations/${id}/chat`, message);
    if (r.status === 404 || r.status === 403) {
      id = await ensureConversation(s, agent, context);
      r = await call(s, `/llm_conversations/${id}/chat`, message);
    }
    if (!r.ok) throw new HttpError(r.status >= 400 ? r.status : 422, messageOf(r, 'Message not sent'));
    sendJson(res, 200, { success: true, conversation_id: id });
  }

  // Start a programme run. The body is rebuilt from an allowlist; the owner is the founder's own
  // startup team (verified server-side), so every teammate sees and can act on the run.
  async function startRun(req, res) {
    const s = founders.requireFounder(req);
    const b = await readJson(req);
    const templateId = posInt(b.template_id);
    const request = typeof b.request === 'string' ? b.request.trim().slice(0, MAX_REQUEST) : '';
    const name = str(b.name, 200);
    if (!templateId) throw new HttpError(400, 'Which programme?');
    const teams = await founders.callerTeams(s);
    const team = b.team_id ? teams.find((t) => t.id === posInt(b.team_id)) : teams[0];
    if (!team) throw new HttpError(403, 'Join a startup team before starting a programme');

    const tpl = await call(s, `/orchestration_templates/${templateId}`);
    if (!tpl.ok) throw new HttpError(404, 'That programme is not available');
    const body = { orchestration_template_id: templateId, owner_party_id: team.id, name: name || undefined, context: {} };
    if (request) body.context.feature_request = request;
    // The startup's own form answers, for every step (the template's instructions refer to it).
    const { data } = forms ? await forms.startupData(s.workspace, team) : { data: {} };
    if (Object.keys(data).length) body.context.startup_data = data;
    const r = await call(s, '/orchestration_executions', { method: 'POST', body });
    if (!r.ok) {
      const missing = r.body && r.body.missing_fields;
      throw new HttpError(r.status >= 400 ? r.status : 422, missing && missing.length ? `Please fill in: ${missing.map((f) => f.label || f.key).join(', ')}` : messageOf(r, 'The programme could not start'));
    }
    const ex = r.body.orchestration_execution || {};
    sendJson(res, 201, { success: true, run: { id: ex.id, name: ex.name } });
  }

  // One output of a run, as text. Authorised by the platform through the run (the founder can
  // view the run), then fetched here so the signed storage URL never reaches the browser.
  async function artifact(req, res, url, runId, artifactId) {
    const s = founders.requireFounder(req);
    const r = await call(s, `/orchestration_executions/${runId}/artifacts/${artifactId}/download`);
    const loc = r.headers && r.headers.get('location');
    if (r.status < 300 || r.status >= 400 || !loc) throw new HttpError(r.status >= 400 ? r.status : 404, 'That output is not available');
    let target;
    try { target = new URL(loc); } catch (_) { throw new HttpError(502, 'That output is not available'); }
    if (target.protocol !== 'https:') throw new HttpError(502, 'That output is not available');
    let f;
    try { f = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(config.backendTimeoutMs || 15000) }); } catch (_) { throw new HttpError(502, 'That output could not be fetched'); }
    if (!f.ok) throw new HttpError(502, 'That output could not be fetched');
    const type = (f.headers.get('content-type') || '').split(';')[0].trim();
    if (!TEXT_TYPES.test(type)) return sendJson(res, 200, { success: true, kind: 'binary', content_type: type });
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > MAX_ARTIFACT_BYTES) return sendJson(res, 200, { success: true, kind: 'too_large' });
    sendJson(res, 200, { success: true, kind: 'text', content_type: type, text: buf.toString('utf8') });
  }

  return { assistants, openAssistant, sendToAssistant, startRun, artifact };
}

module.exports = { createFounderWorkLanes };
