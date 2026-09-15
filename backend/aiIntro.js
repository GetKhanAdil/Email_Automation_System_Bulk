import { chat } from "./groq.js";

/**
 * Generate the 2-3 personalised sentences for the {{ai_intro}} slot.
 * The LLM writes ONLY the intro — never the whole email — so placeholders and
 * structure stay fixed and safe. CSV company_info is the source of truth; when
 * empty, the model falls back to its own knowledge under a no-fabrication rule.
 */

const SYSTEM = `You write short, professional opening lines for campus-placement
invitation emails sent by a university placement cell to a company's HR.

Rules:
- Output ONLY 2-3 sentences. No greeting, no sign-off, no subject. Do not use the recipient's name.
- Connect the company to the students' strengths (AI, ML, NLP, LLMs, data science, software engineering).
- If given company context, use it. If NOT given context and you are not certain what the company does,
  DO NOT invent facts — write a strong generic line focused on the students instead.
- Plain sentences. No markdown, no bullet points, no line breaks.
- Warm and professional, not salesy.`;

export async function generateIntro(company, batchLine) {
  const { name, info, role, website } = company;
  const parts = [];
  if (info) parts.push(`What the company does: ${info}`);
  if (role) parts.push(`Role they may hire for: ${role}`);
  if (website) parts.push(`Website (hint only): ${website}`);
  const context = parts.length ? parts.join("\n") : "No verified context provided — do not invent facts about this company.";

  const user = `Company: ${name}
${context}

Students on offer: ${batchLine}

Write the 2-3 sentence opening now.`;

  const text = await chat(
    [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    { temperature: 0.7, maxTokens: 220 }
  );
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

export async function generateMany(companies, batchLine, { concurrency = 3 } = {}) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const c = companies[idx];
      try {
        results[idx] = { ...c, ai_intro: await generateIntro(c, batchLine), error: null };
      } catch (err) {
        results[idx] = { ...c, ai_intro: "", error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));
  return results;
}
