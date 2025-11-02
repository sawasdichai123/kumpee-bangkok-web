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
    if (e.name === 'NoSuchKey') return [];
    console.error('getJson error', key, e);
    throw e;
  }
}
async function putJson(key, data){
  const body = Buffer.from(JSON.stringify(data));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
}
function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }

// ===== Endpoints =====
app.get('/questions', async (req,res)=>{
  try{
    const list    = await getJson('questions.json');
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

app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));

// NEW: Get all answers
app.get('/answers', async (req,res)=>{
  try{
    const answers = await getJson('answers.json');
    res.json(answers);
  }catch(e){ 
    console.error(e); 
    res.status(500).json({error:'server'}); 
  }
});

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
    const answers = await getJson('answers.json');
    answers.push({ answerId: safeId('a'), questionId: qid, body, author, createdAt: now() });
    await putJson('answers.json', answers);
    res.json({ answerId: answers[answers.length-1].answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.listen(PORT, ()=> console.log(`API + Web on http://0.0.0.0:${PORT}  (bucket=${BUCKET})`));
