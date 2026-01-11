import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
import { BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME, HANDOFF_TO, REPLY_TO } from "../config/env.js";

/* ==================== Mail Client (Brevo HTTP API) ==================== */
export const brevo = new TransactionalEmailsApi();

if (!BREVO_API_KEY) {
    console.warn("[mail] Missing BREVO_API_KEY — set it in environment!");
}
// SDK’nin resmi dokümantasyonundaki doğru yöntem:
// emailAPI.authentications.apiKey.apiKey = "xkeysib-...."
(brevo).authentications.apiKey.apiKey = BREVO_API_KEY;
console.log("[mail] Brevo HTTP API client ready");


function escapeHtml(s = "") {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export async function sendHandoffEmail({ brandKey, brandCfg, kind, payload }) {
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
            HANDOFF_TO ||
            brandCfg.email_to ||
            brandCfg.contactEmail;

        if (!to) throw new Error("No recipient found for handoff email (to).");

        // Gönderen (Brevo’da doğrulanmış olmalı)
        const from = brandCfg.noreplyEmail || EMAIL_FROM;
        const fromName =
            EMAIL_FROM_NAME || brandCfg.brandName || brandLabel;

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
            REPLY_TO ||
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

export async function readIncomingMessageJSON(resp) {
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
