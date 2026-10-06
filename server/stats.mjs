// Anonymous usage counts: how many times each shade, look, procedure was tried and how often
// a product was opened on the partner store, per day and per shop whose mirror it was
// (or Roja's own site). That is all a row is, (day, shop, event, item, count): no key, no
// cookie, no address, no time of day, nothing that tells one visitor from another. nginx
// keeps no access log for it either. Every item is checked against the catalogue and every
// shop against shops.js, so the table can only ever hold names the site itself has.
//
// Reading the counts needs ROJA_STATS_KEY (sent as X-Roja-Stats-Key); without it set,
// nobody can read them.
import {timingSafeEqual,createHash} from 'node:crypto';
import {products,looks} from '../catalog.js';
import {procedures} from '../procedures.js';
import {skincare} from '../skin.js';
import {shops} from '../shops.js';

const shadeIds=new Set(products.flatMap(p=>p.shades.map(s=>s.id)));
const productKeys=new Set([...products,...skincare].flatMap(p=>p.shades.map(s=>`${p.id}:${s.variantId}`)));
export const events={
  shade:item=>shadeIds.has(item),
  look:item=>looks.some(l=>l.id===item)||item==='mine'||item==='link',
  procedure:item=>procedures.some(p=>p.id===item),
  // A product (and shade) opened on the partner store (partner.js).
  buy:item=>productKeys.has(item),
  share:item=>['shot','multi','link'].includes(item),
  // How far a visit got, each counted once per visit: the page opened, the camera or a
  // photo started, a face was found, a shade was tried, a product was opened in the shop.
  step:item=>steps.includes(item)
};
export const steps=['open','camera','photo','face','shade','buy'];
const MAX_EVENTS=100, MAX_DAYS=366;
// Tehran's calendar day.
const dayOf=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran'}).format(t);

export function createStats(db,{send,readJson,Invalid}){
  // shop is '' on Roja's own site. A table from before shops were counted is moved over,
  // its rows Roja's own.
  const create=name=>`CREATE TABLE IF NOT EXISTS ${name}(
    day TEXT NOT NULL, shop TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, item TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY(day,shop,event,item)) WITHOUT ROWID;`;
  const columns=db.prepare('SELECT name FROM pragma_table_info(?)').all('counts').map(c=>c.name);
  if(columns.length&&!columns.includes('shop')){
    db.exec('BEGIN');
    try{
      db.exec(`ALTER TABLE counts RENAME TO counts_before_shops;${create('counts')}
        INSERT INTO counts(day,shop,event,item,n) SELECT day,'',event,item,n FROM counts_before_shops;
        DROP TABLE counts_before_shops;COMMIT;`);
    }catch(e){db.exec('ROLLBACK');throw e;}
  }else db.exec(create('counts'));
  const add=db.prepare('INSERT INTO counts(day,shop,event,item,n) VALUES (?,?,?,?,?) ON CONFLICT(day,shop,event,item) DO UPDATE SET n=n+excluded.n');
  const since=db.prepare('SELECT day,shop,event,item,n FROM counts WHERE day>=? ORDER BY day');
  const keyHash=process.env.ROJA_STATS_KEY?createHash('sha256').update(process.env.ROJA_STATS_KEY).digest():null;
  const allowed=req=>{
    const given=req.headers['x-roja-stats-key'];
    return !!keyHash&&typeof given==='string'&&timingSafeEqual(createHash('sha256').update(given).digest(),keyHash);
  };

  return async function handle(req,res,url){
    if(req.method==='POST'){
      const body=await readJson(req);
      const list=body?.events;
      if(!Array.isArray(list)||!list.length||list.length>MAX_EVENTS)throw new Invalid('events');
      const shop=body.shop??'';
      if(shop!==''&&!(typeof shop==='string'&&Object.hasOwn(shops,shop)))throw new Invalid('shop');
      // Counted together, so one visit adds one write per item, not one per event.
      const counts=new Map();
      for(const e of list){
        if(!Array.isArray(e)||e.length!==2||typeof e[0]!=='string'||typeof e[1]!=='string'||!events[e[0]]?.(e[1]))throw new Invalid('event');
        const k=`${e[0]}\u0000${e[1]}`;counts.set(k,(counts.get(k)||0)+1);
      }
      const day=dayOf(new Date());
      db.exec('BEGIN');
      try{for(const [k,n] of counts){const [event,item]=k.split('\u0000');add.run(day,shop,event,item,n);}db.exec('COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
      return send(res,204);
    }
    if(req.method==='GET'){
      if(!allowed(req))return send(res,403,{error:'key'});
      const days=Math.min(MAX_DAYS,Math.max(1,Number.parseInt(url.searchParams.get('days'),10)||30));
      const from=dayOf(new Date(Date.now()-(days-1)*864e5));
      return send(res,200,{from,to:dayOf(new Date()),shops:Object.fromEntries(Object.entries(shops).map(([id,s])=>[id,s.name])),
        rows:since.all(from).map(r=>[r.day,r.event,r.item,r.n,r.shop])});
    }
    send(res,405,{error:'method'});
  };
}
