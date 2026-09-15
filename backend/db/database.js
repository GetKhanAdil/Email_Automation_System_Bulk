import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "email_automation.db"));

db.pragma("journal_mode = WAL");

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT,
    email TEXT NOT NULL,
    company TEXT,
    role TEXT,
    subject TEXT,
    body TEXT,
    status TEXT DEFAULT 'pending',   -- pending | sending | sent | failed
    error TEXT,
    template_id INTEGER,
    batch_id TEXT,
    scheduled_at TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    hr_name TEXT,
    designation TEXT,
    hr_email TEXT NOT NULL UNIQUE,
    phone TEXT,
    website TEXT,
    linkedin TEXT,
    industry TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    status TEXT DEFAULT 'New',
    last_contact_date TEXT,
    last_reply_date TEXT,
    follow_up_date TEXT,
    meeting_date TEXT,
    meeting_link TEXT,
    student_count TEXT,
    job_role TEXT,
    brochure_link TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ---- Migrations: add columns that may be missing on existing databases ----
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`  [migration] added ${table}.${column}`);
  }
}

// SMTP Message-ID returned by nodemailer at send time. This is the key that
// lets an incoming reply be matched back to the exact email we sent.
// Attachment list (JSON) for this row. Persisted per-row so a restart or a
// scheduled send never loses the brochure — the in-memory batch Map is only
// a fast path, never the source of truth.
addColumnIfMissing("history", "attachments", "TEXT");
addColumnIfMissing("history", "message_id", "TEXT");
addColumnIfMissing("history", "replied_at", "TEXT");
addColumnIfMissing("history", "reply_from", "TEXT");
addColumnIfMissing("history", "reply_snippet", "TEXT");
// Full text of the reply, so it can be read (and answered) inside the app.
addColumnIfMissing("history", "reply_body", "TEXT");
// Set when this row is a follow-up — carries the original Message-ID so the
// follow-up threads under the first email instead of starting a new one.
addColumnIfMissing("history", "in_reply_to", "TEXT");
addColumnIfMissing("history", "ai_intro", "TEXT");
addColumnIfMissing("history", "reply_category", "TEXT");
addColumnIfMissing("history", "reply_cache_key", "TEXT");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_history_message_id ON history(message_id);
  CREATE INDEX IF NOT EXISTS idx_history_email       ON history(email);
  CREATE INDEX IF NOT EXISTS idx_history_batch       ON history(batch_id, status);
`);

// ---- Seed default settings if empty ----
const settingsCount = db.prepare("SELECT COUNT(*) AS c FROM settings").get();
if (settingsCount.c === 0) {
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  insert.run("smtp_host", "smtp.gmail.com");
  insert.run("smtp_port", "465");
  insert.run("gmail_user", "");
  insert.run("gmail_app_password", "");
  insert.run("sender_name", "Placement Cell");
  insert.run("signature", "Regards,\nPlacement Cell");
  insert.run("college_name", "");
  insert.run("college_location", "");
  insert.run("placement_officer", "");
  insert.run("contact_number", "");
  insert.run("website", "");
  insert.run("brochure_link", "");
}

const ensureSetting = db.prepare(`
  INSERT INTO settings (key, value)
  SELECT ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)
`);
[
  ["college_name", ""],
  ["college_location", ""],
  ["placement_officer", ""],
  ["contact_number", ""],
  ["website", ""],
  ["brochure_link", ""],
  ["bulk_footer", "off"],
  ["daily_limit", "150"],
  ["groq_api_key", ""],
  ["batch_description", "graduating M.Tech (Applied AI) students skilled in AI, ML, NLP and LLMs"],
].forEach(([key, value]) => ensureSetting.run(key, value, key));

// ---- Seed sample templates if missing ----
const insertTplIfMissing = db.prepare(`
  INSERT INTO templates (name, subject, body)
  SELECT ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM templates WHERE name = ?)
`);

function seedTemplate(name, subject, body) {
  insertTplIfMissing.run(name, subject, body, name);
}

[
  [
    "Interview Shortlist",
    "Interview Opportunity at {{company_name}}",
    `Dear {{student_name}},

Congratulations! You have been shortlisted for the {{job_role}} position at {{company_name}}.

Interview Date: {{deadline}}
Meeting Link: {{meeting_link}}

Please be available 10 minutes before the scheduled time.

{{signature}}`
  ],
  [
    "Application Reminder",
    "Reminder: Apply for {{job_role}} at {{company_name}}",
    `Dear {{student_name}},

This is a gentle reminder to complete your application for the {{job_role}} role at {{company_name}}.

Deadline: {{deadline}}
Apply here: {{meeting_link}}

Do not miss this opportunity!

{{signature}}`
  ],
  [
    "Offer Congratulations",
    "Congratulations! Offer from {{company_name}}",
    `Dear {{student_name}},

We are delighted to inform you that {{company_name}} has extended an offer for the {{job_role}} position.

Please review the details and respond by {{deadline}}.

{{signature}}`
  ],
  [
    "Placement Invitation",
    "Campus Placement Invitation from {{college_name}}",
    `Dear {{hr_name}},

Greetings from {{college_name}}, {{college_location}}.

We would be delighted to invite {{company_name}} to explore campus placement opportunities for our students. We currently have {{student_count}} eligible students across relevant programs and would be happy to share profiles aligned with your hiring needs.

Please let us know a convenient time to discuss your requirements for {{job_role}} roles.

College website: {{website}}
Brochure: {{brochure_link}}

{{signature}}`
  ],
  [
    "Internship Invitation",
    "Internship Collaboration Opportunity with {{college_name}}",
    `Dear {{hr_name}},

I am reaching out from {{college_name}} to request internship opportunities for our students at {{company_name}}.

Our students are available for internships in roles such as {{job_role}}, and we would be glad to coordinate profiles, interviews, and onboarding support from our placement cell.

Please let us know if your team is open to discussing internship requirements.

{{signature}}`
  ],
  [
    "Campus Drive Invitation",
    "Invitation to Conduct a Campus Recruitment Drive",
    `Dear {{hr_name}},

We invite {{company_name}} to conduct a campus recruitment drive at {{college_name}}, {{college_location}}.

Our placement team can support pre-placement talks, student shortlisting, assessments, interviews, and joining coordination. We would be happy to schedule the drive on {{meeting_date}} or another date convenient for your team.

Meeting link: {{meeting_link}}

{{signature}}`
  ],
  [
    "Recruitment Request",
    "Request for Recruitment Partnership with {{company_name}}",
    `Dear {{hr_name}},

I hope you are doing well. I am writing to explore recruitment opportunities between {{company_name}} and {{college_name}}.

We would appreciate the opportunity to share student profiles for {{job_role}} openings and understand your hiring plans for fresh graduates and interns.

Please let us know a suitable time for a brief discussion.

{{signature}}`
  ],
  [
    "Follow-up Email",
    "Follow-up: Placement Collaboration with {{company_name}}",
    `Dear {{hr_name}},

This is a follow-up regarding our previous communication about placement and internship opportunities with {{company_name}}.

We would be grateful if you could let us know whether your team is open to receiving student profiles or scheduling a campus hiring discussion.

{{signature}}`
  ],
  [
    "Reminder Email",
    "Reminder: Campus Hiring Discussion",
    `Dear {{hr_name}},

This is a gentle reminder for our scheduled discussion with {{company_name}} on {{meeting_date}}.

Meeting link: {{meeting_link}}

Please let us know if any change is required.

{{signature}}`
  ],
  [
    "Thank You Email",
    "Thank You from {{college_name}} Placement Cell",
    `Dear {{hr_name}},

Thank you for taking the time to connect with us regarding placement opportunities with {{company_name}}.

We appreciate your interest and look forward to working together for student internships, placements, and future recruitment drives.

{{signature}}`
  ],
  [
    "Meeting Confirmation",
    "Meeting Confirmation with {{college_name}} Placement Cell",
    `Dear {{hr_name}},

This is to confirm our meeting with {{company_name}} on {{meeting_date}}.

Meeting link: {{meeting_link}}

Agenda: placement opportunities, internship roles, student profiles, and possible recruitment partnership.

{{signature}}`
  ],
  [
    "Partnership Proposal",
    "Placement Partnership Proposal from {{college_name}}",
    `Dear {{hr_name}},

We would like to propose a placement partnership between {{company_name}} and {{college_name}}.

The partnership can include campus recruitment drives, internships, industrial visits, guest sessions, and priority sharing of suitable student profiles for {{job_role}} roles.

We would be happy to discuss how our placement cell can support your hiring plans.

{{signature}}`
  ],
].forEach(([name, subject, body]) => seedTemplate(name, subject, body));

export default db;