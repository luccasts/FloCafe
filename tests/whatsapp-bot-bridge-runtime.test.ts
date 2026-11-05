import { EventEmitter } from 'node:events';
const Module = require('module');
const originalLoad = Module._load;
let socket: FakeSocket;
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string, readonly options: any) { super(); socket = this; }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  open() { this.readyState = 1; this.emit('open'); }
  frame(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bridge-runtime-'));
Module._load = function(request: string) {
  if (request === 'electron') return { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() } };
  if (request === 'ws') return FakeSocket;
  return originalLoad.apply(this, arguments as any);
};
const bridge = require('../main/services/whatsapp-bot-bridge');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
async function run() {
  let inbound: unknown;
  let takeoverPhone = '';
  let checkedPhone = '';
  bridge.configureBotBridgeOperations({ ingest: (payload: unknown) => { inbound = payload; return { status: 201, body: { accepted: true } }; }, takeover: (phone: string) => { takeoverPhone = phone; return { state: 'taken' }; }, isPhoneBlocked: (phone: string) => { checkedPhone = phone; return true; } });
  bridge.saveBotBridgeConfig('wss://bridge.example', 'private-token');
  bridge.startBotBridge();
  assertEqualOrThrow(socket.url, 'wss://bridge.example/api/v1/flo-bridge', 'uses bridge websocket path');
  assertEqualOrThrow(socket.options.headers.Authorization, 'Bearer private-token', 'authorizes socket');
  socket.open(); socket.frame({ type: 'ready', protocol: 1 });
  assertEqualOrThrow(bridge.getBotBridgeStatus().connected, true, 'connected only after ready');
  const qrExpiresAt = Date.now() + 30;
  socket.frame({ type: 'event', event: 'bot_pairing', payload: { state: 'waiting_qr', qr: 'synthetic-one-time-qr', expiresAt: qrExpiresAt } });
  assertEqualOrThrow(bridge.getBotBridgePairingStatus().state, 'waiting_qr', 'receives bot pairing state');
  assertEqualOrThrow(bridge.getBotBridgePairingStatus().qr, 'synthetic-one-time-qr', 'holds QR only in memory');
  assertEqualOrThrow((bridge.getBotBridgeConfig() as any).qr, undefined, 'does not expose QR through config');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEqualOrThrow(bridge.getBotBridgePairingStatus().qr, null, 'expires QR from memory');
  socket.frame({ type: 'event', event: 'bot_pairing', payload: { state: 'connected' } });
  assertEqualOrThrow(bridge.getBotBridgePairingStatus().state, 'connected', 'receives connected state');
  assertEqualOrThrow(bridge.getBotBridgePairingStatus().qr, null, 'clears QR when connected');
  socket.frame({ type: 'request', id: 'a', operation: 'record_inbound', payload: { phone_e164: 'synthetic-phone' } });
  await new Promise((resolve) => setImmediate(resolve));
  assertEqualOrThrow((inbound as any).phone_e164, 'synthetic-phone', 'ingests inbound payload');
  assertOrThrow(socket.sent.some((raw) => { const m = JSON.parse(raw); return m.type === 'response' && m.id === 'a' && m.ok; }), 'answers inbound request');
  socket.frame({ type: 'request', id: 'b', operation: 'get_takeover', payload: { phone_e164: 'synthetic-phone' } });
  await new Promise((resolve) => setImmediate(resolve));
  assertEqualOrThrow(takeoverPhone, 'synthetic-phone', 'queries takeover state');
  socket.frame({ type: 'request', id: 'blocklist', operation: 'check_blocklist', payload: { phone_e164: '+15551234567' } });
  await new Promise((resolve) => setImmediate(resolve));
  assertEqualOrThrow(checkedPhone, '+15551234567', 'checks only the requested recipient');
  assertOrThrow(socket.sent.some((raw) => { const m = JSON.parse(raw); return m.type === 'response' && m.id === 'blocklist' && m.ok && m.result === true; }), 'returns the blocked state over the bridge');
  bridge.configureBotBridgeOperations({ ingest: () => { throw new Error('private customer number +15551234567'); }, takeover: () => ({ state: 'free' }) });
  socket.frame({ type: 'request', id: 'c', operation: 'record_inbound', payload: { body: 'private +15551234567' } });
  await new Promise((resolve) => setImmediate(resolve));
  assertOrThrow(socket.sent.some((raw) => { const m = JSON.parse(raw); return m.type === 'response' && m.id === 'c' && m.ok === false && m.error === 'operation_failed'; }), 'sanitizes operation errors without forwarding PII');
  const reply = bridge.sendHumanReplyViaBotBridge('synthetic-phone', 'human reply');
  const command = JSON.parse(socket.sent[socket.sent.length - 1]);
  assertEqualOrThrow(command.operation, 'send_human_reply', 'sends restricted reply command');
  socket.frame({ type: 'response', id: command.id, ok: true, result: { sent: true } });
  await reply;
  bridge.stopBotBridge();
  assertEqualOrThrow(bridge.getBotBridgeStatus().connected, false, 'stop clears connected state');
  assertEqualOrThrow(await bridge.testBotBridgeConnection(10), false, 'probe timeout settles as failure');
  console.log('whatsapp bot bridge runtime tests passed');
}
run().finally(() => { Module._load = originalLoad; require('node:fs').rmSync(dir, { recursive: true, force: true }); });
