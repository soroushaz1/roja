// Hairstyles: a head of hair drawn over the mirror and carried by the face as it moves.
//
// Each style is drawn once, whenever the style, its colour, its edge or a comb stroke
// changes, into a picture in the head's own space: the canonical face of facemesh.js,
// one unit across the face, with room around it for the hair. Every frame that picture
// is placed on the live face by an affine fit to a dozen landmarks that do not move
// with the jaw or an expression, so the hair follows a turn, a tilt and the distance
// to the camera, and a smile does not lift it.
//
// The hair is drawn, not photographed: strands along each style's flow, shaded darker
// at the roots and the edges, lighter where light catches the crown. It is a preview
// of the shape and the colour, not a photograph of a haircut. The real hair under it
// stays where it is; app.js recolours it to the same colour so the two read as one.
//
// The comb pushes the drawn hair where the finger goes: each stroke adds to a field of
// small displacements over the picture, and the picture is redrawn through it.
import {CANON,CANON_ASPECT} from './facemesh.js?v=25';
import {blurInto} from './blur.js?v=25';

// The picture's extent in head units (x across, y down; the face spans 0..1 across and
// 0..CANON_ASPECT down), and its resolution.
const X0=-.6, X1=1.6, Y0=-.8, Y1=2.3, RES=240;
const PW=Math.round((X1-X0)*RES), PH=Math.round((Y1-Y0)*RES);
const A=CANON_ASPECT;
// Landmarks that hold still through a smile, a blink or an open mouth.
const ANCHORS=[10,109,338,67,297,54,284,234,454,127,356,162,389,168,6,33,263,133,362,1];
const canon=i=>({x:CANON[i*2],y:CANON[i*2+1]*A});
const FACE_OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

/* ---- placing the picture on the face ---------------------------------- */
// The affine map from head units to frame pixels that best fits the anchors, by least
// squares: px = a·x + b·y + c, py = d·x + e·y + f.
export function headFit(landmarks,w,h){
  let sxx=0,sxy=0,syy=0,sx=0,sy=0,n=0,bx=[0,0,0],by=[0,0,0];
  for(const i of ANCHORS){
    const q=canon(i),l=landmarks[i];if(!l)return null;
    const px=l.x*w,py=l.y*h;
    sxx+=q.x*q.x;sxy+=q.x*q.y;syy+=q.y*q.y;sx+=q.x;sy+=q.y;n++;
    bx[0]+=q.x*px;bx[1]+=q.y*px;bx[2]+=px;by[0]+=q.x*py;by[1]+=q.y*py;by[2]+=py;
  }
  const M=[[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]];
  const solve=b=>{
    const m=M.map((row,i)=>[...row,b[i]]);
    for(let c=0;c<3;c++){
      let p=c;for(let r=c+1;r<3;r++)if(Math.abs(m[r][c])>Math.abs(m[p][c]))p=r;
      [m[c],m[p]]=[m[p],m[c]];
      if(Math.abs(m[c][c])<1e-9)return null;
      for(let r=0;r<3;r++)if(r!==c){const k=m[r][c]/m[c][c];for(let k2=c;k2<4;k2++)m[r][k2]-=k*m[c][k2];}
    }
    return [m[0][3]/m[0][0],m[1][3]/m[1][1],m[2][3]/m[2][2]];
  };
  const r1=solve(bx),r2=solve(by);
  return r1&&r2?[...r1,...r2]:null;
}
// A frame pixel back in head units, for the comb.
function toHead(fit,px,py){
  const [a,b,c,d,e,f]=fit,det=a*e-b*d;
  if(Math.abs(det)<1e-9)return null;
  const x=px-c,y=py-f;
  return {x:(e*x-b*y)/det,y:(a*y-d*x)/det,scale:Math.sqrt(Math.abs(det))};
}

/* ---- the styles -------------------------------------------------------- */
// Outlines are closed loops of head-unit points, smoothed into curves. `hairline` is
// how far down the forehead the hair comes (the face shows below it); `fringe` marks a
// style whose hair falls over the forehead to that line. `neck` is the gap below the
// chin where the neck and shoulders show between hair that falls behind them.
const ear=.55;
function arc(cx,cy,rx,ry,from,to,steps=10){
  const out=[];
  for(let i=0;i<=steps;i++){const t=from+(to-from)*i/steps;out.push({x:cx+Math.cos(t)*rx,y:cy+Math.sin(t)*ry});}
  return out;
}
// The crown: the top of the head, from one temple over to the other.
const crown=(lift=0,wide=0)=>arc(.5,.36,.67+wide,.9+lift,Math.PI*1.04,Math.PI*1.96,16);
const wavy=(points,amp,freq,phase=0)=>points.map((q,i)=>({x:q.x+Math.sin(i*freq+phase)*amp,y:q.y}));

export const styles={
  pixie:{
    outline:[...crown(-.06,-.04),{x:1.08,y:.3},{x:1.06,y:ear},{x:.99,y:.62},{x:.95,y:.4},
      {x:.05,y:.4},{x:.01,y:.62},{x:-.06,y:ear},{x:-.08,y:.3}],
    hairline:.08,length:.5,flow:'swept',part:.36
  },
  bob:{
    outline:[...crown(),{x:1.13,y:.4},{x:1.16,y:.8},{x:1.1,y:1.06},{x:.94,y:1.12},{x:.86,y:.95},
      {x:.14,y:.95},{x:.06,y:1.12},{x:-.1,y:1.06},{x:-.16,y:.8},{x:-.13,y:.4}],
    hairline:.06,length:1.15,flow:'straight',part:.42,tuck:.98
  },
  bangs:{
    outline:[...crown(),{x:1.14,y:.45},{x:1.16,y:1},{x:1.2,y:1.5},{x:.9,y:1.6},{x:.84,y:1.1},
      {x:.16,y:1.1},{x:.1,y:1.6},{x:-.2,y:1.5},{x:-.16,y:1},{x:-.14,y:.45}],
    hairline:.2,fringe:true,length:1.6,flow:'straight',part:.5,neck:true
  },
  long:{
    outline:[...crown(),{x:1.13,y:.45},{x:1.15,y:1.1},{x:1.3,y:1.7},{x:1.36,y:2.2},{x:.92,y:2.24},{x:.84,y:1.2},
      {x:.16,y:1.2},{x:.08,y:2.24},{x:-.36,y:2.2},{x:-.3,y:1.7},{x:-.15,y:1.1},{x:-.13,y:.45}],
    hairline:.05,length:2.25,flow:'straight',part:.4,neck:true
  },
  waves:{
    outline:[...crown(.02,.04),...wavy([{x:1.18,y:.5},{x:1.24,y:.8},{x:1.2,y:1.1},{x:1.34,y:1.4},{x:1.32,y:1.7},{x:1.42,y:2}],.05,2.1),
      {x:1.3,y:2.2},{x:.9,y:2.2},{x:.85,y:1.2},{x:.15,y:1.2},{x:.1,y:2.2},{x:-.3,y:2.2},
      ...wavy([{x:-.42,y:2},{x:-.32,y:1.7},{x:-.34,y:1.4},{x:-.2,y:1.1},{x:-.24,y:.8},{x:-.18,y:.5}],.05,2.1,1)],
    hairline:.05,length:2.2,flow:'wave',part:.38,neck:true
  },
  curls:{
    outline:[...arc(.5,.42,.9,1.08,Math.PI*1.0,Math.PI*2.0,22),{x:1.38,y:.75},{x:1.34,y:1.1},{x:1.22,y:1.4},{x:.98,y:1.5},
      {x:.86,y:1.08},{x:.14,y:1.08},{x:.02,y:1.5},{x:-.22,y:1.4},{x:-.34,y:1.1},{x:-.38,y:.75}],
    hairline:.04,length:1.45,flow:'curl',part:.5,neck:true
  }
};

/* ---- drawing ----------------------------------------------------------- */
function rng(seed){return ()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}
const hex=c=>{const n=parseInt(c.slice(1),16);return [(n>>16)&255,(n>>8)&255,n&255];};
const rgb=(c,k=1,add=0)=>`rgb(${c.map(v=>Math.max(0,Math.min(255,Math.round(v*k+add)))).join(',')})`;
const P=q=>({x:(q.x-X0)*RES,y:(q.y-Y0)*RES});
function smooth(ctx,points){
  const p=points.map(P),mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const m=mid(p[p.length-1],p[0]);ctx.moveTo(m.x,m.y);
  p.forEach((q,i)=>{const n=mid(q,p[(i+1)%p.length]);ctx.quadraticCurveTo(q.x,q.y,n.x,n.y);});
  ctx.closePath();
}
// Where the face shows: the face's own outline below the temples, and above them the
// hairline, an arch over the forehead (or the straight edge of a fringe).
function faceWindow(style){
  // FACE_OVAL runs from the forehead down the right side, round the chin and up the
  // left, so below the temples it is one run from right to left; the arch closes it.
  const lower=FACE_OVAL.map(canon).filter(q=>q.y>.3).map(q=>({x:.5+(q.x-.5)*.97,y:q.y}));
  const top=[];
  for(let i=0;i<=12;i++){
    const x=.05+.9*i/12,u=(x-.5)/.45;
    top.push({x,y:style.fringe?style.hairline+.02*u*u:style.hairline-.07+.34*u*u});
  }
  return [...lower,...top];
}
const make=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};

// The silhouette, as coverage: the outline less the face and, for hair that falls behind
// the shoulders, the neck.
function paintShape(ctx,style){
  ctx.clearRect(0,0,PW,PH);
  ctx.fillStyle='#000';ctx.beginPath();smooth(ctx,style.outline);ctx.fill();
  ctx.globalCompositeOperation='destination-out';
  ctx.beginPath();smooth(ctx,faceWindow(style));ctx.fill();
  if(style.neck){
    ctx.beginPath();smooth(ctx,[{x:.2,y:.85},{x:.8,y:.85},{x:.86,y:1.3},{x:1.02,y:2.4},{x:-.02,y:2.4},{x:.14,y:1.3}]);ctx.fill();
  }
  if(style.tuck){                                       // a bob stops at the jaw
    ctx.beginPath();ctx.rect(0,(style.tuck+.16-Y0)*RES,PW,PH);ctx.fill();
  }
  ctx.globalCompositeOperation='source-over';
}

// One strand: a path from a root, bent by the style's flow.
function strand(ctx,style,root,random,len){
  const part={x:style.part,y:-.36};
  let dx=root.x-part.x,dy=root.y-part.y;
  const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
  if(style.fringe&&root.x>.08&&root.x<.92&&root.y<.25){dx*=.3;dy=1;}   // falls over the forehead
  let x=root.x,y=root.y;
  const pts=[P({x,y})],step=.02,steps=Math.round(len/step);
  const phase=random()*6.28,curl=style.flow==='curl';
  for(let i=0;i<steps;i++){
    const t=i*step;
    // Gravity bends every strand down; a swept cut stays short and lies to the side.
    dy+=style.flow==='swept'?.02:.07;
    if(style.flow==='swept')dx+=(root.x<style.part?-.05:.05);
    let ox=0;
    if(style.flow==='wave')ox=Math.sin(t*9+phase)*.05;
    if(curl){const a=t*22+phase;ox=Math.cos(a)*.035;dy-=.04;dx+=Math.sin(a)*.25;}
    const n=Math.hypot(dx,dy)||1;dx/=n;dy/=n;
    x+=dx*step;y+=dy*step;
    pts.push(P({x:x+ox,y}));
  }
  ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length-1;i++){const m={x:(pts[i].x+pts[i+1].x)/2,y:(pts[i].y+pts[i+1].y)/2};ctx.quadraticCurveTo(pts[i].x,pts[i].y,m.x,m.y);}
  ctx.stroke();
}

function paintHair(out,shape,style,color,fade,id){
  const ctx=out.getContext('2d');
  const base=hex(color),light=(base[0]*.3+base[1]*.59+base[2]*.11)/255;
  const random=rng(id.split('').reduce((a,c)=>a*31+c.charCodeAt(0),7));
  ctx.clearRect(0,0,PW,PH);
  // The mass: the colour, darker towards the roots and in the hair's own shadow.
  ctx.fillStyle=rgb(base,.82);ctx.fillRect(0,0,PW,PH);
  const g=ctx.createLinearGradient(0,P({x:0,y:-.4}).y,0,P({x:0,y:style.length}).y);
  g.addColorStop(0,'rgba(0,0,0,.28)');g.addColorStop(.25,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(0,0,0,.18)');
  ctx.fillStyle=g;ctx.fillRect(0,0,PW,PH);
  // Strands: many thin paths, each a little lighter or darker than the colour. Curls
  // are coils instead: short arcs, packed close.
  ctx.lineCap='round';
  if(style.flow==='curl')for(let i=0;i<5200;i++){
    const cx=X0+random()*(X1-X0),cy=-.7+random()*(style.length+.8),r=.025+random()*.03;
    const c=P({x:cx,y:cy}),a=random()*6.28;
    ctx.strokeStyle=rgb(base,.55+random()*.8,random()<.08?40+80*light:0);
    ctx.globalAlpha=.35+random()*.35;ctx.lineWidth=1+random()*1.4;
    ctx.beginPath();ctx.ellipse(c.x,c.y,r*RES,r*RES*.75,random()*3.14,a,a+Math.PI*(1+random()*.6));ctx.stroke();
  }
  const n=style.flow==='curl'?600:2200;
  for(let i=0;i<n;i++){
    const a=Math.PI*(1.02+random()*.96),r=.5+random()*.48;
    const root={x:.5+Math.cos(a)*.6*r,y:.3+Math.sin(a)*.72*r};
    const k=.62+random()*.75,lift=random()<.08?40+80*light:0;
    ctx.strokeStyle=rgb(base,k,lift);
    ctx.globalAlpha=.22+random()*.3;
    ctx.lineWidth=.7+random()*1.3;
    strand(ctx,style,root,random,style.length*(.55+random()*.55)+.3);
  }
  // Lower strands for long hair, so the ends are as full as the top.
  if(style.length>1.3)for(let i=0;i<900;i++){
    const side=random()<.5?-1:1,root={x:.5+side*(.52+random()*.18),y:.4+random()*.5};
    ctx.strokeStyle=rgb(base,.6+random()*.7);ctx.globalAlpha=.2+random()*.3;ctx.lineWidth=.8+random();
    strand(ctx,style,root,random,(style.length-root.y)*(.7+random()*.35));
  }
  ctx.globalAlpha=1;
  // Light on the crown, a band where hair catches it.
  ctx.globalCompositeOperation='screen';
  const s=ctx.createRadialGradient(P({x:.38,y:-.12}).x,P({x:.38,y:-.12}).y,0,P({x:.38,y:-.12}).x,P({x:.38,y:-.12}).y,RES*.5);
  s.addColorStop(0,`rgba(255,248,240,${.16+.12*(1-light)})`);s.addColorStop(1,'rgba(255,248,240,0)');
  ctx.fillStyle=s;ctx.fillRect(0,0,PW,PH);
  ctx.globalCompositeOperation='source-over';
  // The edge: the silhouette blurred by the fade, then everything outside it cut away.
  const edge=make(PW,PH),ex=edge.getContext('2d');
  blurInto(ex,shape,{x:0,y:0,w:PW,h:PH},1+fade/100*RES*.03);
  ctx.globalCompositeOperation='destination-in';ctx.drawImage(edge,0,0);
  // Inside edges (around the face) a little darker, as hair is where it meets skin.
  ctx.globalCompositeOperation='source-atop';
  const inner=make(PW,PH),ix=inner.getContext('2d');
  ix.fillStyle='#000';ix.fillRect(0,0,PW,PH);ix.globalCompositeOperation='destination-out';
  blurInto(ix,shape,{x:0,y:0,w:PW,h:PH},RES*.05);
  ctx.globalAlpha=.35;ctx.drawImage(inner,0,0);ctx.globalAlpha=1;
  ctx.globalCompositeOperation='source-over';
}
// A soft shadow a fringe casts on the forehead under it.
function paintShadow(out,style){
  const ctx=out.getContext('2d');ctx.clearRect(0,0,PW,PH);
  if(!style.fringe)return false;
  const y=P({x:0,y:style.hairline}).y;
  const g=ctx.createLinearGradient(0,y-RES*.02,0,y+RES*.09);
  g.addColorStop(0,'rgba(20,10,8,.32)');g.addColorStop(1,'rgba(20,10,8,0)');
  ctx.fillStyle=g;ctx.beginPath();smooth(ctx,faceWindow(style));ctx.fill();
  return true;
}

/* ---- the comb ---------------------------------------------------------- */
// A field of displacements over the picture, on a coarse grid; the picture is drawn back
// through it, each pixel taking the colour from where the comb pulled it.
const GX=Math.ceil(PW/12)+1, GY=Math.ceil(PH/12)+1;
function createComb(){
  let fx=new Float32Array(GX*GY),fy=new Float32Array(GX*GY);
  const history=[];let last=null,version=0;
  return {
    get version(){return version;},get count(){return history.length;},
    get empty(){return !history.length;},
    begin(q){history.push([fx.slice(),fy.slice()]);if(history.length>30)history.shift();last=q;},
    // Push the hair under a stroke from the last point to q, within `radius` head units.
    extend(q,radius,strength){
      if(!last)return false;
      const dx=(q.x-last.x)*RES,dy=(q.y-last.y)*RES;
      if(Math.hypot(dx,dy)<.5)return false;
      // Centred where the stroke came from, so what was there is carried to where it went.
      const cx=(last.x-X0)*RES/12,cy=(last.y-Y0)*RES/12,r=radius*RES/12,r2=r*r;
      for(let j=Math.max(0,Math.floor(cy-2*r));j<=Math.min(GY-1,Math.ceil(cy+2*r));j++)
        for(let i=Math.max(0,Math.floor(cx-2*r));i<=Math.min(GX-1,Math.ceil(cx+2*r));i++){
          const d2=(i-cx)**2+(j-cy)**2;if(d2>4*r2)continue;
          const k=Math.exp(-d2/r2)*strength;
          fx[j*GX+i]+=dx*k;fy[j*GX+i]+=dy*k;
        }
      last=q;version++;return true;
    },
    end(){last=null;},
    undo(){const h=history.pop();if(h){[fx,fy]=h;version++;}},
    clear(){if(history.length){history.length=0;fx=new Float32Array(GX*GY);fy=new Float32Array(GX*GY);version++;}},
    // `src` through the field into `dst`.
    apply(src,dst){
      const s=src.getContext('2d').getImageData(0,0,PW,PH).data;
      const outImg=new ImageData(PW,PH),o=outImg.data;
      for(let y=0;y<PH;y++){
        const gy=y/12,j=Math.min(GY-2,Math.floor(gy)),ty=gy-j;
        for(let x=0;x<PW;x++){
          const gx=x/12,i=Math.min(GX-2,Math.floor(gx)),tx=gx-i,k=j*GX+i;
          const ddx=(fx[k]*(1-tx)+fx[k+1]*tx)*(1-ty)+(fx[k+GX]*(1-tx)+fx[k+GX+1]*tx)*ty;
          const ddy=(fy[k]*(1-tx)+fy[k+1]*tx)*(1-ty)+(fy[k+GX]*(1-tx)+fy[k+GX+1]*tx)*ty;
          const sx=Math.round(x-ddx),sy=Math.round(y-ddy);
          if(sx<0||sy<0||sx>=PW||sy>=PH)continue;
          const a=(sy*PW+sx)*4,b=(y*PW+x)*4;
          o[b]=s[a];o[b+1]=s[a+1];o[b+2]=s[a+2];o[b+3]=s[a+3];
        }
      }
      dst.getContext('2d').putImageData(outImg,0,0);
    }
  };
}

/* ---- the renderer ------------------------------------------------------ */
export function createHair(){
  const shape=make(PW,PH),hair=make(PW,PH),combed=make(PW,PH),shadow=make(PW,PH);
  const comb=createComb();
  let key='',combedAt=-1,hasShadow=false,current=null;
  function picture(){
    if(!current)return null;
    const k=`${current.style}|${current.color}|${current.fade}`;
    if(k!==key){
      const style=styles[current.style]||styles.bob;
      paintShape(shape.getContext('2d'),style);
      paintHair(hair,shape,style,current.color,current.fade,current.style);
      hasShadow=paintShadow(shadow,style);
      key=k;combedAt=-1;
    }
    if(comb.empty)return hair;
    if(combedAt!==comb.version){comb.apply(hair,combed);combedAt=comb.version;}
    return combed;
  }
  return {
    comb,
    // {style, color, fade} or null for no hairstyle.
    set(next){current=next;},
    get on(){return !!current;},
    // Draws the hair on `ctx` (a frame-sized canvas) for these landmarks.
    draw(ctx,landmarks,w,h,opacity=1){
      const pic=picture();
      if(!pic||!landmarks)return false;
      const fit=headFit(landmarks,w,h);
      if(!fit)return false;
      const [a,b,c,d,e,f]=fit;
      ctx.save();
      ctx.setTransform(a/RES,d/RES,b/RES,e/RES,a*X0+b*Y0+c,d*X0+e*Y0+f);
      ctx.imageSmoothingEnabled=true;
      if(hasShadow){ctx.globalAlpha=opacity;ctx.drawImage(shadow,0,0);}
      ctx.globalAlpha=opacity;ctx.drawImage(pic,0,0);
      ctx.restore();
      return true;
    },
    // A frame pixel in head units, and how many frame pixels one head unit spans.
    toHead(landmarks,w,h,px,py){const fit=landmarks&&headFit(landmarks,w,h);return fit?toHead(fit,px,py):null;}
  };
}
