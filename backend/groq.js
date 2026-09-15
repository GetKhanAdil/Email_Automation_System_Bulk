import { getSettings } from "./db/settings.js";

/**
 * Groq client — deprecation-proof model resolution + multi-key rotation.
 *
 * Keys:
 *   - Primary source is GROQ_KEYS in .env: a comma-separated list of keys from
 *     different Groq accounts, e.g. GROQ_KEYS=key1,key2,key3
 *   - Falls back to a single groq_api_key from Settings if .env has none.
 *
 * Rotation strategy: round-robin across keys, with failover on rate-limit.
 *   - Each call starts from the next key (spreads load).
 *   - If a key returns 429, it's put on a short cooldown and the next key is
 *     tried immediately — the request only fails if EVERY key is exhausted.
 *
 * Model: resolved at runtime from Groq's live /models endpoint against a
 * preference list, so a retired model never breaks anything.
 */

const GROQ_BASE = "https://api.groq.com/openai/v1";

const MODEL_PREFERENCE = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];
const HARD_FALLBACK = "openai/gpt-oss-20b";

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // a 429'd key rests for 60s

// ---- key pool ----

let rrIndex = 0;
const cooldownUntil = new Map(); // key -> timestamp until which it's resting

export function hasKeys() {
  return loadKeys().length > 0;
}

function loadKeys() {
  // .env first (comma-separated, different accounts), else single Settings key.
  const envKeys = (process.env.GROQ_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (envKeys.length) return envKeys;

  const single = getSettings().groq_api_key;
  return single ? [single] : [];
}

/** Keys not currently on cooldown, ordered round-robin from the last position. */
function availableKeys() {
  const all = loadKeys();
  if (!all.length) throw new Error("No Groq API keys configured. Add GROQ_KEYS in .env or a key in Settings.");

  const now = Date.now();
  const ready = all.filter((k) => (cooldownUntil.get(k) || 0) <= now);
  // If everything is cooling down, use them all anyway (better to try than fail).
  const pool = ready.length ? ready : all;

  // Rotate the starting point so load spreads across keys.
  rrIndex = (rrIndex + 1) % pool.length;
  return [...pool.slice(rrIndex), ...pool.slice(0, rrIndex)];
}

// ---- model resolution ----

let cachedModel = null;
let cachedAt = 0;
const MODEL_TTL_MS = 60 * 60 * 1000;

async function fetchAvailableModels(key) {
  const res = await fetch(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Groq /models returned ${res.status}`);
  const data = await res.json();
  return new Set((data.data || []).map((m) => m.id));
}

export async function resolveModel(force = false) {
  if (!force && cachedModel && Date.now() - cachedAt < MODEL_TTL_MS) return cachedModel;
  try {
    const key = availableKeys()[0];
    const available = await fetchAvailableModels(key);
    cachedModel = MODEL_PREFERENCE.find((m) => available.has(m)) || [...available][0] || HARD_FALLBACK;
  } catch {
    cachedModel = cachedModel || HARD_FALLBACK;
  }
  cachedAt = Date.now();
  return cachedModel;
}

// ---- chat with rotation + failover ----

async function callOnce(key, model, messages, opts) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 400,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export async function chat(messages, opts = {}) {
  let model = await resolveModel();
  const keys = availableKeys();
  let lastErr;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      return await callOnce(key, model, messages, opts);
    } catch (err) {
      lastErr = err;

      // Rate limited → rest this key, try the next one.
      if (err.status === 429) {
        cooldownUntil.set(key, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        continue;
      }
      // Model gone → re-resolve once and retry the SAME key with the new model.
      if (err.status === 404 || /decommission|deprecat|not found|does not exist/i.test(err.message)) {
        model = await resolveModel(true);
        try {
          return await callOnce(key, model, messages, opts);
        } catch (err2) {
          lastErr = err2;
          if (err2.status === 429) {
            cooldownUntil.set(key, Date.now() + RATE_LIMIT_COOLDOWN_MS);
            continue;
          }
          throw err2;
        }
      }
      // Any other error (bad key, network) → try next key rather than dying.
      continue;
    }
  }

  throw new Error(
    `All Groq keys failed. Last error: ${lastErr?.message || "unknown"}`
  );
}

export async function testGroq() {
  const model = await resolveModel(true);
  const reply = await chat([{ role: "user", content: "Reply with the word OK." }], { maxTokens: 5, temperature: 0 });
  return { ok: true, model, reply, keyCount: loadKeys().length };
}