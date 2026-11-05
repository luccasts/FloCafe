const assert = require('node:assert').strict;

const Module = require('module');
const originalLoad = Module._load;
let pairingStatus: any = { state: 'waiting_qr', qr: 'synthetic-one-time-qr', expiresAt: Date.now() + 20000 };
const pass = (_req: any, _res: any, next: () => void) => next();
const bridge = {
  clearBotBridgeConfig: () => {},
  configureBotBridgeOperations: () => {},
  getBotBridgeConfig: () => ({ url: null, configured: true }),
  getBotBridgePairingStatus: () => pairingStatus,
  getBotBridgeStatus: () => ({ connected: true, configured: true }),
  saveBotBridgeConfig: () => {},
  sendHumanReplyViaBotBridge: async () => {},
  startBotBridge: () => {},
  testBotBridgeConnection: async () => true,
};
Module._load = function (request: string) {
  if (request === '../services/whatsapp-bot-bridge') return bridge;
  if (request === '../whatsapp-inbox-ingestion') return { ingestWhatsAppMessage: () => ({ status: 201, body: {} }) };
  if (request === '../middleware/whatsapp-service-auth') return { requireWhatsAppServiceKey: pass };
  if (request === '../services/authorization') return { hasPermission: () => true, requirePermission: () => pass };
  if (request === '../middleware/async-handler') return { asyncHandler: (fn: any) => fn };
  if (request === '../db') return { getDatabase: () => ({}), getSettingValue: () => 'true', upsertSettings: () => {} };
  if (request === '../services/offline-mode') return { isOfflineMode: () => false };
  if (request === '../shutdown') return { getHttpRequestSignal: () => undefined, trackHttpRequestWork: (_req: any, work: Promise<unknown>) => work };
  if (request === '../services/whatsapp') return { getTakeoverState: async () => ({ state: 'free' }) };
  if (request === '../lib/phone') return { parsePhoneE164: () => null };
  if (request === '../whatsapp-bot-reply') return { sendHumanReplyToWhatsAppBot: async () => {}, WhatsAppBotReplyError: class extends Error {} };
  return originalLoad.apply(this, arguments as any);
};

async function run() {
  try {
  const { whatsappRoutes } = require('../main/routes/whatsapp');
  const layer = whatsappRoutes.stack.find((item: any) => item.route?.path === '/bot-bridge/pairing');
  assert.ok(layer, 'pairing route is registered');
  const [permission, ownerGuard, handler] = layer.route.stack.map((item: any) => item.handle);
  assert.equal(typeof permission, 'function');

  let proceeded = false;
  const denied: any = { status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  ownerGuard({ user: { role: 'manager' } }, denied, () => { proceeded = true; });
  assert.equal(denied.code, 403, 'non-owner cannot access pairing QR');
  assert.equal(proceeded, false, 'non-owner request is stopped');

  const headers: Record<string, string> = {};
  let body: any;
  const response: any = { setHeader(name: string, value: string) { headers[name] = value; }, json(value: unknown) { body = value; return this; } };
  await handler({ user: { role: 'owner' } }, response, (error: unknown) => { throw error; });
  assert.equal(headers['Cache-Control'], 'no-store, max-age=0', 'QR response cannot be cached');
  assert.equal(headers.Pragma, 'no-cache', 'legacy caches are also disabled');
  assert.equal(body.state, 'waiting_qr', 'returns current bot state');
  assert.ok(body.qrDataUrl.startsWith('data:image/png;base64,'), 'returns a rendered QR image');
  assert.ok(!JSON.stringify(body).includes('synthetic-one-time-qr'), 'never returns raw QR text');

  pairingStatus = { state: 'connected', qr: null, expiresAt: null };
  body = null;
  await handler({ user: { role: 'owner' } }, response, (error: unknown) => { throw error; });
  assert.equal(body.state, 'connected', 'returns connected state');
  assert.equal(body.qrDataUrl, null, 'does not return an image after pairing');
  console.log('whatsapp bot pairing route tests passed');
  } finally {
    Module._load = originalLoad;
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
