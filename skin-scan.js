// Measuring bare skin from one camera frame or photo, for the skin check (skin.js).
//
// The face is cut out of the frame at a fixed scale (320 px ear to ear), so every
// number below means the same thing at any distance and camera resolution. Regions
// (forehead, cheeks, nose, chin, under the eyes, the outer eye corners) are picked from
// the canonical mesh once, then drawn onto the frame through the live landmarks. Each
// region is measured in CIE Lab: tone, shine, redness, uneven tone, spots, fine texture
// and lines.
//
// A handful of numbers leave this module; the pixels do not. Nothing is kept or sent.
import {CANON,TRIANGLES} from './facemesh.js?v=19';

const FACE_PX=320;
const SHARP=12;            // the 98th-percentile edge step a focused face reaches

// Region boxes in the canonical front-on face (x across, y down, both 0..1); a triangle
// belongs to the first box its centre falls in.
const BOXES=[
  ['forehead',.22,.78,.06,.165],
  ['cheekL',.12,.36,.40,.62],['cheekR',.64,.88,.40,.62],
  ['nose',.445,.555,.30,.50],
  ['chin',.37,.63,.80,.93],
  ['eyeL',.24,.38,.355,.405],['eyeR',.62,.76,.355,.405],
  ['crowL',.09,.20,.27,.38],['crowR',.80,.91,.27,.38]
];
export const REGIONS=BOXES.map(b=>b[0]);
const regionTriangles=BOXES.map(()=>[]);
for(let t=0;t<TRIANGLES.length;t+=3){
  const a=TRIANGLES[t],b=TRIANGLES[t+1],c=TRIANGLES[t+2];
  const x=(CANON[a*2]+CANON[b*2]+CANON[c*2])/3,y=(CANON[a*2+1]+CANON[b*2+1]+CANON[c*2+1])/3;
  const k=BOXES.findIndex(([,x0,x1,y0,y1])=>x>=x0&&x<=x1&&y>=y0&&y<=y1);
  if(k>=0)regionTriangles[k].push(a,b,c);
}

// sRGB to CIE Lab (D65), through a table for the 256 channel values.
const LIN=new Float32Array(256);
for(let i=0;i<256;i++){const c=i/255;LIN[i]=c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);}
const f=t=>t>.008856?Math.cbrt(t):7.787*t+16/116;
export function labOf(r,g,b){
  const R=LIN[r],G=LIN[g],B=LIN[b];
  const x=f((R*.4124+G*.3576+B*.1805)/.95047),y=f(R*.2126+G*.7152+B*.0722),z=f((R*.0193+G*.1192+B*.9505)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}

// A box blur of radius r through an integral image.
function blur(src,w,h,r){
  const sum=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){
    let row=0;
    for(let x=0;x<w;x++){row+=src[y*w+x];sum[(y+1)*(w+1)+x+1]=sum[y*(w+1)+x+1]+row;}
  }
  const out=new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const y0=Math.max(0,y-r),y1=Math.min(h,y+r+1);
    for(let x=0;x<w;x++){
      const x0=Math.max(0,x-r),x1=Math.min(w,x+r+1);
      out[y*w+x]=(sum[y1*(w+1)+x1]-sum[y0*(w+1)+x1]-sum[y1*(w+1)+x0]+sum[y0*(w+1)+x0])/((x1-x0)*(y1-y0));
    }
  }
  return out;
}
const median=v=>{if(!v.length)return NaN;const s=Float32Array.from(v).sort(),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:NaN;

export function createSkinScanner(){
  const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):document.createElement('canvas');
  const maskCanvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):document.createElement('canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const mctx=maskCanvas.getContext('2d',{willReadFrequently:true});

  // `image` is anything drawImage takes, `width`×`height` the frame the normalised
  // landmarks refer to, `pose` the head angles if known.
  function scan(image,width,height,landmarks,pose=null){
    if(!image||!landmarks||landmarks.length<468)return null;
    const P=i=>[landmarks[i].x*width,landmarks[i].y*height];
    const faceW=Math.hypot(P(454)[0]-P(234)[0],P(454)[1]-P(234)[1]);
    if(faceW<40)return null;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(let i=0;i<468;i++){const [x,y]=P(i);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    x0=Math.max(0,Math.floor(x0));y0=Math.max(0,Math.floor(y0));
    x1=Math.min(width,Math.ceil(x1));y1=Math.min(height,Math.ceil(y1));
    if(x1-x0<20||y1-y0<20)return null;
    const s=FACE_PX/faceW,w=Math.round((x1-x0)*s),h=Math.round((y1-y0)*s);
    canvas.width=maskCanvas.width=w;canvas.height=maskCanvas.height=h;
    ctx.drawImage(image,x0,y0,x1-x0,y1-y0,0,0,w,h);
    const rgba=ctx.getImageData(0,0,w,h).data;

    // One fill per region, so no seams between its own triangles; the red channel
    // carries the region's number and antialiased edges are left out.
    mctx.clearRect(0,0,w,h);
    regionTriangles.forEach((tris,k)=>{
      mctx.beginPath();
      for(let t=0;t<tris.length;t+=3)for(let j=0;j<3;j++){
        const [px,py]=P(tris[t+j]),X=(px-x0)*s,Y=(py-y0)*s;
        j?mctx.lineTo(X,Y):mctx.moveTo(X,Y);
        if(j===2)mctx.closePath();
      }
      mctx.fillStyle=`rgb(${k+1},0,0)`;mctx.fill();
    });
    const mask=mctx.getImageData(0,0,w,h).data;

    const n=w*h,L=new Float32Array(n),A=new Float32Array(n),B=new Float32Array(n);
    const members=BOXES.map(()=>[]);
    for(let i=0;i<n;i++){
      const [l,a,b]=labOf(rgba[i*4],rgba[i*4+1],rgba[i*4+2]);
      L[i]=l;A[i]=a;B[i]=b;
      const k=mask[i*4];
      if(k&&mask[i*4+3]===255&&k<=BOXES.length)members[k-1].push(i);
    }
    // Hair, brows, glasses and deep shadow are not skin: inside each region, keep the
    // pixels near its own median colour.
    const region={};
    BOXES.forEach(([name],k)=>{
      const idx=members[k];
      const mL=median(idx.map(i=>L[i])),mA=median(idx.map(i=>A[i])),mB=median(idx.map(i=>B[i]));
      const skin=idx.filter(i=>Math.abs(L[i]-mL)<22&&Math.abs(A[i]-mA)<14&&Math.abs(B[i]-mB)<14);
      region[name]={all:idx.length,skin,L:median(skin.map(i=>L[i])),a:median(skin.map(i=>A[i])),b:median(skin.map(i=>B[i]))};
    });
    const pick=(...names)=>names.flatMap(nm=>region[nm].skin);
    const main=pick('forehead','cheekL','cheekR','chin');
    if(main.length<400)return null;

    const tone={L:median(main.map(i=>L[i])),a:median(main.map(i=>A[i])),b:median(main.map(i=>B[i]))};
    tone.ita=Math.atan2(tone.L-50,tone.b)*180/Math.PI;
    tone.hue=Math.atan2(tone.b,tone.a)*180/Math.PI;
    tone.chroma=Math.hypot(tone.a,tone.b);
    {
      const r=[0,0,0];for(const i of main){r[0]+=rgba[i*4];r[1]+=rgba[i*4+1];r[2]+=rgba[i*4+2];}
      tone.hex='#'+r.map(v=>Math.round(v/main.length).toString(16).padStart(2,'0')).join('');
    }

    // Bands of detail: `fine` keeps pores and fine lines, `mid` blotches and spots,
    // `coarse` the shading of the face's shape, which none of the measures should see.
    const fine=blur(L,w,h,1),mid=blur(L,w,h,3),broad=blur(L,w,h,5),coarse=blur(L,w,h,9),smooth=blur(L,w,h,14),redBase=blur(A,w,h,8);
    const tzone=pick('forehead','nose'),cheeks=pick('cheekL','cheekR');
    const spotZone=pick('forehead','cheekL','cheekR','chin');

    // Shine: whitish highlights (much lighter, less coloured than the skin around).
    const shineOf=list=>list.length?list.filter(i=>L[i]>coarse[i]+9&&Math.hypot(A[i],B[i])<tone.chroma*.85).length/list.length:0;
    // Uneven tone: the spread of mid-sized light and dark patches, shading removed.
    const unevenOf=list=>{
      if(list.length<60)return NaN;
      let s1=0,s2=0;for(const i of list){const d=mid[i]-smooth[i];s1+=d;s2+=d*d;}
      return Math.sqrt(Math.max(0,s2/list.length-(s1/list.length)**2));
    };
    // Lines: steps in the fine detail across (horizontal lines) against along, on the
    // forehead; in all directions at the eye corners and under the eyes.
    const lineOf=(list,horizontal)=>{
      if(list.length<40)return NaN;
      let across=0,along=0,k=0;
      const d=i=>fine[i]-broad[i];
      for(const i of list){
        const x=i%w,y=(i/w)|0;if(x<1||y<1||x>=w-1||y>=h-1)continue;
        const dy=Math.abs(d(i+w)-d(i-w)),dx=Math.abs(d(i+1)-d(i-1));
        across+=dy;along+=dx;k++;
      }
      return k?(horizontal?Math.max(0,across-along)/k:(across+along)/k):NaN;
    };

    const metrics={
      shineT:shineOf(tzone),shineU:shineOf(cheeks),
      redness:median(pick('cheekL','cheekR','nose','chin').map(i=>A[i])),
      redPatches:spotZone.length?spotZone.filter(i=>A[i]>tone.a+7).length/spotZone.length:0,
      redSpots:spotZone.length?spotZone.filter(i=>A[i]-redBase[i]>4.5).length/spotZone.length:0,
      darkSpots:spotZone.length?spotZone.filter(i=>L[i]-coarse[i]<-6&&A[i]-redBase[i]<3).length/spotZone.length:0,
      uneven:mean(['forehead','cheekL','cheekR','chin'].map(nm=>unevenOf(region[nm].skin)).filter(Number.isFinite)),
      texture:cheeks.length?mean(cheeks.map(i=>Math.abs(L[i]-fine[i]))):NaN,
      foreheadLines:lineOf(region.forehead.skin,true),
      crowLines:mean([lineOf(region.crowL.skin,false),lineOf(region.crowR.skin,false)].filter(Number.isFinite)),
      underEyeLines:mean([lineOf(region.eyeL.skin,false),lineOf(region.eyeR.skin,false)].filter(Number.isFinite)),
      underEyeDark:mean([region.cheekL.L-region.eyeL.L,region.cheekR.L-region.eyeR.L].filter(Number.isFinite))
    };

    // Sharpness: how steep the strongest edges are (lashes, brows, the eyes), so smooth
    // skin does not read as a blurred picture. Out of focus or moving, they spread out.
    const steep=new Float32Array(Math.ceil((w-2)/2)*Math.ceil((h-2)/2));
    let k=0;
    for(let y=1;y<h-1;y+=2)for(let x=1;x<w-1;x+=2){const i=y*w+x;steep[k++]=Math.abs(L[i+1]-L[i-1])+Math.abs(L[i+w]-L[i-w]);}
    const sharp=steep.subarray(0,k).sort()[Math.floor(k*.98)];
    const clipped=main.filter(i=>L[i]>96).length/main.length;
    const sideGap=Math.abs(region.cheekL.L-region.cheekR.L);
    const quality=[
      {id:'size',ok:faceW>=200,value:faceW},
      {id:'pose',ok:!pose||(Math.abs(pose.yaw)<12&&Math.abs(pose.pitch)<14&&Math.abs(pose.roll)<12),value:pose?Math.max(Math.abs(pose.yaw),Math.abs(pose.pitch),Math.abs(pose.roll)):0},
      {id:'light',ok:tone.L>=38&&tone.L<=84&&clipped<.03,value:tone.L},
      {id:'even',ok:sideGap<9,value:sideGap},
      {id:'colour',ok:tone.hue>=28&&tone.hue<=78&&tone.chroma>=8&&tone.chroma<=40,value:tone.hue},
      {id:'sharp',ok:sharp>=SHARP,value:sharp}
    ];
    return {tone,metrics,quality,ok:quality.every(q=>q.ok),faceWidth:faceW};
  }
  return {scan};
}
