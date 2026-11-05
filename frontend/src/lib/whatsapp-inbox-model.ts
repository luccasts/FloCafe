export function buildInboxHistoryRequest(phone: string) {
  return {
    endpoint: '/whatsapp/messages',
    params: { phone, limit: 200 },
  };
}

export function sameRows<T extends object>(current: T[], incoming: T[]): boolean {
  if (current === incoming) return true;
  if (current.length !== incoming.length) return false;
  return current.every((row, index) => {
    const next = incoming[index];
    const currentRecord = row as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const keys = Object.keys(currentRecord);
    return (
      keys.length === Object.keys(nextRecord).length &&
      keys.every((key) => Object.is(currentRecord[key], nextRecord[key]))
    );
  });
}

export interface InboxInboundMessage {
  id: number;
  phone_e164: string;
  body: string;
  status: string;
  queued_at: string;
  takeover_state?: 'free' | 'taken';
  takeover_taken_by?: string | null;
}

export interface InboxOutboundMessage {
  id: number;
  phone_e164: string;
  body: string;
  direction: 'inbound' | 'outbound';
  queued_at: string;
}

export interface InboxConversationMessage {
  id: number;
  phone_e164: string;
  body: string;
  direction: 'inbound' | 'outbound';
  queued_at: string;
}

export interface InboxConversation {
  phone_e164: string;
  last_message: InboxConversationMessage;
  takeover_state: 'free' | 'taken';
  takeover_taken_by: string | null;
  is_blocked: boolean;
}

function compareMessages(a: InboxConversationMessage, b: InboxConversationMessage): number {
  return a.queued_at.localeCompare(b.queued_at) || a.id - b.id;
}

export function groupInboxConversations(
  inboundMessages: InboxInboundMessage[],
  outboundMessages: InboxOutboundMessage[],
  blocklist: Array<{ phone_e164: string }>,
): InboxConversation[] {
  const conversations = new Map<
    string,
    InboxConversation & { latest_inbound: InboxConversationMessage }
  >();

  for (const inbound of inboundMessages) {
    const message: InboxConversationMessage = { ...inbound, direction: 'inbound' };
    const current = conversations.get(inbound.phone_e164);
    if (!current) {
      conversations.set(inbound.phone_e164, {
        phone_e164: inbound.phone_e164,
        last_message: message,
        latest_inbound: message,
        takeover_state: inbound.takeover_state ?? 'free',
        takeover_taken_by: inbound.takeover_taken_by ?? null,
        is_blocked: false,
      });
      continue;
    }
    if (compareMessages(message, current.latest_inbound) > 0) {
      current.latest_inbound = message;
      current.takeover_state = inbound.takeover_state ?? 'free';
      current.takeover_taken_by = inbound.takeover_taken_by ?? null;
    }
    if (compareMessages(message, current.last_message) > 0) current.last_message = message;
  }

  for (const outbound of outboundMessages) {
    const current = conversations.get(outbound.phone_e164);
    if (!current) continue;
    const message: InboxConversationMessage = {
      id: outbound.id,
      phone_e164: outbound.phone_e164,
      body: outbound.body,
      direction: 'outbound',
      queued_at: outbound.queued_at,
    };
    if (compareMessages(message, current.last_message) > 0) current.last_message = message;
  }

  const blockedPhones = new Set(blocklist.map(({ phone_e164 }) => phone_e164));
  return Array.from(conversations.values())
    .map(({ latest_inbound: _latestInbound, ...conversation }) => ({
      ...conversation,
      is_blocked: blockedPhones.has(conversation.phone_e164),
    }))
    .sort((a, b) => compareMessages(b.last_message, a.last_message));
}
