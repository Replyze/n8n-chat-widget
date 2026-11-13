// A stand-in for everything the workflows call, for tests without a Replyze
// account or an LLM key. One HTTP server, no dependencies:
//
//   /api/v1/...            the Replyze REST API endpoints the workflows use, with the
//                          same paths, auth, objects and errors as client.replyze.chat
//                          (back/app/Http/Controllers/PublicApi, Services/PublicApi/ApiResources.php)
//   /openai/v1/...         an OpenAI-compatible chat model with scripted answers: it calls
//                          the knowledge base tool, or the hand-off tool when the customer
//                          asks for a person, then answers from what the tool returned
//   /hooks/slack           a Slack incoming webhook
//   /sheets/rows           where the Google Sheets step writes in the test copy
//   /__log, /__reset, /__state   for the test: every request, and the fake workspace
//
// Run on its own:  node tests/mock-server.mjs --port 47790
// Every request is printed and kept in memory.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const TEST_API_KEY = 'rpz_live_test_key_for_the_mock_only';

const now = () => new Date();
const apiTime = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : null); // toIso8601ZuluString

/** The fake workspace: two teammates, a knowledge base, conversations and their messages. */
function freshState() {
  return {
    nextMessageId: 1000,
    nextTagId: 10,
    agents: [
      { id: 7, name: 'Ana', avatar_url: null, role: 'agent', availability: 'online', is_online: true },
      { id: 8, name: 'Marko', avatar_url: null, role: 'admin', availability: 'away', is_online: false },
    ],
    tags: [{ id: 3, name: 'vip' }],
    conversations: {},
    messages: {},
    knowledge: [
      {
        object: 'knowledge_result', type: 'article', article_id: 41, title: 'Shipping times',
        url: 'https://help.example.com/en/articles/shipping-times',
        content: 'Orders ship within 1 business day. Delivery takes 2 to 4 business days in the EU and 5 to 8 days elsewhere.',
      },
      {
        object: 'knowledge_result', type: 'website', source_id: 2, page_id: 19, title: 'Returns', heading: 'How to return an item',
        url: 'https://example.com/returns', file: null,
        content: 'You can return any unused item within 30 days for a full refund. Start a return from your account page.',
      },
    ],
    idempotency: {},
  };
}

let state = freshState();
let log = [];

/** A conversation as ApiResources::conversation() returns it. */
function conversationResource(c) {
  return {
    object: 'conversation',
    id: c.id,
    status: c.status,
    priority: c.priority ?? 'normal',
    subject: c.subject ?? null,
    channel: { id: 1, type: c.channel ?? 'web' },
    contact: c.contact ?? null,
    assigned_agent: c.assigned_agent_id ? agentSummary(c.assigned_agent_id) : null,
    assigned_team: c.assigned_team ?? null,
    tags: (c.tags ?? []).map((t) => ({ id: t.id, name: t.name })),
    is_spam: c.status === 'spam',
    url: `https://client.replyze.chat/1/inbox?conversation=${c.id}`,
    created_at: apiTime(c.created_at),
    updated_at: apiTime(c.updated_at ?? c.created_at),
    last_activity_at: apiTime(c.updated_at ?? c.created_at),
    first_reply_at: apiTime(c.first_reply_at),
    resolved_at: apiTime(c.resolved_at),
  };
}

/** A message as ApiResources::message() returns it. */
function messageResource(m) {
  return {
    object: 'message',
    id: m.id,
    conversation_id: m.conversation_id,
    sender_type: m.sender_type,
    sender: m.sender_type === 'agent' && m.sender_id ? agentSummary(m.sender_id) : null,
    type: m.type ?? 'text',
    content: m.content,
    is_internal_note: Boolean(m.is_internal_note),
    attachments: [],
    ai_generated: Boolean(m.ai_generated),
    delivery_status: null,
    delivery_error: null,
    created_at: apiTime(m.created_at),
    edited_at: apiTime(m.edited_at),
  };
}

function agentSummary(id) {
  const a = state.agents.find((x) => x.id === id);
  return a ? { id: a.id, name: a.name, avatar_url: a.avatar_url } : null;
}

const list = (data) => ({ object: 'list', data, has_more: false, next_cursor: null });

// CursorPage::encode / decode for an oldest-first list: base64url of {"id":..,"d":"asc"}.
const encodeCursor = (id) => Buffer.from(JSON.stringify({ id, d: 'asc' })).toString('base64url');
function decodeCursor(cursor) {
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(data?.id) && data.d === 'asc' ? data.id : null;
  } catch {
    return null;
  }
}
const apiError = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });

/** For the test: a conversation with its messages, as Replyze would hold it. */
export function seedConversation(c, messages = []) {
  state.conversations[c.id] = { status: 'open', tags: [], created_at: now(), ...c };
  state.messages[c.id] = messages.map((m) => ({ conversation_id: c.id, created_at: now(), ...m }));
  return state.conversations[c.id];
}

/** For the test: a message saved the way the widget saves one (it gets the next id). */
export function addMessage(conversationId, m) {
  const message = { id: ++state.nextMessageId, conversation_id: conversationId, created_at: now(), ...m };
  (state.messages[conversationId] ??= []).push(message);
  return message;
}

export function getState() { return state; }
export function getLog() { return log; }
export function reset() { state = freshState(); log = []; }

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Replyze REST API v1
// ---------------------------------------------------------------------------

const SCOPES = ['conversations:write', 'conversations:read', 'contacts:read', 'knowledge:read'];

function replyzeApi(req, res, url, body) {
  const auth = req.headers.authorization ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
  if (!key) return send(res, 401, apiError('missing_api_key', 'Send your API key as "Authorization: Bearer <key>". Keys are made in Settings → Developer.'));
  if (key !== TEST_API_KEY) return send(res, 401, apiError('invalid_api_key', 'This API key is not valid.'));

  const rate = { 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '119', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60) };
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = req.method;
  let m;

  if (method === 'GET' && path === '/me') {
    return send(res, 200, { object: 'api_key', id: 1, name: 'n8n test', prefix: 'rpz_live_tes', scopes: SCOPES, expires_at: null, workspace: { id: 1, name: 'Test workspace' } }, rate);
  }
  if (method === 'GET' && path === '/agents') {
    return send(res, 200, list(state.agents.map((a) => ({ ...agentSummary(a.id), object: 'agent', role: a.role, availability: a.availability, is_online: a.is_online }))), rate);
  }
  if (method === 'GET' && path === '/knowledge/search') {
    const q = url.searchParams.get('q') ?? '';
    if (q.trim().length < 2) {
      return send(res, 422, apiError('validation_failed', 'The given data was invalid.', { errors: { q: ['The q field must be at least 2 characters.'] } }), rate);
    }
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const hits = state.knowledge.filter((k) => words.some((w) => (k.title + ' ' + k.content).toLowerCase().includes(w.replace(/s$/, ''))));
    return send(res, 200, list(hits), rate);
  }

  if ((m = path.match(/^\/conversations\/(\d+)(\/.*)?$/))) {
    const c = state.conversations[m[1]];
    if (!c) return send(res, 404, apiError('not_found', 'No conversation with this id.'), rate);
    const rest = m[2] ?? '';

    if (method === 'GET' && rest === '') return send(res, 200, conversationResource(c), rate);

    if (method === 'GET' && rest === '/messages') {
      // MessagesController::index: oldest first, CursorPage by id ("asc"), 50 by default, 100 at most.
      let rows = state.messages[c.id] ?? [];
      if (['false', '0'].includes(url.searchParams.get('include_notes'))) rows = rows.filter((x) => !x.is_internal_note);
      const since = url.searchParams.get('updated_since');
      if (since) {
        const t = Date.parse(since);
        if (Number.isNaN(t)) return send(res, 422, apiError('validation_failed', 'updated_since must be an ISO 8601 date and time, like 2026-11-01T00:00:00Z.'), rate);
        // created_at or edited_at at or after it. Stored times have whole seconds, as in MySQL.
        const seconds = (d) => (d ? Math.floor(new Date(d).getTime() / 1000) : -Infinity);
        rows = rows.filter((x) => seconds(x.created_at) >= Math.floor(t / 1000) || seconds(x.edited_at) >= Math.floor(t / 1000));
      }
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return send(res, 422, apiError('validation_failed', 'limit must be a number from 1 to 100.'), rate);
      const cursor = url.searchParams.get('cursor');
      if (cursor !== null && cursor !== '') {
        const after = decodeCursor(cursor);
        if (after === null) return send(res, 422, apiError('validation_failed', 'This cursor is not valid here. Use the next_cursor of the previous page of the same list.'), rate);
        rows = rows.filter((x) => x.id > after);
      }
      rows = [...rows].sort((a, b) => a.id - b.id);
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return send(res, 200, { object: 'list', data: page.map(messageResource), has_more: more, next_cursor: more ? encodeCursor(page.at(-1).id) : null }, rate);
    }

    if (method === 'POST' && rest === '/messages') {
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return send(res, 400, apiError('bad_request', 'The body is not JSON.'), rate); }
      if (typeof data.content !== 'string' || data.content.trim() === '' || data.content.length > 10000) {
        return send(res, 422, apiError('validation_failed', 'The given data was invalid.', { errors: { content: ['The content field is required.'] } }), rate);
      }
      if (data.type !== undefined && !['reply', 'note'].includes(data.type)) {
        return send(res, 422, apiError('validation_failed', 'The given data was invalid.', { errors: { type: ['The selected type is invalid.'] } }), rate);
      }
      // ApiIdempotency: the same key and body again returns the first answer; another body is refused.
      const idem = req.headers['idempotency-key'];
      if (idem) {
        const stored = state.idempotency[idem];
        if (stored) {
          if (stored.body !== body) return send(res, 422, apiError('idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.'), rate);
          return send(res, stored.status, stored.response, { ...rate, 'Idempotent-Replayed': 'true' });
        }
      }
      const note = data.type === 'note';
      // ConversationActions::send: from the team (sender_id null) or the teammate in agent_id.
      const message = addMessage(c.id, { sender_type: 'agent', sender_id: data.agent_id ?? null, content: data.content, is_internal_note: note, via: 'api' });
      if (!note) {
        if (['resolved', 'closed', 'pending'].includes(c.status)) c.status = 'open';
        if (!c.assigned_agent_id && data.agent_id) c.assigned_agent_id = data.agent_id;
        c.first_reply_at ??= now();
      }
      const response = messageResource(message);
      if (idem) state.idempotency[idem] = { body, status: 201, response };
      return send(res, 201, response, rate);
    }

    if (method === 'POST' && rest === '/assign') {
      const data = JSON.parse(body || '{}');
      if (!('agent_id' in data) && !('team_id' in data)) {
        return send(res, 422, apiError('validation_failed', 'Send agent_id, team_id or both (null takes the conversation off them).'), rate);
      }
      if ('agent_id' in data) {
        if (data.agent_id !== null && !state.agents.some((a) => a.id === Number(data.agent_id))) {
          return send(res, 422, apiError('validation_failed', 'No active teammate who can answer conversations has this id. GET /agents lists them.'), rate);
        }
        c.assigned_agent_id = data.agent_id === null ? null : Number(data.agent_id);
      }
      if ('team_id' in data) c.assigned_team = data.team_id === null ? null : { id: Number(data.team_id), name: 'Support' };
      return send(res, 200, conversationResource(c), rate);
    }

    if (method === 'POST' && rest === '/tags') {
      const data = JSON.parse(body || '{}');
      let tag = data.tag_id ? state.tags.find((t) => t.id === Number(data.tag_id)) : state.tags.find((t) => t.name.toLowerCase() === String(data.name ?? '').toLowerCase());
      if (!tag && data.name) state.tags.push((tag = { id: ++state.nextTagId, name: String(data.name) }));
      if (!tag) return send(res, 422, apiError('validation_failed', 'This workspace has no tag with this id.'), rate);
      if (!c.tags.some((t) => t.id === tag.id)) c.tags.push(tag);
      return send(res, 200, conversationResource(c), rate);
    }
  }

  return send(res, 404, apiError('not_found', 'No such endpoint.'), rate);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat model with scripted answers
// ---------------------------------------------------------------------------

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '');

/** What the model "decides", from the conversation it is given. */
function scriptedTurn(request) {
  const messages = request.messages ?? [];
  const tools = (request.tools ?? []).map((t) => t.function ?? t);
  const kbTool = tools.find((t) => /knowledge/i.test(t.name));
  const handoffTool = tools.find((t) => /hand/i.test(t.name));
  const lastUser = [...messages].reverse().find((x) => x.role === 'user');
  const question = (textOf(lastUser?.content).match(/New message from the customer:\s*([\s\S]*)$/i)?.[1] ?? textOf(lastUser?.content)).trim();
  const last = messages[messages.length - 1];

  if (last?.role === 'tool') {
    const call = messages.flatMap((x) => x.tool_calls ?? []).find((tc) => tc.id === last.tool_call_id);
    const name = call?.function?.name ?? '';
    const result = textOf(last.content);
    if (handoffTool && name === handoffTool.name) {
      return { text: "I've passed your question to our team. Someone will reply here soon." };
    }
    // Answer from the first result the knowledge base returned.
    const found = result.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (found) return { text: `Here is what our help center says: ${JSON.parse('"' + found[1] + '"')}` };
    if (handoffTool) return { call: handoffTool, args: { reason: 'The knowledge base has nothing on this question' } };
    return { text: "I couldn't find that in our help center." };
  }

  if (/\b(human|person|real agent|someone from the team|talk to a)\b/i.test(question) && handoffTool) {
    return { call: handoffTool, args: argsFor(handoffTool, 'The customer asked for a person') };
  }
  if (kbTool) return { call: kbTool, args: argsFor(kbTool, question) };
  return { text: `You asked: ${question}` };
}

/** Fills every parameter the tool declares with the same text. */
function argsFor(tool, text) {
  const props = Object.keys(tool.parameters?.properties ?? {});
  const args = {};
  for (const p of props) args[p] = text;
  if (props.length === 0) args.input = text;
  return args;
}

let callCounter = 0;

function openai(req, res, url, body) {
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return send(res, 200, { object: 'list', data: [{ id: 'gpt-4.1-mini', object: 'model', owned_by: 'mock' }] });
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    return send(res, 404, { error: { message: `The mock model has no ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
  }
  // Test switches, read from the customer's words:
  // "simulate a model outage": the model answers 500, as a provider outage would.
  if (body.includes('simulate a model outage')) {
    return send(res, 500, { error: { message: 'The mock model is down on purpose.', type: 'server_error' } });
  }
  // "the mock AI is slow": while the model thinks, Replyze's own AI answers the conversation.
  if (state.slowNext && body.includes('the mock AI is slow')) {
    addMessage(state.slowNext.conversationId, { sender_type: 'bot', content: state.slowNext.botAnswer, ai_generated: true });
    state.slowNext = null;
  }
  const request = JSON.parse(body || '{}');
  const turn = scriptedTurn(request);
  const id = `chatcmpl-mock-${++callCounter}`;
  const message = turn.call
    ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${callCounter}`, type: 'function', function: { name: turn.call.name, arguments: JSON.stringify(turn.args) } }] }
    : { role: 'assistant', content: turn.text };
  const finish = turn.call ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };

  if (request.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (turn.call) chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...message.tool_calls[0] }] });
    else chunk({ role: 'assistant', content: turn.text });
    chunk({}, finish);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  return send(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, message, finish_reason: finish }], usage });
}

// ---------------------------------------------------------------------------

export function startMock({ port = 0, quiet = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    if (!url.pathname.startsWith('/__')) {
      log.push(entry);
      if (!quiet) console.log(`[mock] ${req.method} ${url.pathname}${url.search} ${body ? body.slice(0, 160) : ''}`);
    }
    try {
      if (url.pathname === '/__log') return send(res, 200, log);
      if (url.pathname === '/__state') return send(res, 200, state);
      if (url.pathname === '/__reset') { reset(); return send(res, 200, { ok: true }); }
      if (url.pathname.startsWith('/api/v1/')) return replyzeApi(req, res, url, body);
      if (url.pathname.startsWith('/openai/')) return openai(req, res, url, body);
      if (url.pathname === '/hooks/slack' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (url.pathname === '/sheets/rows' && req.method === 'POST') return send(res, 200, { ok: true });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[mock] error', e);
      return send(res, 500, { error: { code: 'server_error', message: String(e?.message ?? e) } });
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port');
  const { port } = await startMock({ port: i > 0 ? Number(process.argv[i + 1]) : 47790 });
  console.log(`Mock Replyze API on http://127.0.0.1:${port}/api/v1 (key ${TEST_API_KEY}), mock model on http://127.0.0.1:${port}/openai/v1`);
}
