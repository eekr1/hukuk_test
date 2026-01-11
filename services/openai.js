import { OPENAI_BASE, OPENAI_API_KEY } from "../config/env.js";

/* ==================== Helpers ==================== */
export async function openAI(path, { method = "GET", body } = {}) {
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
