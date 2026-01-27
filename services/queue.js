/* ================== SIMPLE MEMORY QUEUE ================== */
import { getSourceById, updateSourceStatus, clearSourceChunks, saveSourceChunks } from "./db.js";
import { fetchUrlContent, extractMainContent, chunkText, generateEmbeddings } from "./rag.js";

class ScraperQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    add(sourceId) {
        // Zaten kuyrukta varsa tekrar ekleme
        if (this.queue.includes(sourceId)) {
            console.log(`[queue] Source ${sourceId} already in queue.`);
            return;
        }
        this.queue.push(sourceId);
        console.log(`[queue] Source ${sourceId} added. Queue length: ${this.queue.length}`);
        this.processNext();
    }

    async processNext() {
        if (this.processing) return;
        if (this.queue.length === 0) return;

        this.processing = true;
        const sourceId = this.queue.shift();

        try {
            await this.executeJob(sourceId);
        } catch (e) {
            console.error(`[queue] Job failed for ${sourceId}:`, e);
            // Hata durumunu DB'ye yaz
            try {
                await updateSourceStatus(sourceId, { status: "error", lastError: e.message });
            } catch (_) { }
        } finally {
            this.processing = false;
            // Bir sonraki işe geç
            setTimeout(() => this.processNext(), 1000); // 1 sn soğuma
        }
    }

    async executeJob(id) {
        console.log(`[queue] Processing ${id}...`);

        // 1. Kaynağı Getir
        const source = await getSourceById(id);
        if (!source) throw new Error("Source deleted or not found");

        // Durumu güncelle: indexing
        await updateSourceStatus(id, { status: "indexing" });

        // 2. Fetch
        let html = "";
        try {
            html = await fetchUrlContent(source.url);
        } catch (fetchErr) {
            throw new Error(`Fetch failed: ${fetchErr.message}`);
        }

        // 3. Extract
        let text = "";
        try {
            text = await extractMainContent(html, source.url);
            if (!text || text.length < 50) throw new Error("Content too short or empty");
        } catch (parseErr) {
            throw new Error(`Parse failed: ${parseErr.message}`);
        }

        // 4. Chunk
        const chunks = chunkText(text);
        if (!chunks.length) throw new Error("No chunks generated");

        // 5. Embed
        let embeddedChunks = [];
        try {
            embeddedChunks = await generateEmbeddings(chunks);
        } catch (embedErr) {
            throw new Error(`Embedding failed: ${embedErr.message}`);
        }

        // 6. DB Transaction
        await clearSourceChunks(id);
        await saveSourceChunks(id, source.brand_key, embeddedChunks);

        // 7. Finish
        await updateSourceStatus(id, { status: "idle", indexed: true });
        console.log(`[queue] Finished ${id}. Chunks: ${chunks.length}`);
    }
}

// Global singleton instance
export const scraperQueue = new ScraperQueue();
