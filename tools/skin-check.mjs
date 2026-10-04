// Checks for the skin check: the scoring and routine (skin.js) and the server that
// keeps results (server/skin-api.mjs), against a throwaway database.
//
//   node tools/skin-check.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assess,record,fitzFromIta,combineScans,imageScores,questions} from '../skin.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('ok',name);};

const base={oil:'0',sens:'-0.4',pig:'-0.4',lines:'-1',sun:'0.5',burn:'3',concern:'prevent',using:[],irritants:[],age:'20',pregnant:'no'};
const scan=(over={})=>({tone:{L:62,a:12,b:17,ita:35,hue:55,chroma:21,hex:'#c99a84'},samples:6,quality:true,
  metrics:{shineT:.01,shineU:.002,redness:12,redPatches:.04,redSpots:.015,darkSpots:.015,uneven:1.4,texture:.9,
    foreheadLines:.1,crowLines:1.1,underEyeLines:1.2,underEyeDark:4,...over}});
const ids=list=>list.map(s=>s.product.id);

await check('Baumann letters follow the answers',()=>{
  assert.equal(assess({answers:{...base,oil:'1',sens:'1',pig:'1',lines:'1',age:'50'},scan:null}).baumann.code,'OSPW');
  assert.equal(assess({answers:{...base,oil:'-1',sens:'-1',pig:'-1',lines:'-1',age:'u20'},scan:null}).baumann.code,'DRNT');
});
await check('the picture moves an axis but does not overrule a clear answer',()=>{
  const shiny=assess({answers:{...base,oil:'0'},scan:scan({shineT:.06})}),flat=assess({answers:{...base,oil:'0'},scan:scan({shineT:0})});
  assert.ok(shiny.baumann.axes.od.value>flat.baumann.axes.od.value);
  assert.equal(assess({answers:{...base,oil:'-1'},scan:scan({shineT:.06})}).baumann.axes.od.letter,'D');
});
await check('confidence is higher when picture and answers agree',()=>{
  const agree=assess({answers:{...base,oil:'1'},scan:scan({shineT:.05})}).baumann.axes.od.conf;
  const disagree=assess({answers:{...base,oil:'1'},scan:scan({shineT:0})}).baumann.axes.od.conf;
  assert.ok(agree>disagree,`${agree} > ${disagree}`);
});
await check('Fitzpatrick comes from the sun answer, colour only nudges it',()=>{
  assert.equal(fitzFromIta(60),1);assert.equal(fitzFromIta(35),3);assert.equal(fitzFromIta(-40),6);
  assert.equal(assess({answers:{...base,burn:'2'},scan:null}).fitz.type,2);
  assert.equal(assess({answers:{...base,burn:'2'},scan:scan()}).fitz.type,2);       // ITA says III
  const colourOnly=assess({answers:{...base,burn:''},scan:scan()}).fitz;
  assert.equal(colourOnly.type,3);assert.ok(colourOnly.conf<50);
  assert.equal(assess({answers:{...base,burn:''},scan:null}).fitz,null);
});
await check('every routine has a cleanser, a moisturizer and sunscreen in the morning',()=>{
  for(const answers of [base,{...base,oil:'1'},{...base,oil:'-1',sens:'1'}]){
    const {morning,evening}=assess({answers,scan:scan()}).routine;
    assert.equal(morning[0].product.step,'cleanser');
    assert.equal(morning.at(-1).product.step,'sunscreen');
    assert.ok(morning.some(s=>s.product.step==='moisturizer'));
    assert.equal(evening[0].product.step,'cleanser');
  }
});
await check('acne-prone oily skin gets salicylic acid, or azelaic acid if acids irritate',()=>{
  const answers={...base,oil:'1',concern:'acne'};
  assert.ok(ids(assess({answers,scan:scan({redSpots:.07})}).routine.evening).includes('bha'));
  const irritated=ids(assess({answers:{...answers,irritants:['acids']},scan:scan({redSpots:.07})}).routine.evening);
  assert.ok(!irritated.includes('bha')&&irritated.includes('azelaic'));
});
await check('no retinoid in pregnancy or when retinoids irritate',()=>{
  const answers={...base,lines:'1',age:'50',concern:'aging'};
  assert.ok(ids(assess({answers,scan:scan()}).routine.evening).includes('retinal'));
  assert.ok(!ids(assess({answers:{...answers,pregnant:'yes'},scan:scan()}).routine.evening).includes('retinal'));
  assert.ok(!ids(assess({answers:{...answers,irritants:['retinoid']},scan:scan()}).routine.evening).includes('retinal'));
});
await check('sensitive skin gets one night active at most, and a mineral sunscreen',()=>{
  const r=assess({answers:{...base,sens:'1',irritants:['fragrance'],oil:'1',lines:'1',age:'50',concern:'acne'},scan:scan({redSpots:.07})});
  assert.ok(r.routine.evening.filter(s=>s.product.step==='treatment').length<=1);
  assert.equal(r.routine.morning.at(-1).product.id,'spf-tinted');
});
await check('salicylic acid and a retinoid are never used on the same night',()=>{
  const r=assess({answers:{...base,oil:'1',lines:'1',age:'50',concern:'acne'},scan:scan({redSpots:.07,foreheadLines:.6})});
  const night=ids(r.routine.evening);
  assert.ok(night.includes('bha')&&night.includes('retinal'),night.join());
  assert.ok(r.routine.evening.filter(s=>['bha','retinal'].includes(s.product.id)).every(s=>/یک شب در میان/.test(s.note)));
});
await check('without a picture, only what was asked or named is scored',()=>{
  const c=assess({answers:{...base,sens:'1'},scan:null}).concerns;
  for(const k of ['redness','acne','texture','underEye'])assert.ok(!(k in c),k);
  assert.ok(c.sensitivity>=80);
  assert.equal(assess({answers:{...base,concern:'acne'},scan:null}).concerns.acne,60);
});
await check('scans are combined by median, each quality check by majority',()=>{
  const q=(sharp,light)=>[{id:'sharp',ok:sharp},{id:'light',ok:light}];
  const c=combineScans([{...scan({texture:1}),quality:q(true,false)},{...scan({texture:5}),quality:q(true,false)},{...scan({texture:2}),quality:q(false,true)},null]);
  assert.equal(c.metrics.texture,2);assert.equal(c.samples,3);
  assert.deepEqual(c.checks,{sharp:true,light:false});assert.equal(c.quality,false);
});
await check('a picture too small or blurred adds no detail scores, only what it can carry',()=>{
  const blurred=imageScores({...scan(),checks:{size:true,sharp:false,pose:true,light:true,colour:true,even:true}});
  for(const k of ['acne','pigment','texture','lines'])assert.ok(Number.isNaN(blurred[k]),k);
  assert.ok(Number.isFinite(blurred.red)&&Number.isFinite(blurred.oil));
  const yellow=assess({answers:base,scan:{...scan(),checks:{colour:false}}});
  assert.equal(yellow.fitz.from,'answers');
});

/* ---- the server ---- */
const dir=mkdtempSync(path.join(tmpdir(),'roja-skin-'));
const port=51000+Math.floor(Math.random()*800);
const server=spawn(process.execPath,[path.join(root,'server/skin-api.mjs')],
  {env:{...process.env,ROJA_PORT:String(port),ROJA_DB:path.join(dir,'test.db')},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',c=>reject(new Error(`server exited ${c}`)));});
const key='0123456789abcdef0123456789abcdef',other='fedcba9876543210fedcba9876543210';
const api=(method,p='',{body,k=key,raw}={})=>fetch(`http://127.0.0.1:${port}/api/skin${p}`,{method,
  headers:{...(k?{'X-Roja-Key':k}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
  body:raw??(body!==undefined?JSON.stringify(body):undefined)});
const answers={...base,irritants:['fragrance','fragrance']};
const kept=record(assess({answers,scan:scan()}),answers);
try{
  await check('a result is kept and read back by its key only',async()=>{
    assert.equal((await api('GET','',{k:null})).status,401);
    assert.equal((await api('GET','',{k:'nothex'})).status,401);
    const made=await api('POST','',{body:kept});
    assert.equal(made.status,201);
    const {id}=await made.json();
    const mine=await (await api('GET')).json();
    assert.equal(mine.items.length,1);assert.equal(mine.items[0].id,id);
    assert.equal(mine.items[0].record.baumann,kept.baumann);
    assert.deepEqual(mine.items[0].record.answers.irritants,['fragrance']);
    assert.equal((await (await api('GET','',{k:other})).json()).items.length,0);
  });
  await check('anything outside the record\'s shape is refused',async()=>{
    const bad=[
      {...kept,baumann:'XXXX'},{...kept,version:2},{...kept,concerns:{...kept.concerns,acne:101}},
      {...kept,concerns:{...kept.concerns,name:3}},{...kept,answers:{...kept.answers,oil:'7'}},
      {...kept,tone:{hex:'red',ita:3}},{...kept,photo:'data:'},{...kept,fitz:{type:9,conf:50,from:'both'}}
    ];
    for(const body of bad){
      const r=await api('POST','',{body});
      if(body.photo)assert.equal(r.status,201);                       // unknown fields are dropped…
      else assert.equal(r.status,400,JSON.stringify(body).slice(0,80));
    }
    const items=(await (await api('GET')).json()).items;
    assert.ok(items.every(i=>!('photo' in i.record)));                   // …never stored
    assert.equal((await api('POST','',{raw:'{',body:null})).status,400);
    assert.equal((await api('POST','',{raw:JSON.stringify({...kept,pad:'x'.repeat(9000)}),body:null})).status,400);
  });
  await check('feedback is recorded on the owner\'s result only',async()=>{
    const {items}=await (await api('GET')).json();
    const id=items[0].id;
    assert.equal((await api('POST',`/${id}/feedback`,{body:{agree:true},k:other})).status,404);
    assert.equal((await api('POST',`/${id}/feedback`,{body:{agree:'yes'}})).status,400);
    assert.equal((await api('POST',`/${id}/feedback`,{body:{agree:false}})).status,204);
    assert.equal((await (await api('GET')).json()).items.find(i=>i.id===id).agree,false);
  });
  await check('deleting removes every result for the key and no other',async()=>{
    await api('POST','',{body:kept,k:other});
    assert.equal((await api('DELETE')).status,204);
    assert.equal((await (await api('GET')).json()).items.length,0);
    assert.equal((await (await api('GET','',{k:other})).json()).items.length,1);
  });
}finally{
  server.kill();
  await new Promise(r=>server.once('exit',r));
  rmSync(dir,{recursive:true,force:true});
}
assert.ok(questions.length>=10);
console.log(`\n${passed} checks passed`);
