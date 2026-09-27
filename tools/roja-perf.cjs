// How fast the mirror runs: the app's own numbers (display fps, tracking rate and
// latency, mask and draw cost per frame) with the test portrait as a webcam and a
// full look on, one sample per look. Headless Chromium draws WebGL in software, so
// compare runs with each other, not with a phone.
//
//   node tools/preview.cjs          # in one terminal
//   node tools/roja-perf.cjs        # in another
const fs=require('fs'),path=require('path');
const tries=[process.env.PLAYWRIGHT_MODULE,'playwright'];
let chromium;for(const n of tries.filter(Boolean)){try{({chromium}=require(n));break;}catch{}}
const origin=process.env.ROJA_URL||'http://127.0.0.1:4173';
const fixture='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'face-test.png')).toString('base64');

(async()=>{
  const dir='/opt/pw-browsers',exe=fs.readdirSync(dir).filter(n=>/^chromium-\d+$/.test(n)).map(d=>path.join(dir,d,'chrome-linux','chrome'))[0];
  const browser=await chromium.launch({headless:true,executablePath:process.env.ROJA_CHROMIUM||exe,
    args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.addInitScript(({data})=>{
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
      const image=new Image();image.src=data;await image.decode();
      const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');
      let t=0;
      // The face drifts a little, so every frame is new and the tracker never idles.
      const draw=()=>{t++;ctx.fillStyle='#777';ctx.fillRect(0,0,640,480);ctx.drawImage(image,100,0,300,300,80+Math.sin(t/9)*6,0,480,480);};
      draw();setInterval(draw,33);return c.captureStream(30);
    }});
  },{data:fixture});
  await page.goto(origin+'/index.html'+(process.env.ROJA_QUERY||''));
  await page.locator('#start').click();
  await page.waitForFunction(()=>document.querySelector('#guide').hidden&&!document.querySelector('#stage').hidden,null,{timeout:120000});
  await page.evaluate(()=>{document.querySelector('#debug-panel').open=true;});
  const looks=await page.evaluate(()=>[...document.querySelectorAll('[data-look]')].map(b=>b.dataset.look));
  const read=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('#debug-stats dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent])));
  const out={};
  for(const id of looks.slice(0,3)){
    await page.locator(`[data-look="${id}"]`).click();
    await page.waitForTimeout(6000);
    const s=await read();
    out[id]={display:s['نمایش'],tracking:s['ردیابی'],cost:s['هزینهٔ هر فریم'],layers:s['لایه‌ها']};
  }
  console.log(JSON.stringify(out,null,1));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
