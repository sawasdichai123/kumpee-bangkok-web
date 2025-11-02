// server.js (complete, with answers endpoints)
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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
    // รองรับทั้ง e.name === 'NoSuchKey' และ 404
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    console.error('getJson error', key, e);
    throw e;
  }
}
async function putJson(key, data){
  const body = Buffer.from(JSON.stringify(data, null, 0));
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json'
  }));
}
function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }
function noStore(res){ res.set('Cache-Control','no-store'); }

// ===== Helpers =====
const normalizeQid = v => String(v || '').trim().toLowerCase();
function pickQuestionId(a){
  return a?.questionId ?? a?.qid ?? a?.question_id ?? null;
}

// ===== Endpoints =====

// รายการคำถาม + นับจำนวนคำตอบ
app.get('/questions', async (req,res)=>{
  noStore(res);
  try{
    const list    = await getJson('questions.json');
    const answers = await getJson('answers.json');
    const map = answers.reduce((m,a)=>{
      const k = pickQuestionId(a);
      if (k) m[k] = (m[k]||0) + 1;
      return m;
    }, {});
    const out = list.slice().reverse().map(q=>({
      questionId: q.questionId, title: q.title, body: q.body,
      answersCount: map[q.questionId] || 0,
      createdAt: q.createdAt, topics: q.topics||[], locations: q.locations||[]
    }));
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// alias /search → /questions
app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));

// สร้างคำถามใหม่
app.post('/questions', async (req,res)=>{
  noStore(res);
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

// เพิ่มคำตอบให้คำถาม
app.post('/questions/:qid/answers', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const { body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if (!qid || !body) return res.status(400).json({error:'bad input'});

    // ตรวจว่ามีคำถามนี้อยู่จริง (ป้องกันพิมพ์ QID ผิด)
    const questions = await getJson('questions.json');
    const exists = questions.some(q => q.questionId === qid);
    if (!exists) return res.status(404).json({error:'question not found'});

    const answers = await getJson('answers.json');
    const answerId = safeId('a');
    answers.push({ answerId, questionId: qid, body, author, createdAt: now() });
    await putJson('answers.json', answers);
    res.json({ answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// ===== NEW: อ่านคำถามเดี่ยว (พร้อม answers ฝัง) =====
app.get('/questions/:qid', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const list    = await getJson('questions.json');
    const q = list.find(x => x.questionId === qid);
    if (!q) return res.status(404).json({error:'not found'});

    const answers = await getJson('answers.json');
    const items = answers.filter(a => pickQuestionId(a) === qid);
    res.json({ ...q, answers: items });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// ===== NEW: อ่านคำตอบของคำถามแบบราย QID =====
app.get('/questions/:qid/answers', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const answers = await getJson('answers.json');
    const items = answers.filter(a => pickQuestionId(a) === qid);
    res.json(items);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// ===== NEW: อ่านคำตอบทั้งหมด หรือกรองด้วย query =====
// รองรับ /answers?questionId=...  หรือ ?qid=... หรือ ?question_id=...
app.get('/answers', async (req,res)=>{
  noStore(res);
  try{
    const all = await getJson('answers.json');
    const { questionId, qid, question_id } = req.query || {};
    const want = questionId || qid || question_id;
    if (!want) return res.json(all);
    const key = normalizeQid(want);
    const items = all.filter(a => normalizeQid(pickQuestionId(a)) === key);
    res.json(items);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.listen(PORT, ()=> console.log(`API + Web on http://0.0.0.0:${PORT}  (bucket=${BUCKET})`));
