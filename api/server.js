// ✅ FULL UPDATED server.js — Webboard API + Static Web + S3 JSON DB

import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import bodyParser from 'body-parser';

// ---------------- ENV / PATH SETUP ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default port 8080 ✅
const port = process.env.PORT || 8080;

// STATIC ROOT = ../ (parent folder of /api)
const webRoot = process.env.WEB_ROOT || path.resolve(__dirname, '..');
console.log('[WEB] Serving static from:', webRoot);

// S3 bucket name from .env
const BUCKET = process.env.BUCKET;
if (!BUCKET) {
  console.error("❌ ERROR: BUCKET ENV NOT SET");
  process.exit(1);
}
console.log("[S3] Bucket =", BUCKET);

// ---------------- S3 CLIENT ----------------
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

async function readJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await r.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;
    console.error("❌ S3 read error", key, e);
    throw e;
  }
}

async function writeJson(key, data) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json"
    }));
  } catch (e) {
    console.error("❌ S3 write error", key, e);
    throw e;
  }
}

// ---------------- AUTH HELPERS ----------------
function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

async function loadUsers() {
  return (await readJson("users.json")) || { users: [] };
}
async function saveUsers(data) {
  return writeJson("users.json", data);
}

// ---------------- EXPRESS APP ----------------
const app = express();
app.use(bodyParser.json());

// ✅ Serve frontend static
app.use(express.static(webRoot));
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

// ✅ API ROOT CHECK
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------- SIGN-UP ----------------
app.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username/password required" });
  }
  const users = await loadUsers();
  if (users.users.find(u => u.username === username)) {
    return res.status(400).json({ error: "user exists" });
  }

  users.users.push({
    username,
    passwordHash: hashPassword(password), // store hashed
    createdAt: new Date().toISOString()
  });
  await saveUsers(users);
  console.log("✅ SIGN-UP:", username);

  res.json({ ok: true });
});

// ---------------- LOGIN ----------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const users = await loadUsers();
  const u = users.users.find(x => x.username === username);
  if (!u) return res.status(401).json({ error: "not found" });

  if (u.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "bad password" });
  }
  res.json({ ok: true });
});

// ---------------- QUESTIONS GET ----------------
app.get('/questions', async (req, res) => {
  const q = (await readJson("questions.json")) || { questions: [] };
  const a = (await readJson("answers.json")) || { answers: [] };

  const out = q.questions.map(item => ({
    ...item,
    answersCount: a.answers.filter(x => x.qid === item.questionId).length
  }));
  res.json(out);
});

// ---------------- SEARCH GET ----------------
app.get('/search', async (req, res) => {
  const q = (await readJson("questions.json")) || { questions: [] };
  res.json(q.questions);
});

// ---------------- POST QUESTION ----------------
app.post('/questions', async (req, res) => {
  const username = req.header('X-User');
  if (!username) return res.status(401).json({ error: "not logged in" });

  const { title, body } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const db = (await readJson("questions.json")) || { questions: [] };
  const id = "q" + Date.now();

  db.questions.push({
    questionId: id,
    title,
    body,
    createdBy: username,
    createdAt: new Date().toISOString()
  });
  await writeJson("questions.json", db);

  console.log("📝 New Question:", id);
  res.json({ ok: true, questionId: id });
});

// ---------------- POST ANSWER ----------------
app.post('/questions/:qid/answers', async (req, res) => {
  const username = req.header('X-User');
  if (!username) return res.status(401).json({ error: "not logged in" });

  const { qid } = req.params;
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: "body required" });

  const db = (await readJson("answers.json")) || { answers: [] };
  const id = "a" + Date.now();

  db.answers.push({
    answerId: id,
    qid,
    body,
    createdBy: username,
    createdAt: new Date().toISOString()
  });
  await writeJson("answers.json", db);

  console.log("💬 New Answer:", id);
  res.json({ ok: true, answerId: id });
});

// ---------------- FALLBACK ----------------
app.get('*', (req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

// ---------------- START SERVER ----------------
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ API + Web running: http://0.0.0.0:${port}`);
  console.log(`Serving frontend from: ${webRoot}`);
});
