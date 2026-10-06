// Offline support for the installed web app. The page and its versioned modules are
// kept as they are fetched; the face model and its runtime (~15 MB) are kept the
// first time the camera is used, so after that the mirror works without a network.
//
// Only this origin's own files are cached, and nothing from the camera ever passes
// through here: frames never leave the page.
const CACHE='roja-v19';
const SHELL=['./','index.html','roja.css?v=19','app.js?v=19','catalog.js?v=19','makeup.js?v=19','stage.js?v=19',
  'deform.js?v=19','procedures.js?v=19','debug.js?v=19','brush.js?v=19','measure.js?v=19','blur.js?v=19','facemesh.js?v=19','shaders.js?v=19',
  'face-worker.js?v=19','face-core.js?v=19','skin.js?v=19','skin-scan.js?v=19','skin-panel.js?v=19',
  'fonts/Estedad-var.woff2','favicon.svg','manifest.webmanifest','icons/icon-192.png','icons/app-qr.svg'];

// From the server, not the browser's cache: that can still hold the previous release's
// page, and GitHub Pages ignores the ?v= query, so this release's names could be given
// the previous release's files.
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'}))))
    .then(()=>self.skipWaiting()));
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
    // The page itself: fresh when online, so a new version is picked up at once. Checked
    // with the server every time, as the browser would otherwise reuse its copy for ten
    // minutes and pair it with a newer script.
    if(request.mode==='navigate'){
      try{const response=await fetch(request,{cache:'no-cache'});if(response.ok)cache.put(request,response.clone());return response;}
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
