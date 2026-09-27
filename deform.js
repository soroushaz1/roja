// The displacement field behind the procedure preview.
//
// Every shape edit is a sum of localised deformers anchored on landmarks, expressed
// in a face-local frame so it tracks head tilt, distance and rotation. Each deformer
// decays to zero at its radius, so the background and the edges of the frame are
// never touched, and an all-zero set of amounts is exactly the identity.
//
// A few controls change skin texture rather than shape (the non-surgical
// treatments). Those are not deformers: textureLayers() turns them into masked
// smoothing passes for the stage.

// Region controls. Ids are stable: procedures and the fine-tuning panel address them.
// Shape controls run −100…100 with positive meaning "more"; texture controls 0…100.
export const regions=[
  {id:'nose',name:'بینی'},{id:'lips',name:'لب'},{id:'cheeks',name:'گونه و شقیقه'},
  {id:'jaw',name:'فک و چانه'},{id:'eyes',name:'چشم و ابرو'},{id:'skin',name:'پوست'}
];
export const controls=[
  {id:'nose-width',   region:'nose',  name:'پهنای پرهٔ بینی',     help:'باریک یا پهن‌شدن پرهٔ بینی'},
  {id:'nose-bridge',  region:'nose',  name:'پهنای تیغهٔ بینی',    help:'باریک یا پهن‌شدن تیغهٔ بینی'},
  {id:'nose-tip',     region:'nose',  name:'چرخش نوک بینی',       help:'بالا یا پایین‌رفتن نوک بینی'},
  {id:'nose-tip-size',region:'nose',  name:'حجم نوک بینی',        help:'ظریف یا گوشتی‌شدن نوک بینی'},
  {id:'lip-fullness', region:'lips',  name:'حجم کلی لب',          help:'نازک یا پرتر شدن هر دو لب'},
  {id:'lip-upper',    region:'lips',  name:'حجم لب بالا',         help:'نازک یا پرتر شدن لب بالا'},
  {id:'lip-lower',    region:'lips',  name:'حجم لب پایین',        help:'نازک یا پرتر شدن لب پایین'},
  {id:'lip-width',    region:'lips',  name:'پهنای دهان',          help:'کوچک یا پهن‌شدن دهان'},
  {id:'lip-corners',  region:'lips',  name:'گوشهٔ لب',            help:'پایین یا بالا رفتن گوشه‌های لب'},
  {id:'lip-lift',     region:'lips',  name:'فاصلهٔ بینی تا لب',    help:'کوتاه‌شدن فاصلهٔ زیر بینی تا لب بالا'},
  {id:'cheek-volume', region:'cheeks',name:'برجستگی گونه',        help:'کم یا پرحجم‌شدن گونه‌ها'},
  {id:'cheek-hollow', region:'cheeks',name:'گودی زیر گونه',       help:'گودافتادن یا پرشدن زیر استخوان گونه'},
  {id:'temple',       region:'cheeks',name:'پری شقیقه',           help:'گود یا پرشدن شقیقه‌ها'},
  {id:'jaw-width',    region:'jaw',   name:'پهنای فک',            help:'باریک یا پهن‌شدن زاویهٔ فک'},
  {id:'jowl',         region:'jaw',   name:'لیفت خط فک',          help:'افتادگی یا کشیدگی پوست کنار چانه'},
  {id:'chin-length',  region:'jaw',   name:'بلندی چانه',          help:'کوتاه یا بلندشدن چانه'},
  {id:'chin-width',   region:'jaw',   name:'پهنای چانه',          help:'باریک یا پهن‌شدن چانه'},
  {id:'eye-open',     region:'eyes',  name:'بازشدگی چشم',         help:'باز یا بسته‌تر شدن شکاف پلک'},
  {id:'eye-size',     region:'eyes',  name:'اندازهٔ چشم',         help:'کوچک یا بزرگ‌شدن چشم‌ها'},
  {id:'eye-tilt',     region:'eyes',  name:'کشیدگی گوشهٔ چشم',     help:'بالا رفتن گوشهٔ بیرونی چشم (فاکس‌آی)'},
  {id:'brow-lift',    region:'eyes',  name:'لیفت ابرو',           help:'بالا یا پایین‌رفتن کل ابرو'},
  {id:'brow-tail',    region:'eyes',  name:'دم ابرو',             help:'بالا یا پایین‌رفتن انتهای ابرو'},
  {id:'smooth-forehead',region:'skin',name:'صاف‌شدن پیشانی',      help:'کم‌شدن خطوط پیشانی و بین ابرو',texture:true},
  {id:'smooth-eyes',  region:'skin',  name:'صاف‌شدن دور چشم',     help:'کم‌شدن خطوط کنار و زیر چشم',texture:true},
  {id:'smooth-skin',  region:'skin',  name:'یکدستی پوست',         help:'نرم‌تر و یکدست‌تر شدن بافت پوست',texture:true},
  {id:'undereye',     region:'skin',  name:'روشن‌شدن زیر چشم',    help:'کم‌شدن گودی و تیرگی زیر چشم',texture:true}
];
export const controlRange=control=>control.texture?[0,100]:[-100,100];

export const zeroAmounts=()=>Object.fromEntries(controls.map(c=>[c.id,0]));

// Which landmarks each control anchors on, so the debug overlay can highlight the
// region a procedure is actually moving. roja-check.cjs re-reads the p(N) calls in
// deformers() and fails if these fall behind the code.
export const frameLandmarks=[234,454];          // the ear-to-ear pair, used by every edit
export const controlLandmarks={
  'nose-width':[1,2],
  'nose-bridge':[168,6],
  'nose-tip':[1],
  'nose-tip-size':[1,4],
  'lip-fullness':[0,17],
  'lip-upper':[0,13],
  'lip-lower':[14,17],
  'lip-width':[13,14],
  'lip-corners':[61,291],
  'lip-lift':[0],
  'cheek-volume':[50,280],
  'cheek-hollow':[50,61,280,291,132,58,361,288],
  'temple':[162,21,70,389,251,300],
  'jaw-width':[172,397],
  'jowl':[150,136,379,365],
  'chin-length':[152],
  'chin-width':[175],
  'eye-open':[33,133,362,263],
  'eye-size':[33,133,362,263],
  'eye-tilt':[33,263],
  'brow-lift':[105,107,334,336],
  'brow-tail':[70,46,300,276],
  'smooth-forehead':[10,54,284,9],
  'smooth-eyes':[33,263,145,374],
  'smooth-skin':[10,152,234,454],
  'undereye':[145,374]
};

const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const unit=v=>{const l=Math.hypot(v.x,v.y)||1;return {x:v.x/l,y:v.y/l};};
const blend=(a,ka,b,kb)=>unit({x:a.x*ka+b.x*kb,y:a.y*ka+b.y*kb});
const neg=v=>({x:-v.x,y:-v.y});

const AXIS=0, RADIAL=1, SHIFT=2;

export function deformers(landmarks, width, height, amounts) {
  const p=i=>({x:landmarks[i].x*width, y:landmarks[i].y*height});
  const left=p(234), right=p(454);
  const ex=unit(sub(right,left));           // across the face, towards landmark 454
  const ey={x:-ex.y, y:ex.x};               // down the face
  const up=neg(ey);
  const face=Math.hypot(right.x-left.x, right.y-left.y)||1;
  const out=[];
  const at=id=>(amounts[id]||0)/100;

  const axis=(anchor,r,v,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:AXIS,vx:v.x,vy:v.y,a:gain});
  const radial=(anchor,r,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:RADIAL,vx:0,vy:0,a:gain});
  const shift=(anchor,r,v,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:SHIFT,vx:v.x*r,vy:v.y*r,a:gain});

  // Gains are tuned so a control at 100 is a clear but still plausible change.
  /* nose */
  axis(mix(p(1),p(2),.5), face*.20, ex, at('nose-width')*.75);
  axis(mix(p(168),p(6),.5), face*.14, ex, at('nose-bridge')*.70);
  shift(p(1), face*.16, up, at('nose-tip')*.60);
  radial(mix(p(1),p(4),.5), face*.10, at('nose-tip-size')*.45);

  /* lips */
  axis(mix(p(0),p(17),.5), face*.26, ey, at('lip-fullness')*.75);
  axis(mix(p(0),p(13),.5), face*.13, ey, at('lip-upper')*.65);
  axis(mix(p(14),p(17),.5), face*.14, ey, at('lip-lower')*.65);
  axis(mix(p(13),p(14),.5), face*.30, ex, at('lip-width')*.35);
  shift(p(61),  face*.08, up, at('lip-corners')*.30);
  shift(p(291), face*.08, up, at('lip-corners')*.30);
  shift(p(0), face*.10, up, at('lip-lift')*.28);

  /* cheeks and temples */
  radial(p(50),  face*.24, at('cheek-volume')*.58);
  radial(p(280), face*.24, at('cheek-volume')*.58);
  // Buccal hollow sits lower and more forward than the cheekbone itself; from the
  // front, the visible change is the lower cheek line moving in.
  radial(mix(p(50),p(61),.62),  face*.21, -at('cheek-hollow')*.60);
  radial(mix(p(280),p(291),.62),face*.21, -at('cheek-hollow')*.60);
  shift(mix(p(132),p(58),.5), face*.20, ex,      at('cheek-hollow')*.16);
  shift(mix(p(361),p(288),.5),face*.20, neg(ex), at('cheek-hollow')*.16);
  shift(mix(mix(p(162),p(21),.5),p(70),.3),  face*.15, neg(ex), at('temple')*.25);
  shift(mix(mix(p(389),p(251),.5),p(300),.3),face*.15, ex,      at('temple')*.25);

  /* jaw and chin */
  shift(p(172), face*.34, neg(ex), at('jaw-width')*.32);
  shift(p(397), face*.34, ex,      at('jaw-width')*.32);
  shift(mix(p(150),p(136),.5), face*.20, blend(up,.85,ex,.5),      at('jowl')*.22);
  shift(mix(p(379),p(365),.5), face*.20, blend(up,.85,neg(ex),.5), at('jowl')*.22);
  shift(p(152), face*.26, ey, at('chin-length')*.34);
  axis(p(175), face*.17, ex, at('chin-width')*.55);

  /* eyes and brows */
  const leftEye=mix(p(33),p(133),.5), rightEye=mix(p(362),p(263),.5);
  radial(leftEye,  face*.15, at('eye-size')*.55);
  radial(rightEye, face*.15, at('eye-size')*.55);
  axis(leftEye,  face*.13, ey, at('eye-open')*.60);
  axis(rightEye, face*.13, ey, at('eye-open')*.60);
  shift(p(33),  face*.085, blend(up,1,neg(ex),.3), at('eye-tilt')*.24);
  shift(p(263), face*.085, blend(up,1,ex,.3),      at('eye-tilt')*.24);
  shift(mix(p(105),p(107),.5), face*.20, up, at('brow-lift')*.22);
  shift(mix(p(334),p(336),.5), face*.20, up, at('brow-lift')*.22);
  shift(mix(p(70),p(46),.5),   face*.10, up, at('brow-tail')*.28);
  shift(mix(p(300),p(276),.5), face*.10, up, at('brow-tail')*.28);
  return out;
}

// d(q) = Σ amount · smoothstep(1 − |q−anchor|/r) · direction
export function displace(defs, x, y, out) {
  let dx=0, dy=0;
  for (let i=0;i<defs.length;i++) {
    const d=defs[i], ax=x-d.x, ay=y-d.y, dist2=ax*ax+ay*ay;
    if (dist2>=d.r*d.r) continue;
    const t=1-Math.sqrt(dist2)/d.r, s=t*t*(3-2*t)*d.a;
    if (d.kind===AXIS) {const proj=ax*d.vx+ay*d.vy; dx+=s*proj*d.vx; dy+=s*proj*d.vy;}
    else if (d.kind===RADIAL) {dx+=s*ax; dy+=s*ay;}
    else {dx+=s*d.vx; dy+=s*d.vy;}
  }
  out.x=dx; out.y=dy;
}

// The texture controls as stage layers: masked, edge-preserving smoothing, and a
// gentle lift for the under-eye area. Masks come from makeup.js's `texture` shapes.
export function textureLayers(amounts){
  const out=[];
  const at=id=>Math.max(0,Math.min(100,amounts[id]||0))/100;
  if(at('smooth-skin'))    out.push({key:'tx:skin',    zone:'skin',    smooth:at('smooth-skin')*.85});
  if(at('smooth-forehead'))out.push({key:'tx:forehead',zone:'forehead',smooth:at('smooth-forehead')});
  if(at('smooth-eyes'))    out.push({key:'tx:eyes',    zone:'eyes',    smooth:at('smooth-eyes')});
  if(at('undereye'))       out.push({key:'tx:undereye',zone:'undereye',smooth:at('undereye')*.5,bright:at('undereye')});
  return out;
}
