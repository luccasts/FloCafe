import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';

const FILE = 'whatsapp-bot-bridge.enc';
type Config = { url: string; token: string };
type BotPairingState = 'unavailable' | 'connecting' | 'waiting_qr' | 'connected' | 'disconnected';
type BotPairingStatus = { state: BotPairingState; qr: string | null; expiresAt: number | null };
type BridgeOperations = { ingest: (payload: unknown) => unknown | Promise<unknown>; takeover: (phone: string) => unknown | Promise<unknown>; isPhoneBlocked?: (phone: string) => boolean | Promise<boolean> };
let operations: BridgeOperations = { ingest: () => { throw new Error('operation_unavailable'); }, takeover: () => { throw new Error('operation_unavailable'); } };
let socket: WebSocket | null = null;
let connected = false;
let pairingStatus: BotPairingStatus = { state: 'unavailable', qr: null, expiresAt: null };
let pairingQrTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let serial = 0;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const MAX_PENDING = 100;
const REQUEST_TIMEOUT_MS = 10000;
export function configureBotBridgeOperations(value: BridgeOperations): void { operations = value; }
export function getBotBridgeStatus(): { connected: boolean; configured: boolean } { return { connected, configured: Boolean(read()?.token) }; }
function clearPairingQr(): void {
  if (pairingQrTimer) clearTimeout(pairingQrTimer);
  pairingQrTimer = null;
  pairingStatus = { ...pairingStatus, qr: null, expiresAt: null };
}
function setBotPairingStatus(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const value = payload as { state?: unknown; qr?: unknown; expiresAt?: unknown };
  const states: BotPairingState[] = ['connecting', 'waiting_qr', 'connected', 'disconnected'];
  if (!states.includes(value.state as BotPairingState)) return;
  if (pairingQrTimer) clearTimeout(pairingQrTimer);
  pairingQrTimer = null;
  if (value.state === 'waiting_qr' && typeof value.qr === 'string' && value.qr.length > 0 && value.qr.length <= 4096) {
    const now = Date.now();
    const requestedExpiry = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : now + 20000;
    const expiresAt = Math.min(requestedExpiry, now + 20000);
    if (expiresAt > now) {
      pairingStatus = { state: 'waiting_qr', qr: value.qr, expiresAt };
      pairingQrTimer = setTimeout(() => clearPairingQr(), expiresAt - now);
      return;
    }
  }
  pairingStatus = { state: value.state as BotPairingState, qr: null, expiresAt: null };
}
export function getBotBridgePairingStatus(): BotPairingStatus {
  if (pairingStatus.expiresAt !== null && pairingStatus.expiresAt <= Date.now()) clearPairingQr();
  return { ...pairingStatus };
}
function failPending(error: Error): void { for (const [id, item] of pending) { clearTimeout(item.timer); item.reject(error); pending.delete(id); } }
function scheduleReconnect(): void {
  connected = false;
  if (stopped || reconnectTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(30000, retryDelay * 2);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}
function connect(): void {
  if (stopped) return;
  const config = read();
  if (!config) return;
  const client = new WebSocket(`${config.url.replace(/\/$/, '')}/api/v1/flo-bridge`, { headers: { Authorization: `Bearer ${config.token}` } });
  socket = client;
  let ready = false;
  const handshakeTimer = setTimeout(() => { if (!ready) client.terminate(); }, 5000);
  client.on('message', (frame: WebSocket.RawData) => {
    let message: any;
    try { message = JSON.parse(frame.toString()); } catch { return; }
    if (!ready) { if (message.type === 'ready' && message.protocol === 1) { ready = true; clearTimeout(handshakeTimer); connected = true; retryDelay = 1000; } else client.close(); return; }
    if (message.type === 'event' && message.event === 'bot_pairing') { setBotPairingStatus(message.payload); return; }
    if (message.type === 'response' && typeof message.id === 'string') {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.ok === true) item.resolve(message.result); else item.reject(new Error('bot_request_failed'));
      return;
    }
    if (message.type === 'request' && typeof message.id === 'string') {
      void (async () => {
        try {
          let result: unknown;
          if (message.operation === 'record_inbound') result = await operations.ingest(message.payload);
          else if (message.operation === 'get_takeover' && typeof message.payload?.phone_e164 === 'string') result = await operations.takeover(message.payload.phone_e164);
          else if (message.operation === 'check_blocklist' && typeof message.payload?.phone_e164 === 'string' && /^[+][1-9][0-9]{7,14}$/.test(message.payload.phone_e164) && operations.isPhoneBlocked) result = await operations.isPhoneBlocked(message.payload.phone_e164);
          else throw new Error('unsupported_operation');
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }));
        } catch {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'response', id: message.id, ok: false, error: 'operation_failed' }));
        }
      })();
    }
  });
  client.on('error', () => {});
  client.on('close', () => { clearTimeout(handshakeTimer); if (socket === client) socket = null; connected = false; clearPairingQr(); pairingStatus = { state: 'unavailable', qr: null, expiresAt: null }; failPending(new Error('bridge_disconnected')); scheduleReconnect(); });
}
export function startBotBridge(): void { stopped = false; if (!socket && !reconnectTimer) connect(); }
export function reconfigureBotBridge(): void { stopBotBridge(); startBotBridge(); }
export function stopBotBridge(): void { stopped = true; connected = false; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; failPending(new Error('bridge_disconnected')); clearPairingQr(); pairingStatus = { state: 'unavailable', qr: null, expiresAt: null }; const current = socket; socket = null; if (current) current.close(); }
export function sendHumanReplyViaBotBridge(phone_e164: string, body: string): Promise<unknown> {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('bridge_disconnected'));
  if (pending.size >= MAX_PENDING) return Promise.reject(new Error('bridge_queue_full'));
  const id = `flo-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge_request_timeout')); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({ type: 'command', id, operation: 'send_human_reply', payload: { phone_e164, body } }), (error) => {
      if (error) { const item = pending.get(id); if (item) { pending.delete(id); clearTimeout(timer); reject(new Error('bridge_send_failed')); } }
    });
  });
}
export function testBotBridgeConnection(timeoutMs = 5000): Promise<boolean> {
  const config = read();
  if (!config) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = new WebSocket(`${config.url.replace(/\/$/, '')}/api/v1/flo-bridge`, { headers: { Authorization: `Bearer ${config.token}` } });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAllListeners();
      if (probe.readyState !== WebSocket.CLOSED) probe.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    probe.on('message', (frame: WebSocket.RawData) => {
      let message: any;
      try { message = JSON.parse(frame.toString()); } catch { finish(false); return; }
      finish(message.type === 'ready' && message.protocol === 1);
    });
    probe.on('error', () => finish(false));
    probe.on('close', () => finish(false));
  });
}
export function validateBotBridgeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}
function configPath(): string { return path.join(app.getPath('userData'), FILE); }
function read(): Config | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(configPath()))) as Config;
    return validateBotBridgeUrl(data.url) && typeof data.token === 'string' && data.token.length > 0 ? data : null;
  } catch { return null; }
}
export function getBotBridgeConfig(): { url: string | null; configured: boolean } {
  const config = read();
  return { url: config?.url ?? null, configured: Boolean(config?.token) };
}
export function getBotBridgeCredentials(): Config | null { return read(); }
export function saveBotBridgeConfig(url: string, token: string): void {
  if (!validateBotBridgeUrl(url)) throw new Error('invalid_url');
  if (typeof token !== 'string' || !token.trim()) throw new Error('invalid_token');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), safeStorage.encryptString(JSON.stringify({ url: new URL(url).origin, token })), { mode: 0o600 });
  reconfigureBotBridge();
}
export function clearBotBridgeConfig(): void { fs.rmSync(configPath(), { force: true }); reconfigureBotBridge(); }
