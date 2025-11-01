cat > setup-s3-db.sh <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-us-east-1}"
PROJECT="${PROJECT:-kumpee-bangkok-s3db}"
TS="$(date +%s)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
RAND="$(openssl rand -hex 4 2>/dev/null || echo r$RANDOM)"
BUCKET="${PROJECT}-${ACCOUNT_ID}-${RAND}-${TS}"

echo "=== Preflight ==="
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "❌ AWS credentials ไม่พร้อม (ไปที่ Cloud9 > Preferences > AWS Settings > เปิด 'AWS managed temporary credentials' แล้ว Refresh)"
  exit 1
}
aws configure set region "$REGION"

echo "=== 1) สร้าง S3 bucket (private) ==="
aws s3 mb "s3://${BUCKET}" --region "$REGION" >/dev/null || true
echo "Bucket: ${BUCKET}"

echo "=== 2) ใส่ไฟล์ฐานข้อมูลเริ่มต้น (JSON array ว่าง) ==="
echo "[]" | aws s3 cp - "s3://${BUCKET}/questions.json" >/dev/null
echo "[]" | aws s3 cp - "s3://${BUCKET}/answers.json"  >/dev/null

echo "=== 3) เตรียมโค้ด API (Express + S3 JSON) ==="
mkdir -p api

cat > api/server.js <<'JS'
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');

const PORT   = process.env.PORT   || 8080;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET;

if(!BUCKET){ console.error('Missing env BUCKET'); process.exit(1); }

const s3 = new S3Client({ region: REGION });
const app = express();
app.use(cors());
app.use(express.json());

// เสิร์ฟ index.html และไฟล์หน้าเว็บจากรูทโปรเจ็กต์ (อยู่โฟลเดอร์เดียวกับ script ที่รัน)
const webRoot = process.env.WEB_ROOT || path.resolve(process.cwd());
app.use('/', express.static(webRoot));

// --- Utils S3 JSON ---
async function getJson(key){
  try{
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await streamToString(out.Body);
    return JSON.parse(body || '[]');
  }catch(e){
    if(e.name === 'NoSuchKey') return [];
    console.error('getJson error', key, e);
    throw e;
  }
}
async function putJson(key, data){
  const body = Buffer.from(JSON.stringify(data));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
}
function streamToString(stream){
  return new Promise((resolve, reject)=>{
    const chunks=[];
    (stream instanceof Readable ? stream : Readable.from(stream))
      .on('data', (c)=>chunks.push(Buffer.from(c)))
      .on('error', reject)
      .on('end', ()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }

// --- Endpoints ---
// GET /questions : อ่านจาก S3
app.get('/questions', async (req,res)=>{
  try{
    const list = await getJson('questions.json');
    // enrich answersCount จาก answers.json
    const answers = await getJson('answers.json');
    const map = answers.reduce((m,a)=> (m[a.questionId]=(m[a.questionId]||0)+1, m), {});
    const out = list.slice().reverse().map(q=>({
      questionId: q.questionId, title: q.title, body: q.body,
      answersCount: map[q.questionId] || 0,
      createdAt: q.createdAt, topics: q.topics||[], locations: q.locations||[]
    }));
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// GET /search : ส่งเหมือน /questions ให้ client จัดอันดับเอง
app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));

// POST /questions : เพิ่มกระทู้ใหม่
app.post('/questions', async (req,res)=>{
  try{
    const { title, body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if(!title || !String(title).trim()) return res.status(400).json({error:'title required'});
    const qid = safeId('q');
    const list = await getJson('questions.json');
    list.push({ questionId: qid, title, body: body||'', author, createdAt: now(), topics: [], locations: [] });
    await putJson('questions.json', list);
    res.json({ status:'ok', questionId: qid });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// POST /questions/:qid/answers : ตอบกระทู้
app.post('/questions/:qid/answers', async (req,res)=>{
  try{
    const { qid } = req.params;
    const { body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if(!qid || !body) return res.status(400).json({error:'bad input'});
    const answers = await getJson('answers.json');
    answers.push({ answerId: safeId('a'), questionId: qid, body, author, createdAt: now() });
    await putJson('answers.json', answers);
    res.json({ answerId: answers[answers.length-1].answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.listen(PORT, ()=> console.log(`API + Web on http://0.0.0.0:${PORT}  (bucket=${BUCKET})`));
JS

cat > api/package.json <<'JSON'
{
  "name": "kumpee-bangkok-s3db",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.664.0",
    "cors": "^2.8.5",
    "express": "^4.21.1"
  }
}
JSON

echo "=== 4) ติดตั้ง Node 18 และ dependencies ==="
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q 'v18'; then
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
npm install --silent
popd >/dev/null

echo "=== 5) สร้างไฟล์ .env สำหรับ API ==="
cat > api/.env <<ENV
BUCKET=${BUCKET}
PORT=8080
ENV

echo "=== 6) แพตช์ index.html ให้ชี้ API ที่พอร์ต 8080 (ถ้ามีไฟล์) ==="
if [ -f index.html ]; then
  sed -i 's#const api *= *"[^"]*";#const api = window.location.origin;#g' index.html || true
fi

echo
echo "=========== DONE ==========="
echo "Bucket        : ${BUCKET}"
echo "API/Web Start : cd api && set -a; source .env; set +a; node server.js"
echo "Open (C9 prev): Cloud9 > Preview Running Application (port 8080)"
echo "============================"
BASH

chmod +x setup-s3-db.sh
echo "✅ สร้างไฟล์ setup-s3-db.sh แล้ว"
