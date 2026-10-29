// Checks for shops' subscriptions (server/billing.mjs) end to end, against a throwaway
// database and a stand-in for Zarinpal on this machine: prices, a new shop paying and
// getting its code, the way back opened twice, a payment refused or cancelled, renewing,
// the shop's panel, what the mirror is told, and that the usage counts take the new shop.
//
//   node tools/billing-check.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('ok',name);};

// The stand-in gateway: remembers what it was asked, and answers like Zarinpal's v4.
const gw={requests:[],verifies:[],refuse:false,paid:new Set()};
const gateway=http.createServer((req,res)=>{
  let body='';req.on('data',c=>body+=c);
  req.on('end',()=>{
    const b=JSON.parse(body||'{}');
    const out=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data,errors:[]}));};
    if(req.url==='/pg/v4/payment/request.json'){
      gw.requests.push(b);
      if(gw.refuse){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:[],errors:{code:-9,message:'validation'}}));}
      return out({code:100,authority:`A${String(gw.requests.length).padStart(35,'0')}`,fee_type:'Merchant',fee:0});
    }
    if(req.url==='/pg/v4/payment/verify.json'){
      gw.verifies.push(b);
      const again=gw.paid.has(b.authority);gw.paid.add(b.authority);
      return out({code:again?101:100,ref_id:1234+gw.verifies.length,card_pan:'502229******5995',fee:0});
    }
    res.writeHead(404);res.end();
  });
});
await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
const gwBase=`http://127.0.0.1:${gateway.address().port}`;

const dir=mkdtempSync(path.join(tmpdir(),'roja-billing-'));
const port=51900+Math.floor(Math.random()*90);
const server=spawn(process.execPath,[path.join(root,'server/skin-api.mjs')],
  {env:{...process.env,ROJA_PORT:String(port),ROJA_DB:path.join(dir,'test.db'),ZARINPAL_MERCHANT:'00000000-0000-0000-0000-000000000000',
    ZARINPAL_BASE:gwBase,ROJA_SITE:'https://roja.test',ROJA_PRICE_MONTH:'500000'},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',c=>reject(new Error(`server exited ${c}`)));});

const base=`http://127.0.0.1:${port}`;
const post=(p,body)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const back=async query=>{const r=await fetch(`${base}/api/pay/back?${query}`,{redirect:'manual'});
  assert.equal(r.status,303);const loc=new URL(r.headers.get('location'));
  assert.equal(loc.origin+loc.pathname,'https://roja.test/business/');return new URLSearchParams(loc.hash.slice(1));};
const startUrl=async body=>{const r=await post('/api/pay/start',body);assert.equal(r.status,200,await r.clone().text());return (await r.json()).url;};
const orderOf=()=>gw.requests.at(-1).callback_url.split('order=')[1];
const authorityOf=url=>url.split('/StartPay/')[1];

const newShop={name:'آرایشی نمونه',origin:'https://www.shop-sample.ir/some/page',search:'https://www.shop-sample.ir/search?q={q}',contact:'0912 000 0000'};
let code=null,first=null;
try{
  await check('the prices come from the server, the month from its setting',async()=>{
    const p=await (await fetch(base+'/api/plans')).json();
    assert.equal(p.open,true);assert.equal(p.periods.month.price,500000);assert.equal(p.periods.year.price,9900000);
  });

  await check('what a new shop sends is checked before anything is charged',async()=>{
    for(const shop of [{...newShop,name:'x'},{...newShop,origin:'http://shop-sample.ir'},{...newShop,origin:'not a site'},
      {...newShop,search:'https://shop-sample.ir/search'},{...newShop,name:'<b>shop</b>'},{...newShop,contact:'call me'}]){
      assert.equal((await post('/api/pay/start',{period:'month',shop})).status,400,JSON.stringify(shop));
    }
    assert.equal((await post('/api/pay/start',{period:'week',shop:newShop})).status,400);
    assert.equal(gw.requests.length,0);
  });

  await check('a new shop pays in rials, comes back with its code, and is a shop from then on',async()=>{
    const url=await startUrl({period:'month',shop:newShop});
    assert.match(url,/\/pg\/StartPay\/A0+1$/);
    first=`order=${orderOf()}&Authority=${authorityOf(url)}&Status=OK`;
    const asked=gw.requests[0];
    assert.equal(asked.amount,5000000);assert.equal(asked.merchant_id,'00000000-0000-0000-0000-000000000000');
    assert.equal(asked.metadata.mobile,'09120000000');
    const h=await back(`order=${orderOf()}&Authority=${authorityOf(url)}&Status=OK`);
    assert.equal(h.get('pay'),'ok');assert.equal(h.get('shop'),'shop-sample');
    code=h.get('code');assert.match(code,/^RJ-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.equal(gw.verifies[0].amount,5000000);
    const s=await (await fetch(base+'/api/shop?id=shop-sample')).json();
    assert.equal(s.name,newShop.name);assert.equal(s.origin,'https://www.shop-sample.ir');assert.equal(s.pro,true);
    assert.ok(s.until>Date.now()+30*864e5);
    assert.equal(s.contact,undefined);
  });

  await check('the way back opened again shows the same code, and charges nothing more',async()=>{
    const h=await back(first);
    assert.equal(h.get('code'),code);assert.equal(gw.verifies.length,1);
  });

  await check('a wrong order or authority, a cancelled or refused payment, gives no shop',async()=>{
    assert.equal((await back('order=nope&Authority=x&Status=OK')).get('pay'),'unknown');
    await startUrl({period:'month',shop:{...newShop,origin:'https://other.ir'}});
    const order=orderOf();
    assert.equal((await back(`order=${order}&Authority=Awrong&Status=OK`)).get('pay'),'unknown');
    assert.equal((await back(`order=${order}&Authority=A${'2'.padStart(35,'0')}&Status=NOK`)).get('pay'),'failed');
    assert.equal((await fetch(base+'/api/shop?id=other')).status,404);
    gw.refuse=true;
    assert.equal((await post('/api/pay/start',{period:'month',shop:newShop})).status,502);
    gw.refuse=false;
  });

  await check('the code opens the panel, typed any old way, and only the right code does',async()=>{
    const loose=code.toLowerCase().replace(/-/g,' ');
    const me=await (await post('/api/shop/login',{code:loose})).json();
    assert.equal(me.id,'shop-sample');assert.equal(me.contact,'09120000000');assert.equal(me.active,true);
    assert.equal((await post('/api/shop/login',{code:'RJ-AAAA-AAAA-AAAA-AAAA'})).status,404);
    assert.equal((await post('/api/shop/login',{})).status,404);
  });

  await check('the panel changes the name and search, within the same rules',async()=>{
    const r=await post('/api/shop/update',{code,name:'آرایشی تازه',search:'https://www.shop-sample.ir/s?k={q}'});
    assert.equal(r.status,200);assert.equal((await r.json()).name,'آرایشی تازه');
    assert.equal((await post('/api/shop/update',{code,origin:'ftp://x.ir'})).status,400);
    assert.equal((await post('/api/shop/update',{code:'RJ-2222-2222-2222-2222',name:'نه'})).status,404);
  });

  await check('renewing with the code adds a year to what is left',async()=>{
    const before=(await (await fetch(base+'/api/shop?id=shop-sample')).json()).until;
    const url=await startUrl({period:'year',code});
    assert.equal(gw.requests.at(-1).amount,99000000);
    const h=await back(`order=${orderOf()}&Authority=${authorityOf(url)}&Status=OK`);
    assert.equal(h.get('pay'),'renewed');assert.equal(h.get('code'),null);
    const after=(await (await fetch(base+'/api/shop?id=shop-sample')).json()).until;
    assert.equal(after-before,366*864e5);
    assert.equal((await post('/api/pay/start',{period:'year',code:'RJ-2222-2222-2222-2222'})).status,404);
  });

  await check('a second shop on the same name gets an id of its own',async()=>{
    const url=await startUrl({period:'month',shop:{...newShop,origin:'https://shop-sample.com'}});
    const h=await back(`order=${orderOf()}&Authority=${authorityOf(url)}&Status=OK`);
    assert.equal(h.get('shop'),'shop-sample-2');
  });

  await check('the usage counts take a subscribed shop, and still refuse one that is not',async()=>{
    const stats=shop=>post('/api/stats',{events:[['step','open']],shop});
    assert.equal((await stats('shop-sample')).status,204);
    assert.equal((await stats('no-such-shop')).status,400);
  });

  await check('a shop id that is not one gives nothing',async()=>{
    for(const id of ['','../x','A'.repeat(30),'missing'])assert.equal((await fetch(`${base}/api/shop?id=${encodeURIComponent(id)}`)).status,404);
  });
}finally{
  server.kill();gateway.close();rmSync(dir,{recursive:true,force:true});
}
console.log(`${passed} billing checks passed`);
