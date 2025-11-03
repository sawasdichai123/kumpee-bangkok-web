#!/usr/bin/env bash
set -euo pipefail

# ===== Config =====
REGION="${REGION:-us-east-1}"
PROJECT="${PROJECT:-kumpee-bangkok-s3db}"
APP_STAGE="${APP_STAGE:-dev}"     # ใช้เป็น prefix แยกสภาพแวดล้อม
FORCE="${FORCE:-0}"               # FORCE=1 เพื่อเขียนทับ/รีเซ็ต
CWD="$(pwd)"

echo "=== Preflight ==="
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "❌ AWS credentials ไม่พร้อม (Cloud9 > Preferences > AWS Settings > เปิด 'AWS managed temporary credentials' แล้ว Refresh)"
  exit 1
fi
aws configure set region "$REGION"

mkdir -p api

# ===== Reuse BUCKET if exists in api/.env =====
EXISTING_BUCKET=""
if [[ -f "api/.env" ]]; then
  # ดึง BUCKET จากไฟล์ .env (ถ้ามี)
  EXISTING_BUCKET="$(grep -E '^BUCKET=' api/.env | sed -E 's/^BUCKET=//')"
fi

if [[ -n "${EXISTING_BUCKET}" && "${FORCE}" != "1" ]]; then
  BUCKET="${EXISTING_BUCKET}"
  echo "=== ใช้ BUCKET เดิมจาก api/.env: ${BUCKET}"
else
  # สร้างชื่อ BUCKET แบบคงที่ต่อเครื่อง (ถ้าต้องการสุ่ม ให้ตั้ง FORCE=1)
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  # ใช้ชื่อที่ deterministic มากขึ้น (ไม่ต้องสุ่มทุกครั้ง)
  BUCKET="${PROJECT}-${ACCOUNT_ID}-${APP_STAGE}"
  echo "=== เตรียม BUCKET: ${BUCKET}"

  if ! aws s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
    echo "=== 1) สร้าง S3 bucket (private) ==="
    aws s3 mb "s3://${BUCKET}" --region "$REGION" >/dev/null || true
  else
    echo "=== พบ bucket อยู่แล้ว: ${BUCKET}"
  fi
fi

# ===== Seed questions/answers เฉพาะตอนยังไม่มี =====
echo "=== 2) ใส่ไฟล์ฐานข้อมูลเริ่มต้นเฉพาะที่ 'ยังไม่มี' (ไม่ทับ) ==="
if ! aws s3api head-object --bucket "${BUCKET}" --key "questions.json" >/dev/null 2>&1; then
  echo "[]" | aws s3 cp - "s3://${BUCKET}/questions.json" >/dev/null
  echo "  • created questions.json"
else
  echo "  • skip questions.json (already exists)"
fi
if ! aws s3api head-object --bucket "${BUCKET}" --key "answers.json" >/dev/null 2>&1; then
  echo "[]" | aws s3 cp - "s3://${BUCKET}/answers.json"  >/dev/null
  echo "  • created answers.json"
else
  echo "  • skip answers.json (already exists)"
fi

# ===== server.js / package.json: เขียนแบบปลอดภัย =====
echo "=== 3) เตรียมโค้ด API (Express + S3 JSON) ==="
write_file_safely () {
  local target="$1"
  local marker="$2"
  local content_file="$3"

  if [[ -f "$target" && "${FORCE}" != "1" ]]; then
    echo "  • skip ${target} (exists). ใช้ FORCE=1 เพื่อเขียนทับ"
  else
    if [[ -f "$target" && "${FORCE}" == "1" ]]; then
      cp -a "$target" "${target}.bak.$(date +%s)" || true
      echo "  • backup ${target} -> ${target}.bak.$(date +%s)"
    fi
    cat "$content_file" > "$target"
    echo "  • wrote ${target}"
  fi
}

# server.js (โหมด S3 เท่านั้นตามสคริปต์เดิม — ถ้าต้องการ local fallback ให้ใช้ไฟล์เวอร์ชันนั้นแทน)
TMP_DIR="$(mktemp -d)"
cat > "${TMP_DIR}/server.js" <<'JS'
const express = require('express');
const cors = require('cors');
const path = require('path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');

const PORT   = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET;
if (!BUCKET) { console.error('Missing env BUCKET'); process.exit(1); }

const s3 = new S3Client({ region: REGION });
const app = express();
app.use(cors());
app.use(express.json());

// เสิร์ฟหน้าเว็บจากรากโปรเจ็กต์
const webRoot = process.env.WEB_ROOT || process.cwd();
app.use('/', express.static(webRoot));

// ===== Utils S3 JSON =====
function streamToString(stream){
  return new Promise((resolve, reject)=>{
    const chunks=[];
    (stream instanceof Readable ? stream : Readable.from(stream))
      .on('data', (c)=>chunks.push(Buffer.from(c)))
      .on('error', reject)
      .on('end', ()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
async function getJson(key){
  try{
    const out  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await streamToString(out.Body);
    return JSON.parse(body || '[]');
  }catch(e){
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    console.error('getJson error', key, e);
    throw e;
  }
}
async function putJson(key, data){
  const body = Buffer.from(JSON.stringify(data, null, 0));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
}
function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }

// ===== Endpoints =====
app.get('/questions', async (req,res)=>{
  try{
    const list    = await getJson('questions.json');
    const answers = await getJson('answers.json');
    const map = answers.reduce((m,a)=>{ const k=a.questionId; if(k) m[k]=(m[k]||0)+1; return m; }, {});
    const out = list.slice().reverse().map(q=>({
      questionId: q.questionId, title: q.title, body: q.body,
      answersCount: map[q.questionId] || 0,
      createdAt: q.createdAt, topics: q.topics||[], locations: q.locations||[]
    }));
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});
app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));

app.post('/questions', async (req,res)=>{
  try{
    const { title, body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if (!title || !String(title).trim()) return res.status(400).json({error:'title required'});
    const qid  = safeId('q');
    const list = await getJson('questions.json');
    list.push({ questionId: qid, title, body: body||'', author, createdAt: now(), topics: [], locations: [] });
    await putJson('questions.json', list);
    res.json({ status:'ok', questionId: qid });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.post('/questions/:qid/answers', async (req,res)=>{
  try{
    const { qid } = req.params;
    const { body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if (!qid || !body) return res.status(400).json({error:'bad input'});

    const list = await getJson('questions.json');
    if (!list.some(q=>q.questionId===qid)) return res.status(404).json({error:'question not found'});

    const answers = await getJson('answers.json');
    const answerId = safeId('a');
    answers.push({ answerId, questionId: qid, body, author, createdAt: now() });
    await putJson('answers.json', answers);
    res.json({ answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.get('/questions/:qid', async (req,res)=>{
  try{
    const { qid } = req.params;
    const list    = await getJson('questions.json');
    const q = list.find(x => x.questionId === qid);
    if (!q) return res.status(404).json({error:'not found'});
    const answers = await getJson('answers.json');
    const items = answers.filter(a => a.questionId === qid);
    res.json({ ...q, answers: items });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.get('/answers', async (req,res)=>{
  try{
    const all = await getJson('answers.json');
    const { questionId, qid, question_id } = req.query || {};
    const want = (questionId || qid || question_id || '').trim();
    if (!want) return res.json(all);
    const items = all.filter(a => String(a.questionId||'') === want);
    res.json(items);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.get('/healthz', (req,res)=> res.json({ ok:true, time: now(), bucket: BUCKET }));

app.listen(PORT, ()=> console.log(`API + Web on http://0.0.0.0:${PORT}  (bucket=${BUCKET})`));
JS

cat > "${TMP_DIR}/package.json" <<'JSON'
{
  "name": "kumpee-bangkok-s3db",
  "version": "1.0.2",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "start:dev": "NODE_ENV=development node server.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.664.0",
    "cors": "^2.8.5",
    "express": "^4.21.1"
  },
  "engines": { "node": "18.x" }
}
JSON

write_file_safely "api/server.js" "JS" "${TMP_DIR}/server.js"
write_file_safely "api/package.json" "JSON" "${TMP_DIR}/package.json"

# ===== Node 18 & deps (ไม่ลบ lock ถ้าไม่ FORCE) =====
echo "=== 4) ติดตั้ง Node 18 และ dependencies ==="
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v18'; then
  if ! command -v nvm >/dev/null 2>&1; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    . "$HOME/.nvm/nvm.sh"
  else
    . "$HOME/.nvm/nvm.sh"
  fi
  nvm install 18
  nvm use 18
fi
pushd api >/dev/null
if [[ "${FORCE}" == "1" ]]; then
  rm -rf node_modules >/dev/null 2>&1 || true
fi
npm install --silent
popd >/dev/null

# ===== .env (สร้างถ้ายังไม่มี หรือ FORCE=1) =====
echo "=== 5) สร้าง/อัปเดต .env สำหรับ API ==="
if [[ ! -f "api/.env" || "${FORCE}" == "1" ]]; then
  cat > api/.env <<ENV
BUCKET=${BUCKET}
PORT=8080
ENV
  echo "  • wrote api/.env"
else
  echo "  • skip api/.env (exists). ใช้ FORCE=1 เพื่อเขียนทับ"
fi

# ===== แพตช์ index.html เฉพาะตอนมีไฟล์และมี pattern =====
echo "=== 6) แพตช์ index.html (ถ้ามี) ==="
if [[ -f "index.html" ]]; then
  if grep -qE 'const api *= *"[^"]*";' index.html; then
    sed -i 's#const api *= *"[^"]*";#const api = window.location.origin;#g' index.html || true
    echo "  • patched index.html"
  else
    echo "  • skip (no matching pattern)"
  fi
else
  echo "  • skip (no index.html)"
fi

echo
echo "=========== DONE ==========="
echo "Bucket        : ${BUCKET}"
echo "Stage         : ${APP_STAGE}"
echo "Run API/Web   : cd api && set -a; source .env; set +a; npm start"
echo "Cloud9        : Preview Running Application (port 8080)"
echo "Note          : ใช้ FORCE=1 ถ้าต้องการรีเซ็ต/เขียนทับไฟล์"
echo "============================"
