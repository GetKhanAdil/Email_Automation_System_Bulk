import { Router } from "express";
import multer from "multer";
import xlsx from "xlsx";
import Papa from "papaparse";
import fs from "fs";

const router = Router();
const upload = multer({ dest: "uploads/" });

// Map many possible header names to our canonical fields
const COLUMN_ALIASES = {
  student_name: ["student name", "name", "student", "fullname", "full name"],
  email: ["email", "email address", "e-mail", "mail", "hr email", "company email", "recruiter email"],
  company_name: ["company", "company name", "organisation", "organization"],
  hr_name: ["hr name", "recruiter name", "contact person", "contact name", "hiring manager"],
  designation: ["designation", "title", "job title"],
  hr_email: ["hr email", "company email", "recruiter email", "talent email"],
  job_role: ["role", "job role", "position", "designation", "profile"],
  deadline: ["deadline", "date", "interview date", "due date", "last date"],
  meeting_link: ["meeting link", "link", "url", "meeting", "apply link"],
  phone: ["phone", "mobile", "contact", "phone number"],
  college: ["college", "institute", "university", "campus"],
  college_name: ["college name", "institution name"],
  placement_officer: ["placement officer", "coordinator", "tpo", "placement coordinator"],
  college_location: ["college location", "campus location", "location"],
  student_count: ["student count", "eligible students", "students"],
  website: ["website", "company website", "college website"],
  brochure_link: ["brochure", "brochure link", "placement brochure"],
  linkedin: ["linkedin", "linkedin url", "company linkedin"],
  industry: ["industry", "sector"],
  company_info: ["company info", "company description", "about", "description", "about company"],
  city: ["city"],
  state: ["state"],
  country: ["country"],
  status: ["status", "company status"],
  follow_up_date: ["follow up date", "follow-up date", "next follow up", "next follow-up"],
  last_contact_date: ["last contact date", "last contacted"],
  last_reply_date: ["last reply date", "last replied"],
  meeting_date: ["meeting date", "meeting on"],
  notes: ["notes", "remarks"],
};

function canonicalKey(header) {
  const h = String(header).trim().toLowerCase();
  for (const [canon, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (canon === h.replace(/\s+/g, "_")) return canon;
    if (aliases.includes(h)) return canon;
  }
  return h.replace(/\s+/g, "_"); // keep unknown columns as-is
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function normalizeRows(rawRows) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;

  for (const raw of rawRows) {
    const row = {};
    for (const [k, v] of Object.entries(raw)) {
      row[canonicalKey(k)] = typeof v === "string" ? v.trim() : v;
    }
    const email = String(row.email || row.hr_email || row.company_email || "").trim().toLowerCase();

    if (!isValidEmail(email)) {
      invalid.push({ ...row, _reason: "Invalid email" });
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    row.email = email;
    row.hr_email = row.hr_email || email;
    valid.push(row);
  }

  return { valid, invalid, duplicates };
}

router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = req.file.path;
  const name = (req.file.originalname || "").toLowerCase();

  try {
    let rawRows = [];
    if (name.endsWith(".csv")) {
      const text = fs.readFileSync(filePath, "utf8");
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      rawRows = parsed.data;
    } else {
      const wb = xlsx.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rawRows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    }

    const result = normalizeRows(rawRows);
    res.json({
      total: rawRows.length,
      validCount: result.valid.length,
      invalidCount: result.invalid.length,
      duplicates: result.duplicates,
      rows: result.valid,
      invalidRows: result.invalid,
    });
  } catch (err) {
    res.status(400).json({ error: "Failed to parse file: " + err.message });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

export default router;
