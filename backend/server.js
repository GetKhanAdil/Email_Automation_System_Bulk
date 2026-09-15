import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import "./db/database.js";
import templatesRouter from "./routes/templates.js";
import settingsRouter from "./routes/settings.js";
import importRouter from "./routes/import.js";
import sendRouter from "./routes/send.js";
import historyRouter from "./routes/history.js";
import analyticsRouter from "./routes/analytics.js";
import draftsRouter from "./routes/drafts.js";
import companiesRouter from "./routes/companies.js";
import repliesRouter from "./routes/replies.js";
import aiRouter from "./routes/ai.js";
import { startScheduler } from "./scheduler.js";
import { startReplyPoller } from "./replyPoller.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true, service: "email-automation" }));

// Simple optional login (single shared passcode from env, default "admin")
app.post("/api/login", (req, res) => {
  const expected = process.env.APP_PASSCODE || "admin";
  if ((req.body?.passcode || "") === expected) {
    return res.json({ ok: true, token: "session-" + Date.now() });
  }
  res.status(401).json({ ok: false, message: "Incorrect passcode" });
});

app.use("/api/templates", templatesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/import", importRouter);
app.use("/api/send", sendRouter);
app.use("/api/history", historyRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/companies", companiesRouter);
app.use("/api/replies", repliesRouter);
app.use("/api/ai", aiRouter);

// Serve frontend build if present (production single-server mode)
const clientDist = join(__dirname, "..", "frontend", "dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`\n  Email Automation backend running on http://localhost:${PORT}`);
  console.log(`  API base: http://localhost:${PORT}/api\n`);
  startScheduler();
  startReplyPoller();
});