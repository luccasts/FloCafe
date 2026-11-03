import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendHumanReplyToWhatsAppBot } from '../main/whatsapp-bot-reply';

const baseEnv = {
  WHATSAPP_BOT_REPLY_URL: 'http://127.0.0.1:3004/api/v1/inbox/reply',
  WHATSAPP_BOT_REPLY_KEY: 'test-secret',
};

test('posts an operator reply to the bot callback with bearer auth and no redirects', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await sendHumanReplyToWhatsAppBot('+5511999999999', 'Oi, tudo bem?', baseEnv, fakeFetch);

  assert.equal(request?.url, baseEnv.WHATSAPP_BOT_REPLY_URL);
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer test-secret');
  assert.equal(request?.init?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    phone_e164: '+5511999999999',
    body: 'Oi, tudo bem?',
  });
});

test('rejects non-local HTTP and credentials embedded in URL before making a request', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };

  await assert.rejects(
    sendHumanReplyToWhatsAppBot(
      '+5511999999999',
      'Oi',
      {
        ...baseEnv,
        WHATSAPP_BOT_REPLY_URL: 'http://example.com/reply',
      },
      fakeFetch,
    ),
    /HTTPS/,
  );
  await assert.rejects(
    sendHumanReplyToWhatsAppBot(
      '+5511999999999',
      'Oi',
      {
        ...baseEnv,
        WHATSAPP_BOT_REPLY_URL: 'https://user:pass@example.com/reply',
      },
      fakeFetch,
    ),
    /URL/,
  );
  await assert.rejects(
    sendHumanReplyToWhatsAppBot(
      '+5511999999999',
      'Oi',
      {
        ...baseEnv,
        WHATSAPP_BOT_REPLY_URL: 'http://2130706433:3004/api/v1/inbox/reply',
      },
      fakeFetch,
    ),
    /HTTPS/,
  );
  await assert.rejects(
    sendHumanReplyToWhatsAppBot(
      '+5511999999999',
      'Oi',
      {
        ...baseEnv,
        WHATSAPP_BOT_REPLY_URL: 'https://@example.com/reply',
      },
      fakeFetch,
    ),
    /URL/,
  );
  assert.equal(calls, 0);
});

test('reports callback HTTP errors without exposing the configured key', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(
    sendHumanReplyToWhatsAppBot('+5511999999999', 'Oi', baseEnv, fakeFetch),
    (error: Error) => error.message.includes('503') && !error.message.includes('test-secret'),
  );
});
