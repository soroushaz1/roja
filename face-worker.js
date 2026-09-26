// Everything resolves against this worker's own URL, so the app works wherever it
// is served from - a domain root, or a project path like /roja/ on GitHub Pages.
const here=p=>new URL(p,self.location.href).href;
importScripts(here('vendor/vision_bundle.js'));
const {FaceLandmarker,FilesetResolver}=Vision;
let detector;
(async()=>{try{const files=await FilesetResolver.forVisionTasks(here('vendor/wasm'));detector=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:here('vendor/face_landmarker.task'),delegate:'CPU'},runningMode:'VIDEO',numFaces:1,minFaceDetectionConfidence:.55,minTrackingConfidence:.55});postMessage({type:'ready'});}catch(e){postMessage({type:'error',message:e.message});}})();
onmessage=event=>{const {bitmap,timestamp}=event.data;if(!bitmap)return;try{const result=detector.detectForVideo(bitmap,timestamp);postMessage({type:'result',landmarks:result.faceLandmarks[0]||null});}catch{postMessage({type:'error'});}finally{bitmap.close();}};
