import crypto from "crypto";
import { HANDOFF_TO, EMAIL_FROM, EMAIL_FROM_NAME } from "../config/env.js";

// aynı payload'ı kısa sürede tekrar maillemeyi engelle
const recentHandoffs = new Map(); // threadId -> { hash, ts }

export function isDuplicateHandoff(threadId, payload) {
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

export function hasMinimumHandoffData(cleanPayload = {}) {
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


    // Debug log – artık NERESİ eksik görebileceksin
    if (!hasName || !hasPhone || !hasText || !hasMode || !hasDateTime) {
        console.log("[handoff][gate][debug]", {
            hasName,
            hasPhone,
            hasText,
            hasMode,
            hasDateTime,
            name,
            phoneDigits,
            summary,
            details,
            modeRaw,
            dateRaw,
            timeRaw,
        });
    }

    return hasName && hasPhone && hasText && hasMode && hasDateTime;

}




export function userProvidedContactInfo(userText = "") {
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

export function assistantIndicatesSending(assistantText = "") {
    const t = String(assistantText || "").toLowerCase();
    // “iletiyorum / ileteceğim / talebiniz iletildi” = gönderiyor demek
    return /(iletiyorum|ileteceğim|ekibe iletiyorum|ekibe ileteceğim|talebiniz iletildi|talebinizi ilettim|iletilmiştir|ilettim)/i.test(t);
}

// Assistant yanıtından handoff JSON çıkar

// --- Metinden handoff çıkarımı (fallback - sade & güvenli) ---
// Model handoff bloğu üretmediyse, metinden name/phone/summary üretir.
// NOT: Bu fallback, asistanın "form soruları" veya "onay sorusu" çıktılarında çalışmaz.
export function inferHandoffFromText(text) {
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

export function extractHandoff(text = "") {
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
export function resolveEmailRouting(brandCfg) {
    // Alıcı (to): SADECE brandCfg veya env’den gelsin
    const to =
        brandCfg?.handoffEmailTo ||          // Marka özel handoff alıcısı
        brandCfg?.contactEmail ||           // Markanın genel iletişim adresi
        HANDOFF_TO;              // Ortak ortam değişkeni

    // Gönderen (from): Brevo’da doğrulanmış sender tercih edilir
    const from =
        EMAIL_FROM ||            // ✅ Brevo’da doğrulanmış sender
        brandCfg?.noreplyEmail;              // (doğrulanmışsa)

    const fromName =
        EMAIL_FROM_NAME ||       // Örn: "X Hukuk Asistan"
        brandCfg?.brandName ||               // Örn: "X Hukuk"
        "Assistant";

    return { to, from, fromName };
}


export function normalizeHandoffPayload(payload = {}) {
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

    // --- Fallback: Date/Time/Mode from Keywords ---
    // Eğer tarih/saat boşsa ama metinde aciliyet belirten kelimeler varsa doldur.
    const combinedText = ((summary || "") + " " + (details || "")).toLowerCase();

    if (!out.preferred_meeting.date) {
        const urgencyKeywords = ["hemen", "acil", "kısa", "en kısa zamanda", "en kısa sürede", "müsaitlikte", "uygun zamanda", "dönüş yaparsanız", "haber bekliyorum"];

        // Varsa aciliyet, yoksa genel default
        if (urgencyKeywords.some(kw => combinedText.includes(kw))) {
            out.preferred_meeting.date = "En kısa sürede (Tespit edilen)";
        } else {
            out.preferred_meeting.date = "Belirtilmedi";
        }
    }

    // Tarih bir şekilde doldu ama saat yoksa:
    if (!out.preferred_meeting.time) {
        out.preferred_meeting.time = "Müsaitlik durumuna göre";
    }

    // Mod boşsa varsayılan ata (Bloklamaması için)
    if (!out.preferred_meeting.mode) {
        out.preferred_meeting.mode = "İletişimde belirlenecek";
    }



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

export function sanitizeHandoffPayload(payload, kind, brandCfg) {
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
export function normalizeDateTR(input) {
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

export function normalizeTimeTR(input) {
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
