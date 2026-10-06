// Anonymous usage counts: how many times each shade, look, procedure and cart item was
// tried, per day. That is all a row is, (day, event, item, count): no key, no cookie, no
// address, no time of day, nothing that tells one visitor from another. nginx keeps no
// access log for it either. Every item is checked against the catalogue, so the table
// can only ever hold names the site itself has.
//
// Reading the counts needs ROJA_STATS_KEY (sent as X-Roja-Stats-Key); without it set,
// nobody can read them.
import {timingSafeEqual,createHash} from 'node:crypto';
import {products,looks} from '../catalog.js';
import {procedures} from '../procedures.js';
import {skincare} from '../skin.js';

const shadeIds=new Set(products.flatMap(p=>p.shades.map(s=>s.id)));
const cartKeys=new Set([...products,...skincare].flatMap(p=>p.shades.map(s=>`${p.id}:${s.variantId}`)));
export const events={
  shade:item=>shadeIds.has(item),
  look:item=>looks.some(l=>l.id===item)||item==='mine'||item==='link',
  procedure:item=>procedures.some(p=>p.id===item),
  cart:item=>cartKeys.has(item),
  share:item=>['shot','multi','link'].includes(item),
  order:item=>['whatsapp','telegram','share'].includes(item)
};
const MAX_EVENTS=100, MAX_DAYS=366;
// Tehran's calendar day, which is the shop's.
const dayOf=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran'}).format(t);

export function createStats(db,{send,readJson,Invalid}){
  db.exec(`CREATE TABLE IF NOT EXISTS counts(
    day TEXT NOT NULL, event TEXT NOT NULL, item TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY(day,event,item)) WITHOUT ROWID;`);
  const add=db.prepare('INSERT INTO counts(day,event,item,n) VALUES (?,?,?,?) ON CONFLICT(day,event,item) DO UPDATE SET n=n+excluded.n');
  const since=db.prepare('SELECT day,event,item,n FROM counts WHERE day>=? ORDER BY day');
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
      // Counted together, so one visit adds one write per item, not one per event.
      const counts=new Map();
      for(const e of list){
        if(!Array.isArray(e)||e.length!==2||typeof e[0]!=='string'||typeof e[1]!=='string'||!events[e[0]]?.(e[1]))throw new Invalid('event');
        const k=`${e[0]}\u0000${e[1]}`;counts.set(k,(counts.get(k)||0)+1);
      }
      const day=dayOf(new Date());
      db.exec('BEGIN');
      try{for(const [k,n] of counts){const [event,item]=k.split('\u0000');add.run(day,event,item,n);}db.exec('COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
      return send(res,204);
    }
    if(req.method==='GET'){
      if(!allowed(req))return send(res,403,{error:'key'});
      const days=Math.min(MAX_DAYS,Math.max(1,Number.parseInt(url.searchParams.get('days'),10)||30));
      const from=dayOf(new Date(Date.now()-(days-1)*864e5));
      return send(res,200,{from,to:dayOf(new Date()),rows:since.all(from).map(r=>[r.day,r.event,r.item,r.n])});
    }
    send(res,405,{error:'method'});
  };
}
