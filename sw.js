// Offline support for the installed web app. The page and its versioned modules are
// kept as they are fetched; the face model and its runtime (~15 MB) are kept the
// first time the camera is used, so after that the mirror works without a network.
//
// Only this origin's own files are cached, and nothing from the camera ever passes
// through here: frames never leave the page.
const CACHE='roja-v21';
const SHELL=['./','index.html','roja.css?v=21','app.js?v=21','catalog.js?v=21','makeup.js?v=21','stage.js?v=21',
  'deform.js?v=21','procedures.js?v=21','debug.js?v=21','brush.js?v=21','measure.js?v=21','blur.js?v=21','facemesh.js?v=21','shaders.js?v=21',
  'face-worker.js?v=21','face-core.js?v=21','skin.js?v=21','skin-scan.js?v=21','skin-panel.js?v=21','usage.js?v=21','shop.js?v=21',
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
  const url=new URL(request.url);
  // The API answers change with every call (a skin check's saved results, the counts):
  // straight to the server, never from the cache.
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/api/'))return;
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
