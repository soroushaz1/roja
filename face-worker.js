// Face tracking, off the main thread. Everything resolves against this worker's own
// URL, so the app works wherever it is served from - a domain root, or a project path
// like /roja/ on GitHub Pages.
//
// Frames arrive as ImageBitmaps and are closed as soon as they are measured. Nothing
// is kept, sent anywhere or stored.
const here=p=>new URL(p,self.location.href).href;
importScripts(here('vendor/vision_bundle.js'));
const {FaceLandmarker,FilesetResolver}=Vision;
let detector;

const pairs=list=>(list||[]).map(c=>[c.start,c.end]);

(async()=>{
  try{
    const files=await FilesetResolver.forVisionTasks(here('vendor/wasm'));
    detector=await FaceLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetPath:here('vendor/face_landmarker.task'),delegate:'CPU'},
      runningMode:'VIDEO',numFaces:1,
      minFaceDetectionConfidence:.55,minTrackingConfidence:.55,
      // Head pose feeds the "face the camera" hint and the debug readout; the
      // expression scores are only posted back while the debug readout asks for them.
      outputFacialTransformationMatrixes:true,
      outputFaceBlendshapes:true
    });
    // The mesh topology for the debug overlay, sent once.
    postMessage({type:'ready',topology:{
      tesselation:pairs(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
      contours:{
        oval:pairs(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL),
        lips:pairs(FaceLandmarker.FACE_LANDMARKS_LIPS),
        eyes:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE)],
        brows:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW)],
        irises:[...pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS),...pairs(FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS)]
      }
    }});
  }catch(e){postMessage({type:'error',message:e.message});}
})();

// Average skin colour for the foundation shade finder: small patches on both cheeks,
// the forehead and the chin, each rejected if it is too uneven to be bare skin (hair,
// a shadow edge, a highlight), then the median of what is left. A handful of numbers
// leave this function; the pixels do not.
const SKIN_PATCHES=[50,280,101,330,151,199,205,425];
function sampleSkin(bitmap,landmarks){
  if(typeof OffscreenCanvas==='undefined')return null;
  const w=bitmap.width,h=bitmap.height;
  const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
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

onmessage=event=>{
  const {bitmap,timestamp,extras,sample}=event.data;
  if(!bitmap)return;
  try{
    const result=detector.detectForVideo(bitmap,timestamp);
    const landmarks=result.faceLandmarks[0]||null;
    const message={type:'result',landmarks};
    if(landmarks){
      const matrix=result.facialTransformationMatrixes?.[0];
      if(matrix)message.matrix=Array.from(matrix.data);
      if(extras)message.blendshapes=(result.faceBlendshapes?.[0]?.categories||[])
        .map(c=>[c.categoryName,c.score]);
      if(sample)message.skin=sampleSkin(bitmap,landmarks);
    }
    postMessage(message);
  }catch{postMessage({type:'error'});}
  finally{bitmap.close();}
};
