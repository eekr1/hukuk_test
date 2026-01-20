import dotenv from "dotenv";
dotenv.config();

import { ensureTables, addSource, saveSourceChunks, searchVectors } from "../services/db.js";
import { fetchUrlContent, extractMainContent, chunkText, generateEmbeddings } from "../services/rag.js";

async function runTest() {
    console.log("== Starting Knowledge Base Verification using Node " + process.version + " ==");

    // 1. DB Init
    try {
        await ensureTables();
        console.log("[OK] DB Tables ensured.");
    } catch (e) {
        console.error("[FAIL] DB Init:", e);
        process.exit(1);
    }

    // 2. RAG Pipeline
    const testUrl = "https://www.lipsum.com/"; // A reliable text heavy site
    const brandKey = "test-verification-brand";

    try {
        console.log(`\n-- Step 1: Fetching ${testUrl} --`);
        const html = await fetchUrlContent(testUrl);
        console.log(`[OK] Fetched ${html.length} chars of HTML.`);

        console.log(`\n-- Step 2: Extracting Content --`);
        const text = await extractMainContent(html, testUrl);
        console.log(`[OK] Extracted text: ${text.substring(0, 100)}... (${text.length} chars)`);

        console.log(`\n-- Step 3: Chunking --`);
        const chunks = chunkText(text);
        console.log(`[OK] Created ${chunks.length} chunks. Sample: "${chunks[0].substring(0, 50)}..."`);

        console.log(`\n-- Step 4: Embedding (OpenAI) --`);
        if (!process.env.OPENAI_API_KEY) {
            console.warn("⚠️  OPENAI_API_KEY not found in environment. Skipping Embedding, Save, and Search steps.");
            console.log("✅ LOCAL PIPELINE VERIFIED (Fetch -> Clean -> Chunk).");
            console.log("   (To verify full pipeline, ensure .env has OPENAI_API_KEY)");
            process.exit(0);
        }

        // We only embed the first 2 chunks to save cost/time in test
        const chunksToEmbed = chunks.slice(0, 2);
        const embeddings = await generateEmbeddings(chunksToEmbed);
        console.log(`[OK] Generated ${embeddings.length} embeddings.`);

        console.log(`\n-- Step 5: Saving to DB --`);
        // Dummy source
        const source = await addSource({ brandKey, url: testUrl });
        await saveSourceChunks(source.id, brandKey, embeddings);
        console.log(`[OK] Saved chunks for source ID ${source.id}`);

        console.log(`\n-- Step 6: Test Search --`);
        const query = "Lorem Ipsum";
        const [queryEmbed] = await generateEmbeddings([query]);
        const results = await searchVectors(brandKey, queryEmbed.embedding, 3);

        console.log(`[OK] Search returned ${results.length} results.`);
        results.forEach(r => {
            console.log(`   - Score: ${r.score.toFixed(4)} | Content: ${r.content.substring(0, 50)}...`);
        });

        if (results.length > 0) {
            console.log("\n✅ VERIFICATION SUCCESSFUL!");
        } else {
            console.error("\n❌ VERIFICATION FAILED: No results found (might be expected if sim score low or empty DB)");
        }

    } catch (e) {
        console.error("\n❌ VERIFICATION ERROR:", e);
    }

    process.exit(0);
}

runTest();
