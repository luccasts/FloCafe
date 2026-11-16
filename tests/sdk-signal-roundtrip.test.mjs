import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = process.argv[2] || path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const signal = require('libsignal');
const { makeLibSignalRepository } = await import(pathToFileURL(path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js')).href);
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
function makeAuth(identity, signed, pre, registrationId) {
  const values = new Map();
  values.set('pre-key', new Map([['23', { public: pre.keyPair.pubKey.subarray(1), private: pre.keyPair.privKey }]]));
  const keys = {
    async get(kind, names) {
      const bucket = values.get(kind) ?? new Map();
      return Object.fromEntries(names.filter(key => bucket.has(key)).map(key => [key, bucket.get(key)]));
    },
    async set(entries) {
      for (const [kind, kv] of Object.entries(entries)) {
        const bucket = values.get(kind) ?? new Map();
        for (const [key, value] of Object.entries(kv)) value === null ? bucket.delete(key) : bucket.set(key, value);
        values.set(kind, bucket);
      }
    },
    async transaction(fn) { return fn(); },
  };
  return {
    creds: { registrationId, signedIdentityKey: { public: identity.pubKey.subarray(1), private: identity.privKey }, signedPreKey: { keyPair: { public: signed.keyPair.pubKey.subarray(1), private: signed.keyPair.privKey }, keyId: 41 } },
    keys,
  };
}
async function main() {
  const a = signal.keyhelper.generateIdentityKeyPair();
  const b = signal.keyhelper.generateIdentityKeyPair();
  const aSigned = signal.keyhelper.generateSignedPreKey(a, 41);
  const aPre = signal.keyhelper.generatePreKey(23);
  const bSigned = signal.keyhelper.generateSignedPreKey(b, 41);
  const bPre = signal.keyhelper.generatePreKey(23);
  const aRepo = makeLibSignalRepository(makeAuth(a, aSigned, aPre, 11), logger);
  const bRepo = makeLibSignalRepository(makeAuth(b, bSigned, bPre, 12), logger);
  const aliceJid = '15550000001@s.whatsapp.net';
  const bobJid = '15550000002@s.whatsapp.net';
  await aRepo.injectE2ESession({ jid: bobJid, session: {
    identityKey: b.pubKey, signedPreKey: { keyId: 41, publicKey: bSigned.keyPair.pubKey, signature: bSigned.signature },
    preKey: { keyId: 23, publicKey: bPre.keyPair.pubKey }, registrationId: 12,
  } });
  assert.equal((await aRepo.validateSession(bobJid)).exists, true);
  const input = Buffer.from('synthetic SDK repository message');
  const outbound = await aRepo.encryptMessage({ jid: bobJid, data: input });
  assert.equal(outbound.type, 'pkmsg');
  assert.deepEqual(await bRepo.decryptMessage({ jid: aliceJid, type: outbound.type, ciphertext: outbound.ciphertext }), input);
  const reply = Buffer.from('synthetic SDK repository reply');
  const inbound = await bRepo.encryptMessage({ jid: aliceJid, data: reply });
  assert.equal(inbound.type, 'msg');
  assert.deepEqual(await aRepo.decryptMessage({ jid: bobJid, type: inbound.type, ciphertext: inbound.ciphertext }), reply);
  assert.equal((await bRepo.validateSession(aliceJid)).exists, true);
  aRepo.close(); bRepo.close();
  console.log('SDK repository init/encrypt/decrypt/reply: OK');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
