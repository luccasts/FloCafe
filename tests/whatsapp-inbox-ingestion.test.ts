import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ingestion-'));
Module._load = function (name: string) {
  if (name === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
const { initTestDb, closeDatabase } = require('./helpers/test-setup');
const { requireAuth } = require('../main/server');
const { whatsappRoutes } = require('../main/routes/whatsapp');
async function run() {
  const db = initTestDb();
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use('/api/whatsapp', whatsappRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const previous = process.env.FLOCAFE_INBOX_SERVICE_KEY;
  process.env.FLOCAFE_INBOX_SERVICE_KEY = 'a'.repeat(64);
  const payload = { phone_e164: '+14155552671', direction: 'inbound', kind: 'user_message', body: 'synthetic hello', external_message_id: 'event-1', status: 'queued', timestamp: '2026-01-02T03:04:05.000Z' };
  const post = (body: unknown) => request(server).post('/api/whatsapp/inbound').set('X-FloCafe-Inbox-Key', 'a'.repeat(64)).send(body);
  try {
    const first = await post(payload);
    assert.equal(first.status, 200);
    const row = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(first.body.id);
    assert.equal(row.kind, payload.kind);
    assert.equal(row.phone_e164, payload.phone_e164);
    assert.equal(row.queued_at, '2026-01-02 03:04:05');
    const retry = await post(payload);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, first.body.id);
    assert.equal((await post({ ...payload, body: 'changed' })).status, 409);
    for (const patch of [{kind:'bill_receipt'}, {kind:'unknown'}, {direction:'sideways'}, {status:'bogus'}, {phone_e164:'123@lid'}, {phone_e164:123}, {timestamp:'yesterday'}, {body:{}}, {external_message_id:''}]) {
      assert.equal((await post({...payload,...patch})).status, 400, JSON.stringify(patch));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n, 1);
    for (const field of Object.keys(payload)) {
      const missing: any = { ...payload };
      delete missing[field];
      assert.equal((await post(missing)).status, 400, `missing ${field}`);
    }
    for (const kind of ['bot_reply', 'agent_reply']) {
      const event = { ...payload, kind, direction: 'outbound', status: 'sent', external_message_id: kind };
      const result = await post(event);
      assert.equal(result.status, 200);
      const stored = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(result.body.id);
      assert.equal(stored.kind, kind);
      assert.equal(stored.direction, 'outbound');
      assert.equal(stored.status, 'sent');
      assert.equal(stored.body, event.body);
      assert.equal(stored.phone_e164, event.phone_e164);
      assert.equal(stored.external_message_id, kind);
      assert.equal(stored.sent_at, '2026-01-02 03:04:05');
      assert.equal((await post(event)).body.id, result.body.id);
    }
    for (const patch of [
      {timestamp:'2026-02-30T03:04:05.000Z'}, {timestamp:'2026-01-02T03:04:05'},
      {timestamp:123}, {direction:'outbound'}, {phone_e164:'14155552671'},
      {phone_e164:'+14155552671@s.whatsapp.net'}, {body:'  '}, {body:'x'.repeat(65537)},
      {external_message_id:' id '}, {external_message_id:'x'.repeat(257)}, {extra:'field'},
    ]) assert.equal((await post({...payload,...patch})).status, 400);
    for (const patch of [{timestamp:'2026-01-02T03:04:05.001Z'}, {status:'read'}]) {
      assert.equal((await post({...payload,...patch})).status, 409);
    }
    const concurrent = await Promise.all(Array.from({length:5}, () => post(payload)));
    for (const result of concurrent) { assert.equal(result.status,200); assert.equal(result.body.id,first.body.id); }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n, 3);
    const sourceRoot = process.env.POLO_BOT_ROOT;
    if (sourceRoot) {
      const ts = require('typescript');
      const { pathToFileURL } = require('node:url');
      const importModule = new Function('url', 'return import(url)');
      async function loadSource(name: string) {
        const source = fs.readFileSync(path.join(sourceRoot!, 'src/infra', `${name}.ts`), 'utf8');
        const file = path.join(testDir, `${name}.mjs`);
        fs.writeFileSync(file, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
        return importModule(pathToFileURL(file).href);
      }
      const { FloCafeInboxClient } = await loadSource('FloCafeInboxClient');
      const { resolveInboxPhone } = await loadSource('whatsappIdentity');
      const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
      const client = new FloCafeInboxClient({ baseUrl, apiKey: 'a'.repeat(64), requestTimeoutMs: 5000 });
      for (const kind of ['user_message', 'bot_reply', 'agent_reply']) {
        const event = { phoneE164: resolveInboxPhone('987654321@lid', '14155552671@s.whatsapp.net'), direction: kind === 'user_message' ? 'inbound' : 'outbound', kind, body: `client ${kind}`, externalMessageId: `client-${kind}`, status: kind === 'user_message' ? 'queued' : 'sent', timestamp: payload.timestamp };
        const result = await client.sendWithRetry(event, 0);
        assert.equal((await client.sendWithRetry(event, 1)).id, result.id);
        const stored = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(result.id);
        assert.deepEqual([stored.phone_e164, stored.direction, stored.kind, stored.body, stored.external_message_id, stored.status, stored.queued_at], [event.phoneE164,event.direction,kind,event.body,event.externalMessageId,event.status,'2026-01-02 03:04:05']);
        await assert.rejects(client.sendMessage({...event, body:'conflict'}), /HTTP 409/);
      }
      let loseResponse = true;
      const lossyClient = new FloCafeInboxClient({baseUrl, apiKey: 'a'.repeat(64), requestTimeoutMs:5000,
        fetcher: async (...args: Parameters<typeof fetch>) => {
          const response = await fetch(...args);
          if (loseResponse) { loseResponse = false; await response.text(); throw new Error('simulated response loss after commit'); }
          return response;
        }});
      const lostEvent = {phoneE164:payload.phone_e164,direction:'inbound',kind:'user_message',body:'lost response',externalMessageId:'lost-response',status:'queued',timestamp:payload.timestamp};
      const recovered = await lossyClient.sendWithRetry(lostEvent, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_messages WHERE external_message_id=?').get('lost-response').n, 1);
      assert.equal(db.prepare('SELECT id FROM whatsapp_messages WHERE external_message_id=?').get('lost-response').id, recovered.id);
      for (const apiKey of ['', 'b'.repeat(64)]) {
        const invalid = new FloCafeInboxClient({baseUrl, apiKey, requestTimeoutMs:5000});
        await assert.rejects(invalid.sendMessage({phoneE164:payload.phone_e164,direction:'inbound',kind:'user_message',body:'invalid auth',externalMessageId:'bad-auth',status:'queued',timestamp:payload.timestamp}), /HTTP 401/);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages').get().n, 7);
      console.log('Cross-repo production client: 3 event kinds read back, retries deduplicated, conflicts 409, missing/wrong key 401');
    }
    console.log('Ingestion contract: all assertions passed');
  } finally {
    if (previous === undefined) delete process.env.FLOCAFE_INBOX_SERVICE_KEY;
    else process.env.FLOCAFE_INBOX_SERVICE_KEY = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, {recursive:true,force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
