import axios from "axios";
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { searchVectors } from "./db.js";
import http from "http";
import https from "https";

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

/* ================== 1. FETCHER ================== */
export async function fetchUrlContent(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new Error("Invalid protocol (http/https only)");
        }
        if (isPrivateIP(u.hostname)) {
            throw new Error("Private IP/Localhost not allowed");
        }

        const resp = await axios.get(url, {
            timeout: 15000, // 15s timeout
            maxContentLength: 5 * 1024 * 1024, // 5MB max
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                "Accept-Encoding": "gzip, deflate, br", // Axios handles decoding automatically
                "Cache-Control": "max-age=0",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"Windows"',
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1"
            },
            httpAgent: new http.Agent({ family: 4 }),
            httpsAgent: new https.Agent({ family: 4 }),
            validateStatus: (status) => status < 400
        });

        return resp.data; // HTML content
    } catch (e) {
        throw new Error(`Fetch failed: ${e.message}`);
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
