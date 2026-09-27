// A brush for touching up the makeup by hand: blend (spread the colour out softly),
// fade (take some of it away), erase (take all of it away) and restore (undo any of
// that under the brush).
//
// Strokes are stored on the face, not on the screen. Every point is pinned to the
// three landmarks around it by barycentric weights, so a stroke keeps its place on the
// skin when the head turns, the mouth opens or the camera moves closer.

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
  // pass of «محوکن» at 35% takes away 35%, however slowly the pointer moved.
  function drawStroke(ctx,stroke,lm,W,H,operation){
    const radius=stroke.size*faceWidth(lm,W,H);
    const pts=stroke.points.map(a=>locate(lm,W,H,a));
    ctx.save();
    ctx.globalCompositeOperation=operation;
    ctx.shadowColor=`rgba(255,255,255,${stroke.strength})`;
    ctx.shadowBlur=radius*.9;ctx.shadowOffsetX=W*2;
    ctx.translate(-W*2,0);
    ctx.fillStyle=ctx.strokeStyle='#fff';
    if(pts.length===1){
      ctx.beginPath();ctx.arc(pts[0].x,pts[0].y,radius*.6,0,Math.PI*2);ctx.fill();
    }else{
      ctx.lineWidth=radius*1.2;ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
      for(let i=1;i<pts.length-1;i++){
        const mx=(pts[i].x+pts[i+1].x)/2,my=(pts[i].y+pts[i+1].y)/2;
        ctx.quadraticCurveTo(pts[i].x,pts[i].y,mx,my);
      }
      const last=pts[pts.length-1];ctx.lineTo(last.x,last.y);ctx.stroke();
    }
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
