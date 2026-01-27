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

    -- NEW: Sources (Knowledge Base)
    CREATE TABLE IF NOT EXISTS sources (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      brand_key TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled BOOLEAN DEFAULT true,
      status TEXT DEFAULT 'idle', -- idle, indexing, error
      last_indexed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS source_chunks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
      brand_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS source_embeddings (
      chunk_id UUID REFERENCES source_chunks(id) ON DELETE CASCADE,
      brand_key TEXT NOT NULL,
      embedding JSONB NOT NULL,
      PRIMARY KEY (chunk_id)
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

/* ================== SOURCES HELPERS ================== */

export async function getSources(brandKey) {
  const res = await pool.query(
    `SELECT s.*, COUNT(sc.id)::int as chunk_count
     FROM sources s
     LEFT JOIN source_chunks sc ON s.id = sc.source_id
     WHERE s.brand_key = $1
     GROUP BY s.id
     ORDER BY s.created_at DESC`,
    [brandKey]
  );
  return res.rows;
}

export async function addSource({ brandKey, url }) {
  const res = await pool.query(
    `INSERT INTO sources (brand_key, url) VALUES ($1, $2) RETURNING *`,
    [brandKey, url]
  );
  return res.rows[0];
}

export async function updateSourceStatus(id, { status, lastError, indexed }) {
  let q = `UPDATE sources SET status = $1, last_error = $2, updated_at = NOW()`;
  const vals = [status, lastError || null];
  let idx = 3;

  if (indexed) {
    q += `, last_indexed_at = NOW()`;
  }

  q += ` WHERE id = $${idx} RETURNING *`;
  vals.push(id);

  const res = await pool.query(q, vals);
  return res.rows[0];
}

export async function toggleSource(id, enabled) {
  const res = await pool.query(
    `UPDATE sources SET enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [enabled, id]
  );
  return res.rows[0];
}

export async function deleteSource(id) {
  await pool.query(`DELETE FROM sources WHERE id = $1`, [id]);
}

export async function getSourceById(id) {
  const res = await pool.query(`SELECT * FROM sources WHERE id = $1`, [id]);
  return res.rows[0];
}


/* ================== CHUNKS & EMBEDDINGS HELPERS ================== */

export async function clearSourceChunks(sourceId) {
  // cascade deletes embeddings too
  await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [sourceId]);
}

export async function saveSourceChunks(sourceId, brandKey, chunksWithEmbeddings) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let i = 0; i < chunksWithEmbeddings.length; i++) {
      const item = chunksWithEmbeddings[i];
      // 1) insert chunk
      const chunkRes = await client.query(
        `INSERT INTO source_chunks (source_id, brand_key, chunk_index, content)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id`,
        [sourceId, brandKey, i, item.text]
      );
      const chunkId = chunkRes.rows[0].id;

      // 2) insert embedding (jsonb)
      await client.query(
        `INSERT INTO source_embeddings (chunk_id, brand_key, embedding)
                 VALUES ($1, $2, $3)`,
        [chunkId, brandKey, JSON.stringify(item.embedding)]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Simple Cosine Similarity in JS (for MVP)
// Fetch all embeddings for brand -> compute distance -> sort
// Optimization: If rows > 10k, this will be slow. For <10k it's fine.
export async function searchVectors(brandKey, queryVec, limit = 5) {
  // 1) Fetch all embeddings for this brand (TODO: cache or use pgvector later)
  const q = `
        SELECT se.chunk_id, se.embedding, sc.content, s.url
        FROM source_embeddings se
        JOIN source_chunks sc ON se.chunk_id = sc.id
        JOIN sources s ON sc.source_id = s.id
        WHERE se.brand_key = $1 AND s.enabled = true
    `;
  const res = await pool.query(q, [brandKey]);
  const candidates = res.rows;

  if (!candidates.length) return [];

  // 2) Compute Cosine Similarity
  const results = candidates.map(row => {
    const vec = row.embedding; // JSONB parsed automatically by pg driver
    const score = cosineSimilarity(queryVec, vec);
    return { ...row, score };
  });

  // 3) Sort & Limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

/* ================== ANALYTICS (DASHBOARD) ================== */
export async function getDashboardStats(brandKey) {
  const client = await pool.connect();
  try {
    // 1) Total Conversations (All time)
    // 2) New Conversations (Last 7 days)
    // 3) Total Handoffs (Leads)
    // 4) Messages Count

    // Filtre: brandKey varsa sadece o marka, yoksa hepsi
    const brandFilter = brandKey ? `WHERE brand_key = $1` : `WHERE 1=1`;
    const brandParams = brandKey ? [brandKey] : [];

    const totalConvsRes = await client.query(
      `SELECT COUNT(*) FROM conversations ${brandFilter}`,
      brandParams
    );
    const totalConvs = parseInt(totalConvsRes.rows[0].count, 10);

    const newConvsRes = await client.query(
      `SELECT COUNT(*) FROM conversations 
       ${brandFilter} 
       ${brandKey ? 'AND' : 'WHERE'} created_at > NOW() - INTERVAL '7 days'`,
      brandParams
    );
    const newConvs = parseInt(newConvsRes.rows[0].count, 10);

    // Handoff count from messages
    // messages tablosunda brand_key yok -> join gerekli
    // "m.handoff_kind IS NOT NULL" -> bu bir lead
    const handoffFilter = brandKey
      ? `WHERE c.brand_key = $1 AND m.handoff_kind IS NOT NULL`
      : `WHERE m.handoff_kind IS NOT NULL`;

    const totalHandoffsRes = await client.query(
      `SELECT COUNT(*) FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       ${handoffFilter}`,
      brandParams
    );
    const totalHandoffs = parseInt(totalHandoffsRes.rows[0].count, 10);

    // Conversion Rate (Handoffs / Total Convs)
    const conversionRate = totalConvs > 0
      ? ((totalHandoffs / totalConvs) * 100).toFixed(1)
      : "0";

    // Daily breakdown (Last 7 days) for chart
    // date_trunc('day', created_at)
    const chartRes = await client.query(`
      SELECT TO_CHAR(date_trunc('day', created_at), 'YYYY-MM-DD') as day, COUNT(*) as count
      FROM conversations 
      ${brandFilter}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 7
    `, brandParams);

    // Chart verisini ters çevir (eskiden yeniye)
    const chartData = chartRes.rows.reverse();

    return {
      totalConvs,
      newConvs, // last 7 days
      totalHandoffs,
      conversionRate,
      chartData
    };

  } finally {
    client.release();
  }
}
