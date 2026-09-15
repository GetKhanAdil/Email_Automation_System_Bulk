import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import db from "../db/database.js";
import { renderTemplate, sendOne, markdownToHtml } from "../mailer.js";
import { getSettings } from "../db/settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Attachments are stored in /attachments
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "attachments"),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// In-memory control flags per batch (cancel / running state)
const batchControl = new Map();

// Batch IDs currently being processed — prevents concurrent duplicate sends.
const runningBatches = new Set();

function recipientEmail(row = {}) {
  return String(row.email || row.hr_email || row.company_email || "").trim().toLowerCase();
}

function templateExtra(settings) {
  return {
    ...settings,
    signature: settings.signature || "",
    college_name: settings.college_name || settings.college || "",
    college_location: settings.college_location || "",
    placement_officer: settings.placement_officer || settings.sender_name || "",
    contact_number: settings.contact_number || "",
    brochure_link: settings.brochure_link || "",
  };
}

function upsertCompanyFromRow(row = {}) {
  const email = recipientEmail(row);
  const companyName = row.company_name || row.company || "";
  if (!email || !companyName) return;

  db.prepare(`
    INSERT INTO companies (
      company_name, hr_name, designation, hr_email, phone, website, linkedin,
      industry, city, state, country, status, follow_up_date, meeting_date,
      meeting_link, student_count, job_role, brochure_link, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hr_email) DO UPDATE SET
      company_name = excluded.company_name,
      hr_name = COALESCE(NULLIF(excluded.hr_name, ''), companies.hr_name),
      designation = COALESCE(NULLIF(excluded.designation, ''), companies.designation),
      phone = COALESCE(NULLIF(excluded.phone, ''), companies.phone),
      website = COALESCE(NULLIF(excluded.website, ''), companies.website),
      linkedin = COALESCE(NULLIF(excluded.linkedin, ''), companies.linkedin),
      industry = COALESCE(NULLIF(excluded.industry, ''), companies.industry),
      city = COALESCE(NULLIF(excluded.city, ''), companies.city),
      state = COALESCE(NULLIF(excluded.state, ''), companies.state),
      country = COALESCE(NULLIF(excluded.country, ''), companies.country),
      follow_up_date = COALESCE(NULLIF(excluded.follow_up_date, ''), companies.follow_up_date),
      meeting_date = COALESCE(NULLIF(excluded.meeting_date, ''), companies.meeting_date),
      meeting_link = COALESCE(NULLIF(excluded.meeting_link, ''), companies.meeting_link),
      student_count = COALESCE(NULLIF(excluded.student_count, ''), companies.student_count),
      job_role = COALESCE(NULLIF(excluded.job_role, ''), companies.job_role),
      brochure_link = COALESCE(NULLIF(excluded.brochure_link, ''), companies.brochure_link),
      notes = COALESCE(NULLIF(excluded.notes, ''), companies.notes),
      updated_at = datetime('now')
  `).run(
    companyName,
    row.hr_name || row.contact_name || "",
    row.designation || "",
    email,
    row.phone || row.contact_number || "",
    row.website || row.company_website || "",
    row.linkedin || "",
    row.industry || "",
    row.city || "",
    row.state || "",
    row.country || "",
    row.follow_up_date || "",
    row.meeting_date || "",
    row.meeting_link || "",
    row.student_count || "",
    row.job_role || row.role || "",
    row.brochure_link || "",
    row.notes || ""
  );
}

function markCompanyContacted(email) {
  db.prepare(`
    UPDATE companies
    SET last_contact_date = date('now'),
        status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END,
        updated_at = datetime('now')
    WHERE hr_email = ?
  `).run(email);
}

/**
 * Attachments for one history row.
 * The DB column is authoritative; the in-memory batch Map is only a fallback
 * for rows queued before this column existed.
 */
function rowAttachments(item, fallback = []) {
  if (!item.attachments) return fallback;
  try {
    const parsed = JSON.parse(item.attachments);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// ---- Upload attachments (returns stored paths) ----
router.post("/attachments", upload.array("files", 20), (req, res) => {
  const files = (req.files || []).map((f) => ({
    filename: f.originalname,
    path: f.path,
    storedName: f.filename,
  }));
  res.json({ files });
});

/**
 * Preview: render subject+body for each row without sending.
 * body: { templateId, rows }
 */
router.post("/preview", (req, res) => {
  const { templateId, rows = [] } = req.body;
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
  if (!tpl) return res.status(404).json({ error: "Template not found" });
  const s = getSettings();

  const preview = rows.slice(0, 200).map((row) => {
    const body = renderTemplate(tpl.body, row, templateExtra(s));
    return {
      email: recipientEmail(row),
      student_name: row.student_name || row.hr_name || "",
      subject: renderTemplate(tpl.subject, row, templateExtra(s)),
      body,
      // Exactly what the recipient's mail client will render, so the preview
      // isn't showing raw ** markers for text that will arrive bold.
      bodyHtml: markdownToHtml(body),
    };
  });
  res.json({ preview, count: rows.length });
});

/**
 * Which of these recipients have already been mailed recently?
 * body: { rows, days }  ->  { duplicates: [{ email, company, last_sent_at, times }] }
 *
 * Called before queueing so the coordinator can decide what to do. Mailing the
 * same HR contact twice in a few weeks is how a placement cell gets ignored —
 * and on a shared mailbox it is easy to do by accident, because another
 * coordinator may have already contacted them.
 */
router.post("/check-duplicates", (req, res) => {
  const { rows = [], days = 30 } = req.body;
  if (!rows.length) return res.json({ duplicates: [] });

  const lookup = db.prepare(
    `SELECT email, company, MAX(sent_at) AS last_sent_at, COUNT(*) AS times
     FROM history
     WHERE lower(email) = ?
       AND status = 'sent'
       AND sent_at IS NOT NULL
       AND julianday('now') - julianday(sent_at) <= ?
     GROUP BY lower(email)`
  );

  const seen = new Set();
  const duplicates = [];

  for (const row of rows) {
    const email = recipientEmail(row);
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const hit = lookup.get(email, Number(days));
    if (hit) {
      duplicates.push({
        email,
        company: row.company_name || row.company || hit.company || "",
        last_sent_at: hit.last_sent_at,
        times: hit.times,
        days_ago: Math.floor(
          (Date.now() - new Date(hit.last_sent_at.replace(" ", "T") + "Z")) / 86400000
        ),
      });
    }
  }

  res.json({ duplicates, checked: seen.size, days: Number(days) });
});

/**
 * How many sends are left today.
 * The cap is the whole account's daily ceiling (shared by all coordinators),
 * so this counts every 'sent' row today, not just the current user's.
 */
function sentToday() {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM history WHERE status = 'sent' AND date(sent_at) = date('now','localtime')"
    )
    .get().n;
}

function dailyCap() {
  const s = getSettings();
  const n = parseInt(s.daily_limit, 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

router.get("/quota", (req, res) => {
  const cap = dailyCap();
  const used = sentToday();
  res.json({ cap, used, remaining: Math.max(0, cap - used) });
});

/**
 * Queue a batch. body: { templateId, rows, attachments, scheduledAt }
 * Creates history entries with status 'pending' and returns batchId.
 */
router.post("/queue", (req, res) => {
  const { templateId, rows = [], attachments = [], scheduledAt: rawSchedule = null } = req.body;

  // datetime-local gives "2026-07-28T15:05". SQLite's datetime() wants
  // "2026-07-28 15:05:00" — without this the scheduler's comparison never
  // matches and the mail sits pending forever.
  const scheduledAt = rawSchedule
    ? rawSchedule.replace("T", " ").slice(0, 16) + ":00"
    : null;
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
  if (!tpl) return res.status(404).json({ error: "Template not found" });
  if (!rows.length) return res.status(400).json({ error: "No recipients" });

  const s = getSettings();
  const batchId = randomUUID();
  const attachmentsJson = attachments.length ? JSON.stringify(attachments) : null;
  const remainingToday = Math.max(0, dailyCap() - sentToday());
  const insert = db.prepare(`
    INSERT INTO history (student_name, email, company, role, subject, body, status, template_id, batch_id, scheduled_at, in_reply_to, attachments)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const body = renderTemplate(tpl.body, row, templateExtra(s));
      const subject = renderTemplate(tpl.subject, row, templateExtra(s));
      const email = recipientEmail(row);
      upsertCompanyFromRow(row);
      insert.run(
        row.student_name || row.hr_name || "",
        email,
        row.company_name || row.company || "",
        row.job_role || row.role || "",
        subject,
        body,
        templateId,
        batchId,
        scheduledAt,
        row.__in_reply_to || null,
        attachmentsJson
      );
    }
  });
  tx();

  // Store attachments association on the batch (in-memory + we pass at send time)
  batchControl.set(batchId, { cancelled: false, attachments });

  res.status(201).json({
    batchId,
    queued: rows.length,
    scheduledAt,
    remainingToday, // how many of these can actually go out today
    cappedToday: !scheduledAt && rows.length > remainingToday,
  });
});

/**
 * Process a batch now (streams progress via SSE).
 * GET /send/process/:batchId
 */
router.get("/process/:batchId", async (req, res) => {
  const { batchId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const control = batchControl.get(batchId) || { cancelled: false, attachments: [] };
  batchControl.set(batchId, control);
  const attachments = control.attachments || [];

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // GUARD 1 — one processor per batch.
  // EventSource reconnects on its own, and the Resume button opens a second
  // stream. Without this, two loops read the same 'pending' rows and every
  // recipient gets the mail twice.
  if (runningBatches.has(batchId)) {
    send("error", { message: "This batch is already being sent." });
    return res.end();
  }
  runningBatches.add(batchId);

  // GUARD 2 — stop work if the browser goes away, instead of sending into the void.
  let aborted = false;
  req.on("close", () => { aborted = true; });

  const pending = db
    .prepare("SELECT * FROM history WHERE batch_id = ? AND status IN ('pending','failed') ORDER BY id ASC")
    .all(batchId);

  // Daily cap: send only up to today's remaining allowance. The rest stay
  // 'pending' in this same batch, ready to continue tomorrow (or when the user
  // resumes) — this is the "store the leftovers" behaviour.
  const cap = dailyCap();
  const already = sentToday();
  let budget = Math.max(0, cap - already);

  send("start", { total: pending.length, budget, cap });

  if (budget <= 0) {
    send("capped", { sent: 0, held: pending.length, cap });
    runningBatches.delete(batchId);
    return res.end();
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    if (batchControl.get(batchId)?.cancelled) {
      send("cancelled", { sent, failed, remaining: pending.length - i });
      runningBatches.delete(batchId);
      res.end();
      return;
    }

    if (aborted) break;

    // Out of today's allowance — leave the rest pending for next time.
    if (budget <= 0) {
      send("capped", { sent, held: pending.length - i, cap });
      break;
    }

    const item = pending[i];

    // GUARD 3 — claim the row atomically. If another process already moved it
    // out of 'pending', changes === 0 and we skip instead of sending twice.
    const claimed = db
      .prepare(
        "UPDATE history SET status = 'sending' WHERE id = ? AND status IN ('pending','failed')"
      )
      .run(item.id);
    if (claimed.changes === 0) continue;

    send("progress", { index: i + 1, total: pending.length, email: item.email, status: "sending" });

    try {
      const result = await sendOne({
        to: item.email,
        subject: item.subject,
        body: item.body,
        attachments: rowAttachments(item, attachments),
        inReplyTo: item.in_reply_to || null,
      });
      markCompanyContacted(item.email);
      db.prepare(
        `UPDATE history
         SET status = 'sent', sent_at = datetime('now'), error = NULL, message_id = ?
         WHERE id = ?`
      ).run(result?.messageId || null, item.id);
      budget--;
      sent++;
      send("progress", { index: i + 1, total: pending.length, email: item.email, status: "sent" });
    } catch (err) {
      db.prepare("UPDATE history SET status = 'failed', error = ? WHERE id = ?").run(
        err.message,
        item.id
      );
      failed++;
      send("progress", {
        index: i + 1,
        total: pending.length,
        email: item.email,
        status: "failed",
        error: err.message,
      });
    }

    // Delay between emails to be gentle on Gmail rate limits / reduce spam flags
    await new Promise((r) => setTimeout(r, 2000));
  }

  runningBatches.delete(batchId);
  send("done", { sent, failed, total: pending.length });
  res.end();
});

/**
 * Batches that are queued but not sent yet.
 * Grouped by batch so the UI can cancel or move the whole send in one action.
 */
router.get("/scheduled", (req, res) => {
  const rows = db
    .prepare(
      `SELECT h.batch_id,
              h.scheduled_at,
              COUNT(*)                                   AS total,
              SUM(h.status = 'pending')                  AS pending,
              SUM(h.status = 'sent')                     AS sent,
              MIN(h.subject)                             AS subject,
              t.name                                     AS template_name,
              GROUP_CONCAT(DISTINCT h.company)           AS companies
       FROM history h
       LEFT JOIN templates t ON t.id = h.template_id
       WHERE h.scheduled_at IS NOT NULL
         AND h.status = 'pending'
       GROUP BY h.batch_id, h.scheduled_at
       ORDER BY h.scheduled_at ASC`
    )
    .all();
  res.json(rows);
});

/**
 * Cancel a scheduled batch. Only rows still waiting are cancelled — anything
 * already sent stays in history, because it genuinely went out.
 */
router.post("/scheduled/:batchId/cancel", (req, res) => {
  const result = db
    .prepare("UPDATE history SET status = 'cancelled' WHERE batch_id = ? AND status = 'pending'")
    .run(req.params.batchId);

  const control = batchControl.get(req.params.batchId);
  if (control) control.cancelled = true;

  res.json({ ok: true, cancelled: result.changes });
});

/** Move a scheduled batch to a different time. */
router.post("/scheduled/:batchId/reschedule", (req, res) => {
  const { scheduledAt } = req.body || {};
  if (!scheduledAt) return res.status(400).json({ error: "scheduledAt is required" });

  const result = db
    .prepare(
      "UPDATE history SET scheduled_at = ? WHERE batch_id = ? AND status = 'pending'"
    )
    .run(scheduledAt, req.params.batchId);
  res.json({ ok: true, moved: result.changes });
});

/** Undo a cancel, as long as nothing has been sent in the meantime. */
router.post("/scheduled/:batchId/restore", (req, res) => {
  const result = db
    .prepare("UPDATE history SET status = 'pending' WHERE batch_id = ? AND status = 'cancelled'")
    .run(req.params.batchId);
  res.json({ ok: true, restored: result.changes });
});

/**
 * Cancel individual queued rows (used from the History page).
 * body: { ids: [1,2,3] }
 * Only rows still waiting can be cancelled — 'sent' rows are left untouched.
 */
router.post("/rows/cancel", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "No rows selected" });

  const stmt = db.prepare(
    "UPDATE history SET status = 'cancelled' WHERE id = ? AND status IN ('pending','failed')"
  );
  let cancelled = 0;
  db.transaction(() => {
    for (const id of ids) cancelled += stmt.run(id).changes;
  })();

  res.json({ ok: true, cancelled, skipped: ids.length - cancelled });
});

/** Put cancelled rows back in the queue. */
router.post("/rows/restore", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "No rows selected" });

  const stmt = db.prepare(
    "UPDATE history SET status = 'pending' WHERE id = ? AND status = 'cancelled'"
  );
  let restored = 0;
  db.transaction(() => {
    for (const id of ids) restored += stmt.run(id).changes;
  })();

  res.json({ ok: true, restored });
});

/**
 * Batches with recipients still waiting (held by the daily cap or not yet run).
 * Immediate sends only — scheduled batches have their own panel.
 */
router.get("/pending-batches", (req, res) => {
  const rows = db
    .prepare(
      `SELECT h.batch_id,
              COUNT(*)                        AS total,
              SUM(h.status = 'pending')       AS pending,
              SUM(h.status = 'sent')          AS sent,
              MIN(h.created_at)               AS created_at,
              MIN(h.subject)                  AS subject,
              t.name                          AS template_name,
              GROUP_CONCAT(DISTINCT h.company) AS companies
       FROM history h
       LEFT JOIN templates t ON t.id = h.template_id
       WHERE h.scheduled_at IS NULL
       GROUP BY h.batch_id
       HAVING pending > 0
       ORDER BY created_at DESC`
    )
    .all();
  res.json(rows);
});

// Cancel a running batch
router.post("/cancel/:batchId", (req, res) => {
  const c = batchControl.get(req.params.batchId);
  if (c) c.cancelled = true;
  res.json({ ok: true });
});

// Resume: clear cancel flag (re-run process endpoint to continue pending)
router.post("/resume/:batchId", (req, res) => {
  const c = batchControl.get(req.params.batchId) || { attachments: [] };
  c.cancelled = false;
  batchControl.set(req.params.batchId, c);
  res.json({ ok: true });
});

// Retry all failed (optionally in a batch)
router.post("/retry", (req, res) => {
  const { batchId } = req.body;
  if (batchId) {
    db.prepare("UPDATE history SET status = 'pending' WHERE batch_id = ? AND status = 'failed'").run(batchId);
  } else {
    db.prepare("UPDATE history SET status = 'pending' WHERE status = 'failed'").run();
  }
  res.json({ ok: true });
});

export default router;