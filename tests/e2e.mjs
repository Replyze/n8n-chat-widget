// End-to-end test of the three workflows in a real, local n8n, against the
// mock Replyze API and mock chat model in mock-server.mjs. Nothing reaches
// Replyze, OpenAI, Slack or Google.
//
//   node tests/e2e.mjs --n8n <path to node_modules/n8n/bin/n8n>
//
// Run it with the Node.js that your n8n version needs (n8n 2.x: Node 24).
// What it does:
//   1. starts the mock on a free port;
//   2. makes test copies of workflows/*.json: the Replyze API URL points to the mock,
//      the Slack URL to the mock, and the Google Sheets node becomes an HTTP request
//      to the mock (it needs a Google account); nothing else changes;
//   3. imports them and test credentials into a fresh n8n data folder (n8n CLI),
//      publishes them and starts n8n on a free port;
//   4. sends webhooks signed exactly like Replyze's (replyze-webhook.mjs), and copies of
//      them with forged unsigned headers, and checks what n8n answered, what it sent
//      to the mock, and that no execution failed;
//   5. stops the n8n it started (by its process id) and deletes the data folder
//      (--keep keeps it).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startMock, seedConversation, addMessage, getLog, getState, reset, TEST_API_KEY } from './mock-server.mjs';
import { deliver, resend, webhookConversation, webhookMessage, isoMicro } from './replyze-webhook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const N8N_BIN = args.n8n || process.env.N8N_BIN;
if (!N8N_BIN) {
  console.error('Usage: node tests/e2e.mjs --n8n <path to node_modules/n8n/bin/n8n> [--keep] [--work <folder>]');
  process.exit(2);
}

const SECRETS = {
  ai: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  conversations: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  leads: '1234567890abcdef1234567890abcdef',
};
// Each test copy: its id in n8n, its source file, and what differs from the source.
// The AI workflow runs twice: with handoffAgentId 7 (assigns on handoff) and as shipped (empty).
const COPIES = {
  'replyze-ai-support-agent.json': { id: 'e2eAiAgent000001', source: 'replyze-ai-support-agent.json', handoffAgentId: '7' },
  'replyze-ai-support-agent.as-shipped.json': { id: 'e2eAiAgentAsShip', source: 'replyze-ai-support-agent.json', path: 'replyze-ai-agent-as-shipped' },
  'replyze-new-conversation-to-slack.json': { id: 'e2eNewConv000001', source: 'replyze-new-conversation-to-slack.json' },
  'replyze-new-lead-to-google-sheets.json': { id: 'e2eNewLead000001', source: 'replyze-new-lead-to-google-sheets.json' },
};
const WORKFLOW_IDS = Object.fromEntries(Object.entries(COPIES).map(([file, c]) => [file, c.id]));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const work = args.work ? path.resolve(args.work) : mkdtempSync(path.join(tmpdir(), 'replyze-n8n-e2e-'));
mkdirSync(work, { recursive: true });
const userFolder = path.join(work, 'n8n-data');
const importDir = path.join(work, 'import');
mkdirSync(importDir, { recursive: true });

const { server: mockServer, port: mockPort } = await startMock({ port: 0, quiet: !args.verbose });
const MOCK = `http://127.0.0.1:${mockPort}`;
const n8nPort = await freePort();
const brokerPort = await freePort();
const N8N = `http://127.0.0.1:${n8nPort}`;
console.log(`Work folder ${work}\nMock on ${MOCK}, n8n on ${N8N}`);

// The test copies.
for (const [file, copy] of Object.entries(COPIES)) {
  let text = readFileSync(path.join(ROOT, 'workflows', copy.source), 'utf8');
  text = text.split('https://client.replyze.chat/api/v1').join(`${MOCK}/api/v1`);
  text = text.split('https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK').join(`${MOCK}/hooks/slack`);
  const wf = JSON.parse(text);
  wf.id = copy.id;
  wf.name += copy.path ? ' (as shipped)' : '';
  wf.active = false;
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.googleSheets') {
      // Same input, same place in the flow; only the destination changes.
      node.type = 'n8n-nodes-base.httpRequest';
      node.typeVersion = 4.2;
      node.parameters = { method: 'POST', url: `${MOCK}/sheets/rows`, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}', options: {} };
      delete node.credentials;
    }
    if (node.type === 'n8n-nodes-base.webhook' && copy.path) {
      node.parameters.path = copy.path;
      node.webhookId = `${node.webhookId.slice(0, -4)}0001`;
    }
    if (node.name === 'Settings' && copy.handoffAgentId) {
      node.parameters.assignments.assignments.find((a) => a.name === 'handoffAgentId').value = copy.handoffAgentId;
    }
  }
  writeFileSync(path.join(importDir, file), JSON.stringify(wf, null, 2));
}

const credentials = [
  { id: 'replyzeApiKey', name: 'Replyze API key', type: 'httpBearerAuth', data: { token: TEST_API_KEY } },
  { id: 'openAiAccount', name: 'OpenAI account', type: 'openAiApi', data: { apiKey: 'sk-test-not-a-real-key', url: `${MOCK}/openai/v1` } },
  { id: 'replyzeSecretAiAgent', name: 'Replyze webhook secret: AI agent', type: 'crypto', data: { hmacSecret: SECRETS.ai } },
  { id: 'replyzeSecretNewConversations', name: 'Replyze webhook secret: new conversations', type: 'crypto', data: { hmacSecret: SECRETS.conversations } },
  { id: 'replyzeSecretLeads', name: 'Replyze webhook secret: leads', type: 'crypto', data: { hmacSecret: SECRETS.leads } },
];
const credentialsFile = path.join(work, 'credentials.json');
writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2));

const env = {
  ...process.env,
  N8N_USER_FOLDER: userFolder,
  N8N_PORT: String(n8nPort),
  N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_RUNNERS_BROKER_PORT: String(brokerPort),
  N8N_RUNNERS_BROKER_LISTEN_ADDRESS: '127.0.0.1',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
  N8N_SECURE_COOKIE: 'false',
  N8N_LOG_LEVEL: 'info',
  EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'all',
  EXECUTIONS_DATA_SAVE_ON_ERROR: 'all',
};
// Code nodes must work on a stock n8n: no extra modules allowed.
delete env.NODE_FUNCTION_ALLOW_BUILTIN;
delete env.NODE_FUNCTION_ALLOW_EXTERNAL;

function cli(...cliArgs) {
  const r = spawnSync(process.execPath, [N8N_BIN, ...cliArgs], { env, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) {
    console.log(`n8n ${cliArgs.join(' ')}:\n${out.trim()}`);
    throw new Error(`n8n ${cliArgs[0]} failed`);
  }
  return out;
}

console.log('Importing credentials and workflows…');
cli('import:credentials', `--input=${credentialsFile}`);
cli('import:workflow', '--separate', `--input=${importDir}`);
for (const id of Object.values(WORKFLOW_IDS)) cli('publish:workflow', `--id=${id}`);

console.log('Starting n8n…');
const logFile = path.join(work, 'n8n.log');
const logFd = openSync(logFile, 'a');
const n8n = spawn(process.execPath, [N8N_BIN, 'start'], { env, stdio: ['ignore', logFd, logFd], detached: process.platform !== 'win32' });
console.log(`n8n started, process id ${n8n.pid}, log ${logFile}`);

let stopped = false;
n8n.on('exit', () => { stopped = true; });
function stopN8n() {
  // Once only: a process id that has exited can be given to another program.
  if (stopped || n8n.exitCode !== null) return;
  stopped = true;
  if (process.platform === 'win32') {
    // By process id, with the task runner it started: nothing else.
    spawnSync('taskkill', ['/PID', String(n8n.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-n8n.pid, 'SIGTERM'); } catch { n8n.kill('SIGTERM'); }
  }
}
process.on('exit', stopN8n);
process.on('SIGINT', () => { stopN8n(); process.exit(130); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db;
function executions(workflowId) {
  db ??= new DatabaseSync(path.join(userFolder, '.n8n', 'database.sqlite'), { readOnly: true });
  return db.prepare('SELECT id, status, finished FROM execution_entity WHERE "workflowId" = ? ORDER BY id').all(workflowId);
}
function executionError(id) {
  const row = db.prepare('SELECT data FROM execution_data WHERE "executionId" = ?').get(id);
  const text = String(row?.data ?? '');
  const m = text.match(/"message":"([^"]{1,300})"/) || text.match(/"description":"([^"]{1,300})"/);
  return m ? m[1] : '(no message found)';
}

/** Waits until every execution of the workflow has finished and there are at least `count`. */
async function settle(workflowId, count, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = executions(workflowId);
    const running = rows.filter((r) => ['new', 'running', 'waiting'].includes(r.status));
    if (rows.length >= count && running.length === 0) return rows;
    await sleep(250);
  }
  throw new Error(`Executions of ${workflowId} did not finish in ${timeoutMs / 1000}s`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
}

const apiCalls = (since) => getLog().slice(since).filter((e) => e.path.startsWith('/api/v1/'));
const modelCalls = (since) => getLog().slice(since).filter((e) => e.path.startsWith('/openai/'));
const posts = (since, re) => apiCalls(since).filter((e) => e.method === 'POST' && re.test(e.path));

const executed = { ai: 0, shipped: 0, conv: 0, lead: 0 };
const FLOW_IDS = {
  ai: COPIES['replyze-ai-support-agent.json'].id,
  shipped: COPIES['replyze-ai-support-agent.as-shipped.json'].id,
  conv: COPIES['replyze-new-conversation-to-slack.json'].id,
  lead: COPIES['replyze-new-lead-to-google-sheets.json'].id,
};
const SECRET_OF = { ai: SECRETS.ai, shipped: SECRETS.ai, conv: SECRETS.conversations, lead: SECRETS.leads };
const PATH_OF = { ai: 'replyze-ai-agent', shipped: 'replyze-ai-agent-as-shipped', conv: 'replyze-new-conversation', lead: 'replyze-new-lead' };
async function send(flow, webhookPath, event, data, options = {}) {
  executed[flow] += 1;
  return deliver(`${N8N}/webhook/${webhookPath}`, event, data, SECRET_OF[flow], options);
}
/** The same signed body again, with new values in the unsigned headers. */
async function sendAgain(flow, delivery, options = {}) {
  executed[flow] += 1;
  return resend(`${N8N}/webhook/${PATH_OF[flow]}`, delivery, options);
}
async function done(flow) {
  return settle(FLOW_IDS[flow], executed[flow]);
}
/** Everything n8n sent anywhere (Replyze API, model, Slack, sheet) since `since`. */
const sideEffects = (since) => getLog().slice(since).filter((e) => !e.path.startsWith('/__'));
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const unixNow = () => String(Math.floor(Date.now() / 1000));

/**
 * The checks every workflow gets on what reaches its webhook: `event`/`data` is an
 * event the workflow would act on, `first` a delivery it has already handled.
 */
async function receivingChecks(flow, label, { event, data, first }) {
  // The handled event again: same body and signature, new X-Replyze-Event-Id and X-Replyze-Timestamp.
  let mark = getLog().length;
  let r = await sendAgain(flow, first);
  await done(flow);
  check(`${label}: the same body again with a new X-Replyze-Event-Id and X-Replyze-Timestamp gets 200 and is not handled again`,
    r.status === 200 && json(r.body)?.duplicate === true && sideEffects(mark).length === 0,
    `HTTP ${r.status} ${r.body}; sent ${JSON.stringify(sideEffects(mark).map((e) => e.method + ' ' + e.path))}`);

  // Signed 10 minutes ago, sent again now with fresh headers: the age comes from the body.
  mark = getLog().length;
  const old = await send(flow, PATH_OF[flow], event, data, { createdAt: new Date(Date.now() - 10 * 60 * 1000), headers: { 'X-Replyze-Timestamp': unixNow() } });
  await done(flow);
  check(`${label}: a body created 10 minutes ago is refused with 400, even with a fresh X-Replyze-Timestamp`,
    old.status === 400 && sideEffects(mark).length === 0, `HTTP ${old.status} ${old.body}`);

  // And the other way round: a fresh body with an old X-Replyze-Timestamp is fine (a dashboard test event: nothing to do).
  mark = getLog().length;
  r = await send(flow, PATH_OF[flow], 'webhook.test', { message: 'This is a test delivery from Replyze.' }, { headers: { 'X-Replyze-Timestamp': String(Math.floor(Date.now() / 1000) - 3600) } });
  await done(flow);
  check(`${label}: a fresh body with an hour-old X-Replyze-Timestamp is accepted (the header is not used); webhook.test is ignored`,
    r.status === 200 && json(r.body)?.received === true && json(r.body)?.duplicate === undefined && sideEffects(mark).length === 0, `HTTP ${r.status} ${r.body}`);

  // Bad signatures: another secret, an empty header, and one of the right length with a non-ASCII character.
  mark = getLog().length;
  const wrong = await send(flow, PATH_OF[flow], event, data, { signWith: 'not-the-secret' });
  const empty = await send(flow, PATH_OF[flow], event, data, { headers: { 'X-Replyze-Signature': '' } });
  const nonAscii = await send(flow, PATH_OF[flow], event, data, { headers: { 'X-Replyze-Signature': 'sha256=\u00e9' + 'a'.repeat(63) } });
  await done(flow);
  check(`${label}: a wrong, an empty and a non-ASCII signature are refused with 401, and nothing is sent anywhere`,
    [wrong, empty, nonAscii].every((x) => x.status === 401) && sideEffects(mark).length === 0,
    [wrong, empty, nonAscii].map((x) => `HTTP ${x.status} ${x.body}`).join('; '));
}

const contact = { id: 55, name: 'Jana Novak', email: 'jana@example.com', phone: null };
let nextConversation = 300;
/** A conversation in the mock and the message.created webhook for its newest visitor message. */
function visitorWrites(text, { conversation = {}, before = [] } = {}) {
  const id = conversation.id ?? ++nextConversation;
  if (!getState().conversations[id]) seedConversation({ id, contact, ...conversation }, []);
  for (const m of before) addMessage(id, m);
  const message = addMessage(id, { sender_type: 'visitor', content: text });
  const c = getState().conversations[id];
  const data = {
    message: webhookMessage({ ...message, created_at: isoMicro(message.created_at) }),
    conversation: webhookConversation({ id, status: c.status, contact, assigned_agent: c.assigned_agent_id ? { id: c.assigned_agent_id, name: 'Ana' } : null }),
  };
  return { id, message, data };
}

// ---------------------------------------------------------------------------
// Wait for n8n
// ---------------------------------------------------------------------------

{
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 180_000) {
    if (n8n.exitCode !== null) break;
    try {
      // A webhook.test event: what the dashboard's Test button sends. 404 until the workflow is live.
      const r = await send('ai', 'replyze-ai-agent', 'webhook.test', { message: 'This is a test delivery from Replyze.' });
      if (r.status !== 404) { ready = true; break; }
      executed.ai -= 1;
    } catch { executed.ai -= 1; }
    await sleep(1000);
  }
  if (!ready) {
    console.error(`n8n did not come up. Last log lines:\n${readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')}`);
    stopN8n();
    process.exit(1);
  }
  await done('ai');
  console.log(`n8n is up after ${Math.round((Date.now() - start) / 1000)}s\n`);
}

// ---------------------------------------------------------------------------
// 1. AI support agent
// ---------------------------------------------------------------------------

console.log('— replyze-ai-support-agent.json');
{
  // webhook.test (sent above): accepted, nothing else.
  check('webhook.test from the dashboard is answered 200 and ignored', apiCalls(0).length === 0);

  // A visitor question, in Serbian with an emoji and a URL: the raw body is signed byte for byte.
  let mark = getLog().length;
  const q = visitorWrites('How long does shipping take to Novi Sad? Šaljete li i u Hrvatsku? 🚚 https://example.com/a/b');
  let r = await send('ai', 'replyze-ai-agent', 'message.created', q.data);
  const firstDelivery = r;
  await done('ai');
  check('a correctly signed event (with non-ASCII text) is accepted with 200', r.status === 200, `HTTP ${r.status} ${r.body}`);
  check(`… and answered before Replyze's 10-second timeout (${r.ms} ms)`, r.ms < 10_000);
  const kb = apiCalls(mark).filter((e) => e.path === '/api/v1/knowledge/search');
  check('the AI agent called search_knowledge_base (GET /knowledge/search)', kb.length >= 1, JSON.stringify(apiCalls(mark).map((e) => e.method + ' ' + e.path)));
  const sentByAgent = modelCalls(mark).some((e) => (JSON.parse(e.body).tools ?? []).some((t) => (t.function ?? t).name === 'search_knowledge_base'));
  check('the model was offered the tools search_knowledge_base and hand_off_to_human', sentByAgent && modelCalls(mark).some((e) => e.body.includes('hand_off_to_human')));
  const reply = posts(mark, /\/conversations\/\d+\/messages$/).map((e) => ({ body: JSON.parse(e.body), key: e.headers['idempotency-key'] }));
  check('one reply was posted to POST /conversations/{id}/messages', reply.length === 1, JSON.stringify(reply));
  check('… with the answer from the knowledge base', reply[0]?.body.content?.includes('Orders ship within 1 business day'), JSON.stringify(reply[0]?.body));
  check('… as a reply (no type, no agent_id: from the team)', reply[0] && reply[0].body.type === undefined && reply[0].body.agent_id === undefined);
  check('… with Idempotency-Key n8n-reply-<message id>', reply[0]?.key === `n8n-reply-${q.message.id}`, reply[0]?.key);
  check('no tag, note or assignment for an answered question', posts(mark, /\/(tags|assign)$/).length === 0);

  // Replays, old events and bad signatures, against the event just handled.
  await receivingChecks('ai', 'AI agent', { event: 'message.created', data: visitorWrites('Hello? Is anyone there?').data, first: firstDelivery });

  // Replyze sends the workflow's own reply back as message.created (sender_type agent, no sender).
  mark = getLog().length;
  const own = getState().messages[q.id].at(-1);
  r = await send('ai', 'replyze-ai-agent', 'message.created', {
    message: webhookMessage({ ...own, sender: null, created_at: isoMicro(own.created_at) }),
    conversation: webhookConversation({ id: q.id, contact }),
  });
  await done('ai');
  check('its own reply coming back as message.created is ignored (no loop)', r.status === 200 && apiCalls(mark).length === 0, JSON.stringify(apiCalls(mark).map((e) => e.method + ' ' + e.path)));

  // Replyze's AI (sender_type bot) and a teammate (agent with sender) are ignored too.
  mark = getLog().length;
  await send('ai', 'replyze-ai-agent', 'message.created', { message: webhookMessage({ id: 9001, conversation_id: q.id, sender_type: 'bot', content: 'Hi from the AI', ai_generated: true }), conversation: webhookConversation({ id: q.id, contact }) });
  await send('ai', 'replyze-ai-agent', 'message.created', { message: webhookMessage({ id: 9002, conversation_id: q.id, sender_type: 'agent', sender: { id: 7, name: 'Ana' }, content: 'Hi, Ana here' }), conversation: webhookConversation({ id: q.id, contact }) });
  await done('ai');
  check('messages from Replyze\'s AI and from teammates are ignored', apiCalls(mark).length === 0);

  // An image from the widget: type "image", content is the image's URL (PublicWidgetController::upload).
  mark = getLog().length;
  await send('ai', 'replyze-ai-agent', 'message.created', {
    message: webhookMessage({ id: 9003, conversation_id: q.id, sender_type: 'visitor', type: 'image', content: 'https://cdn.example.com/uploads/photo.jpg', attachments: [{ url: 'https://cdn.example.com/uploads/photo.jpg', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 48211 }] }),
    conversation: webhookConversation({ id: q.id, contact }),
  });
  await done('ai');
  check('an image or a file from the visitor is left to the team', apiCalls(mark).length === 0);

  // The same message in a new event (another id): the id check lets it in, the message check stops it.
  mark = getLog().length;
  r = await send('ai', 'replyze-ai-agent', 'message.created', q.data);
  await done('ai');
  check('the same message in a new event (another id) gets no second answer', r.status === 200 && posts(mark, /./).length === 0, JSON.stringify(posts(mark, /./).map((e) => e.path + ' ' + e.body)));

  // A busy conversation: 140 messages in the last 24 hours, so more than one page (100 at most).
  // A teammate replied after the first 100: only reading every page finds that reply.
  mark = getLog().length;
  const busyBefore = (n) => Array.from({ length: n }, (_, i) => (i % 2 === 0
    ? { sender_type: 'visitor', content: `Question ${i + 1}` }
    : { sender_type: 'bot', content: `Answer ${i + 1}`, ai_generated: true }));
  await send('ai', 'replyze-ai-agent', 'message.created', visitorWrites('One more question about shipping', {
    before: [...busyBefore(130), { sender_type: 'agent', sender_id: 7, content: 'Hi, Ana here, I will take it from here.' }, ...busyBefore(9)],
  }).data);
  await done('ai');
  const pagesRead = apiCalls(mark).filter((e) => e.method === 'GET' && /\/messages$/.test(e.path));
  check('a busy chat (140 messages, 2 pages): a teammate\'s reply after the first 100 keeps the AI out',
    posts(mark, /./).length === 0 && modelCalls(mark).length === 0 && pagesRead.length === 2 && Boolean(pagesRead[1]?.query.cursor),
    `posts ${JSON.stringify(posts(mark, /./).map((e) => e.path))}, pages ${JSON.stringify(pagesRead.map((e) => e.query))}`);

  // The same without a teammate: the agent answers, with the newest messages as its history.
  mark = getLog().length;
  const busy = visitorWrites('And how long does shipping take?', { before: [...busyBefore(150), { sender_type: 'visitor', content: 'NEWEST-MESSAGE-BEFORE-THE-QUESTION' }] });
  await send('ai', 'replyze-ai-agent', 'message.created', busy.data);
  await done('ai');
  const busyReply = posts(mark, /\/messages$/);
  check('a busy chat (151 messages): the agent answers once, with the newest messages in its history',
    busyReply.length === 1 && busyReply[0].headers['idempotency-key'] === `n8n-reply-${busy.message.id}` && modelCalls(mark).some((e) => e.body.includes('NEWEST-MESSAGE-BEFORE-THE-QUESTION')),
    JSON.stringify(busyReply.map((e) => e.body)));

  // Handoff: the visitor asks for a person.
  mark = getLog().length;
  const h = visitorWrites('This is not helping, can I talk to a real person please?', { before: [{ sender_type: 'visitor', content: 'My order arrived broken.' }] });
  r = await send('ai', 'replyze-ai-agent', 'message.created', h.data);
  await done('ai');
  const hp = posts(mark, /./).map((e) => ({ path: e.path.replace(/\/conversations\/\d+/, '/conversations/{id}'), body: JSON.parse(e.body) }));
  const calledTools = modelCalls(mark).flatMap((e) => (JSON.parse(e.body).messages ?? []).flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function?.name)));
  check('handoff: the agent called hand_off_to_human', calledTools.includes('hand_off_to_human'), JSON.stringify(calledTools));
  check('handoff: tag, note, assignment, then the reply, in that order',
    JSON.stringify(hp.map((p) => p.path + (p.body.type === 'note' ? ' (note)' : ''))) === JSON.stringify(['/api/v1/conversations/{id}/tags', '/api/v1/conversations/{id}/messages (note)', '/api/v1/conversations/{id}/assign', '/api/v1/conversations/{id}/messages']),
    JSON.stringify(hp));
  check('handoff: the tag is "needs-human"', hp[0]?.body.name === 'needs-human');
  check('handoff: the note says why', /handed this conversation to the team\. Reason: .+/.test(hp[1]?.body.content ?? ''), hp[1]?.body.content);
  check('handoff: assigned to agent 7 (handoffAgentId)', hp[2]?.body.agent_id === 7);
  check('handoff: the visitor is told a teammate will reply', /teammate|team/i.test(hp[3]?.body.content ?? ''), hp[3]?.body.content);
  check('handoff: the conversation history reached the model', modelCalls(mark).some((e) => e.body.includes('My order arrived broken.')));

  // The visitor writes again in the handed-off conversation: the AI stays out.
  mark = getLog().length;
  const after = visitorWrites('Hello? Anyone?', { conversation: { id: h.id } });
  await send('ai', 'replyze-ai-agent', 'message.created', after.data);
  await done('ai');
  check('after a handoff (tag on the conversation) the AI stays silent', posts(mark, /./).length === 0 && modelCalls(mark).length === 0);

  // A teammate assigned, a teammate who replied, a conversation that isn't open.
  mark = getLog().length;
  await send('ai', 'replyze-ai-agent', 'message.created', visitorWrites('Is anyone there?', { conversation: { assigned_agent_id: 8 } }).data);
  await send('ai', 'replyze-ai-agent', 'message.created', visitorWrites('Thanks Ana, one more thing', { before: [{ sender_type: 'agent', sender_id: 7, content: 'Hi, Ana here, how can I help?' }] }).data);
  await send('ai', 'replyze-ai-agent', 'message.created', visitorWrites('Still waiting', { conversation: { status: 'pending' } }).data);
  await done('ai');
  check('assigned to a teammate, a teammate replied, or not open: the AI stays silent', posts(mark, /./).length === 0 && modelCalls(mark).length === 0, JSON.stringify(posts(mark, /./).map((e) => e.path)));

  // Two quick messages: only the newest gets the answer.
  mark = getLog().length;
  const first = visitorWrites('Hi');
  const second = visitorWrites('Do you ship to Austria?', { conversation: { id: first.id } });
  await send('ai', 'replyze-ai-agent', 'message.created', first.data);
  await send('ai', 'replyze-ai-agent', 'message.created', second.data);
  await done('ai');
  const replies = posts(mark, /\/messages$/);
  check('two quick visitor messages get one answer, for the newest', replies.length === 1 && replies[0].headers['idempotency-key'] === `n8n-reply-${second.message.id}`, JSON.stringify(replies.map((e) => e.headers['idempotency-key'])));

  // Replyze's own AI answered while the agent was thinking: no second answer.
  mark = getLog().length;
  const raced = visitorWrites('What is your return policy? (the mock AI is slow on this one)');
  getState().slowNext = { conversationId: raced.id, botAnswer: 'You can return items within 30 days.' };
  await send('ai', 'replyze-ai-agent', 'message.created', raced.data);
  await done('ai');
  check('if someone answers while the agent is thinking, nothing more is sent', posts(mark, /./).length === 0, JSON.stringify(posts(mark, /./).map((e) => e.path + ' ' + e.body)));

  // The model fails: the visitor gets the fallback reply, the team gets the conversation.
  mark = getLog().length;
  await send('ai', 'replyze-ai-agent', 'message.created', visitorWrites('Please simulate a model outage').data);
  await done('ai');
  const fp = posts(mark, /./).map((e) => JSON.parse(e.body));
  check('when the model fails: fallback reply, tag and note for the team', fp.length === 4 && fp[3].content === 'Thanks for your message! A teammate will reply here soon.' && /AI agent failed/.test(fp[1].content ?? ''), JSON.stringify(fp));

  // The workflow exactly as shipped (handoffAgentId empty): a handoff tags and notes, but assigns nobody.
  mark = getLog().length;
  await send('shipped', 'replyze-ai-agent-as-shipped', 'message.created', visitorWrites('I want to speak to a person about my invoice').data);
  await done('shipped');
  const sp = posts(mark, /./).map((e) => ({ path: e.path.replace(/\/conversations\/\d+/, '/conversations/{id}'), body: JSON.parse(e.body) }));
  check('as shipped (no handoffAgentId): a handoff tags, notes and replies, and assigns nobody',
    JSON.stringify(sp.map((p) => p.path + (p.body.type === 'note' ? ' (note)' : ''))) === JSON.stringify(['/api/v1/conversations/{id}/tags', '/api/v1/conversations/{id}/messages (note)', '/api/v1/conversations/{id}/messages']),
    JSON.stringify(sp));
}

// ---------------------------------------------------------------------------
// 2. New conversation → Slack
// ---------------------------------------------------------------------------

console.log('\n— replyze-new-conversation-to-slack.json');
{
  let mark = getLog().length;
  seedConversation({ id: 700, contact }, [{ id: 7001, sender_type: 'visitor', content: 'Hi! Do you have the blue one in size M?' }]);
  let r = await send('conv', 'replyze-new-conversation', 'conversation.created', { conversation: webhookConversation({ id: 700, contact }) });
  await done('conv');
  const slack = getLog().slice(mark).filter((e) => e.path === '/hooks/slack');
  const text = slack[0] ? JSON.parse(slack[0].body).text : '';
  check('conversation.created is accepted with 200', r.status === 200);
  check('… and posted to Slack with the name, the first message and the inbox link',
    slack.length === 1 && text.includes('Jana Novak') && text.includes('> Hi! Do you have the blue one in size M?') && text.includes('<https://client.replyze.chat/1/inbox?conversation=700|Open it in Replyze>'), text);

  await receivingChecks('conv', 'Slack', { event: 'conversation.created', data: { conversation: webhookConversation({ id: 702, contact }) }, first: r });

  // A chat that starts with the widget's welcome and a few bot lines before the visitor writes.
  mark = getLog().length;
  seedConversation({ id: 703, contact }, [
    ...Array.from({ length: 6 }, (_, i) => ({ id: 7030 + i, sender_type: 'bot', content: `Bot line ${i + 1}` })),
    { id: 7040, sender_type: 'visitor', content: 'Is the shop open on Sunday?' },
  ]);
  await send('conv', 'replyze-new-conversation', 'conversation.created', { conversation: webhookConversation({ id: 703, contact }) });
  await done('conv');
  const welcomed = getLog().slice(mark).filter((e) => e.path === '/hooks/slack').map((e) => JSON.parse(e.body).text);
  check('a chat that starts with six bot lines is posted with the visitor\'s first message', welcomed.length === 1 && welcomed[0].includes('> Is the shop open on Sunday?'), JSON.stringify(welcomed));

  mark = getLog().length;
  seedConversation({ id: 701, contact }, [{ id: 7011, sender_type: 'agent', sender_id: 7, content: 'Hi Jana, your order shipped.' }]);
  await send('conv', 'replyze-new-conversation', 'conversation.created', { conversation: webhookConversation({ id: 701, contact }) });
  await done('conv');
  check('a conversation the team started is not posted', getLog().slice(mark).filter((e) => e.path === '/hooks/slack').length === 0);

  mark = getLog().length;
  r = await send('conv', 'replyze-new-conversation', 'conversation.created', { conversation: webhookConversation({ id: 700, contact }) }, { signWith: SECRETS.ai });
  await done('conv');
  check('a webhook signed with another webhook\'s secret is refused with 401', r.status === 401 && getLog().slice(mark).filter((e) => !e.path.startsWith('/__')).length === 0);
}

// ---------------------------------------------------------------------------
// 3. New lead → Google Sheets
// ---------------------------------------------------------------------------

console.log('\n— replyze-new-lead-to-google-sheets.json');
{
  const lead = {
    id: 91, name: 'Marko Petrović', email: 'marko@example.com', phone: '+381601234567', address: null, website: null, gender: null, avatar_url: null,
    company: 'Petrović d.o.o.', job_title: 'Owner', job_role: null, company_domain: null, city: 'Beograd', country: 'Serbia', country_code: 'RS',
    language: 'sr', tags: ['wholesale'], segments: null, custom_data: [], created_at: isoMicro(), updated_at: isoMicro(),
  };
  let mark = getLog().length;
  let r = await send('lead', 'replyze-new-lead', 'contact.created', { contact: lead });
  await done('lead');
  const rows = getLog().slice(mark).filter((e) => e.path === '/sheets/rows').map((e) => JSON.parse(e.body));
  check('contact.created is accepted with 200', r.status === 200);
  check('… and becomes a row keyed by Replyze ID', rows.length === 1 && rows[0]['Replyze ID'] === 91 && rows[0].Email === 'marko@example.com' && rows[0].Company === 'Petrović d.o.o.' && rows[0].Tags === 'wholesale', JSON.stringify(rows));

  await receivingChecks('lead', 'Google Sheets', { event: 'contact.created', data: { contact: { ...lead, id: 92, email: 'ana@example.com' } }, first: r });

  mark = getLog().length;
  await send('lead', 'replyze-new-lead', 'contact.updated', { contact: { ...lead, phone: '+381609999999' }, changed: ['phone'] });
  await send('lead', 'replyze-new-lead', 'message.created', { message: webhookMessage({ id: 1, conversation_id: 1, sender_type: 'visitor', content: 'hi' }), conversation: webhookConversation({ id: 1 }) });
  await done('lead');
  const rows2 = getLog().slice(mark).filter((e) => e.path === '/sheets/rows').map((e) => JSON.parse(e.body));
  check('contact.updated updates the row; other events are ignored', rows2.length === 1 && rows2[0].Phone === '+381609999999', JSON.stringify(rows2));
}

// ---------------------------------------------------------------------------
// No execution may have failed
// ---------------------------------------------------------------------------

for (const [file, id] of Object.entries(WORKFLOW_IDS)) {
  const failed = executions(id).filter((e) => e.status !== 'success');
  check(`${file}: all ${executions(id).length} executions finished without an error`, failed.length === 0,
    failed.map((e) => `#${e.id} ${e.status}: ${executionError(e.id)}`).join('\n      '));
}

const version = spawnSync(process.execPath, [N8N_BIN, '--version'], { env, encoding: 'utf8' }).stdout.trim();
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount} of ${results.length} checks passed on n8n ${version}, Node ${process.version}.`);

db?.close();
stopN8n();
mockServer.close();
await sleep(1500);
if (!args.keep) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
else console.log(`Kept ${work}`);
process.exit(failedCount === 0 ? 0 : 1);
