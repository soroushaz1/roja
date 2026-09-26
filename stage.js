// The viewport for the procedure preview: the camera frame carried through a grid
// mesh displaced by deform.js. An all-zero field is a pixel-exact copy of the frame.
//
// The frame becomes a GPU texture on the device. It is never read back, sent or stored.
import {deformers, displace} from './deform.js?v=12';

const COLS=64, ROWS=48;          // resolves the smallest anchor radius
const GRID=(COLS+1)*(ROWS+1);
const LANDMARKS=468;

const VERT=`attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;
void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.,1.);}`;
const FRAG=`precision mediump float;uniform sampler2D u_tex;varying vec2 v_uv;
void main(){gl_FragColor=texture2D(u_tex,v_uv);}`;

export function createStage(canvas) {
  let gl;
  const options={alpha:false,antialias:false,depth:false,preserveDrawingBuffer:true};
  try{gl=canvas.getContext('webgl',options)||canvas.getContext('experimental-webgl',options);}
  catch{return null;}
  if(!gl) return null;

  let program;
  try{
    const compile=(type,source)=>{
      const shader=gl.createShader(type);
      gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,VERT));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  }catch{return null;}

  const positions=new Float32Array(GRID*2), uv=new Float32Array(GRID*2);
  const indices=new Uint16Array(COLS*ROWS*6);
  for(let r=0,v=0;r<=ROWS;r++)for(let c=0;c<=COLS;c++,v+=2){uv[v]=c/COLS;uv[v+1]=r/ROWS;}
  for(let r=0,i=0;r<ROWS;r++)for(let c=0;c<COLS;c++){
    const a=r*(COLS+1)+c,b=a+1,d=a+COLS+1,e=d+1;
    indices[i++]=a;indices[i++]=b;indices[i++]=d;
    indices[i++]=b;indices[i++]=e;indices[i++]=d;
  }

  gl.useProgram(program);
  const posBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER,positions,gl.DYNAMIC_DRAW);
  const posLocation=gl.getAttribLocation(program,'a_pos');
  gl.enableVertexAttribArray(posLocation);
  gl.vertexAttribPointer(posLocation,2,gl.FLOAT,false,0,0);

  const uvBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER,uv,gl.STATIC_DRAW);
  const uvLocation=gl.getAttribLocation(program,'a_uv');
  gl.enableVertexAttribArray(uvLocation);
  gl.vertexAttribPointer(uvLocation,2,gl.FLOAT,false,0,0);

  const indexBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);

  const texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  // The frame is not power-of-two, so clamp and skip mipmaps.
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program,'u_tex'),0);

  const offset={x:0,y:0};
  let disposed=false;

  // Texture row 0 is the top of the frame, so v runs down with y and clip y is flipped.
  function fill(defs,width,height){
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
    gl.bindBuffer(gl.ARRAY_BUFFER,posBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,positions);
    gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
  }

  return {
    // seam is a canvas-space fraction: from it to the far edge the frame is drawn
    // untouched. The canvas is mirrored in CSS, so the caller passes the complement
    // of the fraction it wants shown on screen.
    draw(video,landmarks,amounts,seam=null){
      if(disposed||gl.isContextLost())return false;
      const width=video.videoWidth,height=video.videoHeight;
      if(!width||!height||video.readyState<2)return false;
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);}
      catch{return false;}
      gl.disable(gl.SCISSOR_TEST);
      // No face, or the viewer asked for the original: draw the identity mesh.
      const defs=landmarks&&landmarks.length>=LANDMARKS?deformers(landmarks,width,height,amounts):[];
      fill(defs,width,height);
      if(seam!==null&&defs.length){
        const start=Math.max(0,Math.min(width,Math.round(seam*width)));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(start,0,width-start,height);
        fill([],width,height);
        gl.disable(gl.SCISSOR_TEST);
      }
      return true;
    },

    dispose(){
      if(disposed)return;
      disposed=true;
      for(const handle of [posBuffer,uvBuffer,indexBuffer])gl.deleteBuffer(handle);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
