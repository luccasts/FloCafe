import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
const Module = require('module');
const originalLoad = Module._load;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'flo-bridge-hardening-'));
fs.writeFileSync(path.join(dir, 'whatsapp-bot-bridge.enc'), Buffer.from(JSON.stringify({ url: 'wss://synthetic.example', token: 'synthetic-token' })));
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  constructor(readonly url: string, readonly options: unknown) { super(); sockets.push(this); }
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(raw); callback?.(); }
  ping() { this.emit('test-ping'); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  open() { this.readyState = 1; this.emit('open'); this.frame({ type: 'ready', protocol: 1 }); }
}
Module._load = function(request: string) {
  if (request === 'ws') return FakeSocket;
  if (request === 'electron') return { app: { isReady: () => true, getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => true, decryptString: (b: Buffer) => b.toString() } };
  return originalLoad.apply(this, arguments as any);
};
async function run() {
  const bridge = require('../main/services/whatsapp-bot-bridge');
  try {
    bridge.startBotBridge();
    assert.equal(await bridge.testBotBridgeConnection(10), false, 'opening owner is not displaced by a probe');
    assert.equal(sockets.length, 1, 'probe does not race owner upgrade');
    const old = sockets[0]; old.open();
    assert.equal((old.options as { maxPayload?: number }).maxPayload, 16 * 1024, 'transport rejects oversized messages before application buffering');
    assert.equal(await bridge.testBotBridgeConnection(10), true, 'probe uses existing authenticated owner instead of competing for second socket');
    assert.equal(sockets.length, 1, 'probe does not attempt duplicate upgrade');
    const p = bridge.sendHumanReplyViaBotBridge('+15551234567', 'synthetic reply');
    const sent = JSON.parse(old.sent.at(-1)!);
    bridge.reconfigureBotBridge();
    await assert.rejects(p, { message: 'bridge_disconnected_outcome_unknown' });
    const current = sockets[1]; current.open();
    const p2 = bridge.sendHumanReplyViaBotBridge('+15551234567', 'another');
    const command = JSON.parse(current.sent.at(-1)!);
    old.frame({ type: 'response', id: command.id, ok: true, result: 'stale' }); old.emit('close');
    assert.equal(bridge.getBotBridgeStatus().connected, true);
    current.frame({ type: 'response', id: sent.id, ok: true, result: 'stale' });
    current.frame({ type: 'response', id: command.id, ok: true, result: 'current' });
    assert.equal(await p2, 'current');
    process.env.FLOCAFE_BRIDGE_MAX_PENDING = '1';
    const waiting = bridge.sendHumanReplyViaBotBridge('+15551234567', 'synthetic');
    const waitingId = JSON.parse(current.sent.at(-1)!).id;
    await assert.rejects(bridge.sendHumanReplyViaBotBridge('+15551234567', 'synthetic'), /bridge_queue_full/);
    current.frame({ type: 'response', id: waitingId, ok: true, result: { sent: true } });
    await waiting;
    delete process.env.FLOCAFE_BRIDGE_MAX_PENDING;
    let finish!: (v: unknown) => void;
    bridge.configureBotBridgeOperations({ ingest: () => new Promise(resolve => { finish = resolve; }), takeover: () => ({ state: 'free' }) });
    current.frame({ type: 'request', id: 'slow', operation: 'record_inbound', payload: {} });
    bridge.reconfigureBotBridge(); const replacement = sockets[2]; replacement.open();
    finish({ id: 'synthetic' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(old.sent.filter(x => JSON.parse(x).id === 'slow').length, 0);
    assert.equal(current.sent.filter(x => JSON.parse(x).id === 'slow').length, 0, 'old async generation cannot respond');
    replacement.bufferedAmount = 1024 * 1024;
    await assert.rejects(bridge.sendHumanReplyViaBotBridge('+15551234567', 'synthetic'), /bridge_buffer_full/);
    replacement.bufferedAmount = 0;
    await assert.rejects(bridge.sendHumanReplyViaBotBridge('+15551234567', 'x'.repeat(20000)), /bridge_payload_too_large/);
    process.env.FLOCAFE_BRIDGE_MAX_ACTIVE = '1';
    bridge.reconfigureBotBridge(); const busy = sockets[3]; busy.open();
    let release!: (v: unknown) => void;
    bridge.configureBotBridgeOperations({ ingest: () => new Promise(resolve => { release = resolve; }), takeover: () => ({ state: 'free' }) });
    busy.frame({ type: 'request', id: 'active-one', operation: 'record_inbound', payload: {} });
    busy.frame({ type: 'request', id: 'active-two', operation: 'record_inbound', payload: {} });
    assert.ok(busy.sent.some(raw => { const m = JSON.parse(raw); return m.id === 'active-two' && m.error === 'bridge_busy'; }));
    release({ id: 1 }); await new Promise(resolve => setImmediate(resolve));
    bridge.configureBotBridgeOperations({ ingest: () => ({ body: 'x'.repeat(20000) }), takeover: () => ({ state: 'free' }) });
    busy.frame({ type: 'request', id: 'large-result', operation: 'record_inbound', payload: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(busy.sent.some(raw => { const m = JSON.parse(raw); return m.id === 'large-result' && m.error === 'bridge_response_too_large'; }), 'responds with safe error, never silent success');
    busy.frame({ type: 'event', event: 'bot_pairing', payload: { qr: 'x'.repeat(20000) } });
    assert.equal(busy.readyState, FakeSocket.CLOSED, 'oversized incoming frame terminates connection');
    process.env.FLOCAFE_BRIDGE_MAX_ACTIVE = '2';
    bridge.reconfigureBotBridge(); const priority = sockets[4]; priority.open();
    let finishPriority!: (value: unknown) => void;
    bridge.configureBotBridgeOperations({ ingest: () => new Promise(resolve => { finishPriority = resolve; }), takeover: () => ({ state: 'free' }) });
    priority.frame({ type: 'request', id: 'record', operation: 'record_inbound', payload: {} });
    priority.frame({ type: 'request', id: 'record-overflow', operation: 'record_inbound', payload: {} });
    priority.frame({ type: 'request', id: 'takeover', operation: 'get_takeover', payload: { phone_e164: '+15551234567' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(priority.sent.some(raw => { const m = JSON.parse(raw); return m.id === 'record-overflow' && m.error === 'bridge_busy'; }));
    assert.ok(priority.sent.some(raw => { const m = JSON.parse(raw); return m.id === 'takeover' && m.ok === true; }));
    finishPriority({ id: 1 });
    await new Promise(resolve => setImmediate(resolve));
    bridge.stopBotBridge();
    delete process.env.FLOCAFE_BRIDGE_MAX_ACTIVE;
    process.env.FLOCAFE_BRIDGE_HEARTBEAT_MS = '20';
    bridge.reconfigureBotBridge(); const hung = sockets[5]; hung.open();
    await new Promise<void>((resolve, reject) => {
      const onClose = () => { clearTimeout(deadline); resolve(); };
      const deadline = setTimeout(() => { hung.off('close', onClose); reject(new Error('heartbeat_close_timeout')); }, 1000);
      hung.once('close', onClose);
    });
    assert.equal(hung.readyState, FakeSocket.CLOSED, 'control ping without pong expires desktop connection');
    delete process.env.FLOCAFE_BRIDGE_HEARTBEAT_MS;
    process.env.FLOCAFE_BRIDGE_MAX_PENDING = '1000';
    assert.throws(() => bridge.reconfigureBotBridge(), /bridge_invalid_limits/);
    delete process.env.FLOCAFE_BRIDGE_MAX_PENDING;
    bridge.stopBotBridge();
    const beforeProbe = sockets.length;
    assert.equal(await bridge.testBotBridgeConnection(10), false);
    assert.equal(sockets.length, beforeProbe, 'disconnected probe never grabs first-owner slot');
    process.env.FLOCAFE_BRIDGE_MAX_ACTIVE = '1';
    bridge.startBotBridge();
    const detached = sockets.at(-1)!; detached.open();
    let finishDetached!: (value: unknown) => void;
    bridge.configureBotBridgeOperations({ ingest: () => ({}), takeover: () => new Promise(resolve => { finishDetached = resolve; }), isPhoneBlocked: () => false });
    detached.frame({ type: 'request', id: 'detached-active', operation: 'get_takeover', payload: { phone_e164: '+15550001111' } });
    bridge.reconfigureBotBridge(); const successor = sockets.at(-1)!; successor.open();
    successor.frame({ type: 'request', id: 'successor-busy', operation: 'check_blocklist', payload: { phone_e164: '+15550001111' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(successor.sent.some(raw => { const m = JSON.parse(raw); return m.id === 'successor-busy' && m.error === 'bridge_busy'; }), 'reconnect cannot reset capacity consumed by unfinished work');
    finishDetached({ state: 'free' });
    await new Promise(resolve => setImmediate(resolve));
    bridge.stopBotBridge();
    delete process.env.FLOCAFE_BRIDGE_MAX_ACTIVE;
    console.log('whatsapp bot bridge hardening tests passed');
  } finally { bridge.stopBotBridge(); Module._load = originalLoad; fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
