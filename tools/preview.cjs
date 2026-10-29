const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');   // the site lives at the repo root
// With ROJA_API (say http://127.0.0.1:51840, server/skin-api.mjs running), /api/ is
// passed on to it, as nginx does on the server.
const api=process.env.ROJA_API&&new URL(process.env.ROJA_API);
http.createServer((req,res)=>{
  if(api&&req.url.startsWith('/api/')){
    const out=http.request({host:api.hostname,port:api.port,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    out.on('error',()=>{res.writeHead(502).end();});req.pipe(out);return;
  }
  let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  // A folder serves its index.html, as nginx does for the reading pages (faq/, makeup/…).
  const file=path.resolve(root,'.'+(name.endsWith('/')?name+'index.html':name));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.svg':'image/svg+xml','.jpeg':'image/jpeg','.jpg':'image/jpeg','.woff2':'font/woff2','.png':'image/png','.txt':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json','.json':'application/json','.xml':'application/xml','.task':'application/octet-stream'};
  fs.readFile(file,(e,data)=>{if(e){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);});
}).listen(4173,'127.0.0.1',()=>console.log('http://127.0.0.1:4173'));
