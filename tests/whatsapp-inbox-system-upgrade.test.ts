import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inbox-system-upgrade-'));
Module._load = function (name: string) {
  if (name === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.NODE_ENV = 'test';
const database = require('../main/db');
const migration = database.MIGRATIONS.pop();
try {
  assert.equal(migration.version, 127);
  database.initDatabase();
  let db = database.getDatabase();
  assert.equal(database.getCurrentSchemaVersion(), 126);
  db.prepare("INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id,inbox_payload_hash) VALUES ('+14155552671','inbound','user_message','queued','previous message','previous-id','previous-hash')").run();
  const previousId = db.prepare("SELECT id FROM whatsapp_messages WHERE external_message_id = 'previous-id'").get().id;
  const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='whatsapp_messages'").get().sql;
  const oldIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_whatsapp_messages_inbox_external'").get().sql;
  db.prepare("INSERT INTO whatsapp_message_attempts (message_id,external_message_id,created_at) VALUES (?,'previous-attempt','2026-01-01 00:00:00')").run(previousId);
  db.exec('CREATE TABLE inbox_system_trigger_probe (message_id INTEGER); CREATE TRIGGER inbox_system_probe AFTER UPDATE ON whatsapp_messages BEGIN INSERT INTO inbox_system_trigger_probe VALUES (NEW.id); END;');
  const before = db.prepare('SELECT * FROM whatsapp_messages').all();
  database.closeDatabase();
  database.MIGRATIONS.push(migration);
  database.initDatabase();
  db = database.getDatabase();
  assert.equal(database.getCurrentSchemaVersion(), 127);
  assert.deepEqual(db.prepare('SELECT * FROM whatsapp_messages').all(), before);
  assert.equal(db.prepare("SELECT message_id FROM whatsapp_message_attempts WHERE external_message_id = 'previous-attempt'").get().message_id, previousId);
  db.prepare("UPDATE whatsapp_messages SET body = 'after upgrade' WHERE id = ?").run(previousId);
  assert.equal(db.prepare('SELECT message_id FROM inbox_system_trigger_probe').get().message_id, previousId);
  db.prepare("INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id) VALUES ('+14155552671','inbound','system','queued','request','system-id')").run();
  assert.throws(() => db.prepare("INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body,external_message_id) VALUES ('+14155552671','inbound','system','queued','repeat','system-id')").run(), /UNIQUE/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // Each in-memory database starts at the real v126 schema, without touching a live store.
  const Sqlite = require('better-sqlite3');
  const { migrateWhatsAppInboxSystem } = require('../main/whatsapp-inbox-migration');
  for (const [retained, high] of [[false, 900], [true, 1000]] as const) {
    const fixture = new Sqlite(':memory:');
    try {
      fixture.exec(`${oldSchema}; ${oldIndex}; CREATE TABLE whatsapp_message_attempts (id INTEGER PRIMARY KEY, message_id INTEGER, external_message_id TEXT, created_at TEXT);`);
      for (const reference of fixture.prepare('PRAGMA foreign_key_list(whatsapp_messages)').all() as { table: string; to: string }[]) {
        fixture.exec(`CREATE TABLE IF NOT EXISTS "${reference.table}" ("${reference.to}" INTEGER PRIMARY KEY)`);
      }
      if (retained) fixture.prepare("INSERT INTO whatsapp_messages (id,phone_e164,direction,kind,status,body) VALUES (2,'+14155552671','inbound','user_message','queued','retained')").run();
      fixture.prepare("INSERT INTO whatsapp_messages (id,phone_e164,direction,kind,status,body) VALUES (?,'+14155552671','inbound','user_message','queued','deleted')").run(high);
      fixture.prepare('DELETE FROM whatsapp_messages WHERE id = ?').run(high);
      assert.equal(fixture.prepare("SELECT seq FROM sqlite_sequence WHERE name='whatsapp_messages'").get().seq, high);
      // Emulate an absent sqlite_sequence entry at the restore boundary (SQLite versions
      // may create a zero entry even for an empty INSERT ... SELECT).
      const migrationDb = retained ? fixture : {
        prepare: fixture.prepare.bind(fixture),
        exec: (sql: string) => {
          fixture.exec(sql);
          if (sql.includes('ALTER TABLE whatsapp_messages_system RENAME')) {
            fixture.prepare("DELETE FROM sqlite_sequence WHERE name='whatsapp_messages'").run();
          }
        },
      };
      migrateWhatsAppInboxSystem(migrationDb);
      assert.equal(fixture.prepare("SELECT seq FROM sqlite_sequence WHERE name='whatsapp_messages'").get().seq, high);
      const next = fixture.prepare("INSERT INTO whatsapp_messages (phone_e164,direction,kind,status,body) VALUES ('+14155552671','inbound','system','queued','new')").run().lastInsertRowid;
      assert.equal(next, high + 1);
      assert.deepEqual(fixture.prepare('SELECT id FROM whatsapp_messages ORDER BY id').all().map((row: any) => row.id), retained ? [2, high + 1] : [high + 1]);
    } finally {
      fixture.close();
    }
  }
  console.log('Upgrade v126 -> v127: rows, gap, empty sequence, system kind and unique ID preserved');
} finally {
  if (!database.MIGRATIONS.includes(migration)) database.MIGRATIONS.push(migration);
  database.closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}
