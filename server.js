import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.RADOXAI_BASE_URL || "https://radoxai.com/v1").replace(/\/+$/, "");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretsPath = path.join(__dirname, ".runtime-secrets.json");
let runtimeSecrets = {};
try { runtimeSecrets = JSON.parse(await readFile(secretsPath, "utf8")); } catch {}
let apiKey = process.env.RADOXAI_API_KEY || runtimeSecrets.radoxAiApiKey || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";
function secureEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function requireAdmin(req, res) {
  const supplied = req.get("x-admin-password") || "";
  if (!adminPassword) { res.status(503).json({ error: "Admin belum diaktifkan. Atur ADMIN_PASSWORD di environment server." }); return false; }
  if (!secureEqual(supplied, adminPassword)) { res.status(401).json({ error: "Password admin salah." }); return false; }
  return true;
}

const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(v => v.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Tanpa CORS_ORIGIN, wildcard hanya untuk uji coba. Set CORS_ORIGIN di server produksi.
    if (!allowedOrigins.length || !origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin tidak diizinkan oleh konfigurasi CORS."));
  }
}));
app.use(express.json({ limit: "1mb" }));

// Batas sederhana untuk mengurangi penyalahgunaan endpoint chat.
const requestBuckets = new Map();
app.use("/api/chat", (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.start > 10 * 60 * 1000) bucket = { start: now, count: 0 };
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  if (requestBuckets.size > 5000) {
    for (const [ip, value] of requestBuckets) if (now - value.start > 10 * 60 * 1000) requestBuckets.delete(ip);
  }
  if (bucket.count > 12) return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi beberapa menit lagi." });
  next();
});

app.get("/", (_req, res) => {
  res.type("text").send("Xyro AI backend aktif. Cek /api/health untuk status konfigurasi.");
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(apiKey), service: "Xyro AI" });
});

// Panel admin: rahasia tidak pernah dikirim kembali ke browser. Wajib gunakan HTTPS.
app.get("/api/admin/status", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, configured: Boolean(apiKey), maskedKey: apiKey ? "••••••••" : "Belum diatur" });
});

app.post("/api/admin/config", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const newKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  if (newKey.length < 12 || newKey.length > 500) return res.status(400).json({ error: "API key tidak valid. Periksa lalu coba lagi." });
  try {
    // Disimpan hanya di backend; file tidak berada di folder frontend/static.
    const content = JSON.stringify({ radoxAiApiKey: newKey }, null, 2);
    await writeFile(secretsPath, content, { encoding: "utf8", mode: 0o600 });
    apiKey = newKey;
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, configured: true, maskedKey: "••••••••" });
  } catch {
    res.status(500).json({ error: "Gagal menyimpan key di server. Gunakan environment variable RADOXAI_API_KEY pada hosting." });
  }
});

app.get("/api/models", async (_req, res) => {
  if (!apiKey) return res.status(503).json({ error: "API belum dikonfigurasi. Isi RADOXAI_API_KEY di .env." });
  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || "Gagal mengambil daftar model." });
    res.json(data);
  } catch {
    res.status(502).json({ error: "Tidak dapat terhubung ke layanan model." });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!apiKey) return res.status(503).json({ error: "API belum dikonfigurasi. Salin .env.example menjadi .env dan isi API key RadoxAI." });
  const { messages, model = "claude-opus-4.8", temperature = 0.7 } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Pesan percakapan tidak valid." });
  }
  if (messages.length > 60 || messages.some(m => !["user", "assistant", "system"].includes(m?.role) || typeof m?.content !== "string")) {
    return res.status(400).json({ error: "Format pesan tidak valid atau percakapan terlalu panjang." });
  }
  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: String(model).slice(0, 160),
        messages: messages.map(m => ({ role: m.role, content: m.content.slice(0, 30000) })),
        temperature: Math.min(1.2, Math.max(0, Number(temperature) || 0.7))
      })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const msg = data?.error?.message || data?.message || `RadoxAI mengembalikan HTTP ${upstream.status}. Periksa FASTROUTER_BASE_URL dan model yang dipilih.`;
      return res.status(upstream.status).json({ error: msg, upstreamStatus: upstream.status });
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string") return res.status(502).json({ error: "Respons model tidak memiliki teks yang dapat ditampilkan." });
    res.json({ answer, model: data.model || model, usage: data.usage || null });
  } catch {
    res.status(502).json({ error: "Koneksi ke RadoxAI gagal. Periksa koneksi dan konfigurasi server." });
  }
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Xyro AI berjalan di http://localhost:${port}`);
});