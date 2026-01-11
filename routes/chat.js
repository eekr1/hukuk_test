import express from "express";
import rateLimit from "express-rate-limit";
import { openAI } from "../services/openai.js";
import { logChatMessage } from "../services/db.js";
import { getBrandConfig, buildRunInstructions } from "../config/brands.js";
import { ASSISTANT_ID, OPENAI_BASE, OPENAI_API_KEY } from "../config/env.js";
import { extractHandoff, isDuplicateHandoff, sanitizeHandoffPayload, hasMinimumHandoffData, inferHandoffFromText, resolveEmailRouting } from "../services/handoff.js";
import { sendHandoffEmail } from "../services/mail.js";
import { pushHandoffToSheets } from "../services/sheets.js";

const router = express.Router();

const chatLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

/* ==================== STREAMING (Typing Effect) — brandKey destekli ==================== */

/* OpenAI Assistants v2 SSE proxy: /threads/{threadId}/runs  +  { stream:true } */
router.post("/stream", chatLimiter, async (req, res) => {
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
                            payload: clean,
                            // Flattened meeting fields for easy Sheets usage
                            meeting_mode: clean?.preferred_meeting?.mode || "",
                            meeting_date: clean?.preferred_meeting?.date || "",
                            meeting_time: clean?.preferred_meeting?.time || ""
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
});

// 1) Thread oluştur
router.post("/init", chatLimiter, async (req, res) => {
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
router.post("/message", chatLimiter, async (req, res) => {
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
                            payload: clean,
                            // Flattened meeting fields for easy Sheets usage
                            meeting_mode: clean?.preferred_meeting?.mode || "",
                            meeting_date: clean?.preferred_meeting?.date || "",
                            meeting_time: clean?.preferred_meeting?.time || ""
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

export default router;
