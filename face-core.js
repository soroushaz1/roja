// Face tracking, shared by the worker (face-worker.js) and — where a worker cannot run
// MediaPipe, as on iPhones older than iOS 17, which have no WebGL in workers — by the
// page itself. It is a plain script with no import or export, so importScripts() in the
// worker and import() in the page both load it; it leaves one global, rojaFaceCore.
//
// Frames are measured and let go. Nothing is kept, sent anywhere or stored.
self.rojaFaceCore=function(Vision,base){
  'use strict';
  const {FaceLandmarker,FilesetResolver,ImageSegmenter}=Vision;
  const here=p=>new URL(p,base).href;
  const pairs=list=>(list||[]).map(c=>[c.start,c.end]);
  let detector=null,files=null,model=null,wasmUrl='',delegate='CPU',gpuError='';

  function create(kind){
    return FaceLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetBuffer:model.slice(),delegate:kind},
      runningMode:'VIDEO',numFaces:1,
      minFaceDetectionConfidence:.55,minTrackingConfidence:.55,
      // Head pose feeds the "face the camera" hint and the debug readout; the
      // expression scores are only posted back while the debug readout asks for them.
      outputFacialTransformationMatrixes:true,
      outputFaceBlendshapes:true
    });
  }
  // A GPU the browser only emulates in software (SwiftShader, llvmpipe) runs the model
  // far slower than the CPU does.
  function softwareGL(){
    try{
      const c=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):document.createElement('canvas');
      const gl=c.getContext('webgl2');
      if(!gl)return true;
      const info=gl.getExtension('WEBGL_debug_renderer_info');
      const name=String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER)||'');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)?name:false;
    }catch{return true;}
  }
  // The model and the runtime this browser will use (~15 MB the first time) are fetched
  // here rather than by MediaPipe, so the page can show how far along they are. Each is
  // fetched once and handed over from memory: the model as bytes, the runtime as a blob
  // address in place of its file's.
  async function download(onProgress){
    const found=await FilesetResolver.forVisionTasks(here('vendor/wasm'));
    const urls=[here(found.wasmBinaryPath),here('vendor/face_landmarker.task')];
    // With gzip on the way the server sends no length, so the files' own sizes stand in.
    const SIZES={'vision_wasm_internal.wasm':11756954,'vision_wasm_nosimd_internal.wasm':10960242,'face_landmarker.task':3758596};
    const loaded=urls.map(()=>0), total=urls.map(()=>0);
    let last=0;
    const report=()=>{
      const now=Date.now();
      if(now-last<150)return;
      last=now;
      try{onProgress?.(loaded.reduce((a,b)=>a+b,0),total.reduce((a,b)=>a+b,0));}catch{}
    };
    const fetchOne=async(url,i)=>{
      const response=await fetch(url);
      if(!response.ok)throw new Error(`${url.split('/').pop()}: ${response.status}`);
      const length=!response.headers.get('content-encoding')&&Number(response.headers.get('content-length'));
      total[i]=length||SIZES[url.split('/').pop()]||0;
      if(!response.body)return new Uint8Array(await response.arrayBuffer());
      const reader=response.body.getReader(), parts=[];
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        parts.push(value);loaded[i]+=value.length;
        if(loaded[i]>total[i])total[i]=loaded[i];
        report();
      }
      const bytes=new Uint8Array(loaded[i]);
      let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
      return bytes;
    };
    const [wasm,task]=await Promise.all(urls.map(fetchOne));
    model=task;
    wasmUrl=URL.createObjectURL(new Blob([wasm],{type:'application/wasm'}));
    files={...found,wasmBinaryPath:wasmUrl};
  }
  // On the GPU the model runs several times faster than on the CPU. Where the GPU
  // cannot run it (no WebGL2 here, a driver MediaPipe rejects, a software GPU), the
  // CPU does. 'GPU!' insists on the GPU even so (the test harness uses it).
  async function init(prefer='CPU',onProgress){
    if(!files)await download(onProgress);
    detector?.close();detector=null;
    if(prefer==='GPU'){
      const soft=softwareGL();
      if(soft){gpuError=soft===true?'no WebGL2':`software GPU (${soft})`;prefer='CPU';}
    }
    if(prefer==='GPU'||prefer==='GPU!'){
      try{detector=await create('GPU');delegate='GPU';}
      catch(e){gpuError=String(e&&e.message||e);}
    }
    if(!detector){detector=await create('CPU');delegate='CPU';}
    // The mesh topology for the debug overlay.
    return {delegate,gpuError,
      tesselation:pairs(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
      contours:{
        oval:pairs(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL),
        lips:pairs(FaceLandmarker.FACE_LANDMARKS_LIPS),
        eyes:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE)],
        brows:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW)],
        irises:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS)]
      }
    };
  }

  // Average skin colour for the foundation shade finder: small patches on both cheeks,
  // the forehead and the chin, each rejected if it is too uneven to be bare skin (hair,
  // a shadow edge, a highlight), then the median of what is left. A handful of numbers
  // leave this function; the pixels do not.
  const SKIN_PATCHES=[50,280,101,330,151,199,205,425];
  function sampleSkin(frame,landmarks){
    const w=frame.displayWidth||frame.width,h=frame.displayHeight||frame.height;
    let ctx;
    if(typeof ImageData!=='undefined'&&frame instanceof ImageData){
      ctx={getImageData:(x,y,cw,ch)=>{
        const out=new Uint8ClampedArray(cw*ch*4);
        for(let row=0;row<ch;row++)out.set(frame.data.subarray(((y+row)*w+x)*4,((y+row)*w+x+cw)*4),row*cw*4);
        return {data:out};
      }};
    }else{
      const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(w,h)
        :typeof document!=='undefined'?Object.assign(document.createElement('canvas'),{width:w,height:h}):null;
      if(!canvas)return null;
      ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(!ctx)return null;
      ctx.drawImage(frame,0,0);
    }
    const face=Math.hypot((landmarks[454].x-landmarks[234].x)*w,(landmarks[454].y-landmarks[234].y)*h);
    const half=Math.max(2,Math.round(face*.025));
    const found=[];
    for(const index of SKIN_PATCHES){
      const cx=Math.round(landmarks[index].x*w),cy=Math.round(landmarks[index].y*h);
      if(cx-half<0||cy-half<0||cx+half>=w||cy+half>=h)continue;
      const data=ctx.getImageData(cx-half,cy-half,half*2+1,half*2+1).data;
      let r=0,g=0,b=0,n=0,l2=0;
      for(let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];n++;const l=data[i]*.299+data[i+1]*.587+data[i+2]*.114;l2+=l*l;}
      r/=n;g/=n;b/=n;
      const mean=r*.299+g*.587+b*.114,spread=Math.sqrt(Math.max(0,l2/n-mean*mean));
      if(spread>22||mean<25||mean>245)continue;
      found.push([r,g,b]);
    }
    if(found.length<2)return null;
    const median=k=>{const v=found.map(c=>c[k]).sort((a,b)=>a-b),m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2;};
    return {rgb:[median(0),median(1),median(2)],patches:found.length};
  }

  // Hair, for the hair colour and the hairstyles: MediaPipe's hair segmenter (~0.8 MB),
  // fetched and started the first time a frame asks for it. Its answer is how sure it is
  // that each pixel is hair, shrunk to a small mask (HAIR_W wide, one byte a pixel) with
  // the box around it, as fractions of the frame. Like the landmarks, it is all that
  // leaves here: the frame does not.
  const HAIR_W=192;
  const hair={state:'off',seg:null,error:'',frames:0};
  function startHair(){
    if(hair.state!=='off')return;
    hair.state='loading';
    (async()=>{
      const response=await fetch(here('vendor/hair_segmenter.tflite'));
      if(!response.ok)throw new Error(`hair_segmenter.tflite: ${response.status}`);
      const bytes=new Uint8Array(await response.arrayBuffer());
      const make=kind=>ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetBuffer:bytes.slice(),delegate:kind},
        runningMode:'VIDEO',outputConfidenceMasks:true,outputCategoryMask:false});
      let seg=null;
      if(delegate==='GPU'){try{seg=await make('GPU');}catch{}}
      hair.seg=seg||await make('CPU');
      hair.state='ready';
    })().catch(e=>{hair.state='failed';hair.error=String(e&&e.message||e);});
  }
  function hairMask(frame,timestamp){
    let out=null;
    hair.seg.segmentForVideo(frame,timestamp,result=>{
      const masks=result.confidenceMasks;
      const mask=masks?.[masks.length-1];          // [background, hair]
      if(!mask)return;
      const W=mask.width,H=mask.height,src=mask.getAsFloat32Array();
      const w=Math.min(HAIR_W,W),h=Math.max(1,Math.round(H*w/W)),data=new Uint8Array(w*h);
      let x0=w,y0=h,x1=-1,y1=-1;
      for(let y=0;y<h;y++){
        const sy=Math.min(H-1,Math.floor((y+.5)*H/h)),sy2=Math.min(H-1,sy+1);
        for(let x=0;x<w;x++){
          const sx=Math.min(W-1,Math.floor((x+.5)*W/w)),sx2=Math.min(W-1,sx+1);
          const v=(src[sy*W+sx]+src[sy*W+sx2]+src[sy2*W+sx]+src[sy2*W+sx2])/4;
          const b=Math.round(Math.max(0,Math.min(1,v))*255);
          data[y*w+x]=b;
          if(b>64){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
        }
      }
      out={w,h,data,box:x1<0?null:{x:x0/w,y:y0/h,w:(x1-x0+1)/w,h:(y1-y0+1)/h}};
      for(const m of masks)m.close?.();
    });
    return out;
  }

  // One frame (a VideoFrame, an ImageBitmap or ImageData) in, one result message out.
  function handle({frame,timestamp,extras,sample,hair:wantHair}){
    const start=performance.now();
    const result=detector.detectForVideo(frame,timestamp);
    const landmarks=result.faceLandmarks[0]||null;
    const message={type:'result',landmarks,ms:performance.now()-start,delegate};
    if(landmarks){
      const matrix=result.facialTransformationMatrixes?.[0];
      if(matrix)message.matrix=Array.from(matrix.data);
      if(extras)message.blendshapes=(result.faceBlendshapes?.[0]?.categories||[])
        .map(c=>[c.categoryName,c.score]);
      if(sample)message.skin=sampleSkin(frame,landmarks);
      if(wantHair){
        startHair();
        // On the CPU every other frame: hair moves with the head, and the last mask
        // holds well for one frame, while the landmarks keep their full rate.
        if(hair.state==='ready'&&(delegate==='GPU'||hair.frames++%2===0)){
          const t=performance.now();
          try{message.hair=hairMask(frame,timestamp);}
          catch(e){hair.state='failed';hair.error=String(e&&e.message||e);}
          message.hairMs=performance.now()-t;
        }
        if(hair.state!=='ready')message.hairState=hair.state==='failed'?`failed: ${hair.error}`:hair.state;
      }
    }
    return message;
  }

  return {init,handle,get delegate(){return delegate;},close(){try{detector?.close();hair.seg?.close();}catch{}if(wasmUrl)URL.revokeObjectURL(wasmUrl);}};
};
