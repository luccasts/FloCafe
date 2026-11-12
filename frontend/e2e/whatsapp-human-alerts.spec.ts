import { test, expect, type Route } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const firstPhone = '+155****0101';
const secondPhone = '+155****0202';
const alertBody = '🔔 Cliente pediu atendimento humano';
type Row = {
  id: number; phone_e164: string; body: string; kind: string; status: string;
  queued_at: string; takeover_state: 'free' | 'taken'; takeover_taken_by: string | null;
};
const reply = (route: Route, payload: unknown) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });

test('human handoff toast, badge, selection, deduplication and rearm after release', async ({ page }) => {
  await page.addInitScript(({ token, tenant }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('tenant', JSON.stringify(tenant));
    localStorage.setItem('whatsapp.activeTab', 'inbox');
  }, {
    token: getE2eToken(),
    tenant: { id: 1, business_name: 'E2E Cafe', role: 'owner', plan: 'free',
      status: 'active', business_type: 'restaurant', language: 'en',
      permission_ids: ['whatsapp.manage', 'whatsapp.use'] },
  });
  await page.route('**/api/auth/me', (route) => reply(route, {
    user: { id: 'e2e-owner', name: 'E2E Owner', email: 'owner@flo.local', role: 'owner', category_ids: [] },
    tenants: [{ id: 1, business_name: 'E2E Cafe', role: 'owner', plan: 'free',
      status: 'active', business_type: 'restaurant', language: 'en',
      permission_ids: ['whatsapp.manage', 'whatsapp.use'] }],
  }));
  await page.route('**/api/auth/setup/status', (route) => reply(route, { needsSetup: false }));
  await page.route('**/api/settings**', (route) => reply(route, { settings: {} }));
  await page.route('**/api/whatsapp/status', (route) => reply(route, { state: 'connected', enabled: true }));
  await page.route('**/api/whatsapp/bot-bridge/**', (route) =>
    reply(route, { configured: false, connected: false, url: '' }));
  await page.route('**/api/whatsapp/automation**', (route) => reply(route, { config: null }));
  await page.route('**/api/whatsapp/blocklist**', (route) => reply(route, { blocklist: [] }));

  const rows: Row[] = [
    { id: 701, phone_e164: firstPhone, body: alertBody, kind: 'system', status: 'received',
      queued_at: '2026-11-03 10:01:00', takeover_state: 'free', takeover_taken_by: null },
    { id: 702, phone_e164: secondPhone, body: 'Pedido de café', kind: 'user_message', status: 'received',
      queued_at: '2026-11-03 10:02:00', takeover_state: 'free', takeover_taken_by: null },
  ];
  let inboxRequests = 0;
  await page.route('**/api/whatsapp/inbox**', (route) => {
    inboxRequests += 1;
    return reply(route, { messages: [...rows].reverse() });
  });
  await page.route('**/api/whatsapp/messages**', (route) => {
    const selectedPhone = new URL(route.request().url()).searchParams.get('phone');
    return reply(route, { messages: selectedPhone
      ? rows.filter((row) => row.phone_e164 === selectedPhone)
        .map((row) => ({ ...row, direction: 'inbound' })).reverse()
      : [] });
  });
  for (const action of ['takeover', 'release'] as const) {
    await page.route(`**/api/whatsapp/${action}/**`, (route) => {
      expect(route.request().method()).toBe('POST');
      expect(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!))
        .toBe(secondPhone);
      for (const row of rows.filter((item) => item.phone_e164 === secondPhone)) {
        row.takeover_state = action === 'takeover' ? 'taken' : 'free';
        row.takeover_taken_by = action === 'takeover' ? 'E2E Owner' : null;
      }
      return reply(route, { ok: true });
    });
  }

  await page.goto(`${BASE}/whatsapp`);
  const conversations = page.locator('[aria-label="Inbox"]').first();
  const first = conversations.getByRole('button').filter({ hasText: firstPhone });
  const second = conversations.getByRole('button').filter({ hasText: secondPhone });
  const openToast = page.getByRole('button', { name: 'Abrir conversa' });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(openToast).toHaveCount(0);
  await expect(first.getByLabel('Cliente pediu atendimento humano')).toHaveCount(0);
  await expect(second.getByLabel('Cliente pediu atendimento humano')).toHaveCount(0);

  rows.push({ id: 703, phone_e164: secondPhone, body: alertBody, kind: 'system', status: 'received',
    queued_at: '2026-11-03 10:03:00', takeover_state: 'free', takeover_taken_by: null });
  await expect(openToast).toHaveCount(1, { timeout: 8000 });
  await expect(second.getByLabel('Cliente pediu atendimento humano')).toBeVisible();
  await expect(first.getByLabel('Cliente pediu atendimento humano')).toHaveCount(0);

  const requestsAtAlert = inboxRequests;
  await expect.poll(() => inboxRequests, { timeout: 8000 }).toBeGreaterThan(requestsAtAlert);
  await expect(openToast).toHaveCount(1);
  await openToast.click();
  await expect(openToast).toHaveCount(0);
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[aria-label="Inbox"]').nth(1).locator('xpath=..').locator('h3'))
    .toHaveText(secondPhone);

  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  await expect(second.getByLabel('Cliente pediu atendimento humano')).toHaveCount(0);
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByRole('button', { name: 'Take over' })).toBeVisible();
  await expect(second.getByLabel('Cliente pediu atendimento humano')).toHaveCount(0);
  await expect(openToast).toHaveCount(0);

  rows.push({ id: 704, phone_e164: secondPhone, body: alertBody, kind: 'system', status: 'received',
    queued_at: '2026-11-03 10:04:00', takeover_state: 'free', takeover_taken_by: null });
  await expect(openToast).toHaveCount(1, { timeout: 8000 });
  await expect(second.getByLabel('Cliente pediu atendimento humano')).toBeVisible();
});
