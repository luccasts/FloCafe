import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
const Module = require('module');
const originalLoad = Module._load;
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  close() { this.readyState = FakeSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bridge-test-'));
Module._load = function (request: string) {
  if (request === 'ws') return FakeSocket;
  if (request === 'electron') return { app: { getPath: () => dir }, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), 'base64').toString(),
  } };
  return originalLoad.apply(this, arguments as any);
};
const { getBotBridgeConfig, saveBotBridgeConfig, clearBotBridgeConfig, validateBotBridgeUrl } = require('../main/services/whatsapp-bot-bridge');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
try {
  for (const url of ['http://example.com', 'ws://example.com', 'wss://user:pass@example.com', 'wss://example.com/?x=1', 'wss://example.com/#frag']) assertOrThrow(!validateBotBridgeUrl(url), `rejects ${url}`);

  // WS sem TLS: so loopback literal, so com opt-in explicito, nunca em producao.
  const savedFlag = process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK;
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK;
    for (const url of ['ws://127.0.0.1:3004/', 'ws://localhost:3004/']) {
      assertOrThrow(!validateBotBridgeUrl(url), `rejects ${url} without explicit opt-in`);
    }

    process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK = '1';
    for (const url of ['ws://127.0.0.1:3004/', 'ws://localhost:3004/', 'ws://127.0.0.1/', 'ws://localhost/']) {
      assertOrThrow(validateBotBridgeUrl(url), `allows local ${url} with opt-in`);
    }
    assertOrThrow(validateBotBridgeUrl('wss://bridge.example/'), 'still allows wss');

    for (const url of [
      'ws://0.0.0.0:3004/',
      'ws://192.168.0.10:3004/',
      'ws://10.0.0.5:3004/',
      'ws://172.16.0.1:3004/',
      'ws://example.com/',
      'ws://localhost.evil.com/',
      'ws://127.0.0.1.evil.com/',
      'ws://127.0.0.2:3004/',
      'ws://[::1]:3004/',
      'http://127.0.0.1:3004/',
      'ws://user:pass@127.0.0.1:3004/',
      'ws://127.0.0.1:3004/?x=1',
      'ws://127.0.0.1:3004/#frag',
      'ws://127.0.0.1:3004/path',
    ]) assertOrThrow(!validateBotBridgeUrl(url), `rejects ${url} even with opt-in`);

    process.env.NODE_ENV = 'production';
    assertOrThrow(!validateBotBridgeUrl('ws://127.0.0.1:3004/'), 'rejects ws loopback in production despite opt-in');
    assertOrThrow(validateBotBridgeUrl('wss://bridge.example/'), 'keeps wss allowed in production');

    process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK = '0';
    delete process.env.NODE_ENV;
    assertOrThrow(!validateBotBridgeUrl('ws://127.0.0.1:3004/'), 'rejects non-1 opt-in value');
  } finally {
    if (savedFlag === undefined) delete process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK;
    else process.env.FLOCAFE_BOT_BRIDGE_ALLOW_INSECURE_LOOPBACK = savedFlag;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }

  const token = 'secret-bridge-token';
  saveBotBridgeConfig('wss://bridge.example', token);
  assertEqualOrThrow(getBotBridgeConfig().url, 'wss://bridge.example', 'returns configured URL');
  assertEqualOrThrow(getBotBridgeConfig().configured, true, 'marks token configured');
  assertOrThrow(!JSON.stringify(getBotBridgeConfig()).includes(token), 'never returns token');
  const bytes = fs.readFileSync(path.join(dir, 'whatsapp-bot-bridge.enc'));
  assertOrThrow(!bytes.toString().includes(token), 'credential stored encrypted');
  clearBotBridgeConfig();
  assertEqualOrThrow(getBotBridgeConfig().configured, false, 'clear removes credentials');
  console.log('whatsapp bot bridge config tests passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
