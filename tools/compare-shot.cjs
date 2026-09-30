// Same look, same face, two builds, one image — so "more realistic" can be judged.
//   node tools/compare-shot.cjs <beforeUrl> <afterUrl> <out.png> [lookId]
// Writes before | after | amplified difference, and prints per-region colour change.
const fs=require('fs'),path=require('path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const [beforeUrl,afterUrl,out]=process.argv.slice(2);
const look=process.argv[5]||'evening';
const fixture='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'face-test.png')).toString('base64');

const fakeCamera=({data})=>{
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='result')window.testLandmarks=e.data.landmarks;});}};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
    const image=new Image();image.src=data;await image.decode();
    const c=document.createElement('canvas');c.width=640;c.height=480;const x=c.getContext('2d');
    const draw=()=>{x.fillStyle='#777';x.fillRect(0,0,640,480);x.drawImage(image,100,0,300,300,80,0,480,480);};
    draw();setInterval(draw,70);return c.captureStream(15);
  }});
};

// The crop is taken in landmark space so both builds frame the face identically.
async function shoot(browser,url,look){
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  await page.addInitScript(fakeCamera,{data:fixture});
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('#start').click();
  await page.waitForFunction(()=>window.testLandmarks,null,{timeout:90000});
  await page.waitForFunction(()=>!document.querySelector('#stage').hidden,null,{timeout:20000});
  await page.evaluate(id=>{const b=[...document.querySelectorAll('[data-look]')].find(x=>x.dataset.look===id);if(b)b.click();},look);
  await page.waitForTimeout(900);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const shot=await page.evaluate(()=>{
    const s=document.querySelector('#stage'),lm=window.testLandmarks;
    const xs=lm.map(p=>p.x*s.width),ys=lm.map(p=>p.y*s.height),pad=22;
    const x0=Math.max(0,Math.min(...xs)-pad),x1=Math.min(s.width,Math.max(...xs)+pad);
    const y0=Math.max(0,Math.min(...ys)-pad),y1=Math.min(s.height,Math.max(...ys)+pad);
    const w=Math.round(x1-x0),h=Math.round(y1-y0),k=2;         // 2x, small crops are unreadable
    const c=document.createElement('canvas');c.width=w*k;c.height=h*k;
    const x=c.getContext('2d');x.imageSmoothingQuality='high';
    x.save();x.translate(w*k,0);x.scale(-1,1);x.drawImage(s,x0,y0,w,h,0,0,w*k,h*k);x.restore();
    // Regions to measure, in this crop's own pixels.
    const at=i=>({x:(lm[i].x*s.width-x0)*k,y:(lm[i].y*s.height-y0)*k});
    const mirror=q=>({x:w*k-q.x,y:q.y});
    return {url:c.toDataURL('image/png'),w:w*k,h:h*k,
      regions:{lips:mirror(at(13)),lid:mirror(at(386)),cheek:mirror(at(280)),brow:mirror(at(334))}};
  });
  await page.close();
  return shot;
}

(async()=>{
  const browser=await playwright.chromium.launch({headless:true,channel:'chrome'});
  try{
    const a=await shoot(browser,beforeUrl,look), b=await shoot(browser,afterUrl,look);
    const page=await browser.newPage({viewport:{width:1200,height:700}});
    const res=await page.evaluate(async({a,b,look})=>{
      const load=src=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=src;});
      const [ia,ib]=await Promise.all([load(a.url),load(b.url)]);
      const w=a.w,h=a.h,gap=10,head=26;
      const c=document.createElement('canvas');c.width=w*3+gap*2;c.height=h+head;
      const x=c.getContext('2d');x.fillStyle='#111';x.fillRect(0,0,c.width,c.height);
      x.drawImage(ia,0,head);x.drawImage(ib,w+gap,head);
      // Amplified difference, so a small change is still visible.
      const ca=document.createElement('canvas');ca.width=w;ca.height=h;
      const cb=document.createElement('canvas');cb.width=w;cb.height=h;
      ca.getContext('2d').drawImage(ia,0,0);cb.getContext('2d').drawImage(ib,0,0);
      const da=ca.getContext('2d').getImageData(0,0,w,h),db=cb.getContext('2d').getImageData(0,0,w,h);
      const out=x.createImageData(w,h);
      for(let i=0;i<da.data.length;i+=4){
        for(let k=0;k<3;k++)out.data[i+k]=Math.min(255,Math.abs(da.data[i+k]-db.data[i+k])*4);
        out.data[i+3]=255;
      }
      x.putImageData(out,(w+gap)*2,head);
      x.fillStyle='#fff';x.font='15px sans-serif';
      x.fillText(`${look} · before`,8,18);x.fillText(`${look} · after`,w+gap+8,18);
      x.fillText('difference ×4',(w+gap)*2+8,18);
      // Mean colour at each measured spot, over a small disc.
      const sample=(img,q)=>{const d=img.data,r=6;let n=0,s=[0,0,0];
        for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
          const px=Math.round(q.x+dx),py=Math.round(q.y+dy);
          if(px<0||py<0||px>=w||py>=h)continue;
          const i=(py*w+px)*4;s[0]+=d[i];s[1]+=d[i+1];s[2]+=d[i+2];n++;}
        return s.map(v=>Math.round(v/Math.max(1,n)));};
      const report={};
      for(const key of Object.keys(a.regions)){
        const before=sample(da,a.regions[key]),after=sample(db,b.regions[key]);
        report[key]={before,after,shift:Math.round(Math.hypot(...before.map((v,i)=>v-after[i])))};
      }
      return {png:c.toDataURL('image/png'),report};
    },{a,b,look});
    fs.writeFileSync(out,Buffer.from(res.png.split(',')[1],'base64'));
    console.log(out);
    console.log(JSON.stringify(res.report,null,1));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
