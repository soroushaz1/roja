// Roja's one server-side part: keeping a skin check, when its owner asks, so a later
// check can be compared with it. nginx serves the site and passes /api/skin here.
//
// What is kept is the profile and the answers (skin.js record()), never a picture; no
// name, address or account. A random key made on the visitor's device names its
// results: whoever holds it can read and delete them. Only a hash of the key is stored.
//
//   node server/skin-api.mjs            # 127.0.0.1:51840, ./roja-skin.db
//   ROJA_PORT=… ROJA_DB=… node server/skin-api.mjs
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {questions,axes,concernNames} from '../skin.js';

const PORT=Number(process.env.ROJA_PORT||51840);
const db=new DatabaseSync(process.env.ROJA_DB||'roja-skin.db');
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS checks(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, record TEXT NOT NULL, agree INTEGER);
  CREATE INDEX IF NOT EXISTS checks_owner ON checks(owner, created);`);
const q={
  insert:db.prepare('INSERT INTO checks(id,owner,created,record) VALUES (?,?,?,?)'),
  count:db.prepare('SELECT count(*) AS n FROM checks WHERE owner=?'),
  list:db.prepare('SELECT id,created,record,agree FROM checks WHERE owner=? ORDER BY created DESC LIMIT 100'),
  wipe:db.prepare('DELETE FROM checks WHERE owner=?'),
  agree:db.prepare('UPDATE checks SET agree=? WHERE id=? AND owner=?')
};
const PER_OWNER=200;
const MAX_BODY=8*1024;

/* ---- validation: a record is rebuilt from what is allowed, nothing is passed through ---- */
class Invalid extends Error{}
const fail=what=>{throw new Invalid(what);};
const int=(v,lo,hi,what)=>Number.isInteger(v)&&v>=lo&&v<=hi?v:fail(what);
const num=(v,lo,hi,what)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi?+v.toFixed(3):fail(what);
const obj=(v,what)=>v&&typeof v==='object'&&!Array.isArray(v)?v:fail(what);
const IMAGE_KEYS=['oil','red','acne','pigment','texture','lines','underEye'];
const scores=(v,keys,what)=>{
  obj(v,what);
  const out={};
  for(const [k,s] of Object.entries(v)){if(!keys.includes(k))fail(`${what}.${k}`);out[k]=int(s,0,100,`${what}.${k}`);}
  return out;
};
function clean(body){
  obj(body,'record');
  if(body.version!==1)fail('version');
  const out={version:1};
  out.fitz=body.fitz==null?null:{
    type:int(obj(body.fitz,'fitz').type,1,6,'fitz.type'),conf:int(body.fitz.conf,0,100,'fitz.conf'),
    from:['both','answers','image'].includes(body.fitz.from)?body.fitz.from:fail('fitz.from')};
  out.baumann=typeof body.baumann==='string'&&/^[OD][SR][PN][WT]$/.test(body.baumann)?body.baumann:fail('baumann');
  obj(body.axes,'axes');
  out.axes={};
  for(const a of axes){
    const v=obj(body.axes[a.id],`axes.${a.id}`);
    out.axes[a.id]={value:num(v.value,-1,1,`axes.${a.id}.value`),conf:int(v.conf,0,100,`axes.${a.id}.conf`)};
  }
  out.concerns=scores(body.concerns,Object.keys(concernNames),'concerns');
  out.image=body.image==null?null:scores(body.image,IMAGE_KEYS,'image');
  out.tone=body.tone==null?null:{
    hex:typeof obj(body.tone,'tone').hex==='string'&&/^#[0-9a-f]{6}$/.test(body.tone.hex)?body.tone.hex:fail('tone.hex'),
    ita:int(body.tone.ita,-90,90,'tone.ita')};
  out.imageQuality=body.imageQuality==null?null:typeof body.imageQuality==='boolean'?body.imageQuality:fail('imageQuality');
  obj(body.answers,'answers');
  out.answers={};
  for(const question of questions){
    const allowed=question.options.map(o=>o[0]),v=body.answers[question.id];
    if(question.multi){
      if(!Array.isArray(v)||v.some(x=>!allowed.includes(x)))fail(`answers.${question.id}`);
      out.answers[question.id]=[...new Set(v)];
    }else out.answers[question.id]=v==null?null:allowed.includes(v)?v:fail(`answers.${question.id}`);
  }
  return out;
}

/* ---- HTTP ---- */
function send(res,status,body){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body==null?'':JSON.stringify(body));
}
function readJson(req){
  return new Promise((resolve,reject)=>{
    if(!/^application\/json\b/.test(req.headers['content-type']||''))return reject(new Invalid('content-type'));
    let size=0;const parts=[];
    // Past the limit the rest is read and dropped, so the refusal still gets through.
    req.on('data',c=>{size+=c.length;if(size>MAX_BODY)reject(new Invalid('too large'));else parts.push(c);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(new Invalid('json'));}});
    req.on('error',reject);
  });
}
const ownerOf=req=>{
  const key=req.headers['x-roja-key'];
  return typeof key==='string'&&/^[0-9a-f]{32}$/.test(key)?createHash('sha256').update(key).digest('hex'):null;
};

function handle(req,res){
  const url=new URL(req.url,'http://local');
  const path=url.pathname.replace(/^\/api\/skin/,'');
  if(!url.pathname.startsWith('/api/skin'))return send(res,404,{error:'not found'});
  const owner=ownerOf(req);
  if(!owner)return send(res,401,{error:'key'});
  (async()=>{
    if(path===''||path==='/'){
      if(req.method==='GET'){
        const items=q.list.all(owner).map(r=>({id:r.id,created:r.created,record:JSON.parse(r.record),agree:r.agree==null?null:!!r.agree}));
        return send(res,200,{items});
      }
      if(req.method==='POST'){
        const record=clean(await readJson(req));
        if(q.count.get(owner).n>=PER_OWNER)return send(res,429,{error:'too many'});
        const id=randomUUID(),created=Date.now();
        q.insert.run(id,owner,created,JSON.stringify(record));
        return send(res,201,{id,created});
      }
      if(req.method==='DELETE'){q.wipe.run(owner);return send(res,204);}
      return send(res,405,{error:'method'});
    }
    const m=/^\/([0-9a-f-]{36})\/feedback$/.exec(path);
    if(m&&req.method==='POST'){
      const body=obj(await readJson(req),'feedback');
      if(typeof body.agree!=='boolean')fail('agree');
      const {changes}=q.agree.run(body.agree?1:0,m[1],owner);
      return changes?send(res,204):send(res,404,{error:'not found'});
    }
    send(res,404,{error:'not found'});
  })().catch(e=>{
    if(e instanceof Invalid)send(res,400,{error:'invalid',field:e.message});
    else{console.error(e);if(!res.headersSent)send(res,500,{error:'server'});}
  });
}

http.createServer(handle).listen(PORT,'127.0.0.1',()=>console.log(`roja skin api on 127.0.0.1:${PORT}`));
