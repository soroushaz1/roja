// Face tracking, shared by the worker (face-worker.js) and — where a worker cannot run
// MediaPipe, as on iPhones older than iOS 17, which have no WebGL in workers — by the
// page itself. It is a plain script with no import or export, so importScripts() in the
// worker and import() in the page both load it; it leaves one global, rojaFaceCore.
//
// Frames are measured and let go. Nothing is kept, sent anywhere or stored.
self.rojaFaceCore=function(Vision,base){
  'use strict';
  const {FaceLandmarker,FilesetResolver}=Vision;
  const here=p=>new URL(p,base).href;
  const pairs=list=>(list||[]).map(c=>[c.start,c.end]);
  let detector=null,files=null,delegate='CPU',gpuError='';

  function create(kind){
    return FaceLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetPath:here('vendor/face_landmarker.task'),delegate:kind},
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
  // On the GPU the model runs several times faster than on the CPU. Where the GPU
  // cannot run it (no WebGL2 here, a driver MediaPipe rejects, a software GPU), the
  // CPU does. 'GPU!' insists on the GPU even so (the test harness uses it).
  async function init(prefer='CPU'){
    files=files||await FilesetResolver.forVisionTasks(here('vendor/wasm'));
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

  // One frame (a VideoFrame, an ImageBitmap or ImageData) in, one result message out.
  function handle({frame,timestamp,extras,sample}){
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
    }
    return message;
  }

  return {init,handle,get delegate(){return delegate;},close(){try{detector?.close();}catch{}}};
};
