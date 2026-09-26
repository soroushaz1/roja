// The displacement field behind the procedure preview.
//
// Every edit is a sum of localised deformers anchored on landmarks, expressed in a
// face-local frame so it tracks head tilt, distance and rotation. Each deformer
// decays to zero at its radius, so the background and the edges of the frame are
// never touched, and an all-zero set of amounts is exactly the identity.

// Region controls. Ids are stable: procedures and the fine-tuning panel address them.
export const controls=[
  {id:'nose-width',   region:'بینی',  name:'پهنای بینی',        help:'باریک یا پهن‌شدن پرهٔ بینی'},
  {id:'nose-bridge',  region:'بینی',  name:'پهنای تیغهٔ بینی',  help:'باریک یا پهن‌شدن تیغهٔ بینی'},
  {id:'nose-tip',     region:'بینی',  name:'نوک بینی',          help:'بالا یا پایین‌رفتن نوک بینی'},
  {id:'lip-fullness', region:'لب',    name:'پری لب',            help:'نازک یا پرتر شدن لب‌ها'},
  {id:'cheek-volume', region:'گونه',  name:'برجستگی گونه',      help:'کم یا پرحجم‌شدن گونه‌ها'},
  {id:'cheek-hollow', region:'گونه',  name:'گودی زیر گونه',     help:'گودافتادن یا پرشدن زیر استخوان گونه'},
  {id:'jaw-width',    region:'فک',    name:'پهنای فک',          help:'باریک یا پهن‌شدن خط فک'},
  {id:'chin-length',  region:'چانه',  name:'بلندی چانه',        help:'کوتاه یا بلندشدن چانه'},
  {id:'eye-open',     region:'چشم',   name:'بازشدگی چشم',       help:'باز یا بسته‌تر شدن شکاف پلک'},
  {id:'eye-size',     region:'چشم',   name:'اندازهٔ چشم',       help:'کوچک یا بزرگ‌شدن چشم‌ها'},
  {id:'brow-lift',    region:'ابرو',  name:'لیفت ابرو',         help:'بالا یا پایین‌رفتن ابروها'}
];

export const zeroAmounts=()=>Object.fromEntries(controls.map(c=>[c.id,0]));

// Which landmarks each control anchors on, so the debug overlay can highlight the
// region a procedure is actually moving. roja-check.cjs re-reads the p(N) calls in
// deformers() and fails if these fall behind the code.
export const frameLandmarks=[234,454];          // the ear-to-ear pair, used by every edit
export const controlLandmarks={
  'nose-width':[1,2],
  'nose-bridge':[168,6],
  'nose-tip':[1],
  'lip-fullness':[0,17],
  'cheek-volume':[50,280],
  'cheek-hollow':[50,61,280,291],
  'jaw-width':[172,397],
  'chin-length':[152],
  'eye-open':[33,133,362,263],
  'eye-size':[33,133,362,263],
  'brow-lift':[105,107,334,336]
};

const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const unit=v=>{const l=Math.hypot(v.x,v.y)||1;return {x:v.x/l,y:v.y/l};};

const AXIS=0, RADIAL=1, SHIFT=2;

// Landmark indices here are the ones already relied on by makeup.js and muscles.js.
export function deformers(landmarks, width, height, amounts) {
  const p=i=>({x:landmarks[i].x*width, y:landmarks[i].y*height});
  const left=p(234), right=p(454);
  const ex=unit(sub(right,left));           // across the face
  const ey={x:-ex.y, y:ex.x};               // down the face
  const up={x:-ey.x, y:-ey.y};
  const face=Math.hypot(right.x-left.x, right.y-left.y)||1;
  const out=[];
  const at=id=>(amounts[id]||0)/100;

  const axis=(anchor,r,v,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:AXIS,vx:v.x,vy:v.y,a:gain});
  const radial=(anchor,r,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:RADIAL,vx:0,vy:0,a:gain});
  const shift=(anchor,r,v,gain)=>gain&&out.push({x:anchor.x,y:anchor.y,r,kind:SHIFT,vx:v.x*r,vy:v.y*r,a:gain});

  // Gains are tuned so a control at 100 is a clear but still plausible change.
  axis(mix(p(1),p(2),.5), face*.20, ex, at('nose-width')*.75);
  axis(mix(p(168),p(6),.5), face*.14, ex, at('nose-bridge')*.70);
  shift(p(1), face*.16, up, at('nose-tip')*.60);

  axis(mix(p(0),p(17),.5), face*.26, ey, at('lip-fullness')*.75);

  radial(p(50),  face*.24, at('cheek-volume')*.58);
  radial(p(280), face*.24, at('cheek-volume')*.58);
  // Buccal hollow sits lower and more forward than the cheekbone itself.
  radial(mix(p(50),p(61),.62),  face*.19, -at('cheek-hollow')*.50);
  radial(mix(p(280),p(291),.62),face*.19, -at('cheek-hollow')*.50);

  shift(p(172), face*.34, ex,                at('jaw-width')*.32);
  shift(p(397), face*.34, {x:-ex.x,y:-ex.y}, at('jaw-width')*.32);
  shift(p(152), face*.26, ey, at('chin-length')*.34);

  const leftEye=mix(p(33),p(133),.5), rightEye=mix(p(362),p(263),.5);
  radial(leftEye,  face*.15, at('eye-size')*.55);
  radial(rightEye, face*.15, at('eye-size')*.55);
  axis(leftEye,  face*.13, ey, at('eye-open')*.60);
  axis(rightEye, face*.13, ey, at('eye-open')*.60);

  shift(mix(p(105),p(107),.5), face*.20, up, at('brow-lift')*.22);
  shift(mix(p(334),p(336),.5), face*.20, up, at('brow-lift')*.22);
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
