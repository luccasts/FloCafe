import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inbox-upgrade-'));
Module._load = function (name: string) {
  if (name === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.NODE_ENV = 'test';
const database = require('../main/db');
const migration = database.MIGRATIONS.pop();
assert.equal(migration.version, 126);
try {
  database.initDatabase();
  let db = database.getDatabase();
  assert.equal(database.getCurrentSchemaVersion(), 125);
  const kinds = ['bill_receipt','manual_reply','auto_followup','z_report','daily_sales_report'];
  for (const kind of kinds) db.prepare(`INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id) VALUES ('+14155552671','outbound',?,'sent',?,?)`).run(kind, kind, `old-${kind}`);
  db.prepare("INSERT INTO whatsapp_message_attempts (message_id,external_message_id,created_at) VALUES (1,'old-attempt','2026-01-01 00:00:00')").run();
  db.prepare("INSERT INTO whatsapp_messages (id,phone_e164,direction,kind,status,body) VALUES (1000,'+14155552671','outbound','manual_reply','sent','deleted fixture')").run();
  db.prepare('DELETE FROM whatsapp_messages WHERE id=1000').run();
  const rows = db.prepare('SELECT * FROM whatsapp_messages ORDER BY id').all();
  const attempts = db.prepare('SELECT * FROM whatsapp_message_attempts ORDER BY id').all();
  db.exec(`CREATE TABLE inbox_upgrade_trigger_probe (message_id INTEGER);
    CREATE TRIGGER inbox_upgrade_probe AFTER UPDATE ON whatsapp_messages
    BEGIN INSERT INTO inbox_upgrade_trigger_probe VALUES (NEW.id); END;`);
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='inbox_upgrade_probe'").get();
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='whatsapp_messages' ORDER BY name").all();
  const fks = db.prepare('PRAGMA foreign_key_list(whatsapp_messages)').all();
  database.closeDatabase();
  database.MIGRATIONS.push(migration);
  database.initDatabase();
  db = database.getDatabase();
  assert.equal(database.getCurrentSchemaVersion(), 126);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='whatsapp_messages'").get().seq, 1000);
  const upgraded = db.prepare('SELECT * FROM whatsapp_messages ORDER BY id').all();
  assert.deepEqual(upgraded.map(({inbox_payload_hash, ...row}: any) => row), rows);
  assert.deepEqual(db.prepare('SELECT * FROM whatsapp_message_attempts ORDER BY id').all(), attempts);
  for (const index of indexes) assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE name=?").get(index.name), index);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(whatsapp_messages)').all(), fks);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='inbox_upgrade_probe'").get(), trigger);
  db.prepare("UPDATE whatsapp_messages SET body='updated' WHERE id=2").run();
  assert.equal(db.prepare('SELECT message_id FROM inbox_upgrade_trigger_probe').get().message_id, 2);
  assert.throws(() => db.prepare("INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,bill_id) VALUES ('+14155552671','inbound','user_message','queued','invalid reference',999999)").run(), /FOREIGN KEY/);
  for (const kind of ['user_message','bot_reply','agent_reply']) db.prepare(`INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id) VALUES ('+14155552671','inbound',?,'queued',?,?)`).run(kind, kind, kind);
  assert.throws(() => db.prepare(`INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id) VALUES ('+14155552671','inbound','user_message','queued','duplicate','user_message')`).run(), /UNIQUE/);
  db.prepare('DELETE FROM whatsapp_messages WHERE id=1').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_message_attempts WHERE message_id=1').get().n, 0);
  console.log('Upgrade v125 -> v126: 5 legacy kinds and attempts preserved; indexes, FKs, cascade and unique constraint passed');
} finally {
  if (!database.MIGRATIONS.includes(migration)) database.MIGRATIONS.push(migration);
  database.closeDatabase();
  fs.rmSync(testDir, {recursive:true,force:true});
}
