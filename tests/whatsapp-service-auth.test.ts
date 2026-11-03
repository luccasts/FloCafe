import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import expressRateLimit from 'express-rate-limit';
import request from 'supertest';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inbox-auth-'));
Module._load = function (name: string) {
  if (name === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
const {
  initTestDb,
  closeDatabase,
  assertEqualOrThrow: equal,
  assertOrThrow: assert,
  seedOwnerUser,
} = require('./helpers/test-setup');
const { requireAuth } = require('../main/server');
const { databaseMaintenanceMiddleware } = require('../main/db');
const { whatsappRoutes } = require('../main/routes/whatsapp');
const { posInfoRoutes } = require('../main/routes/pos-info');

async function run() {
  const previous = process.env.FLOCAFE_INBOX_SERVICE_KEY;
  const db = initTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api', databaseMaintenanceMiddleware);
  app.use(
    '/api',
    expressRateLimit({ windowMs: 60000, limit: 100, standardHeaders: true, legacyHeaders: false }),
  );
  app.use(requireAuth);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/pos-info', posInfoRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const key = randomBytes(32).toString('hex');
  process.env.FLOCAFE_INBOX_SERVICE_KEY = key;
  const payload = {
    phone_e164: '+14155552671',
        direction: 'inbound',
        kind: 'user_message',
    body: 'isolated auth test',
    external_message_id: 'auth-test',
    status: 'delivered',
    timestamp: '2026-01-02T03:04:05.000Z',
  };
  try {
    const result = await request(server)
      .post('/api/whatsapp/inbound')
      .set('X-FloCafe-Inbox-Key', key)
      .send(payload);
    equal(result.status, 200, 'dedicated service key accepted without JWT');
    const row = db.prepare('SELECT body FROM whatsapp_messages WHERE id = ?').get(result.body.id);
    assert(row?.body === payload.body, 'accepted message read back from isolated database');
    const { authHeader } = seedOwnerUser(db);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('assistant_api_key', ?)").run(
      key,
    );
    for (const headers of [
      {},
      { 'X-FloCafe-Inbox-Key': randomBytes(32).toString('hex') },
      { 'X-FloCafe-Inbox-Key': 'short' },
      { Authorization: `Bearer ${key}` },
      authHeader,
    ]) {
      equal(
        (await request(server).post('/api/whatsapp/inbound').set(headers).send(payload)).status,
        401,
        'missing, wrong, malformed, bearer and human credentials rejected',
      );
    }
    for (const url of [
      '/api/whatsapp/inbound/',
      '/API/whatsapp/inbound',
      '/api/whatsapp/INBOUND',
      '/api/whatsapp/inbound-extra',
      '/api/whatsapp/inbound/child',
      '/api/whatsapp/%69nbound',
      '/api/whatsapp/inbox',
      '/api/pos-info',
    ]) {
      equal(
        (await request(server).post(url).set('X-FloCafe-Inbox-Key', key).send(payload)).status,
        401,
        `service key cannot authorize ${url}`,
      );
    }
    for (const method of ['get', 'put', 'patch', 'delete', 'head', 'options'] as const) {
      equal(
        (await request(server)[method]('/api/whatsapp/inbound').set('X-FloCafe-Inbox-Key', key))
          .status,
        401,
        `${method} is not service-authorized`,
      );
    }
    equal(
      (await request(server).get('/api/pos-info').set(authHeader)).status,
      200,
      'human JWT route unaffected',
    );
    equal(
      (await request(server).get('/api/whatsapp/inbox').set(authHeader)).status,
      200,
      'human WhatsApp permissions unaffected',
    );
    db.prepare(`INSERT INTO conversation_takeover (phone_e164, state, taken_by, taken_at)
      VALUES (?, 'taken', ?, CURRENT_TIMESTAMP)`).run('+14155552671', 'operator-1');
    const takeoverState = await request(server)
      .get('/api/whatsapp/takeover/%2B14155552671')
      .set('X-FloCafe-Inbox-Key', key);
    equal(takeoverState.status, 200, 'service key can read exact takeover state without JWT');
    equal(takeoverState.body.state, 'taken', 'service read returns persisted takeover state');
    equal(takeoverState.body.takenBy, 'operator-1', 'service read returns takeover actor');
    const humanTakeoverState = await request(server)
      .get('/api/whatsapp/takeover/%2B14155552671')
      .set(authHeader);
    equal(humanTakeoverState.status, 200, 'human JWT access to takeover state is preserved');
    for (const url of [
      '/api/whatsapp/takeover/%2B14155552671/',
      '/api/whatsapp/takeover/%2B14155552671/extra',
      '/api/whatsapp/takeover/%2B14155552671x',
      '/api/whatsapp/takeover/14155552671',
      '/api/whatsapp/inbox',
    ]) {
      equal(
        (await request(server).get(url).set('X-FloCafe-Inbox-Key', key)).status,
        401,
        `service key cannot read broader route ${url}`,
      );
    }
    equal(
      (await request(server).get('/api/whatsapp/takeover/%2B14155552671')
        .set('X-FloCafe-Inbox-Key', randomBytes(32).toString('hex'))).status,
      401,
      'wrong service key cannot read takeover state',
    );
    const inbox = await request(server).get('/api/whatsapp/inbox').set(authHeader);
    equal(inbox.body.messages[0]?.takeover_state, 'taken', 'human inbox lists persisted takeover state');
    equal(inbox.body.messages[0]?.takeover_taken_by, 'operator-1', 'human inbox lists takeover actor');
    equal(
      (await request(server).post('/api/whatsapp/release/%2B14155552671').set(authHeader).send({})).status,
      200,
      'human can release the conversation through the UI route',
    );
    const releasedState = await request(server)
      .get('/api/whatsapp/takeover/%2B14155552671')
      .set('X-FloCafe-Inbox-Key', key);
    equal(releasedState.status, 200, 'service key can re-read state after release');
    equal(releasedState.body.state, 'free', 'bot sees released conversation as free');
    equal(
      (
        await request(server)
          .post('/api/whatsapp/inbound/')
          .set(authHeader)
          .set('X-FloCafe-Inbox-Key', key)
          .send(payload)
      ).status,
      401,
      'route guard rejects alias even with both credentials',
    );
    equal(
      (
        await request(server)
          .post('/api/whatsapp/inbound?source=test')
          .set('X-FloCafe-Inbox-Key', key)
          .send(payload)
      ).status,
      200,
      'query does not broaden path scope',
    );
    const replacement = randomBytes(32).toString('hex');
    process.env.FLOCAFE_INBOX_SERVICE_KEY = replacement;
    equal(
      (
        await request(server)
          .post('/api/whatsapp/inbound')
          .set('X-FloCafe-Inbox-Key', key)
          .send(payload)
      ).status,
      401,
      'replaced key rejected',
    );
    equal(
      (
        await request(server)
          .post('/api/whatsapp/inbound')
          .set('X-FloCafe-Inbox-Key', replacement)
          .send(payload)
      ).status,
      200,
      'replacement accepted',
    );
    for (const configured of [undefined, '', 'weak']) {
      if (configured === undefined) delete process.env.FLOCAFE_INBOX_SERVICE_KEY;
      else process.env.FLOCAFE_INBOX_SERVICE_KEY = configured;
      equal(
        (
          await request(server)
            .post('/api/whatsapp/inbound')
            .set('X-FloCafe-Inbox-Key', replacement)
            .send(payload)
        ).status,
        401,
        'revoked or invalid configuration fails closed',
      );
    }
  } finally {
    if (previous === undefined) delete process.env.FLOCAFE_INBOX_SERVICE_KEY;
    else process.env.FLOCAFE_INBOX_SERVICE_KEY = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
