import axios from "axios";
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { searchVectors } from "./db.js";
import puppeteer from "puppeteer";

/* ================== CONSTANTS ================== */
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"; // Cheap & fast

// Basic blocking of private ranges to prevent SSRF
function isPrivateIP(ip) {
    return (
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|0\.|169\.254\.|localhost)/.test(ip)
    );
}

/* ================== 1. FETCHER (PUPPETEER) ================== */
export async function fetchUrlContent(url) {
    let browser;
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new Error("Invalid protocol (http/https only)");
        }
        if (isPrivateIP(u.hostname)) {
            throw new Error("Private IP/Localhost not allowed");
        }

        // Launch Puppeteer (Headless Chrome)
        // Args needed for some container environments (like Render/Docker)
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        // Set User Agent to standard Chrome
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

        // Set minimal headers to look legit
        await page.setExtraHTTPHeaders({
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"
        });

        // Navigate
        // waitUntil: 'networkidle2' means wait until at most 2 connections are open (good for SPAs)
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

        // Get full HTML
        const html = await page.content();
        return html;

    } catch (e) {
        throw new Error(`Fetch failed: ${e.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

/* ================== 2. CLEANER ================== */
export async function extractMainContent(html, url) {
    try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        // Fallback if readability fails
        if (!article || !article.textContent) {
            const $ = cheerio.load(html);
            $("script, style, nav, footer, header, aside").remove();
            return $("body").text().replace(/\s+/g, " ").trim();
        }

        return article.textContent.replace(/\s+/g, " ").trim();
    } catch (e) {
        throw new Error(`Parsing failed: ${e.message}`);
    }
}

/* ================== 3. CHUNKER ================== */
export function chunkText(text) {
    if (!text) return [];

    // Simple overlapping character window
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        let slice = text.slice(start, end);

        chunks.push(slice);

        if (end >= text.length) break;
        start += (CHUNK_SIZE - CHUNK_OVERLAP);
    }
    return chunks;
}

/* ================== 4. EMBEDDER ================== */
export async function generateEmbeddings(textChunks) {
    if (!textChunks || !textChunks.length) return [];

    // OpenAI embedding endpoint usually accepts array of inputs
    // We'll process in batches of 20 to be safe
    const BATCH_SIZE = 20;
    const results = [];

    for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
        const batch = textChunks.slice(i, i + BATCH_SIZE);

        try {
            const resp = await axios.post("https://api.openai.com/v1/embeddings", {
                input: batch,
                model: OPENAI_EMBEDDING_MODEL
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
                }
            });

            const data = resp.data;
            // data.data is array of objects { embedding: [...], index: ... }
            // We match them back to batch
            data.data.forEach((item, idx) => {
                results.push({
                    text: batch[idx],
                    embedding: item.embedding
                });
            });
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message;
            throw new Error(`OpenAI Embedding Error: ${errMsg}`);
        }
    }

    return results;
}

/* ================== 5. SEARCHER ================== */
// High-level search function used by API
export async function searchSimilarChunks(brandKey, query) {
    // 1. Embed query
    const [embeddedQuery] = await generateEmbeddings([query]);
    if (!embeddedQuery) return [];

    // 2. Search DB (Cosine Similarity)
    const candidates = await searchVectors(brandKey, embeddedQuery.embedding, 6);

    return candidates.map(c => ({
        content: c.content,
        score: c.score,
        url: c.url
    }));
}
