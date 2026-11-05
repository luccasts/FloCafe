import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const phone = '+15550000001';

const MOCK_ME_RESPONSE = {
  user: {
    id: 'e2e-owner',
    name: 'E2E Owner',
    email: 'owner@flo.local',
    role: 'owner',
    category_ids: [],
  },
  tenants: [
    {
      id: 1,
      business_name: 'E2E Cafe',
      role: 'owner',
      plan: 'free',
      status: 'active',
      business_type: 'restaurant',
      language: 'en',
      permission_ids: ['whatsapp.manage', 'whatsapp.use'],
    },
  ],
};

/**
 * Sets up localStorage auth (token + tenant) via addInitScript so it is
 * available before any page JS runs, and intercepts every API route the
 * WhatsApp page touches so nothing leaks to the real server.
 */
async function setupMockAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, tenant }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('tenant', JSON.stringify(tenant));
    },
    {
      token: getE2eToken(),
      tenant: MOCK_ME_RESPONSE.tenants[0],
    },
  );

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_ME_RESPONSE) }),
  );
  await page.route('**/api/auth/setup/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ needsSetup: false }),
    }),
  );
  // Catch-all: any unmocked /api/ request that slips through should not hang.
  await page.route('**/api/whatsapp/automation**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ config: null }),
    }),
  );
  await page.route('**/api/whatsapp/qr', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ dataUrl: null }),
    }),
  );
  await page.route('**/api/whatsapp/pairing-code', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: null }),
    }),
  );
  await page.route('**/api/settings**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ settings: {} }),
    }),
  );
  await page.route('**/api/diagnostics/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/whatsapp/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'connected', enabled: true }),
    }),
  );
  await page.route('**/api/whatsapp/bot-bridge/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: false, connected: false, url: '' }),
    }),
  );
});

test('Inbox opens a grouped conversation with inbound and bot replies', async ({ page }) => {
  await setupMockAuth(page);
  await page.addInitScript(() => localStorage.setItem('whatsapp.activeTab', 'inbox'));
  await page.route('**/api/whatsapp/inbox**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            id: 501,
            phone_e164: phone,
            body: 'Quero uma pizza grande',
            status: 'received',
            queued_at: '2026-11-03 11:00:00',
            takeover_state: 'taken',
            takeover_taken_by: 'Ana',
          },
        ],
      }),
    }),
  );
  let requestedPhone: string | null = null;
  await page.route('**/api/whatsapp/messages**', (route) => {
    const url = new URL(route.request().url());
    const selectedPhone = url.searchParams.get('phone');
    if (selectedPhone) requestedPhone = selectedPhone;
    const messages = selectedPhone
      ? [
          {
            id: 501,
            phone_e164: phone,
            body: 'Quero uma pizza grande',
            direction: 'inbound',
            kind: 'user_message',
            queued_at: '2026-11-03 11:00:00',
          },
          {
            id: 502,
            phone_e164: phone,
            body: 'Claro, qual sabor?',
            direction: 'outbound',
            kind: 'bot_reply',
            queued_at: '2026-11-03 11:01:00',
          },
        ]
      : [
          {
            id: 502,
            phone_e164: phone,
            body: 'Claro, qual sabor?',
            direction: 'outbound',
            kind: 'bot_reply',
            status: 'sent',
            queued_at: '2026-11-03 11:01:00',
          },
        ];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages }) });
  });
  await page.route('**/api/whatsapp/blocklist**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        blocklist: [{ phone_e164: phone, reason: null, blocked_at: '2026-11-03' }],
      }),
    }),
  );
  let observedReply: unknown;
  await page.route('**/api/whatsapp/inbox/501/reply', async (route) => {
    observedReply = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${BASE}/whatsapp`);

  await expect.poll(() => requestedPhone, { timeout: 10000 }).toBe(phone);
  await expect(page.getByText('Quero uma pizza grande')).toBeVisible();
  await expect(page.getByText('Claro, qual sabor?', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Taken by Ana', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Blocked', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Type a reply…' }).fill('Vou confirmar seu pedido.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect.poll(() => observedReply).toEqual({ body: 'Vou confirmar seu pedido.' });
});

test('Inbox keeps conversation selection and independent scroll positions during polling', async ({
  page,
}) => {
  await setupMockAuth(page);
  await page.addInitScript(() => localStorage.setItem('whatsapp.activeTab', 'inbox'));

  const rows = Array.from({ length: 28 }, (_, index) => ({
    id: 800 + index,
    phone_e164: `+${15550000000 + index}`,
    body: `Mensagem recebida ${index}`,
    status: 'received',
    queued_at: `2026-11-03 10:${String(index).padStart(2, '0')}:00`,
    takeover_state: 'free',
    takeover_taken_by: null,
  }));
  const initiallySelectedPhone = rows.at(-1)!.phone_e164;
  let inboxRequests = 0;
  let historyRequests = 0;
  let historyCount = 70;

  await page.route('**/api/whatsapp/inbox**', (route) => {
    inboxRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ messages: rows }),
    });
  });
  await page.route('**/api/whatsapp/messages**', (route) => {
    const url = new URL(route.request().url());
    const selectedPhone = url.searchParams.get('phone');
    if (!selectedPhone) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ messages: [] }),
      });
    }
    historyRequests += 1;
    const messages = Array.from({ length: historyCount }, (_, index) => ({
      id: 9000 + index,
      phone_e164: selectedPhone,
      body: `Histórico ${index} — mensagem longa para ocupar espaço na conversa`,
      direction: index % 2 === 0 ? 'inbound' : 'outbound',
      kind: index % 2 === 0 ? 'user_message' : 'bot_reply',
      queued_at: new Date(Date.UTC(2026, 10, 3, 11, index)).toISOString(),
    })).reverse();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages }) });
  });
  await page.route('**/api/whatsapp/blocklist**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ blocklist: [] }) }),
  );

  await page.goto(`${BASE}/whatsapp`);

  const scrollAreas = page.locator('[aria-label="Inbox"]');
  const conversationList = scrollAreas.nth(0);
  const conversationHistory = scrollAreas.nth(1);
  await expect.poll(() => historyRequests, { timeout: 10000 }).toBeGreaterThan(0);
  const conversationCard = conversationHistory.locator('xpath=..');
  await expect(conversationCard.locator('h3')).toHaveText(initiallySelectedPhone);
  await expect
    .poll(async () =>
      conversationHistory.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      conversationHistory.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);

  await conversationList.evaluate((element) => {
    element.scrollTop = 320;
  });
  await conversationHistory.evaluate((element) => {
    element.scrollTop = 640;
  });
  await expect
    .poll(() => conversationList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(() => conversationHistory.evaluate((element) => element.scrollTop)).toBe(640);

  const previousInboxRequests = inboxRequests;
  historyCount += 1;
  const previousHistoryRequests = historyRequests;
  rows.unshift({
    id: 9999,
    phone_e164: '+15559999999',
    body: 'Nova mensagem durante a leitura',
    status: 'received',
    queued_at: '2026-11-03 12:00:00',
    takeover_state: 'free',
    takeover_taken_by: null,
  });
  await expect.poll(() => inboxRequests, { timeout: 8000 }).toBeGreaterThan(previousInboxRequests);
  await expect
    .poll(() => historyRequests, { timeout: 8000 })
    .toBeGreaterThan(previousHistoryRequests);
  await expect(conversationCard.locator('h3')).toHaveText(initiallySelectedPhone);
  await expect
    .poll(() => conversationList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(() => conversationHistory.evaluate((element) => element.scrollTop)).toBe(640);

  await expect(
    conversationHistory.getByText('Histórico 70 — mensagem longa para ocupar espaço na conversa'),
  ).toBeAttached();
  await expect.poll(() => conversationHistory.evaluate((el) => el.scrollTop)).toBe(640);

  await conversationHistory.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForFunction(() => {
    const el = document.querySelectorAll('[aria-label="Inbox"]')[1];
    return el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  });
  // Allow the scroll event to update the follow-latest flag before the next poll.
  await conversationHistory.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  historyCount += 1;
  await expect(
    conversationHistory.getByText('Histórico 71 — mensagem longa para ocupar espaço na conversa'),
  ).toBeAttached({ timeout: 8000 });
  await expect
    .poll(() =>
      conversationHistory.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThanOrEqual(2);

  await conversationHistory.evaluate((el) => {
    el.scrollTop = 640;
  });
  await page.getByRole('tab').first().click();
  await page.getByRole('tab', { name: 'Inbox', exact: true }).click();
  await expect
    .poll(() =>
      conversationHistory.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThanOrEqual(2);

  const nextPhone = rows[2].phone_e164;
  const historyRequestsBeforeSelection = historyRequests;
  await conversationList.getByRole('button').filter({ hasText: nextPhone }).click();
  await expect(conversationCard.locator('h3')).toHaveText(nextPhone);
  await expect
    .poll(() => historyRequests, { timeout: 8000 })
    .toBeGreaterThan(historyRequestsBeforeSelection);
  await expect
    .poll(async () =>
      conversationHistory.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
});
