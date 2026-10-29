// What this mirror offers: the professional plan or the free one.
//
// Shops pay for the professional plan (server/billing.mjs, business/). A shop's mirror
// opens it only on that shop's own site: inside its page (an iframe) or reached by a link
// from it. The same address opened anywhere else is the free mirror. On Roja's own site
// (no shop), everything is shown, with the professional parts marked, so a shop can see
// what it would get.
//
// The professional plan adds:
//   shades     every shade of every product (free: about half, spread over each range,
//              so no skin tone loses its foundation)
//   looks      every ready-made look (free: the first two)
//   skin       the full skin check: the routine, keeping results and comparing them
//   photo      pictures at the camera's full size, without Roja's mark, and several
//              shades side by side (free: marked, at most 720 px on the long side)
//   view3d     the face as a model to turn (3D)
//
// The mirror runs on the shopper's device, so this is a matter of what is offered, not
// a lock: the agreement with the shop is what binds.
export const FREE_LOOKS=['natural','office'];
export const FREE_PHOTO_PX=720;

// The page this mirror sits in, if any, as an origin.
function hostOrigin(){
  try{const a=location.ancestorOrigins;if(a&&a.length)return a[0];}catch{}
  try{if(document.referrer)return new URL(document.referrer).origin;}catch{}
  return null;
}
const local=()=>['localhost','127.0.0.1','[::1]'].includes(location.hostname);

// Once seen coming from the shop's site, the rest of the visit keeps the plan, as the
// pages of Roja's own site that a shopper may open on the way do not come from there.
const SEEN='roja-plan';
export function planFor(shop){
  if(!shop)return {pro:true,showcase:true};
  if(shop.plan==='pro')return {pro:true,showcase:false};
  if(shop.pro){
    let seen=false;try{seen=sessionStorage.getItem(SEEN)===shop.id;}catch{}
    if(seen||local()||hostOrigin()===shop.origin){
      try{sessionStorage.setItem(SEEN,shop.id);}catch{}
      return {pro:true,showcase:false};
    }
  }
  return {pro:false,showcase:false};
}

// The shades the free plan keeps: an even spread over each product's range, and every
// shade a free look uses, so those looks stay as they are.
export function freeShadeIds(products,looks){
  const keep=new Set();
  for(const look of looks.filter(l=>FREE_LOOKS.includes(l.id)))for(const [,shade] of look.items)if(shade!=='auto')keep.add(shade);
  for(const p of products){
    const n=p.shades.length,take=n<=4?n:Math.max(3,Math.ceil(n/2));
    for(let i=0;i<take;i++)keep.add(p.shades[Math.round(i*(n-1)/Math.max(1,take-1))].id);
  }
  return keep;
}

// Trims the catalogue in place to the free plan, before anything is drawn from it.
export function applyFreePlan(products,looks){
  const keep=freeShadeIds(products,looks);
  for(const p of products)p.shades=p.shades.filter(s=>keep.has(s.id));
  for(let i=looks.length-1;i>=0;i--)if(!FREE_LOOKS.includes(looks[i].id))looks.splice(i,1);
}
