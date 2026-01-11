import { SHEETS_WEBHOOK_URL, SHEETS_WEBHOOK_SECRET } from "../config/env.js";

/* ==================== Google Sheets Webhook (Apps Script) ==================== */
export async function pushHandoffToSheets(row) {
    const url = (SHEETS_WEBHOOK_URL || "").trim();
    if (!url) return { ok: false, skipped: true, reason: "SHEETS_WEBHOOK_URL missing" };

    const secret = (SHEETS_WEBHOOK_SECRET || "").trim();

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
