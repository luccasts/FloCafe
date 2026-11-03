import { createHash } from 'node:crypto';
import { getDatabase, now } from './db';
import { parsePhoneE164 } from './lib/phone';

export function ingestWhatsAppMessage(input: unknown): { status: number; body: object } {
  const invalid = () => ({ status: 400, body: { error: 'Invalid inbox message', code: 'invalid_inbox_message' } });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  const fields = ['phone_e164', 'direction', 'kind', 'body', 'external_message_id', 'status', 'timestamp'];
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => typeof value[key] !== 'string')) return invalid();
  const { phone_e164, direction, kind, body, external_message_id, status, timestamp } = value as Record<string, string>;
  if (!/^\+[1-9]\d{7,14}$/.test(phone_e164) || parsePhoneE164(phone_e164, '')?.e164 !== phone_e164) return invalid();
  if (!['user_message', 'bot_reply', 'agent_reply'].includes(kind) || direction !== (kind === 'user_message' ? 'inbound' : 'outbound')) return invalid();
  if (!['queued', 'seen', 'typing', 'sent', 'delivered', 'read', 'failed'].includes(status)) return invalid();
  if (!body.trim() || body.length > 65536 || !external_message_id.trim() || external_message_id.length > 256 || external_message_id !== external_message_id.trim()) return invalid();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) return invalid();
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) return invalid();
  const hash = createHash('sha256').update(JSON.stringify(fields.map(key => value[key]))).digest('hex');
  const db = getDatabase();
  return db.transaction(() => {
    const existing = db.prepare(`SELECT id, inbox_payload_hash FROM whatsapp_messages
      WHERE phone_e164 = ? AND direction = ? AND external_message_id = ?
      AND kind IN ('user_message','bot_reply','agent_reply')`).get(phone_e164, direction, external_message_id) as { id: number; inbox_payload_hash: string } | undefined;
    if (existing) return existing.inbox_payload_hash === hash
      ? { status: 200, body: { ok: true, id: existing.id } }
      : { status: 409, body: { error: 'External message ID conflicts with stored event', code: 'inbox_event_conflict' } };
    const ts = now(date);
    const result = db.prepare(`INSERT INTO whatsapp_messages
      (phone_e164, direction, kind, body, external_message_id, status, queued_at,
       seen_at, typing_at, sent_at, delivered_at, read_at, failed_at, inbox_payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        phone_e164, direction, kind, body, external_message_id, status, ts,
        ...['seen','typing','sent','delivered','read','failed'].map(state => status === state ? ts : null), hash);
    return { status: 200, body: { ok: true, id: Number(result.lastInsertRowid) } };
  })();
}
