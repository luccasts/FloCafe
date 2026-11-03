import type Database from 'better-sqlite3';

export function migrateWhatsAppInbox(db: Database.Database): void {
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'whatsapp_messages'").get() as { seq: number } | undefined;
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_messages'").get() as { sql: string };
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'whatsapp_messages' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as { sql: string }[];
  const sql = schema.sql.replace(/CREATE TABLE\s+"?whatsapp_messages"?/i, 'CREATE TABLE whatsapp_messages_inbox')
    .replace("'daily_sales_report'))", "'daily_sales_report','user_message','bot_reply','agent_reply'))");
  if (sql === schema.sql || !sql.includes("'agent_reply'")) throw new Error('Unexpected WhatsApp schema');
  db.exec(`CREATE TEMP TABLE inbox_attempts_backup AS SELECT * FROM whatsapp_message_attempts;
    ${sql};
    INSERT INTO whatsapp_messages_inbox SELECT * FROM whatsapp_messages;
    DROP TABLE whatsapp_messages;
    ALTER TABLE whatsapp_messages_inbox RENAME TO whatsapp_messages;`);
  if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'whatsapp_messages'").run(sequence.seq);
  for (const index of indexes) db.exec(index.sql);
  db.exec(`INSERT OR IGNORE INTO whatsapp_message_attempts SELECT * FROM inbox_attempts_backup;
    DROP TABLE inbox_attempts_backup;
    ALTER TABLE whatsapp_messages ADD COLUMN inbox_payload_hash TEXT;
    CREATE UNIQUE INDEX idx_whatsapp_messages_inbox_external
    ON whatsapp_messages(phone_e164, direction, external_message_id)
    WHERE kind IN ('user_message','bot_reply','agent_reply');`);
}
