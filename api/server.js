// server.js — S3 or Local fallback (no IAM required for local)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const { Readable } = require('stream');

// --- S3 (optional) ---
let S3Client, GetObjectCommand, PutObjectCommand;
try {
  ({ S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3'));
} catch { /* ok if not installed in local-only mode */ }

const PORT   = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET; // ถ้าไม่ตั้ง เราจะใช้ local ทันที
const WEB_ROOT = process.env.WEB_ROOT || process.cwd();

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use('/', express.static(WEB_ROOT));

function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }
function noStore(res){ res.set('Cache-Control','no-store'); }
const normalizeQid = v => String(v || '').trim().toLowerCase();
const pickQuestionId = a => a?.questionId ?? a?.qid ?? a?.question_id ?? null;

// ---------- Storage Adapter ----------
const useS3 = !!(BUCKET && S3Client && GetObjectCommand && PutObjectCommand);
let s3;
if (useS3) {
  s3 = new S3Client({ region: REGION });
  console.log(`[storage] S3 mode • bucket=${BUCKET} • region=${REGION}`);
} else {
  console.log('[storage] LOCAL mode • using ./data/*.json');
}

async function streamToString(stream){
  return new Promise((resolve, reject)=>{
    const chunks=[];
    (stream instanceof Readable ? stream : Readable.from(stream))
      .on('data', (c)=>chunks.push(Buffer.from(c)))
      .on('error', reject)
      .on('end', ()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const DATA_DIR = path.join(process.cwd(), 'data');
const Q_FILE = path.join(DATA_DIR, 'questions.json');
const A_FILE = path.join(DATA_DIR, 'answers.json');

async function ensureLocalFiles(){
  if (!existsSync(DATA_DIR)) await fs.mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(Q_FILE)) await fs.writeFile(Q_FILE, '[]');
  if (!existsSync(A_FILE)) await fs.writeFile(A_FILE, '[]');
}

async function getJsonLocal(which){ // 'questions'|'answers'
  await ensureLocalFiles();
  const fp = which === 'questions' ? Q_FILE : A_FILE;
  try {
    const txt = await fs.readFile(fp, 'utf8');
    return JSON.parse(txt || '[]');
  } catch {
    return [];
  }
}
async function putJsonLocal(which, data){
  await ensureLocalFiles();
  const fp = which === 'questions' ? Q_FILE : A_FILE;
  await fs.writeFile(fp, JSON.stringify(data, null, 0));
}

async function getJsonS3(key){
  try{
    const out  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await streamToString(out.Body);
    return JSON.parse(body || '[]');
  }catch(e){
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    console.error('getJson S3 error', key, e);
    throw e;
  }
}
async function putJsonS3(key, data){
  const body = Buffer.from(JSON.stringify(data, null, 0));
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json'
  }));
}

async function getJson(which){
  if (useS3) {
    const key = which === 'questions' ? 'questions.json' : 'answers.json';
    try { return await getJsonS3(key); }
    catch (e) {
      console.warn('[storage] S3 failed, falling back to LOCAL for this call:', e?.message);
      return await getJsonLocal(which);
    }
  }
  return await getJsonLocal(which);
}
async function putJson(which, data){
  if (useS3) {
    const key = which === 'questions' ? 'questions.json' : 'answers.json';
    try { return await putJsonS3(key, data); }
    catch (e) {
      console.warn('[storage] S3 failed, falling back to LOCAL for this call:', e?.message);
      return await putJsonLocal(which, data);
    }
  }
  return await putJsonLocal(which, data);
}

// ---------- Endpoints ----------

// list questions (with answersCount)
app.get('/questions', async (req,res)=>{
  noStore(res);
  try{
    const list    = await getJson('questions');
    const answers = await getJson('answers');
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

// alias
app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));

// create question
app.post('/questions', async (req,res)=>{
  noStore(res);
  try{
    const { title, body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if (!title || !String(title).trim()) return res.status(400).json({error:'title required'});
    const qid  = safeId('q');
    const list = await getJson('questions');
    list.push({ questionId: qid, title, body: body||'', author, createdAt: now(), topics: [], locations: [] });
    await putJson('questions', list);
    res.json({ status:'ok', questionId: qid });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// add answer
app.post('/questions/:qid/answers', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const { body } = req.body||{};
    const author = req.header('X-User') || 'anon';
    if (!qid || !body) return res.status(400).json({error:'bad input'});

    const questions = await getJson('questions');
    const exists = questions.some(q => q.questionId === qid);
    if (!exists) return res.status(404).json({error:'question not found'});

    const answers = await getJson('answers');
    const answerId = safeId('a');
    answers.push({ answerId, questionId: qid, body, author, createdAt: now() });
    await putJson('answers', answers);
    res.json({ answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// read single question (with answers)
app.get('/questions/:qid', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const list    = await getJson('questions');
    const q = list.find(x => x.questionId === qid);
    if (!q) return res.status(404).json({error:'not found'});

    const answers = await getJson('answers');
    const items = answers.filter(a => pickQuestionId(a) === qid);
    res.json({ ...q, answers: items });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// read answers of a question
app.get('/questions/:qid/answers', async (req,res)=>{
  noStore(res);
  try{
    const { qid } = req.params;
    const answers = await getJson('answers');
    const items = answers.filter(a => pickQuestionId(a) === qid);
    res.json(items);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// read all answers (supports query filters)
app.get('/answers', async (req,res)=>{
  noStore(res);
  try{
    const all = await getJson('answers');
    const { questionId, qid, question_id } = req.query || {};
    const want = questionId || qid || question_id;
    if (!want) return res.json(all);
    const key = normalizeQid(want);
    const items = all.filter(a => normalizeQid(pickQuestionId(a)) === key);
    res.json(items);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// health/version
app.get('/healthz', (req,res)=> { noStore(res); res.json({ ok:true, time: now(), storage: useS3 ? 's3' : 'local' }); });

app.listen(PORT, ()=> console.log(`API + Web on http://0.0.0.0:${PORT}  (storage=${useS3?'S3':'LOCAL'}, webRoot=${WEB_ROOT})`));
