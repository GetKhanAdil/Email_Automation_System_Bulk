import db from "./db/database.js";
import { sendOne } from "./mailer.js";

/**
 * Background scheduler: every 30 seconds, finds emails whose scheduled_at is
 * due and still pending, then sends them.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. setInterval does not wait for an async callback. A batch of 20 emails
 *    takes 40+ seconds (2s pause each), so the next tick fires while the
 *    previous one is still working. Both ticks then read the same rows, which
 *    are still 'pending', and every recipient gets the mail two, three, or
 *    more times depending on how many ticks overlap. `running` prevents that.
 *
 * 2. Claiming a row must be atomic. `UPDATE ... WHERE id = ? AND status =
 *    'pending'` returns changes === 0 if anything else already took it, which
 *    is what stops the SSE send path and this scheduler from both sending the
 *    same row.
 */

const TICK_MS = 30_000;
const BATCH_LIMIT = 20;
const DELAY_MS = 2000;
const STUCK_AFTER_MINUTES = 15;

let running = false;

/**
 * Rows left in 'sending' after a crash or restart would otherwise sit there
 * forever. Put them back to 'pending' so the next tick retries them.
 */
function requeueStuckRows() {
  const res = db
    .prepare(
      `UPDATE history
       SET status = 'pending'
       WHERE status = 'sending'
         AND scheduled_at IS NOT NULL
         AND datetime(created_at) <= datetime('now', '-${STUCK_AFTER_MINUTES} minutes')` // created_at is UTC, so compare against UTC now
    )
    .run();
  if (res.changes) {
    console.log(`  [scheduler] requeued ${res.changes} stuck row(s)`);
  }
}

function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // malformed JSON — send without attachments rather than failing
  }
}

async function tick() {
  if (running) return; // previous tick still working
  running = true;

  try {
    requeueStuckRows();

    const due = db
      .prepare(
        `SELECT * FROM history
         WHERE status = 'pending'
           AND scheduled_at IS NOT NULL
           AND datetime(scheduled_at) <= datetime('now', 'localtime')
         ORDER BY scheduled_at ASC
         LIMIT ${BATCH_LIMIT}`
      )
      .all();

    if (!due.length) return;

    const claim = db.prepare(
      "UPDATE history SET status = 'sending' WHERE id = ? AND status = 'pending'"
    );

    for (const item of due) {
      // If anything else already took this row, skip it — never send twice.
      if (claim.run(item.id).changes === 0) continue;

      try {
        const result = await sendOne({
          to: item.email,
          subject: item.subject,
          body: item.body,
          attachments: parseAttachments(item.attachments),
          inReplyTo: item.in_reply_to || null,
        });

        db.prepare(
          `UPDATE history
           SET status = 'sent', sent_at = datetime('now'), error = NULL, message_id = ?
           WHERE id = ?`
        ).run(result?.messageId || null, item.id);

        db.prepare(
          `UPDATE companies
           SET last_contact_date = date('now'),
               status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END,
               updated_at = datetime('now')
           WHERE hr_email = ?`
        ).run(item.email);
      } catch (err) {
        db.prepare("UPDATE history SET status = 'failed', error = ? WHERE id = ?").run(
          err.message,
          item.id
        );
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  } catch (err) {
    console.error("  [scheduler]", err.message);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setInterval(tick, TICK_MS);
  console.log("  Scheduler started (checks every 30s for due emails)");
}