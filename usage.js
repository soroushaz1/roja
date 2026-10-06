// Anonymous usage counts: which shades, looks and procedures are tried, what is opened in
// the shop, how often things are shared, and how far a visit got. Each count is a pair
// like ['shade','vlv-3'], sent in batches with the id of the shop whose mirror it is to
// server/stats.mjs, which keeps only a per-day total for each. No key, cookie, picture
// or answer is ever part of it.
//
// Not from the Android app (its pages are not on the site) or a development server.
import {currentShop} from './shops.js?v=24';

const API='api/stats';
// The shop whose mirror this is, so each shop's counts can be read on their own.
const shop=currentShop()?.id||'';
const on=!window.RojaAndroid&&location.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const queue=[];
const seen=new Set();

// A shade or a look counts once per visit however often it is picked again, so going
// through the shades with the arrow keys does not count each of them many times.
export function count(event,item,{each=false}={}){
  if(!on||!item)return;
  const key=`${event}\u0000${item}`;
  if(!each){if(seen.has(key))return;seen.add(key);}
  queue.push([event,item]);
  if(queue.length>=100)flush();
}
export function flush(){
  if(!queue.length)return;
  const body=JSON.stringify({events:queue.splice(0,100),...(shop&&{shop})});
  try{
    if(!navigator.sendBeacon?.(API,new Blob([body],{type:'application/json'})))
      fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});
  }catch{}
}
if(on){
  setInterval(flush,60000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});
  window.addEventListener('pagehide',flush);
}
