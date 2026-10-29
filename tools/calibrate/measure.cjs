// The skin check and the shade finder on the calibration faces (faces.json, made by
// AI, each labelled with the Fitzpatrick type and the skin condition it was asked to
// show), side by side with what each was asked for. Prints a table, and writes it as
// JSON with an out file.
//
//   git fetch origin calibrate-1 && git checkout FETCH_HEAD -- tools/calibrate/faces
//   node tools/preview.cjs
//   node tools/calibrate/measure.cjs [out.json]
//
// The faces live on the branch the Calibration faces workflow made (calibrate-<run>),
// not on main: they are only for measuring.
//
// Playwright as for tools/roja-check.cjs (PLAYWRIGHT_MODULE, ROJA_CHROMIUM).
const fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const ORIGIN=process.env.ROJA_URL||'http://127.0.0.1:4173';
const here=__dirname;
const {faces}=JSON.parse(fs.readFileSync(path.join(here,'faces.json'),'utf8'));
const release=fs.readFileSync(path.join(here,'../../index.html'),'utf8').match(/data-release="(\d+)"/)[1];

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.ROJA_CHROMIUM&&{executablePath:process.env.ROJA_CHROMIUM})});
  const rows=[];
  for(const face of faces.filter(f=>f.fitz)){
    const file=path.join(here,'faces',`${face.id}.png`);
    if(!fs.existsSync(file)){console.log(`${face.id}: no face`);continue;}
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    // The tracker's own landmarks, as it gives them (the app smooths what it shows).
    await page.addInitScript(()=>{
      try{localStorage.setItem('roja-tour','done');}catch{}
      const N=window.Worker;window.Worker=class extends N{constructor(...a){super(...a);
        this.addEventListener('message',e=>{if(e.data.type==='result'&&e.data.landmarks)window.testLandmarks=e.data.landmarks;});}};
    });
    await page.goto(`${ORIGIN}/index.html#product=foundation`);
    const data=fs.readFileSync(file).toString('base64');
    await page.evaluate(async d=>{const blob=await (await fetch('data:image/png;base64,'+d)).blob(),t=new DataTransfer();
      t.items.add(new File([blob],'face.png',{type:'image/png'}));
      document.querySelector('#viewport').dispatchEvent(new DragEvent('drop',{dataTransfer:t,bubbles:true,cancelable:true}));},data);
    try{await page.waitForFunction(()=>document.querySelector('#guide').hidden&&!document.querySelector('#toolbar').hidden&&window.testLandmarks,null,{timeout:240000});}
    catch{console.log(`${face.id}: no face found`);await page.close();continue;}
    await page.waitForTimeout(1500);
    // The skin check's measurements, as the panel takes them (three scans of a photo
    // are the same scan), and its scores.
    const skin=await page.evaluate(async release=>{
      const {createSkinScanner}=await import(`/skin-scan.js?v=${release}`);
      const {combineScans,imageScores,fitzFromIta}=await import(`/skin.js?v=${release}`);
      const photo=document.querySelector('#photo'),s=createSkinScanner().scan(photo,photo.width,photo.height,window.testLandmarks,{yaw:0,pitch:0,roll:0});
      if(!s)return null;
      const combined=combineScans([s,s,s]),scores=imageScores(combined);
      const round=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='number'?+v.toFixed(4):v]));
      return {ita:+combined.tone.ita.toFixed(1),hex:combined.tone.hex,fitz:fitzFromIta(combined.tone.ita),tone:round(combined.tone),metrics:round(combined.metrics),
        checks:combined.checks,scores:Object.fromEntries(Object.entries(scores).map(([k,v])=>[k,Number.isFinite(v)?Math.round(v):null]))};
    },release);
    // The shade finder, on the foundation.
    await page.locator('#finder-run').click();
    let finder=null;
    try{
      await page.waitForFunction(()=>!document.querySelector('#finder-result').hidden&&document.querySelector('#finder-result .pick'),null,{timeout:60000});
      finder=await page.evaluate(()=>[document.querySelector('#finder-result .swatch')?.style.background||'',...[...document.querySelectorAll('#finder-result .pick')].map(b=>b.textContent.trim())]);
    }catch{finder=['failed'];}
    rows.push({id:face.id,asked:{fitz:face.fitz,skin:face.skin},skin,finder});
    const sc=skin?.scores||{};
    console.log(`${face.id}  asked ${face.fitz}/${face.skin.padEnd(7)}  ITA ${String(skin?.ita).padStart(5)} → type ${skin?.fitz}  `+
      `oil ${sc.oil} red ${sc.red} acne ${sc.acne} pigment ${sc.pigment} texture ${sc.texture} lines ${sc.lines}  | ${finder.slice(0,2).join(' ')}`);
    await page.close();
  }
  await browser.close();
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(rows,null,1)+'\n');
})().catch(e=>{console.error(e);process.exit(1);});
