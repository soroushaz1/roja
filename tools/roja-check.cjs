// Browser checks for Roja: makeup, procedures, the debug overlay and the phone layout.
//
//   node tools/preview.cjs      # in one terminal
//   node tools/roja-check.cjs   # in another
//
// Set ROJA_URL to point it at a deployed copy instead of the local server.
const {chromium}=require('C:/Users/sorou/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const siteRoot=path.resolve(__dirname,'..');
const origin=process.env.ROJA_URL||'http://127.0.0.1:4173';
const fixture='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'face-test.png')).toString('base64');
const GX=32,GY=24;

const fakeCamera=({data})=>{
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='result')window.testLandmarks=e.data.landmarks;});}};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
    const image=new Image();image.src=data;await image.decode();
    const c=document.createElement('canvas');c.width=640;c.height=480;
    const ctx=c.getContext('2d');window.testBlank=false;
    const draw=()=>{ctx.fillStyle='#777';ctx.fillRect(0,0,640,480);if(!window.testBlank)ctx.drawImage(image,100,0,300,300,80,0,480,480);};
    draw();window.testTimer=setInterval(draw,70);window.testStream=c.captureStream(15);return window.testStream;
  }});
};

const probe=({GX,GY})=>{
  const s=document.querySelector('#stage'),v=document.querySelector('#video'),w=s.width,h=s.height;
  const read=source=>{const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(source,0,0,w,h);
    return x.getImageData(0,0,w,h).data;};
  const sd=read(s),vd=read(v);
  let diff=0;for(let i=0;i<sd.length;i+=4)diff+=Math.abs(sd[i]-vd[i])+Math.abs(sd[i+1]-vd[i+1])+Math.abs(sd[i+2]-vd[i+2]);
  const grid=[];
  for(let gy=0;gy<GY;gy++)for(let gx=0;gx<GX;gx++){
    const x0=Math.floor(gx*w/GX),x1=Math.floor((gx+1)*w/GX),y0=Math.floor(gy*h/GY),y1=Math.floor((gy+1)*h/GY);
    let sum=0,n=0;
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const i=(y*w+x)*4;sum+=sd[i]*.299+sd[i+1]*.587+sd[i+2]*.114;n++;}
    grid.push(sum/n);
  }
  return {w,h,diff:diff/(sd.length/4*3),grid};
};

function changed(base,now){
  const cells=[];
  for(let i=0;i<base.grid.length;i++)if(Math.abs(base.grid[i]-now.grid[i])>3)cells.push(i);
  if(!cells.length)return {count:0,maxX:0};
  return {count:cells.length,maxX:Math.max(...cells.map(i=>(i%GX+1)/GX)),share:cells.length/base.grid.length};
}

const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const onScreen=(page,selector)=>page.evaluate(s=>{
  const r=document.querySelector(s).getBoundingClientRect();
  return r.height>0&&r.top>=0&&r.bottom<=innerHeight+1;
},selector);

(async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const report={origin};
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(fakeCamera,{data:fixture});
    await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});

    await page.locator('#start').click();
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:90000});
    await settle(page);

    /* ---- makeup ---- */
    assert.equal(await page.locator('#stage').isVisible(),false,'stage visible in makeup mode');
    const makeupPixels=()=>page.evaluate(()=>{const c=document.querySelector('#overlay');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
    assert(await makeupPixels()>0,'makeup painted nothing');

    // Every product in the new range renders, and none leaks into the eye opening.
    const productIds=await page.evaluate(()=>[...document.querySelectorAll('[data-product]')].map(b=>b.dataset.product));
    assert(productIds.length>=7,`expected the full Roja range, got ${productIds.length}`);
    report.products={};
    let totalShades=0;
    for(const id of productIds){
      await page.locator(`[data-product="${id}"]`).click();
      await settle(page);
      const shades=await page.locator('#shades .shade').count();
      assert(shades>0,`${id} has no shades`);
      const painted=await makeupPixels();
      assert(painted>0,`${id} painted nothing`);
      const eye=await page.evaluate(()=>{
        const c=document.querySelector('#overlay'),x=c.getContext('2d'),lm=window.testLandmarks;
        return [[33,133,159,145],[263,362,386,374]].map(ids=>{
          const px=Math.round(ids.reduce((n,i)=>n+lm[i].x,0)/ids.length*c.width);
          const py=Math.round(ids.reduce((n,i)=>n+lm[i].y,0)/ids.length*c.height);
          return x.getImageData(px,py,1,1).data[3];});
      });
      assert.deepEqual(eye,[0,0],`${id} put colour in the eye opening`);
      report.products[id]={shades,painted};
      totalShades+=shades;
    }
    report.shadeChoices=totalShades;

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
      panel.scrollTop=panel.scrollHeight;
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
  const tagged=(src,token)=>{
    const out=[];let i=0;
    while((i=src.indexOf(token,i))>=0){
      const rest=src.slice(i+token.length);
      const digits=(rest.match(/^[0-9]+/)||[''])[0];
      if(digits)out.push(Number(digits));
      i+=token.length;
    }
    return out;
  };

  const deform=read('deform.js');
  const declared=nums(between(deform,'controlLandmarks={','};'))
    .concat(nums(between(deform,'frameLandmarks=[',']')));
  const stale=anchors(deform).filter(i=>!declared.includes(i));
  assert.deepEqual(stale,[],`deform.js anchors on ${stale} but controlLandmarks omits them`);

  const makeup=read('makeup.js');
  const known=nums(between(makeup,'blushAnchors=[',']'))
    .concat(nums(between(makeup,'frameLandmarks=[',']')));
  const loose=[...new Set([
    ...anchors(makeup),
    ...tagged(makeup,'eye:'),...tagged(makeup,'mouth:'),...tagged(makeup,'edge:'),
    ...tagged(makeup,'landmarks[')
  ])];
  const staleLoose=loose.filter(i=>!known.includes(i));
  assert.deepEqual(staleLoose,[],`makeup.js reads ${staleLoose} but blushAnchors omits them`);
  report.landmarkMaps='in step with the code';
}

    /* ---- procedures ---- */
    await page.locator('#mode-procedure').click();
    await page.waitForFunction(()=>{const s=document.querySelector('#stage');return !s.hidden&&s.width>0;},null,{timeout:20000});
    assert.equal(await page.locator('#webgl-missing').isVisible(),false,'WebGL reported missing');
    assert.equal(await page.locator('#badge').isVisible(),true,'simulation badge missing');

    const identity=await page.evaluate(probe,{GX,GY});
    assert(identity.diff<1.5,`identity differs from source by ${identity.diff}`);
    report.identityDiff=Number(identity.diff.toFixed(4));

    const ids=await page.evaluate(()=>[...document.querySelectorAll('[data-procedure]')].map(b=>b.dataset.procedure));
    assert(ids.length>=8,`expected the full procedure tray, got ${ids.length}`);
    report.procedures={};
    for(const id of ids){
      await page.locator(`[data-procedure="${id}"]`).click();
      await page.locator('#strength').fill('100');
      await page.locator('#strength').dispatchEvent('input');
      await settle(page);
      const spot=changed(identity,await page.evaluate(probe,{GX,GY}));
      assert(spot.count>0,`${id} changed nothing`);
      assert(spot.share<0.5,`${id} changed ${Math.round(spot.share*100)}% of the frame`);
      report.procedures[id]=spot.count;
      await page.locator('#procedure-reset').click();
      await settle(page);
      assert.equal(changed(identity,await page.evaluate(probe,{GX,GY})).count,0,`${id} did not reset`);
    }

    // The seam: "before" fills from the left edge, so dragging it right hides more.
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await page.locator('#strength').fill('100');
    await page.locator('#strength').dispatchEvent('input');
    await settle(page);
    const dragSeam=fraction=>page.evaluate(f=>{
      const box=document.querySelector('#viewport').getBoundingClientRect();
      document.querySelector('#seam').dispatchEvent(new PointerEvent('pointerdown',
        {clientX:box.left+box.width*f,clientY:box.top+box.height/2,bubbles:true,pointerId:1}));
    },fraction);
    await dragSeam(0.5);await settle(page);
    const half=changed(identity,await page.evaluate(probe,{GX,GY}));
    assert(half.count>0,'the seam hid the whole result at the half-way point');
    assert(half.maxX<=0.56,`warped pixels leaked past the seam (to ${half.maxX})`);
    await dragSeam(0.04);await settle(page);
    const mostlyAfter=changed(identity,await page.evaluate(probe,{GX,GY}));
    await dragSeam(0.96);await settle(page);
    const mostlyBefore=changed(identity,await page.evaluate(probe,{GX,GY}));
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
      await page.locator('#strength').fill('100');
      await page.locator('#strength').dispatchEvent('input');
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
    await page.locator('#strength').fill('100');
    await page.locator('#strength').dispatchEvent('input');
    await settle(page);

    // Losing the face must not leave a warped frame behind.
    await page.evaluate(()=>window.testBlank=true);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('صورت پیدا نشد'),null,{timeout:20000});
    await settle(page);
    assert((await page.evaluate(probe,{GX,GY})).diff<1.5,'stale warp after the face was lost');
    await page.evaluate(()=>window.testBlank=false);
    await page.waitForFunction(()=>window.testLandmarks,null,{timeout:20000});
    await page.locator('#procedure-reset').click();

    /* ---- back to makeup ---- */
    await page.locator('#mode-makeup').click();await settle(page);
    assert.equal(await page.locator('#stage').isVisible(),false,'stage left visible in makeup mode');
    assert.equal(await page.evaluate(()=>document.querySelector('#video').style.visibility),'','video left hidden');
    assert(await makeupPixels()>0,'makeup stopped rendering after the procedure mode');
    await page.locator('#shades .shade').nth(1).click();
    await page.locator('#add').click();
    await page.locator('#basket').click();
    assert.equal(await page.locator('.cart-row').count(),1,'cart did not record the shade');
    await page.locator('#close').click();


    /* ---- debug overlay ---- */
    await page.locator('#mode-makeup').click();await settle(page);
    assert.equal(await page.locator('#debug').isVisible(),false,'debug overlay on by default');

    // Earlier sections leave several products on the face. Start from a known state:
    // clear the look, then switch on one lipstick and nothing else.
    for(let left=await page.locator('#look-items .look-chip').count();left>0;left--)
      await page.locator('#look-items .look-chip').first().click();
    await page.locator('[data-product="velvet"]').click();
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
    const painted=()=>page.evaluate(()=>{
      const c=document.querySelector('#debug');
      if(c.hidden)return 0;
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;
    });

    await page.locator('#debug-panel summary').click();     // the panel starts collapsed
    await page.locator('#debug-on').check();
    await page.locator('#debug-size').fill('0');            // dots only, so labels never
    await page.locator('#debug-size').dispatchEvent('input');// sit on the pixel we sample
    await page.waitForTimeout(350);await settle(page);
    assert.equal(await page.locator('#debug').isVisible(),true,'debug overlay did not appear');
    const dotsOnly=await painted();
    assert(dotsOnly>0,'debug overlay painted nothing');

    // A lipstick is on by default: the lip contour is live, the eyelid is not.
    assert.equal(await dotAt(13),'active','the lip contour is not marked while a lipstick is on');
    assert.equal(await dotAt(386),'plain','the eyelid is marked with no eyeshadow on');

    // Turning on an eyeshadow brings its own landmarks in.
    await page.locator('[data-product="shadow"]').click();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(386),'active','the eyelid is not marked with an eyeshadow on');

    // Procedures highlight the region they move, and nothing else.
    await page.locator('#mode-procedure').click();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'plain','the nose is marked with no procedure applied');
    await page.locator('[data-procedure="rhinoplasty"]').click();
    await page.locator('#strength').fill('100');
    await page.locator('#strength').dispatchEvent('input');
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'active','rhinoplasty did not mark the nose');
    assert.equal(await dotAt(0),'plain','rhinoplasty marked the lip');
    await page.locator('[data-procedure="lip-filler"]').click();
    await page.locator('#strength').fill('100');
    await page.locator('#strength').dispatchEvent('input');
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(0),'active','the lip filler did not mark the lip');
    assert.equal(await dotAt(1),'active','the nose stopped being marked');

    // Labels respond to the slider, and the filter narrows the overlay.
    await page.locator('#debug-size').fill('16');
    await page.locator('#debug-size').dispatchEvent('input');
    await page.waitForTimeout(300);await settle(page);
    const withLabels=await painted();
    assert(withLabels>dotsOnly,'the label size slider changed nothing');
    await page.locator('#debug-only').check();
    await page.waitForTimeout(300);await settle(page);
    const narrowed=await painted();
    assert(narrowed<withLabels,'"active only" did not reduce the overlay');
    assert.equal(await dotAt(1),'active','the nose vanished under "active only"');
    await page.locator('#debug-only').uncheck();

    // Highlighting off leaves the points but drops the second colour.
    await page.locator('#debug-highlight').uncheck();
    await page.waitForTimeout(300);await settle(page);
    assert.equal(await dotAt(1),'plain','the active colour survived turning highlighting off');
    await page.locator('#debug-highlight').check();

    await page.locator('#procedure-reset').click();
    await page.locator('#mode-makeup').click();await settle(page);
    assert(await makeupPixels()>0,'makeup stopped rendering with the debug overlay on');
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
    // Changing a shade must not move the mirror.
    const before=await page.evaluate(()=>document.querySelector('#viewport').getBoundingClientRect().top);
    await page.locator('#shades .shade').nth(2).click();
    await settle(page);
    const after=await page.evaluate(()=>document.querySelector('#viewport').getBoundingClientRect().top);
    assert.equal(before,after,'picking a shade moved the mirror');

    await page.locator('#mode-procedure').click();
    await page.locator('[data-procedure="lip-filler"]').click();
    await settle(page);
    assert(await onScreen(page,'#viewport'),'the mirror is not visible in procedure mode on a phone');
    assert(await onScreen(page,'#strength'),'the amount slider is off-screen on a phone');
    report.phone='mirror and controls share one screen';

    await page.locator('#stop').click();
    assert(await page.evaluate(()=>window.testStream.getTracks().every(t=>t.readyState==='ended')),'camera tracks left running');

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
    const fallbackPixels=await plain.evaluate(()=>{const c=document.querySelector('#overlay');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
    assert(fallbackPixels>0,'makeup broken on a device without WebGL');
    assert.deepEqual(plainErrors,[],'page errors in the fallback run');
    report.fallbackPixels=fallbackPixels;

    report.errors=[];
    console.log(JSON.stringify(report,null,1));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
