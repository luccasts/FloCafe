const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const scratch = process.env.DEPENDENCY_PRIVACY_TMPDIR || process.env.TMPDIR || require('node:os').tmpdir();
const installer = path.join(root, 'scripts/patch-dependency-privacy.cjs');
const packaging = path.join(root, 'scripts/verify-dependency-privacy-package.cjs');
function fixture() {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'flo-package-privacy-'));
  for (const [name, files] of [
    ['libsignal', ['src/session_record.js', 'src/session_cipher.js', 'src/queue_job.js']],
    ['@whiskeysockets/baileys', ['lib/Utils/logger.js', 'lib/Socket/communities.js', 'lib/Utils/business.js']],
  ]) for (const relative of ['package.json', ...files]) {
    const to = path.join(dir, 'node_modules', name, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, 'node_modules', name, relative), to);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('packaging refuses unpatched source and verifies bytes inside final app.asar', async () => {
  const f = fixture();
  const output = fs.mkdtempSync(path.join(scratch, 'flo-package-output-'));
  try {
    const packageManifest = require('../package.json');
    assert.equal(packageManifest.build.beforePack, 'scripts/verify-dependency-privacy-package.cjs');
    assert.equal(packageManifest.build.afterPack, 'scripts/afterPack.js');
    const beforePack = require(packaging);
    // Deliberately restore only this disposable fixture to the known unpatched source.
    const fixtureRecord = path.join(f.dir, 'node_modules/libsignal/src/session_record.js');
    const spec = require(installer).specs.libsignal.files['src/session_record.js'];
    let unpatched = fs.readFileSync(fixtureRecord, 'utf8');
    for (const [before, after] of spec.replacements) unpatched = unpatched.replace(after, before);
    assert.equal(require('node:crypto').createHash('sha256').update(unpatched).digest('hex'), spec.before);
    fs.writeFileSync(fixtureRecord, unpatched);
    assert.throws(() => beforePack({ packager: { projectDir: f.dir } }), /patch missing|privacy/i);
    const apply = spawnSync(process.execPath, [installer, '--root', f.dir], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.doesNotThrow(() => beforePack({ packager: { projectDir: f.dir } }));
    const resources = path.join(output, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    const archive = path.join(resources, 'app.asar');
    await asar.createPackage(f.dir, archive);
    const context = { appOutDir: output, packager: { platform: { name: 'windows' }, projectDir: f.dir }, arch: 1 };
    const afterPack = () => spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(root, 'scripts/afterPack.js'))})(${JSON.stringify(context)}).catch(e => { console.error(e.message); process.exitCode=1 })`,
    ], { encoding: 'utf8' });
    const good = afterPack();
    assert.equal(good.status, 0, good.stderr);
    const source = path.join(f.dir, 'node_modules/libsignal/src/session_record.js');
    fs.appendFileSync(source, '\n// unexpected mutation\n');
    fs.rmSync(archive);
    await asar.createPackage(f.dir, archive);
    const bad = afterPack();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /privacy|hash/i);
  } finally { f.cleanup(); fs.rmSync(output, { recursive: true, force: true }); }
});
