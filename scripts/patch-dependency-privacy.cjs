// Exact-source privacy patch for the installed SDKs. No crypto expressions change.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = data => createHash('sha256').update(data).digest('hex');
const safe = (before, after) => [before, after];
const specs = {
  libsignal: {
    version: '6.0.0',
    files: {
      'src/session_record.js': {
        before: '604d6d8ded9d316f7e8367c45759f6449be743c5aabe142db3412eff4e89ab35', after: '8ae609024615a404cd88a4ba47dbf8565f56a548a4daf2f71dd85fd2e09f53c8',
        replacements: [
          safe("console.error('V1 session storage migration error: registrationId',\n                                  data.registrationId, 'for open session version',\n                                  data.version);", "console.error('V1 session storage migration error: registrationId');"),
          safe('console.warn("Session already closed", session);', 'console.warn("Session already closed");'),
          safe('console.info("Closing session:", session);', 'console.info("Closing session");'),
          safe('console.info("Opening session:", session);', 'console.info("Opening session");'),
          safe('console.info("Removing old closed session:", oldestSession);', 'console.info("Removing old closed session");'),
        ],
      },
      'src/session_cipher.js': {
        before: '031b3282489ffec6a0cab23520bdf956a5bf4d15c57cb868e89fa6643255cd2b', after: 'adb619d9e2e752c9094c144e6d4bd22e092059ca670e499c5fa8598d237eef29',
        replacements: [safe('console.error("Session error:" + e, e.stack);', 'console.error("Session error: decrypt_failed");')],
      },
      'src/queue_job.js': {
        before: 'd581518bab0da98ddc71cd6616bab769e0de413ec007454b7d42804ee3f244f3', after: 'c0a34e9ff48145733ac6414231646214e71447808ddc42cfe21a089ff97984f2',
        replacements: [safe('console.warn("Unhandled bucket type (for naming):", typeof bucket, bucket);', 'console.warn("Unhandled bucket type (for naming)");')],
      },
    },
  },
  '@whiskeysockets/baileys': {
    versions: ['7.0.0-rc13', '7.0.0-rc14'],
    files: {
      'lib/Utils/logger.js': {
        before: '01b6faa2d8a7dbe80271dd0c12d67f6458578b3072862b53a0cd91fbaa491143', after: 'c95ce8180d480b1648afb7e73a51139d9f9e64b18e905787716ec94256602dc4',
        replacements: [safe('export default P({ timestamp: () => `,"time":"${new Date().toJSON()}"` });', 'const logger = P({ base: null, timestamp: () => `,"time":"${new Date().toJSON()}"`, hooks: { logMethod(_args, method) { method.call(this, { code: "sdk_log" }, "sdk_log"); } } });\nlogger.child = () => logger;\nexport default logger;')],
      },
      'lib/Socket/communities.js': {
        before: '25dd8d85c66f28d850bb1c8583fd4c014b79a4e228cc7ba3e2fe936009def062', after: '34198e10369de1e290630af429353c0787bfe8c80af755996831928ac7740d58',
        replacements: [safe("console.error('Error parsing group metadata:', error);", "console.error('Error parsing group metadata: parse_failed');")],
      },
      'lib/Utils/business.js': {
        before: 'ac9afff29a97d7978cd98d2ed04d70772de92bdcffd018e4d9e85dd809b81e09', after: '57efcaf68a1b9ece5c6b9cf2704565687a4e1534a85734d2ec5deae6eac4586f',
        replacements: [safe("console.log('Error deleting temp file ', err)", "console.warn('Error deleting temp file: cleanup_failed')")],
      },
    },
  },
  '@itsliaaa/baileys': {
    version: '0.4.4',
    files: {
      'lib/Socket/communities.js': {
        before: '88f0480b1a98658144678eab4034d0625ccaa662f19e85682d5a310b99937ab2', after: 'b88e9dd7dc4ec64be7729fba4d202828f76613bf45efbae3e2d176bd7a2ff96e',
        replacements: [safe("console.error('Error parsing group metadata:', error);", "console.error('Error parsing group metadata: parse_failed');")],
      },
      'lib/Utils/business.js': {
        before: 'a305ffa6c1d5587cf1dd0ed23fa3874bbf57b8cfd7e231d579bc555737c7734e', after: '599b01a817ce6490c2d5b240f29fe494655ac76a61b525ecb16b8af261914b95',
        replacements: [safe("console.log('Error deleting temp file ', err)", "console.warn('Error deleting temp file: cleanup_failed')")],
      },
      'lib/Transport/session-record.js': {
        before: 'c29ff0d152b560f04b2f1e37a1896d81d2c3f22fd62a2e702b242809916cc4c6', after: 'caf1b426a9a19683498bcb53cd6ca89152b9638ce7a3d0f7e8932128b4088a03',
        replacements: [safe("console.error('V1 session storage migration error: registrationId', data.registrationId, 'for open session version', data.version);", "console.error('V1 session storage migration error: registrationId');")],
      },
    },
  },
};
function occurrences(text, token) { return text.split(token).length - 1; }
function findPackages(root, name) {
  const found = [];
  const seen = new Set();
  function visit(nodeModules) {
    if (!fs.existsSync(nodeModules)) return;
    const entries = fs.readdirSync(nodeModules, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const loc = path.join(nodeModules, entry.name);
      if (!entry.isDirectory()) continue;
      const packageDirs = entry.name.startsWith('@')
        ? fs.readdirSync(loc, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(loc, e.name))
        : [loc];
      for (const packageDir of packageDirs) {
        const real = fs.realpathSync(packageDir);
        if (seen.has(real)) continue;
        seen.add(real);
        const manifest = path.join(packageDir, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name === name) found.push(packageDir);
        visit(path.join(packageDir, 'node_modules'));
      }
    }
  }
  visit(path.join(root, 'node_modules'));
  return found;
}
function verify(root, mode = 'apply') {
  const writes = [];
  const counts = {};
  for (const [name, spec] of Object.entries(specs)) {
    const packages = findPackages(root, name);
    counts[name] = packages.length;
    for (const packageDir of packages) {
      const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      if (!((spec.versions || [spec.version]).includes(pkg.version))) throw new Error(`${name}: unexpected version ${pkg.version}`);
      for (const [relative, file] of Object.entries(spec.files)) {
        const target = path.join(packageDir, relative);
        const text = fs.readFileSync(target, 'utf8');
        const digest = sha(text);
        if (digest === file.after) continue;
        if (mode === 'check') throw new Error(`${name}/${relative}: privacy patch missing or unexpected hash`);
        if (digest !== file.before) throw new Error(`${name}/${relative}: unexpected hash ${digest}`);
        let patched = text;
        for (const [oldText, newText] of file.replacements) {
          if (occurrences(patched, oldText) !== 1) throw new Error(`${name}/${relative}: hunk mismatch`);
          patched = patched.replace(oldText, newText);
        }
        if (sha(patched) !== file.after) throw new Error(`${name}/${relative}: post-patch hash mismatch`);
        writes.push([target, patched]);
      }
    }
  }
  if (!counts.libsignal || !counts['@whiskeysockets/baileys']) throw new Error(`missing required packages: ${JSON.stringify(counts)}`);
  // Preflight every installed copy before touching any file.
  for (const [target, content] of writes) fs.writeFileSync(target, content);
  return { counts, filesPatched: writes.length };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const rootIndex = args.indexOf('--root');
    const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : path.resolve(__dirname, '..');
    if (args.includes('--print-hashes')) {
      for (const [name, spec] of Object.entries(specs)) {
        for (const dir of findPackages(root, name)) {
          for (const [relative, file] of Object.entries(spec.files)) {
            let text = fs.readFileSync(path.join(dir, relative), 'utf8');
            if (sha(text) !== file.before) throw new Error(`${name}/${relative}: source hash mismatch`);
            for (const [oldText, newText] of file.replacements) {
              if (occurrences(text, oldText) !== 1) throw new Error(`${name}/${relative}: hunk mismatch`);
              text = text.replace(oldText, newText);
            }
            console.log(`${name}/${relative} ${sha(text)}`);
          }
        }
      }
    } else console.log(`dependency privacy ${JSON.stringify(verify(root, args.includes('--check') ? 'check' : 'apply'))}`);
  } catch (err) {
    console.error(`dependency privacy patch refused: ${err.message}`);
    process.exitCode = 1;
  }
}
module.exports = { verify, specs };
