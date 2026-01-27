import express from "express";
import { getDashboardStats } from "../services/db.js";

const router = express.Router();

// GET /api/stats?brand=xxx
router.get("/", async (req, res) => {
    try {
        const brandKey = req.query.brand || null;

        // Admin yetkisi kontrolü burada yapılabilir (session vs.)
        // Şimdilik açık bırakıyoruz.

        const stats = await getDashboardStats(brandKey);

        return res.json({
            success: true,
            stats
        });
    } catch (e) {
        console.error("[stats] error:", e);
        return res.status(500).json({ error: "Failed to fetch stats" });
    }
});

export default router;
