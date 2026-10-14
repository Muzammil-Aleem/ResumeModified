import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { MongoClient, ServerApiVersion } from "mongodb";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));


const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME || "resume_tailor";
let mongoClient = null;
async function getMongoDb(){
  if(!mongoUri) throw new Error("MONGODB_URI is not configured in .env");
  if(!mongoClient){
    mongoClient = new MongoClient(mongoUri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
    await mongoClient.connect();
  }
  return mongoClient.db(mongoDbName);
}

const PROVIDERS = [
  { name: "openai", endpoint: "https://api.openai.com/v1/chat/completions",                              key: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" },
  { name: "groq",   endpoint: "https://api.groq.com/openai/v1/chat/completions",                          key: process.env.GROQ_API_KEY,   model: "llama-3.3-70b-versatile" },
  { name: "gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: process.env.GEMINI_API_KEY, model: "gemini-3.8-flash" },
  { name: "gpt",    endpoint: "https://models.github.ai/inference/chat/completions",                      key: process.env.GITHUB_TOKEN,   model: "openai/gpt-4o-mini" },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
console.log("Providers ready:", PROVIDERS.filter(p => p.key).map(p => p.name).join(", ") || "NONE — add keys to .env");

// Large generations (a full tailored resume) can take well over 20s on a 70B model.
// A too-short timeout was the main cause of the 503s: the request got aborted, counted
// as a failure, and once every provider "failed" the route returned 503.
const TIMEOUT_MS = 60000;   // per request
const ROUNDS = 3;           // full passes over the provider list
const TOKEN_CAP = 8000;     // ceiling we'll allow a client to ask for

const clampTokens = (n) => {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return 4000; // sane default when unspecified
  return Math.min(Math.max(v, 256), TOKEN_CAP);
};

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function callLLM(body) {
  const active = PROVIDERS.filter(p => p.key);
  if (!active.length) return { error: "No API keys found in .env." };
  const tried = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const p of active) {
      try {
        const r = await fetchTimeout(p.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "authorization": "Bearer " + p.key },
          body: JSON.stringify({ ...body, model: p.model }),
        }, TIMEOUT_MS);
        if (r.status === 429 || r.status >= 500) {
          const ra = parseInt(r.headers.get("retry-after") || "0", 10);
          console.log(`${p.name} busy (${r.status})${ra ? ` retry-after ${ra}s` : ""} → next`);
          tried.push(`${p.name}:${r.status}`);
          if (ra > 0 && ra <= 10) await sleep(ra * 1000);
          continue;
        }
        return { r, provider: p.name };
      } catch (e) {
        console.log(`${p.name} timed out / errored → next:`, String(e));
        tried.push(`${p.name}:timeout`);
      }
    }
    // exponential-ish backoff between full passes so a brief rate-limit window can clear
    if (round < ROUNDS - 1) {
      const wait = 2000 + round * 3000;
      console.log(`All providers busy; waiting ${wait / 1000}s for another pass…`);
      await sleep(wait);
    }
  }
  return { error: "All providers are busy or unreachable — wait a few seconds and try again.", tried };
}

app.post("/api/claude", async (req, res) => {
  try {
    const messages = [];
    if (req.body.system) messages.push({ role: "system", content: req.body.system });
    (req.body.messages || []).forEach(m => messages.push({ role: m.role, content: m.content }));
    const { r, provider, error, tried } = await callLLM({ max_tokens: clampTokens(req.body.max_tokens), messages });
    if (!r) { console.log("Failover failed:", error, tried || ""); return res.status(503).json({ error, tried }); }
    const data = await r.json();
    if (!r.ok) { console.log(`${provider} said:`, JSON.stringify(data)); return res.status(r.status).json(data); }
    const text = data?.choices?.[0]?.message?.content || "";
    console.log(`✓ via ${provider} | ${text.length} chars`);
    res.json({ content: [{ type: "text", text }] });
  } catch (e) {
    console.log("Server error:", e);
    res.status(500).json({ error: String(e) });
  }
});


app.post("/api/resumes", async (req, res) => {
  try {
    const body = req.body || {};
    if(!body.tailored || typeof body.tailored !== "object") return res.status(400).json({ error: "tailored resume data is required" });
    const text = (v, max = 300) => String(v ?? "").trim().slice(0, max);
    const db = await getMongoDb();
    const result = await db.collection("tailored_resumes").insertOne({
      companyName: text(body.companyName, 200) || "Unknown company",
      jobTitle: text(body.jobTitle, 200),
      candidateName: text(body.tailored?.name, 200),
      template: text(body.template, 80),
      matchScore: Number.isFinite(Number(body.matchScore)) ? Number(body.matchScore) : null,
      coverageScore: Number.isFinite(Number(body.coverageScore)) ? Number(body.coverageScore) : null,
      analysisKeywords: Array.isArray(body.analysisKeywords) ? body.analysisKeywords.map(v => text(v, 120)).filter(Boolean).slice(0, 100) : [],
      tailored: body.tailored,
      createdAt: new Date(),
      source: "resume-tailor-local",
    });
    res.status(201).json({ ok: true, id: result.insertedId.toString() });
  } catch (e) {
    console.log("MongoDB save failed:", e);
    res.status(500).json({ error: "Could not save tailored resume to MongoDB.", details: String(e?.message || e) });
  }
});

app.listen(3001, () => console.log("AI backend running on http://localhost:3001"));