import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "resume_tailor";

let cached = globalThis.__resumeTailorMongo;
if (!cached) {
  cached = globalThis.__resumeTailorMongo = { client: null, promise: null };
}

async function getDb() {
  if (!uri) throw new Error("MONGODB_URI is not configured in Vercel.");
  if (cached.client) return cached.client.db(dbName);
  if (!cached.promise) {
    const client = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    });
    cached.promise = client.connect().then(() => client);
  }
  try {
    cached.client = await cached.promise;
    return cached.client.db(dbName);
  } catch (err) {
    cached.promise = null;
    throw err;
  }
}

function cleanText(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    const body = req.body || {};
    if (!body.tailored || typeof body.tailored !== "object") {
      res.status(400).json({ error: "tailored resume data is required" });
      return;
    }

    const companyName = cleanText(body.companyName, 200) || "Unknown company";
    const jobTitle = cleanText(body.jobTitle, 200);
    const candidateName = cleanText(body.tailored?.name, 200);

    const document = {
      companyName,
      jobTitle,
      candidateName,
      template: cleanText(body.template, 80),
      matchScore: Number.isFinite(Number(body.matchScore)) ? Number(body.matchScore) : null,
      coverageScore: Number.isFinite(Number(body.coverageScore)) ? Number(body.coverageScore) : null,
      analysisKeywords: Array.isArray(body.analysisKeywords)
        ? body.analysisKeywords.map(v => cleanText(v, 120)).filter(Boolean).slice(0, 100)
        : [],
      tailored: body.tailored,
      createdAt: new Date(),
      source: "resume-tailor-web",
    };

    const db = await getDb();
    const result = await db.collection("tailored_resumes").insertOne(document);

    res.status(201).json({ ok: true, id: result.insertedId.toString() });
  } catch (err) {
    console.error("MongoDB save failed:", err);
    res.status(500).json({ error: "Could not save tailored resume to MongoDB.", details: String(err?.message || err) });
  }
}
