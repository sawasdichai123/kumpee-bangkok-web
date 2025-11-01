// api/server.js — Express + S3 JSON DB + Server-side Auth (CommonJS)
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');

const PORT   = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BUCKET = process.env.BUCKET;
if (!BUCKET) { console.error('❌ Missing env BUCKET'); process.exit(1); }

const s3 = new S3Client({ region: REGION });
const app = express();
app.use(cors());
app.use(express.json());

// ---- Static Web (index.html อยู่โฟลเดอร์พ่อของ /api) ----
const webRoot = process.env.WEB_ROOT || path.resolve(process.cwd(), '..');
console.log('[WEB] Serving static from:', webRoot);
app.use(express.static(webRoot));
app.get(['/', '/index.html'], (req,res)=> res.sendFile(path.join(webRoot, 'index.html')));

// ---- Utils stream/json ----
function streamToString(stream){
  return new Promise((resolve, reject)=>{
    const chunks=[];
    (stream instanceof Readable ? stream : Readable.from(stream))
      .on('data', (c)=>chunks.push(Buffer.from(c)))
      .on('error', reject)
      .on('end', ()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
async function getJson(key, fallback='[]'){
  try{
    const out  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const txt  = await streamToString(out.Body);
    return JSON.parse(txt || fallback);
  }catch(e){
    if (e.name === 'NoSuchKey') return JSON.parse(fallback);
    console.error('getJson error', key, e);
    throw e;
  }
}
async function putJson(key, data){
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(JSON.stringify(data)),
    ContentType: 'application/json'
  }));
}
function now(){ return new Date().toISOString(); }
function safeId(prefix='q'){ return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`; }
function hash(pass){ return crypto.createHash('sha256').update(String(pass)).digest('hex'); }

// ---- Auth (users.json: [{username,hash,createdAt}]) ----
async function ensureUsersFile(){
  const u = await getJson('users.json', '[]');
  if (!Array.isArray(u)) await putJson('users.json', []);
}
app.post('/auth/signup', async (req,res)=>{
  try{
    const { username, password } = req.body || {};
    const USER_RE = /^[a-z0-9._-]{3,20}$/i;
    if (!USER_RE.test(username||'')) return res.status(400).json({error:'bad username'});
    if (!password || String(password).length < 6) return res.status(400).json({error:'short password'});

    await ensureUsersFile();
    const users = await getJson('users.json', '[]');
    if (users.find(u=>u.username.toLowerCase() === String(username).toLowerCase())){
      return res.status(409).json({error:'user exists'});
    }
    users.push({ username, hash: hash(password), createdAt: now() });
    await putJson('users.json', users);
    res.json({ status:'ok', username });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});
app.post('/auth/login', async (req,res)=>{
  try{
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({error:'bad input'});
    const users = await getJson('users.json', '[]');
    const u = users.find(x=>x.username.toLowerCase() === String(username).toLowerCase());
    if (!u) return res.status(404).json({error:'not found'});
    if (u.hash !== hash(password)) return res.status(401).json({error:'wrong password'});
    res.json({ status:'ok', username: u.username });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

// ---- Threads ----
app.get('/questions', async (req,res)=>{
  try{
    const list    = await getJson('questions.json', '[]');
    const answers = await getJson('answers.json',  '[]');
    const countMap = answers.reduce((m,a)=>(m[a.questionId]=(m[a.questionId]||0)+1,m),{});
    const out = list.slice().reverse().map(q=>({
      questionId: q.questionId, title: q.title, body: q.body,
      answersCount: countMap[q.questionId] || 0,
      createdAt: q.createdAt, topics: q.topics||[], locations: q.locations||[]
    }));
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});
app.get('/search', (req,res)=> app._router.handle({ ...req, url:'/questions', method:'GET' }, res));
app.post('/questions', async (req,res)=>{
  try{
    const { title, body } = req.body || {};
    const author = req.header('X-User') || 'anon';
    if (!title || !String(title).trim()) return res.status(400).json({error:'title required'});
    const qid  = safeId('q');
    const list = await getJson('questions.json', '[]');
    list.push({ questionId: qid, title, body: body||'', author, createdAt: now(), topics: [], locations: [] });
    await putJson('questions.json', list);
    res.json({ status:'ok', questionId: qid });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});
app.post('/questions/:qid/answers', async (req,res)=>{
  try{
    const { qid } = req.params;
    const { body } = req.body || {};
    const author = req.header('X-User') || 'anon';
    if (!qid || !body) return res.status(400).json({error:'bad input'});
    const answers = await getJson('answers.json', '[]');
    const answerId = safeId('a');
    answers.push({ answerId, questionId: qid, body, author, createdAt: now() });
    await putJson('answers.json', answers);
    res.json({ answerId });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.listen(PORT, ()=> console.log(`✅ API + Web on http://0.0.0.0:${PORT} (bucket=${BUCKET})`));
