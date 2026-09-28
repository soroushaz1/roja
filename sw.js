// Offline support for the installed web app. The page and its versioned modules are
// kept as they are fetched; the face model and its runtime (~15 MB) are kept the
// first time the camera is used, so after that the mirror works without a network.
//
// Only this origin's own files are cached, and nothing from the camera ever passes
// through here: frames never leave the page.
const CACHE='roja-v16';
const SHELL=['./','index.html','roja.css?v=16','app.js?v=16','catalog.js?v=16','makeup.js?v=16','stage.js?v=16',
  'deform.js?v=16','procedures.js?v=16','debug.js?v=16','brush.js?v=16','measure.js?v=16','blur.js?v=16','facemesh.js?v=16','shaders.js?v=16',
  'face-worker.js?v=16','face-core.js?v=16',
  'fonts/Estedad-var.woff2','favicon.svg','manifest.webmanifest','icons/icon-192.png','icons/app-qr.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    // The page itself: fresh when online, so a new version is picked up at once.
    if(request.mode==='navigate'){
      try{const response=await fetch(request);if(response.ok)cache.put(request,response.clone());return response;}
      catch{return (await cache.match(request))||(await cache.match('./'))||Response.error();}
    }
    // Everything else is versioned or never changes: the cache first.
    const hit=await cache.match(request);
    if(hit)return hit;
    const response=await fetch(request);
    if(response.ok)cache.put(request,response.clone());
    return response;
  })());
});
