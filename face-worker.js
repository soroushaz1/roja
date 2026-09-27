// Face tracking, off the main thread. Everything resolves against this worker's own
// URL, so the app works wherever it is served from - a domain root, or a project path
// like /roja/ on GitHub Pages. The tracking itself is in face-core.js, shared with the
// page for browsers that cannot run it here.
//
// `?gpu=1` asks for the GPU, unless the browser only emulates one in software;
// `?gpu=force` insists. If the GPU then fails on a frame, the worker moves to the CPU
// and carries on.
//
// Frames arrive as VideoFrames, ImageBitmaps or ImageData and are let go as soon as
// they are measured. Nothing is kept, sent anywhere or stored.
const here=p=>new URL(p,self.location.href).href;
importScripts(here('vendor/vision_bundle.js'),here('face-core.js?v=16'));
const core=rojaFaceCore(Vision,self.location.href);
const prefer={'1':'GPU','force':'GPU!'}[new URLSearchParams(self.location.search).get('gpu')]||'CPU';
core.init(prefer).then(
  info=>postMessage({type:'ready',topology:info,delegate:info.delegate,gpuError:info.gpuError}),
  e=>postMessage({type:'error',stage:'init',message:String(e&&e.message||e)})
);

let switching=false;
onmessage=event=>{
  const {frame}=event.data;
  if(!frame)return;
  // While moving to the CPU there is no model to ask: the frame is let go, and the
  // page is told so it can send the next one.
  if(switching){frame.close?.();postMessage({type:'skip'});return;}
  try{postMessage(core.handle(event.data));}
  catch(e){
    const message=String(e&&e.message||e);
    if(core.delegate==='GPU'){
      // Drop to the CPU for good; the page is told, so its readout says so.
      switching=true;
      postMessage({type:'error',stage:'gpu',message,recoverable:true});
      core.init('CPU').then(
        info=>{switching=false;postMessage({type:'ready',topology:info,delegate:info.delegate,gpuError:message});},
        err=>postMessage({type:'error',stage:'init',message:String(err&&err.message||err)}));
    }else postMessage({type:'error',stage:'detect',message});
  }
  finally{frame.close?.();}
};
