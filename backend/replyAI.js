import { chat } from "./groq.js";
import db from "./db/database.js";

/** Reply intelligence: classify a reply + draft a suggested response. Cached per reply text. */

const CATEGORIES = ["interested", "declined", "needs_info", "auto_reply", "other"];

const CLASSIFY_SYSTEM = `You classify a company HR's reply to a university
placement-drive invitation into exactly one category:
- interested : positive, wants to proceed, schedule, or share details
- declined   : not hiring, not interested, or a clear no
- needs_info : asking questions or requesting more information
- auto_reply : out-of-office / automated / no human intent
- other      : none of the above
Respond with JSON only: {"category":"<one>","confidence":0-1,"reason":"<short>"}`;

function hashText(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `c${h >>> 0}`;
}

export async function classifyReply(historyId) {
  const row = db.prepare("SELECT * FROM history WHERE id = ?").get(historyId);
  if (!row) throw new Error("Row not found");
  const text = row.reply_body || row.reply_snippet;
  if (!text) throw new Error("No reply text to classify");

  const key = hashText(text);
  if (row.reply_category && row.reply_cache_key === key) {
    return { category: row.reply_category, cached: true };
  }

  const raw = await chat(
    [{ role: "system", content: CLASSIFY_SYSTEM }, { role: "user", content: `Reply:\n"""${text.slice(0, 4000)}"""` }],
    { temperature: 0, maxTokens: 120, json: true }
  );
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { category: "other", confidence: 0 }; }
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : "other";

  db.prepare("UPDATE history SET reply_category = ?, reply_cache_key = ? WHERE id = ?").run(category, key, historyId);
  return { category, confidence: parsed.confidence, reason: parsed.reason, cached: false };
}

const DRAFT_SYSTEM = `You draft a placement coordinator's reply to a company HR,
continuing an email thread about a campus recruitment drive.
Rules:
- Match the HR's intent. Interested -> propose a short call or share dates. Asked something -> answer briefly, offer the brochure. Declined -> polite, leave the door open.
- 3-5 sentences. Professional, warm, concise. Plain text. No subject, no placeholders, no markdown.
- Sign off as "Placement Cell, Jamia Millia Islamia".`;

export async function suggestReply(historyId) {
  const row = db.prepare("SELECT * FROM history WHERE id = ?").get(historyId);
  if (!row) throw new Error("Row not found");
  const text = row.reply_body || row.reply_snippet || "";
  return chat(
    [{ role: "system", content: DRAFT_SYSTEM },
     { role: "user", content: `Company: ${row.company || ""}\nOur original subject: ${row.subject || ""}\nTheir reply:\n"""${text.slice(0, 4000)}"""\n\nWrite the suggested reply now.` }],
    { temperature: 0.6, maxTokens: 300 }
  );
}
