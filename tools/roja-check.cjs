// Browser checks for Roja: makeup, the brush, compare, looks, photos, procedures,
// the debug overlay and the phone layout.
//
//   node tools/preview.cjs      # in one terminal
//   node tools/roja-check.cjs   # in another
//
// Set ROJA_URL to point it at a deployed copy instead of the local server. Playwright
// is found through PLAYWRIGHT_MODULE, a normal require, or the global npm folder; the
// browser through ROJA_CHROMIUM (an executable path), installed Chrome, or
// Playwright's own Chromium.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');

function loadPlaywright(){
  const tries=[process.env.PLAYWRIGHT_MODULE,'playwright',
    'C:/Users/sorou/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'];
  try{tries.push(path.join(require('child_process').execSync('npm root -g',{stdio:['ignore','pipe','ignore']}).toString().trim(),'playwright'));}catch{}
  for(const name of tries.filter(Boolean)){try{return require(name);}catch{}}
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.');
}
const {chromium}=loadPlaywright();
async function launch(){
  const attempts=[];
  if(process.env.ROJA_CHROMIUM)attempts.push({executablePath:process.env.ROJA_CHROMIUM});
  attempts.push({channel:'chrome'},{});
  for(const dir of ['/opt/pw-browsers']){
    try{for(const d of fs.readdirSync(dir).filter(n=>/^chromium-\d+$/.test(n)))
      attempts.push({executablePath:path.join(dir,d,'chrome-linux','chrome')});}catch{}
  }
  let last;
  for(const options of attempts){try{return await chromium.launch({headless:true,...options});}catch(e){last=e;}}
  throw last;
}

const siteRoot=path.resolve(__dirname,'..');
const origin=process.env.ROJA_URL||'http://127.0.0.1:4173';
const fixturePng=fs.readFileSync(path.join(__dirname,'face-test.png'));
const fixture='data:image/png;base64,'+fixturePng.toString('base64');
const GX=32,GY=24;

// A webcam made from the test portrait. `testShift` slides the face sideways and
// `testBlank` takes it away.
const fakeCamera=({data})=>{
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='result')window.testLandmarks=e.data.landmarks;});}};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
    const image=new Image();image.src=data;await image.decode();
    const c=document.createElement('canvas');c.width=640;c.height=480;
    const ctx=c.getContext('2d');window.testBlank=false;window.testShift=0;
    const draw=()=>{ctx.fillStyle='#777';ctx.fillRect(0,0,640,480);if(!window.testBlank)ctx.drawImage(image,100,0,300,300,80+window.testShift,0,480,480);};
    draw();window.testTimer=setInterval(draw,70);window.testStream=c.captureStream(15);return window.testStream;
  }});
};

// The stage against its source, per grid cell, as mean absolute difference.
const probe=({GX,GY})=>{
  const s=document.querySelector('#stage'),v=document.querySelector('#photo').hidden&&document.querySelector('#video').srcObject?document.querySelector('#video'):document.querySelector('#photo');
  const w=s.width,h=s.height;
  const read=source=>{const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(source,0,0,w,h);
    return x.getImageData(0,0,w,h).data;};
  const sd=read(s),vd=read(v);
  let diff=0;for(let i=0;i<sd.length;i+=4)diff+=Math.abs(sd[i]-vd[i])+Math.abs(sd[i+1]-vd[i+1])+Math.abs(sd[i+2]-vd[i+2]);
  const grid=[],luma=[];
  for(let gy=0;gy<GY;gy++)for(let gx=0;gx<GX;gx++){
    const x0=Math.floor(gx*w/GX),x1=Math.floor((gx+1)*w/GX),y0=Math.floor(gy*h/GY),y1=Math.floor((gy+1)*h/GY);
    let sum=0,lum=0,n=0;
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const i=(y*w+x)*4;
      sum+=Math.abs(sd[i]-vd[i])+Math.abs(sd[i+1]-vd[i+1])+Math.abs(sd[i+2]-vd[i+2]);
      lum+=sd[i]*.299+sd[i+1]*.587+sd[i+2]*.114;n++;}
    grid.push(sum/n/3);luma.push(lum/n);
  }
  return {w,h,diff:diff/(sd.length/4*3),grid,luma};
};
// Mean difference and mean stage colour inside the box around some landmarks.
const region=({ids,pad=2})=>{
  const s=document.querySelector('#stage'),v=document.querySelector('#photo').hidden&&document.querySelector('#video').srcObject?document.querySelector('#video'):document.querySelector('#photo');
  const w=s.width,h=s.height,lm=window.testLandmarks;
  const read=source=>{const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(source,0,0,w,h);return x.getImageData(0,0,w,h).data;};
  const sd=read(s),vd=read(v);
  const xs=ids.map(i=>lm[i].x*w),ys=ids.map(i=>lm[i].y*h);
  const x0=Math.max(0,Math.floor(Math.min(...xs)-pad)),x1=Math.min(w,Math.ceil(Math.max(...xs)+pad));
  const y0=Math.max(0,Math.floor(Math.min(...ys)-pad)),y1=Math.min(h,Math.ceil(Math.max(...ys)+pad));
  let d=0,n=0,r=0,g=0,b=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*w+x)*4;
    d+=Math.abs(sd[i]-vd[i])+Math.abs(sd[i+1]-vd[i+1])+Math.abs(sd[i+2]-vd[i+2]);r+=sd[i];g+=sd[i+1];b+=sd[i+2];n++;}
  return {diff:d/n/3,color:[r/n,g/n,b/n]};
};
// Pixels the stage changed outside the landmarks' bounding box (plus a margin).
const outside=({margin})=>{
  const s=document.querySelector('#stage'),v=document.querySelector('#video');
  const w=s.width,h=s.height,lm=window.testLandmarks;
  const read=source=>{const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(source,0,0,w,h);return x.getImageData(0,0,w,h).data;};
  const sd=read(s),vd=read(v);
  const xs=lm.map(l=>l.x*w),ys=lm.map(l=>l.y*h);
  const x0=Math.min(...xs)-margin,x1=Math.max(...xs)+margin,y0=Math.min(...ys)-margin,y1=Math.max(...ys)+margin;
  let n=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x>=x0&&x<=x1&&y>=y0&&y<=y1)continue;
    const i=(y*w+x)*4;if(Math.abs(sd[i]-vd[i])+Math.abs(sd[i+1]-vd[i+1])+Math.abs(sd[i+2]-vd[i+2])>6)n++;
  }
  return n;
};

function changed(base,now,threshold=3){
  const cells=[];
  for(let i=0;i<now.grid.length;i++)if(Math.abs((base?base.grid[i]:0)-now.grid[i])>threshold)cells.push(i);
  if(!cells.length)return {count:0,maxX:0,share:0};
  return {count:cells.length,maxX:Math.max(...cells.map(i=>(i%GX+1)/GX)),share:cells.length/now.grid.length};
}
// The grid method the seam checks use: stage luma against a reference state.
function moved(base,now){
  const cells=[];
  for(let i=0;i<base.luma.length;i++)if(Math.abs(base.luma[i]-now.luma[i])>3)cells.push(i);
  if(!cells.length)return {count:0,maxX:0};
  return {count:cells.length,maxX:Math.max(...cells.map(i=>(i%GX+1)/GX)),share:cells.length/base.luma.length};
}

const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const onScreen=(page,selector)=>page.evaluate(s=>{
  const r=document.querySelector(s).getBoundingClientRect();
  return r.height>0&&r.top>=0&&r.bottom<=innerHeight+1;
},selector);
// A landmark's position on screen: the frame is letterboxed and mirrored.
const screenOf=(page,index)=>page.evaluate(i=>{
  const v=document.querySelector('#viewport').getBoundingClientRect(),s=document.querySelector('#stage');
  const ratio=s.width/s.height;let bw=v.width,bh=v.width/ratio;if(bh>v.height){bh=v.height;bw=v.height*ratio;}
  const l=v.left+(v.width-bw)/2,t=v.top+(v.height-bh)/2,lm=window.testLandmarks;
  return [l+(1-lm[i].x)*bw,t+lm[i].y*bh];
},index);
async function stroke(page,ids){
  const pts=[];for(const i of ids)pts.push(await screenOf(page,i));
  await page.mouse.move(...pts[0]);await page.mouse.down();
  for(const q of pts.slice(1))await page.mouse.move(...q,{steps:8});
  await page.mouse.up();
  await page.waitForTimeout(250);await settle(page);
}
const setSlider=async(page,selector,value)=>{await page.locator(selector).fill(String(value));await page.locator(selector).dispatchEvent('input');};
const LIPS=[61,0,291,17,40,270,91,321];

(async()=>{
  const browser=await launch();
  const report={origin};
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(fakeCamera,{data:fixture});
    await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});

    await page.locator('#start').click();
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:90000});
    await page.waitForFunction(()=>!document.querySelector('#stage').hidden,null,{timeout:20000});
    await settle(page);

    /* ---- makeup on the WebGL stage ---- */
    assert.equal(await page.locator('#webgl-missing').isVisible(),false,'WebGL reported missing');
    const lipsOn=await page.evaluate(region,{ids:LIPS});
    assert(lipsOn.diff>4,`the default lipstick did not colour the lips (${lipsOn.diff.toFixed(2)})`);
    assert.equal(await page.evaluate(outside,{margin:12}),0,'makeup changed pixels away from the face');

    // Every product renders, and none leaks into the eye opening or off the face.
    const productIds=await page.evaluate(()=>[...document.querySelectorAll('[data-product]')].map(b=>b.dataset.product));
    assert(productIds.length>=14,`expected the full Roja range, got ${productIds.length}`);
    report.products={};
    let totalShades=0;
    for(const id of productIds){
      await page.locator('#clear-look').click();
      await page.locator(`[data-product="${id}"]`).click();
      await page.locator('#shades .shade').nth(2).click();
      await page.waitForTimeout(150);await settle(page);
      const shades=await page.locator('#shades .shade').count();
      assert(shades>0,`${id} has no shades`);
      const now=await page.evaluate(probe,{GX,GY});
      const cells=changed(null,now,1).count;
      assert(cells>0,`${id} changed nothing`);
      const eye=await page.evaluate(()=>{
        const s=document.querySelector('#stage'),v=document.querySelector('#video'),w=s.width,h=s.height,lm=window.testLandmarks;
        const read=src=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(src,0,0,w,h);return x;};
        const a=read(s),b=read(v);
        return [[33,133,159,145],[263,362,386,374]].map(ids=>{
          const px=Math.round(ids.reduce((n,i)=>n+lm[i].x,0)/ids.length*w);
          const py=Math.round(ids.reduce((n,i)=>n+lm[i].y,0)/ids.length*h);
          const p=a.getImageData(px,py,1,1).data,q=b.getImageData(px,py,1,1).data;
          return Math.abs(p[0]-q[0])+Math.abs(p[1]-q[1])+Math.abs(p[2]-q[2]);});
      });
      assert(eye.every(d=>d<=3),`${id} put colour in the eye opening (${eye})`);
      assert.equal(await page.evaluate(outside,{margin:12}),0,`${id} changed pixels away from the face`);
      report.products[id]={shades,cells};
      totalShades+=shades;
    }
    report.shadeChoices=totalShades;

    // With nothing on, the stage is the camera frame.
    await page.locator('#clear-look').click();await settle(page);await page.waitForTimeout(150);
    const bare=await page.evaluate(probe,{GX,GY});
    assert(bare.diff<1.5,`bare face differs from the camera by ${bare.diff}`);
    report.bareDiff=Number(bare.diff.toFixed(4));

    /* ---- finishes and realism ---- */
    await page.locator('[data-product="velvet"]').click();
    await page.locator('[data-id="vlv-8"]').click();await page.waitForTimeout(150);await settle(page);
    const red=await page.evaluate(region,{ids:LIPS});
    assert(red.color[0]>red.color[1]*1.35,`a red lipstick did not read as red (${red.color.map(Math.round)})`);
    await page.locator('#natural-blend').uncheck();await page.waitForTimeout(150);await settle(page);
    const flat=await page.evaluate(region,{ids:LIPS});
    assert(Math.abs(flat.diff-red.diff)>0.3,'the skin-texture switch changed nothing');
    await page.locator('#natural-blend').check();
    await page.locator('[data-product="gloss"]').click();
    await page.locator('[data-id="gls-1"]').click();await page.waitForTimeout(150);await settle(page);
    const glossed=await page.evaluate(region,{ids:LIPS});
    assert(Math.abs(glossed.diff-red.diff)>0.3,'a gloss over the lipstick changed nothing');
    await page.locator('#product-toggle').click();          // gloss off again
    report.finishes={red:red.color.map(Math.round),flatDiff:+flat.diff.toFixed(2),glossDiff:+glossed.diff.toFixed(2)};

    /* ---- the brush ---- */
    await page.locator('[data-product="velvet"]').click();
    await page.waitForTimeout(150);await settle(page);
    const painted=(await page.evaluate(region,{ids:LIPS})).diff;
    await page.locator('#brush-toggle').click();
    assert.equal(await page.locator('#brush-toggle').getAttribute('aria-pressed'),'true','the brush did not switch on');
    await page.locator('#brush-modes [data-mode="erase"]').click();
    await setSlider(page,'#brush-size',30);
    await stroke(page,[61,0,291]);await stroke(page,[61,17,291]);
    const erased=(await page.evaluate(region,{ids:LIPS})).diff;
    assert(erased<painted*.45,`erasing left too much colour (${erased.toFixed(2)} of ${painted.toFixed(2)})`);
    // The correction sits on the face, not the screen: slide the face over and it
    // stays erased where the lips now are.
    await page.evaluate(()=>{window.testShift=36;window.testLandmarks=null;});
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:20000});
    await page.waitForTimeout(700);await settle(page);
    const followed=(await page.evaluate(region,{ids:LIPS})).diff;
    assert(followed<painted*.5,`the erased area did not follow the face (${followed.toFixed(2)})`);
    await page.evaluate(()=>{window.testShift=0;window.testLandmarks=null;});
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:20000});
    await page.waitForTimeout(700);await settle(page);
    await page.locator('#brush-undo').click();await page.locator('#brush-undo').click();
    await page.waitForTimeout(150);await settle(page);
    const undone=(await page.evaluate(region,{ids:LIPS})).diff;
    assert(Math.abs(undone-painted)<painted*.15,`undo did not bring the colour back (${undone.toFixed(2)} vs ${painted.toFixed(2)})`);
    await page.locator('#brush-modes [data-mode="fade"]').click();
    await stroke(page,[61,0,291]);
    const faded=(await page.evaluate(region,{ids:LIPS})).diff;
    assert(faded<painted*.95&&faded>erased,`fade was not between full and erased (${faded.toFixed(2)})`);
    await page.locator('#brush-modes [data-mode="restore"]').click();
    await stroke(page,[61,0,291]);
    const restored=(await page.evaluate(region,{ids:LIPS})).diff;
    assert(restored>faded,'restore did not bring the faded colour back');
    await page.locator('#brush-modes [data-mode="blend"]').click();
    const before=await page.evaluate(probe,{GX,GY});
    await stroke(page,[61,146,17]);
    const blended=await page.evaluate(probe,{GX,GY});
    assert(changed(before,blended,.4).count>0,'the blend brush changed nothing');
    await page.locator('#brush-clear').click();
    await page.locator('#brush-toggle').click();
    report.brush={painted:+painted.toFixed(2),erased:+erased.toFixed(2),followed:+followed.toFixed(2),faded:+faded.toFixed(2),restored:+restored.toFixed(2)};

    /* ---- compare: with and without, and two shades side by side ---- */
    const dragSeam=fraction=>page.evaluate(f=>{
      const box=document.querySelector('#viewport').getBoundingClientRect(),s=document.querySelector('#stage');
      const ratio=s.width/s.height;let bw=box.width,bh=box.width/ratio;if(bh>box.height){bh=box.height;bw=box.height*ratio;}
      const left=box.left+(box.width-bw)/2;
      document.querySelector('#seam').dispatchEvent(new PointerEvent('pointerdown',
        {clientX:left+bw*f,clientY:box.top+box.height/2,bubbles:true,pointerId:1}));
    },fraction);
    await page.locator('#compare').click();
    assert.equal(await page.locator('#seam').isVisible(),true,'compare did not show the seam in makeup mode');
    await dragSeam(1);await settle(page);
    assert((await page.evaluate(probe,{GX,GY})).diff<1.5,'the "without makeup" side is not the camera frame');
    await dragSeam(0);await settle(page);
    assert((await page.evaluate(region,{ids:LIPS})).diff>4,'the "with makeup" side lost the makeup');
    await page.locator('#compare').click();
    assert.equal(await page.locator('#seam').isVisible(),false,'the seam stayed after compare was switched off');

    await page.locator('[data-id="vlv-8"]').click();
    await page.locator('#pin-shade').click();
    await page.locator('[data-id="vlv-12"]').click();
    await page.waitForTimeout(150);await settle(page);
    assert.equal(await page.locator('#seam').isVisible(),true,'pinning a shade did not show the seam');
    await dragSeam(1);await settle(page);
    const pinned=await page.evaluate(region,{ids:LIPS});
    await dragSeam(0);await settle(page);
    const current=await page.evaluate(region,{ids:LIPS});
    assert(Math.abs(pinned.color[0]-current.color[0])>12,'the two sides of the shade compare show the same colour');
    assert.equal(await page.locator('#seam-before').textContent(),'قرمز کلاسیک','the pinned shade is not named on its side');
    await page.locator('#pin-shade').click();
    report.shadeCompare={pinned:pinned.color.map(Math.round),current:current.color.map(Math.round)};

    /* ---- looks, the shade finder, lighting, snapshots ---- */
    const lookIds=await page.evaluate(()=>[...document.querySelectorAll('[data-look]')].map(b=>b.dataset.look));
    assert(lookIds.length>=5,'the ready-made looks are missing');
    report.looks={};
    for(const id of lookIds){
      await page.locator(`[data-look="${id}"]`).click();
      await page.waitForTimeout(250);await settle(page);
      const on=await page.locator('#look-items .look-chip').count();
      assert(on>=4,`look ${id} put only ${on} products on`);
      assert(changed(null,await page.evaluate(probe,{GX,GY}),1).count>3,`look ${id} changed too little`);
      report.looks[id]=on;
    }
    await page.waitForFunction(()=>!document.querySelector('#finder-run')?.disabled,null,{timeout:20000}).catch(()=>{});
    await page.locator('[data-product="foundation"]').click();
    await page.locator('#finder-run').click();
    await page.waitForFunction(()=>document.querySelectorAll('#finder-result .pick').length>=3,null,{timeout:30000});
    report.finder=(await page.locator('#finder-result .pick').first().textContent()).trim();

    await page.locator('#clear-look').click();await settle(page);
    await page.locator('#light-toggle').click();
    await page.locator('#light-menu button',{hasText:'آفتاب عصر'}).click();
    await page.waitForTimeout(100);await settle(page);
    assert((await page.evaluate(probe,{GX,GY})).diff>3,'the lighting preview changed nothing');
    await page.locator('#light-toggle').click();
    await page.locator('#light-menu button',{hasText:'نور فعلی'}).click();
    await page.waitForTimeout(100);await settle(page);
    assert((await page.evaluate(probe,{GX,GY})).diff<1.5,'the lighting preview did not switch back off');

    await page.locator('[data-product="velvet"]').click();
    await page.locator('#snap').click();
    await page.waitForFunction(()=>document.querySelector('#shots-count').textContent!=='۰',null,{timeout:10000});
    await page.locator('#gallery-open').click();
    assert.equal(await page.locator('#gallery-shots img').count(),1,'the snapshot is not in the gallery');
    await page.locator('#gallery-close').click();

    /* ---- the mirror must not resize when the panel's content changes ---- */
    // Regression: the detail panel used to stretch the document, so a product with
    // more shades made the page taller and the mirror grew with it.
    const stageHeights=[];
    for(const id of productIds){
      await page.locator(`[data-product="${id}"]`).click();
      await settle(page);
      stageHeights.push(await page.evaluate(()=>Math.round(document.querySelector('#viewport').getBoundingClientRect().height)));
    }
    assert.equal(new Set(stageHeights).size,1,`the mirror resized between products: ${stageHeights.join(', ')}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false,'the desktop page scrolls');
    report.stageHeight=stageHeights[0];

    // The panel is the only scroller, so its controls must still be reachable.
    const reachable=await page.evaluate(()=>{
      const panel=document.querySelector('#inspector'), add=document.querySelector('#add');
      add.scrollIntoView({block:'nearest'});
      const r=add.getBoundingClientRect(), p=panel.getBoundingClientRect();
      const ok=r.top>=p.top-1&&r.bottom<=p.bottom+1;
      panel.scrollTop=0;
      return ok;
    });
    assert(reachable,'the add-to-cart button cannot be scrolled into view');

    /* ---- the debug overlay's landmark maps must not fall behind the code ---- */
    {
      const read=f=>fs.readFileSync(path.join(siteRoot,f),'utf8');
      const between=(src,open,close)=>{
        const a=src.indexOf(open);
        return src.slice(a+open.length,src.indexOf(close,a+open.length));
      };
      const nums=text=>(text.match(/[0-9]+/g)||[]).map(Number);
      // every p(N) call, found without a regex so no escape can be lost in transit
      const anchors=src=>{
        const out=[];let i=0;
        while((i=src.indexOf('p(',i))>=0){
          const close=src.indexOf(')',i);
          const inner=src.slice(i+2,close);
          if(/^[0-9]+$/.test(inner))out.push(Number(inner));
          i=close+1;
        }
        return [...new Set(out)];
      };
      const tagged=(src,tokens)=>{
        const out=[];
        for(const token of tokens){let i=0;
          while((i=src.indexOf(token,i))>=0){
            const digits=(src.slice(i+token.length).match(/^[0-9]+/)||[''])[0];
            if(digits)out.push(Number(digits));
            i+=token.length;
          }}
        return out;
      };

      const deform=read('deform.js');
      const declared=nums(between(deform,'controlLandmarks={','};'))
        .concat(nums(between(deform,'frameLandmarks=[',']')));
      const stale=anchors(deform).filter(i=>!declared.includes(i));
      assert.deepEqual(stale,[],`deform.js anchors on ${stale} but controlLandmarks omits them`);

      // makeup.js: every landmark it reads must be in some layer's list.
      const byType=await page.evaluate(async()=>{const m=await import('./makeup.js?v=13');
        return [...new Set([...Object.values(m.landmarksByType).flat(),...m.frameLandmarks])];});
      const makeup=read('makeup.js');
      const loose=[...new Set([...anchors(makeup),
        ...tagged(makeup,['eye:','mouth:','edge:','ear:','top:','bottom:','under:','bone:','low:','landmarks['])])];
      const staleLoose=loose.filter(i=>!byType.includes(i));
      assert.deepEqual(staleLoose,[],`makeup.js reads ${staleLoose} but landmarksByType omits them`);
      report.landmarkMaps='in step with the code';
    }

    /* ---- procedures ---- */
    await page.locator('#clear-look').click();
    await page.locator('#mode-procedure').click();
    await page.waitForFunction(()=>{const s=document.querySelector('#stage');return !s.hidden&&s.width>0;},null,{timeout:20000});
    assert.equal(await page.locator('#badge').isVisible(),true,'simulation badge missing');

    const identity=await page.evaluate(probe,{GX,GY});
    assert(identity.diff<1.5,`identity differs from source by ${identity.diff}`);
    report.identityDiff=Number(identity.diff.toFixed(4));

    const ids=await page.evaluate(()=>[...document.querySelectorAll('[data-procedure]')].map(b=>b.dataset.procedure));
    assert(ids.length>=16,`expected the full procedure tray, got ${ids.length}`);
    report.procedures={};
    for(const id of ids){
      await page.locator(`[data-procedure="${id}"]`).click();
      await setSlider(page,'#strength',100);
      await page.waitForTimeout(80);await settle(page);
      const spot=changed(identity,await page.evaluate(probe,{GX,GY}),.8);
      assert(spot.count>0,`${id} changed nothing`);
      assert(spot.share<0.5,`${id} changed ${Math.round(spot.share*100)}% of the frame`);
      assert.equal(await page.locator('#procedure-facts').isVisible(),true,`${id} shows no facts`);
      report.procedures[id]=spot.count;
      await page.locator('#procedure-reset').click();
      await settle(page);
      assert(changed(identity,await page.evaluate(probe,{GX,GY}),.8).count===0,`${id} did not reset`);
    }

    // Variants change the result, and the measurements report the change.
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await setSlider(page,'#strength',100);
    await page.locator('#variant-options [data-variant="natural"]').click();await settle(page);
    const natural=(await page.evaluate(region,{ids:[1,2,64,294,98,327],pad:10})).diff;
    await page.locator('#variant-options [data-variant="fantasy"]').click();await settle(page);
    const fantasy=(await page.evaluate(region,{ids:[1,2,64,294,98,327],pad:10})).diff;
    assert(fantasy>natural,`the fantasy rhinoplasty is not a bigger change than the natural one (${fantasy} vs ${natural})`);
    await page.waitForTimeout(300);
    const noseRow=await page.evaluate(()=>{
      const cells=[...document.querySelectorAll('#measure-table span')];
      const i=cells.findIndex(c=>c.textContent==='پهنای پرهٔ بینی');
      return i<0?null:{changed:cells[i].classList.contains('changed'),change:cells[i+3].textContent};
    });
    assert(noseRow&&noseRow.changed,'the measurements did not register a narrower nose');
    report.variants={natural:+natural.toFixed(2),fantasy:+fantasy.toFixed(2),noseWidth:noseRow.change};
    await page.locator('#procedure-reset').click();

    // Makeup can stay on during a procedure.
    await page.locator('#with-makeup').check();
    await page.locator('#mode-makeup').click();await page.locator('[data-product="velvet"]').click();
    await page.locator('#mode-procedure').click();await settle(page);await page.waitForTimeout(150);
    assert((await page.evaluate(region,{ids:LIPS})).diff>4,'"keep makeup on" did not show the makeup in procedure mode');
    await page.locator('#with-makeup').uncheck();await settle(page);await page.waitForTimeout(150);
    assert((await page.evaluate(probe,{GX,GY})).diff<1.5,'makeup stayed after "keep makeup on" was cleared');

    // The seam: "before" fills from the left edge, so dragging it right hides more.
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await setSlider(page,'#strength',100);
    await settle(page);
    await dragSeam(0.5);await settle(page);
    const half=moved(identity,await page.evaluate(probe,{GX,GY}));
    assert(half.count>0,'the seam hid the whole result at the half-way point');
    assert(half.maxX<=0.56,`warped pixels leaked past the seam (to ${half.maxX})`);
    await dragSeam(0.04);await settle(page);
    const mostlyAfter=moved(identity,await page.evaluate(probe,{GX,GY}));
    await dragSeam(0.96);await settle(page);
    const mostlyBefore=moved(identity,await page.evaluate(probe,{GX,GY}));
    assert(mostlyAfter.count>0,'nothing visible with the seam at the "after" end');
    assert.equal(mostlyBefore.count,0,'dragging to "before" left warped pixels on screen');
    assert(mostlyAfter.count>=half.count&&half.count>=mostlyBefore.count,'the seam is not monotonic');
    report.seam={after:mostlyAfter.count,half:half.count,before:mostlyBefore.count};

    // The drawn line must sit exactly on the cut. `object-fit:contain` letterboxes the
    // frame, and measuring the seam against the element instead of the frame made the
    // two use different scales — they agreed only at dead centre, and were ~70px apart
    // near the edges. Checked by finding the cut in the pixels, not from a formula.
    for(const id of ['jaw-contour','cheek-filler','brow-lift','lip-filler']){
      await page.locator(`[data-procedure="${id}"]`).click();
      await setSlider(page,'#strength',100);
    }
    const keep=key=>page.evaluate(k=>{
      const s=document.querySelector('#stage');
      const c=document.createElement('canvas');c.width=s.width;c.height=s.height;
      const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(s,0,0);
      window[k]=x.getImageData(0,0,c.width,c.height);
    },key);
    await dragSeam(0);await settle(page);await keep('__full');      // nothing hidden
    await dragSeam(1);await settle(page);await keep('__ident');     // everything hidden

    const alignment=()=>page.evaluate(()=>{
      const s=document.querySelector('#stage');
      const c=document.createElement('canvas');c.width=s.width;c.height=s.height;
      const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(s,0,0);
      const now=x.getImageData(0,0,c.width,c.height);
      const {__full:full,__ident:ident}=window, w=c.width, h=c.height;
      const spread=(A,B,px)=>{let m=0;for(let y=0;y<h;y+=2){const i=(y*w+px)*4;
        for(let k=0;k<3;k++){const v=Math.abs(A.data[i+k]-B.data[i+k]);if(v>m)m=v;}}return m;};
      let cut=-1;
      for(let px=0;px<w;px++){
        if(spread(full,ident,px)<=18)continue;                 // the warp is invisible here
        if(spread(now,full,px)<spread(now,ident,px))cut=px;    // this column shows the warp
      }
      if(cut<0)return null;
      const vp=document.querySelector('#viewport').getBoundingClientRect();
      const v=document.querySelector('#video');
      const ratio=v.videoWidth/v.videoHeight;
      let bw=vp.width,bh=vp.width/ratio;
      if(bh>vp.height){bh=vp.height;bw=vp.height*ratio;}
      const left=(vp.width-bw)/2;
      // The canvas is mirrored in CSS, so canvas x maps to the far side of the frame.
      const cutScreen=left+bw-((cut+1)/w)*bw;
      const lineScreen=document.querySelector('#seam-line').getBoundingClientRect().left-vp.left;
      return Math.round(cutScreen-lineScreen);
    });
    const offsets=[];
    for(const f of [0.46,0.50,0.54,0.58,0.62]){
      await dragSeam(f);await settle(page);
      const offset=await alignment();
      assert.notEqual(offset,null,`could not locate the cut at ${f}`);
      offsets.push(offset);
    }
    const worst=Math.max(...offsets.map(Math.abs));
    assert(worst<=4,`the seam line is ${worst}px away from the cut (${offsets.join(', ')})`);
    report.seamAlignmentPx=worst;
    await page.locator('#procedure-reset').click();
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await setSlider(page,'#strength',100);
    await settle(page);

    // Losing the face must not leave a warped frame behind.
    await page.evaluate(()=>window.testBlank=true);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('صورت پیدا نشد'),null,{timeout:20000});
    await settle(page);
    assert((await page.evaluate(probe,{GX,GY})).diff<1.5,'stale warp after the face was lost');
    await page.evaluate(()=>{window.testBlank=false;window.testLandmarks=null;});
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:20000});
    await page.locator('#procedure-reset').click();

    /* ---- back to makeup ---- */
    await page.locator('#mode-makeup').click();await settle(page);
    await page.locator('[data-product="velvet"]').click();
    await page.waitForTimeout(150);await settle(page);
    assert((await page.evaluate(region,{ids:LIPS})).diff>4,'makeup stopped rendering after the procedure mode');
    await page.locator('#shades .shade').nth(1).click();
    await page.locator('#add').click();
    await page.locator('#basket').click();
    assert.equal(await page.locator('.cart-row').count(),1,'cart did not record the shade');
    await page.locator('.cart-row .qty button').nth(1).click();
    assert.equal(await page.locator('.cart-row .qty span').textContent(),'۲','the quantity did not go up');
    assert.equal(await page.locator('#cart-total').isVisible(),true,'the cart shows no total');
    await page.locator('#close').click();

    /* ---- debug overlay ---- */
    assert.equal(await page.locator('#debug').isVisible(),false,'debug overlay on by default');

    // Start from a known state: clear the look, then switch on one lipstick.
    await page.locator('#clear-look').click();
    await page.locator('[data-product="velvet"]').click();
    await page.locator('#shades .shade').nth(0).click();
    await settle(page);

    // The colour of the dot drawn exactly on a given landmark.
    const dotAt=index=>page.evaluate(i=>{
      const c=document.querySelector('#debug');
      if(c.hidden)return 'hidden';
      const lm=window.testLandmarks;
      const x=Math.round(lm[i].x*c.width),y=Math.round(lm[i].y*c.height);
      const d=c.getContext('2d').getImageData(x,y,1,1).data;
      if(!d[3])return 'none';
      return d[0]>200&&d[1]>150&&d[2]<120?'active':'plain';
    },index);
    const debugPixels=()=>page.evaluate(()=>{
      const c=document.querySelector('#debug');
      if(c.hidden)return 0;
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;
    });

    await page.locator('#debug-panel summary').click();     // the panel starts collapsed
    await page.locator('#debug-on').check();
    await setSlider(page,'#debug-size',0);                  // dots only, so labels never sit on the pixel we sample
    await page.waitForTimeout(350);await settle(page);
    assert.equal(await page.locator('#debug').isVisible(),true,'debug overlay did not appear');
    const dotsOnly=await debugPixels();
    assert(dotsOnly>0,'debug overlay painted nothing');

    // A lipstick is on: the lip contour is live, the eyelid is not.
    assert.equal(await dotAt(13),'active','the lip contour is not marked while a lipstick is on');
    assert.equal(await dotAt(386),'plain','the eyelid is marked with no eyeshadow on');
    await page.locator('[data-product="shadow"]').click();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(386),'active','the eyelid is not marked with an eyeshadow on');

    // Extra layers each add to the overlay.
    for(const layer of ['mesh','contours','axes','masks']){
      const base=await debugPixels();
      await page.locator(`#debug-${layer}`).check();
      await page.waitForTimeout(350);await settle(page);
      assert(await debugPixels()>base,`the ${layer} layer drew nothing`);
      await page.locator(`#debug-${layer}`).uncheck();
    }
    await page.locator('#debug-find').fill('1');
    await page.waitForTimeout(300);await settle(page);
    assert((await page.locator('#debug-find-info').textContent()).includes('۱'),'finding a landmark reported nothing');
    await page.locator('#debug-find').fill('');

    // Procedures highlight the region they move, and nothing else.
    await page.locator('#mode-procedure').click();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'plain','the nose is marked with no procedure applied');
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await setSlider(page,'#strength',100);
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'active','rhinoplasty did not mark the nose');
    assert.equal(await dotAt(0),'plain','rhinoplasty marked the lip');
    await page.locator('[data-procedure="lip-filler"]').click();
    await setSlider(page,'#strength',100);
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(0),'active','the lip filler did not mark the lip');
    assert.equal(await dotAt(1),'active','the nose stopped being marked');
    {
      const base=await debugPixels();
      await page.locator('#debug-field').check();
      await page.waitForTimeout(350);await settle(page);
      assert(await debugPixels()>base,'the displacement field drew nothing');
      await page.locator('#debug-field').uncheck();
    }

    // Labels respond to the slider, and the filter narrows the overlay.
    await setSlider(page,'#debug-size',16);
    await page.waitForTimeout(300);await settle(page);
    const withLabels=await debugPixels();
    assert(withLabels>dotsOnly,'the label size slider changed nothing');
    await page.locator('#debug-only').check();
    await page.waitForTimeout(300);await settle(page);
    const narrowed=await debugPixels();
    assert(narrowed<withLabels,'"active only" did not reduce the overlay');
    assert.equal(await dotAt(1),'active','the nose vanished under "active only"');
    await page.locator('#debug-only').uncheck();

    // Highlighting off leaves the points but drops the second colour.
    await page.locator('#debug-highlight').uncheck();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'plain','the active colour survived turning highlighting off');
    await page.locator('#debug-highlight').check();

    // The live readout and the export.
    await page.locator('#debug-hud').check();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#hud').isVisible(),true,'the live readout did not appear');
    assert((await page.locator('#debug-stats').textContent()).includes('WebGL'),'the stats do not name the renderer');
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#debug-export').click()]);
    const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert(exported.landmarks&&exported.landmarks.length>=468,'the export has no landmarks');
    assert(exported.procedures.active.rhinoplasty===100,'the export does not record the procedures');
    await page.locator('#debug-hud').uncheck();

    await page.locator('#procedure-reset').click();
    await page.locator('#mode-makeup').click();await settle(page);
    assert((await page.evaluate(region,{ids:LIPS})).diff>2,'makeup stopped rendering with the debug overlay on');
    report.debug={dotsOnly,withLabels,narrowed};
    await page.locator('#debug-on').uncheck();
    await settle(page);
    assert.equal(await page.locator('#debug').isVisible(),false,'debug overlay stayed on');

    /* ---- the phone layout: the mirror and its control share one screen ---- */
    await page.setViewportSize({width:390,height:844});
    await settle(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal scroll at 390px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false,'the page scrolls on a phone');
    assert(await onScreen(page,'#viewport'),'the mirror is not fully visible on a phone');
    assert(await onScreen(page,'#shades'),'the shade row is off-screen on a phone');
    assert(await onScreen(page,'#tray'),'the product tray is off-screen on a phone');
    assert(await onScreen(page,'#toolbar'),'the mirror tools are off-screen on a phone');
    // Changing a shade must not move the mirror.
    const top0=await page.evaluate(()=>document.querySelector('#viewport').getBoundingClientRect().top);
    await page.locator('#shades .shade').nth(2).click();
    await settle(page);
    const top1=await page.evaluate(()=>document.querySelector('#viewport').getBoundingClientRect().top);
    assert.equal(top0,top1,'picking a shade moved the mirror');

    await page.locator('#mode-procedure').click();
    await page.locator('[data-procedure="lip-filler"]').click();
    await settle(page);
    assert(await onScreen(page,'#viewport'),'the mirror is not visible in procedure mode on a phone');
    assert(await onScreen(page,'#strength'),'the amount slider is off-screen on a phone');
    await page.locator('#procedure-reset').click();
    await page.locator('#mode-makeup').click();
    report.phone='mirror and controls share one screen';
    await page.setViewportSize({width:1440,height:960});

    await page.locator('#stop').click();
    assert(await page.evaluate(()=>window.testStream.getTracks().every(t=>t.readyState==='ended')),'camera tracks left running');

    /* ---- a photo instead of the camera ---- */
    // The test portrait with a red corner, so its orientation on screen can be read.
    const marked=Buffer.from((await page.evaluate(async data=>{
      const im=new Image();im.src=data;await im.decode();
      const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');
      x.drawImage(im,0,0);x.fillStyle='#f00';x.fillRect(0,0,24,24);
      return c.toDataURL('image/png');
    },fixture)).split(',')[1],'base64');
    await page.evaluate(()=>{window.testLandmarks=null;});
    await page.locator('#photo-input').setInputFiles({name:'face.png',mimeType:'image/png',buffer:marked});
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:60000});
    await page.waitForTimeout(800);await settle(page);
    assert.equal(await page.locator('#welcome').isVisible(),false,'the photo did not open');
    // Regression: stopping the camera loses the WebGL context, and reusing its canvas
    // dropped the next source to the 2D fallback.
    assert.equal(await page.locator('#stage').isVisible(),true,'the photo fell back to the 2D path after a camera session');
    assert.equal(await page.locator('#webgl-missing').isVisible(),false,'WebGL reported missing after a camera session');
    assert.equal(await page.locator('#freeze').isDisabled(),true,'freeze is offered for a still photo');
    assert((await page.evaluate(region,{ids:LIPS})).diff>4,'makeup did not render on the photo');
    // The photo is shown the right way round. The stage is mirrored in CSS like a
    // selfie camera, so the photo's top-left corner must sit top-right on the canvas.
    const orientation=await page.evaluate(()=>{
      const s=document.querySelector('#stage'),c=document.createElement('canvas');c.width=s.width;c.height=s.height;
      const x=c.getContext('2d');x.drawImage(s,0,0);
      const red=(px,py)=>{const d=x.getImageData(px,py,1,1).data;return d[0]>200&&d[1]<60&&d[2]<60;};
      return red(s.width-4,4)&&!red(4,4)?'shown as taken':'mirrored';
    });
    assert.equal(orientation,'shown as taken','the photo is shown mirrored');
    await page.locator('#stop').click();
    assert.equal(await page.locator('#welcome').isVisible(),true,'closing the photo did not return to the start');
    report.photo='opens, renders, closes';

    // Clicking the mark reloads the page.
    assert.equal(await page.evaluate(()=>{
      const a=document.querySelector('.brand');
      if(a.tagName!=='A')return 'not a link';
      // Must point at the app's own root, not the domain root: on a project page
      // the app lives under /<repo>/ and an absolute "/" would navigate away.
      return a.href===new URL('./',location.href).href?'app root':a.href;
    }),'app root','the brand does not link to the app root');
    await page.evaluate(()=>{window.__beforeReload=1;});
    await page.locator('.brand').click();
    await page.waitForFunction(()=>typeof window.__beforeReload==='undefined',null,{timeout:15000});
    assert.equal(await page.locator('#welcome').isVisible(),true,'the page did not come back up after reloading');
    report.brandReload='reloads';

    assert.deepEqual(errors,[],'page errors during the main run');

    /* ---- a device without WebGL keeps makeup working ---- */
    const plain=await browser.newPage({viewport:{width:1280,height:900}});
    const plainErrors=[];plain.on('pageerror',e=>plainErrors.push(e.message));
    await plain.addInitScript(()=>{const real=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...rest){return String(type).includes('webgl')?null:real.call(this,type,...rest);};});
    await plain.addInitScript(fakeCamera,{data:fixture});
    await plain.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});
    await plain.locator('#start').click();
    await plain.waitForFunction(()=>window.testLandmarks,null,{timeout:90000});
    await plain.locator('#mode-procedure').click();
    await plain.waitForFunction(()=>!document.querySelector('#webgl-missing').hidden,null,{timeout:20000});
    assert.equal(await plain.locator('#stage').isVisible(),false,'stage shown without WebGL');
    await plain.locator('#mode-makeup').click();
    await plain.waitForTimeout(300);
    const fallbackPixels=await plain.evaluate(()=>{const c=document.querySelector('#overlay');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
    assert(fallbackPixels>0,'makeup broken on a device without WebGL');
    assert.deepEqual(plainErrors,[],'page errors in the fallback run');
    report.fallbackPixels=fallbackPixels;

    /* ---- iPhone-like browsers ---- */
    // Every iPhone browser is WebKit. Three things it does differently, simulated here:
    // a worker that cannot start MediaPipe (no WebGL in workers before iOS 17), a
    // video.play() refused without a fresh tap (seen in Chrome on iPhone), and a muted
    // video that is paused as soon as it is hidden (so it must never be hidden).
    {
      const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      const phoneErrors=[];phone.on('pageerror',e=>phoneErrors.push(e.message));
      await phone.addInitScript(fakeCamera,{data:fixture});
      await phone.addInitScript(()=>{
        window.Worker=class{
          constructor(){setTimeout(()=>this.onmessage?.({data:{type:'error',stage:'init',message:'no WebGL in workers'}}),30);}
          postMessage(){}
          terminate(){}
        };
        const play=HTMLMediaElement.prototype.play;let refused=false;
        HTMLMediaElement.prototype.play=function(){
          if(!refused){refused=true;return Promise.reject(new DOMException('needs a tap','NotAllowedError'));}
          return play.call(this);
        };
      });
      await phone.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});
      await phone.locator('#start').click();
      await phone.waitForFunction(()=>document.querySelector('#welcome').hidden,null,{timeout:30000});
      assert.equal(await phone.locator('#tap-start').isVisible(),true,'no tap-to-start when play() was refused');
      await phone.locator('#tap-start').click();
      await phone.waitForFunction(()=>document.querySelector('#tap-start').hidden,null,{timeout:10000});
      // Tracked on the page itself: the guide goes when the face is found.
      await phone.waitForFunction(()=>document.querySelector('#guide').hidden&&!document.querySelector('#stage').hidden,null,{timeout:120000});
      assert.equal(await phone.evaluate(()=>getComputedStyle(document.querySelector('#video')).visibility),'visible','the camera video was hidden while live');
      await phone.locator('#shades .shade').nth(7).click();              // a strong red
      await phone.waitForTimeout(600);
      const cells=changed(null,await phone.evaluate(probe,{GX,GY}),1).count;
      assert(cells>0,'no makeup with tracking on the page itself');
      await phone.evaluate(()=>document.querySelector('#debug-panel').open=true);
      await phone.waitForTimeout(400);
      assert((await phone.locator('#debug-stats').textContent()).includes('main thread'),'the stats do not say tracking fell back to the page');
      assert.deepEqual(phoneErrors,[],'page errors in the iPhone-like run');
      report.iphoneLike={makeupCells:cells,tracker:'main thread'};
      await phone.close();
    }

    /* ---- the fast path, and frames in step ---- */
    // The model on the GPU, camera frames handed over as VideoFrames, and each frame
    // shown with its own landmarks; then the same showing-in-step on the CPU route
    // iPhones take, where the frame kept is an ImageBitmap. This browser only emulates
    // a GPU, so the tracker would rightly choose the CPU: ?gpu=force makes it take the
    // GPU anyway, and ?sync=always shows frames in step although the tracker here is
    // too slow for that to be chosen. What is checked is that both work.
    report.inStep={};
    let recorded=null;                  // landmarks from a real run, for the app's stand-in below
    for(const [name,query,engine] of [['gpu','?gpu=force&sync=always','GPU'],['cpu','?gpu=0&sync=always','CPU']]){
      const fast=await browser.newPage({viewport:{width:1280,height:800}});
      const fastErrors=[];fast.on('pageerror',e=>fastErrors.push(e.message));
      await fast.addInitScript(fakeCamera,{data:fixture});
      await fast.goto(origin+'/index.html'+query,{waitUntil:'domcontentloaded',timeout:60000});
      await fast.locator('#start').click();
      await fast.waitForFunction(()=>document.querySelector('#guide').hidden&&!document.querySelector('#stage').hidden,null,{timeout:180000});
      await fast.evaluate(()=>document.querySelector('#debug-panel').open=true);
      await fast.waitForTimeout(1800);
      const stats=await fast.locator('#debug-stats').textContent();
      assert(stats.includes(engine),`${name}: the model is not on the ${engine}: ${stats}`);
      assert(stats.includes('فریم و نقاط هم‌زمان'),`${name}: frames are not shown with their own landmarks: ${stats}`);
      // With nothing on, the shown frame is the camera's picture.
      await fast.locator('#clear-look').click();await fast.waitForTimeout(1200);
      const plain=await fast.evaluate(probe,{GX,GY});
      assert(plain.diff<.5,`${name}: the frame shown differs from the camera by ${plain.diff.toFixed(2)}`);
      await fast.locator('#shades .shade').nth(7).click();
      await fast.waitForTimeout(1500);
      const cells=changed(null,await fast.evaluate(probe,{GX,GY}),1).count;
      assert(cells>0,`${name}: no makeup with frames in step`);
      assert.deepEqual(fastErrors,[],`${name}: page errors with frames in step`);
      report.inStep[name]={makeupCells:cells,plainDiff:+plain.diff.toFixed(3)};
      recorded=recorded||await fast.evaluate(()=>window.testLandmarks?.flatMap(q=>[q.x,q.y,q.z||0])||null);
      await fast.close();
    }

    /* ---- the Android app's native mirror, from the page's side ---- */
    // Inside the app the live camera, the tracking and the drawing are native, under
    // the page. Here a stand-in bridge answers as the app does, with landmarks from a
    // real tracking run, and records what the page sends it.
    {
      const lm=recorded;
      assert(lm&&lm.length>=468*3,'no landmarks recorded for the app stand-in');
      const app=await browser.newPage({viewport:{width:1280,height:800}});
      const appErrors=[];app.on('pageerror',e=>appErrors.push(e.message));
      await app.addInitScript(({lm})=>{
        const calls=window.nativeCalls={start:0,stop:0,place:[],plan:[],masks:{},keep:[],freeze:[],snap:0,skin:[],extras:[]};
        let timer=null;
        window.RojaAndroid={
          saveFile(){return 'saved';},keepScreenOn(){},version(){return 'test';},
          nativeMirror(){return true;},
          mirrorStart(){calls.start++;setTimeout(()=>{window.rojaNative.onStart(640,480);
            timer=setInterval(()=>window.rojaNative.onFrame({lm,size:[640,480],st:{hz:30,fps:30,infer:12,draw:3,delegate:'GPU',note:'',gpu:'Test GPU'}}),50);},100);},
          mirrorStop(){calls.stop++;clearInterval(timer);},
          mirrorFreeze(on){calls.freeze.push(on);},
          mirrorPlace(json){calls.place.push(JSON.parse(json));},
          mirrorPlan(json){calls.plan.push(JSON.parse(json));},
          mirrorMask(key,box,w,h,alpha){calls.masks[key]={box:JSON.parse(box),w,h,bytes:atob(alpha).length};},
          mirrorKeep(json){calls.keep.push(JSON.parse(json));},
          mirrorSkin(on){calls.skin.push(on);},mirrorExtras(on){calls.extras.push(on);},
          mirrorSnapshot(){calls.snap++;const c=document.createElement('canvas');c.width=640;c.height=480;
            c.getContext('2d').fillRect(0,0,10,10);setTimeout(()=>window.rojaNative.onSnapshot(c.toDataURL()),30);}
        };
      },{lm});
      await app.goto(origin+'/index.html',{waitUntil:'domcontentloaded',timeout:60000});
      await app.locator('#start').click();
      await app.waitForFunction(()=>document.querySelector('#guide').hidden&&window.rojaState?.().native,null,{timeout:20000});
      await app.waitForTimeout(400);
      const calls=()=>app.evaluate(()=>window.nativeCalls);
      let c=await calls();
      assert.equal(c.start,1,'the page did not start the native camera');
      assert.equal(await app.evaluate(()=>document.documentElement.classList.contains('native-live')),true,'no hole left for the native mirror');
      assert.notEqual(await app.evaluate(()=>getComputedStyle(document.body,'::before').webkitMaskImage||getComputedStyle(document.body,'::before').maskImage),'none','the page ground has no hole');
      const place=c.place[c.place.length-1];
      assert(place&&place.w>100&&place.pw>100&&place.pw<=place.w&&place.ph<=place.h,'the mirror was not placed: '+JSON.stringify(place));
      const lip=Object.entries(c.masks).find(([k])=>k==='velvet');
      assert(lip&&lip[1].bytes===lip[1].w*lip[1].h&&lip[1].box[2]>0,'the lipstick mask did not reach the app whole');
      const last=()=>c.plan[c.plan.length-1];
      assert(last().after.some(l=>l.key==='velvet'&&l.radiusK>0),'the plan has no lipstick layer');
      assert.equal(last().before,null,'a before side with nothing to compare');
      // Compare: a before side and a seam.
      await app.locator('#compare').click();await app.waitForTimeout(300);c=await calls();
      assert(Array.isArray(last().before)&&typeof last().seam==='number','compare sent no before side and seam');
      await app.locator('#compare').click();
      // A procedure: amounts for the renderer's warp.
      await app.locator('#mode-procedure').click();
      await app.locator('[data-procedure="rhinoplasty"]').click();
      await setSlider(app,'#strength',100);await app.waitForTimeout(300);c=await calls();
      assert(Object.entries(last().amounts||{}).some(([k,v])=>k.startsWith('nose')&&v!==0),'the procedure sent no amounts');
      await app.locator('#mode-makeup').click();
      // Snapshot, freeze and the readout go through the app.
      await app.locator('#snap').click();
      await app.waitForFunction(()=>document.querySelector('#shots-count').textContent==='۱',null,{timeout:5000});
      await app.locator('#freeze').click();await app.waitForTimeout(100);c=await calls();
      assert.deepEqual(c.freeze,[true],'freeze did not reach the app');
      await app.locator('#freeze').click();
      await app.evaluate(()=>document.querySelector('#debug-panel').open=true);await app.waitForTimeout(400);
      assert((await app.locator('#debug-stats').textContent()).includes('native'),'the stats do not say the mirror is native');
      await app.locator('#stop').click();await app.waitForTimeout(200);c=await calls();
      assert(c.stop>=1,'stopping did not stop the native camera');
      assert.equal(await app.evaluate(()=>document.documentElement.classList.contains('native-live')),false,'the hole stayed after stopping');
      assert.deepEqual(appErrors,[],'page errors with the native mirror');
      report.nativeMirror={masks:Object.keys(c.masks).length,plans:c.plan.length,placed:c.place.length};
      await app.close();
    }

    report.errors=[];
    console.log(JSON.stringify(report,null,1));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
