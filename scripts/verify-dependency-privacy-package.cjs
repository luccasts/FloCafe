'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const { verify, specs } = require('./patch-dependency-privacy.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function beforePack(context) {
  verify(context.packager.projectDir, 'check');
}

function verifyArchive(context) {
  const output = context.appOutDir;
  let resourceDir;
  if (context.packager.platform.name === 'mac') {
    const apps = fs.readdirSync(output).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('dependency privacy: expected exactly one macOS app artifact');
    resourceDir = path.join(output, apps[0], 'Contents', 'Resources');
  } else resourceDir = path.join(output, 'resources');
  const archive = path.join(resourceDir, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error('dependency privacy: app.asar missing');
  const entries = new Map(asar.listPackage(archive).map(raw => [raw.replaceAll('\\', '/').replace(/^\//, ''), raw]));
  const paths = [...entries.keys()];
  const counts = {};
  for (const [name, spec] of Object.entries(specs)) {
    const manifests = paths.filter(value => value.endsWith(`node_modules/${name}/package.json`));
    counts[name] = manifests.length;
    for (const manifest of manifests) {
      const prefix = manifest.slice(0, -'package.json'.length);
      const metadata = JSON.parse(asar.extractFile(archive, entries.get(manifest).replace(/^[\\/]/, '')).toString('utf8'));
      if (metadata.name !== name || !(spec.versions || [spec.version]).includes(metadata.version))
        throw new Error(`dependency privacy: ${name} unexpected artifact version`);
      for (const [relative, file] of Object.entries(spec.files)) {
        const inArchive = `${prefix}${relative}`;
        if (!entries.has(inArchive) || sha(asar.extractFile(archive, entries.get(inArchive).replace(/^[\\/]/, ''))) !== file.after)
          throw new Error(`dependency privacy: ${name}/${relative} artifact hash mismatch`);
      }
    }
  }
  if (!counts.libsignal || !counts['@whiskeysockets/baileys'])
    throw new Error('dependency privacy: required packages missing from artifact');
  console.log(`dependency privacy artifact verified: ${JSON.stringify(counts)}`);
}

module.exports = beforePack;
module.exports.verifyArchive = verifyArchive;
