// Turns the showcase's made faces (make-faces.mjs) into before/after pictures for the
// site, with the mirror's own renderers: Roja's looks on the makeup faces, Roja Clinic's
// procedures on the clinic faces. Every picture says it is a simulation on a face made by
// AI. Faces the tracker does not find are left out.
//
//   node tools/preview.cjs                       # Roja on 4173
//   PORT=4174 node ../roja-clinic/tools/preview.cjs
//   node tools/showcase/render.cjs tools/showcase/faces showcase
//
// Playwright and its Chromium as for tools/roja-check.cjs (PLAYWRIGHT_MODULE, ROJA_CHROMIUM).
const fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const ROJA=process.env.ROJA_URL||'http://127.0.0.1:4173',CLINIC=process.env.CLINIC_URL||'http://127.0.0.1:4174';
const [facesDir=path.join(__dirname,'faces'),outDir='showcase']=process.argv.slice(2);
const {faces}=JSON.parse(fs.readFileSync(path.join(__dirname,'faces.json'),'utf8'));
fs.mkdirSync(outDir,{recursive:true});

// The picture alone: the stage filling the window (3:4), everything over it hidden,
// the clinic's own "simulation" tag too, as each card says so itself.
const BARE=`#viewport{position:fixed!important;top:0!important;left:0!important;right:auto!important;bottom:auto!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;min-height:0!important;z-index:2147483646!important;border:0!important;border-radius:0!important;margin:0!important}
#toolbar,#seam,#guide,#hud,#flash,#tour,#loading,#v3,.menu,#tap-start,#inspect-tip,#brush-cursor,.v3-capture,#welcome,#badge{display:none!important}`;
const W=768,H=1024;

async function openFace(page,origin,file){
  await page.addInitScript(()=>{try{localStorage.setItem('roja-tour','done');localStorage.setItem('roja-theme','dark');}catch{}});
  await page.goto(origin+'/index.html',{waitUntil:'load',timeout:90000});
  const data=fs.readFileSync(file).toString('base64');
  await page.evaluate(async d=>{
    const blob=await (await fetch('data:image/png;base64,'+d)).blob(),t=new DataTransfer();
    t.items.add(new File([blob],'face.png',{type:'image/png'}));
    document.querySelector('#viewport').dispatchEvent(new DragEvent('drop',{dataTransfer:t,bubbles:true,cancelable:true}));
  },data);
  await page.waitForFunction(()=>document.querySelector('#guide').hidden&&!document.querySelector('#toolbar').hidden,null,{timeout:240000});
  await page.addStyleTag({content:BARE});
  await page.waitForTimeout(2500);
}
// Where the face is on screen, from Roja's tracker (rojaState().points, fractions of the
// frame; the picture is shown mirrored and fills the 3:4 window): a 3:4 box round it with
// room for the hair and the neck. Found once per face in Roja, used for both mirrors.
async function faceBox(page){
  const {points:pts,width:fw,height:fh}=await page.evaluate(()=>window.rojaState());
  // The frame as shown: contained in the window, mirrored.
  const k=Math.min(W/fw,H/fh),ox=(W-fw*k)/2,oy=(H-fh*k)/2;
  let x0=W,x1=0,y0=H,y1=0;
  for(const [px,py] of pts){const x=ox+(1-px)*fw*k,y=oy+py*fh*k;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  const cx=(x0+x1)/2,cy=(y0+y1)/2-(y1-y0)*.04;
  let h=Math.max((y1-y0)*1.75,(x1-x0)*1.6*4/3),w=h*3/4;
  h=Math.min(h,fh*k);w=Math.min(w,fw*k,h*3/4);h=w*4/3;
  const x=Math.max(ox,Math.min(ox+fw*k-w,cx-w/2)),y=Math.max(oy,Math.min(oy+fh*k-h,cy-h/2));
  return {x:Math.round(x),y:Math.round(y),width:Math.round(w),height:Math.round(h)};
}
let clip=null;
const shot=async page=>`data:image/jpeg;base64,${(await page.screenshot({type:'jpeg',quality:92,...(clip&&{clip})})).toString('base64')}`;

async function card(browser,before,after,name,note,file){
  const p=await browser.newPage({viewport:{width:1200,height:860}});
  await p.goto(ROJA+'/tools/showcase/card.html');
  await p.evaluate(({before,after,name,note})=>{
    document.getElementById('before').src=before;document.getElementById('after').src=after;
    document.getElementById('name').textContent=name;document.getElementById('note').textContent=note;
  },{before,after,name,note});
  await p.evaluate(()=>Promise.all([document.fonts.ready,...[...document.images].map(i=>i.decode())]));
  await p.screenshot({path:file,type:'jpeg',quality:86});
  await p.close();
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.ROJA_CHROMIUM&&{executablePath:process.env.ROJA_CHROMIUM})});
  const made=[];
  for(const face of faces){
    const file=path.join(facesDir,`${face.id}.png`);
    if(!fs.existsSync(file)){console.log(`${face.id}: no face`);continue;}
    const page=await browser.newPage({viewport:{width:W,height:H}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await openFace(page,ROJA,file);
      clip=await faceBox(page);
      if(face.makeup){
        await page.evaluate(()=>document.querySelector('#clear-look').click());await page.waitForTimeout(1500);
        const before=await shot(page);
        for(const id of face.makeup){
          const name=await page.evaluate(id=>{const b=document.querySelector(`#looks [data-look="${id}"]`);b.click();return b.querySelector('strong').firstChild.textContent;},id);
          await page.waitForTimeout(3000);
          const out=path.join(outDir,`makeup-${face.id}-${id}.jpg`);
          await card(browser,before,await shot(page),`آرایش «${name}»`,'شبیه‌سازی آینهٔ رُژا روی چهره‌ای ساخته‌شده با هوش مصنوعی',out);
          made.push({file:path.basename(out),kind:'makeup',face:face.id,id,name});console.log('made',out);
        }
      }
      if(face.clinic){
        await openFace(page,CLINIC,file);
        const before=await shot(page);
        for(const id of face.clinic){
          const name=await page.evaluate(id=>{const b=document.querySelector(`[data-procedure="${id}"]`);b.click();return (b.querySelector('strong')||b).textContent.trim().split('\n')[0];},id);
          // The whole result, without the before/after line across it.
          await page.evaluate(()=>{const c=document.querySelector('#compare');if(c.getAttribute('aria-pressed')==='true')c.click();});
          await page.waitForTimeout(2500);
          const out=path.join(outDir,`clinic-${face.id}-${id}.jpg`);
          await card(browser,before,await shot(page),name,'شبیه‌سازی تصویری رُژا کلینیک روی چهره‌ای ساخته‌شده با هوش مصنوعی؛ نه نتیجهٔ قطعی عمل',out);
          made.push({file:path.basename(out),kind:'clinic',face:face.id,id,name});console.log('made',out);
          await page.evaluate(()=>document.querySelector('#procedure-reset').click());await page.waitForTimeout(800);
        }
      }
    }catch(e){console.log(`${face.id}: ${e.message.split('\n')[0]}`);}
    if(errors.length)console.log(`${face.id}: page errors: ${errors.join('; ')}`);
    await page.close();
  }
  fs.writeFileSync(path.join(outDir,'index.json'),JSON.stringify(made,null,1)+'\n');
  await browser.close();
  if(!made.length)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1);});
