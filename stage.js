// The mirror's renderer. The camera frame becomes a GPU texture and stays there: each
// makeup layer is a full-frame pass that recolours it under that layer's mask, and the
// result is carried through a grid mesh displaced by deform.js for the procedures.
// The frame is never read back, sent or stored.
//
// Masks are painted once, in the face's own front-on space (facemesh.js), whenever a
// product or setting changes. Every frame the face mesh, placed on the live landmarks,
// carries each one onto the face: a few hundred triangles on the GPU instead of
// repainting every mask on the CPU each time the face moves.
//
// With no layers and an all-zero displacement field the output is a pixel-exact copy
// of the camera frame.
import {deformers,displace} from './deform.js?v=24';
import {CANON,TRIANGLES} from './facemesh.js?v=24';
import * as GLSL from './shaders.js?v=24';

const COLS=64, ROWS=48;          // resolves the smallest anchor radius
const GRID=(COLS+1)*(ROWS+1);
const LANDMARKS=468;

// The triangles of the face mesh that reach into a box of face space, and their corners.
export function trianglesIn(uv){
  const x0=uv.x,y0=uv.y,x1=uv.x+uv.w,y1=uv.y+uv.h,tris=[],verts=new Set();
  for(let t=0;t<TRIANGLES.length;t+=3){
    const a=TRIANGLES[t],b=TRIANGLES[t+1],c=TRIANGLES[t+2];
    const ax=CANON[a*2],bx=CANON[b*2],cx=CANON[c*2],ay=CANON[a*2+1],by=CANON[b*2+1],cy=CANON[c*2+1];
    if(Math.max(ax,bx,cx)<x0||Math.min(ax,bx,cx)>x1||Math.max(ay,by,cy)<y0||Math.min(ay,by,cy)>y1)continue;
    tris.push(a,b,c);verts.add(a);verts.add(b);verts.add(c);
  }
  return {tris:new Uint16Array(tris),verts:Uint16Array.from(verts)};
}

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
    const F=GLSL.PRECISION;
    programs={out:link(GLSL.MESH_VERT,F+GLSL.OUT_FRAG),down:link(GLSL.QUAD_VERT,F+GLSL.DOWN_FRAG),
      stats:link(GLSL.QUAD_VERT,F+GLSL.STATS_FRAG),layer:link(GLSL.QUAD_VERT,F+GLSL.LAYER_FRAG),
      mask:link(GLSL.MASK_VERT,F+GLSL.MASK_FRAG)};
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
  // The face mesh: live landmark positions (per frame) and face-space coordinates.
  const facePos=new Float32Array(LANDMARKS*2);
  const facePosBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,facePosBuffer);gl.bufferData(gl.ARRAY_BUFFER,facePos,gl.DYNAMIC_DRAW);
  const canonBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,canonBuffer);gl.bufferData(gl.ARRAY_BUFFER,CANON,gl.STATIC_DRAW);

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
  const masks=new Map();                          // key -> {tex, uv, tris, count, verts}
  let targets=null, size={w:0,h:0};
  const stats=makeTarget(1,1,gl.NEAREST);
  function ensureTargets(w,h){
    if(targets&&size.w===w&&size.h===h)return;
    if(targets)Object.values(targets).flat().forEach(dropTarget);
    targets={
      a:[makeTarget(w,h),makeTarget(w,h)],b:[makeTarget(w,h),makeTarget(w,h)],mask:makeTarget(w,h),
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
  // Where a mask lands on screen this frame: around the live corners of its triangles.
  function screenBox(mask){
    let x0=1,y0=1,x1=0,y1=0;
    for(const i of mask.verts){const x=facePos[i*2],y=facePos[i*2+1];
      if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
    // clip space to frame fractions, a pixel or two of room
    const px=2/size.w,py=2/size.h;
    x0=Math.max(0,(x0+1)/2-px);x1=Math.min(1,(x1+1)/2+px);y0=Math.max(0,(y0+1)/2-py);y1=Math.min(1,(y1+1)/2+py);
    return x1>x0&&y1>y0?{x:x0,y:y0,w:x1-x0,h:y1-y0}:null;
  }
  // The mask for this frame, into the shared mask target (cleared whole, so nothing
  // from the last layer's mask is left where this pass looks).
  function renderMask(mask){
    const t=targets.mask,p=programs.mask;
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);gl.viewport(0,0,t.w,t.h);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER,facePosBuffer);
    gl.enableVertexAttribArray(p.pos);gl.vertexAttribPointer(p.pos,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,canonBuffer);
    gl.enableVertexAttribArray(p.uv);gl.vertexAttribPointer(p.uv,2,gl.FLOAT,false,0,0);
    bindTex(0,mask.tex,p.uniforms.u_mask);
    gl.uniform4f(p.uniforms.u_box,mask.uv.x,mask.uv.y,mask.uv.w,mask.uv.h);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mask.tris);
    gl.drawElements(gl.TRIANGLES,mask.count,gl.UNSIGNED_SHORT,0);
    gl.disableVertexAttribArray(p.uv);
  }
  function composite(layers,pair,probes,time){
    let input=camera,flip=0,passes=0,previous=null;
    for(const layer of layers){
      const mask=masks.get(layer.key);
      if(!mask||!mask.count||!(layer.amount>0||layer.gloss>0||layer.shimmer>0))continue;
      const box=screenBox(mask);
      if(!box)continue;
      gl.disable(gl.SCISSOR_TEST);
      renderMask(mask);
      // this layer's region statistics
      let p=programs.stats;useQuad(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER,stats.fbo);gl.viewport(0,0,1,1);
      bindTex(0,targets.low2.tex,p.uniforms.u_low);bindTex(1,targets.mask.tex,p.uniforms.u_mask);
      gl.uniform4f(p.uniforms.u_box,box.x,box.y,box.x+box.w,box.y+box.h);
      gl.uniform4f(p.uniforms.u_probeA,probes[0],probes[1],probes[2],probes[3]);
      gl.uniform4f(p.uniforms.u_probeB,probes[4],probes[5],probes[6],probes[7]);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      // the layer itself
      const out=pair[flip];flip^=1;
      p=programs.layer;useQuad(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER,out.fbo);gl.viewport(0,0,size.w,size.h);
      const u=p.uniforms;
      bindTex(0,input,u.u_src);bindTex(1,targets.low2.tex,u.u_low);bindTex(2,targets.mask.tex,u.u_mask);bindTex(3,stats.tex,u.u_stats);
      gl.uniform3f(u.u_color,layer.color[0],layer.color[1],layer.color[2]);
      gl.uniform1f(u.u_amount,layer.amount);gl.uniform1f(u.u_mode,layer.mode);
      gl.uniform1f(u.u_detail,layer.detail);gl.uniform1f(u.u_gloss,layer.gloss);
      gl.uniform1f(u.u_matte,layer.matte);gl.uniform1f(u.u_shimmer,layer.shimmer);
      gl.uniform1f(u.u_sheer,layer.sheer||0);gl.uniform1f(u.u_lift,layer.lift||0);
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
    // Upload one layer's mask, painted in face space (facemesh.js). `source` holds just
    // the part `uv` bounds, as fractions of that space; everything outside it is empty.
    // Only the triangles that reach into it are drawn.
    setMask(key,source,uv){
      if(disposed)return;
      let entry=masks.get(key);
      if(!entry){entry={tex:makeTexture(0,0),uv:null,tris:gl.createBuffer(),count:0,verts:null};masks.set(key,entry);}
      gl.bindTexture(gl.TEXTURE_2D,entry.tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      if(!entry.uv||entry.uv.x!==uv.x||entry.uv.y!==uv.y||entry.uv.w!==uv.w||entry.uv.h!==uv.h){
        const {tris,verts}=trianglesIn(uv);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,entry.tris);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,tris,gl.STATIC_DRAW);
        entry.count=tris.length;entry.verts=verts;
      }
      entry.uv={...uv};
    },
    dropMasks(keep){
      for(const [key,entry] of masks)if(!keep||!keep.has(key)){gl.deleteTexture(entry.tex);gl.deleteBuffer(entry.tris);masks.delete(key);}
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
      if(needs){
        // Texture row 0 is the top of the frame, and so is clip y = -1 in every target.
        for(let i=0;i<LANDMARKS;i++){facePos[i*2]=landmarks[i].x*2-1;facePos[i*2+1]=landmarks[i].y*2-1;}
        gl.bindBuffer(gl.ARRAY_BUFFER,facePosBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,facePos);
        buildLow();
      }
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
      for(const handle of [posBuffer,uvBuffer,indexBuffer,quadBuffer,facePosBuffer,canonBuffer])gl.deleteBuffer(handle);
      gl.deleteTexture(camera);
      for(const entry of masks.values()){gl.deleteTexture(entry.tex);gl.deleteBuffer(entry.tris);}
      if(targets)Object.values(targets).flat().forEach(dropTarget);
      dropTarget(stats);
      for(const p of Object.values(programs))gl.deleteProgram(p.program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
