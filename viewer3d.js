// The 3D view: the face with its makeup as a model to turn by hand, from the front round
// towards the profile. Taken over from Roja Clinic, where it was made for previewing
// procedures; here nothing is reshaped, and the model is made from one picture: the
// mirror as it is, makeup and all.
//
// The model is the tracker's own face mesh (468 points with their depth), solved for
// over every picture taken rather than read off one (fuse.js), and placed in the
// head's frame as the front picture has it: the face alone, not the head, with an
// edge that fades out so it is soft. It is smoothed by two rounds of subdivision that
// keep every original point where it is (each new point sits on the curved surface
// the points' normals describe, as in Phong tessellation): an approximating scheme
// like Catmull–Clark would pull in the tip of the nose and the chin, the very shape
// being simulated.
//
// Its texture is baked once, when the model is made, into a picture of its own: an
// atlas, the face unrolled round a vertical axis so the sides keep as much room as the
// front. Every picture taken adds to each texel of it, weighted by how squarely it saw
// that spot against the picture that saw it most squarely, and only where nothing hid
// the spot from it (each picture's own depth map, as on the live view); the pictures
// are first brought to one colour, since the camera's exposure changes as the head
// turns. The middle of the face comes from the front picture, and whatever it saw at
// a slant (the sides of the nose, the cheeks out to the ears, the jaw) from the two or
// three pictures that faced it, so nothing is stretched out of a picture that saw it
// edge-on. The atlas is then filled a little past its edges and given mipmaps, so it
// stays smooth when small and clean at a slant.
//
// It is all done on this device, from the frame already on screen.
import {points3,headFrame,WARP_TRIANGLES,SEEN_VERT,SEEN_FRAG} from './head3d.js?v=29';
import {PRECISION} from './shaders.js?v=29';
import {fuse,apply,place,MESH} from './fuse.js?v=29';

const LEVELS=2;
// The face's outline, in order round it (MediaPipe's face oval).
export const OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,
  152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
// No rim past the outline: the face's own edge fades instead (EDGE below). The skirt
// code stays for a rim, should one be wanted: each ring's reach round the head past the
// outline (radians; below the chin down the neck by `neck` face widths instead), and how
// much of the outline's move under an edit it follows.
const RINGS=[];
const BASE=MESH+OVAL.length*RINGS.length;
// How sharply the picture that saw a point most squarely wins over the others: one
// 8° away gives about a third as much, one 16° away almost nothing. And where the
// front picture keeps the face to itself: wherever it saw the surface within about 35°
// of square on (handing over until about 55°). It is the sharpest picture, and the
// one the tracker places best; averaged with pictures from the side, which never
// line up with it to the pixel, an eye, a nostril or the corner of the mouth would
// show twice.
const SHARP=100, FRONT=[.55,.8];
// The atlas: the share of it left empty round the face, and its size limits.
const MARGIN=.02, ATLAS_MIN=1024, ATLAS_MAX=2048;
// The limits of turning, in degrees. Past ~80° the model is mostly what no picture saw.
export const LIMITS={yaw:80,pitch:30};
// From a single picture, past about 50° the model shows mostly what that picture saw
// edge-on, so it turns no further.
const ONE_PICTURE_YAW=50;

// The model on screen: its colour from the atlas, and how much of each point shows
// (v_a: the face's edge fades out, and near it what no picture saw squarely).
const VERT=`attribute vec3 a_pos;attribute vec2 a_t;attribute float a_a;uniform mat4 u_mvp;
varying vec2 v_t;varying float v_a;
void main(){v_t=a_t;v_a=a_a;gl_Position=u_mvp*vec4(a_pos,1.);}`;
const FRAG=`uniform sampler2D u_atlas;varying vec2 v_t;varying float v_a;
void main(){if(v_a<.02)discard;gl_FragColor=vec4(texture2D(u_atlas,v_t).rgb,v_a);}`;
// Baking, one picture at a time, drawn into the atlas: each texel adds that picture's
// colour times its weight (per point, see weigh()) where the picture saw it, inside
// its frame with nothing nearer in its depth map, and the weight itself.
const ADD_VERT=`attribute vec2 a_t;attribute vec2 a_uv;attribute float a_dep;attribute float a_w;
varying vec2 v_uv;varying float v_dep;varying float v_w;
void main(){v_uv=a_uv;v_dep=a_dep*.5+.5;v_w=a_w;gl_Position=vec4(a_t*2.-1.,0.,1.);}`;
const ADD_FRAG=`uniform sampler2D u_img;uniform sampler2D u_seen;uniform vec3 u_gain;uniform float u_tol;
varying vec2 v_uv;varying float v_dep;varying float v_w;
float inside(vec2 uv){return step(0.,uv.x)*step(uv.x,1.)*step(0.,uv.y)*step(uv.y,1.);}
void main(){
  vec4 d=texture2D(u_seen,v_uv);
  float w=v_w*inside(v_uv)*step(v_dep-u_tol,d.r+d.g/255.);
  if(w<=0.)discard;
  gl_FragColor=vec4(min(texture2D(u_img,v_uv).rgb*u_gain,1.)*w,w);
}`;
// Then each texel's sum over its weight. Where the pictures that should have given it
// most did not see it after all, the front picture as it is: under the nose and the
// chin, where no picture looks, and under the tip of the nose, where the tracker's
// mesh folds over in the front picture and its depth map hides what the picture shows.
const RESOLVE_VERT=`attribute vec2 a_t;attribute vec2 a_uv;varying vec2 v_uv;
void main(){v_uv=a_uv;gl_Position=vec4(a_t*2.-1.,0.,1.);}`;
const RESOLVE_FRAG=`uniform sampler2D u_sum;uniform sampler2D u_img;uniform float u_size;varying vec2 v_uv;
void main(){
  vec4 s=texture2D(u_sum,gl_FragCoord.xy/u_size);
  vec3 front=texture2D(u_img,v_uv).rgb,col=s.a>1e-4?s.rgb/s.a:front;
  gl_FragColor=vec4(mix(front,col,smoothstep(.3,.85,s.a)),1.);
}`;
// And filled past the face's edge: an empty texel takes the mean of the filled ones
// round it, u_step texels away, so filtering and mipmaps never bring in the black
// around the face.
const FILL_VERT=`attribute vec2 a_q;varying vec2 v_t;void main(){v_t=a_q*.5+.5;gl_Position=vec4(a_q,0.,1.);}`;
const FILL_FRAG=`uniform sampler2D u_src;uniform float u_step;varying vec2 v_t;
void main(){
  vec4 c=texture2D(u_src,v_t);
  if(c.a>.5){gl_FragColor=c;return;}
  vec4 s=vec4(0.);
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec4 n=texture2D(u_src,v_t+vec2(float(x),float(y))*u_step);s+=vec4(n.rgb*n.a,n.a);}
  gl_FragColor=s.a>0.?vec4(s.rgb/s.a,1.):vec4(0.);
}`;

const unit=v=>{const l=Math.hypot(v.x,v.y,v.z)||1;return {x:v.x/l,y:v.y/l,z:v.z/l};};

// The triangles: the face mesh, then the skirt, ring by ring from the outline out.
function baseTriangles(){
  const out=[...WARP_TRIANGLES],n=OVAL.length;
  const ring=(k,j)=>k<0?OVAL[j%n]:MESH+k*n+(j%n);
  for(let k=0;k<RINGS.length;k++)for(let j=0;j<n;j++){
    const a=ring(k-1,j),b=ring(k-1,j+1),c=ring(k,j),d=ring(k,j+1);
    out.push(a,b,c,b,d,c);
  }
  return out;
}
// Each round of subdivision: every edge gets a point (its two ends listed in `edges`,
// numbered on from `from`), every triangle becomes four.
function subdivideTopology(tris,count){
  const index=new Map(),edges=[],out=[];
  const mid=(a,b)=>{
    const key=a<b?a*65536+b:b*65536+a;
    let i=index.get(key);
    if(i===undefined){i=count+edges.length/2;index.set(key,i);edges.push(a,b);}
    return i;
  };
  for(let t=0;t<tris.length;t+=3){
    const a=tris[t],b=tris[t+1],c=tris[t+2],ab=mid(a,b),bc=mid(b,c),ca=mid(c,a);
    out.push(a,ab,ca, ab,b,bc, ca,bc,c, ab,bc,ca);
  }
  return {from:count,edges:Uint16Array.from(edges),tris:out,count:count+edges.length/2};
}
const ROUNDS=[];
{
  let tris=baseTriangles(),count=BASE;
  ROUNDS.push({tris,count});
  for(let l=0;l<LEVELS;l++){const r=subdivideTopology(tris,count);ROUNDS.push(r);tris=r.tris;count=r.count;}
}
const COUNT=ROUNDS[ROUNDS.length-1].count;
// The face's edge, per point of the mesh: how much of it shows (the outline itself not
// at all and the step in partly, so the edge is soft; the chin's outline in full, as
// its line in profile is part of what is simulated), and how near the outline it is
// (1 on it, less by a fifth for each step in across the mesh), for fading what no
// picture saw squarely.
const CHIN=new Set([378,400,377,152,148,176,149]);
const EDGE=(()=>{
  const steps=new Array(MESH).fill(Infinity),next=new Map();
  for(let t=0;t<WARP_TRIANGLES.length;t+=3)for(let k=0;k<3;k++){
    const a=WARP_TRIANGLES[t+k],b=WARP_TRIANGLES[t+(k+1)%3];
    if(!next.has(a))next.set(a,[]);if(!next.has(b))next.set(b,[]);next.get(a).push(b);next.get(b).push(a);
  }
  let ring=[...OVAL];for(const i of ring)steps[i]=0;
  for(let d=1;d<5;d++){const out=[];for(const i of ring)for(const j of next.get(i)||[])if(steps[j]===Infinity){steps[j]=d;out.push(j);}ring=out;}
  return steps.map((d,i)=>({show:CHIN.has(i)?1:d===0?0:d===1?.75:1,near:Math.max(0,1-d/5)}));
})();
const TRIANGLES=new Uint16Array(ROUNDS[ROUNDS.length-1].tris);

// Normals at the points of `pos` (x,y,z triples, the first `count` points), from the
// triangles round each, each turned away from the middle of the head.
function normals(pos,tris,count,out){
  out.fill(0,0,count*3);
  for(let t=0;t<tris.length;t+=3){
    const a=tris[t]*3,b=tris[t+1]*3,c=tris[t+2]*3;
    const ux=pos[b]-pos[a],uy=pos[b+1]-pos[a+1],uz=pos[b+2]-pos[a+2],vx=pos[c]-pos[a],vy=pos[c+1]-pos[a+1],vz=pos[c+2]-pos[a+2];
    let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    if(nx*(pos[a]+pos[b]+pos[c])+ny*(pos[a+1]+pos[b+1]+pos[c+1])+nz*(pos[a+2]+pos[b+2]+pos[c+2])<0){nx=-nx;ny=-ny;nz=-nz;}
    for(const i of [a,b,c]){out[i]+=nx;out[i+1]+=ny;out[i+2]+=nz;}
  }
  for(let i=0;i<count*3;i+=3){const l=Math.hypot(out[i],out[i+1],out[i+2])||1;out[i]/=l;out[i+1]/=l;out[i+2]/=l;}
}
// Two rounds of subdivision on `pos` (the base points filled in, room for the rest),
// each new point on the curved surface the normals describe between an edge's ends
// (Phong tessellation, α = 3/4). `each(i,a,b,ox,oy,oz)` hears of every new point i,
// with its edge's ends and how far it stands off the straight line between them.
const ALPHA=.75;
function subdivide(pos,nrm,each){
  for(let r=1;r<ROUNDS.length;r++){
    const {from,edges}=ROUNDS[r],{tris,count}=ROUNDS[r-1];
    normals(pos,tris,count,nrm);
    for(let e=0;e<edges.length;e+=2){
      const a=edges[e]*3,b=edges[e+1]*3,i=from+e/2;
      const mx=(pos[a]+pos[b])/2,my=(pos[a+1]+pos[b+1])/2,mz=(pos[a+2]+pos[b+2])/2;
      // The midpoint onto each end's tangent plane, and the mean of the two.
      const da=(mx-pos[a])*nrm[a]+(my-pos[a+1])*nrm[a+1]+(mz-pos[a+2])*nrm[a+2];
      const db=(mx-pos[b])*nrm[b]+(my-pos[b+1])*nrm[b+1]+(mz-pos[b+2])*nrm[b+2];
      const ox=-ALPHA*(da*nrm[a]+db*nrm[b])/2,oy=-ALPHA*(da*nrm[a+1]+db*nrm[b+1])/2,oz=-ALPHA*(da*nrm[a+2]+db*nrm[b+2])/2;
      pos[i*3]=mx+ox;pos[i*3+1]=my+oy;pos[i*3+2]=mz+oz;
      each?.(i,edges[e],edges[e+1],ox,oy,oz);
    }
  }
  normals(pos,TRIANGLES,COUNT,nrm);
}
// The face unrolled for the atlas: across, the angle round a vertical axis through
// the middle of the head times the face's mean distance from that axis; down, as it
// is. So the sides, which turn away from the front, keep about the room the front has.
// Into [0,1]² with a margin, the same scale both ways; `span` is the longer side in
// face widths.
function unroll(pos,out){
  let r=0;for(let i=0;i<MESH;i++)r+=Math.hypot(pos[i*3],pos[i*3+2])/MESH;
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(let i=0;i<COUNT;i++){
    const u=Math.atan2(pos[i*3],pos[i*3+2])*r,v=pos[i*3+1];
    out[i*2]=u;out[i*2+1]=v;x0=Math.min(x0,u);x1=Math.max(x1,u);y0=Math.min(y0,v);y1=Math.max(y1,v);
  }
  const span=Math.max(x1-x0,y1-y0)||1,k=(1-2*MARGIN)/span;
  const ox=(1-(x1-x0)*k)/2,oy=(1-(y1-y0)*k)/2;
  for(let i=0;i<COUNT;i++){out[i*2]=ox+(out[i*2]-x0)*k;out[i*2+1]=oy+(out[i*2+1]-y0)*k;}
  return span;
}

// Column-major 4×4 matrices, as WebGL takes them.
function perspective(fov,aspect,near,far){
  const f=1/Math.tan(fov/2),nf=1/(near-far);
  return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
}
function multiply(a,b){
  const o=new Array(16);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}
  return o;
}
// Turned about `pivot` by `yaw` about the vertical, then tilted by `pitch`, `distance`
// from the eye; the model's down (y) made up.
function modelView(yaw,pitch,distance,pivot){
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  // R = Rx(pitch)·Ry(yaw)·diag(1,-1,1), applied to (point − pivot), then moved back.
  const m=[cy,sp*sy,-cp*sy,0, 0,-cp,-sp,0, sy,-sp*cy,cp*cy,0, 0,0,-distance,1];
  for(let r=0;r<3;r++)m[12+r]-=m[r]*pivot.x+m[4+r]*pivot.y+m[8+r]*pivot.z;
  return m;
}
// The vertical field of view that fits a ball of `radius` at `distance`, whatever the
// shape of the picture, with a little room round it.
const fov=(aspect,distance,radius)=>2*Math.asin(Math.min(.99,radius*1.08/distance/Math.min(1,aspect)));

export function createViewer3d(canvas){
  const options={alpha:false,antialias:true,depth:true,preserveDrawingBuffer:true};
  let gl;
  try{gl=canvas.getContext('webgl',options)||canvas.getContext('experimental-webgl',options);}catch{return null;}
  if(!gl)return null;
  let main,seen,add,resolve,fill;
  try{
    const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    const link=(v,f)=>{const p=gl.createProgram();gl.attachShader(p,compile(gl.VERTEX_SHADER,v));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,PRECISION+f));
      gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
      const a=n=>gl.getAttribLocation(p,n),u=n=>gl.getUniformLocation(p,n);return {p,a,u};};
    main=link(VERT,FRAG);seen=link(SEEN_VERT,SEEN_FRAG);add=link(ADD_VERT,ADD_FRAG);
    resolve=link(RESOLVE_VERT,RESOLVE_FRAG);fill=link(FILL_VERT,FILL_FRAG);
  }catch{return null;}

  const buffer=(data,target=gl.ARRAY_BUFFER)=>{const b=gl.createBuffer();gl.bindBuffer(target,b);gl.bufferData(target,data,gl.STATIC_DRAW);return b;};
  const index=buffer(TRIANGLES,gl.ELEMENT_ARRAY_BUFFER);
  const before=new Float32Array(COUNT*3), after=new Float32Array(COUNT*3), nrm=new Float32Array(COUNT*3), scratch=new Float32Array(COUNT*3);
  const off=new Float32Array(COUNT*3), edge=new Float32Array(COUNT*2), atlasAt=new Float32Array(COUNT*2), shows=new Float32Array(COUNT);
  // The atlas and what shows are the model's; uv, dep and w are one picture's at a
  // time, while baking.
  const buf={before:buffer(before),after:buffer(after),t:buffer(atlasAt),a:buffer(shows),
    uv:buffer(new Float32Array(COUNT*2)),dep:buffer(new Float32Array(COUNT)),w:buffer(new Float32Array(COUNT)),
    quad:buffer(new Float32Array([-1,-1,1,-1,-1,1,1,1]))};
  const texture=(filter=gl.LINEAR)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    for(const [k,v] of [[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_MIN_FILTER,filter],[gl.TEXTURE_MAG_FILTER,filter]])gl.texParameteri(gl.TEXTURE_2D,k,v);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));return t;};
  const picture=texture();
  const seenMap={tex:texture(gl.NEAREST),fbo:gl.createFramebuffer(),rb:gl.createRenderbuffer(),w:0,h:0};
  const fbo=gl.createFramebuffer();
  let atlas=texture();
  const anisotropy=gl.getExtension('EXT_texture_filter_anisotropic')||gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  const sumTypes=(()=>{
    // What the sums are kept in while baking: half floats or floats where the GPU can
    // draw into them and blend them, else bytes, which are enough, as the weights at a
    // point add up to one.
    const out=[],half=gl.getExtension('OES_texture_half_float');
    if(half&&gl.getExtension('EXT_color_buffer_half_float'))out.push(half.HALF_FLOAT_OES);
    if(gl.getExtension('OES_texture_float')&&gl.getExtension('WEBGL_color_buffer_float')&&gl.getExtension('EXT_float_blend'))out.push(gl.FLOAT);
    out.push(gl.UNSIGNED_BYTE);
    return out;
  })();

  let model=null;            // what build() worked out from the pictures
  let maxYaw=LIMITS.yaw;
  let state={mode:'after',yaw:0,pitch:0};
  let spin=0,spinStart=0,raf=0,disposed=false,ready=false;

  function set(buffer,data){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);}
  function attrib(loc,buffer,size){if(loc<0)return;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);}
  function detach(){for(let k=0;k<8;k++)gl.disableVertexAttribArray(k);}

  // From the pictures: views[0] front-on, then any number at other angles; each
  // {image (a canvas: the face cut out of the frame), crop {x,y,w,h} (where the image
  // was in the frame, in its pixels), landmarks (as the tracker gives them for the
  // whole frame), width, height (the frame's)}.
  function build(views){
    const Ps=views.map(v=>points3(v.landmarks,v.width,v.height));
    const {X,poses}=fuse(Ps);
    // The shape, in the front picture's frame, with that picture's irises (no part of
    // the mesh).
    const P=X.concat(Ps[0].slice(MESH));
    const f=headFrame(P);
    const toLocal=p=>{const d={x:p.x-f.center.x,y:p.y-f.center.y,z:p.z-f.center.z};
      return {x:(d.x*f.ex.x+d.y*f.ex.y+d.z*f.ex.z)/f.face,y:(d.x*f.ey.x+d.y*f.ey.y+d.z*f.ey.z)/f.face,z:(d.x*f.ez.x+d.y*f.ez.y+d.z*f.ez.z)/f.face};};
    const L=new Array(BASE);
    for(let i=0;i<MESH;i++)L[i]=toLocal(P[i]);
    // The rim. The head round the face is taken as an ellipsoid as wide as the outline,
    // a quarter higher than it is above its middle, and 0.6 of a face width deep; the
    // rim carries the outline a little way round it, towards the back. Below the chin
    // it runs a little way down the neck instead.
    let cx=0,cy=0,wide=0,top=Infinity;
    for(const i of OVAL){cx+=L[i].x/OVAL.length;cy+=L[i].y/OVAL.length;}
    for(const i of OVAL){wide=Math.max(wide,Math.abs(L[i].x-cx));top=Math.min(top,L[i].y);}
    const C={x:cx,y:cy,z:-.05},R={x:wide*1.05,y:(cy-top)*1.25,z:.6};
    const n=OVAL.length;
    RINGS.forEach((ring,k)=>OVAL.forEach((b,j)=>{
      const q=L[b];
      let u={x:(q.x-C.x)/R.x,y:(q.y-C.y)/R.y,z:(q.z-C.z)/R.z};
      const r=Math.hypot(u.x,u.y,u.z)||1;u={x:u.x/r,y:u.y/r,z:u.z/r};
      // Along the ellipsoid towards the back of the head.
      const t=unit({x:u.z*u.x,y:u.z*u.y,z:u.z*u.z-1}),cs=Math.cos(ring.turn),sn=Math.sin(ring.turn);
      const v={x:u.x*cs+t.x*sn,y:u.y*cs+t.y*sn,z:u.z*cs+t.z*sn};
      const round={x:C.x+R.x*v.x*r,y:C.y+R.y*v.y*r,z:C.z+R.z*v.z*r};
      const down={x:q.x,y:q.y+ring.neck,z:q.z-ring.neck*.3};
      const dx=q.x-cx,dy=q.y-cy,l=Math.hypot(dx,dy)||1,s=Math.max(0,Math.min(1,(dy/l-.3)/.5)),m=s*s*(3-2*s);
      L[MESH+k*n+j]={x:round.x+(down.x-round.x)*m,y:round.y+(down.y-round.y)*m,z:round.z+(down.z-round.z)*m};
    }));
    for(let i=0;i<BASE;i++){before[i*3]=L[i].x;before[i*3+1]=L[i].y;before[i*3+2]=L[i].z;}
    for(let i=0;i<BASE;i++){edge[i*2]=i<MESH?EDGE[i].show:0;edge[i*2+1]=i<MESH?EDGE[i].near:1;}
    // Subdivided, keeping how far each new point stands off its edge, to place it in
    // each picture.
    subdivide(before,nrm,(i,a,b,ox,oy,oz)=>{
      off[i*3]=ox;off[i*3+1]=oy;off[i*3+2]=oz;
      edge[i*2]=(edge[a*2]+edge[b*2])/2;edge[i*2+1]=(edge[a*2+1]+edge[b*2+1])/2;
    });
    const span=unroll(before,atlasAt);
    const base=i=>i<MESH?i:OVAL[(i-MESH)%n];
    const seenBy=views.map((v,s)=>project(v,Ps[s],poses[s],f,L,base));
    const W=weigh(seenBy);
    set(buf.t,atlasAt);set(buf.a,shows);set(buf.before,before);
    // About three texels for every pixel of the front picture's face: drawn from the
    // pictures into the atlas and from the atlas onto the screen, the face is
    // resampled twice, and with fewer texels the second one shows as a blur.
    const v0=views[0],perFace=poses[0].s*f.face*v0.image.width/v0.crop.w;
    const limit=Math.min(ATLAS_MAX,gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    let size=ATLAS_MIN;while(size<limit&&size<perFace*3*span/(1-2*MARGIN))size*=2;
    const gains=colourGains(views,seenBy,W);
    const sums=bake(views,seenBy,W,gains,Math.min(size,limit));
    // The face turns about its own middle, and is framed to the ball round it.
    let lo={x:Infinity,y:Infinity,z:Infinity},hi={x:-Infinity,y:-Infinity,z:-Infinity};
    for(let i=0;i<MESH;i++){const q=L[i];lo={x:Math.min(lo.x,q.x),y:Math.min(lo.y,q.y),z:Math.min(lo.z,q.z)};hi={x:Math.max(hi.x,q.x),y:Math.max(hi.y,q.y),z:Math.max(hi.z,q.z)};}
    const pivot={x:(lo.x+hi.x)/2,y:(lo.y+hi.y)/2,z:(lo.z+hi.z)/2};
    let radius=0;for(let i=0;i<COUNT;i++)radius=Math.max(radius,Math.hypot(before[i*3]-pivot.x,before[i*3+1]-pivot.y,before[i*3+2]-pivot.z));
    model={P,f,L,n,views:views.length,pivot,radius,gains,size:Math.min(size,limit),sums,
      landmarks:P.map(q=>({x:q.x/v0.width,y:q.y/v0.height,z:q.z/v0.width}))};
    after.set(before);set(buf.after,after);
    maxYaw=views.length>1?LIMITS.yaw:ONE_PICTURE_YAW;
    ready=true;
    draw();
  }

  // The model's points in one picture (as fractions of its image) and how deep: the
  // landmarks where that picture has them, and the points between them where the
  // smoothed surface puts them as the head's frame lies in that picture. And which way
  // that picture's camera is, in the head's frame.
  function project(v,Pv,pose,f,L,base){
    const k=pose.s*f.face,c=v.crop;
    // Each axis of the head's frame as it lies in the picture, in its pixels per unit.
    const ax=[f.ex,f.ey,f.ez].map(e=>{const r=apply(pose.R,e);return {x:r.x*k,y:r.y*k,z:r.z*k};});
    const o=place(pose,f.center);
    const deep=z=>Math.max(-.99,Math.min(.99,z));
    const uv=new Float32Array(COUNT*2),dep=new Float32Array(COUNT);
    for(let i=0;i<BASE;i++){
      const b=base(i),pb=Pv[b],q=L[i],ob=L[b],dx=q.x-ob.x,dy=q.y-ob.y,dz=q.z-ob.z;
      // The landmark itself, or the skirt carried by its outline point.
      const p={x:pb.x+dx*ax[0].x+dy*ax[1].x+dz*ax[2].x,y:pb.y+dx*ax[0].y+dy*ax[1].y+dz*ax[2].y,z:pb.z+dx*ax[0].z+dy*ax[1].z+dz*ax[2].z};
      uv[i*2]=(p.x-c.x)/c.w;uv[i*2+1]=(p.y-c.y)/c.h;dep[i]=deep((p.z-o.z)/(k*2));
    }
    for(let r=1;r<ROUNDS.length;r++){
      const {from,edges}=ROUNDS[r];
      for(let e=0;e<edges.length;e+=2){
        const a=edges[e],b=edges[e+1],i=from+e/2,ox=off[i*3],oy=off[i*3+1],oz=off[i*3+2];
        uv[i*2]=(uv[a*2]+uv[b*2])/2+(ox*ax[0].x+oy*ax[1].x+oz*ax[2].x)/c.w;
        uv[i*2+1]=(uv[a*2+1]+uv[b*2+1])/2+(ox*ax[0].y+oy*ax[1].y+oz*ax[2].y)/c.h;
        dep[i]=deep((dep[a]+dep[b])/2+(ox*ax[0].z+oy*ax[1].z+oz*ax[2].z)/(k*2));
      }
    }
    // Image z grows away from the camera.
    return {uv,dep,toward:unit({x:-ax[0].z,y:-ax[1].z,z:-ax[2].z})};
  }

  // Each picture's weight at each point of the model: how squarely it saw the point
  // (its normal against the way to that camera) against the picture that saw it most
  // squarely, so only the few that faced it count; then shared out so the weights at
  // a point add up to one, and handed to the front picture where it saw the point
  // squarely enough (FRONT). Where a picture's depth map shows the point hidden, its
  // texels get nothing, and the atlas divides the sum by what is left. Also how much
  // of each point shows: the face's edge fades, and near it, what no picture saw
  // squarely enough to give more than a stretched smear (by the ear and down the jaw,
  // with only a front picture); never inside the face, where under the nose and
  // between the lips no picture sees squarely either.
  function weigh(seenBy){
    const W=seenBy.map(()=>new Float32Array(COUNT)),c=new Float32Array(seenBy.length);
    for(let i=0;i<COUNT;i++){
      const nx=nrm[i*3],ny=nrm[i*3+1],nz=nrm[i*3+2];
      let best=-1;
      seenBy.forEach(({uv,toward},s)=>{
        const u=uv[i*2],t=uv[i*2+1];
        c[s]=u>=0&&u<=1&&t>=0&&t<=1?nx*toward.x+ny*toward.y+nz*toward.z:-1;
        if(c[s]>.05)best=Math.max(best,c[s]);
      });
      let sum=0;
      for(let s=0;s<seenBy.length;s++){const w=c[s]>.05?Math.exp(SHARP*(c[s]-best)):0;W[s][i]=w;sum+=w;}
      const f=Math.max(0,Math.min(1,(c[0]-FRONT[0])/(FRONT[1]-FRONT[0]))),front=f*f*(3-2*f);
      if(sum>0)for(let s=0;s<seenBy.length;s++)W[s][i]=W[s][i]/sum*(1-front)+(s?0:front);
      const k=Math.max(0,Math.min(1,(best-.2)/.3)),squarely=k*k*(3-2*k);
      shows[i]=edge[i*2]*(1+(squarely-1)*edge[i*2+1]);
    }
    return W;
  }

  // Every picture brought to one colour, since the camera's exposure and white balance
  // change as the head turns: per picture and channel, the gain that best matches its
  // colours at the landmarks it saw squarely to what all the pictures together make of
  // them. A few rounds, then the front picture keeps its own colour and the rest
  // follow it. Clamped, so a bad match does little harm.
  function colourGains(views,seenBy,W){
    const gains=views.map(()=>[1,1,1]);
    if(views.length<2)return gains;
    const samples=views.map((v,s)=>{
      const k=Math.min(1,200/Math.max(v.image.width,v.image.height)),c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(v.image.width*k));c.height=Math.max(1,Math.round(v.image.height*k));
      const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(v.image,0,0,c.width,c.height);
      const d=x.getImageData(0,0,c.width,c.height).data,{uv,toward}=seenBy[s],out=new Array(MESH).fill(null);
      for(let i=0;i<MESH;i++){
        if(nrm[i*3]*toward.x+nrm[i*3+1]*toward.y+nrm[i*3+2]*toward.z<.7)continue;
        const u=Math.round(uv[i*2]*c.width),t=Math.round(uv[i*2+1]*c.height);
        if(u<2||t<2||u>c.width-3||t>c.height-3)continue;
        const m=[0,0,0];
        for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){const p=((t+y)*c.width+u+z)*4;m[0]+=d[p];m[1]+=d[p+1];m[2]+=d[p+2];}
        out[i]=m;
      }
      return out;
    });
    for(let round=0;round<3;round++){
      const ref=new Array(MESH).fill(null);
      for(let i=0;i<MESH;i++){
        const m=[0,0,0];let total=0;
        samples.forEach((sm,s)=>{const w=W[s][i];if(!sm[i]||!w)return;for(let k=0;k<3;k++)m[k]+=w*gains[s][k]*sm[i][k];total+=w;});
        if(total>0)ref[i]=m.map(v=>v/total);
      }
      samples.forEach((sm,s)=>{
        const a=[0,0,0],b=[0,0,0];let count=0;
        for(let i=0;i<MESH;i++){if(!sm[i]||!ref[i])continue;for(let k=0;k<3;k++){a[k]+=ref[i][k];b[k]+=sm[i][k];}count++;}
        if(count>=20)gains[s]=a.map((v,k)=>Math.max(.6,Math.min(1.6,v/(b[k]||1))));
      });
    }
    const front=gains[0];
    return gains.map(g=>g.map((v,k)=>Math.max(.7,Math.min(1.4,v/front[k]))));
  }

  // One picture's depth map: the model as that picture saw it (its points in buf.uv
  // and buf.dep), nearest surface kept, at the size of its image or 1024 at most.
  function drawSeen(image){
    const k=Math.min(1,1024/Math.max(image.width,image.height)),t=seenMap;
    const w=Math.max(1,Math.round(image.width*k)),h=Math.max(1,Math.round(image.height*k));
    if(w!==t.w||h!==t.h){
      t.w=w;t.h=h;
      gl.bindTexture(gl.TEXTURE_2D,t.tex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindRenderbuffer(gl.RENDERBUFFER,t.rb);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,w,h);
      gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t.tex,0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,t.rb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);
    gl.viewport(0,0,w,h);gl.disable(gl.BLEND);
    gl.clearColor(1,1,1,1);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(seen.p);
    attrib(seen.a('a_uv'),buf.uv,2);attrib(seen.a('a_src'),buf.dep,1);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LESS);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.drawElements(gl.TRIANGLES,TRIANGLES.length,gl.UNSIGNED_SHORT,0);
    gl.disable(gl.DEPTH_TEST);detach();
  }

  // The atlas, `size` texels square: every picture added in (the front one last, so
  // its picture is still there for what nothing else saw), each texel divided by its
  // weight, filled past the face's edge, and mipmapped.
  function bake(views,seenBy,W,gains,size){
    for(const type of sumTypes)if(bakeWith(type,views,seenBy,W,gains,size))
      return type===gl.FLOAT?'float':type===gl.UNSIGNED_BYTE?'bytes':'half float';
    return 'none';
  }
  function bakeWith(type,views,seenBy,W,gains,size){
    const sum=texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,type,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,sum,0);
    const give=()=>{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteTexture(sum);return false;};
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)return give();
    gl.viewport(0,0,size,size);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.getError();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);
    for(let s=views.length-1;s>=0;s--){
      const v=views[s];
      gl.bindTexture(gl.TEXTURE_2D,picture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v.image);
      set(buf.uv,seenBy[s].uv);set(buf.dep,seenBy[s].dep);set(buf.w,W[s]);
      drawSeen(v.image);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.viewport(0,0,size,size);
      gl.useProgram(add.p);
      attrib(add.a('a_t'),buf.t,2);attrib(add.a('a_uv'),buf.uv,2);attrib(add.a('a_dep'),buf.dep,1);attrib(add.a('a_w'),buf.w,1);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,picture);gl.uniform1i(add.u('u_img'),0);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,seenMap.tex);gl.uniform1i(add.u('u_seen'),1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3fv(add.u('u_gain'),gains[s]);gl.uniform1f(add.u('u_tol'),.006);
      gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
      gl.drawElements(gl.TRIANGLES,TRIANGLES.length,gl.UNSIGNED_SHORT,0);
      gl.disable(gl.BLEND);detach();
      // A GPU that takes these sums but cannot blend them says so on the first draw.
      if(s===views.length-1&&gl.getError()!==gl.NO_ERROR)return give();
    }
    // Divided out, into the atlas (the front picture's points are still in buf.uv).
    const next=texture(gl.NEAREST),spare=texture(gl.NEAREST);
    for(const t of [next,spare]){gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,next,0);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(resolve.p);
    attrib(resolve.a('a_t'),buf.t,2);attrib(resolve.a('a_uv'),buf.uv,2);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,sum);gl.uniform1i(resolve.u('u_sum'),0);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,picture);gl.uniform1i(resolve.u('u_img'),1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(resolve.u('u_size'),size);
    gl.drawElements(gl.TRIANGLES,TRIANGLES.length,gl.UNSIGNED_SHORT,0);
    detach();
    // Filled outwards 1, 2, 4… 32 texels a step, back and forth between two textures,
    // ending where it began.
    gl.useProgram(fill.p);
    attrib(fill.a('a_q'),buf.quad,2);
    gl.uniform1i(fill.u('u_src'),0);
    let from=next,to=spare;
    for(let step=1;step<=32;step*=2){
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,to,0);
      gl.bindTexture(gl.TEXTURE_2D,from);gl.uniform1f(fill.u('u_step'),step/size);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      [from,to]=[to,from];
    }
    detach();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.deleteTexture(sum);gl.deleteTexture(to);gl.deleteTexture(atlas);
    atlas=from;
    gl.bindTexture(gl.TEXTURE_2D,atlas);gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    if(anisotropy)gl.texParameterf(gl.TEXTURE_2D,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    // The last picture is not needed any more.
    gl.bindTexture(gl.TEXTURE_2D,picture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
    return true;
  }

  function render(mode,yaw,pitch,width,height){
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,width,height);
    gl.clearColor(.078,.047,.067,1);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(!model)return;
    gl.useProgram(main.p);
    const deg=Math.PI/180,aspect=width/height;
    const mvp=multiply(perspective(fov(aspect,4.4,model.radius),aspect,.5,20),modelView(yaw*deg,pitch*deg,4.4,model.pivot));
    gl.uniformMatrix4fv(main.u('u_mvp'),false,new Float32Array(mvp));
    attrib(main.a('a_pos'),mode==='before'?buf.before:buf.after,3);
    attrib(main.a('a_t'),buf.t,2);attrib(main.a('a_a'),buf.a,1);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,atlas);gl.uniform1i(main.u('u_atlas'),0);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.drawElements(gl.TRIANGLES,TRIANGLES.length,gl.UNSIGNED_SHORT,0);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);
    detach();
  }
  function fitCanvas(){
    const r=Math.min(2,window.devicePixelRatio||1);
    const w=Math.max(1,Math.round(canvas.clientWidth*r)),h=Math.max(1,Math.round(canvas.clientHeight*r));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  }
  function draw(){
    if(disposed||gl.isContextLost())return;
    fitCanvas();
    render(state.mode,state.yaw,state.pitch,canvas.width,canvas.height);
  }

  // Turning by hand: the canvas is mirrored on screen like the live picture, so a drag
  // to the right turns the face to the right as seen.
  let drag=null;
  canvas.addEventListener('pointerdown',e=>{
    if(!ready)return;
    drag={x:e.clientX,y:e.clientY,yaw:state.yaw,pitch:state.pitch};stopSpin();
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drag)return;
    const k=180/Math.max(240,canvas.clientWidth);
    turn(drag.yaw-(e.clientX-drag.x)*k,drag.pitch+(e.clientY-drag.y)*k);
  });
  const end=()=>{drag=null;};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('dblclick',()=>{stopSpin();animateTo(0,0);});
  window.addEventListener('resize',()=>{if(ready&&canvas.clientWidth)draw();});

  function turn(yaw,pitch){
    state.yaw=Math.max(-maxYaw,Math.min(maxYaw,yaw));
    state.pitch=Math.max(-LIMITS.pitch,Math.min(LIMITS.pitch,pitch));
    draw();onTurn?.(state);
  }
  // A smooth turn to an angle, for the presets.
  function animateTo(yaw,pitch=0){
    cancelAnimationFrame(raf);
    const from={yaw:state.yaw,pitch:state.pitch},t0=performance.now();
    const step=now=>{
      const t=Math.min(1,(now-t0)/450),e=t*t*(3-2*t);
      turn(from.yaw+(yaw-from.yaw)*e,from.pitch+(pitch-from.pitch)*e);
      if(t<1)raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
  }
  // Turning slowly from one side to the other and back, for showing the patient.
  function startSpin(){
    cancelAnimationFrame(raf);spin=1;spinStart=performance.now();
    const amp=Math.min(55,maxYaw-5),phase=Math.asin(Math.max(-1,Math.min(1,state.yaw/amp)));
    const step=now=>{
      if(!spin)return;
      turn(amp*Math.sin(phase+(now-spinStart)/1000*.9),state.pitch*.96);
      raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
  }
  function stopSpin(){if(spin){spin=0;cancelAnimationFrame(raf);onSpin?.(false);}}
  let onTurn=null,onSpin=null;

  return {
    build,draw,animateTo,
    get state(){return {...state};},
    get views(){return model?.views||0;},
    // The model's landmarks, as the tracker would give them for the front picture's
    // frame: the shape solved for over every picture, for measuring.
    get landmarks(){return model?.landmarks||null;},
    // What the model was made with, for the debug export: pictures, the atlas's size and
    // what its sums were kept in, and each picture's colour gains.
    get info(){return model?{views:model.views,atlas:model.size,sums:model.sums,gains:model.gains.map(g=>g.map(v=>+v.toFixed(3)))}:null;},
    get spinning(){return !!spin;},
    setMode(mode){state.mode=mode;draw();},
    spin(on){if(on){startSpin();onSpin?.(true);}else stopSpin();},
    on(handlers){onTurn=handlers.turn||null;onSpin=handlers.spin||null;},
    // A picture of the model at the current angle, `mode` before or after, in a
    // canvas of its own, as the WebGL canvas has it (not mirrored).
    picture(mode,width,height){
      const keep=[canvas.width,canvas.height];
      canvas.width=width;canvas.height=height;
      render(mode,state.yaw,state.pitch,width,height);
      const c=document.createElement('canvas');c.width=width;c.height=height;
      c.getContext('2d').drawImage(canvas,0,0);
      [canvas.width,canvas.height]=keep;
      draw();
      return c;
    },
    clear(){model=null;ready=false;stopSpin();gl.deleteTexture(atlas);atlas=texture();draw();},
    dispose(){
      if(disposed)return;disposed=true;stopSpin();cancelAnimationFrame(raf);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
