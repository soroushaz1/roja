// A brush for touching up the makeup by hand: blend (spread the colour out softly),
// fade (take some of it away), erase (take all of it away) and restore (undo any of
// that under the brush).
//
// Strokes are stored on the face, not on the screen. Every point is pinned to the
// three landmarks around it by barycentric weights, so a stroke keeps its place on the
// skin when the head turns, the mouth opens or the camera moves closer.

import {blurInto} from './blur.js?v=22';

export const brushModes=[
  {id:'blend',  name:'پخش‌کن',   help:'رنگ را زیر براش نرم و پخش می‌کند، مثل براش ترکیب.',strength:60},
  {id:'fade',   name:'محوکن',    help:'هر بار کشیدن، کمی از رنگ را کم می‌کند.',strength:35},
  {id:'erase',  name:'پاک‌کن',   help:'رنگ را زیر براش کامل برمی‌دارد.',strength:100},
  {id:'restore',name:'بازگردانی',help:'هر اصلاحی را که زیر براش است برمی‌گرداند.',strength:100}
];

const TRACKED=468;   // the iris points move with the gaze, not the skin

function faceWidth(lm,W,H){return Math.hypot((lm[454].x-lm[234].x)*W,(lm[454].y-lm[234].y)*H)||1;}

// Pin a point to the smallest nearby landmark triangle that contains it; if none
// does (off the edge of the mesh), to the nearest three that are not in a line.
export function anchor(lm,W,H,x,y){
  const near=[];
  for(let i=0;i<TRACKED;i++){
    const dx=lm[i].x*W-x,dy=lm[i].y*H-y,d=dx*dx+dy*dy;
    if(near.length<8||d<near[near.length-1].d){
      near.push({i,d});near.sort((a,b)=>a.d-b.d);if(near.length>8)near.pop();
    }
  }
  const at=k=>({x:lm[k].x*W,y:lm[k].y*H});
  let best=null,fallback=null;
  for(let a=0;a<near.length;a++)for(let b=a+1;b<near.length;b++)for(let c=b+1;c<near.length;c++){
    const A=at(near[a].i),B=at(near[b].i),C=at(near[c].i);
    const v0x=B.x-A.x,v0y=B.y-A.y,v1x=C.x-A.x,v1y=C.y-A.y,v2x=x-A.x,v2y=y-A.y;
    const d00=v0x*v0x+v0y*v0y,d01=v0x*v1x+v0y*v1y,d11=v1x*v1x+v1y*v1y;
    const denom=d00*d11-d01*d01;
    if(Math.abs(denom)<1e-3*d00*d11)continue;          // three points in a line
    const d20=v2x*v0x+v2y*v0y,d21=v2x*v1x+v2y*v1y;
    const v=(d11*d20-d01*d21)/denom,w=(d00*d21-d01*d20)/denom,u=1-v-w;
    const candidate={i:[near[a].i,near[b].i,near[c].i],w:[u,v,w]};
    if(!fallback)fallback=candidate;
    if(u<-.02||v<-.02||w<-.02)continue;
    const size=Math.max(d00,d11,(C.x-B.x)**2+(C.y-B.y)**2);
    if(!best||size<best.size)best={...candidate,size};
  }
  const chosen=best||fallback;
  return chosen?{i:chosen.i,w:chosen.w}:null;
}
export function locate(lm,W,H,a){
  let x=0,y=0;
  for(let k=0;k<3;k++){x+=lm[a.i[k]].x*W*a.w[k];y+=lm[a.i[k]].y*H*a.w[k];}
  return {x,y};
}

export function createBrush(){
  const strokes=[];
  let current=null,version=0;
  const canvases=new Map();
  let cached=null,cachedFor=null;

  function canvasFor(kind,target,W,H){
    const key=`${kind}:${target}`;
    let c=canvases.get(key);
    if(!c){c=document.createElement('canvas');canvases.set(key,c);}
    if(c.width!==W||c.height!==H){c.width=W;c.height=H;}
    return c;
  }

  // A whole stroke is one path, so overlapping points inside it never add up: one
  // pass of «محوکن» at 35% takes away 35%, however slowly the pointer moved. It is
  // drawn sharp on a scratch canvas, then softened onto the map at the stroke's strength.
  const scratch=document.createElement('canvas');
  function drawStroke(ctx,stroke,lm,W,H,operation){
    const radius=stroke.size*faceWidth(lm,W,H);
    const pts=stroke.points.map(a=>locate(lm,W,H,a));
    if(scratch.width!==W||scratch.height!==H){scratch.width=W;scratch.height=H;}
    const pad=radius*2+4;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const q of pts){x0=Math.min(x0,q.x);y0=Math.min(y0,q.y);x1=Math.max(x1,q.x);y1=Math.max(y1,q.y);}
    x0=Math.max(0,Math.floor(x0-pad));y0=Math.max(0,Math.floor(y0-pad));
    x1=Math.min(W,Math.ceil(x1+pad));y1=Math.min(H,Math.ceil(y1+pad));
    if(x1<=x0||y1<=y0)return;
    const box={x:x0,y:y0,w:x1-x0,h:y1-y0};
    const s=scratch.getContext('2d');
    s.clearRect(box.x,box.y,box.w,box.h);
    s.fillStyle=s.strokeStyle='#fff';
    if(pts.length===1){
      s.beginPath();s.arc(pts[0].x,pts[0].y,radius*.6,0,Math.PI*2);s.fill();
    }else{
      s.lineWidth=radius*1.2;s.lineCap='round';s.lineJoin='round';
      s.beginPath();s.moveTo(pts[0].x,pts[0].y);
      for(let i=1;i<pts.length-1;i++){
        const mx=(pts[i].x+pts[i+1].x)/2,my=(pts[i].y+pts[i+1].y)/2;
        s.quadraticCurveTo(pts[i].x,pts[i].y,mx,my);
      }
      const last=pts[pts.length-1];s.lineTo(last.x,last.y);s.stroke();
    }
    ctx.save();
    ctx.globalCompositeOperation=operation;
    ctx.globalAlpha=stroke.strength;
    blurInto(ctx,scratch,box,radius*.45);
    ctx.restore();
  }

  return {
    get count(){return strokes.length;},
    get version(){return version;},
    get painting(){return !!current;},
    begin(options,lm,W,H,x,y){
      const a=anchor(lm,W,H,x,y);if(!a)return false;
      current={mode:options.mode,target:options.target,strength:options.strength,size:options.size,points:[a]};
      strokes.push(current);version++;
      return true;
    },
    extend(lm,W,H,x,y){
      if(!current)return false;
      const last=locate(lm,W,H,current.points[current.points.length-1]);
      if(Math.hypot(x-last.x,y-last.y)<current.size*faceWidth(lm,W,H)*.3)return false;
      const a=anchor(lm,W,H,x,y);if(!a)return false;
      current.points.push(a);version++;
      return true;
    },
    end(){current=null;},
    undo(){if(strokes.length){strokes.pop();current=null;version++;}},
    clear(){strokes.length=0;current=null;version++;},
    targets(){return new Set(strokes.map(s=>s.target));},
    // The coverage maps for the current landmarks, or null with nothing painted.
    maps(lm,W,H){
      if(!strokes.length||!lm)return null;
      const key=`${version}|${W}|${H}`;
      if(cached&&cachedFor===lm&&cached.key===key)return cached.maps;
      const maps={blend:new Map(),erase:new Map()};
      const used=new Set();
      for(const stroke of strokes){
        if(stroke.mode==='restore'){
          for(const key of used){const [kind,target]=key.split(':');
            drawStroke(canvasFor(kind,target,W,H).getContext('2d'),stroke,lm,W,H,'destination-out');}
          continue;
        }
        const kind=stroke.mode==='blend'?'blend':'erase';
        const key=`${kind}:${stroke.target}`;
        const canvas=canvasFor(kind,stroke.target,W,H);
        if(!used.has(key)){canvas.getContext('2d').clearRect(0,0,W,H);used.add(key);maps[kind].set(stroke.target,canvas);}
        drawStroke(canvas.getContext('2d'),stroke,lm,W,H,'source-over');
      }
      cached={key,maps};cachedFor=lm;
      return maps;
    },
    // Stroke outlines on screen, for the debug overlay.
    outlines(lm,W,H){
      return strokes.map(s=>({mode:s.mode,radius:s.size*faceWidth(lm,W,H),points:s.points.map(a=>locate(lm,W,H,a))}));
    }
  };
}
