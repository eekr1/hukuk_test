import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;
import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
import crypto from "crypto";


dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false } // Render gibi managed DB'lerde güvenli
    : false,
});


const app = express();
console.log("[boot] node version:", process.version);


/* ==================== Mail Client (Brevo HTTP API) ==================== */
const brevo = new TransactionalEmailsApi();
const apiKey = process.env.BREVO_API_KEY || "";
if (!apiKey) {
  console.warn("[mail] Missing BREVO_API_KEY — set it in environment!");
}
// SDK’nin resmi dokümantasyonundaki doğru yöntem:
// emailAPI.authentications.apiKey.apiKey = "xkeysib-...."
(brevo).authentications.apiKey.apiKey = apiKey;
console.log("[mail] Brevo HTTP API client ready");


function escapeHtml(s = "") {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sendHandoffEmail({ brandKey, brandCfg, kind, payload }) {
  try {
    const brandLabel =
      brandCfg.label ||
      brandCfg.brandName ||
      brandKey;

    const subjectPrefix =
      brandCfg.subject_prefix || `[${brandLabel}]`;

    // Alıcı önceliği
    const to =
      brandCfg.handoffEmailTo ||
      process.env.HANDOFF_TO ||
      brandCfg.email_to ||
      brandCfg.contactEmail;

    if (!to) throw new Error("No recipient found for handoff email (to).");

    // Gönderen (Brevo’da doğrulanmış olmalı)
    const from = brandCfg.noreplyEmail || process.env.EMAIL_FROM;
    const fromName =
      process.env.EMAIL_FROM_NAME || brandCfg.brandName || brandLabel;

    if (!from) {
      throw new Error("No verified sender configured (from). Use brand.noreplyEmail or EMAIL_FROM env.");
    }

    const normalize = (s) => (s || "").toString().trim();

    // ===========
    // SUBJECT
    // ===========
    const summary =
      normalize(payload?.request?.summary) ||
      normalize(payload?.summary) ||
      "";

    const categoryRaw =
      normalize(payload?.matter?.category) ||
      normalize(payload?.category) ||
      "";

    const categoryMap = {
      aile: "Aile Hukuku",
      is: "İş Hukuku",
      ceza: "Ceza Hukuku",
      icra: "İcra / Alacak",
      kira: "Kira / Tahliye",
      tazminat: "Tazminat",
      diger: "Diğer"
    };

    const category = categoryMap[categoryRaw] || categoryRaw;


    const urgency =
      normalize(payload?.matter?.urgency) ||
      normalize(payload?.urgency) ||
      "";

    const intentLabel = summary ? `Hukuk Talebi — ${summary}` : "Hukuk Talebi";
    const tailBits = [category && `Alan: ${category}`, urgency && `Aciliyet: ${urgency}`]
      .filter(Boolean)
      .join(" | ");

    const subject = tailBits
      ? `${subjectPrefix} ${intentLabel} (${tailBits})`
      : `${subjectPrefix} ${intentLabel}`;

    // ===========
    // BODY (KV)
    // ===========
    const kv = [];

    // Contact
    const name = normalize(payload?.contact?.name || payload?.full_name);
    const phone = normalize(payload?.contact?.phone || payload?.phone);
    const email = normalize(payload?.contact?.email || payload?.email);

    if (name) kv.push(["Ad Soyad", name]);
    if (phone) kv.push(["Telefon", phone]);
    if (email) kv.push(["E-posta", email]);

    if (category) kv.push(["Hukuk Alanı", category]);
    if (urgency) kv.push(["Aciliyet", urgency]);

    const eventDate =
      normalize(payload?.dates?.event) ||
      normalize(payload?.event_date) ||
      "";

    const deadline =
      normalize(payload?.dates?.deadline) ||
      normalize(payload?.deadline) ||
      "";

    if (eventDate) kv.push(["Olay Tarihi / Aralık", eventDate]);
    if (deadline) kv.push(["Kritik Tarih / Son Gün", deadline]);

    const meetingMode =
      normalize(payload?.preferred_meeting?.mode) ||
      normalize(payload?.meeting_mode) ||
      "";

    const meetingDate =
      normalize(payload?.preferred_meeting?.date) ||
      normalize(payload?.meeting_date) ||
      "";

    const meetingTime =
      normalize(payload?.preferred_meeting?.time) ||
      normalize(payload?.meeting_time) ||
      "";

    const meetingDateTime =
      normalize(payload?.preferred_meeting?.datetime) ||
      normalize(payload?.meeting_datetime) ||
      "";


    if (meetingMode) kv.push(["Görüşme Tercihi", meetingMode]);

    if (meetingDate || meetingTime || meetingDateTime) {
      if (meetingDate) kv.push(["Görüşme Tarihi", meetingDate]);
      if (meetingTime) kv.push(["Görüşme Saati", meetingTime]);
      if (!meetingDate && !meetingTime && meetingDateTime) {
        kv.push(["Görüşme Tarih/Saat", meetingDateTime]);
      }
    }

    if (summary) kv.push(["Konu (Özet)", summary]);

    const details =
      normalize(payload?.request?.details) ||
      normalize(payload?.details) ||
      "";

    if (details) kv.push(["Açıklama (Detay)", details]);

    const docs = Array.isArray(payload?.documents)
      ? payload.documents.map(x => normalize(x)).filter(Boolean)
      : [];

    if (docs.length) kv.push(["Belgeler", docs.join(", ")]);

    kv.push(["Handoff Türü", normalize(kind) || "customer_request"]);
    kv.push(["Kaynak Marka", brandLabel]);

    // TEXT
    const textLines = [];
    kv.forEach(([k, v]) => textLines.push(`${k}: ${v}`));
    textLines.push("");
    textLines.push("Not: Hassas veriler (TCKN/IBAN/kart/sağlık vb.) bu kanaldan istenmez/paylaşılmamalıdır.");
    const textBody = textLines.join("\n");

    // HTML
    const htmlRows = kv
      .map(([k, v]) => `<tr>
        <td style="padding:6px 10px;border:1px solid #eee;font-weight:600;white-space:nowrap;">${escapeHtml(String(k))}</td>
        <td style="padding:6px 10px;border:1px solid #eee;">${escapeHtml(String(v || ""))}</td>
      </tr>`)
      .join("");

    const htmlBody = `
      <div style="font-family:system-ui, -apple-system, 'Segoe UI', Roboto, Arial; line-height:1.5; color:#111;">
        <table style="border-collapse:collapse;border:1px solid #eee;min-width:420px;">${htmlRows}</table>
        <p style="margin:10px 0 0 0; color:#777;font-size:12px;">
          Not: Hassas veriler (TCKN/IBAN/kart/sağlık vb.) bu kanaldan istenmez/paylaşılmamalıdır.
        </p>
      </div>
    `;

    // Brevo
    const toList = to.split(",").map(e => ({ email: e.trim() })).filter(x => x.email);

    const rawReplyTo =
      payload?.contact?.email ||
      payload?.email ||
      process.env.REPLY_TO ||
      null;

    const replyToEmail = (rawReplyTo || "").toString().trim();
    const isReplyToValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail);

    const emailObj = new SendSmtpEmail();
    emailObj.sender = { email: from, name: fromName };
    emailObj.to = toList;
    emailObj.subject = subject;
    emailObj.htmlContent = htmlBody;
    emailObj.textContent = textBody;

    if (isReplyToValid) {
      emailObj.replyTo = { email: replyToEmail };
      emailObj.headers = { ...(emailObj.headers || {}), "Reply-To": replyToEmail };
    }

    console.log("[handoff] sendHandoffEmail", { kind, to, from, subject });

    const resp = await brevo.sendTransacEmail(emailObj);
    const data = await readIncomingMessageJSON(resp);
    const msgId = data?.messageId || data?.messageIds?.[0] || null;

    console.log("[handoff] sendHandoffEmail OK", { messageId: msgId });
    return { ok: true, messageId: msgId };
  } catch (err) {
    console.error("[handoff] sendHandoffEmail ERROR", err);
    return { ok: false, error: String(err?.message || err) };
  }
}






async function readIncomingMessageJSON(resp) {
  // Brevo SDK bazı ortamlarda node:http IncomingMessage döndürüyor
  // (resp.response yerine doğrudan resp de gelebilir)
  const msg = resp?.response || resp;
  if (!msg || typeof msg.on !== "function") return null;

  const chunks = [];
  for await (const chunk of msg) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
/* ==================== Google Sheets Webhook (Apps Script) ==================== */
async function pushHandoffToSheets(row) {
  const url = (process.env.SHEETS_WEBHOOK_URL || "").trim();
  if (!url) return { ok: false, skipped: true, reason: "SHEETS_WEBHOOK_URL missing" };

  const secret = (process.env.SHEETS_WEBHOOK_SECRET || "").trim();

  // Timeout (Render’da takılmasın)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-webhook-secret": secret } : {}),
      },
      body: JSON.stringify(row),
      signal: ctrl.signal,
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.warn("[sheets] webhook non-2xx:", resp.status, text.slice(0, 300));
      return { ok: false, status: resp.status, body: text };
    }

    console.log("[sheets] pushed ✅");
    return { ok: true, status: resp.status, body: text };
  } catch (e) {
    console.warn("[sheets] push failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}



/* ==================== App Middleware ==================== */
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Basit request log
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Health + Static
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static("public"));
app.get("/", (_req, res) => res.redirect("/test.html"));

/* ==================== Brand Config (accept both BRAND_JSON & BRANDS_JSON) ==================== */
let BRANDS = {};
try {
  const raw = process.env.BRAND_JSON || process.env.BRANDS_JSON || "{}";
  BRANDS = JSON.parse(raw);
} catch (e) {
  console.warn("[brand] JSON parse error:", e?.message || e);
}
console.log("[brand] keys:", Object.keys(BRANDS || {}));


/* ==================== OpenAI Config ==================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const PORT = process.env.PORT || 8787;

const hasAnyBrandAssistant = Object.values(BRANDS || {}).some(
  b => b && b.assistant_id
);
if (!OPENAI_API_KEY || (!ASSISTANT_ID && !hasAnyBrandAssistant)) {
  console.error("Missing OPENAI_API_KEY and no assistant_id found (global or brand).");
  process.exit(1);
}




// Bilinmeyen key'i reddet (whitelist)
function getBrandConfig(brandKey) {
  if (!brandKey) return null;
  const cfg = BRANDS[brandKey];
  return cfg || null;
}

// === Brand run talimatÄ± (instructions) Ã¼retici ===
function buildRunInstructions(brandKey, brandCfg = {}) {
  const label =
    brandCfg.label ||
    brandCfg.brandName ||
    brandCfg.subject_prefix?.replace(/[\[\]]/g, "") ||
    brandKey;

  const city = brandCfg?.office?.city || "Türkiye";
  const practiceAreas = Array.isArray(brandCfg?.practiceAreas) && brandCfg.practiceAreas.length
    ? brandCfg.practiceAreas.join(", ")
    : "Aile, Ceza, İş, İcra/İflas, Gayrimenkul/Kira, Tazminat";

  return [
    `ROLE / KİMLİK`,
    `- You are the official digital pre-intake and information assistant for "${label}" (a law office in ${city}).`,
    `- Your job is to: (1) understand the user’s legal topic, (2) provide general information only, (3) collect minimum pre-intake details, (4) prepare a handoff request for the legal team when needed.`,
    ``,

    `LANGUAGE & TONE`,
    `- Language: Turkish.`,
    `- Tone: professional, calm, clear. No slang. Avoid emojis (use none unless absolutely necessary).`,
    `- Keep answers concise: 3–10 lines when possible. Use bullet points for clarity.`,
    ``,

    `SCOPE (WHAT YOU CAN / CAN'T DO)`,
    `- You are NOT a lawyer and you do NOT provide legal advice. You provide GENERAL INFORMATION only.`,
    `- Do NOT promise outcomes, do NOT guarantee results, do NOT say "kesin", "garanti", "kazanırsınız".`,
    `- Do NOT provide tactics/strategy (e.g., "şöyle ifade ver", "şunu söyle", "delili böyle kurgula", "dilekçe yaz").`,
    `- If the user asks for strategy, a definitive legal opinion, exact deadlines, or fees: explain it requires lawyer review and offer to forward the request (handoff).`,
    ``,

    `SAFETY / KVKK / PRIVACY`,
    `- Never ask the user to share sensitive personal data in chat: T.C. kimlik no, IBAN, card info, medical records details, children’s sensitive identifiers, etc.`,
    `- If user starts sharing sensitive data: warn them to stop and say it should be shared securely during the attorney meeting.`,
    `- Do not request unnecessary details about third parties.`,
    ``,

    `RAG / KNOWLEDGE BASE RULES`,
    `- If a knowledge base/policies/SSS document exists, use it as the source of truth.`,
    `- If you do not have a reliable source for a specific claim, do NOT invent it. Say you need attorney review.`,
    `- Prefer: "Genelde süreç şu şekildedir..." + "Sizin dosyanız için avukat değerlendirmesi gerekir."`,
    ` Working hours: Weekdays 09:00–18:00 Initial consultation: By appointment only Online consultation: Possible in suitable cases`,


    ``,

    `PRACTICE AREAS (CLASSIFY THE TOPIC)`,
    `- Classify the case into one primary area (or "Diğer"):`,
    `  • Aile Hukuku (boşanma, velayet, nafaka, mal rejimi)`,
    `  • Ceza Hukuku (soruşturma, ifade, kovuşturma, duruşma süreci)`,
    `  • İş Hukuku (işe iade, kıdem/ihbar, alacaklar)`,
    `  • İcra/İflas (takip, itiraz, haciz)`,
    `  • Gayrimenkul & Kira (tahliye, kira tespiti, tapu/ortaklık)`,
    `  • Tazminat (trafik kazası, maddi/manevi tazminat)`,
    `  • Diğer (miras, ticaret, idare/vergi, KVKK vb.)`,
    `- If unclear: ask 1–2 clarifying questions to classify.`,
    `- Note: Office focus areas: ${practiceAreas}.`,
    ``,

    `GENERAL INFORMATION STYLE (VERY IMPORTANT)`,
    `- Provide general process outlines, common documents, and next steps.`,
    `- Avoid strict deadlines or exact durations; say they vary and attorney must confirm.`,
    `- Always end with a next-step option: "İsterseniz ön görüşme talebi oluşturup ekibe iletebilirim."`,
    ``,

    `APPOINTMENT / HANDOFF FLOW (VERY IMPORTANT)

If the user asks for an appointment, attorney contact, or says "randevu istiyorum":

Ask for these items (you can ask in 1 or 2 steps to be natural):
- Ad Soyad
- Telefon numarası
- Kısa konu özeti (1–2 cümle)
- Görüşme tercihi (Online / Yüz Yüze)
- Uygun zaman (Tarih ve Saat önerisi)

Optional:
- Şehir / ilçe

Do NOT ask for:
- Legal specific deadline dates (hak düşürücü süreler)
- Documents (unless user offers)
- Detailed timelines
- Category selection lists

If the user provides name + phone + short summary + meeting preferences:
This counts as implicit consent to forward the request.
Do NOT ask for confirmation or approval.
Immediately prepare and send the handoff.

After sending the handoff:
Respond with a short confirmation message like:
"Talebinizi ekibe ilettim. Ekibimiz en kısa sürede sizinle iletişime geçecektir."

Never say:
- Onay verirseniz
- Onaylıyor musunuz
- İletmemi ister misiniz `,

    `
HANDOFF PROTOCOL (SINGLE UNIVERSAL REQUEST)

Produce a handoff when:
-The user requests an appointment or attorney contact, AND
-The user has provided name, phone, summary, AND meeting preferences (mode/time).

Once these details are collected, this is considered consent.
Do NOT ask for additional confirmation or approval.
`,
    `Handoff Format (MUST match exactly):`,
    `  \\\`\\\`\\\`handoff`,
    `  {`,
    `    "handoff": "customer_request",`,
    `    "payload": {`,
    `      "contact": { "name": "<Ad Soyad>", "phone": "<+905xx...>", "email": "<varsa@eposta>" },`,
    `      "preferred_meeting": { "mode": "<online|yüz yüze>", "date": "<gün ay yıl>", "time": "<saat>" },`,
    `      "matter": { "category": "<aile|ceza|is|icra|kira|tazminat|diger>", "urgency": "<acil|normal>" },`,
    `      "request": {`,
    `        "summary": "<tek satır konu özeti>",`,
    `        "details": "<3-8 cümle olay özeti + ek detaylar>"`,
    `      }`,
    `    }`,
    `  }`,
    `  \\\`\\\`\\\``,
    ``,

    `FORBIDDEN`,
    `- No guarantees. No legal strategy/tactics. No drafting petitions.`,
    `- No requesting sensitive data (TCKN/IBAN/card/medical etc.).`,
    `- No claiming you booked an appointment; you only forward a request.`,
  ].join("\n");
}





/* ==================== Helpers ==================== */
async function openAI(path, { method = "GET", body } = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI ${method} ${path} ${res.status}: ${errText}`);
  }
  return res.json();
}





// aynı payload'ı kısa sürede tekrar maillemeyi engelle
const recentHandoffs = new Map(); // threadId -> { hash, ts }

function isDuplicateHandoff(threadId, payload) {
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(payload || {}))
    .digest("hex");

  const now = Date.now();
  const prev = recentHandoffs.get(threadId);

  if (prev && prev.hash === hash && (now - prev.ts) < 5 * 60 * 1000) {
    return true;
  }

  recentHandoffs.set(threadId, { hash, ts: now });
  return false;
}

function hasMinimumHandoffData(cleanPayload = {}) {
  const name = String(cleanPayload?.contact?.name || "").trim();

  // normalizeHandoffPayload zaten digits üretiyor olabilir; yoksa raw’dan da yakala
  const phoneDigits =
    String(cleanPayload?.contact?.phoneDigits || "").trim() ||
    String(cleanPayload?.contact?.phone || "").replace(/\D/g, "").trim();

  const summary = String(cleanPayload?.request?.summary || cleanPayload?.summary || "").trim();
  const details = String(cleanPayload?.request?.details || cleanPayload?.details || "").trim();

  const hasName = name.length >= 2;
  const hasPhone = phoneDigits.length >= 10; // TR için pratik eşik
  const hasText = (summary.length >= 3) || (details.length >= 3);

  // 🔹 Yeni zorunlu alanlar: Görüşme modu + tarih & saat
  const modeRaw =
    String(cleanPayload?.preferred_meeting?.mode || cleanPayload?.meeting_mode || "")
      .trim()
      .toLowerCase();

  const dateRaw =
    String(
      cleanPayload?.preferred_meeting?.date ||
      cleanPayload?.meeting_date ||
      cleanPayload?.preferred_meeting?.datetime ||
      cleanPayload?.meeting_datetime ||
      ""
    ).trim();

  const timeRaw =
    String(
      cleanPayload?.preferred_meeting?.time ||
      cleanPayload?.meeting_time ||
      ""
    ).trim();

  const hasMode = !!modeRaw; // "online", "yüz yüze", "yuz_yuze" vs. metin olarak
  const hasDateTime =
    (!!dateRaw && !!timeRaw) || // ayrı alanlar doluysa
    (!!dateRaw && !timeRaw && dateRaw.includes(" ")); // "2025-01-10 14:30" gibi tek string’se

  return hasName && hasPhone && hasText && hasMode && hasDateTime;
}




function userProvidedContactInfo(userText = "") {
  const t = String(userText || "");
  // telefon var mı?
  const hasPhone = /(\+?\d[\d\s().-]{9,}\d)/.test(t);
  // isim ipucu var mı?
  const hasName =
    /ad\s*soyad\s*[:\-]/i.test(t) ||
    /iletişim\s*:\s*[^\n,]+\s*,/i.test(t) ||
    /benim\s+adım|adım|isim|ismim/i.test(t);

  return hasPhone && hasName;
}

function assistantIndicatesSending(assistantText = "") {
  const t = String(assistantText || "").toLowerCase();
  // “iletiyorum / ileteceğim / talebiniz iletildi” = gönderiyor demek
  return /(iletiyorum|ileteceğim|ekibe iletiyorum|ekibe ileteceğim|talebiniz iletildi|talebinizi ilettim|iletilmiştir|ilettim)/i.test(t);
}

// Assistant yanıtından handoff JSON çıkar

// --- Metinden handoff çıkarımı (fallback - sade & güvenli) ---
// Model handoff bloğu üretmediyse, metinden name/phone/summary üretir.
// NOT: Bu fallback, asistanın "form soruları" veya "onay sorusu" çıktılarında çalışmaz.
function inferHandoffFromText(text) {
  if (!text) return null;

  // Explicit handoff varsa fallback çalışmasın
  if (/```[\s\S]*"handoff"\s*:/.test(text)) return null;

  // Asistanın kendi form/soru/özet şablonlarında tetikleme (bunlar handoff değildir)
  const isAssistantFormAsk =
    /lütfen.*(aşağıdaki|bilgileri).*paylaşır mısınız/i.test(text) ||
    /1\.\s*ad[ıi]\s*soyad/i.test(text) ||
    /2\.\s*telefon/i.test(text) ||
    /3\.\s*e-?posta/i.test(text) ||
    /aşağıdaki bilgileri paylaşabilir misiniz/i.test(text);

  const isAssistantConfirm =
    /onay verirseniz|onaylıyor musunuz|iletmemi ister misiniz|iletebilirim/i.test(text);

  if (isAssistantFormAsk || isAssistantConfirm) return null;

  // Telefon / Email yakala (en az biri yoksa handoff üretme)
  const phoneMatch = text.match(/(\+?\d[\d\s().-]{9,}\d)/);
  const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);

  if (!phoneMatch && !emailMatch) return null;

  const phone = phoneMatch ? phoneMatch[1].trim() : undefined;
  const email = emailMatch ? emailMatch[0].trim() : undefined;

  // ✅ NAME yakalama (senin örnekte "İletişim: Enis Kuru, 0546..." geçiyor)
  let name = undefined;

  // 1) "İletişim: Ad Soyad, 05xx" formatı
  const mContactLine = text.match(/İletişim\s*:\s*([^\n,]+)\s*,\s*(\+?\d[\d\s().-]{9,}\d)/i);
  if (mContactLine?.[1]) name = mContactLine[1].trim();

  // 2) "Ad Soyad: ..." formatı
  if (!name) {
    const mName = text.match(/ad\s*soyad\s*[:\-]\s*([^\n,]+)/i);
    if (mName?.[1]) name = mName[1].trim();
  }

  // 3) "Adım/İsim ..." formatı (son çare)
  if (!name) {
    const mName2 = text.match(/(?:benim\s+adım|adım|isim|ismim)\s*[:\-]?\s*([^\n,]+)/i);
    if (mName2?.[1]) name = mName2[1].trim();
  }

  // ✅ CATEGORY sinyali
  const lower = text.toLowerCase();
  let category = "diger";
  if (/boşan|velayet|nafaka|mal rejimi/.test(lower)) category = "aile";
  else if (/işten|kıdem|ihbar|fazla mesai|mobbing|işe iade/.test(lower)) category = "is";
  else if (/icra|haciz|takip|tebligat|ödeme emri/.test(lower)) category = "icra";
  else if (/kira|tahliye|kiracı|ev sahibi|kontrat/.test(lower)) category = "kira";
  else if (/tazminat|trafik kazası|maddi|manevi/.test(lower)) category = "tazminat";
  else if (/ceza|savcılık|ifade|duruşma|şikayet/.test(lower)) category = "ceza";

  const urgency = /acil|bugün|yarın|son gün|tebligat|ifade|duruşma/i.test(text) ? "acil" : "normal";

  // ✅ SUMMARY: "Olay Özeti:" satırını yakala; yoksa ilk anlamlı cümle
  let summary = "";
  const mOlay = text.match(/Olay\s*Özeti\s*:\s*([^\n]+)/i);
  if (mOlay?.[1]) summary = mOlay[1].trim();

  if (!summary) {
    const firstMeaningful = text
      .split("\n")
      .map(x => x.trim())
      .find(x =>
        x &&
        !x.startsWith("-") &&
        !/hukuk dalı|kritik tarih|belge|şehir|iletişim|görüşme tercihi/i.test(x.toLowerCase())
      );
    summary = firstMeaningful ? firstMeaningful.slice(0, 160) : "";
  }

  if (!summary) summary = "Hukuk Talebi";

  return {
    kind: "customer_request",
    payload: {
      contact: { name, phone, email },
      matter: { category, urgency },
      request: {
        summary,
        details: text.length > 4000 ? text.slice(-4000) : text
      }
    }
  };
}

function extractHandoff(text = "") {
  try {
    if (!text || typeof text !== "string") return null;

    // 0) TÜM fenced blokları tara: ``` ... ```
    // Model bazen ```handoff etiketi koymadan JSON basar.
    const blocks = text.match(/```[\s\S]*?```/g) || [];
    for (const block of blocks) {
      const inner = block
        .replace(/^```[a-zA-Z0-9_-]*\s*/m, "")
        .replace(/```$/m, "")
        .trim();

      if (!inner) continue;
      if (!/"handoff"\s*:|handoff\s*:/i.test(inner)) continue;

      try {
        const obj = JSON.parse(inner);

        const handoffVal = obj.handoff || obj.kind || obj.type || "customer_request";
        const kind =
          (handoffVal === "reservation" || handoffVal === "reservation_request")
            ? "customer_request"
            : handoffVal;

        const payload = obj.payload ? obj.payload : obj;
        return { kind, payload };
      } catch (_) {
        // parse olmadıysa sonraki fence'e bak
      }
    }

    // 1) ```handoff ... ``` fenced block (eski kural; yine dursun)
    const fence = text.match(/```handoff\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      const raw = fence[1].trim();
      let obj = null;
      try { obj = JSON.parse(raw); } catch (_) { }

      if (obj && typeof obj === "object") {
        const handoffVal = obj.handoff || obj.kind || obj.type || null;
        const kind =
          (handoffVal === "reservation" || handoffVal === "reservation_request")
            ? "customer_request"
            : (handoffVal || "customer_request");

        const payload = obj.payload ? obj.payload : obj;
        return { kind, payload };
      }
    }

    // 2) <handoff>{...}</handoff>
    const tag = text.match(/<handoff>\s*([\s\S]*?)\s*<\/handoff>/i);
    if (tag?.[1]) {
      const obj = JSON.parse(tag[1].trim());
      const handoffVal = obj.handoff || obj.kind || obj.type || "customer_request";
      const kind =
        (handoffVal === "reservation" || handoffVal === "reservation_request")
          ? "customer_request"
          : handoffVal;

      const payload = obj.payload ? obj.payload : obj;
      return { kind, payload };
    }

    // 3) [[HANDOFF: base64]]...[[/HANDOFF]]
    const b64 = text.match(/\[\[HANDOFF:\s*base64\]\]\s*([\s\S]*?)\s*\[\[\/HANDOFF\]\]/i);
    if (b64?.[1]) {
      const decoded = Buffer.from(b64[1].trim(), "base64").toString("utf8");
      const obj = JSON.parse(decoded);
      const handoffVal = obj.handoff || obj.kind || obj.type || "customer_request";
      const kind =
        (handoffVal === "reservation" || handoffVal === "reservation_request")
          ? "customer_request"
          : handoffVal;

      const payload = obj.payload ? obj.payload : obj;
      return { kind, payload };
    }

    return null;
  } catch (e) {
    console.warn("[handoff] extractHandoff failed:", e?.message);
    return null;
  }
}

// ---- Resolve "to" & "from" (NO personal fallback) ----
function resolveEmailRouting(brandCfg) {
  // Alıcı (to): SADECE brandCfg veya env’den gelsin
  const to =
    brandCfg?.handoffEmailTo ||          // Marka özel handoff alıcısı
    brandCfg?.contactEmail ||           // Markanın genel iletişim adresi
    process.env.HANDOFF_TO;              // Ortak ortam değişkeni

  // Gönderen (from): Brevo’da doğrulanmış sender tercih edilir
  const from =
    process.env.EMAIL_FROM ||            // ✅ Brevo’da doğrulanmış sender
    brandCfg?.noreplyEmail;              // (doğrulanmışsa)

  const fromName =
    process.env.EMAIL_FROM_NAME ||       // Örn: "X Hukuk Asistan"
    brandCfg?.brandName ||               // Örn: "X Hukuk"
    "Assistant";

  return { to, from, fromName };
}


function normalizeHandoffPayload(payload = {}) {
  const out = JSON.parse(JSON.stringify(payload || {}));

  // --- Helpers ---
  const toStr = (v) => (v == null ? "" : String(v));
  const clean = (s) => toStr(s).replace(/\s+/g, " ").trim();

  const normalizePhone = (p) => {
    const s = clean(p);
    if (!s) return { raw: "", digits: "" };
    const digits = s.replace(/\D/g, "");
    return { raw: s, digits };
  };

  const stripFences = (s) => toStr(s).replace(/```[\s\S]*?```/g, "").trim();

  // --- Gather candidate texts ---
  const summaryText = stripFences(out?.request?.summary || out?.summary || "");
  const detailsText = stripFences(out?.request?.details || out?.details || "");
  const combined = clean([summaryText, detailsText].filter(Boolean).join("\n"));

  // --- Phone ---
  const phoneRaw = clean(out?.contact?.phone || out?.phone || "");
  const phoneFromFields = normalizePhone(phoneRaw);

  // Metnin içinde telefon yakala (etiketsiz girişlerde yardımcı olur)
  let phoneFromTextRaw = "";
  const mPhone = combined.match(/(\+?\d[\d\s().-]{9,}\d)/);
  if (mPhone?.[1]) phoneFromTextRaw = mPhone[1];

  const phoneFromText = normalizePhone(phoneFromTextRaw);

  const finalPhoneRaw = phoneFromFields.raw || phoneFromText.raw;
  const finalPhoneDigits = phoneFromFields.digits || phoneFromText.digits;

  // --- Name ---
  let name = clean(out?.contact?.name || out?.full_name || out?.name || "");

  // 1) Etiketli formatlar: "Ad Soyad: X", "İsim: X", "Benim adım X"
  if (!name) {
    const m1 = combined.match(/ad\s*soyad\s*[:\-]\s*([^\n,]+)/i);
    if (m1?.[1]) name = clean(m1[1]);
  }
  if (!name) {
    const m2 = combined.match(/(?:benim\s+adım|adım|isim|ismim)\s*[:\-]?\s*([^\n,]+)/i);
    if (m2?.[1]) name = clean(m2[1]);
  }

  // 2) İletişim satırı: "İletişim: Enis Kuru, 0546..."
  if (!name) {
    const m3 = combined.match(/iletişim\s*:\s*([^\n,]+)\s*,\s*(\+?\d[\d\s().-]{9,}\d)/i);
    if (m3?.[1]) name = clean(m3[1]);
  }

  // 3) “Düz yazı” isim yakalama (telefonun önü değil; isim formatı + harf filtresi)
  if (!name && combined) {
    const m4 = combined.match(/(^|\n)\s*([a-zA-ZığüşöçİĞÜŞÖÇ]{2,}\s+[a-zA-ZığüşöçİĞÜŞÖÇ]{2,}(?:\s+[a-zA-ZığüşöçİĞÜŞÖÇ]{2,})?)\s+(\+?\d[\d\s().-]{9,}\d)/);
    if (m4?.[2]) name = clean(m4[2]);
  }

  // Name’i düzgün büyük/küçük harfe çek
  if (name) {
    name = name
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  // --- Summary ---
  let summary = clean(summaryText);
  if (!summary || /bilgilerinizi aldım/i.test(summary)) {
    summary = clean(detailsText);
  }
  if (summary.length > 180) summary = summary.slice(0, 180) + "…";

  // --- Details ---
  let details = clean(detailsText || summaryText);
  if (details.length > 900) details = details.slice(0, 900) + "…";

  // --- Apply back to payload (basic contact + text) ---
  out.contact = out.contact || {};
  if (!out.contact.name && name) out.contact.name = name;
  if (!out.contact.phone && finalPhoneRaw) out.contact.phone = finalPhoneRaw;

  out.request = out.request || {};
  if (!out.request.summary && summary) out.request.summary = summary;
  if (!out.request.details && details) out.request.details = details;

  if (out.request.summary) out.request.summary = stripFences(out.request.summary);
  if (out.request.details) out.request.details = stripFences(out.request.details);

  // 🔹 Görüşme bilgilerini normalize et (mode + date + time)
  // Model veya frontend farklı alan isimleri kullanırsa hepsini toparlayalım.
  const pm = out.preferred_meeting || out.meeting || {};

  let mode = clean(pm.mode || out.meeting_mode || "");
  // Sık kullanılan varyasyonları sadeleştirelim (opsiyonel ama okunaklı olur)
  const modeLower = mode.toLowerCase();
  if (/online|çevrim içi|cevrim ici/.test(modeLower)) {
    mode = "Online Görüşme";
  } else if (/yüz yüze|yuz yuze|ofis/.test(modeLower)) {
    mode = "Yüz Yüze Görüşme";
  }

  const rawDate =
    clean(
      pm.date ||
      out.meeting_date ||
      pm.datetime ||
      out.meeting_datetime ||
      ""
    );

  const rawTime =
    clean(
      pm.time ||
      out.meeting_time ||
      ""
    );

  // Varsa normalize etmeye çalış (TR tarih/saat helper’larını kullanıyoruz)
  const normalizedDate = normalizeDateTR(rawDate) || rawDate || "";
  const normalizedTime = normalizeTimeTR(rawTime) || rawTime || "";

  out.preferred_meeting = out.preferred_meeting || {};
  if (mode) out.preferred_meeting.mode = mode;
  if (normalizedDate) out.preferred_meeting.date = normalizedDate;
  if (normalizedTime) out.preferred_meeting.time = normalizedTime;



  // --- Mailde sohbet/handoff bloğu görünmesin diye: details temizliği ---
  if (out?.request?.details) {
    out.request.details = String(out.request.details)
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (out.request.details.length > 900) {
      out.request.details = out.request.details.slice(0, 900) + "…";
    }
  }

  if (out?.request?.summary && /Bilgilerinizi aldım/i.test(out.request.summary)) {
    out.request.summary = "Randevu talebi";
  }

  const stripFenced2 = (s = "") => String(s).replace(/```[\s\S]*?```/g, "").trim();
  if (out?.request?.summary) out.request.summary = stripFenced2(out.request.summary);
  if (out?.request?.details) out.request.details = stripFenced2(out.request.details);

  return out;
}

function sanitizeHandoffPayload(payload, kind, brandCfg) {
  const out = JSON.parse(JSON.stringify(payload || {})); // deep copy

  // ✅ Model bazen wrapper objeyi ({handoff, payload}) döndürür.
  // Bu durumda asıl veriyi out.payload içinden al.
  if (out && typeof out === "object" && out.payload && (out.handoff || out.kind || out.type)) {
    // out = out.payload yapmak için yeniden kopyalayalım (const olduğu için yeni değişkenle)
    const unwrapped = JSON.parse(JSON.stringify(out.payload || {}));
    // out değişkeni const olduğu için burada return ile devam etmek yerine
    // aşağıdaki satırdan itibaren unwrapped üzerinden ilerleyeceğiz.
    // Bu yüzden out yerine kullanılacak bir "data" değişkeni tanımlayalım:
    return sanitizeHandoffPayload(unwrapped, kind, brandCfg);
  }

  // 1) Markanın kendi e-postasını "müşteri maili" gibi koymayı engelle
  const brandEmails = [
    brandCfg?.contactEmail,
    brandCfg?.handoffEmailTo,
    brandCfg?.email_to
  ]
    .filter(Boolean)
    .map(s => String(s).trim().toLowerCase());

  const currentEmail =
    (out?.contact?.email || out?.email || "")
      .toString()
      .trim()
      .toLowerCase();

  if (brandEmails.length && currentEmail && brandEmails.includes(currentEmail)) {
    if (out?.contact?.email) out.contact.email = "";
    if (out?.email) out.email = "";
  }

  // 2) Hukuk botu: handoff minimum doğrulama (customer_request / case_intake)
  // ✅ Normalize (kök çözüm): name/phone/summary alanlarını tek yerde toparla
  const normalized = normalizeHandoffPayload(out);
  // out const olduğu için alanları overwrite ediyoruz
  Object.assign(out, normalized);

  // - En az: name + phone + summary
  const name =
    (out?.contact?.name || out?.full_name || "").toString().trim();

  const phoneRaw =
    (out?.contact?.phone || out?.phone || "").toString();

  const phoneDigits = phoneRaw.replace(/\D/g, "");

  const summary =
    (out?.request?.summary || out?.summary || "").toString().trim();

  // Eğer bu endpoint sadece handoff üretince mail atıyorsa,
  // burada validasyon ile “boş mail”i kesiyoruz.
  if (!name || phoneDigits.length < 10 || summary.length < 5) {
    throw new Error("handoff validation failed (need name/phone/summary)");
  }

  // details boşsa summary ile doldur
  if (!out?.request) out.request = {};
  if (!out.request.details) out.request.details = summary;

  // Normalize: contact alanını tekle
  out.contact = out.contact || {};
  if (!out.contact.name) out.contact.name = name;
  if (!out.contact.phone) out.contact.phone = phoneRaw;
  if (!out.contact.email && out.email) out.contact.email = out.email;

  // --- Mailde sohbet/handoff bloğu görünmesin diye: details temizliği ---
  if (out?.request?.details) {
    out.request.details = String(out.request.details)
      .replace(/```[\s\S]*?```/g, "")      // fenced blokları tamamen sil
      .replace(/\n{3,}/g, "\n\n")          // aşırı boşlukları toparla
      .trim();

    // çok uzunsa kırp (maili şişirmesin)
    if (out.request.details.length > 900) {
      out.request.details = out.request.details.slice(0, 900) + "…";
    }
  }

  // summary saçmaysa düzelt
  if (out?.request?.summary && /Bilgilerinizi aldım/i.test(out.request.summary)) {
    out.request.summary = "Randevu talebi";
  }

  const stripFenced = (s = "") => String(s).replace(/```[\s\S]*?```/g, "").trim();

  if (out?.request?.summary) out.request.summary = stripFenced(out.request.summary);
  if (out?.request?.details) out.request.details = stripFenced(out.request.details);

  return out;
}

// --- TR tarih/saat normalizasyon helpers ---
function normalizeDateTR(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/\s+/g, " ");

  // 1) dd.mm.yyyy | dd/mm/yyyy | dd-mm-yyyy | dd mm yyyy
  let m = s.match(/^(\d{1,2})[.\-/ ](\d{1,2})[.\-/ ](\d{4})$/);
  if (m) {
    let dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yyyy = parseInt(m[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // 2) dd <ay adı> yyyy  (ör. 5 kasım 2025)
  const aylar = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "mayis": 5,
    "haziran": 6, "temmuz": 7, "ağustos": 8, "agustos": 8, "eylül": 9, "eylul": 9,
    "ekim": 10, "kasım": 11, "kasim": 11, "aralık": 12, "aralik": 12
  };
  m = s.match(/^(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})$/i);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = aylar[m[2]] || null;
    const yyyy = parseInt(m[3], 10);
    if (mm && dd >= 1 && dd <= 31) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // 3) yyyy-mm-dd zaten ISO ise dokunma
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null; // tanıyamadı
}

function normalizeTimeTR(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();

  // 1) 14.00 → 14:00
  s = s.replace(/\./g, ":").replace(/\s+/g, " ");

  // 2) "14:00" veya "14 00" veya "14"
  let m = s.match(/^(\d{1,2})(?::|\s)?(\d{2})?$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    let mm = m[2] ? parseInt(m[2], 10) : 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
  }

  // 3) 2:30 pm / 2 pm vb. (hafif destek)
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    let mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
  }

  if (/^\d{2}:\d{2}$/.test(s)) return s; // zaten uygun
  return null;
}

async function ensureTables() {
  if (!process.env.DATABASE_URL) {
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
        ADD COLUMN IF NOT EXISTS meta JSONB;
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

async function logChatMessage({
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
  if (!process.env.DATABASE_URL) return;

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

      // 2) Mesajı ekle
      await client.query(
        `
  INSERT INTO messages
    (conversation_id, role, text, raw_text, handoff_kind, handoff_payload, meta, created_at)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, now())
  `,
        [
          conversationId,
          role,
          text || null,
          rawText || null,
          handoff ? handoff.kind || null : null,
          handoff ? JSON.stringify(handoff.payload || null) : null,
          meta ? JSON.stringify(meta) : null,
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


/* ==================== Rate Limit ==================== */
app.use(rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ==================== STREAMING (Typing Effect) — brandKey destekli ==================== */

/* OpenAI Assistants v2 SSE proxy: /threads/{threadId}/runs  +  { stream:true } */
app.post("/api/chat/stream", chatLimiter, async (req, res) => {
  try {
    const { threadId, message, brandKey, visitorId, sessionId, source, meta } = req.body || {};

    console.log("[brand] incoming:", { brandKey });

    if (!threadId || !message) {
      return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
    }

    // BRAND: brandKey zorunlu ve whitelist kontrolü
    const brandCfg = getBrandConfig(brandKey);
    if (!brandCfg) {
      return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed or missing" });
    }

    // 🔴 BURAYA EKLE: user mesajını logla
    await logChatMessage({
      brandKey,
      threadId,
      role: "user",
      text: message,
      rawText: message,
      handoff: null,
      visitorId,
      sessionId,
      source,
      meta
    });



    // SSE başlıkları
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // 🔌 Düzenli nabız gönder (yorum satırı SSE: client'a görünmez)
    const KA_MS = 20_000; // 20 sn: 15–30 arası güvenli

    const keepAlive = setInterval(() => {
      try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch { }
    }, KA_MS);

    let clientClosed = false;
    req.on("close", () => {
      clientClosed = true;
      try { clearInterval(keepAlive); } catch { }
      try { res.end(); } catch { }
    });

    // 1) Kullanıcı mesajını threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2) Run'ı STREAM modda başlat (assistant_id: brand öncelikli, yoksa global fallback)
    const upstream = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs`, {

      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        assistant_id: brandCfg.assistant_id || ASSISTANT_ID,
        stream: true,
        metadata: { brandKey }, // izleme
        // ✅ Hukuk botu run talimatı (kritik)
        instructions: buildRunInstructions(brandKey, brandCfg),

      }),

    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(`OpenAI stream start failed ${upstream.status}: ${errText}`);
    }

    // Handoff tespiti için metni biriktirelim (KULLANICIYA GÖSTERMEYİZ)
    let buffer = "";
    let accTextOriginal = "";   // e-posta/parse için ORİJİNAL metin
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();


    // Fenced blocks (``` ... ```) gizleme + chunk boundary fix (tail overlap yok)
    let inFencedBlock = false;
    let fenceTail = ""; // sadece "```" yakalamak için, kullanıcıya BASILMAZ

    function sanitizeDeltaText(chunk) {
      if (!chunk) return "";

      const tailLen = fenceTail.length;      // genelde 2
      const merged = fenceTail + chunk;      // sadece arama amacıyla birleştiriyoruz
      fenceTail = merged.slice(-2);          // sonraki chunk için son 2 karakteri sakla

      let out = "";
      let i = 0;

      // Yardımcı: merged içinden parça eklerken tail kısmını ASLA kullanıcıya ekleme
      const appendSafe = (from, to) => {
        const a = Math.max(from, tailLen);
        const b = Math.max(to, tailLen);
        if (b > a) out += merged.slice(a, b);
      };

      while (i < merged.length) {
        if (!inFencedBlock) {
          const start = merged.indexOf("```", i);
          if (start === -1) {
            appendSafe(i, merged.length);
            break;
          }
          appendSafe(i, start);
          inFencedBlock = true;
          i = start + 3;
        } else {
          const end = merged.indexOf("```", i);
          if (end === -1) {
            // fence içindeyiz; bu chunk’ta kapanış yok -> kalan her şeyi yut
            break;
          }
          inFencedBlock = false;
          i = end + 3;
        }
      }

      return out;
    }




    // 3) OpenAI’den gelen SSE’yi sanitize ederek client'a aktar + orijinali topla
    let sawHandoffSignal = false; // delta sırasında metadata.handoff görürsek işaretle

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientClosed) break;

      const piece = decoder.decode(value, { stream: true });
      buffer += piece;

      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // eksik satır

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const evt = JSON.parse(dataStr);

          // --- STREAM HANDLER: her delta paketinde handoff sinyali var mı? ---
          // (farklı şekiller için 3 kaynaktan da bak: choices[].delta, evt.delta, evt.message)
          const metaDeltaA = evt?.choices?.[0]?.delta?.metadata;
          const metaDeltaB = evt?.delta?.metadata;
          const metaDeltaC = evt?.message?.metadata;
          const metaDelta = metaDeltaA ?? metaDeltaB ?? metaDeltaC;

          if (metaDelta !== undefined) {
            console.log("[handoff][detect:delta]", {
              hasMeta: true,
              handoff: metaDelta?.handoff,
              keys: metaDelta ? Object.keys(metaDelta) : []
            });
            if (metaDelta?.handoff === true) {
              sawHandoffSignal = true;
            }
          }

          // 1) ORİJİNAL metni topla (mail/parse için)
          if (evt?.delta?.content && Array.isArray(evt.delta.content)) {
            for (const c of evt.delta.content) {
              if (c?.type === "text" && c?.text?.value) {
                accTextOriginal += c.text.value;
              }
            }
          }
          if (evt?.message?.content && Array.isArray(evt.message.content)) {
            for (const c of evt.message.content) {
              if (c?.type === "text" && c?.text?.value) {
                accTextOriginal += c.text.value;
              }
            }
          }

          // 2) KULLANICIYA GİDECEK EVENT'i sanitize et (handoff bloklarını gizle)
          const evtOut = JSON.parse(JSON.stringify(evt)); // shallow clone

          const sanitizeContentArray = (arr) => {
            for (const c of arr) {
              if (c?.type === "text" && c?.text?.value) {
                c.text.value = sanitizeDeltaText(c.text.value);
                // Son çivi: "handoff": geçen bir şey kalırsa komple kırp
                if (/"handoff"\s*:|```handoff/i.test(c.text.value)) {
                  c.text.value = c.text.value.replace(/```[\s\S]*$/g, "").trim();
                }

                // defensive: "handoff" kelimesi geçen fenced parçalar bazen fence’siz sızabilir
                c.text.value = c.text.value.replace(/```handoff[\s\S]*?```/gi, "");

              }
            }
          };

          if (evtOut?.delta?.content && Array.isArray(evtOut.delta.content)) {
            sanitizeContentArray(evtOut.delta.content);
          }
          if (evtOut?.message?.content && Array.isArray(evtOut.message.content)) {
            sanitizeContentArray(evtOut.message.content);
          }

          // 3) Sanitized event'i client'a yaz
          res.write(`data: ${JSON.stringify(evtOut)}\n\n`);
        } catch (err) {
          // parse edilemeyen satırları olduğu gibi geçirmek istersen:
          // res.write(`data: ${dataStr}\n\n`);
          console.warn("[stream][parse] non-JSON line forwarded or skipped:", err?.message);
        }
      }
    }

    // 4) Stream bitti → handoff varsa maille (brandCfg ile)
    console.log("[handoff][debug] accTextOriginal.len =", accTextOriginal.length,
      "```handoff fence?", /```handoff/i.test(accTextOriginal),
      "```json fence?", /```json/i.test(accTextOriginal),
      "fenced handoff key?", /```[\s\S]*\"handoff\"\s*:/.test(accTextOriginal),
      "<handoff> tag?", /<handoff>/i.test(accTextOriginal),
      "[[HANDOFF: base64]?", /\[\[HANDOFF:/i.test(accTextOriginal)
    );


    let handoff = extractHandoff(accTextOriginal);

    // Fallback: explicit block yoksa metinden çıkar
    if (!handoff) {
      // fallback SADECE kullanıcı mesajından yapılmalı (asistan metninden değil)
      const inferred = inferHandoffFromText(message);
      if (inferred) {
        handoff = inferred;
      }
    }




    const { to: toAddr, from: fromAddr } = resolveEmailRouting(brandCfg);

    console.log("[handoff] PREP(stream-end)", {
      sawHandoffSignal: !!handoff,
      to: toAddr,
      from: fromAddr
    });



    if (handoff) {
      // 1) duplicate engeli (kalsın)
      if (isDuplicateHandoff(threadId, handoff.payload)) {
        console.log("[handoff][gate][stream] blocked duplicate payload");
        handoff = null;
      }

      if (!handoff) {
        console.log("[handoff][stream] not sending (gated)");
      } else {
        try {
          const clean = sanitizeHandoffPayload(handoff.payload, handoff.kind, brandCfg);

          // 2) Minimum bilgi yoksa mail YOK
          if (!hasMinimumHandoffData(clean)) {
            console.log("[handoff][gate][stream] blocked (missing minimum data)");
          } else {
            await sendHandoffEmail({ brandKey, kind: handoff.kind, payload: clean, brandCfg });

            await pushHandoffToSheets({
              ts: new Date().toISOString(),
              brandKey,
              kind: handoff.kind,
              threadId,
              visitorId: visitorId || null,
              sessionId: sessionId || null,
              source: source || null,
              meta: meta || null,
              payload: clean
            });

            console.log("[handoff][stream] SENT");

            console.log("[handoff][stream] SENT");
          }
        } catch (e) {
          console.error("[handoff][stream] email failed or dropped:", {
            message: e?.message,
            code: e?.code,
          });
          console.error(
            "[handoff][stream] payload snapshot:",
            JSON.stringify(handoff?.payload || {}, null, 2)
          );
        }
      }
    }


    // 🔵 BURAYA: assistant cevabını logla
    try {
      const cleanText = accTextOriginal.replace(/```[\s\S]*?```/g, "").trim();
      await logChatMessage({
        brandKey,
        threadId,
        role: "assistant",
        text: cleanText,
        rawText: accTextOriginal,
        handoff,
        visitorId,
        sessionId,
        source,
        meta
      });

    } catch (e) {
      console.error("[db] logChatMessage (stream assistant) error:", e);
    }


    // 5) Bitiş işareti
    try {
      res.write("data: [DONE]\n\n");
      clearInterval(keepAlive);
      res.end();
    } catch (e) {
      // yoksay
    }
  } catch (e) {
    console.error("[stream] fatal:", e);
    try { res.write(`data: ${JSON.stringify({ error: "stream_failed" })}\n\n`); } catch (__) { }
    try { res.write("data: [DONE]\n\n"); } catch (__) { }
    try { clearInterval(keepAlive); } catch (__) { }
    try { res.end(); } catch (__) { }
  }
}); // /api/chat/stream KAPANIŞ





/* ==================== Routes ==================== */
// 1) Thread oluştur
app.post("/api/chat/init", chatLimiter, async (req, res) => {
  try {
    const brandKey = (req.body && req.body.brandKey) || (req.query && req.query.brandKey);

    // brandKey varsa whitelistten kontrol et, yoksa da sorun yapma (opsiyonel)
    let brandCfg = null;
    if (brandKey) {
      brandCfg = getBrandConfig(brandKey);
      if (!brandCfg) {
        return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed" });
      }
    }

    // Thread oluştur (brandKey varsa metadata’ya yazalım)

    const thread = await openAI("/threads", {
      method: "POST",
      body: brandKey ? { metadata: { brandKey } } : {}
    });

    return res.json({ threadId: thread.id, brandKey: brandKey || null });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "init_failed", detail: String(e) });
  }
});



// 2) Mesaj gönder + run başlat + poll + yanıtı getir (brandKey destekli)

app.post("/api/chat/message", chatLimiter, async (req, res) => {
  const { threadId, message, brandKey, visitorId, sessionId, source, meta } = req.body || {};

  console.log("[brand] incoming:", { brandKey });

  if (!threadId || !message) {
    return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
  }

  // BRAND: brandKey zorunlu ve whitelist kontrolü
  const brandCfg = getBrandConfig(brandKey);
  if (!brandCfg) {
    return res.status(403).json({ error: "unknown_brand", detail: "brandKey not allowed or missing" });
  }

  try {
    //  BURAYA: user mesajını logla
    await logChatMessage({
      brandKey,
      threadId,
      role: "user",
      text: message,
      rawText: message,
      handoff: null,
      visitorId,
      sessionId,
      source,
      meta
    });


    // 2.a) Mesajı threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2.b) Run oluştur  (assistant_id: brand öncelikli, yoksa global fallback)
    // 2.b) Run oluştur  (assistant_id: brand öncelikli, yoksa global fallback)
    const run = await openAI(`/threads/${threadId}/runs`, {
      method: "POST",
      body: {
        assistant_id: brandCfg.assistant_id || ASSISTANT_ID,
        metadata: { brandKey },

        // ✅ Hukuk botu run talimatı (kritik)
        instructions: buildRunInstructions(brandKey, brandCfg)

      },
    });



    // 2.c) Run tamamlanana kadar bekle (poll)
    let runStatus = run.status;
    const runId = run.id;
    const started = Date.now();
    const TIMEOUT_MS = 180_000;

    while (runStatus !== "completed") {
      if (Date.now() - started > TIMEOUT_MS) {
        throw new Error("Run polling timeout");
      }
      await new Promise(r => setTimeout(r, 1200));
      const polled = await openAI(`/threads/${threadId}/runs/${runId}`);
      runStatus = polled.status;
      if (["failed", "cancelled", "expired"].includes(runStatus)) {
        throw new Error(`Run status: ${runStatus}`);
      }
    }

    // // 2.d) Mesajları çek (en yeni asistan mesajını al)

    const msgs = await openAI(`/threads/${threadId}/messages?order=desc&limit=10`);
    const assistantMsg = (msgs.data || []).find(m => m.role === "assistant");

    // İçerik metnini ayıkla (text parçaları)

    // İçerik metnini ayıkla (text parçaları)
    let rawAssistantText = "";
    if (assistantMsg && assistantMsg.content) {
      for (const part of assistantMsg.content) {
        if (part.type === "text" && part.text?.value) {
          rawAssistantText += part.text.value + "\n";
        }
      }
      rawAssistantText = rawAssistantText.trim();
    }

    // Kullanıcıya asla code-fence göstermeyelim
    const stripFenced = (s = "") => s.replace(/```[\s\S]*?```/g, "").trim();
    let cleanText = stripFenced(rawAssistantText);


    {
      const handoffProbe = extractHandoff(rawAssistantText);
      if (!handoffProbe && /randevu|avukat|iletişime geç|arasın|ön görüşme/i.test(message)) {
        console.warn("[handoff] no block found; assistant raw text:", rawAssistantText.slice(0, 500));
      }
    }


    // --- Handoff JSON çıkar + e-posta ile gönder (brandConfig ile) ---
    let handoff = extractHandoff(rawAssistantText);

    // explicit yoksa metinden üret
    if (!handoff) {
      const inferred = inferHandoffFromText(message);
      if (inferred) {
        handoff = inferred;
        console.log("[handoff][fallback][poll] inferred from text");
      }
    }

    // kullanıcıya dönecek metin her zaman temiz
    cleanText = stripFenced(rawAssistantText);


    if (handoff) {
      // duplicate engeli
      if (isDuplicateHandoff(threadId, handoff.payload)) {
        console.log("[handoff][gate][poll] blocked duplicate payload");
        handoff = null;
      }

      if (!handoff) {
        console.log("[handoff][poll] not sending (gated)");
      } else {
        try {
          const clean = sanitizeHandoffPayload(handoff.payload, handoff.kind, brandCfg);

          if (!hasMinimumHandoffData(clean)) {
            console.log("[handoff][gate][poll] blocked (missing minimum data)");
          } else {
            await sendHandoffEmail({
              brandKey,
              kind: handoff.kind,
              payload: clean,
              brandCfg,
            });

            await pushHandoffToSheets({
              ts: new Date().toISOString(),
              brandKey,
              kind: handoff.kind,
              threadId,
              visitorId: visitorId || null,
              sessionId: sessionId || null,
              source: source || null,
              meta: meta || null,
              payload: clean
            });

            console.log("[handoff][poll] SENT", { kind: handoff.kind });


          }
        } catch (e) {
          console.error("[handoff][poll] email failed or dropped:", {
            message: e?.message,
            code: e?.code,
          });
          console.error(
            "[handoff][poll] payload snapshot:",
            JSON.stringify(handoff?.payload || {}, null, 2)
          );
        }
      }
    }



    // 🔵 BURAYA: assistant cevabını logla
    try {
      await logChatMessage({
        brandKey,
        threadId,
        role: "assistant",
        text: cleanText,
        rawText: accTextOriginal,
        handoff,
        visitorId,
        sessionId,
        source,
        meta,
        rawText: rawAssistantText,      // burada zaten fence'ler temizlenmiş metin var

      });
    } catch (e) {
      console.error("[db] logChatMessage (poll assistant) error:", e);
    }

    return res.json({
      status: "ok",
      threadId,
      message: cleanText || "(Yanıt metni bulunamadı)",
      handoff: handoff ? { kind: handoff.kind } : null
    });


  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "message_failed", detail: String(e) });
  }
});


/* ==================== Mail Isolated Test Endpoint (opsiyonel) ==================== */
app.post("/_mail_test", async (req, res) => {
  try {
    const apiKey = process.env.BREVO_API_KEY || "";
    if (!apiKey) throw new Error("BREVO_API_KEY missing");

    const senderEmail = process.env.EMAIL_FROM || "";
    const senderName = process.env.EMAIL_FROM_NAME || "Assistant";
    const toStr = (req.body?.to || process.env.EMAIL_TO || "").trim();

    if (!senderEmail) throw new Error("EMAIL_FROM missing");
    if (!toStr) throw new Error("EMAIL_TO missing (or body.to not provided)");

    const to = toStr
      .split(",")
      .map(e => ({ email: e.trim() }))
      .filter(x => x.email);

    const email = new SendSmtpEmail();
    email.sender = { email: senderEmail, name: senderName };
    email.to = to;
    email.subject = `Brevo HTTP API Test — ${new Date().toISOString()}`;
    email.htmlContent = `<p>Merhaba! Bu mail Brevo HTTP API ile gönderildi.</p>`;
    email.textContent = `Merhaba! Bu mail Brevo HTTP API ile gönderildi.`;

    const resp = await brevo.sendTransacEmail(email);

    // Brevo yanıt gövdesini oku ve messageId çıkar
    const data = await readIncomingMessageJSON(resp);
    const msgId = data?.messageId || data?.messageIds?.[0] || null;

    console.log("[mail][test] send OK — status:",
      resp?.response?.statusCode || 201,
      "messageId:", msgId
    );

    res.status(201).json({ ok: true, messageId: msgId, data });
  } catch (e) {
    const status = e?.response?.status || 400;
    const body = e?.response?.data || { message: e?.message || "unknown error" };

    console.error("[mail][test] error:", status, body);
    res.status(status).json({ ok: false, error: body });
  }
});

await ensureTables().catch((e) => {
  console.error("[db] ensureTables hata:", e);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// (opsiyonel, platforma gÃ¶re etkisi deÄŸiÅŸir)
server.headersTimeout = 120_000;   // header bekleme
server.requestTimeout = 0;          // request toplam sÃ¼resini sÄ±nÄ±rsÄ±z yap (Node 18+)
server.keepAliveTimeout = 75_000;   // TCP keep-alive




