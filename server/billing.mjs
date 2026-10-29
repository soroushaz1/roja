// Shops' subscriptions: a shop pays for the professional plan through Zarinpal on the
// business page, and gets an activation code that names its shop from then on. The
// mirror on that shop's own site then opens the professional features (plan.js).
//
// What is kept, per shop: the id it got, its name, its site's origin, its search address,
// a contact number if given, how long the plan runs, and a hash of its activation code;
// per payment: the amount, Zarinpal's authority and reference, and the masked card number
// Zarinpal reports. Nothing about any shopper.
//
// Zarinpal's merchant id is read from ZARINPAL_MERCHANT and never kept in the
// repository. Without it the business page says payment is not open yet. With
// ZARINPAL_SANDBOX=1 every payment goes to Zarinpal's sandbox, where nothing is charged.
//
//   GET  /api/plans                 prices, and whether payment is open
//   POST /api/pay/start             {period, shop:{name,origin,search,contact}} a new shop,
//                                   or {period, code} renewing one → {url} to pay at
//   GET  /api/pay/back              where Zarinpal sends the payer back; verifies and
//                                   lands on /business/ with the code (new) or the news
//   POST /api/shop/login            {code} → the shop, for its panel on the business page
//   POST /api/shop/update           {code, name?, search?, origin?, contact?}
//   GET  /api/shop?id=…             what the mirror needs for a registered shop
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const DAY=86400000;
// Prices in toman. Set ROJA_PRICE_MONTH and ROJA_PRICE_YEAR on the server to change them.
export const periods={
  month:{name:'یک‌ماهه',days:31,env:'ROJA_PRICE_MONTH',price:990000},
  year:{name:'یک‌ساله',days:366,env:'ROJA_PRICE_YEAR',price:9900000}
};
const price=p=>{const v=Number(process.env[periods[p].env]);return Number.isInteger(v)&&v>=1000?v:periods[p].price;};

// Codes are read aloud and typed, so the alphabet leaves out what looks alike (0/O, 1/I/L).
const ALPHABET='23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newCode(){
  const bytes=randomBytes(16);let s='';
  for(let i=0;i<16;i++)s+=ALPHABET[bytes[i]%ALPHABET.length];
  return `RJ-${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8,12)}-${s.slice(12,16)}`;
}
// Spaces, dashes and lower case are forgiven when a code is typed back.
export const normalCode=c=>typeof c==='string'?c.toUpperCase().replace(/[^0-9A-Z]/g,'').replace(/^RJ/,''):'';
const hashCode=c=>createHash('sha256').update('roja-shop:'+normalCode(c)).digest('hex');

export function createBilling(db,{send,readJson,Invalid,staticShops={}}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, search TEXT, contact TEXT,
      code_hash TEXT NOT NULL UNIQUE, until INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(
      id TEXT PRIMARY KEY, shop_id TEXT, draft TEXT, period TEXT NOT NULL, amount INTEGER NOT NULL,
      authority TEXT UNIQUE, status TEXT NOT NULL, ref_id TEXT, card_pan TEXT,
      reveal TEXT, created INTEGER NOT NULL, paid INTEGER);`);
  const q={
    shop:db.prepare('SELECT * FROM shops WHERE id=?'),
    byCode:db.prepare('SELECT * FROM shops WHERE code_hash=?'),
    addShop:db.prepare('INSERT INTO shops(id,name,origin,search,contact,code_hash,until,created) VALUES (?,?,?,?,?,?,?,?)'),
    extend:db.prepare('UPDATE shops SET until=? WHERE id=?'),
    update:db.prepare('UPDATE shops SET name=?,origin=?,search=?,contact=? WHERE id=?'),
    addOrder:db.prepare('INSERT INTO orders(id,shop_id,draft,period,amount,status,created) VALUES (?,?,?,?,?,?,?)'),
    setAuthority:db.prepare('UPDATE orders SET authority=? WHERE id=?'),
    order:db.prepare('SELECT * FROM orders WHERE id=? AND authority=?'),
    paid:db.prepare("UPDATE orders SET status='paid',ref_id=?,card_pan=?,shop_id=?,reveal=?,paid=? WHERE id=? AND status='pending'"),
    failed:db.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'"),
    forget:db.prepare('UPDATE orders SET reveal=NULL WHERE reveal IS NOT NULL AND paid<?')
  };

  const merchant=()=>process.env.ZARINPAL_MERCHANT||'';
  const sandbox=()=>process.env.ZARINPAL_SANDBOX==='1';
  const gateway=()=>process.env.ZARINPAL_BASE||(sandbox()?'https://sandbox.zarinpal.com':'https://payment.zarinpal.com');
  const site=()=>(process.env.ROJA_SITE||'https://pythonpath.ir').replace(/\/$/,'');

  /* ---- what a shop may send ---- */
  const fail=what=>{throw new Invalid(what);};
  const text=(v,max,what)=>typeof v==='string'&&v.trim().length>=2&&v.trim().length<=max&&!/[<>\u0000-\u001f]/.test(v)?v.trim():fail(what);
  function origin(v){
    try{const u=new URL(v.trim());if(u.protocol==='https:'&&!u.username&&u.hostname.includes('.'))return u.origin;}catch{}
    fail('origin');
  }
  function search(v){
    if(v==null||v==='')return null;
    try{const u=new URL(v.trim().replace('{q}','QQQ'));
      if(u.protocol==='https:'&&v.includes('{q}'))return v.trim();}catch{}
    fail('search');
  }
  const contact=v=>v==null||v===''?null:typeof v==='string'&&/^\+?[0-9 -]{8,16}$/.test(v.trim())?v.trim().replace(/[ -]/g,''):fail('contact');

  // A shop's id comes from its site's name: shop.example.ir → example.
  function newId(o){
    const host=new URL(o).hostname.replace(/^www\./,'').split('.');
    const base=(host.length>2?host.at(-2):host[0]).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20)||'shop';
    for(let i=1;;i++){const id=i===1?base:`${base}-${i}`;if(!Object.hasOwn(staticShops,id)&&!q.shop.get(id))return id;}
  }

  const view=s=>({id:s.id,name:s.name,origin:s.origin,search:s.search,contact:s.contact,until:s.until,active:s.until>Date.now()});

  async function zarinpal(path,body){
    const res=await fetch(`${gateway()}/pg/v4/payment/${path}.json`,{method:'POST',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({merchant_id:merchant(),...body}),signal:AbortSignal.timeout(20000)});
    const json=await res.json().catch(()=>({}));
    return json?.data&&!Array.isArray(json.data)?json.data:{code:json?.errors?.code??res.status,message:json?.errors?.message};
  }

  async function start(req,res){
    if(!merchant())return send(res,503,{error:'closed'});
    const body=await readJson(req);
    const period=Object.hasOwn(periods,body?.period)?body.period:fail('period');
    let shop=null,draft=null;
    if(body.code!=null){
      shop=q.byCode.get(hashCode(body.code));
      if(!shop)return send(res,404,{error:'code'});
    }else{
      const s=body.shop||fail('shop');
      draft={name:text(s.name,40,'name'),origin:origin(s.origin),search:search(s.search),contact:contact(s.contact)};
    }
    const id=randomUUID(),amount=price(period);
    q.addOrder.run(id,shop?.id??null,draft&&JSON.stringify(draft),period,amount,'pending',Date.now());
    const name=shop?.name??draft.name;
    // Zarinpal counts in rials unless told otherwise; rials both ways keep request and
    // verify certain to agree.
    const r=await zarinpal('request',{amount:amount*10,
      description:`اشتراک ${periods[period].name} آینهٔ رُژا برای ${name}`.slice(0,250),
      callback_url:`${site()}/api/pay/back?order=${id}`,
      metadata:{order_id:id,...((shop?.contact??draft?.contact)&&{mobile:shop?.contact??draft.contact})}});
    if(r.code!==100||!r.authority){
      q.failed.run(id);console.error('zarinpal request',r.code,r.message);
      return send(res,502,{error:'gateway',code:r.code});
    }
    q.setAuthority.run(r.authority,id);
    send(res,200,{url:`${gateway()}/pg/StartPay/${r.authority}`});
  }

  // The payer's way back from Zarinpal. Always ends on the business page.
  async function back(res,url){
    const go=hash=>{res.writeHead(303,{Location:`${site()}/business/#${hash}`,'Cache-Control':'no-store'});res.end();};
    const id=url.searchParams.get('order')||'',authority=url.searchParams.get('Authority')||'';
    const order=/^[0-9a-f-]{36}$/.test(id)&&authority?q.order.get(id,authority):null;
    if(!order)return go('pay=unknown');
    // A code is shown for an hour after paying, should the page be opened again.
    q.forget.run(Date.now()-3600000);
    if(order.status==='paid'){
      const again=q.order.get(id,authority);
      return go(again.reveal?`pay=ok&code=${encodeURIComponent(again.reveal)}&shop=${again.shop_id}`:`pay=done&shop=${again.shop_id}`);
    }
    if(order.status!=='pending'||url.searchParams.get('Status')!=='OK'){q.failed.run(id);return go('pay=failed');}
    const r=await zarinpal('verify',{amount:order.amount*10,authority});
    if(r.code!==100&&r.code!==101){q.failed.run(id);console.error('zarinpal verify',r.code,r.message);return go('pay=failed');}
    const days=periods[order.period].days*DAY,now=Date.now();
    let shopId=order.shop_id,code=null;
    let raced=false;
    db.exec('BEGIN IMMEDIATE');
    try{
      // Two openings of the page at once: only one of them keeps the payment.
      if(q.order.get(id,authority).status!=='pending')raced=true;
      else if(shopId){
        const s=q.shop.get(shopId);q.extend.run(Math.max(s.until,now)+days,shopId);
      }else{
        const d=JSON.parse(order.draft);
        shopId=newId(d.origin);code=newCode();
        q.addShop.run(shopId,d.name,d.origin,d.search,d.contact,hashCode(code),now+days,now);
      }
      if(!raced)q.paid.run(String(r.ref_id??''),r.card_pan??null,shopId,code,now,id);
      db.exec(raced?'ROLLBACK':'COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    if(raced)return back(res,url);
    go(code?`pay=ok&code=${encodeURIComponent(code)}&shop=${shopId}`:`pay=renewed&shop=${shopId}`);
  }

  async function login(req,res){
    const s=q.byCode.get(hashCode((await readJson(req))?.code));
    return s?send(res,200,view(s)):send(res,404,{error:'code'});
  }
  async function update(req,res){
    const body=await readJson(req);
    const s=q.byCode.get(hashCode(body?.code));
    if(!s)return send(res,404,{error:'code'});
    const next={
      name:body.name!==undefined?text(body.name,40,'name'):s.name,
      origin:body.origin!==undefined?origin(body.origin):s.origin,
      search:body.search!==undefined?search(body.search):s.search,
      contact:body.contact!==undefined?contact(body.contact):s.contact};
    q.update.run(next.name,next.origin,next.search,next.contact,s.id);
    send(res,200,view(q.shop.get(s.id)));
  }

  // For the mirror: only what it shows, and whether the plan is running.
  function publicShop(id){
    const s=typeof id==='string'&&/^[a-z0-9-]{1,24}$/.test(id)?q.shop.get(id):null;
    return s&&{id:s.id,name:s.name,origin:s.origin,search:s.search,pro:s.until>Date.now(),until:s.until};
  }

  async function handle(req,res,url){
    const p=url.pathname;
    if(p==='/api/plans'&&req.method==='GET')
      return send(res,200,{open:!!merchant(),sandbox:sandbox(),
        periods:Object.fromEntries(Object.entries(periods).map(([k,v])=>[k,{name:v.name,days:v.days,price:price(k)}]))});
    if(p==='/api/pay/start'&&req.method==='POST')return start(req,res);
    if(p==='/api/pay/back'&&req.method==='GET')return back(res,url);
    if(p==='/api/shop/login'&&req.method==='POST')return login(req,res);
    if(p==='/api/shop/update'&&req.method==='POST')return update(req,res);
    if(p==='/api/shop'&&req.method==='GET'){
      const s=publicShop(url.searchParams.get('id'));
      return s?send(res,200,s):send(res,404,{error:'not found'});
    }
    return send(res,404,{error:'not found'});
  }

  return {handle,publicShop,isShop:id=>!!publicShop(id)};
}
