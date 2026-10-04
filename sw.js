// Offline support for the installed web app. The page and its versioned modules are
// kept as they are fetched; the face model and its runtime (~15 MB) are kept the
// first time the camera is used, so after that the mirror works without a network.
//
// Only this origin's own files are cached, and nothing from the camera ever passes
// through here: frames never leave the page.
const CACHE='roja-v18';
const SHELL=['./','index.html','roja.css?v=18','app.js?v=18','catalog.js?v=18','makeup.js?v=18','stage.js?v=18',
  'deform.js?v=18','procedures.js?v=18','debug.js?v=18','brush.js?v=18','measure.js?v=18','blur.js?v=18','facemesh.js?v=18','shaders.js?v=18',
  'face-worker.js?v=18','face-core.js?v=18','skin.js?v=18','skin-scan.js?v=18','skin-panel.js?v=18',
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
