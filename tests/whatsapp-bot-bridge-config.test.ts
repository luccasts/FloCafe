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
