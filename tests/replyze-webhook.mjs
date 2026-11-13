// Sends a webhook to a URL exactly the way Replyze does
// (back/app/Services/WebhookDeliveryService.php and Webhooks/WebhookEvents.php):
//
//   body     {"id":"<uuid>","event":"...","created_at":"<ISO 8601, microseconds>","workspace_id":1,"data":{...}}
//            encoded like PHP json_encode(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
//   headers  User-Agent: Replyze-Webhooks/1.0
//            X-Replyze-Event
//            X-Replyze-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the signing secret>
//            X-Replyze-Event-Id, X-Replyze-Timestamp: unsigned copies of the body's id and
//            created_at (Unix seconds). Only the body is signed, so a replay can change these two.
//
// As a command:
//   node tests/replyze-webhook.mjs --url http://localhost:5678/webhook/replyze-ai-agent //     --secret <signing secret> --event message.created --data tests/fixtures/message.created.json
// Add --bad-signature to sign with the wrong secret, --age <seconds> to backdate the event
// (its created_at; the X-Replyze-Timestamp header copies it).

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** PHP's json_encode with JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE: like JSON.stringify, but U+2028 and U+2029 stay escaped. */
export function phpJson(value) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const escaped = (code) => String.fromCharCode(92) + 'u' + code; // a backslash, "u" and the hex code
  return JSON.stringify(value).split(LS).join(escaped('2028')).split(PS).join(escaped('2029'));
}

/** Carbon's toISOString(): UTC with microseconds, e.g. 2026-11-13T10:15:00.123000Z */
export function isoMicro(date = new Date()) {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** The body of one event (WebhookDeliveryService::body). */
export function buildBody(event, data, { workspaceId = 1, createdAt = new Date(), id = crypto.randomUUID() } = {}) {
  return phpJson({ id, event, created_at: isoMicro(createdAt), workspace_id: workspaceId, data });
}

export function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** The headers of one attempt (WebhookDeliveryService::send). */
export function headersFor(body, secret) {
  const envelope = JSON.parse(body);
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Replyze-Webhooks/1.0',
    'X-Replyze-Event': envelope.event,
    'X-Replyze-Event-Id': envelope.id,
    'X-Replyze-Timestamp': String(Math.floor(Date.parse(envelope.created_at) / 1000)),
    'X-Replyze-Signature': sign(body, secret),
  };
}

/** POSTs a body with these headers; Replyze waits 10 seconds for an answer (5 to connect). */
export async function post(url, body, headers) {
  const started = Date.now();
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { status: response.status, body: text, ms: Date.now() - started };
}

/**
 * POSTs one event. options.headers replaces headers after signing (for tests:
 * a forged X-Replyze-Timestamp, a non-ASCII X-Replyze-Signature).
 */
export async function deliver(url, event, data, secret, options = {}) {
  const body = buildBody(event, data, options);
  const headers = { ...headersFor(body, options.signWith ?? secret), ...(options.headers ?? {}) };
  const result = await post(url, body, headers);
  return { ...result, eventId: JSON.parse(body).id, sent: body, headers };
}

/**
 * What someone who captured a delivery can do: send the same signed body again
 * with new values in the unsigned headers (a fresh X-Replyze-Timestamp and
 * another X-Replyze-Event-Id, unless options.headers says otherwise).
 */
export async function resend(url, delivery, options = {}) {
  const headers = {
    ...delivery.headers,
    'X-Replyze-Event-Id': crypto.randomUUID(),
    'X-Replyze-Timestamp': String(Math.floor(Date.now() / 1000)),
    ...(options.headers ?? {}),
  };
  const result = await post(url, delivery.sent, headers);
  return { ...result, sent: delivery.sent, headers };
}

// The payload parts, shaped like WebhookEvents::conversation() and ::message().
export function webhookConversation(c, { appUrl = 'https://client.replyze.chat', workspaceId = 1 } = {}) {
  return {
    id: c.id,
    status: c.status ?? 'open',
    priority: c.priority ?? null,
    subject: c.subject ?? null,
    channel: c.channel ?? 'web',
    url: `${appUrl}/${workspaceId}/inbox?conversation=${c.id}`,
    contact: c.contact ?? null,
    assigned_agent: c.assigned_agent ?? null,
    assigned_team: c.assigned_team ?? null,
    created_at: c.created_at ?? isoMicro(),
    resolved_at: c.resolved_at ?? null,
  };
}

export function webhookMessage(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender_type: m.sender_type,
    sender: m.sender ?? null,
    type: m.type ?? 'text',
    content: m.content ?? null,
    attachments: m.attachments ?? [],
    ai_generated: Boolean(m.ai_generated),
    created_at: m.created_at ?? isoMicro(),
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const a = args(process.argv.slice(2));
  if (!a.url || !a.secret || !a.event || !a.data) {
    console.error('Usage: node tests/replyze-webhook.mjs --url <n8n webhook URL> --secret <signing secret> --event <event> --data <file with the "data" object> [--bad-signature] [--age <seconds>]');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(a.data, 'utf8'));
  const createdAt = new Date(Date.now() - Number(a.age ?? 0) * 1000);
  const result = await deliver(a.url, a.event, data, a.secret, {
    createdAt,
    signWith: a['bad-signature'] ? a.secret + 'x' : undefined,
  });
  console.log(`HTTP ${result.status} in ${result.ms} ms: ${result.body}`);
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}
