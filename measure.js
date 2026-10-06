// Measurements of the face, before and after the procedures on screen.
//
// Lengths are given as a share of face width (ear to ear, landmarks 234–454), so
// they do not change with the distance to the camera. The "after" value moves every
// landmark through the same displacement field the stage draws with, so the numbers
// describe exactly the change you see. They describe the picture, not the anatomy:
// a frontal photo cannot measure depth, and a turned head skews every one of them.
import {displace} from './deform.js?v=21';

export const metrics=[
  {id:'nose-width', name:'پهنای پرهٔ بینی', span:[64,294]},
  {id:'nose-eyes',  name:'پهنای بینی / فاصلهٔ دو چشم', ratio:[[64,294],[133,362]]},
  {id:'mouth',      name:'پهنای دهان', span:[61,291]},
  {id:'lip-upper',  name:'ضخامت لب بالا', span:[0,13]},
  {id:'lip-lower',  name:'ضخامت لب پایین', span:[14,17]},
  {id:'lip-ratio',  name:'لب پایین / لب بالا', ratio:[[14,17],[0,13]]},
  {id:'philtrum',   name:'فاصلهٔ بینی تا لب', span:[2,0]},
  {id:'eye-open',   name:'بازشدگی چشم', spans:[[159,145],[386,374]]},
  {id:'eye-width',  name:'پهنای چشم', spans:[[33,133],[263,362]]},
  {id:'canthal',    name:'زاویهٔ گوشهٔ چشم', tilt:true},
  {id:'brow',       name:'فاصلهٔ ابرو تا پلک', spans:[[105,159],[334,386]]},
  {id:'cheeks',     name:'پهنای گونه‌ها', span:[50,280]},
  {id:'jaw',        name:'پهنای فک', span:[172,397]},
  {id:'chin-width', name:'پهنای چانه', span:[148,377]},
  {id:'chin',       name:'بلندی چانه', span:[17,152]},
  {id:'thirds',     name:'یک‌سوم پایین / میانی صورت', ratio:[[2,152],[168,2]]}
];
// Every landmark read here, for the debug overlay.
export const measuredLandmarks=[...new Set(metrics.flatMap(m=>[
  ...(m.span||[]),...(m.spans||[]).flat(),...(m.ratio||[]).flat(),...(m.tilt?[33,133,263,362]:[])]))];

const PAIRS=[[33,263],[133,362],[61,291],[105,334],[172,397],[50,280],[70,300]];

// Landmark positions in pixels, optionally carried through a displacement field.
export function points(landmarks,W,H,defs){
  const out=new Array(landmarks.length),o={x:0,y:0};
  for(let i=0;i<landmarks.length;i++){
    let x=landmarks[i].x*W,y=landmarks[i].y*H;
    if(defs&&defs.length){displace(defs,x,y,o);x+=o.x;y+=o.y;}
    out[i]={x,y};
  }
  return out;
}

export function measure(pts){
  const d=(a,b)=>Math.hypot(pts[a].x-pts[b].x,pts[a].y-pts[b].y);
  const face=d(234,454)||1;
  const ex={x:(pts[454].x-pts[234].x)/face,y:(pts[454].y-pts[234].y)/face};
  const out={};
  for(const m of metrics){
    if(m.span)out[m.id]={value:d(...m.span)/face*100,unit:'%'};
    else if(m.spans)out[m.id]={value:m.spans.reduce((s,pair)=>s+d(...pair),0)/m.spans.length/face*100,unit:'%'};
    else if(m.ratio)out[m.id]={value:d(...m.ratio[0])/(d(...m.ratio[1])||1),unit:'×'};
    else if(m.tilt){
      // Outer corner above inner corner reads positive, on both sides.
      const up={x:ex.y,y:-ex.x};
      const tilt=(outer,inner)=>{
        const vx=pts[outer].x-pts[inner].x,vy=pts[outer].y-pts[inner].y;
        return Math.atan2(vx*up.x+vy*up.y,Math.abs(vx*ex.x+vy*ex.y))*180/Math.PI;
      };
      out[m.id]={value:(tilt(33,133)+tilt(263,362))/2,unit:'°'};
    }
  }
  return out;
}

// Left–right balance: each paired point reflected across the face's midline, the
// mean miss as a share of face width, turned into a 0–100 score.
export function symmetry(pts){
  const top=pts[168],bottom=pts[152];
  const ax=bottom.x-top.x,ay=bottom.y-top.y,len=Math.hypot(ax,ay)||1,ux=ax/len,uy=ay/len;
  const face=Math.hypot(pts[454].x-pts[234].x,pts[454].y-pts[234].y)||1;
  let miss=0;
  for(const [a,b] of PAIRS){
    const px=pts[a].x-top.x,py=pts[a].y-top.y,along=px*ux+py*uy;
    const rx=ux*along*2-px,ry=uy*along*2-py;                  // a, reflected
    miss+=Math.hypot(rx-(pts[b].x-top.x),ry-(pts[b].y-top.y))/face;
  }
  return Math.max(0,Math.min(100,100-miss/PAIRS.length*400));
}

// Yaw, pitch and roll in degrees from MediaPipe's facial transformation matrix.
export function pose(data){
  if(!data||data.length<16)return null;
  // The packed data is column-major; detect it by where the translation sits.
  const colMajor=Math.abs(data[12])+Math.abs(data[13])+Math.abs(data[14])>=Math.abs(data[3])+Math.abs(data[7])+Math.abs(data[11]);
  const r=(row,col)=>colMajor?data[col*4+row]:data[row*4+col];
  const deg=180/Math.PI;
  return {
    yaw:Math.asin(Math.max(-1,Math.min(1,-r(2,0))))*deg,
    pitch:Math.atan2(r(2,1),r(2,2))*deg,
    roll:Math.atan2(r(1,0),r(0,0))*deg
  };
}
