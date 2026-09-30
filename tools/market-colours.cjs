// Learn what shade colours are actually on sale in Iran, so Roja's own palette can be
// built from the real range instead of invented ones.
//
// It reads the public JSON catalogue one product at a time with a pause between calls,
// and keeps ONLY the colour values: no product names, no brands, no images, no ids.
// Nothing that identifies a third party's product ends up in this repository.
//
//   node tools/market-colours.cjs [out.json]
const https=require('https'),fs=require('fs');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36';
const HOST='www.khanoumi.com';
const out=process.argv[2]||'tools/market-colours.json';
const PAUSE=1200;                                   // one request at a time, ~0.8/second

// Category to sample size: more where the colour range is wide, less where it is not.
const CATEGORIES=[
  ['lipstick',25,35],['eyeshadow',18,35],['foundation-makeup',10,30],['blush',13,25],
  ['concealer',12,20],['lip-liner',229,15],['highlighter',746,15],['bronzer',327,15],
  ['eyeliner',20,12],['mascara',23,10]
];

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const getJson=path=>new Promise((resolve,reject)=>{
  https.get({host:HOST,path,headers:{'User-Agent':UA,Accept:'application/json'}},res=>{
    let body='';res.setEncoding('utf8');
    res.on('data',c=>body+=c);
    res.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(new Error(`${res.statusCode} ${path}`));}});
  }).on('error',reject);
});

const isHex=v=>typeof v==='string'&&/^#[0-9a-fA-F]{6}$/.test(v.trim());

(async()=>{
  const result={};
  for(const [slug,catId,sample] of CATEGORIES){
    const hexes=new Set();
    let seen=0,scanned=0;
    try{
      await wait(PAUSE);
      const list=await getJson(`/api/ntl/v1/products?cat_id=${catId}&page_size=${Math.max(sample*2,48)}`);
      const items=(list?.data?.products?.items||[]).filter(i=>(i.colorsCount||0)>1);
      for(const item of items.slice(0,sample)){
        await wait(PAUSE);
        let detail;
        try{detail=await getJson(`/api/ntl/v1/products/slug/${item.slug}`);}catch{continue;}
        scanned++;
        for(const v of detail?.data?.variants||[]){
          seen++;
          const hex=v?.color?.hexCode;
          if(isHex(hex))hexes.add(hex.trim().toLowerCase());
        }
      }
    }catch(e){console.error(`  ${slug}: ${e.message}`);}
    result[slug]=[...hexes];
    console.error(`  ${slug.padEnd(18)} ${String(scanned).padStart(3)} products · ${String(seen).padStart(4)} variants · ${String(hexes.size).padStart(3)} colours`);
  }
  fs.writeFileSync(out,JSON.stringify(result,null,1));
  const total=Object.values(result).reduce((n,a)=>n+a.length,0);
  console.error(`\nwrote ${out} — ${total} colours across ${Object.keys(result).length} categories`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
