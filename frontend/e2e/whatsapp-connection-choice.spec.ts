import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('WhatsApp setup clearly separates FloCafe-only use from the Polo Pizza bot', async ({ page }) => {
  await page.addInitScript((token) => localStorage.setItem('token', token), getE2eToken());
  await page.route('**/api/whatsapp/status', (route) =>
    route.fulfill({ json: { state: 'disconnected', enabled: false } }),
  );
  await page.route('**/api/whatsapp/bot-bridge/config', (route) =>
    route.fulfill({ json: { configured: false, connected: false, url: '' } }),
  );

  await page.goto(`${BASE}/whatsapp`);
  await page.getByRole('tab', { name: 'Connection' }).click();

  await expect(page.getByRole('button', { name: /^WhatsApp directly on FloCafe/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Polo Pizza bot/ })).toBeVisible();
  await expect(page.getByText('FloCafe works without WhatsApp. You can use the POS without connecting either option.')).toBeVisible();

  await page.getByRole('button', { name: /^Polo Pizza bot/ }).click();
  await expect(page.getByLabel('WSS URL')).toBeVisible();
  await expect(page.getByLabel('Bridge token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start QR pairing' })).toHaveCount(0);

  await page.getByRole('button', { name: /^WhatsApp directly on FloCafe/ }).click();
  await expect(page.getByLabel('WSS URL')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Enable in Settings' })).toBeVisible();
});
