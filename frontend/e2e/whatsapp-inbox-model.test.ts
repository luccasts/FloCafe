import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInboxHistoryRequest,
  groupInboxConversations,
  sameRows,
} from '../src/lib/whatsapp-inbox-model';

test('groups inbound and outbound messages by phone and sorts by latest activity', () => {
  const inbound: Parameters<typeof groupInboxConversations>[0] = [
    {
      id: 2,
      phone_e164: '+15550000001',
      body: 'Cliente voltou',
      status: 'seen',
      queued_at: '2026-11-03 11:00:00',
      takeover_state: 'taken',
      takeover_taken_by: 'Ana',
    },
    {
      id: 1,
      phone_e164: '+15550000001',
      body: 'Mensagem anterior',
      status: 'seen',
      queued_at: '2026-11-03 10:00:00',
      takeover_state: 'taken',
      takeover_taken_by: 'Ana',
    },
    {
      id: 3,
      phone_e164: '+15550000002',
      body: 'Olá',
      status: 'seen',
      queued_at: '2026-11-03 11:30:00',
      takeover_state: 'free',
      takeover_taken_by: null,
    },
  ];
  const outbound: Parameters<typeof groupInboxConversations>[1] = [
    {
      id: 10,
      phone_e164: '+15550000001',
      body: 'Resposta do bot',
      direction: 'outbound',
      queued_at: '2026-11-03 11:15:00',
    },
    {
      id: 11,
      phone_e164: '+15550000003',
      body: 'Sem entrada',
      direction: 'outbound',
      queued_at: '2026-11-03 11:45:00',
    },
  ];

  const conversations = groupInboxConversations(inbound, outbound, [
    { phone_e164: '+15550000002' },
  ]);

  assert.deepEqual(
    conversations.map((item) => item.phone_e164),
    ['+15550000002', '+15550000001'],
  );
  assert.equal(conversations[1].last_message.body, 'Resposta do bot');
  assert.equal(conversations[1].takeover_state, 'taken');
  assert.equal(conversations[0].last_message.body, 'Olá');
  assert.equal(conversations[0].is_blocked, true);
});

test('builds history request with the selected phone and bounded limit', () => {
  assert.deepEqual(buildInboxHistoryRequest('+15550000001'), {
    endpoint: '/whatsapp/messages',
    params: { phone: '+15550000001', limit: 200 },
  });
});

test('recognizes unchanged polling data so the UI can preserve existing state', () => {
  const current = [
    { id: 1, body: 'same' },
    { id: 2, body: 'also same' },
  ];
  assert.equal(
    sameRows(
      current,
      current.map((row) => ({ ...row })),
    ),
    true,
  );
  assert.equal(sameRows(current, [{ ...current[0], body: 'changed' }, current[1]]), false);
  assert.equal(sameRows(current, [...current].reverse()), false);
});
