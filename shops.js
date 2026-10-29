// The shops the mirror can sell for. Roja itself sells nothing: a shop puts the mirror
// on its own site (business/ shows how), and every "buy" in it leads to that shop.
//
// Which shop a page is for comes from its address, ?shop=<id> (or #shop=<id>), and is
// kept for the visit. Without one, the mirror is Roja's own demo and offers no buying,
// only the way to put it on a shop (unless `defaultShop` names one).
//
// A shop is:
//   name      shown on the buttons: "در خانومی ببین"
//   origin    the shop's own site, where "buy" messages may be posted when it embeds
//             the mirror (an exact origin: scheme, host, and port if any)
//   search    the shop's search address; {q} becomes the words searched for: a kind of
//             product and a shade's colour, "رژ لب جامد آجری"
//   links     optional: the shop's own page for a product, or for one shade of it,
//             keyed 'velvet' or 'velvet:8'; these win over a search
//   params    optional: added to every link (a referral or tracking code)
//   cart      true when the shop's page listens for "roja:buy" messages and puts the
//             product in its own cart; the mirror then stays where it is instead of
//             opening a link (see business/ for the message)
//   plan      'pro' for the professional plan wherever the mirror is (plan.js); shops
//             that subscribe on the business page are not listed here but kept on the
//             server, which says how long their plan runs
//
// Check `search` on the shop itself: a link that lands on "nothing found" is worse
// than none.
export const shops={
  // The demo on business/: "buy" lands on that page, where a shop's product would be.
  demo:{
    name:'فروشگاه نمونه',
    origin:'https://pythonpath.ir',
    plan:'pro',
    search:'https://pythonpath.ir/business/?q={q}#buy-demo'
  },
  // An example of a real shop's search. Put a shop here only once it has agreed.
  khanoumi:{
    name:'خانومی',
    origin:'https://www.khanoumi.com',
    search:'https://www.khanoumi.com/search?q={q}',
    params:{utm_source:'roja',utm_medium:'referral',utm_campaign:'mirror'}
  }
};
export const defaultShop=null;

// Who a shop talks to about putting the mirror on its site (business/).
//   whatsapp — the number in international form, digits only
//   telegram — the username without @
export const contact={
  whatsapp:'989116571248',
  telegram:'soroushamel'
};

const KEY='roja-shop';
// Shops that subscribed on the business page, as the server described them (resolveShop).
const registered={};
const known=id=>typeof id==='string'&&(Object.hasOwn(shops,id)||Object.hasOwn(registered,id));
const idFrom=loc=>{
  const from=s=>new URLSearchParams(s).get('shop');
  return from(loc?.search||'')||from((loc?.hash||'').replace(/^#/,''));
};
// The shop this page is for, or null. Only ids in `shops`, or ones the server knows,
// count, so an address cannot make the mirror send people anywhere a shop was not set
// up for.
export function currentShop(loc=globalThis.location){
  let id=null;
  try{
    id=idFrom(loc);
    if(known(id))sessionStorage.setItem(KEY,id);
    else id=sessionStorage.getItem(KEY);
  }catch{}
  id=known(id)?id:defaultShop;
  if(!id)return null;
  return Object.hasOwn(shops,id)?{id,...shops[id]}:{id,...registered[id]};
}
// The same, after asking the server about an id that is not in `shops`. Gives up after a
// few seconds (offline, or the app), and the mirror is then Roja's own.
export async function resolveShop(loc=globalThis.location){
  let id=null;
  try{id=idFrom(loc)||sessionStorage.getItem(KEY);}catch{}
  if(id&&!known(id)&&/^[a-z0-9-]{1,24}$/.test(id)&&!globalThis.RojaAndroid){
    try{
      const res=await fetch(`${new URL('api/shop',document.baseURI)}?id=${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(4000)});
      if(res.ok){const s=await res.json();
        if(s?.id===id&&typeof s.name==='string'&&typeof s.origin==='string')
          registered[id]={name:s.name,origin:s.origin,search:s.search||null,pro:!!s.pro};}
    }catch{}
  }
  return currentShop(loc);
}

// The words for one product in one shade. A skincare product is searched by its own
// name; a four-pan palette by its kind, since its colours vary too much.
export function searchWords(item,shade){
  if(item.kind==='skincare')return item.search||item.name;
  if(item.palettes)return item.search;
  return `${item.search||item.name} ${shade?.name||''}`.replace(/\s+/g,' ').trim();
}
function withParams(shop,url){
  const u=new URL(url);
  for(const [k,v] of Object.entries(shop.params||{}))if(v)u.searchParams.set(k,v);
  return u.toString();
}
// Where "buy" goes for this product and shade in this shop.
export function shopUrl(shop,item,shade){
  const own=shop.links?.[`${item.id}:${shade?.variantId}`]||shop.links?.[item.id];
  if(own)return withParams(shop,own);
  if(shop.search)return withParams(shop,shop.search.replace('{q}',encodeURIComponent(searchWords(item,shade))));
  return withParams(shop,shop.origin+'/');
}
