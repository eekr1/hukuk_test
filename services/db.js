import pkg from "pg";
const { Pool } = pkg;
import { DATABASE_URL } from "../config/env.js";

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false } // Render gibi managed DB'lerde güvenli
    : false,
});

export async function ensureTables() {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL yok — loglama devre dışı.");
    return;
  }

  try {
    // 1) Tabloları oluştur (kolonlar burada olsa da olur; ama minimal tutup garantiye alıyoruz)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        thread_id TEXT UNIQUE NOT NULL,
        brand_key TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        last_message_at TIMESTAMPTZ DEFAULT now()
      );

     CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT,
  raw_text TEXT,
  handoff_kind TEXT,
  handoff_payload JSONB,
  meta JSONB,
  meeting_mode TEXT,
  meeting_date TEXT,
  meeting_time TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

    `);

    // 2) Kolonları garanti et (idempotent migration)
    await pool.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS visitor_id TEXT,
        ADD COLUMN IF NOT EXISTS session_id TEXT,
        ADD COLUMN IF NOT EXISTS source JSONB;

      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS meta JSONB,
        ADD COLUMN IF NOT EXISTS meeting_mode TEXT,
        ADD COLUMN IF NOT EXISTS meeting_date TEXT,
        ADD COLUMN IF NOT EXISTS meeting_time TEXT,
        ADD COLUMN IF NOT EXISTS admin_status TEXT DEFAULT 'NEW',
        ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    `);

    // 3) Index’leri garanti et (kolonlar artık kesin var)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_thread_id
        ON conversations(thread_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_brand_key
        ON conversations(brand_key);

      CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id
        ON conversations(visitor_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_session_id
        ON conversations(session_id);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
        ON messages(conversation_id);
    `);

    console.log("[db] tablo kontrolü / migration / index tamam ✅");
  } catch (e) {
    console.error("[db] ensureTables hata:", e);
  }
}

export async function logChatMessage({
  brandKey,
  threadId,
  role,
  text,
  rawText,
  handoff,
  visitorId,
  sessionId,
  source,
  meta
}) {
  if (!DATABASE_URL) return;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1) Konuşmayı upsert et (thread_id unique)
      // ✅ NEW: visitor/session bilgileri varsa conversations'a yaz / güncelle
      const convRes = await client.query(
        `
  INSERT INTO conversations (thread_id, brand_key, visitor_id, session_id, source, created_at, last_message_at)
  VALUES ($1, $2, $3, $4, $5, now(), now())
  ON CONFLICT (thread_id)
  DO UPDATE SET
    brand_key = EXCLUDED.brand_key,
    last_message_at = now(),
    visitor_id = COALESCE(conversations.visitor_id, EXCLUDED.visitor_id),
    session_id = COALESCE(conversations.session_id, EXCLUDED.session_id),
    source = COALESCE(conversations.source, EXCLUDED.source)
  RETURNING id
  `,
        [threadId, brandKey || null, visitorId || null, sessionId || null, source ? JSON.stringify(source) : null]
      );


      const conversationId = convRes.rows[0].id;

      // Extract meeting details if available
      const pm = handoff?.payload?.preferred_meeting || {};
      const meetingMode = pm.mode || null;
      const meetingDate = pm.date || null;
      const meetingTime = pm.time || null;

      // 2) Mesajı ekle
      await client.query(
        `
  INSERT INTO messages
    (conversation_id, role, text, raw_text, handoff_kind, handoff_payload, meta, meeting_mode, meeting_date, meeting_time, created_at)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
  `,
        [
          conversationId,
          role,
          text || null,
          rawText || null,
          handoff ? handoff.kind || null : null,
          handoff ? JSON.stringify(handoff.payload || null) : null,
          meta ? JSON.stringify(meta) : null,
          meetingMode,
          meetingDate,
          meetingTime
        ]
      );


      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[db] logChatMessage transaction error:", e);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[db] connection error:", e);
  }
}
