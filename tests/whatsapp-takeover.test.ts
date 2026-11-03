/**
 * whatsapp-takeover.test.ts
 * Tests for conversation takeover/release feature.
 */

process.env.NODE_ENV = 'test';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-test-whatsapp-takeover-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const whatsappRoutes = require('../main/routes/whatsapp').whatsappRoutes;
const whatsappService = require('../main/services/whatsapp');

function seedTestRegionalDefaults(db) {
  const insert = (key, value) =>
    db
      .prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, now());
  insert('country', 'IN');
  insert('currency', 'INR');
  insert('currency_symbol', '₹');
  insert('timezone', 'Asia/Kolkata');
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test-secret-' + Date.now();
  }
  const { getJWTSecret } = require('../main/routes/auth');

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      next();
      return;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, getJWTSecret());
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  });

  app.use('/api/whatsapp', whatsappRoutes);
  return app;
}

function seedOwnerUser(db) {
  const ownerId = crypto.randomUUID();
  const pinHash = bcrypt.hashSync('1234', 10);
  const passwordHash = bcrypt.hashSync('password123', 10);
  db.prepare(
    'INSERT INTO users (id, name, role, pin_hash, password, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ownerId, 'Test Owner', 'owner', pinHash, passwordHash, now());
  return ownerId;
}

function makeToken(userId, role = 'owner') {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function apiRequest(app, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: 'localhost',
        port,
        path: '/api' + path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          server.close();
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode, data: parsed });
          } catch {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(
      `  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function getResults() {
  return { passed, failed, total };
}

// Test: Takeover/Release feature
async function testTakeoverRelease() {
  console.log('\n--- Testing WhatsApp Takeover/Release ---');

  initDatabase();
  const db = getDatabase();
  seedTestRegionalDefaults(db);
  const ownerId = seedOwnerUser(db);

  // Set JWT_SECRET before importing auth routes
  process.env.JWT_SECRET = 'test-secret-' + Date.now();
  const token = makeToken(ownerId);

  // Enable WhatsApp
  whatsappService.enable(ownerId);
  whatsappService.initFromDb();

  const app = createApp();

  // Test 1: Initial state - conversation should be free
  console.log('\n1. Test initial takeover state (free)');
  const state1 = whatsappService.getTakeoverState('+5511987654321');
  assertEqual(state1.state, 'free', 'Initial state should be free');
  assertEqual(state1.takenBy, undefined, 'No one should have taken it');
  assertEqual(state1.takenAt, undefined, 'No takenAt timestamp');

  // Test 2: Take conversation
  console.log('\n2. Take conversation');
  whatsappService.takeConversation('+5511987654321', 'atendente-joao');
  const state2 = whatsappService.getTakeoverState('+5511987654321');
  assertEqual(state2.state, 'taken', 'State should be taken after takeover');
  assertEqual(state2.takenBy, 'atendente-joao', 'Taken by should be atendente-joao');
  assert(state2.takenAt !== undefined, 'takenAt should be set');

  // Test 3: Release conversation
  console.log('\n3. Release conversation');
  whatsappService.releaseConversation('+5511987654321', 'atendente-joao');
  const state3 = whatsappService.getTakeoverState('+5511987654321');
  assertEqual(state3.state, 'free', 'State should be free after release');
  assertEqual(state3.releasedBy, 'atendente-joao', 'Released by should be atendente-joao');
  assert(state3.releasedAt !== undefined, 'releasedAt should be set');

  // Test 4: Take conversation via API endpoint
  console.log('\n4. Take conversation via API endpoint');
  const takeoverRes = await apiRequest(app, 'POST', '/whatsapp/takeover/+5511987654321', {}, token);
  assertEqual(takeoverRes.status, 200, 'Takeover API should return 200');
  assertEqual(takeoverRes.data.ok, true, 'Takeover API should return ok=true');
  const state4 = whatsappService.getTakeoverState('+5511987654321');
  assertEqual(state4.state, 'taken', 'State should be taken after API takeover');
  assertEqual(state4.takenBy, ownerId, 'Taken by should be owner user ID');

  // Reply through the existing bot socket only after this conversation is taken over.
  const insertInbound = db.prepare(`
    INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, queued_at)
    VALUES (?, 'inbound', 'user_message', 'queued', ?, ?)
  `);
  const inboundId = Number(insertInbound.run('+5511777700001', 'Boa noite', now()).lastInsertRowid);
  const freeReply = await apiRequest(
    app,
    'POST',
    `/whatsapp/inbox/${inboundId}/reply`,
    { body: 'Olá' },
    token,
  );
  assertEqual(freeReply.status, 409, 'Reply should be rejected while conversation is not taken');

  whatsappService.takeConversation('+5511777700001', ownerId);
  const previousFetch = global.fetch;
  let botRequest;
  process.env.WHATSAPP_BOT_REPLY_URL = 'http://127.0.0.1:3004/api/v1/inbox/reply';
  process.env.WHATSAPP_BOT_REPLY_KEY = 'synthetic-test-key';
  global.fetch = async (url, init) => {
    botRequest = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const humanReply = await apiRequest(
      app,
      'POST',
      `/whatsapp/inbox/${inboundId}/reply`,
      { body: 'Olá, boa noite!' },
      token,
    );
    assertEqual(humanReply.status, 200, 'Human reply should be forwarded to bot callback');
    assertEqual(humanReply.data.ok, true, 'Human reply API should return ok=true');
    assertEqual(
      botRequest.url,
      process.env.WHATSAPP_BOT_REPLY_URL,
      'Reply should target configured bot callback',
    );
    assertEqual(
      new Headers(botRequest.init.headers).get('authorization'),
      'Bearer synthetic-test-key',
      'Reply should authenticate to bot callback',
    );
    assertEqual(
      JSON.parse(botRequest.init.body).phone_e164,
      '+5511777700001',
      'Reply should use phone from inbound message',
    );
    assertEqual(
      JSON.parse(botRequest.init.body).body,
      'Olá, boa noite!',
      'Reply text should reach bot callback unchanged',
    );
  } finally {
    global.fetch = previousFetch;
    delete process.env.WHATSAPP_BOT_REPLY_URL;
    delete process.env.WHATSAPP_BOT_REPLY_KEY;
  }

  // Test 5: Get takeover state via API
  console.log('\\n5. Get takeover state via API');
  const getStateRes = await apiRequest(
    app,
    'GET',
    '/whatsapp/takeover/+5511987654321',
    null,
    token,
  );
  assertEqual(getStateRes.status, 200, 'Get state API should return 200');
  assertEqual(getStateRes.data.state, 'taken', 'Get state should return taken');
  assertEqual(getStateRes.data.takenBy, ownerId, 'Get state should show takenBy');

  // Test 6: Release conversation via API endpoint
  console.log('\n6. Release conversation via API endpoint');
  const releaseRes = await apiRequest(app, 'POST', '/whatsapp/release/+5511987654321', {}, token);
  assertEqual(releaseRes.status, 200, 'Release API should return 200');
  assertEqual(releaseRes.data.ok, true, 'Release API should return ok=true');
  const state6 = whatsappService.getTakeoverState('+5511987654321');
  assertEqual(state6.state, 'free', 'State should be free after API release');
  assertEqual(state6.releasedBy, ownerId, 'Released by should be owner user ID');

  // Test 7: Get state after release
  console.log('\n7. Get takeover state after release');
  const getStateAfterRelease = await apiRequest(
    app,
    'GET',
    '/whatsapp/takeover/+5511987654321',
    null,
    token,
  );
  assertEqual(getStateAfterRelease.status, 200, 'Get state after release should return 200');
  assertEqual(getStateAfterRelease.data.state, 'free', 'State should be free');

  // Test 8: Multiple takeovers should update the same record
  console.log('\n8. Multiple takeovers update same record');
  whatsappService.takeConversation('+5511888888888', 'atendente-maria');
  const state8a = whatsappService.getTakeoverState('+5511888888888');
  assertEqual(state8a.state, 'taken', 'First takeover should be taken');
  assertEqual(state8a.takenBy, 'atendente-maria', 'First taken by');

  whatsappService.takeConversation('+5511888888888', 'atendente-pedro');
  const state8b = whatsappService.getTakeoverState('+5511888888888');
  assertEqual(state8b.state, 'taken', 'Second takeover should still be taken');
  assertEqual(state8b.takenBy, 'atendente-pedro', 'Taken by should be updated to pedro');

  // Test 9: Invalid phone format
  console.log('\n9. Invalid phone format');
  const invalidPhoneRes = await apiRequest(
    app,
    'POST',
    '/whatsapp/takeover/invalid-phone',
    {},
    token,
  );
  assertEqual(invalidPhoneRes.status, 400, 'Invalid phone should return 400');
  assertEqual(invalidPhoneRes.data.reason, 'invalid_phone', 'Should return invalid_phone reason');

  // Test 10: Release without prior takeover (should still work)
  console.log('\n10. Release without prior takeover');
  const state10a = whatsappService.getTakeoverState('+5511777777777');
  assertEqual(state10a.state, 'free', 'Fresh phone should be free');

  whatsappService.releaseConversation('+5511777777777', 'atendente-test');
  const state10b = whatsappService.getTakeoverState('+5511777777777');
  assertEqual(state10b.state, 'free', 'Releasing free conversation should keep it free');
  assertEqual(state10b.releasedBy, 'atendente-test', 'Released by should be recorded');

  console.log('\n--- Takeover/Release Tests Complete ---');
}

// Run tests
async function runTests() {
  try {
    await testTakeoverRelease();
  } catch (err) {
    console.error('Test suite error:', err);
    failed++;
    total++;
  }

  const results = getResults();
  console.log(
    `\n=== Results: ${results.passed} passed, ${results.failed} failed, ${results.total} total ===`,
  );

  if (results.failed > 0) {
    process.exit(1);
  }
}

runTests();
