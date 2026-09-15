import { Router } from "express";
import db from "../db/database.js";
import { getSettings } from "../db/settings.js";
import { generateMany } from "../aiIntro.js";
import { hasKeys } from "../groq.js";
import { classifyReply, suggestReply } from "../replyAI.js";

const router = Router();

function batchLine() {
  const s = getSettings();
  return s.batch_description || "graduating students skilled in AI, ML and software engineering";
}

// Generate AI intros for review (nothing sent, nothing committed).
router.post("/generate-intros", async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "No recipients" });
  if (!hasKeys()) return res.status(400).json({ error: "No Groq API key. Add GROQ_KEYS in .env or a key in Settings." });

  const companies = rows.map((r) => ({
    email: r.email || r.hr_email || "",
    name: r.company_name || r.company || "",
    info: r.company_info || "",
    role: r.job_role || r.role || "",
    website: r.website || "",
  }));

  try {
    const out = await generateMany(companies, batchLine(), { concurrency: 3 });
    res.json({
      intros: out.map((o) => ({ email: o.email, name: o.name, ai_intro: o.ai_intro, error: o.error })),
      failures: out.filter((o) => o.error).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/classify/:id", async (req, res) => {
  try { res.json({ ok: true, ...(await classifyReply(req.params.id)) }); }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

router.post("/classify-pending", async (req, res) => {
  const rows = db.prepare(
    `SELECT id FROM history WHERE replied_at IS NOT NULL AND (reply_category IS NULL OR reply_category = '') LIMIT 50`
  ).all();
  let done = 0; const errors = [];
  for (const r of rows) {
    try { await classifyReply(r.id); done++; }
    catch (err) { errors.push({ id: r.id, error: err.message }); }
  }
  res.json({ ok: true, classified: done, errors });
});

router.post("/suggest-reply/:id", async (req, res) => {
  try { res.json({ ok: true, draft: await suggestReply(req.params.id) }); }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

export default router;