// Hairstyles: the baked styles in hairstyles/<id>/ (made offline by tools/hair-bake; the
// format is tools/hair-bake/FORMAT.md). The list comes from hairstyles/index.json, written
// by tools/hair-bake/manifest.py, so a newly baked style shows up without a code change.
//
// Nothing is fetched until the hairstyle product is opened: then the list (a few KB with
// its small pictures), and a style's own textures only when that style is picked. They
// come from this site like every other file; the camera frame never goes anywhere.
//
// This module loads and decodes. Drawing is the stage's job: a loaded style carries its
// decoded images (ImageBitmap, or <img> where createImageBitmap cannot skip colour
// management) ready for texImage2D, and each view's parallax grid (FORMAT.md section 8,
// step 4) ready for a vertex buffer. Upload the images with
// UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE, PREMULTIPLY_ALPHA and FLIP_Y false: the
// values are data, not colours.

export const STYLE_DIR='hairstyles/';
const FORMAT='roja-hairstyle', VERSION=1;
const KINDS=['hair','aux','mask','depth'];
export const GROUPS=[{id:'women',name:'زنانه'},{id:'men',name:'مردانه'}];
export const GRID=8;                       // parallax mesh: one vertex every 8 full-resolution texels
const KEEP=2;                              // decoded styles kept in memory: the current one and the one before
const ID=/^[a-z0-9][a-z0-9-]{0,47}$/;
export const validId=id=>typeof id==='string'&&ID.test(id);

/* ---- the list ------------------------------------------------------------ */
let index=null;
// The styles the site has: [{id, name, group, views, bytes, rev, thumb}], women first.
// One request per page; a failure is not remembered, so the next call tries again.
export function loadIndex(){
  if(!index)index=(async()=>{
    const response=await fetch(STYLE_DIR+'index.json',{cache:'no-cache'});
    if(!response.ok)throw new Error(`hairstyles/index.json: HTTP ${response.status}`);
    const doc=await response.json();
    if(doc?.format!=='roja-hairstyles'||!(doc.version<=1))throw new Error('hairstyles/index.json: unknown format');
    const styles=[];
    for(const s of Array.isArray(doc.styles)?doc.styles:[]){
      if(!validId(s?.id)||!GROUPS.some(g=>g.id===s.group)||!/^[0-9a-f]{6,40}$/.test(s.rev||''))continue;
      styles.push({id:s.id,group:s.group,rev:s.rev,
        name:typeof s.name==='string'&&s.name.trim()?s.name.trim().slice(0,60):s.id,
        views:Array.isArray(s.views)?s.views.filter(Number.isFinite):[],
        bytes:Number.isFinite(s.bytes)?s.bytes:0,
        thumb:typeof s.thumb==='string'&&s.thumb.startsWith('data:image/')?s.thumb:''});
    }
    return styles;
  })().catch(e=>{index=null;throw e;});
  return index;
}

/* ---- one style ----------------------------------------------------------- */
const loaded=new Map();                    // id -> {rev, promise, style}
const disposers=new Set();
// The stage registers here to free what it made from a style (its GL textures and
// buffers) when the style leaves memory.
export function onDispose(fn){disposers.add(fn);return ()=>disposers.delete(fn);}

// Loads a style from its index entry: style.json, then the four textures of every view at
// once. Resolves to the style, ready to draw (see the top of this file). `signal` aborts
// the downloads (a newer pick); `onProgress(0..1)` reports the files done.
export function loadStyle(entry,{signal,onProgress}={}){
  if(!validId(entry?.id))return Promise.reject(new Error('hairstyle: bad id'));
  const hit=loaded.get(entry.id);
  if(hit&&hit.rev===entry.rev){
    loaded.delete(entry.id);loaded.set(entry.id,hit);           // most recently used last
    if(hit.style){onProgress?.(1);return Promise.resolve(hit.style);}
    if(!hit.signal?.aborted)return hit.promise;
  }
  if(hit)drop(entry.id);
  const record={rev:entry.rev,signal,style:null,promise:null};
  record.promise=fetchStyle(entry,signal,onProgress).then(style=>{
    if(loaded.get(entry.id)!==record){dispose(style);throw abortError();}
    record.style=style;trim();return style;
  },e=>{if(loaded.get(entry.id)===record)loaded.delete(entry.id);throw e;});
  loaded.set(entry.id,record);
  return record.promise;
}
export function loadedStyle(id){return loaded.get(id)?.style||null;}

function trim(){
  for(const [id,record] of loaded){
    if(loaded.size<=KEEP)break;
    if(record.style)drop(id);
  }
}
function drop(id){
  const record=loaded.get(id);loaded.delete(id);
  if(record?.style)dispose(record.style);
}
function dispose(style){
  if(style.disposed)return;
  style.disposed=true;
  for(const fn of disposers){try{fn(style);}catch{}}
  for(const view of style.views)for(const k of KINDS)view.images[k]?.close?.();
}
const abortError=()=>Object.assign(new Error('hairstyle: replaced by a newer pick'),{name:'AbortError'});

async function fetchStyle(entry,signal,onProgress){
  const base=`${STYLE_DIR}${entry.id}/`, q=`?r=${encodeURIComponent(entry.rev)}`;
  const get=async name=>{
    const response=await fetch(base+name+q,{signal});
    if(!response.ok)throw new Error(`${base}${name}: HTTP ${response.status}`);
    return response;
  };
  const meta=await (await get('style.json')).json();
  check(meta,entry.id);
  const files=meta.views.length*KINDS.length;
  let done=0;onProgress?.(0);
  const views=await Promise.all([...meta.views].sort((a,b)=>a.yaw-b.yaw).map(async v=>{
    const images={};
    await Promise.all(KINDS.map(async k=>{
      images[k]=await decode(await (await get(v[k])).blob());
      onProgress?.(++done/files);
    }));
    return {yaw:Number(v.yaw),tag:v.hair.replace(/\.hair\.webp$/,''),images,anchors:v.anchors,headOutline:v.head_outline};
  }));
  const {frame,half}=meta;
  for(const view of views){
    const sizes={hair:[frame.width,frame.height],aux:[half.width,half.height],mask:[half.width,half.height],depth:[half.width,half.height]};
    for(const k of KINDS){
      const img=view.images[k],[w,h]=sizes[k];
      if((img.width||img.naturalWidth)!==w||(img.height||img.naturalHeight)!==h)
        throw new Error(`${base}${view.tag}.${k}: ${img.width}x${img.height}, expected ${w}x${h}`);
    }
    view.grid=buildGrid(meta,view.images.depth);
  }
  return {id:entry.id,rev:entry.rev,name:entry.name||meta.name||entry.id,group:meta.group,meta,
    frame:{...frame},half:{...half},scale:{...meta.scale},z:{...meta.z},spec:Number(meta.look?.spec??1),
    anchors:{landmarks:meta.anchors.landmarks.slice(),canonical:meta.anchors.canonical.map(p=>p.slice()),pivot:meta.anchors.pivot.slice()},
    views,yaws:views.map(v=>v.yaw),bytes:meta.bytes||0,disposed:false};
}
// FORMAT.md section 14: refuse other formats and newer versions; check what is drawn with.
function check(meta,id){
  const bad=what=>{throw new Error(`hairstyles/${id}/style.json: ${what}`);};
  if(meta?.format!==FORMAT)bad(`format ${meta?.format}`);
  if(!(Math.floor(meta.version)<=VERSION))bad(`version ${meta.version} is newer than this mirror (${VERSION})`);
  if(meta.id!==id)bad(`id ${meta.id}`);
  const f=meta.frame,h=meta.half,pow2=n=>Number.isInteger(n)&&n>=8&&n<=4096&&!(n&(n-1));
  if(!f||!['x0','y0','x1','y1','res'].every(k=>Number.isFinite(f[k]))||!pow2(f.width)||!pow2(f.height))bad('frame');
  if(!h||h.width!==f.width/2||h.height!==f.height/2)bad('half');
  if(!Array.isArray(meta.views)||!meta.views.length)bad('views');
  for(const v of meta.views){
    if(!Number.isFinite(v?.yaw))bad('view yaw');
    for(const k of KINDS)if(typeof v[k]!=='string'||!/^[\w.-]+\.webp$/.test(v[k]))bad(`view ${v.yaw} ${k}`);
  }
  if(!['D','S1','S2'].every(k=>Number.isFinite(meta.scale?.[k])))bad('scale');
  if(!Number.isFinite(meta.z?.min)||!Number.isFinite(meta.z?.max))bad('z');
  const a=meta.anchors;
  if(!Array.isArray(a?.landmarks)||a.landmarks.length<3||a.canonical?.length!==a.landmarks.length||a.pivot?.length!==3)bad('anchors');
}

// Lossless WebP, decoded without colour management or premultiplication (FORMAT.md
// section 6). The site's development server sends WebP as octet-stream; the type is set
// here so every decoder knows it.
async function decode(blob){
  const typed=new Blob([blob],{type:'image/webp'});
  if(typeof createImageBitmap==='function'){
    try{return await createImageBitmap(typed,{colorSpaceConversion:'none',premultiplyAlpha:'none'});}catch{}
  }
  const url=URL.createObjectURL(typed);
  try{const img=new Image();img.decoding='async';img.src=url;await img.decode();return img;}
  finally{URL.revokeObjectURL(url);}
}

// The parallax grid of one view (FORMAT.md section 8, step 4): a vertex every GRID
// full-resolution texels, at head units (x, y) with the view's depth z (the half-
// resolution Z, bilinearly sampled at the same point), and its texture coordinate (u, v).
// vertices: Float32Array of (x, y, z, u, v); indices: two triangles per cell,
// (p00, p10, p11) and (p00, p11, p01).
function buildGrid(meta,depthImage){
  const {frame,half,z}=meta, hw=half.width, hh=half.height;
  const c=document.createElement('canvas');c.width=hw;c.height=hh;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(depthImage,0,0);
  const px=ctx.getImageData(0,0,hw,hh).data;
  const Z=k=>z.min+(z.max-z.min)*px[k*4]/255;
  const at=(x,y)=>{                       // bilinear at half-res texel coordinates, edges clamped
    const x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
    const cx=i=>Math.min(hw-1,Math.max(0,i)),cy=j=>Math.min(hh-1,Math.max(0,j));
    const a=Z(cy(y0)*hw+cx(x0)),b=Z(cy(y0)*hw+cx(x0+1)),d=Z(cy(y0+1)*hw+cx(x0)),e=Z(cy(y0+1)*hw+cx(x0+1));
    return (a*(1-fx)+b*fx)*(1-fy)+(d*(1-fx)+e*fx)*fy;
  };
  const cols=frame.width/GRID+1, rows=frame.height/GRID+1;
  const vertices=new Float32Array(cols*rows*5);
  for(let b=0,k=0;b<rows;b++)for(let a=0;a<cols;a++,k+=5){
    const U=a*GRID,V=b*GRID;
    vertices[k]=frame.x0+U/frame.res;vertices[k+1]=frame.y0+V/frame.res;
    vertices[k+2]=at(U/frame.width*hw-.5,V/frame.height*hh-.5);
    vertices[k+3]=U/frame.width;vertices[k+4]=V/frame.height;
  }
  const indices=new (cols*rows>65535?Uint32Array:Uint16Array)((cols-1)*(rows-1)*6);
  for(let b=0,k=0;b<rows-1;b++)for(let a=0;a<cols-1;a++){
    const p00=b*cols+a,p10=p00+1,p01=p00+cols,p11=p01+1;
    indices[k++]=p00;indices[k++]=p10;indices[k++]=p11;
    indices[k++]=p00;indices[k++]=p11;indices[k++]=p01;
  }
  return {vertices,indices,cols,rows};
}

/* ---- placement helpers (FORMAT.md sections 3 and 8) ------------------------ */
// A head-unit point turned by `deg` about the vertical axis through the pivot:
// positive yaw turns the face toward image right.
export function turn(x,z,deg,pivot){
  const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a),dx=x-pivot[0],dz=z-pivot[2];
  return [pivot[0]+c*dx+s*dz,pivot[2]-s*dx+c*dz];
}
// The anchors' head-unit (x, y) at this yaw: anchors_xy(yaw).
export function anchorsAt(style,yaw){
  const {canonical,pivot}=style.anchors, out=new Float64Array(canonical.length*2);
  canonical.forEach(([x,y,z],i)=>{out[i*2]=turn(x,z,yaw,pivot)[0];out[i*2+1]=y;});
  return out;
}
// The least-squares affine from those head units to the landmarks in frame pixels:
// [a, b, c, d, e, f] with px = a x + b y + c, py = d x + e y + f. Null if degenerate.
export function headFit(style,landmarks,w,h,yaw){
  const q=anchorsAt(style,yaw), ids=style.anchors.landmarks;
  let sxx=0,sxy=0,sx=0,syy=0,sy=0,n=0,bx=[0,0,0],by=[0,0,0];
  ids.forEach((id,i)=>{
    const l=landmarks[id];if(!l)return;
    const x=q[i*2],y=q[i*2+1],X=l.x*w,Y=l.y*h;
    sxx+=x*x;sxy+=x*y;sx+=x;syy+=y*y;sy+=y;n++;
    bx[0]+=x*X;bx[1]+=y*X;bx[2]+=X;by[0]+=x*Y;by[1]+=y*Y;by[2]+=Y;
  });
  const m=[[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]];
  const det=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  if(n<3||!(Math.abs(det)>1e-12))return null;
  const solve=r=>[0,1,2].map(j=>{
    const t=m.map((row,i)=>row.map((v,k)=>k===j?r[i]:v));
    return (t[0][0]*(t[1][1]*t[2][2]-t[1][2]*t[2][1])-t[0][1]*(t[1][0]*t[2][2]-t[1][2]*t[2][0])+t[0][2]*(t[1][0]*t[2][1]-t[1][1]*t[2][0]))/det;
  });
  return [...solve(bx),...solve(by)];
}
// Cross-fade weights of the views (sorted by yaw): linear between the two nearest, the
// outermost alone beyond them.
export function viewWeights(yaws,yaw){
  const w=yaws.map(()=>0), n=yaws.length;
  if(!n)return w;
  if(yaw<=yaws[0]){w[0]=1;return w;}
  if(yaw>=yaws[n-1]){w[n-1]=1;return w;}
  for(let i=0;i<n-1;i++)if(yaw>=yaws[i]&&yaw<yaws[i+1]){const t=(yaw-yaws[i])/(yaws[i+1]-yaws[i]);w[i]=1-t;w[i+1]=t;break;}
  return w;
}

/* ---- recolour (FORMAT.md section 9; colour.RECOLOUR in tools/hair-bake) ---------- */
export const RECOLOUR={kd:1.38,kd_light:.49,k_m:.55,k_ml:.6,M0:.52,T0:.50,tone:1.6,tone_light:1.2,
  sat:1.08,sat_light:.22,sat_m:.6,sat_t:.8,sat_max:1.35,D0:.6,contrast_light:.35,desat_hi:.15,
  warm:.6,warm_rgb:[1.25,1,.72],k1:.075,k1_dark:.55,tint1:.55,tint1_light:.18,k2:.45,e2:.75,sat2:1.15};
const LUMA709=[.2126,.7152,.0722];
const toLin=c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
// The per-shade terms, once per shade change (uniforms for the stage).
export function dyeTerms(hex,p=RECOLOUR){
  const c=[1,3,5].map(i=>toLin(parseInt(hex.slice(i,i+2),16)/255));
  const Y=Math.max(dot3(c,LUMA709),1e-4),l=Math.pow(Y,1/2.2),wl=dot3(p.warm_rgb,LUMA709);
  return {Y,l,ch:c.map(v=>v/Y),wv:p.warm_rgb.map(v=>v/wl),
    kd:p.kd*(1+p.kd_light*(l-.4)),gamma:1-p.contrast_light*l,tone:p.tone*(1+p.tone_light*l),
    sat:p.sat*(1-p.sat_light*l),k1:p.k1*(p.k1_dark+(1-p.k1_dark)*l),
    tint1:p.tint1+(p.tint1_light-p.tint1)*l,
    absorb:Math.pow(Y,p.k_m)*Math.exp(-p.k_ml*l),y2:p.k2*Math.pow(Y,p.e2)};
}
// One texel, as the shader does it: premultiplied Dp, S1p, S2p; straight M, T; coverage
// A -> premultiplied linear [r, g, b]. For checks against FORMAT.md's test vectors.
export function recolour(Dp,S1p,S2p,M,T,A,t,spec,p=RECOLOUR){
  const a=Math.max(A,1e-3),rel=Dp/a/p.D0;
  const Dc=a*p.D0*Math.pow(Math.max(rel,0),t.gamma);
  const lum=t.kd*t.Y*Dc*Math.exp(t.tone*(T-p.T0))*Math.pow(t.absorb,M-p.M0);
  const s=Math.min(p.sat_max,t.sat*(1+p.sat_m*(M-p.M0)+p.sat_t*(p.T0-T))*(1-p.desat_hi*Math.min(Math.max(rel-1,0),1)));
  const dark=Math.min(Math.max(.5*(1-rel)+(M-p.M0)+.5*(p.T0-T),0),1);
  return [0,1,2].map(k=>{
    const warm=1+(t.wv[k]-1)*(p.warm*t.l*dark);
    const body=lum*Math.max(0,1+(t.ch[k]-1)*s)*warm;
    const hl1=t.k1*S1p*(1+(t.ch[k]-1)*t.tint1);
    const hl2=t.y2*S2p*Math.max(0,1+(t.ch[k]-1)*p.sat2);
    return body+spec*(hl1+hl2);
  });
}
export const shoulder=(x,k=.72)=>x>k?k+(1-k)*Math.tanh((x-k)/(1-k)):x;
