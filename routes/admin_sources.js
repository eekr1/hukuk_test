import express from "express";
import {
    getSources,
    addSource,
    toggleSource,
    updateSourceStatus,
    deleteSource,
    getSourceById,
    clearSourceChunks,
    saveSourceChunks
} from "../services/db.js";
import {
    fetchUrlContent,
    extractMainContent,
    chunkText,
    generateEmbeddings,
    searchSimilarChunks
} from "../services/rag.js";

const router = express.Router();

// Middleware: Require brandKey (except perhaps for super-admin, but here we assume brand context)
// In a real app, you'd check session/auth here. For now, we trust the query/body params coming from the admin UI.

/* 1. GET / - List sources */
router.get("/", async (req, res) => {
    try {
        const brandKey = req.query.brand_key;
        if (!brandKey) return res.status(400).json({ error: "Missing brand_key" });

        const rows = await getSources(brandKey);
        return res.json({ sources: rows });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to list sources" });
    }
});

/* 2. POST / - Add URL */
router.post("/", async (req, res) => {
    try {
        const { brand_key, url } = req.body;
        if (!brand_key || !url) return res.status(400).json({ error: "Missing brand_key or url" });

        const newSource = await addSource({ brandKey: brand_key, url });
        return res.json(newSource);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to add source" });
    }
});

/* 3. PATCH /:id - Toggle enabled */
router.patch("/:id", async (req, res) => {
    try {
        const { enabled } = req.body;
        // id is UUID
        const updated = await toggleSource(req.params.id, enabled);
        return res.json(updated);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to update source" });
    }
});

/* 3.1. DELETE /:id - Remove source */
router.delete("/:id", async (req, res) => {
    try {
        await deleteSource(req.params.id);
        return res.json({ success: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to delete source" });
    }
});

/* 4. POST /:id/index - Trigger Indexing */
router.post("/:id/index", async (req, res) => {
    try {
        const id = req.params.id;
        const source = await getSourceById(id);
        if (!source) return res.status(404).json({ error: "Source not found" });

        // Update status to 'pending' immediately
        await updateSourceStatus(id, { status: "pending" });

        // Add to Queue (Fire & Forget)
        const { scraperQueue } = await import("../services/queue.js");
        scraperQueue.add(id);

        return res.json({ success: true, message: "Queued for indexing" });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to queue job" });
    }
});

/* 5. GET /search - Test Semantic Search */
router.get("/search", async (req, res) => {
    try {
        const { brand_key, q } = req.query;
        if (!brand_key || !q) return res.status(400).json({ error: "Missing params" });

        const results = await searchSimilarChunks(brand_key, q);
        return res.json({ results });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
});

export default router;
