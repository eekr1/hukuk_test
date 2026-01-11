import dotenv from "dotenv";

dotenv.config();

export const PORT = process.env.PORT || 8787;
export const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ASSISTANT_ID = process.env.ASSISTANT_ID;
export const DATABASE_URL = process.env.DATABASE_URL;
export const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
export const HANDOFF_TO = process.env.HANDOFF_TO;
export const EMAIL_FROM = process.env.EMAIL_FROM;
export const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME;
export const REPLY_TO = process.env.REPLY_TO;
export const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
export const SHEETS_WEBHOOK_SECRET = process.env.SHEETS_WEBHOOK_SECRET;
export const BRAND_JSON = process.env.BRAND_JSON;
export const BRANDS_JSON = process.env.BRANDS_JSON;
export const NODE_ENV = process.env.NODE_ENV;
