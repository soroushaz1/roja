import {products} from './catalog.js?v=7';
export {products};

// MediaPipe's lip and eye contours. Eye interiors are never filled.
const lipOuter=[61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];
const lipInner=[78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
const faceOval=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const eyes=[
  {upper:[33,246,161,160,159,158,157,173,133],lower:[133,155,154,153,145,144,163,7,33],brow:[46,53,52,65,55]},
  {upper:[263,466,388,387,386,385,384,398,362],lower:[362,382,381,380,374,373,390,249,263],brow:[276,283,282,295,285]}
];
// Every landmark this module reads, for the debug overlay to pick out. The loose
// numbers are the blush anchors and the ear-to-ear pair used for face width;
// roja-check.cjs re-reads this file and fails if any of them drifts out of step.
// Which landmarks each product type actually drives, so the debug overlay can pick
// out the ones in play right now. Blush is placed from the eye, mouth corner and side
// of the face, with the nose and outer eye corners setting its size and angle.
const blushAnchors=[145,374,61,291,234,454,1,33,263];
export const frameLandmarks=[234,454];
export const landmarksByType={
  lipstick:[...lipOuter,...lipInner],
  blush:[...blushAnchors],
  eyeshadow:[...eyes.flatMap(e=>[...e.upper,...e.brow])]
};

const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function polygon(ctx,points){
  // Quadratic mid-point contours avoid visible straight mesh segments.
  const mid=mix(points[points.length-1],points[0],.5);ctx.moveTo(mid.x,mid.y);
  points.forEach((p,i)=>{const next=mix(p,points[(i+1)%points.length],.5);ctx.quadraticCurveTo(p.x,p.y,next.x,next.y);});ctx.closePath();
}
function rgba(hex,alpha){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${(n>>8)&255},${n&255},${alpha})`;}

function renderLayer(ctx,landmarks,states,before=false){
  const {width,height}=ctx.canvas;
  ctx.clearRect(0,0,width,height);
  if(before||!landmarks||landmarks.length<468)return;
  const p=i=>({x:landmarks[i].x*width,y:landmarks[i].y*height});
  const layers=Object.fromEntries(['lipstick','blush','eyeshadow'].map(type=>{const item=products.find(p=>p.type===type && states[p.id]?.enabled);return [type,item ? {...states[item.id],color:item.shades.find(s=>s.id===states[item.id].shade).color} : {enabled:false}];}));
  ctx.save();
  ctx.beginPath();polygon(ctx,faceOval.map(p));ctx.clip();

  if(layers.blush.enabled){
    const color=layers.blush.color,alpha=layers.blush.intensity/100;
    // Cheek placement follows the lower eye, mouth corner and side of the face.
    for(const side of [{eye:145,mouth:61,edge:234},{eye:374,mouth:291,edge:454}]){
      const eye=p(side.eye),mouth=p(side.mouth),edge=p(side.edge);
      const center=mix(mix(eye,mouth,.57),edge,.24);
      const eyeLineA=p(33),eyeLineB=p(263);
      const rx=Math.max(1,distance(p(1),edge)*.39),ry=Math.max(1,distance(eye,mouth)*.40);
      ctx.save();ctx.translate(center.x,center.y);ctx.rotate(Math.atan2(eyeLineB.y-eyeLineA.y,eyeLineB.x-eyeLineA.x));ctx.scale(rx,ry);
      const gradient=ctx.createRadialGradient(0,0,0,0,0,1);
      gradient.addColorStop(0,rgba(color,alpha*.70));gradient.addColorStop(.4,rgba(color,alpha*.46));gradient.addColorStop(1,rgba(color,0));
      ctx.fillStyle=gradient;ctx.fillRect(-1,-1,2,2);ctx.restore();
    }
  }

  if(layers.eyeshadow.enabled){
    const color=layers.eyeshadow.color,alpha=layers.eyeshadow.intensity/100;
    for(const eye of eyes){
      const lash=eye.upper.map(p);
      const brow=eye.brow.map(p);
      const cap=lash.map((point,i)=>{
        const t=i/(lash.length-1),b=t*(brow.length-1),j=Math.min(brow.length-2,Math.floor(b));
        const target=mix(brow[j],brow[j+1],b-j);
        return mix(point,target,.65*Math.sin(Math.PI*t));
      });
      ctx.save();ctx.beginPath();polygon(ctx,[...lash,...cap.slice().reverse()]);ctx.clip();
      const center=lash[4],top=cap[4];
      const gradient=ctx.createLinearGradient(center.x,center.y,top.x,top.y);
      gradient.addColorStop(0,rgba(color,alpha*.85));gradient.addColorStop(.55,rgba(color,alpha*.55));gradient.addColorStop(1,rgba(color,0));
      ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);ctx.restore();
    }
  }

  if(layers.lipstick.enabled){ctx.save();ctx.beginPath();polygon(ctx,lipOuter.map(p));polygon(ctx,lipInner.map(p));ctx.fillStyle=layers.lipstick.color;ctx.globalAlpha=layers.lipstick.intensity/100;ctx.fill('evenodd');ctx.restore();}
  // Exclude the eye openings even when the face rotates or the cheeks lift.
  ctx.globalCompositeOperation='destination-out';
  ctx.beginPath();for(const eye of eyes)polygon(ctx,[...eye.upper,...eye.lower].map(p));ctx.fill();
  ctx.restore();
}

// Reuse two buffers. Shadow blur works on Safari as well as Chromium, without
// depending on CanvasRenderingContext2D.filter or reading camera pixels.
let layerCanvas,softCanvas;
export function renderMakeup(ctx,landmarks,states,before=false){
  const {width,height}=ctx.canvas;ctx.clearRect(0,0,width,height);
  if(before||!landmarks||landmarks.length<468)return;
  if(!layerCanvas){layerCanvas=document.createElement('canvas');softCanvas=document.createElement('canvas');}
  for(const c of [layerCanvas,softCanvas])if(c.width!==width||c.height!==height){c.width=width;c.height=height;}
  const layer=layerCanvas.getContext('2d'),soft=softCanvas.getContext('2d');
  const faceWidth=distance(landmarks[234],landmarks[454])*width;
  for(const item of products){
    const state=states[item.id];if(!state?.enabled)continue;
    const isolated=Object.fromEntries(products.map(p=>[p.id,{...states[p.id],enabled:p.id===item.id}]));
    renderLayer(layer,landmarks,isolated);
    const fade=Math.max(0,Math.min(100,state.fade??45))/100;
    const radius=faceWidth*({lipstick:.024,blush:.07,eyeshadow:.035}[item.type])*fade;
    if(radius<.1){ctx.drawImage(layerCanvas,0,0);continue;}
    soft.clearRect(0,0,width,height);soft.save();
    soft.shadowColor=selectedColor(item,state);soft.shadowBlur=radius*2;
    soft.shadowOffsetX=width*2;soft.drawImage(layerCanvas,-width*2,0);soft.restore();
    ctx.drawImage(softCanvas,0,0);
  }
  const p=i=>({x:landmarks[i].x*width,y:landmarks[i].y*height});
  ctx.save();ctx.globalCompositeOperation='destination-in';ctx.beginPath();polygon(ctx,faceOval.map(p));ctx.fill();
  ctx.globalCompositeOperation='destination-out';ctx.beginPath();
  polygon(ctx,lipInner.map(p));for(const eye of eyes)polygon(ctx,[...eye.upper,...eye.lower].map(p));ctx.fill();ctx.restore();
}
function selectedColor(item,state){return item.shades.find(s=>s.id===state.shade)?.color||'#000';}

export function smoothLandmarks(previous,next){
  if(!next)return null;
  if(!previous||previous.length!==next.length)return next;
  const movement=distance(previous[1],next[1]);
  if(movement>.10)return next; // Do not drag a stale mask onto a reacquired face.
  const amount=Math.min(.88,.48+movement*12);
  return next.map((p,i)=>({...p,x:previous[i].x+(p.x-previous[i].x)*amount,y:previous[i].y+(p.y-previous[i].y)*amount}));
}

