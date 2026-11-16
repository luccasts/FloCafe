import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { negotiateV2, validateRequest, validateResponse, type BusinessRequest, type BusinessResponse, type TrustedContext } from '../contracts/businessV2';
import { signCatalogHandshake, validateCatalogHandshake, validCatalogMachineConfig, type CatalogMachineConfig, type CatalogHandshake } from '../contracts/catalogBridgeProtocol';

const FILE = 'whatsapp-bot-bridge.enc';
type Config = { url: string; token: string; businessCatalog?: CatalogMachineConfig };
type BotPairingState = 'unavailable' | 'connecting' | 'waiting_qr' | 'connected' | 'disconnected';
type BotPairingStatus = { state: BotPairingState; qr: string | null; expiresAt: number | null };
type CatalogRequest = Extract<BusinessRequest, { operation: 'catalog.get_page' }>;
type BridgeOperations = { ingest: (payload: unknown) => unknown | Promise<unknown>; takeover: (phone: string) => unknown | Promise<unknown>; isPhoneBlocked?: (phone: string) => boolean | Promise<boolean>; catalog?: (request: CatalogRequest, context: TrustedContext, maxPayloadBytes: number) => BusinessResponse | Promise<BusinessResponse>; clearCatalog?: () => void };
let operations: BridgeOperations = { ingest: () => { throw new Error('operation_unavailable'); }, takeover: () => { throw new Error('operation_unavailable'); } };
let socket: WebSocket | null = null;
let connected = false;
let businessReady = false;
let pairingStatus: BotPairingStatus = { state: 'unavailable', qr: null, expiresAt: null };
let pairingQrTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let waitingForReady = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let serial = 0;
type Pending = { owner: WebSocket; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const active = new Map<WebSocket, number>();
const cleanupSocket = new WeakMap<WebSocket, () => void>();
type Limits = { maxPayload: number; maxPending: number; maxActive: number; maxBuffered: number; heartbeat: number };
const defaults: Limits = { maxPayload: 16 * 1024, maxPending: 100, maxActive: 32, maxBuffered: 64 * 1024, heartbeat: 30_000 };
const names: Record<keyof Limits, string> = { maxPayload: 'FLOCAFE_BRIDGE_MAX_PAYLOAD_BYTES', maxPending: 'FLOCAFE_BRIDGE_MAX_PENDING', maxActive: 'FLOCAFE_BRIDGE_MAX_ACTIVE', maxBuffered: 'FLOCAFE_BRIDGE_MAX_BUFFERED_BYTES', heartbeat: 'FLOCAFE_BRIDGE_HEARTBEAT_MS' };
const bounds: Record<keyof Limits, [number, number]> = { maxPayload: [256, 16 * 1024], maxPending: [1, 100], maxActive: [1, 100], maxBuffered: [256, 1024 * 1024], heartbeat: [20, 120_000] };
function limits(): Limits {
  const value = { ...defaults };
  for (const key of Object.keys(names) as (keyof Limits)[]) {
    const raw = process.env[names[key]];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < bounds[key][0] || parsed > bounds[key][1]) throw new Error('bridge_invalid_limits');
    value[key] = parsed;
  }
  return value;
}
function catalogHandshakeFits(machine: CatalogMachineConfig, maxPayload: number): boolean {
  const largest = signCatalogHandshake('confirm', machine, 's'.repeat(64), 'a'.repeat(64), ['catalog.get_page'], 'b'.repeat(64));
  return Buffer.byteLength(JSON.stringify(largest)) <= maxPayload;
}
function sendBounded(client: WebSocket, frame: unknown, setting: Limits, callback?: (error?: Error) => void): 'sent' | 'large' | 'full' {
  const data = JSON.stringify(frame);
  const size = Buffer.byteLength(data);
  if (size > setting.maxPayload) return 'large';
  if (client.bufferedAmount + size > setting.maxBuffered) return 'full';
  client.send(data, callback);
  return 'sent';
}
const REQUEST_TIMEOUT_MS = 10000;
export function configureBotBridgeOperations(value: BridgeOperations): void { operations = value; }
export function getBotBridgeStatus(): { connected: boolean; configured: boolean } {
  const config = read();
  const configured = Boolean(config?.token);
  return { connected: connected && configured, configured };
}
export function getBotBridgeBusinessStatus(): { businessReady: boolean; businessConfigured: boolean } {
  const config = read();
  return {businessReady: businessReady && connected && Boolean(config?.businessCatalog), businessConfigured: Boolean(config?.businessCatalog)};
}
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
function failPending(error: Error, owner?: WebSocket): void { for (const [id, item] of pending) { if (owner && item.owner !== owner) continue; clearTimeout(item.timer); item.reject(new Error(error.message === 'bridge_disconnected' ? 'bridge_disconnected_outcome_unknown' : 'bridge_outcome_unknown')); pending.delete(id); } }
function scheduleReconnect(): void {
  connected = false;
  if (stopped || reconnectTimer) return;
  const delay = Math.min(30000, Math.floor(retryDelay * (0.8 + Math.random() * 0.4)));
  retryDelay = Math.min(30000, retryDelay * 2);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  reconnectTimer.unref?.();
}
function connect(): void {
  if (stopped) return;
  const config = read();
  if (!config) return;
  const setting = limits();
  if (config.businessCatalog && !catalogHandshakeFits(config.businessCatalog, setting.maxPayload)) {
    console.error('catalog_bridge_payload_config_invalid');
    return;
  }
  const client = new WebSocket(`${config.url.replace(/\/$/, '')}/api/v1/flo-bridge`, { headers: { Authorization: `Bearer ${config.token}` }, maxPayload: setting.maxPayload, perMessageDeflate: false });
  socket = client;
  let ready = false;
  let catalogContext: TrustedContext | null = null;
  let pendingCatalog: { offer: CatalogHandshake; peerNonce: string } | null = null;
  let catalogAttempted = false;
  const resetCatalog = () => { pendingCatalog = null; catalogContext = null; if (socket === client) { businessReady = false; operations.clearCatalog?.(); } };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let alive = true;
  const detach = () => {
    resetCatalog();
    clearTimeout(handshakeTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    cleanupSocket.delete(client);
    // In-flight local work keeps its capacity across transport reconnects.
    failPending(new Error('bridge_disconnected'), client);
    if (socket !== client) return;
    socket = null; connected = false;
    clearPairingQr(); pairingStatus = { state: 'unavailable', qr: null, expiresAt: null };
    scheduleReconnect();
  };
  const handshakeTimer = setTimeout(() => { if (!ready) { detach(); client.terminate(); } }, 5000);
  handshakeTimer.unref?.();
  cleanupSocket.set(client, detach);
  const respond = (frame: unknown, id: string) => {
    if (socket !== client || client.readyState !== WebSocket.OPEN) return;
    const result = sendBounded(client, frame, setting);
    if (result === 'large') {
      if (sendBounded(client, { type: 'response', id, ok: false, error: 'bridge_response_too_large' }, setting) === 'sent') return;
    } else if (result === 'sent') return;
    detach(); client.terminate();
  };
  client.on('pong', () => { alive = true; });
  client.on('message', (frame: WebSocket.RawData, isBinary: boolean) => {
    if (socket !== client) return;
    const frameBytes = Array.isArray(frame) ? frame.reduce((sum, chunk) => sum + chunk.length, 0) : frame.byteLength;
    if (isBinary || frameBytes > setting.maxPayload) { detach(); client.terminate(); return; }
    let message: any;
    try { message = JSON.parse(frame.toString()); } catch { detach(); client.terminate(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { detach(); client.terminate(); return; }
    if (!ready) { if (message.type === 'ready' && message.protocol === 1) {
      ready = true; clearTimeout(handshakeTimer); connected = true; retryDelay = 1000;
      heartbeatTimer = setInterval(() => {
        if (socket !== client || client.readyState !== WebSocket.OPEN) return;
        if (!alive) { detach(); client.terminate(); return; }
        alive = false; client.ping();
      }, setting.heartbeat);
      heartbeatTimer.unref?.();
    } else { detach(); client.close(); } return; }
    if (message.type === 'business') {
      if (!config.businessCatalog || !operations.catalog) { resetCatalog(); return; }
      if (message.phase === 'offer') {
        // A second offer on the same socket is not a renegotiation or replay grant.
        if (catalogAttempted) { resetCatalog(); return; }
        catalogAttempted = true;
        const offer = validateCatalogHandshake(message, 'offer', config.businessCatalog);
        if (!offer) { resetCatalog(); return; }
        const negotiation = negotiateV2({ peerVersion: 2, peerSupported: offer.capabilities, localAllowed: ['catalog.get_page'], principalScopes: ['catalog.view'], required: ['catalog.get_page'] });
        if (!negotiation.ok) { resetCatalog(); return; }
        const peerNonce = randomBytes(32).toString('hex');
        pendingCatalog = { offer, peerNonce };
        const accept = signCatalogHandshake('accept', config.businessCatalog, offer.sessionId, offer.nonce, negotiation.granted as ['catalog.get_page'], peerNonce);
        if (sendBounded(client, accept, setting) !== 'sent') { resetCatalog(); detach(); client.terminate(); }
        return;
      }
      if (message.phase === 'confirm' && pendingCatalog) {
        const {offer, peerNonce} = pendingCatalog;
        const confirm = validateCatalogHandshake(message, 'confirm', config.businessCatalog, {sessionId:offer.sessionId,nonce:offer.nonce,peerNonce});
        pendingCatalog = null;
        if (!confirm || confirm.capabilities.length !== 1 || confirm.capabilities[0] !== 'catalog.get_page') { resetCatalog(); return; }
        catalogContext = { installationId: config.businessCatalog.installationId, sessionId: offer.sessionId, principal: {kind:'machine',installationId:config.businessCatalog.installationId,scopes:['catalog.view']},granted:['catalog.get_page'] };
        businessReady = true;
        return;
      }
      resetCatalog(); return;
    }
    if (message.protocol === 2) {
      const context = catalogContext;
      if (!context || message.type !== 'request' || message.operation !== 'catalog.get_page' || !operations.catalog) return;
      const validated = validateRequest(message, context);
      if (!validated.ok) return;
      const request = validated.value as CatalogRequest;
      const totalActive = [...active.values()].reduce((sum, value) => sum + value, 0);
      if (totalActive >= setting.maxActive || (setting.maxActive > 1 && totalActive >= setting.maxActive - 1)) {
        const busy = {type:'response',protocol:2,requestId:request.requestId,sessionId:request.sessionId,operation:'catalog.get_page',outcome:'unknown',errorCode:'unavailable',result:null};
        if (sendBounded(client,busy,setting) !== 'sent') {detach();client.terminate();}
        return;
      }
      active.set(client,(active.get(client) ?? 0)+1);
      void (async () => {
        const unknown = (): BusinessResponse => ({type:'response',protocol:2,requestId:request.requestId,sessionId:request.sessionId,operation:'catalog.get_page',outcome:'unknown',errorCode:'unavailable',result:null});
        try {
          let response: unknown;
          try { response = await operations.catalog!(request,context,setting.maxPayload); } catch { response = unknown(); }
          if (!validateResponse(response,request,context).ok || Buffer.byteLength(JSON.stringify(response)) > setting.maxPayload) response = unknown();
          if (socket === client && catalogContext === context && client.readyState === WebSocket.OPEN && sendBounded(client,response,setting) !== 'sent') { detach(); client.terminate(); }
        } finally {
          const remaining=(active.get(client) ?? 1)-1;
          if (remaining<=0) active.delete(client); else active.set(client,remaining);
        }
      })();
      return;
    }
    if (message.type === 'event' && message.event === 'bot_pairing') { setBotPairingStatus(message.payload); return; }
    if (message.type === 'response' && typeof message.id === 'string') {
      const item = pending.get(message.id); if (!item || item.owner !== client) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.ok === true) item.resolve(message.result); else item.reject(new Error('bot_request_failed'));
      return;
    }
    if (message.type === 'request' && typeof message.id === 'string') {
      if (!message.id || message.id.length > 128) { detach(); client.close(); return; }
      const count = active.get(client) ?? 0;
      const totalActive = [...active.values()].reduce((sum, value) => sum + value, 0);
      if (totalActive >= setting.maxActive || (message.operation === 'record_inbound' && setting.maxActive > 1 && totalActive >= setting.maxActive - 1)) { respond({ type: 'response', id: message.id, ok: false, error: 'bridge_busy' }, message.id); return; }
      active.set(client, count + 1);
      void (async () => {
        try {
          let result: unknown;
          if (message.operation === 'record_inbound') result = await operations.ingest(message.payload);
          else if (message.operation === 'get_takeover' && typeof message.payload?.phone_e164 === 'string') result = await operations.takeover(message.payload.phone_e164);
          else if (message.operation === 'check_blocklist' && typeof message.payload?.phone_e164 === 'string' && /^[+][1-9][0-9]{7,14}$/.test(message.payload.phone_e164) && operations.isPhoneBlocked) result = await operations.isPhoneBlocked(message.payload.phone_e164);
          else throw new Error('unsupported_operation');
          respond({ type: 'response', id: message.id, ok: true, result }, message.id);
        } catch {
          respond({ type: 'response', id: message.id, ok: false, error: 'operation_failed' }, message.id);
        } finally {
          const remaining = Math.max(0, (active.get(client) ?? 1) - 1);
          if (remaining === 0) active.delete(client);
          else active.set(client, remaining);
        }
      })();
    }
  });
  client.on('error', () => {});
  client.on('close', detach);
}
export function startBotBridge(): void {
  stopped = false;
  if (!app.isReady()) {
    if (!waitingForReady) {
      waitingForReady = true;
      void app.whenReady().then(() => {
        waitingForReady = false;
        if (!stopped) startBotBridge();
      });
    }
    return;
  }
  if (!socket && !reconnectTimer) connect();
}
export function reconfigureBotBridge(): void { stopBotBridge(); startBotBridge(); }
export function stopBotBridge(): void { stopped = true; connected = false; businessReady = false; operations.clearCatalog?.(); if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; failPending(new Error('bridge_disconnected')); clearPairingQr(); pairingStatus = { state: 'unavailable', qr: null, expiresAt: null }; const current = socket; socket = null; if (current) { cleanupSocket.get(current)?.(); current.close(); } }
export function sendHumanReplyViaBotBridge(phone_e164: string, body: string): Promise<unknown> {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('bridge_disconnected'));
  const setting = limits();
  if (pending.size >= setting.maxPending) return Promise.reject(new Error('bridge_queue_full'));
  const owner = socket;
  const id = `flo-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const command = { type: 'command', id, operation: 'send_human_reply', payload: { phone_e164, body } };
    const encoded = JSON.stringify(command);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > setting.maxPayload) { reject(new Error('bridge_payload_too_large')); return; }
    if (owner.bufferedAmount + bytes > setting.maxBuffered) { reject(new Error('bridge_buffer_full')); return; }
    const timer = setTimeout(() => { if (pending.get(id)?.owner !== owner) return; pending.delete(id); reject(new Error('bridge_request_timeout')); }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { owner, resolve, reject, timer });
    owner.send(encoded, (error) => {
      if (error) { const item = pending.get(id); if (item?.owner === owner) { pending.delete(id); clearTimeout(timer); reject(new Error('bridge_send_failed')); } }
    });
  });
}
export function testBotBridgeConnection(_timeoutMs = 5000): Promise<boolean> {
  const config = read();
  return Promise.resolve(Boolean(config && connected && socket?.readyState === WebSocket.OPEN));
}
/**
 * Excecao minima para WS sem TLS: apenas loopback literal.
 *
 * O bot serve o bridge em HTTP puro (node:http), sem TLS. Em teste local,
 * FloCafe e bot na mesma maquina, exigir wss:// obrigaria a montar um
 * terminador TLS so para o piloto. A excecao vale SOMENTE para 127.0.0.1 e
 * localhost, SOMENTE com opt-in explicito por variavel de ambiente, e nunca
 * com NODE_ENV=production. Destinos remotos continuam exigindo wss://.
 */
const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);
const INSECURE_LOOPBACK_FLAG = 'FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK';
function insecureLoopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[INSECURE_LOOPBACK_FLAG] !== '1') return false;
  if (env.NODE_ENV === 'production') return false;
  return true;
}
export function validateBotBridgeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    if (url.protocol === 'wss:') return true;
    if (url.protocol !== 'ws:') return false;
    if (!LOOPBACK_BRIDGE_HOSTS.has(url.hostname)) return false;
    return insecureLoopbackAllowed();
  } catch { return false; }
}
function configPath(): string { return path.join(app.getPath('userData'), FILE); }
let configReadErrorLogged = false;
function reportConfigReadError(): void {
  if (configReadErrorLogged) return;
  configReadErrorLogged = true;
  console.error('whatsapp_bot_bridge_config_unreadable');
}
function read(): Config | null {
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(configPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportConfigReadError();
    return null;
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      if (app.isReady()) reportConfigReadError();
      return null;
    }
    const data: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    if (!data || typeof data !== 'object') { reportConfigReadError(); return null; }
    const config = data as Partial<Config>;
    if (!validateBotBridgeUrl(config.url) || typeof config.token !== 'string' || !config.token.length || (config.businessCatalog !== undefined && (!validCatalogMachineConfig(config.businessCatalog) || config.businessCatalog.key === config.token))) {
      reportConfigReadError();
      return null;
    }
    configReadErrorLogged = false;
    return config as Config;
  } catch { reportConfigReadError(); return null; }
}
export function getBotBridgeConfig(): { url: string | null; configured: boolean } {
  const config = read();
  return { url: config?.url ?? null, configured: Boolean(config?.token) };
}
export function getBotBridgeCredentials(): { url: string; token: string } | null { const config = read(); return config ? {url: config.url, token: config.token} : null; }
export function saveBotBridgeConfig(url: string, token: string, businessCatalog?: CatalogMachineConfig | null): void {
  if (!validateBotBridgeUrl(url)) throw new Error('invalid_url');
  if (typeof token !== 'string' || !token.trim()) throw new Error('invalid_token');
  const catalog = businessCatalog === undefined ? read()?.businessCatalog : businessCatalog ?? undefined;
  if (catalog !== undefined && !validCatalogMachineConfig(catalog)) throw new Error('invalid_catalog_config');
  if (catalog?.key === token) throw new Error('invalid_catalog_key');
  if (catalog && !catalogHandshakeFits(catalog, limits().maxPayload)) throw new Error('catalog_payload_limit_insufficient');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), safeStorage.encryptString(JSON.stringify({ url: new URL(url).origin, token, ...(catalog ? { businessCatalog: catalog } : {}) })), { mode: 0o600 });
  reconfigureBotBridge();
}
export function clearBotBridgeConfig(): void { fs.rmSync(configPath(), { force: true }); reconfigureBotBridge(); }
