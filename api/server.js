// Kumpee Bangkok — Webboard API (Express + S3 JSON)
// แก้ hashing ให้ Signup/Login ทำงานจริง (sha256 ฝั่ง server)
// ใช้ S3 เป็น JSON DB: users.json, questions.json, answers.json (bucket private)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// ---------- ENV ----------
dotenv.config();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET;
if (!BUCKET) {
  console.error('[FATAL] .env ไม่พบ BUCKET — โปรดตั้งค่า BUCKET=<ชื่อบัคเก็ต S3>');
  process.exit(1);
}

// ---------- AWS S3 (SDK v3) ----------
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({ region: AWS_REGION });

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// โฟลเดอร์เว็บ (เสิร์ฟ index.html + asset)
// โครงสร้าง: /repo-root (index.html) + /api (server.js)
const webRoot = path.resolve(__dirname, '..');
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(webRoot));

// ---------- Utilities ----------
function sha256Hex(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}
function nowIso() {
  return new Date().toISOString();
}
function newId(prefix) {
  const rnd = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}
async function s3KeyExists(Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return true;
  } catch {
    return false;
  }
}
async function s3ReadJson(Key, fallback) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
    const buf = await streamToBuffer(res.Body);
    const text = buf.toString('utf8').trim() || JSON.stringify(fallback);
    const data = JSON.parse(text);
    return data;
  } catch (err) {
    if (String(err?.$metadata?.httpStatusCode) === '404') {
      return fallback;
    }
    console.error(`[S3 READ ERR] ${Key}`, err);
    return fallback;
  }
}
async function s3WriteJson(Key, jsonObj) {
  const Body = Buffer.from(JSON.stringify(jsonObj, null, 2), 'utf8');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body,
    ContentType: 'application/json; charset=utf-8',
    ACL: 'private'
  }));
}
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------- DB Keys ----------
const USERS_KEY = 'users.json';
const QUESTIONS_KEY = 'questions.json';
const ANSWERS_KEY = 'answers.json';

// ---------- Bootstrapping: ensure empty arrays exist ----------
(async () => {
  const ensure = async (key, tmpl) => {
    const exists = await s3KeyExists(key);
    if (!exists) {
      console.log(`[S3 INIT] สร้างไฟล์ใหม่: ${key}`);
      await s3WriteJson(key, tmpl);
    }
  };
  await ensure(USERS_KEY, { users: [] });
  await ensure(QUESTIONS_KEY, { questions: [] });
  await ensure(ANSWERS_KEY, { answers: [] });
})().catch(e => {
  console.error('[BOOTSTRAP ERROR]', e);
});

// ---------- Auth ----------
app.post('/auth/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'username/password ต้องไม่ว่าง' });
    }
    const db = await s3ReadJson(USERS_KEY, { users: [] });
    const exists = db.users.find(u => u.username === username);
    if (exists) {
      return res.status(409).json({ ok: false, error: 'username นี้ถูกใช้งานแล้ว' });
    }
    const passwordHash = sha256Hex(password); // hash ฝั่ง server
    const user = { username, passwordHash, createdAt: nowIso() };
    db.users.push(user);
    await s3WriteJson(USERS_KEY, db);
    console.log(`[AUTH] signup: ${username}`);
    return res.json({ ok: true, user: { username } });
  } catch (err) {
    console.error('[AUTH SIGNUP ERR]', err);
    return res.status(500).json({ ok: false, error: 'signup failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'username/password ต้องไม่ว่าง' });
    }
    const db = await s3ReadJson(USERS_KEY, { users: [] });
    const user = db.users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'ไม่พบผู้ใช้' });
    }
    const hash = sha256Hex(password);
    if (hash !== user.passwordHash) {
      return res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    }
    console.log(`[AUTH] login: ${username}`);
    return res.json({ ok: true, user: { username } });
  } catch (err) {
    console.error('[AUTH LOGIN ERR]', err);
    return res.status(500).json({ ok: false, error: 'login failed' });
  }
});

// ---------- Questions ----------
app.get('/questions', async (_req, res) => {
  try {
    const qdb = await s3ReadJson(QUESTIONS_KEY, { questions: [] });
    const adb = await s3ReadJson(ANSWERS_KEY, { answers: [] });
    const counts = new Map();
    for (const a of adb.answers) {
      counts.set(a.qid, (counts.get(a.qid) || 0) + 1);
    }
    const questions = qdb.questions
      .slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(q => ({ ...q, answersCount: counts.get(q.questionId) || 0 }));
    return res.json({ ok: true, questions });
  } catch (err) {
    console.error('[GET /questions ERR]', err);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ส่งรายการคำถามทั้งหมด (ให้ client จัดอันดับเอง)
app.get('/search', async (_req, res) => {
  try {
    const qdb = await s3ReadJson(QUESTIONS_KEY, { questions: [] });
    return res.json({ ok: true, questions: qdb.questions });
  } catch (err) {
    console.error('[GET /search ERR]', err);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ต้องมี header X-User: <username>
function requireUser(req, res, next) {
  const uname = req.get('X-User');
  if (!uname) return res.status(401).json({ ok: false, error: 'ต้องส่ง header X-User' });
  req.username = uname;
  next();
}

app.post('/questions', requireUser, async (req, res) => {
  try {
    const { title, body } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ ok: false, error: 'title/body ต้องไม่ว่าง' });
    }
    const qdb = await s3ReadJson(QUESTIONS_KEY, { questions: [] });
    const q = {
      questionId: newId('q'),
      title: String(title).trim(),
      body: String(body).trim(),
      createdBy: req.username,
      createdAt: nowIso()
    };
    qdb.questions.push(q);
    await s3WriteJson(QUESTIONS_KEY, qdb);
    console.log(`[Q] add: ${q.questionId} by ${req.username}`);
    return res.json({ ok: true, question: q });
  } catch (err) {
    console.error('[POST /questions ERR]', err);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

app.post('/questions/:qid/answers', requireUser, async (req, res) => {
  try {
    const { qid } = req.params;
    const { body } = req.body || {};
    if (!body) {
      return res.status(400).json({ ok: false, error: 'body ต้องไม่ว่าง' });
    }
    // ตรวจว่ามีคำถามนี้จริงไหม
    const qdb = await s3ReadJson(QUESTIONS_KEY, { questions: [] });
    const exists = qdb.questions.find(q => q.questionId === qid);
    if (!exists) {
      return res.status(404).json({ ok: false, error: 'ไม่พบคำถามนี้' });
    }
    const adb = await s3ReadJson(ANSWERS_KEY, { answers: [] });
    const ans = {
      answerId: newId('a'),
      qid,
      body: String(body).trim(),
      createdBy: req.username,
      createdAt: nowIso()
    };
    adb.answers.push(ans);
    await s3WriteJson(ANSWERS_KEY, adb);
    console.log(`[A] add: ${ans.answerId} -> ${qid} by ${req.username}`);
    return res.json({ ok: true, answer: ans });
  } catch (err) {
    console.error('[POST /questions/:qid/answers ERR]', err);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ---------- Fallback: เสิร์ฟ index.html ----------
app.get('*', (req, res, next) => {
  // ถ้าเป็น API path ไม่ต้องเสิร์ฟ index
  if (req.path.startsWith('/auth') || req.path.startsWith('/questions') || req.path.startsWith('/search')) {
    return next();
  }
  const indexPath = path.join(webRoot, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send('index.html not found');
});

// ---------- Start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] API + Web running: http://0.0.0.0:${PORT}`);
  console.log(`[WEB] Serving static from: ${webRoot}`);
  console.log(`[S3] bucket=${BUCKET} region=${AWS_REGION}`);
});
