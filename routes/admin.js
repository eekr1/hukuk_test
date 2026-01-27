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

// GET /api/admin/stats
router.get("/stats", requireAdmin, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

        // 1) Bugünkü Yeni Talepler
        const resToday = await pool.query(`
            SELECT COUNT(*) as count FROM messages 
            WHERE handoff_payload IS NOT NULL 
            AND created_at::date = $1
        `, [today]);

        // 2) Bekleyen "NEW" Sayısı
        const resPending = await pool.query(`
            SELECT COUNT(*) as count FROM messages 
            WHERE handoff_payload IS NOT NULL 
            AND (admin_status = 'NEW' OR admin_status IS NULL)
        `);

        // 3) Son 7 Gün Toplam
        const resWeekly = await pool.query(`
            SELECT COUNT(*) as count FROM messages 
            WHERE handoff_payload IS NOT NULL 
            AND created_at > now() - interval '7 days'
        `);

        // 4) Kategori Analizi (Son 7 Gün)
        const resCats = await pool.query(`
            SELECT 
                COALESCE(handoff_payload->'matter'->>'category', 'diger') as category,
                COUNT(*) as count
            FROM messages
            WHERE handoff_payload IS NOT NULL
            AND created_at > now() - interval '7 days'
            GROUP BY 1
            ORDER BY 2 DESC
            LIMIT 5
        `);

        res.json({
            ok: true,
            stats: {
                today: parseInt(resToday.rows[0].count),
                pending: parseInt(resPending.rows[0].count),
                weekly: parseInt(resWeekly.rows[0].count),
                categories: resCats.rows
            }
        });
    } catch (e) {
        console.error("[admin] stats error:", e);
        res.status(500).json({ error: "Stats error" });
    }
});

// GET /api/admin/handoffs (Filtreli + Arama)
router.get("/handoffs", requireAdmin, async (req, res) => {
    try {
        const { status, days, q, category } = req.query;

        let query = `
            SELECT 
                m.id,
                m.created_at,
                m.handoff_payload,
                m.meeting_mode,
                m.meeting_date,
                m.meeting_time,
                m.admin_status,
                m.admin_notes,
                m.lead_score,
                m.summary_key_points,
                c.thread_id,
                c.visitor_id,
                c.session_id
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE m.handoff_payload IS NOT NULL
        `;

        const params = [];
        let paramIdx = 1;

        // Filtre: Durum
        if (status && status !== 'ALL') {
            if (status === 'NEW') {
                query += ` AND (m.admin_status = 'NEW' OR m.admin_status IS NULL)`;
            } else {
                query += ` AND m.admin_status = $${paramIdx++}`;
                params.push(status);
            }
        }

        // Filtre: Tarih (Son X gün)
        if (days) {
            query += ` AND m.created_at > now() - interval '${parseInt(days)} days'`;
        }

        // Filtre: Kategori
        if (category && category !== 'ALL') {
            // JSONB sorgusu: payload->matter->category
            query += ` AND (m.handoff_payload->'matter'->>'category')::text = $${paramIdx++}`;
            params.push(category);
        }

        // Arama (İsim veya Telefon veya Notlar)
        if (q) {
            const likeQ = `%${q}%`;
            query += ` AND (
                (m.handoff_payload->'contact'->>'name') ILIKE $${paramIdx} OR
                (m.handoff_payload->'contact'->>'phone') ILIKE $${paramIdx} OR
                m.admin_notes ILIKE $${paramIdx}
            )`;
            params.push(likeQ);
            paramIdx++;
        }

        query += ` ORDER BY m.created_at DESC LIMIT 200`;

        const result = await pool.query(query, params);

        const rows = result.rows.map(r => {
            const p = r.handoff_payload || {};
            return {
                id: r.id,
                date: r.created_at,
                threadId: r.thread_id,
                visitorId: r.visitor_id,
                handoff_payload: r.handoff_payload, // Frontend ihtiyaç duyuyor

                // Admin Fields
                status: r.admin_status || "NEW",
                notes: r.admin_notes || "",
                lead_score: r.lead_score,
                summary_key_points: r.summary_key_points,

                // Contact
                name: p.contact?.name || "İsimsiz",
                phone: p.contact?.phone || "",
                email: p.contact?.email || "",

                // Request
                category: p.matter?.category || p.category || "Diğer",
                summary: p.request?.summary || p.summary || "",
                details: p.request?.details || p.details || "",

                // Meeting
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

// PATCH /api/admin/handoffs/:id (Durum/Not Güncelleme)
router.patch("/handoffs/:id", requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, notes } = req.body;

        // Dinamik güncelleme query'si
        const updates = [];
        const params = [id];
        let idx = 2;

        if (status !== undefined) {
            updates.push(`admin_status = $${idx++}`);
            params.push(status);
        }
        if (notes !== undefined) {
            updates.push(`admin_notes = $${idx++}`);
            params.push(notes);
        }

        if (updates.length === 0) {
            return res.json({ ok: true, msg: "No changes" });
        }

        const query = `
            UPDATE messages 
            SET ${updates.join(", ")}
            WHERE id = $1
        `;

        await pool.query(query, params);
        res.json({ ok: true });
    } catch (e) {
        console.error("[admin] update error:", e);
        res.status(500).json({ error: "Update error" });
    }
});


// GET /api/admin/conversations/:threadId
router.get("/conversations/:threadId", requireAdmin, async (req, res) => {
    try {
        const { threadId } = req.params;

        // Thread ID'ye göre mesajları çek
        const result = await pool.query(`
            SELECT 
                m.role,
                m.text,
                m.created_at
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE c.thread_id = $1
            ORDER BY m.created_at ASC
        `, [threadId]);

        res.json({ ok: true, messages: result.rows });
    } catch (e) {
        console.error("[admin] conversation error:", e);
        res.status(500).json({ error: "Conversation error" });
    }
});

export default router;
