// Face tracking, off the main thread. Everything resolves against this worker's own
// URL, so the app works wherever it is served from - a domain root, or a project path
// like /roja/ on GitHub Pages. The tracking itself is in face-core.js, shared with the
// page for browsers that cannot run it here.
//
// Frames arrive as ImageBitmaps (or ImageData) and are let go as soon as they are
// measured. Nothing is kept, sent anywhere or stored.
const here=p=>new URL(p,self.location.href).href;
importScripts(here('vendor/vision_bundle.js'),here('face-core.js?v=15'));
const core=rojaFaceCore(Vision,self.location.href);

core.init().then(
  topology=>postMessage({type:'ready',topology}),
  e=>postMessage({type:'error',stage:'init',message:String(e&&e.message||e)})
);

onmessage=event=>{
  const {frame}=event.data;
  if(!frame)return;
  try{postMessage(core.handle(event.data));}
  catch(e){postMessage({type:'error',stage:'detect',message:String(e&&e.message||e)});}
  finally{frame.close?.();}
};
