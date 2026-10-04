// Where each product goes on the face, drawn as a soft white mask from the landmarks.
//
// The WebGL stage (stage.js) uploads each mask and decides how the colour meets the
// skin. Without WebGL, renderFallback() paints the same masks in flat colour on the 2D
// overlay, so makeup still works on a device that cannot run the stage.
import {products,layerOrder} from './catalog.js?v=18';
import {blurInto} from './blur.js?v=18';
export {products};

// MediaPipe's contours. Eye openings and the mouth opening are never painted.
const lipOuter=[61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];
const lipInner=[78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
const faceOval=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
// Per eye, listed outer corner first: the upper and lower lid, the lower and upper
// edge of the brow, and the side of the face the eye is on.
const eyes=[
  {upper:[33,246,161,160,159,158,157,173,133],lower:[133,155,154,153,145,144,163,7,33],
   brow:[46,53,52,65,55],browTop:[70,63,105,66,107]},
  {upper:[263,466,388,387,386,385,384,398,362],lower:[362,382,381,380,374,373,390,249,263],
   brow:[276,283,282,295,285],browTop:[300,293,334,296,336]}
];
// Loose anchors, per side: blush (lower lid, mouth corner, face edge), highlighter
// (cheekbone), contour (cheek hollow, side of the nose).
const blushAnchors=[145,374,61,291,234,454,1,33,263];
const highlightAnchors=[116,117,118,123,345,346,347,352,6,195,0];
const contourAnchors=[132,361,61,291,122,126,351,355];
const foreheadAnchors=[54,103,67,109,10,338,297,332,284,9];

// Which landmarks each layer reads, so the debug overlay can pick out the ones in
// play. roja-check.cjs re-reads every p(N) in this file and fails if one is missing.
export const frameLandmarks=[234,454];
export const eyeContours=eyes;          // so a test can collapse one lid and check the result
const eyeUpper=eyes.flatMap(e=>e.upper), eyeLower=eyes.flatMap(e=>e.lower);
const browAll=eyes.flatMap(e=>[...e.brow,...e.browTop]);
export const landmarksByType={
  foundation:[...faceOval,...eyeUpper,...eyeLower,...browAll,...lipOuter],
  concealer:[...eyeLower],
  contour:[...contourAnchors],
  blush:[...blushAnchors],
  highlighter:[...highlightAnchors],
  eyeshadow:[...eyeUpper,...eyes.flatMap(e=>e.brow)],
  eyeliner:[...eyeUpper,...eyeLower],
  mascara:[...eyeUpper,...eyeLower],
  brow:[...browAll],
  lipliner:[...lipOuter],
  lipstick:[...lipOuter,...lipInner],
  gloss:[...lipOuter,...lipInner],
  texture:[...faceOval,...foreheadAnchors,...eyeUpper,...eyeLower]
};

/* ---- geometry helpers --------------------------------------------------- */
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const add=(a,v,k=1)=>({x:a.x+v.x*k,y:a.y+v.y*k});
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const unit=v=>{const l=Math.hypot(v.x,v.y)||1;return {x:v.x/l,y:v.y/l};};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const scaleAbout=(pts,c,k)=>pts.map(q=>mix(c,q,k));
const centroid=pts=>pts.reduce((s,q)=>({x:s.x+q.x/pts.length,y:s.y+q.y/pts.length}),{x:0,y:0});

// Quadratic mid-point contours avoid visible straight mesh segments.
function polygon(ctx,points){
  const mid=mix(points[points.length-1],points[0],.5);ctx.moveTo(mid.x,mid.y);
  points.forEach((q,i)=>{const next=mix(q,points[(i+1)%points.length],.5);ctx.quadraticCurveTo(q.x,q.y,next.x,next.y);});
  ctx.closePath();
}
function curve(ctx,points){
  ctx.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length-1;i++){const next=mix(points[i],points[i+1],.5);ctx.quadraticCurveTo(points[i].x,points[i].y,next.x,next.y);}
  const last=points[points.length-1];ctx.lineTo(last.x,last.y);
}
export function hexToRgb(hex){const n=parseInt(hex.slice(1),16);return [(n>>16)/255,((n>>8)&255)/255,(n&255)/255];}
function rgba(hex,alpha){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${(n>>8)&255},${n&255},${alpha})`;}
const white=a=>`rgba(255,255,255,${Math.max(0,Math.min(1,a))})`;

// The face-local frame every size is measured in, so a mask keeps its proportions
// whatever the distance to the camera and the tilt of the head.
// How open one eye is, 0 shut to 1 wide. The lower lid is listed in the opposite
// direction to the upper, so `upper[i]` pairs with `lower[n-1-i]`; two chords across
// the opening, over the corner-to-corner width, is the usual eye-aspect ratio. The
// thresholds are wide enough to cover different eye shapes without flickering.
export function eyeOpenness(eye,p){
  const u=eye.upper.map(p),l=eye.lower.map(p),n=eye.upper.length;
  const span=distance(u[0],u[n-1])||1;
  const ratio=(distance(u[3],l[n-4])+distance(u[5],l[n-6]))/(2*span);
  return Math.max(0,Math.min(1,(ratio-.07)/.13));
}
function faceFrame(p){
  const left=p(234),right=p(454);
  const ex=unit(sub(right,left)),ey={x:-ex.y,y:ex.x};
  // Per eye, in the same order as `eyes`. Eye makeup fades with the lid it sits on,
  // because a closed lid folds the landmarks into a line and anything drawn along
  // them turns into a smear.
  return {face:distance(left,right)||1,ex,ey,up:{x:-ey.x,y:-ey.y},
    open:eyes.map(e=>eyeOpenness(e,p))};
}

// The line a fraction k of the way from the lash line to the lower edge of the brow,
// bowed so it meets the lash line again at both corners.
function lidLine(lash,brow,k,power=1){
  return lash.map((q,i)=>{
    const t=i/(lash.length-1),b=t*(brow.length-1),j=Math.min(brow.length-2,Math.floor(b));
    return mix(q,mix(brow[j],brow[j+1],b-j),k*Math.pow(Math.sin(Math.PI*t),power));
  });
}
// Per lash point, the direction away from the eye.
function lidNormals(lash,up){
  return lash.map((q,i)=>{
    const a=lash[Math.max(0,i-1)],b=lash[Math.min(lash.length-1,i+1)];
    let n=unit({x:-(b.y-a.y),y:b.x-a.x});
    if(n.x*up.x+n.y*up.y<0)n={x:-n.x,y:-n.y};
    return unit(add(n,up,.6));
  });
}
function ellipse(ctx,center,rx,ry,angle,stops){
  ctx.save();ctx.translate(center.x,center.y);ctx.rotate(angle);ctx.scale(rx,ry);
  const g=ctx.createRadialGradient(0,0,0,0,0,1);
  for(const [at,alpha] of stops)g.addColorStop(at,white(alpha));
  ctx.fillStyle=g;ctx.fillRect(-1,-1,2,2);ctx.restore();
}

/* ---- the shape of each layer --------------------------------------------
   Each draws in white on a clear canvas and returns the points that bound it, so
   the blur that feathers it only has to touch that part of the frame. */
const shapes={
  lipstick(ctx,p){
    const outer=lipOuter.map(p);
    ctx.fillStyle='#fff';ctx.beginPath();polygon(ctx,outer);polygon(ctx,lipInner.map(p));ctx.fill('evenodd');
    return outer;
  },
  gloss(ctx,p){return shapes.lipstick(ctx,p);},
  lipliner(ctx,p,f){
    const outer=lipOuter.map(p);
    ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,f.face*.013);ctx.lineJoin='round';
    ctx.beginPath();polygon(ctx,outer);ctx.stroke();
    return outer;
  },
  foundation(ctx,p,f){
    const oval=faceOval.map(p),c=centroid(oval);
    // Pull the outline in, most of all at the top, where the hairline or a fringe
    // usually sits inside the model's oval.
    const inner=oval.map(q=>{const d=unit(sub(q,c)),lift=Math.max(0,d.x*f.up.x+d.y*f.up.y);return mix(c,q,.965-.085*lift);});
    ctx.fillStyle='#fff';ctx.beginPath();polygon(ctx,inner);ctx.fill();
    ctx.globalCompositeOperation='destination-out';ctx.beginPath();
    for(const eye of eyes){
      const lid=[...eye.upper,...eye.lower].map(p);polygon(ctx,scaleAbout(lid,centroid(lid),1.3));
      const brow=[...eye.browTop,...eye.brow.slice().reverse()].map(p);polygon(ctx,scaleAbout(brow,centroid(brow),1.12));
    }
    const lips=lipOuter.map(p);polygon(ctx,scaleAbout(lips,centroid(lips),1.06));
    ctx.fill();ctx.globalCompositeOperation='source-over';
    return oval;
  },
  concealer(ctx,p,f){
    const pts=[];
    ctx.fillStyle='#fff';ctx.beginPath();
    for(const eye of eyes){
      const lower=eye.lower.map(p);                     // inner corner first
      const width=distance(lower[0],lower[lower.length-1]);
      const top=lower.map(q=>add(q,f.ey,width*.07));
      const bottom=lower.map((q,i)=>{const t=i/(lower.length-1);
        return add(q,f.ey,width*(.14+.62*Math.pow(Math.sin(Math.PI*(.15+.7*t)),.8)));});
      const shape=[...top,...bottom.reverse()];polygon(ctx,shape);pts.push(...shape);
    }
    ctx.fill();return pts;
  },
  contour(ctx,p,f){
    const pts=[];
    for(const side of [{ear:132,mouth:61,top:122,bottom:126},{ear:361,mouth:291,top:351,bottom:355}]){
      const ear=p(side.ear),mouth=p(side.mouth);
      const len=distance(ear,mouth),angle=Math.atan2(mouth.y-ear.y,mouth.x-ear.x);
      const center=mix(ear,mouth,.3);
      ellipse(ctx,center,len*.36,f.face*.055,angle,[[0,.95],[.55,.7],[1,0]]);
      pts.push(add(center,f.ex,-len*.4),add(center,f.ex,len*.4),add(center,f.ey,f.face*.08),add(center,f.up,f.face*.08));
      // A thinner line down each side of the nose.
      const a=p(side.top),b=p(side.bottom);
      ctx.save();ctx.strokeStyle=white(.55);ctx.lineCap='round';ctx.lineWidth=f.face*.03;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.restore();
      pts.push(a,b);
    }
    return pts;
  },
  blush(ctx,p,f){
    const pts=[];
    const tilt=Math.atan2(p(263).y-p(33).y,p(263).x-p(33).x);
    for(const side of [{eye:145,mouth:61,edge:234},{eye:374,mouth:291,edge:454}]){
      const eye=p(side.eye),mouth=p(side.mouth),edge=p(side.edge);
      const center=mix(mix(eye,mouth,.57),edge,.24);
      const rx=Math.max(1,distance(p(1),edge)*.39),ry=Math.max(1,distance(eye,mouth)*.40);
      ellipse(ctx,center,rx,ry,tilt,[[0,1],[.4,.66],[1,0]]);
      pts.push({x:center.x-rx,y:center.y-rx},{x:center.x+rx,y:center.y+rx});
    }
    return pts;
  },
  highlighter(ctx,p,f){
    const pts=[];
    for(const side of [{under:118,edge:116,bone:117,low:123},{under:347,edge:345,bone:346,low:352}]){
      const center=mix(p(side.bone),p(side.low),.42);
      const dir=sub(p(side.edge),p(side.under));
      ellipse(ctx,center,f.face*.11,f.face*.035,Math.atan2(dir.y,dir.x),[[0,1],[.5,.7],[1,0]]);
      pts.push({x:center.x-f.face*.12,y:center.y-f.face*.12},{x:center.x+f.face*.12,y:center.y+f.face*.12});
    }
    const a=p(6),b=p(195);
    ctx.save();ctx.strokeStyle=white(.7);ctx.lineCap='round';ctx.lineWidth=f.face*.02;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.restore();
    const bow=add(p(0),f.up,f.face*.018);
    ellipse(ctx,bow,f.face*.035,f.face*.012,Math.atan2(f.ex.y,f.ex.x),[[0,.6],[1,0]]);
    pts.push(a,b,add(bow,f.up,f.face*.03),add(bow,f.ey,f.face*.03));
    return pts;
  },
  eyeshadow(ctx,p,f,spec){
    const zone=spec.zone||'single';
    const pts=[];
    for(let side=0;side<eyes.length;side++){
      const eye=eyes[side],open=f.open[side];
      if(open<=.02)continue;
      ctx.save();ctx.globalAlpha*=open;
      const lash=eye.upper.map(p),brow=eye.brow.map(p);
      const outer=lash[0],inner=lash[lash.length-1],width=distance(outer,inner);
      // Fractions of the way from the lash line to the brow. These used to sit far too
      // high — a wash reaching .68 puts colour most of the way to the brow, which is why
      // the placement read as wrong. The lid stops below the socket, the crease sits on it.
      const reach={single:.55,lid:.45,crease:.70,outer:.62,highlight:.90}[zone];
      const cap=lidLine(lash,brow,reach);
      ctx.save();ctx.beginPath();polygon(ctx,[...lash,...cap.slice().reverse()]);ctx.clip();
      const mid=lash[4],top=cap[4];
      if(zone==='single'||zone==='lid'){
        const g=ctx.createLinearGradient(mid.x,mid.y,top.x,top.y);
        g.addColorStop(0,white(zone==='lid'?.85:.7));g.addColorStop(.55,white(zone==='lid'?.55:.38));g.addColorStop(1,white(0));
        ctx.fillStyle=g;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
      }else if(zone==='crease'){
        const g=ctx.createLinearGradient(mid.x,mid.y,top.x,top.y);
        g.addColorStop(0,white(0));g.addColorStop(.45,white(.62));g.addColorStop(.75,white(.4));g.addColorStop(1,white(0));
        ctx.fillStyle=g;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
        // Deepest towards the outer corner.
        ctx.globalCompositeOperation='destination-in';
        const h=ctx.createLinearGradient(outer.x,outer.y,inner.x,inner.y);
        h.addColorStop(0,white(1));h.addColorStop(1,white(.3));
        ctx.fillStyle=h;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
      }else if(zone==='outer'){
        const c=mix(outer,cap[2],.35);
        const g=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,width*.62);
        g.addColorStop(0,white(1));g.addColorStop(.5,white(.75));g.addColorStop(1,white(0));
        ctx.fillStyle=g;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
      }else if(zone==='highlight'){
        // Under the brow, and a touch at the inner corner.
        const band=lidLine(lash,brow,.74);
        ctx.beginPath();polygon(ctx,[...band,...cap.slice().reverse()]);
        ctx.fillStyle=white(.42);ctx.fill();
        const g=ctx.createRadialGradient(inner.x,inner.y,0,inner.x,inner.y,width*.24);
        g.addColorStop(0,white(1));g.addColorStop(1,white(0));
        ctx.fillStyle=g;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
      }
      ctx.restore();
      if(zone==='highlight'){
        const g=ctx.createRadialGradient(inner.x,inner.y,0,inner.x,inner.y,width*.2);
        g.addColorStop(0,white(.9));g.addColorStop(1,white(0));
        ctx.fillStyle=g;ctx.beginPath();ctx.arc(inner.x,inner.y,width*.2,0,Math.PI*2);ctx.fill();
      }
      pts.push(...lash,...cap);
      ctx.restore();
    }
    return pts;
  },
  eyeliner(ctx,p,f,spec){
    const style=spec.style||'classic';
    const pts=[];
    ctx.fillStyle='#fff';
    for(let side=0;side<eyes.length;side++){
      const eye=eyes[side],open=f.open[side];
      // A shut lid collapses the lash line onto the lower one; anything drawn between
      // them smears across the eye. People close one eye to draw liner, so this is the
      // common case, not an edge case.
      if(open<=.02)continue;
      ctx.save();ctx.globalAlpha*=open;
      const lash=eye.upper.map(p),normal=lidNormals(lash,f.up);
      const outer=lash[0],inner=lash[lash.length-1],width=distance(outer,inner);
      const thick={thin:[.022,.022],classic:[.035,.055],wing:[.035,.06],smudge:[.06,.05]}[style];
      const edge=lash.map((q,i)=>{const t=i/(lash.length-1);return add(q,normal[i],width*(thick[0]+thick[1]*(1-t)));});
      ctx.beginPath();polygon(ctx,[...lash,...edge.slice().reverse()]);ctx.fill();
      if(style==='wing'){
        const out=unit(add(unit(sub(outer,inner)),f.up,.5));
        const tip=add(outer,out,width*.34);
        ctx.beginPath();ctx.moveTo(lash[1].x,lash[1].y);ctx.lineTo(tip.x,tip.y);ctx.lineTo(edge[2].x,edge[2].y);ctx.closePath();ctx.fill();
        pts.push(tip);
      }
      if(style==='smudge'){
        const lower=eye.lower.map(p);
        const under=lower.map(q=>add(q,f.ey,width*.05));
        ctx.save();ctx.globalAlpha=.7;ctx.beginPath();polygon(ctx,[...lower,...under.slice().reverse()]);ctx.fill();ctx.restore();
        pts.push(...under);
      }
      pts.push(...lash,...edge);
      ctx.restore();
    }
    return pts;
  },
  mascara(ctx,p,f,spec){
    const volume=spec.style==='volume';
    const pts=[];
    ctx.strokeStyle='#fff';ctx.lineCap='round';
    // A fixed scatter, so the lashes do not shimmer from frame to frame.
    const jitter=k=>{const v=Math.sin(k*12.9898)*43758.5453;return v-Math.floor(v)-.5;};
    for(let side=0;side<eyes.length;side++){
      const eye=eyes[side],open=f.open[side];
      if(open<=.02)continue;
      ctx.save();ctx.globalAlpha*=open;
      const lash=eye.upper.map(p),normal=lidNormals(lash,f.up);
      const outer=lash[0],inner=lash[lash.length-1],width=distance(outer,inner);
      const outward=unit(sub(outer,inner));
      // Mostly, mascara darkens and thickens the lash line; individual lashes are
      // short, curled and irregular, longest at the outer corner.
      ctx.lineWidth=width*(volume?.038:.024);ctx.beginPath();curve(ctx,lash);ctx.stroke();
      // Every lash goes into one path. They share a width and an alpha, and it was the
      // forty-odd separate stroke() calls per frame that made mascara lag.
      ctx.save();ctx.globalAlpha*=.85;
      ctx.lineWidth=Math.max(.6,width*(volume?.014:.009));
      const count=volume?24:17;
      ctx.beginPath();
      for(let k=0;k<count;k++){
        const s=.06+.9*k/(count-1)+jitter(k)*.02,at=Math.max(0,Math.min(1,s))*(lash.length-1),j=Math.min(lash.length-2,Math.floor(at));
        const root=mix(lash[j],lash[j+1],at-j),n=unit(mix(normal[j],normal[j+1],at-j));
        const dir=unit(add(add(n,outward,.7*(1-s)),outward,jitter(k+7)*.25));
        const length=width*(.085+.075*Math.pow(1-s,.7))*(volume?1:1.3)*(1+jitter(k+3)*.3);
        const tip=add(add(root,dir,length),f.up,length*.25),bend=add(root,dir,length*.6);
        ctx.moveTo(root.x,root.y);ctx.quadraticCurveTo(bend.x,bend.y,tip.x,tip.y);
        pts.push(tip);
      }
      ctx.stroke();ctx.restore();
      // A few short lower lashes, again as one path.
      const lower=eye.lower.map(p);
      ctx.save();ctx.globalAlpha*=.4;ctx.lineWidth=Math.max(.5,width*.007);
      ctx.beginPath();
      for(let k=3;k<lower.length-1;k+=1){
        const q=lower[k],tip=add(add(q,f.ey,width*.045),outward,width*.02);
        ctx.moveTo(q.x,q.y);ctx.lineTo(tip.x,tip.y);pts.push(tip);
      }
      ctx.stroke();ctx.restore();
      pts.push(...lash);
      ctx.restore();
    }
    return pts;
  },
  brow(ctx,p,f){
    const pts=[];
    ctx.fillStyle='#fff';ctx.strokeStyle='#fff';ctx.lineWidth=f.face*.008;ctx.lineJoin='round';
    for(const eye of eyes){
      const shape=[...eye.browTop,...eye.brow.slice().reverse()].map(p);
      ctx.beginPath();polygon(ctx,shape);ctx.fill();ctx.stroke();
      pts.push(...shape);
    }
    return pts;
  },
  // Skin-texture areas for the non-surgical procedures.
  texture(ctx,p,f,spec){
    if(spec.zone==='skin')return shapes.foundation(ctx,p,f);
    ctx.fillStyle='#fff';
    if(spec.zone==='forehead'){
      // Across the top from one temple to the other, then back along the brows.
      const top=foreheadAnchors.slice(0,9).map(p);
      const brows=[...eyes[1].browTop.map(p),p(9),...eyes[0].browTop.slice().reverse().map(p)];
      const c=centroid(top);
      const shape=[...scaleAbout(top,c,.92),...brows.map(q=>add(q,f.up,f.face*.02))];
      ctx.beginPath();polygon(ctx,shape);ctx.fill();
      return shape;
    }
    if(spec.zone==='eyes'){
      const pts=[];
      for(const eye of eyes){
        const outer=p(eye.upper[0]),inner=p(eye.upper[eye.upper.length-1]),width=distance(outer,inner);
        const away=unit(sub(outer,inner));
        const c=add(outer,away,width*.3);
        ellipse(ctx,c,width*.32,width*.42,Math.atan2(f.ex.y,f.ex.x),[[0,1],[.6,.75],[1,0]]);
        pts.push(add(c,f.ex,-width*.5),add(c,f.ex,width*.5),add(c,f.ey,width*.5),add(c,f.up,width*.5));
      }
      return [...pts,...shapes.concealer(ctx,p,f)];
    }
    if(spec.zone==='undereye')return shapes.concealer(ctx,p,f);
    return [];
  }
};

/* ---- masks -------------------------------------------------------------- */
// How far each layer's edge is feathered at 100% on the fade slider, in face widths.
const FEATHER={foundation:.06,concealer:.05,contour:.07,blush:.07,highlighter:.045,eyeshadow:.02,
  eyeliner:.012,mascara:.004,brow:.02,lipliner:.012,lipstick:.024,gloss:.024,texture:.05};

function makeCanvas(){return document.createElement('canvas');}
function fit(canvas,w,h){if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}}

function boundsOf(points,pad,W,H){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const q of points){if(q.x<x0)x0=q.x;if(q.y<y0)y0=q.y;if(q.x>x1)x1=q.x;if(q.y>y1)y1=q.y;}
  if(!points.length)return {x:0,y:0,w:W,h:H};
  x0=Math.max(0,Math.floor(x0-pad));y0=Math.max(0,Math.floor(y0-pad));
  x1=Math.min(W,Math.ceil(x1+pad));y1=Math.min(H,Math.ceil(y1+pad));
  return {x:x0,y:y0,w:Math.max(1,x1-x0),h:Math.max(1,y1-y0)};
}

// Broad, soft layers are painted at half resolution: their edges are feathered far
// wider than a pixel anyway, and a quarter of the pixels is a quarter of the work.
// Thin ones (liner, lashes, lip liner, brows, lipstick edges) keep every pixel.
const HALF=new Set(['foundation','concealer','contour','blush','highlighter','texture']);

// One painter per renderer. It owns its scratch canvases and returns the same mask
// canvas each time, so the caller must use (or upload) it before the next paint.
// The mask may be smaller than the frame; draw or sample it stretched to the frame.
export function createMaskPainter(){
  const mask=makeCanvas(),shape=makeCanvas(),spread=makeCanvas(),union=makeCanvas();
  const opts={willReadFrequently:false};
  let lastBox=null;
  const mctx=mask.getContext('2d',opts),sctx=shape.getContext('2d',opts);
  const bctx=spread.getContext('2d',opts),uctx=union.getContext('2d',opts);

  function paint(spec,landmarks,W,H,brush){
    const scale=HALF.has(spec.type)?.5:1;
    const w=Math.max(1,Math.round(W*scale)),h=Math.max(1,Math.round(H*scale));
    for(const c of [mask,shape,spread,union])fit(c,w,h);
    const p=i=>({x:landmarks[i].x*w,y:landmarks[i].y*h});
    const f=faceFrame(p);
    const draw=shapes[spec.type];
    sctx.clearRect(0,0,w,h);mctx.clearRect(0,0,w,h);
    sctx.save();const points=draw(sctx,p,f,spec)||[];sctx.restore();
    const radius=f.face*(FEATHER[spec.type]||.03)*Math.max(0,Math.min(100,spec.fade??45))/100;
    let box=boundsOf(points,radius*3+4,w,h);
    blurInto(mctx,shape,box,radius);

    // The brush: blend spreads the colour, fade and erase take it away. The maps are
    // frame-sized, so they are drawn stretched to this mask.
    if(brush){
      const blend=[brush.blend.get('all'),brush.blend.get(spec.type)].filter(Boolean);
      if(blend.length){
        box={x:0,y:0,w,h};                                  // the spread can reach past the shape
        uctx.clearRect(0,0,w,h);for(const b of blend)uctx.drawImage(b,0,0,w,h);
        bctx.clearRect(0,0,w,h);blurInto(bctx,mask,box,f.face*.045);
        bctx.globalCompositeOperation='destination-in';bctx.drawImage(union,0,0);bctx.globalCompositeOperation='source-over';
        mctx.globalCompositeOperation='destination-out';mctx.drawImage(union,0,0);
        mctx.globalCompositeOperation='lighter';mctx.drawImage(spread,0,0);
        mctx.globalCompositeOperation='source-over';
      }
      for(const e of [brush.erase.get('all'),brush.erase.get(spec.type)]){
        if(!e)continue;
        mctx.globalCompositeOperation='destination-out';mctx.drawImage(e,0,0,w,h);mctx.globalCompositeOperation='source-over';
      }
    }

    // Keep everything on the face and out of the eye and mouth openings, whatever
    // the blur and the brush did. Nothing lies outside the box, so only it is touched.
    mctx.save();
    mctx.beginPath();mctx.rect(box.x,box.y,box.w,box.h);mctx.clip();
    mctx.globalCompositeOperation='destination-in';mctx.beginPath();polygon(mctx,faceOval.map(p));mctx.fill();
    mctx.globalCompositeOperation='destination-out';mctx.beginPath();
    polygon(mctx,lipInner.map(p));for(const eye of eyes)polygon(mctx,[...eye.upper,...eye.lower].map(p));mctx.fill();
    mctx.restore();
    lastBox={x:box.x/w,y:box.y/h,w:box.w/w,h:box.h/h};
    return mask;
  }
  // `box` bounds the last mask painted, as fractions of the frame.
  return {paint,canvas:mask,get box(){return lastBox;}};
}

/* ---- what is on the face ------------------------------------------------ */
// The layers to paint, in order, for the current makeup state. A palette becomes four
// layers, one per pan; every other product is one.
export function layerSpecs(states){
  const out=[];
  for(const type of layerOrder){
    const item=products.find(p=>p.type===type&&states[p.id]?.enabled);
    if(!item)continue;
    const state=states[item.id];
    const shade=item.shades.find(s=>s.id===state.shade)||item.shades[0];
    const base={product:item.id,type,mode:item.mode,intensity:state.intensity,fade:state.fade,
      style:state.style||item.styles?.[0]?.id,finish:shade.finish||item.finish,shade:shade.id};
    if(shade.colors){
      // A real eye is not four strong washes stacked on one lid. The light pan washes
      // the lid, a mid pan sits in the crease, the dark one stays in the outer corner
      // and only a touch of light goes under the brow. Weights are well below the old
      // .75-.95, which was what turned any palette into one flat smear of colour.
      const zones=[['lid',0,.55],['crease',1,.58],['outer',2,.42],['highlight',0,.22]];
      for(const [zone,pan,weight] of zones)
        out.push({...base,key:`${item.id}:${zone}`,zone,color:shade.colors[pan],intensity:state.intensity*weight,
          finish:zone==='lid'?'shimmer':base.finish});
    }else out.push({...base,key:item.id,color:shade.color});
  }
  return out;
}

/* ---- fallback: flat colour on the 2D overlay ----------------------------- */
let tint;
export function renderFallback(ctx,specs,landmarks,painter,brush){
  const {width,height}=ctx.canvas;ctx.clearRect(0,0,width,height);
  if(!landmarks||landmarks.length<468||!specs.length)return;
  if(!tint)tint=makeCanvas();fit(tint,width,height);
  const tctx=tint.getContext('2d');
  for(const spec of specs){
    const mask=painter.paint(spec,landmarks,width,height,brush);
    tctx.clearRect(0,0,width,height);tctx.globalCompositeOperation='source-over';tctx.drawImage(mask,0,0,width,height);
    tctx.globalCompositeOperation='source-in';tctx.fillStyle=spec.color;tctx.fillRect(0,0,width,height);
    tctx.globalCompositeOperation='source-over';
    const soften={foundation:.55,concealer:.5,texture:0,highlighter:.6}[spec.type]??1;
    ctx.globalAlpha=Math.min(1,spec.intensity/100*soften);ctx.drawImage(tint,0,0);ctx.globalAlpha=1;
  }
}
export const colorOf=rgba;

// Steadies the landmarks without making the makeup trail a moving face: a One Euro
// filter, one gain for the whole face so its shape is never bent. At rest the cutoff
// is low and the jitter of the model is smoothed away; the faster the face moves,
// the higher the cutoff, so the smoothing, and its lag, fade out.
export function createSmoother({minCutoff=1.5,beta=20,dCutoff=1}={}){
  let prev=null,prevT=0,speed=0;
  const gain=(cutoff,dt)=>1/(1+1/(2*Math.PI*cutoff*dt));
  const probes=[1,10,152,234,454];
  return {
    reset(){prev=null;},
    // `t` in milliseconds: when the frame these landmarks came from was taken.
    smooth(next,t){
      if(!next){prev=null;return null;}
      if(!prev||prev.length!==next.length){prev=next;prevT=t;speed=0;return next;}
      const dt=Math.max(.001,(t-prevT)/1000);prevT=t;
      let move=0;for(const i of probes)move+=distance(prev[i],next[i])/probes.length;
      // Do not drag a stale mask onto a reacquired face.
      if(move>.1){prev=next;speed=0;return next;}
      speed+=gain(dCutoff,dt)*(move/dt-speed);
      const a=gain(minCutoff+beta*speed,dt);
      prev=next.map((q,i)=>({...q,x:prev[i].x+(q.x-prev[i].x)*a,y:prev[i].y+(q.y-prev[i].y)*a}));
      return prev;
    }
  };
}
