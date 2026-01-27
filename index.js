import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { PORT } from "./config/env.js";
import { ensureTables } from "./services/db.js";
import chatRoutes from "./routes/chat.js";
import { brevo, sendHandoffEmail, readIncomingMessageJSON } from "./services/mail.js";
import { SendSmtpEmail } from "@getbrevo/brevo";

dotenv.config();

const app = express();
console.log("[boot] node version:", process.version);

/* ==================== App Middleware ==================== */
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Basit request log
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Health + Static
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static("public"));
app.get("/", (_req, res) => res.redirect("/test.html"));

/* ==================== Rate Limit ==================== */
app.use(rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));


import cookieParser from "cookie-parser";
import adminRoutes from "./routes/admin.js";
import adminSourcesRouter from "./routes/admin_sources.js";
import adminStatsRouter from "./routes/admin_stats.js";

/* ==================== Routes ==================== */
app.use(cookieParser()); // Cookie parse et
app.use("/api/chat", chatRoutes);
app.use("/api/admin", adminRoutes); // Admin routes
app.use("/api/admin/sources", adminSourcesRouter);
app.use("/api/stats", adminStatsRouter);

/* ==================== Mail Isolated Test Endpoint (opsiyonel) ==================== */
app.post("/_mail_test", async (req, res) => {
  try {
    const apiKey = process.env.BREVO_API_KEY || "";
    if (!apiKey) throw new Error("BREVO_API_KEY missing");

    const senderEmail = process.env.EMAIL_FROM || "";
    const senderName = process.env.EMAIL_FROM_NAME || "Assistant";
    const toStr = (req.body?.to || process.env.EMAIL_TO || "").trim();

    if (!senderEmail) throw new Error("EMAIL_FROM missing");
    if (!toStr) throw new Error("EMAIL_TO missing (or body.to not provided)");

    const to = toStr
      .split(",")
      .map(e => ({ email: e.trim() }))
      .filter(x => x.email);

    const email = new SendSmtpEmail();
    email.sender = { email: senderEmail, name: senderName };
    email.to = to;
    email.subject = `Brevo HTTP API Test — ${new Date().toISOString()}`;
    email.htmlContent = `<p>Merhaba! Bu mail Brevo HTTP API ile gönderildi.</p>`;
    email.textContent = `Merhaba! Bu mail Brevo HTTP API ile gönderildi.`;

    const resp = await brevo.sendTransacEmail(email);

    // Brevo yanıt gövdesini oku ve messageId çıkar
    const data = await readIncomingMessageJSON(resp);
    const msgId = data?.messageId || data?.messageIds?.[0] || null;

    console.log("[mail][test] send OK — status:",
      resp?.response?.statusCode || 201,
      "messageId:", msgId
    );

    res.status(201).json({ ok: true, messageId: msgId, data });
  } catch (e) {
    const status = e?.response?.status || 400;
    const body = e?.response?.data || { message: e?.message || "unknown error" };

    console.error("[mail][test] error:", status, body);
    res.status(status).json({ ok: false, error: body });
  }
});

/* ==================== Boot ==================== */
await ensureTables().catch((e) => {
  console.error("[db] ensureTables hata:", e);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// (opsiyonel, platforma göre etkisi deÄŸiÅŸir)
server.headersTimeout = 120_000;   // header bekleme
server.requestTimeout = 0;          // request toplam sÃ¼resini sÄ±nÄ±rsÄ±z yap (Node 18+)
server.keepAliveTimeout = 75_000;   // TCP keep-alive
