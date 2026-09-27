// The mirror's renderer. The camera frame becomes a GPU texture and stays there: each
// makeup layer is a full-frame pass that recolours it under that layer's mask, and the
// result is carried through a grid mesh displaced by deform.js for the procedures.
// The frame is never read back, sent or stored.
//
// With no layers and an all-zero displacement field the output is a pixel-exact copy
// of the camera frame.
import {deformers,displace} from './deform.js?v=13';

const COLS=64, ROWS=48;          // resolves the smallest anchor radius
const GRID=(COLS+1)*(ROWS+1);
const LANDMARKS=468;

const MESH_VERT=`attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;
void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.,1.);}`;
// A grade of (1,1,1) multiplies by exactly one, so the plain view stays exact.
const OUT_FRAG=`precision mediump float;uniform sampler2D u_tex;uniform vec3 u_grade;varying vec2 v_uv;
void main(){vec4 c=texture2D(u_tex,v_uv);gl_FragColor=vec4(c.rgb*u_grade,c.a);}`;

// Full-frame passes map texture space onto itself, so every intermediate texture has
// the camera texture's orientation and all of them are sampled at the same v_uv.
const QUAD_VERT=`attribute vec2 a_pos;varying vec2 v_uv;
void main(){v_uv=a_pos*.5+.5;gl_Position=vec4(a_pos,0.,1.);}`;

// 4 bilinear taps over a 4×4 block: a box filter for the local-mean pyramid.
const DOWN_FRAG=`precision mediump float;uniform sampler2D u_tex;uniform vec2 u_step;varying vec2 v_uv;
void main(){
  gl_FragColor=.25*(texture2D(u_tex,v_uv+u_step*vec2(-1.,-1.))+texture2D(u_tex,v_uv+u_step*vec2(1.,-1.))
                  +texture2D(u_tex,v_uv+u_step*vec2(-1.,1.))+texture2D(u_tex,v_uv+u_step*vec2(1.,1.)));
}`;

// One texel per layer: the mean colour of the frame under the layer's mask (from the
// low-resolution copy), and in alpha the brightness of the cheeks and forehead, which
// stands in for how much light is on the face.
const STATS_FRAG=`precision mediump float;
uniform sampler2D u_low;uniform sampler2D u_mask;uniform vec4 u_box;uniform vec4 u_probeA;uniform vec4 u_probeB;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
void main(){
  vec3 sum=vec3(0.);float w=0.;
  for(int j=0;j<6;j++)for(int i=0;i<6;i++){
    vec2 uv=mix(u_box.xy,u_box.zw,vec2((float(i)+.5)/6.,(float(j)+.5)/6.));
    float m=texture2D(u_mask,uv).a;
    sum+=texture2D(u_low,uv).rgb*m;w+=m;
  }
  vec3 mean=w>.05?sum/w:texture2D(u_low,(u_box.xy+u_box.zw)*.5).rgb;
  float face=.25*(luma(texture2D(u_low,u_probeA.xy).rgb)+luma(texture2D(u_low,u_probeA.zw).rgb)
                 +luma(texture2D(u_low,u_probeB.xy).rgb)+luma(texture2D(u_low,u_probeB.zw).rgb));
  gl_FragColor=vec4(mean,face);
}`;

// How a colour meets the skin. The colour is scaled to the light on the face, then
// modulated by how bright each pixel is relative to the region's mean, so lip creases,
// the shadow under the lower lip and the texture of the skin all show through the
// colour, as they do with real product. Finish then decides how the glints behave:
// matte flattens them, gloss sharpens them, shimmer scatters specks.
const LAYER_FRAG=`precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_src;uniform sampler2D u_low;uniform sampler2D u_mask;uniform sampler2D u_stats;
uniform vec3 u_color;uniform float u_amount;uniform float u_mode;
uniform float u_detail;uniform float u_gloss;uniform float u_matte;uniform float u_shimmer;
uniform float u_smooth;uniform float u_bright;uniform vec2 u_texel;uniform float u_radius;uniform float u_time;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 smoothed(vec3 c0){
  vec3 sum=c0;float wsum=1.;
  for(int i=0;i<16;i++){
    float fi=float(i),a=fi*2.39996,r=sqrt((fi+.5)/16.)*u_radius;
    vec3 c=texture2D(u_src,v_uv+vec2(cos(a),sin(a))*r*u_texel).rgb;
    vec3 d=c-c0;float w=exp(-dot(d,d)*90.);
    sum+=c*w;wsum+=w;
  }
  return sum/wsum;
}
void main(){
  vec4 src=texture2D(u_src,v_uv);
  float cover=texture2D(u_mask,v_uv).a;
  if(cover<=0.){gl_FragColor=src;return;}
  vec3 base=src.rgb;
  vec4 stats=texture2D(u_stats,vec2(.5));
  float Y=luma(base);
  float Yl=max(luma(texture2D(u_low,v_uv).rgb),.03);
  float Yr=max(luma(stats.rgb),.03);
  float light=clamp(mix(1.,stats.a/.58,.5),.72,1.12);
  float shade=clamp(Y/Yr,0.,2.5);
  float glint=max(Y-Yl,0.);
  vec3 col=u_color*light;
  float m=cover*u_amount;
  vec3 outc=base;
  if(u_mode<.5){
    float s=shade>1.?1.+(shade-1.)*(1.-.8*u_matte):shade;
    outc=mix(base,col*mix(1.,s,u_detail),m);
  }else if(u_mode<1.5){
    float mx=max(max(u_color.r,u_color.g),max(u_color.b,.001));
    outc=mix(base,base*(u_color/mx),m);
  }else if(u_mode<2.5){
    outc=mix(base,base*(u_color/max(luma(u_color),.05))*.78,m);
  }else if(u_mode<3.5){
    vec3 g=col*(.45+.55*smoothstep(.9,1.25,shade));
    outc=mix(base,1.-(1.-base)*(1.-g*.85),m);
  }else{
    // Skin only: a pixel far darker or brighter than the region (hair, a fringe,
    // a nostril) is left mostly alone.
    float away=abs(Y-Yr)/Yr;
    float skin=clamp(1.-(away-.3)*1.6,0.,1.);
    vec3 even=mix(base,smoothed(base),clamp(u_smooth*cover*skin,0.,1.));
    if(u_mode<4.5){
      float s=clamp(luma(even)/Yr,0.,2.);
      s=s>1.?1.+(s-1.)*(1.-.7*u_matte):s;
      outc=mix(even,col*mix(1.,s,u_detail),m*skin);
    }else{
      outc=even*(1.+.24*u_bright*cover*skin);
      outc.b*=1.-.05*u_bright*cover*skin;
    }
  }
  outc+=u_gloss*cover*(smoothstep(.012,.18,glint)*.55*light+.045*shade);
  if(u_shimmer>0.){
    float n=hash(floor(gl_FragCoord.xy/1.5)+floor(u_time*5.));
    outc+=u_shimmer*(step(.982,n)*.38*cover*cover+smoothstep(.95,1.3,shade)*.14*cover)*mix(vec3(1.),u_color*1.2,.45);
  }
  gl_FragColor=vec4(clamp(outc,0.,1.),1.);
}`;

export const layerModes={pigment:0,tint:1,shade:2,glow:3,foundation:4,smooth:5};

export function createStage(canvas) {
  let gl;
  const options={alpha:false,antialias:false,depth:false,preserveDrawingBuffer:true};
  try{gl=canvas.getContext('webgl',options)||canvas.getContext('experimental-webgl',options);}
  catch{return null;}
  if(!gl) return null;

  let programs;
  try{
    const compile=(type,source)=>{
      const shader=gl.createShader(type);
      gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const link=(vert,frag)=>{
      const program=gl.createProgram();
      gl.attachShader(program,compile(gl.VERTEX_SHADER,vert));
      gl.attachShader(program,compile(gl.FRAGMENT_SHADER,frag));
      gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
      const uniforms={};
      const count=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);
      for(let i=0;i<count;i++){const info=gl.getActiveUniform(program,i);uniforms[info.name]=gl.getUniformLocation(program,info.name);}
      return {program,uniforms,pos:gl.getAttribLocation(program,'a_pos'),uv:gl.getAttribLocation(program,'a_uv')};
    };
    programs={out:link(MESH_VERT,OUT_FRAG),down:link(QUAD_VERT,DOWN_FRAG),
      stats:link(QUAD_VERT,STATS_FRAG),layer:link(QUAD_VERT,LAYER_FRAG)};
  }catch{return null;}

  /* ---- geometry ---- */
  const positions=new Float32Array(GRID*2), uv=new Float32Array(GRID*2);
  const indices=new Uint16Array(COLS*ROWS*6);
  for(let r=0,v=0;r<=ROWS;r++)for(let c=0;c<=COLS;c++,v+=2){uv[v]=c/COLS;uv[v+1]=r/ROWS;}
  for(let r=0,i=0;r<ROWS;r++)for(let c=0;c<COLS;c++){
    const a=r*(COLS+1)+c,b=a+1,d=a+COLS+1,e=d+1;
    indices[i++]=a;indices[i++]=b;indices[i++]=d;
    indices[i++]=b;indices[i++]=e;indices[i++]=d;
  }
  const posBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,posBuffer);gl.bufferData(gl.ARRAY_BUFFER,positions,gl.DYNAMIC_DRAW);
  const uvBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer);gl.bufferData(gl.ARRAY_BUFFER,uv,gl.STATIC_DRAW);
  const indexBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
  const quadBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,quadBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);

  /* ---- textures and targets ---- */
  // Nothing here is power-of-two, so clamp and skip mipmaps.
  function makeTexture(w,h,filter=gl.LINEAR){
    const t=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    if(w)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    return t;
  }
  function makeTarget(w,h,filter){
    const tex=makeTexture(w,h,filter),fbo=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return {tex,fbo,w,h};
  }
  function dropTarget(t){if(t){gl.deleteFramebuffer(t.fbo);gl.deleteTexture(t.tex);}}

  const camera=makeTexture(0,0);
  const masks=new Map();                          // key -> {tex, box}
  let targets=null, size={w:0,h:0};
  const stats=makeTarget(1,1,gl.NEAREST);
  function ensureTargets(w,h){
    if(targets&&size.w===w&&size.h===h)return;
    if(targets)Object.values(targets).flat().forEach(dropTarget);
    targets={
      a:[makeTarget(w,h),makeTarget(w,h)],b:[makeTarget(w,h),makeTarget(w,h)],
      low1:makeTarget(Math.max(1,Math.round(w/4)),Math.max(1,Math.round(h/4))),
      low2:makeTarget(Math.max(1,Math.round(w/8)),Math.max(1,Math.round(h/8)))
    };
    size={w,h};
  }

  let disposed=false, uploadedVersion=-1;

  function useQuad(p){
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER,quadBuffer);
    gl.enableVertexAttribArray(p.pos);gl.vertexAttribPointer(p.pos,2,gl.FLOAT,false,0,0);
  }
  function bindTex(unit,tex,uniform){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(uniform,unit);}

  function buildLow(){
    const p=programs.down;useQuad(p);
    const {low1,low2}=targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER,low1.fbo);gl.viewport(0,0,low1.w,low1.h);
    bindTex(0,camera,p.uniforms.u_tex);gl.uniform2f(p.uniforms.u_step,1/size.w,1/size.h);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,low2.fbo);gl.viewport(0,0,low2.w,low2.h);
    bindTex(0,low1.tex,p.uniforms.u_tex);gl.uniform2f(p.uniforms.u_step,.5/low1.w,.5/low1.h);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }

  // A layer only changes pixels inside its mask's box, so each pass is scissored to
  // it. The ping-pong target still holds the composite from two passes back, which
  // differs from this pass's input only inside the previous layer's box: covering
  // that box as well (where the shader copies its input) brings the whole target up
  // to date. The first two passes write a target that holds last frame's pixels, so
  // they cover everything.
  const FULL={x:0,y:0,w:1,h:1};
  function scissorTo(a,b){
    let x0=a.x,y0=a.y,x1=a.x+a.w,y1=a.y+a.h;
    if(b){x0=Math.min(x0,b.x);y0=Math.min(y0,b.y);x1=Math.max(x1,b.x+b.w);y1=Math.max(y1,b.y+b.h);}
    const X=Math.max(0,Math.floor(x0*size.w)-1),Y=Math.max(0,Math.floor(y0*size.h)-1);
    gl.scissor(X,Y,Math.min(size.w,Math.ceil(x1*size.w)+1)-X,Math.min(size.h,Math.ceil(y1*size.h)+1)-Y);
  }
  function composite(layers,pair,probes,time){
    let input=camera,flip=0,passes=0,previous=null;
    for(const layer of layers){
      const mask=masks.get(layer.key);
      if(!mask||!(layer.amount>0||layer.gloss>0||layer.shimmer>0))continue;
      const box=mask.box||FULL;
      // this layer's region statistics
      gl.disable(gl.SCISSOR_TEST);
      let p=programs.stats;useQuad(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER,stats.fbo);gl.viewport(0,0,1,1);
      bindTex(0,targets.low2.tex,p.uniforms.u_low);bindTex(1,mask.tex,p.uniforms.u_mask);
      gl.uniform4f(p.uniforms.u_box,box.x,box.y,box.x+box.w,box.y+box.h);
      gl.uniform4f(p.uniforms.u_probeA,probes[0],probes[1],probes[2],probes[3]);
      gl.uniform4f(p.uniforms.u_probeB,probes[4],probes[5],probes[6],probes[7]);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      // the layer itself
      const out=pair[flip];flip^=1;
      p=programs.layer;useQuad(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER,out.fbo);gl.viewport(0,0,size.w,size.h);
      const u=p.uniforms;
      bindTex(0,input,u.u_src);bindTex(1,targets.low2.tex,u.u_low);bindTex(2,mask.tex,u.u_mask);bindTex(3,stats.tex,u.u_stats);
      gl.uniform3f(u.u_color,layer.color[0],layer.color[1],layer.color[2]);
      gl.uniform1f(u.u_amount,layer.amount);gl.uniform1f(u.u_mode,layer.mode);
      gl.uniform1f(u.u_detail,layer.detail);gl.uniform1f(u.u_gloss,layer.gloss);
      gl.uniform1f(u.u_matte,layer.matte);gl.uniform1f(u.u_shimmer,layer.shimmer);
      gl.uniform1f(u.u_smooth,layer.smooth||0);gl.uniform1f(u.u_bright,layer.bright||0);
      gl.uniform2f(u.u_texel,1/size.w,1/size.h);gl.uniform1f(u.u_radius,layer.radius||4);
      gl.uniform1f(u.u_time,time);
      gl.enable(gl.SCISSOR_TEST);
      if(passes<2)scissorTo(FULL);else scissorTo(box,previous);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      gl.disable(gl.SCISSOR_TEST);
      input=out.tex;previous=box;passes++;
    }
    return input;
  }

  // Texture row 0 is the top of the frame, so v runs down with y and clip y is flipped.
  const offset={x:0,y:0};
  function drawMesh(tex,defs,width,height){
    const p=programs.out;
    gl.useProgram(p.program);
    for(let r=0,i=0;r<=ROWS;r++){
      const py=r/ROWS*height;
      for(let c=0;c<=COLS;c++){
        const px=c/COLS*width;
        let x=px,y=py;
        if(defs.length){displace(defs,px,py,offset);x+=offset.x;y+=offset.y;}
        positions[i++]=x/width*2-1;
        positions[i++]=1-y/height*2;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,posBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,positions);
    gl.enableVertexAttribArray(p.pos);gl.vertexAttribPointer(p.pos,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer);
    gl.enableVertexAttribArray(p.uv);gl.vertexAttribPointer(p.uv,2,gl.FLOAT,false,0,0);
    bindTex(0,tex,p.uniforms.u_tex);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
    gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
  }

  return {
    // Upload one layer's mask, at any resolution: it is sampled stretched over the
    // frame. `box` bounds it, as fractions of the frame.
    setMask(key,source,box){
      if(disposed)return;
      let entry=masks.get(key);
      if(!entry){entry={tex:makeTexture(0,0),box:null};masks.set(key,entry);}
      gl.bindTexture(gl.TEXTURE_2D,entry.tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      entry.box=box||FULL;
    },
    dropMasks(keep){
      for(const [key,entry] of masks)if(!keep||!keep.has(key)){gl.deleteTexture(entry.tex);masks.delete(key);}
    },
    // after/before: {layers, landmarks, amounts}. `before` is drawn from `seam` (a
    // canvas-space fraction) to the far edge. The canvas is mirrored in CSS, so the
    // caller passes the complement of the fraction it wants shown on screen.
    draw({source,width,height,version,live,landmarks,after,before=null,seam=null,grade=null,probes,time=0}){
      if(disposed||gl.isContextLost())return false;
      if(!width||!height)return false;
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      ensureTargets(width,height);
      gl.disable(gl.SCISSOR_TEST);
      if(live||version!==uploadedVersion){
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,camera);
        try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);}
        catch{return false;}
        uploadedVersion=version;
      }
      const face=landmarks&&landmarks.length>=LANDMARKS;
      const needs=face&&(after.layers.length||(before&&before.layers.length));
      if(needs)buildLow();
      const probe=probes||[.5,.5,.5,.5,.5,.5,.5,.5];
      const afterTex=face&&after.layers.length?composite(after.layers,targets.a,probe,time):camera;
      const beforeTex=before?(face&&before.layers.length?composite(before.layers,targets.b,probe,time):camera):null;

      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,width,height);
      const p=programs.out;gl.useProgram(p.program);
      const g=grade||[1,1,1];gl.uniform3f(p.uniforms.u_grade,g[0],g[1],g[2]);
      // No face, or no change asked for: the identity mesh.
      const afterDefs=face&&after.amounts?deformers(landmarks,width,height,after.amounts):[];
      drawMesh(afterTex,afterDefs,width,height);
      if(before&&seam!==null){
        const start=Math.max(0,Math.min(width,Math.round(seam*width)));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(start,0,width-start,height);
        const beforeDefs=face&&before.amounts?deformers(landmarks,width,height,before.amounts):[];
        drawMesh(beforeTex,beforeDefs,width,height);
        gl.disable(gl.SCISSOR_TEST);
      }
      return true;
    },

    dispose(){
      if(disposed)return;
      disposed=true;
      for(const handle of [posBuffer,uvBuffer,indexBuffer,quadBuffer])gl.deleteBuffer(handle);
      gl.deleteTexture(camera);
      for(const entry of masks.values())gl.deleteTexture(entry.tex);
      if(targets)Object.values(targets).flat().forEach(dropTarget);
      dropTarget(stats);
      for(const p of Object.values(programs))gl.deleteProgram(p.program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
