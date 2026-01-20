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
    // We can respond immediately "Indexing started" or await it.
    // Since user wants to see "Indexing..." spinner, let's await it or do fire-and-forget.
    // For small pages, awaiting is fine and provides immediate feedback on error.

    try {
        const id = req.params.id;
        const source = await getSourceById(id);
        if (!source) return res.status(404).json({ error: "Source not found" });

        // Update status to indexing
        await updateSourceStatus(id, { status: "indexing" });

        // Start heavyweight process
        // In steps:

        // 1. Fetch
        let html = "";
        try {
            html = await fetchUrlContent(source.url);
        } catch (fetchErr) {
            await updateSourceStatus(id, { status: "error", lastError: fetchErr.message });
            return res.status(400).json({ error: fetchErr.message });
        }

        // 2. Extract
        let text = "";
        try {
            text = await extractMainContent(html, source.url);
            if (text.length < 50) throw new Error("Content too short or empty");
        } catch (parseErr) {
            await updateSourceStatus(id, { status: "error", lastError: parseErr.message });
            return res.status(400).json({ error: parseErr.message });
        }

        // 3. Chunk
        const chunks = chunkText(text);

        // 4. Embed
        let embeddedChunks = [];
        try {
            embeddedChunks = await generateEmbeddings(chunks);
        } catch (embedErr) {
            await updateSourceStatus(id, { status: "error", lastError: embedErr.message });
            return res.status(500).json({ error: embedErr.message });
        }

        // 5. Save (Transaction)
        try {
            // First clear old chunks for this source
            await clearSourceChunks(id);
            // Insert new
            await saveSourceChunks(id, source.brand_key, embeddedChunks);

            // 6. Finish
            await updateSourceStatus(id, { status: "idle", indexed: true });

            return res.json({ success: true, chunks: chunks.length });

        } catch (dbErr) {
            await updateSourceStatus(id, { status: "error", lastError: dbErr.message });
            return res.status(500).json({ error: dbErr.message });
        }

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Fatal indexing error" });
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
