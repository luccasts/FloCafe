const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const scratch = process.env.DEPENDENCY_PRIVACY_TMPDIR || process.env.TMPDIR || require('node:os').tmpdir();
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts', 'patch-dependency-privacy.cjs');
const secret = 'SYNTHETIC_PRIVATE_SESSION_KEY_78432';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture() {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'dependency-privacy-'));
  const src = path.join(root, 'node_modules', 'libsignal');
  const dst = path.join(dir, 'node_modules', 'libsignal');
  fs.cpSync(src, dst, { recursive: true });
  for (const [name, files] of [
    ['@whiskeysockets/baileys', ['lib/Utils/logger.js', 'lib/Socket/communities.js', 'lib/Utils/business.js']],
  ]) {
    for (const file of ['package.json', ...files]) {
      const destination = path.join(dir, 'node_modules', name, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, 'node_modules', name, file), destination);
    }
  }
  const pinoDir = path.dirname(require.resolve('pino/package.json', { paths: [path.join(root, 'node_modules', '@whiskeysockets', 'baileys')] }));
  fs.mkdirSync(path.join(dir, 'node_modules', '@whiskeysockets', 'baileys', 'node_modules'), { recursive: true });
  fs.symlinkSync(pinoDir, path.join(dir, 'node_modules', '@whiskeysockets', 'baileys', 'node_modules', 'pino'), 'junction');
  return { dir, dst, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function run(rootDir, source) {
  return spawnSync(process.execPath, ['-e', source, rootDir, secret], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') } });
}
const scenario = `
const assert = require('node:assert/strict');
const lib = require(require('node:path').join(process.argv[1], 'node_modules/libsignal'));
const SessionRecord = require(require('node:path').join(process.argv[1], 'node_modules/libsignal/src/session_record'));
const queue = require(require('node:path').join(process.argv[1], 'node_modules/libsignal/src/queue_job'));
const secret = process.argv[2];
(async () => {
  const record = new SessionRecord();
  const entry = SessionRecord.createEntry();
  entry.indexInfo = { baseKey: Buffer.alloc(33, 5), baseKeyType: 1, closed: -1, used: 1, created: 1, remoteIdentityKey: Buffer.alloc(33, 4) };
  entry.registrationId = 42;
  entry.syntheticSecret = secret;
  record.setSession(entry);
  record.closeSession(entry);
  assert.equal(record.isClosed(entry), true);
  record.closeSession(entry);
  record.openSession(entry);
  assert.equal(record.isClosed(entry), false);
  for(let i=0;i<41;i++) {
    const older = SessionRecord.createEntry();
    older.indexInfo = { baseKey: Buffer.alloc(33, i+50), closed: i+1 };
    older.syntheticSecret = secret;
    record.setSession(older);
  }
  record.removeOldSessions();
  assert.equal(record.getSessions().length, 40);
  SessionRecord.migrate({ _sessions: { x: {indexInfo:{closed:-1}} }, registrationId:0, version:undefined });
  assert.equal(await queue({ toString: () => secret }, async function job() {return 17}), 17);
  const cipher = new lib.SessionCipher({}, new lib.ProtocolAddress('synthetic', 1));
  cipher.doDecryptWhisperMessage = async () => { throw new Error(secret) };
  await assert.rejects(() => cipher.decryptWithSessions(Buffer.alloc(3), [{ indexInfo: {} }]), /No matching sessions/);
  process.stdout.write('OUTCOMES_OK\\n');
})().catch(e => { process.stderr.write('SCENARIO_FAILED ' + e.stack); process.exitCode=2 });
`;
test('session lifecycle, migration, queue and decrypt failure never print synthetic secrets', () => {
  const f = fixture();
  try {
    if (process.env.DEPENDENCY_PRIVACY_RED !== '1') {
      const install = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
      assert.equal(install.status, 0, install.stderr);
    }
    const outcome = run(f.dir, scenario);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /OUTCOMES_OK/);
    assert.doesNotMatch(outcome.stdout + outcome.stderr, /SYNTHETIC_PRIVATE_SESSION_KEY_78432/);
    assert.match(outcome.stderr, /Failed to decrypt message with any known session/);
    assert.match(outcome.stderr, /V1 session storage migration error/);
  } finally { f.cleanup(); }
});
test('installer is idempotent, refuses tamper and unknown version without partial writes', () => {
  const f = fixture();
  try {
    const target = path.join(f.dst, 'src', 'session_record.js');
    const first = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const digest = hash(target);
    const repeat = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(hash(target), digest);
    fs.appendFileSync(target, '\n// unexpected change\n');
    const reject = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.notEqual(reject.status, 0);
    assert.match(reject.stderr, /unexpected|hash|mismatch/i);
    assert.notEqual(hash(target), digest);
    fs.writeFileSync(path.join(f.dst, 'package.json'), JSON.stringify({ version: '6.0.1' }));
    const wrong = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.notEqual(wrong.status, 0);
  } finally { f.cleanup(); }
});
test('all exact nested instances are patched and mixed tamper fails before any write', () => {
  const f = fixture();
  try {
    const nested = path.join(f.dir, 'node_modules/@whiskeysockets/baileys/node_modules/libsignal');
    fs.cpSync(f.dst, nested, { recursive: true });
    const sdkLogger = path.join(f.dir, 'node_modules/@whiskeysockets/baileys/lib/Utils/logger.js');
    const nestedRecord = path.join(nested, 'src/session_record.js');
    const rootRecord = path.join(f.dst, 'src/session_record.js');
    fs.appendFileSync(sdkLogger, '\n// tampered SDK\n');
    const rootBefore = hash(rootRecord), nestedBefore = hash(nestedRecord);
    const reject = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.notEqual(reject.status, 0);
    assert.equal(hash(rootRecord), rootBefore);
    assert.equal(hash(nestedRecord), nestedBefore);
    fs.writeFileSync(sdkLogger, fs.readFileSync(path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Utils/logger.js')));
    const apply = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(hash(rootRecord), require(installer).specs.libsignal.files['src/session_record.js'].after);
    assert.equal(hash(rootRecord), hash(nestedRecord));
    assert.match(apply.stdout, /"libsignal":2/);
  } finally { f.cleanup(); }
});
test('SDK default logger never serializes child bindings or variable arguments', () => {
  const f = fixture();
  try {
    const install = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const probe = run(f.dir, `
      (async () => {
        const { pathToFileURL } = require('node:url');
        const { join } = require('node:path');
        const { default: logger } = await import(pathToFileURL(join(process.argv[1], 'node_modules/@whiskeysockets/baileys/lib/Utils/logger.js')).href);
        logger.level = 'warn';
        logger.child({ jid: process.argv[2] }).warn({ qr: process.argv[2] }, process.argv[2]);
        logger.error(new Error(process.argv[2]), process.argv[2]);
      })().catch(e => { console.error('probe failed', e); process.exitCode = 2 });
    `);
    assert.equal(probe.status, 0, probe.stderr);
    assert.doesNotMatch(probe.stdout + probe.stderr, /SYNTHETIC_PRIVATE_SESSION_KEY_78432/);
    assert.match(probe.stdout, /"code":"sdk_log"/);
  } finally { f.cleanup(); }
});
