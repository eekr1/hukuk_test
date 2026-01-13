import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../services/db.js";

const router = express.Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key-change-me";

// Middleware: Admin yetkisi kontrolü
const requireAdmin = (req, res, next) => {
    const token = req.cookies?.admin_token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        res.clearCookie("admin_token");
        return res.status(401).json({ error: "Invalid token" });
    }
};

/* ==================== Auth Endpoints ==================== */

// POST /api/admin/login
router.post("/login", (req, res) => {
    const { password } = req.body;

    // Basit şifre kontrolü
    if (password !== ADMIN_PASSWORD) {
        // Gecikme ekle (brute-force önlemi - basit)
        return setTimeout(() => {
            res.status(401).json({ error: "Hatalı şifre" });
        }, 1000);
    }

    // Token oluştur
    const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "24h" });

    // Cookie set et (httpOnly: true -> JS erişemez, güvenli)
    res.cookie("admin_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // Sadece HTTPS'de gönder (Prod)
        sameSite: "strict",
        maxAge: 24 * 60 * 60 * 1000 // 24 saat
    });

    res.json({ ok: true });
});

// POST /api/admin/logout
router.post("/logout", (req, res) => {
    res.clearCookie("admin_token");
    res.json({ ok: true });
});

// GET /api/admin/check (Frontend bu endpoint ile giriş durumunu anlar)
router.get("/check", requireAdmin, (req, res) => {
    res.json({ ok: true, user: "admin" });
});

/* ==================== Data Endpoints ==================== */

// GET /api/admin/handoffs
router.get("/handoffs", requireAdmin, async (req, res) => {
    try {
        // Son 100 handoff mesajını çek
        // conversations tablosuyla join yaparak visitor bilgilerini de alabiliriz (opsiyonel ama iyi olur)
        const result = await pool.query(`
            SELECT 
                m.id,
                m.created_at,
                m.handoff_payload,
                m.meeting_mode,
                m.meeting_date,
                m.meeting_time,
                c.thread_id,
                c.visitor_id,
                c.session_id
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE m.handoff_payload IS NOT NULL
            ORDER BY m.created_at DESC
            LIMIT 100
        `);

        // Frontend için veriyi temizle/hazırla
        const rows = result.rows.map(r => {
            // Payload içindeki detayları düzleştir
            const p = r.handoff_payload || {};
            return {
                id: r.id,
                date: r.created_at,
                threadId: r.thread_id,
                visitorId: r.visitor_id,

                // Contact
                name: p.contact?.name || "İsimsiz",
                phone: p.contact?.phone || "",
                email: p.contact?.email || "",

                // Request
                category: p.matter?.category || p.category || "Diğer",
                summary: p.request?.summary || p.summary || "",
                details: p.request?.details || p.details || "",

                // Meeting (DB kolonlarından veya payload'dan)
                meetingMode: r.meeting_mode || p.preferred_meeting?.mode || "",
                meetingDate: r.meeting_date || p.preferred_meeting?.date || "",
                meetingTime: r.meeting_time || p.preferred_meeting?.time || ""
            };
        });

        res.json({ ok: true, data: rows });
    } catch (e) {
        console.error("[admin] handoffs error:", e);
        res.status(500).json({ error: "Database error" });
    }
});

export default router;
