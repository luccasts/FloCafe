import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';

const Module = require('node:module');
const originalLoad = Module._load;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-startup-'));
const file = path.join(dir, 'whatsapp-bot-bridge.enc');
const token = 'synthetic-saved-token';
const sealed = Buffer.from(JSON.stringify({ url: 'wss://bridge.example', token }));
fs.writeFileSync(file, sealed);
let ready = false;
let resolveReady!: () => void;
const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
let encrypted = 0;
let storageAvailable = true;
let decryptFailure = false;
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  constructor(readonly url: string, readonly options: { headers: { Authorization: string } }) {
    super();
    sockets.push(this);
  }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
Module._load = function (request: string) {
  if (request === 'electron') return {
    app: { isReady: () => ready, whenReady: () => readyPromise, getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => ready && storageAvailable,
      decryptString: (value: Buffer) => {
        if (decryptFailure) throw new Error(`decrypt failed: ${token}`);
        return value.toString();
      },
      encryptString: (value: string) => { encrypted++; return Buffer.from(value); },
    },
  };
  if (request === 'ws') return FakeSocket;
  return originalLoad.apply(this, arguments as any);
};

async function run() {
  const bridge = require('../main/services/whatsapp-bot-bridge');
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    bridge.startBotBridge();
    bridge.startBotBridge();
    assert.equal(sockets.length, 0, 'startup cannot connect before Electron readiness');
    ready = true;
    resolveReady();
    await readyPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1, 'saved credentials connect once without saving again');
    assert.equal(sockets[0].url, 'wss://bridge.example/api/v1/flo-bridge');
    assert.equal(sockets[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(encrypted, 0, 'startup does not re-encrypt or save a token');
    assert.deepEqual(fs.readFileSync(file), sealed, 'saved credentials remain untouched');
    bridge.startBotBridge();
    assert.equal(sockets.length, 1, 'subsequent start does not duplicate the socket');
    assert.equal(bridge.getBotBridgeStatus().connected, false, 'not connected before handshake');
    sockets[0].frame({ type: 'ready', protocol: 1 });
    assert.equal(bridge.getBotBridgeStatus().connected, true, 'connected only after handshake');
    sockets[0].close();
    assert.equal(bridge.getBotBridgeStatus().connected, false, 'close resets connected state');
    await new Promise<void>((resolve) => setTimeout(resolve, 1300));
    assert.equal(sockets.length, 2, 'reconnects with saved authentication');
    assert.equal(sockets[1].options.headers.Authorization, `Bearer ${token}`);
    sockets[1].frame({ type: 'ready', protocol: 1 });
    assert.equal(bridge.getBotBridgeStatus().connected, true, 'reconnection requires handshake');
    fs.writeFileSync(file, Buffer.from('synthetic-malformed-ciphertext'));
    assert.equal(bridge.getBotBridgeStatus().connected, false, 'invalid saved config cannot report connected');
    assert.deepEqual(bridge.getBotBridgeConfig(), { url: null, configured: false }, 'invalid saved config fails closed');
    assert.ok(!JSON.stringify(bridge.getBotBridgeConfig()).includes(token), 'status never exposes credentials');
    assert.deepEqual(errors, [['whatsapp_bot_bridge_config_unreadable']], 'invalid config emits only a fixed safe code once');
    assert.ok(!JSON.stringify(errors).includes(token), 'logs never contain saved credentials');
    fs.writeFileSync(file, sealed);
    assert.equal(bridge.getBotBridgeConfig().configured, true, 'valid config recovers after parse failure');
    decryptFailure = true;
    assert.deepEqual(bridge.getBotBridgeStatus(), { connected: false, configured: false }, 'decrypt failure fails closed');
    bridge.getBotBridgeConfig();
    assert.equal(errors.length, 2, 'decrypt failure emits again after recovery but does not spam polling');
    assert.deepEqual(errors[1], ['whatsapp_bot_bridge_config_unreadable'], 'decrypt exception details are omitted');
    decryptFailure = false;
    assert.equal(bridge.getBotBridgeConfig().configured, true, 'decrypt recovery resets error dedupe');
    storageAvailable = false;
    assert.deepEqual(bridge.getBotBridgeStatus(), { connected: false, configured: false }, 'storage unavailable after ready fails closed');
    bridge.getBotBridgeConfig();
    assert.equal(errors.length, 3, 'storage unavailable is logged once');
    assert.deepEqual(errors[2], ['whatsapp_bot_bridge_config_unreadable']);
    storageAvailable = true;
    assert.equal(bridge.getBotBridgeConfig().configured, true);
    fs.writeFileSync(file, Buffer.from(JSON.stringify({ url: 'wss://bridge.example', token: '' })));
    assert.equal(bridge.getBotBridgeConfig().configured, false, 'invalid saved data fails closed');
    assert.equal(errors.length, 4, 'validation failure emits safe error after recovery');
    fs.rmSync(file);
    bridge.getBotBridgeStatus();
    bridge.getBotBridgeConfig();
    assert.equal(errors.length, 4, 'missing config remains silent');
    fs.writeFileSync(file, sealed);
    assert.equal(bridge.getBotBridgeConfig().configured, true);
    assert.ok(!JSON.stringify(errors).includes(token), 'no error path leaks a token');
    bridge.reconfigureBotBridge();
    assert.equal(sockets.length, 3, 'reconfiguration opens one replacement socket');
    sockets[2].frame({ type: 'ready', protocol: 1 });
    sockets[1].emit('close');
    assert.equal(bridge.getBotBridgeStatus().connected, true, 'stale close does not disconnect replacement');
    await new Promise<void>((resolve) => setTimeout(resolve, 1300));
    assert.equal(sockets.length, 3, 'stale close cannot schedule duplicate reconnect');
    bridge.stopBotBridge();
    assert.equal(bridge.getBotBridgeConfig().configured, true, 'stop retains saved authentication');
  } finally {
    console.error = originalError;
    bridge.stopBotBridge();
    Module._load = originalLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('whatsapp bot bridge startup tests passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
