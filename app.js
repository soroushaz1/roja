import {products,renderMakeup,smoothLandmarks,landmarksByType,frameLandmarks} from './makeup.js?v=12';
import {createStage} from './stage.js?v=12';
import {controls,zeroAmounts,controlLandmarks} from './deform.js?v=12';
import {procedures,byId,amountsFor} from './procedures.js?v=12';
import {renderDebug} from './debug.js?v=12';

const $=id=>document.getElementById(id);
const fa=new Intl.NumberFormat('fa-IR');
const pct=n=>fa.format(n)+'٪';

const video=$('video'), canvas=$('overlay'), ctx=canvas.getContext('2d');
const debugCanvas=$('debug'), debugCtx=debugCanvas.getContext('2d');

let mode='makeup';                       // makeup | procedure
let landmarks=null, before=false;
let stage=null, stageBroken=false;
let seam=0.5, seamOn=false;
const debug={on:false,labelSize:10,highlight:true,onlyActive:false};
let debugDrawn=null, debugSettings='';

const makeupState=Object.fromEntries(products.map(p=>[p.id,{shade:p.shades[0].id,intensity:p.intensity,fade:45,enabled:p.id===products[0].id}]));
let product=products[0];
const cart=new Map();

const active=new Map();                  // procedure id -> strength 0..100
let currentProcedure=null;
const overrides=zeroAmounts();

/* ---------- makeup ------------------------------------------------------ */
const selected=()=>product.shades.find(s=>s.id===makeupState[product.id].shade);
const visibleShades=()=>product.palettes?product.shades.filter(s=>s.variantId===selected().variantId):product.shades;
function enableProduct(item){for(const other of products)if(other.type===item.type)makeupState[other.id].enabled=other.id===item.id;}

function renderShades(){
  $('shades').replaceChildren();
  for(const shade of visibleShades()){
    const b=document.createElement('button');
    b.className='shade';b.type='button';b.dataset.id=shade.id;b.style.background=shade.color;
    b.setAttribute('role','radio');b.setAttribute('aria-label',shade.name);b.title=shade.name;
    b.onclick=()=>select(shade.id);
    $('shades').append(b);
  }
}
function updateLook(){
  $('look-items').replaceChildren();
  for(const item of products.filter(p=>makeupState[p.id].enabled)){
    const shade=item.shades.find(s=>s.id===makeupState[item.id].shade);
    const chip=document.createElement('button');
    chip.className='look-chip';chip.style.setProperty('--chip-color',shade.color);
    chip.textContent=`${item.name} ${shade.name}`;
    chip.setAttribute('aria-label',`حذف ${item.name} از آینه`);
    chip.onclick=()=>{makeupState[item.id].enabled=false;updateLook();draw();};
    $('look-items').append(chip);
  }
  if(!$('look-items').childElementCount){
    const empty=document.createElement('span');empty.className='quiet';
    empty.textContent='بدون آرایش. یک رنگ انتخاب کن.';$('look-items').append(empty);
  }
  $('product-toggle').textContent=makeupState[product.id].enabled?'برداشتن از آینه':'گذاشتن روی صورت';
  $('product-toggle').setAttribute('aria-pressed',String(makeupState[product.id].enabled));
}
function updateSelection(){
  const shade=selected();
  $('shade-name').textContent=shade.name;
  $('shade-code').textContent=`${product.code} / ${shade.variantId}`;
  if(product.palettes)$('palette-select').value=shade.variantId;
  $('big-swatch').style.background=shade.color;
  $('shades').querySelectorAll('.shade').forEach(b=>{
    const checked=b.dataset.id===shade.id;
    b.setAttribute('aria-checked',String(checked));b.tabIndex=checked?0:-1;
  });
  $('fade').value=makeupState[product.id].fade;$('fade-amount').textContent=pct(makeupState[product.id].fade);
  $('intensity').value=makeupState[product.id].intensity;$('amount').textContent=pct(makeupState[product.id].intensity);
  updateLook();draw();
}
function select(id){
  const shade=product.shades.find(s=>s.id===id);
  if(!shade)throw new Error('Unknown shade');
  const changed=selected().variantId!==shade.variantId;
  makeupState[product.id].shade=id;enableProduct(product);
  if(changed)renderShades();
  updateSelection();
  return {product:product.id,id,variant:shade.variantId,name:shade.name};
}
function selectProduct(id,apply=true){
  const next=products.find(p=>p.id===id);
  if(!next)throw new Error('Unknown product');
  product=next;if(apply)enableProduct(next);
  $('product-kicker').textContent=`روژا، ${next.region}`;
  $('product-title').textContent=next.title;
  $('product-description').textContent=next.description;
  $('product-limitation').textContent=next.limitation;
  $('palette-field').hidden=!next.palettes;
  $('palette-select').replaceChildren();
  for(const palette of next.palettes||[]){
    const option=document.createElement('option');
    option.value=palette.id;option.textContent=palette.label;
    $('palette-select').append(option);
  }
  $('shade-legend').textContent=next.palettes?'اول پالت، بعد خانهٔ رنگ را انتخاب کن.':'رنگ‌ها زیر آینه‌اند.';
  renderShades();updateSelection();
  if(mode==='makeup')buildTray();
}

/* ---------- procedures -------------------------------------------------- */
const procedureAmounts=()=>amountsFor(active,overrides);
const anyProcedure=()=>[...active.values()].some(v=>v>0)||controls.some(c=>overrides[c.id]!==0);

function showProcedure(id){
  currentProcedure=id;
  const procedure=byId(id);
  $('quick-procedure').hidden=!procedure;
  $('procedure-reset').hidden=!anyProcedure();
  if(!procedure){
    $('procedure-title').textContent='یک عمل را انتخاب کن';
    $('procedure-summary').textContent='از نوار بالا عملی را بزن تا نتیجهٔ تقریبی آن روی صورتت ساخته شود. می‌توانی چند مورد را با هم ببینی.';
    $('procedure-note').textContent='';
    return;
  }
  const strength=active.get(id)||0;
  $('procedure-title').textContent=procedure.name;
  $('procedure-summary').textContent=procedure.summary;
  $('procedure-note').textContent=procedure.note;
  $('strength-label').textContent=`میزان ${procedure.name}`;
  $('strength').value=strength;$('strength-amount').textContent=pct(strength);
}
function setStrength(id,value){
  if(value>0)active.set(id,value);else active.delete(id);
  $('procedure-reset').hidden=!anyProcedure();
  buildTray();updateSeam();draw();
}
function updateSeam(){
  seamOn=mode==='procedure'&&anyProcedure();
  $('seam').hidden=!seamOn;
  if(seamOn)placeSeam();
}
// object-fit:contain letterboxes the frame inside the stage, so the seam must be
// measured and drawn against the displayed frame rather than the whole element.
// Mixing the two puts the cut and the line in different places everywhere except
// dead centre, by half the letterbox width at the edges.
function videoBox(){
  const rect=$('viewport').getBoundingClientRect();
  const ratio=video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;
  let width=rect.width, height=rect.width/ratio;
  if(height>rect.height){height=rect.height;width=rect.height*ratio;}
  return {rect,left:(rect.width-width)/2,top:(rect.height-height)/2,width,height};
}
function placeSeam(){
  const box=videoBox();
  const x=box.left+seam*box.width;
  const line=$('seam-line');
  line.style.left=x+'px';line.style.top=box.top+'px';
  line.style.height=box.height+'px';line.style.bottom='auto';
  $('seam-grip').style.left=x+'px';
  $('seam-grip').setAttribute('aria-valuenow',String(Math.round(seam*100)));
  $('seam-before').style.left=(box.left+12)+'px';$('seam-before').style.right='';
  $('seam-after').style.right=(box.left+12)+'px';$('seam-after').style.left='';
}

/* ---------- tray -------------------------------------------------------- */
function buildTray(){
  const tray=$('tray');
  tray.replaceChildren();
  if(mode==='makeup'){
    tray.setAttribute('aria-label','انتخاب محصول');
    for(const item of products){
      const b=document.createElement('button');
      b.className='chip';b.dataset.product=item.id;
      b.setAttribute('aria-pressed',String(item.id===product.id));
      b.textContent=item.name;
      b.onclick=()=>selectProduct(item.id);
      tray.append(b);
    }
  }else{
    tray.setAttribute('aria-label','انتخاب عمل');
    for(const procedure of procedures){
      const strength=active.get(procedure.id)||0;
      const b=document.createElement('button');
      b.className='chip';b.dataset.procedure=procedure.id;
      b.setAttribute('aria-pressed',String(strength>0));
      b.textContent=procedure.name;
      if(strength>0){
        const on=document.createElement('span');on.className='on';on.textContent=pct(strength);b.append(on);
      }
      b.onclick=()=>{
        if(!active.has(procedure.id))setStrength(procedure.id,60);
        showProcedure(procedure.id);
      };
      tray.append(b);
    }
  }
}

/* ---------- modes ------------------------------------------------------- */
function statusText(){
  if(!landmarks)return stream?'صورتت را روبه‌روی دوربین نگه دار.':'برای شروع، دوربین را روشن کن.';
  if(mode==='procedure')return anyProcedure()?'مرز روی تصویر را بکش تا پیش و پس از عمل را مقایسه کنی.':'یک عمل را از نوار بالا انتخاب کن.';
  return 'رنگ زنده است.';
}
function setMode(next){
  mode=next;before=false;
  $('mode-makeup').setAttribute('aria-selected',String(mode==='makeup'));
  $('mode-procedure').setAttribute('aria-selected',String(mode==='procedure'));
  $('panel-makeup').hidden=mode!=='makeup';
  $('panel-procedure').hidden=mode!=='procedure';
  $('quick-makeup').hidden=mode!=='makeup';
  $('quick-procedure').hidden=mode!=='procedure'||!currentProcedure;
  $('compare').hidden=mode!=='makeup';
  $('compare').setAttribute('aria-pressed','false');
  $('compare').textContent='نمایش بدون آرایش';
  $('badge').hidden=mode!=='procedure';
  $('badge-text').textContent='شبیه‌سازی تصویری، نه نتیجهٔ قطعی';
  if(mode!=='procedure')$('seam').hidden=true;
  if(mode==='makeup'){$('stage').hidden=true;video.style.visibility='';}
  buildTray();updateSeam();
  status(statusText());draw();
}

/* ---------- drawing ----------------------------------------------------- */
function ensureStage(){
  if(!stage&&!stageBroken){
    stage=createStage($('stage'));
    if(!stage){stageBroken=true;$('webgl-missing').hidden=false;}
  }
  return stage;
}
// The landmarks driving what is on screen right now: the contours of each product
// that is switched on, or the anchors of every control a procedure is moving.
function activeLandmarks(){
  const set=new Set(frameLandmarks);
  if(mode==='makeup'){
    for(const item of products)
      if(makeupState[item.id].enabled)
        for(const index of landmarksByType[item.type]||[])set.add(index);
    return set;
  }
  const amounts=procedureAmounts();
  for(const control of controls)
    if(amounts[control.id])
      for(const index of controlLandmarks[control.id]||[])set.add(index);
  return set;
}

// 468 numbered labels are not cheap, so this only redraws when the points, the
// selection or the settings actually change, not on every animation frame.
function drawDebug(){
  const on=debug.on&&!!stream;
  debugCanvas.hidden=!on;
  if(!on){debugDrawn=null;return;}
  if(debugCanvas.width!==canvas.width||debugCanvas.height!==canvas.height){
    debugCanvas.width=canvas.width;debugCanvas.height=canvas.height;debugDrawn=null;
  }
  const active=activeLandmarks();
  const settings=`${debug.labelSize}|${debug.highlight}|${debug.onlyActive}|${[...active].join()}`;
  if(landmarks===debugDrawn&&settings===debugSettings)return;
  debugDrawn=landmarks;debugSettings=settings;
  renderDebug(debugCtx,landmarks,{...debug,active});
  $('debug-count').textContent=active.size>frameLandmarks.length
    ? `${fa.format(active.size)} نقطه در این لحظه درگیرند.`
    : 'هیچ محصول یا عملی فعال نیست.';
}
function draw(){
  canvas.classList.toggle('natural',mode==='makeup'&&$('natural-blend').checked);
  drawDebug();
  if(mode==='makeup'){
    $('stage').hidden=true;video.style.visibility='';
    renderMakeup(ctx,landmarks,makeupState,before);
    return;
  }
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!stream)return;
  const gl=ensureStage();
  if(!gl){$('stage').hidden=true;return;}
  if(gl.draw(video,landmarks,procedureAmounts(),seamOn?1-seam:null))$('stage').hidden=false;
  // The canvas covers the same rect as the video; hiding the element underneath
  // removes the sub-pixel sliver that otherwise shows along its edge. It keeps
  // playing, so it is still usable as a texture source.
  video.style.visibility=$('stage').hidden?'':'hidden';
}

/* ---------- camera ------------------------------------------------------ */
let stream=null,worker=null,ready=false,busy=false,activeCamera=false;
let generation=0,raf=0,lastFrame=0,initTimer;

function status(text){$('status').textContent=text;}

function stop(message='دوربین خاموش شد.'){
  generation++;activeCamera=false;ready=false;busy=false;
  clearTimeout(initTimer);cancelAnimationFrame(raf);
  if(stream)stream.getTracks().forEach(t=>t.stop());
  stream=null;video.srcObject=null;
  if(worker)worker.terminate();worker=null;
  landmarks=null;
  if(stage){stage.dispose();stage=null;}
  stageBroken=false;$('stage').hidden=true;video.style.visibility='';
  debugCanvas.hidden=true;debugDrawn=null;
  $('viewport').classList.remove('live');
  draw();
  $('welcome').hidden=false;$('start').disabled=false;$('start').textContent='روشن‌کردن دوربین';
  $('stop').disabled=true;$('compare').disabled=true;$('seam').hidden=true;
  status(message);
}

async function start(){
  if(activeCamera)return;
  activeCamera=true;
  const token=++generation;
  $('start').disabled=true;$('start').textContent='در حال آماده‌سازی…';$('stop').disabled=false;
  status('اجازهٔ دوربین را در مرورگر تأیید کن.');
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('UNSUPPORTED');
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}}});
    if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;video.srcObject=stream;await video.play();
    if(token!==generation)return;
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    $('welcome').hidden=true;$('viewport').classList.add('live');
    status('آماده‌سازی آینه. بار اول ممکن است کمی طول بکشد.');
    worker=new Worker(new URL('face-worker.js',import.meta.url));
    worker.onmessage=e=>{
      if(token!==generation)return;
      if(e.data.type==='ready'){
        clearTimeout(initTimer);ready=true;$('compare').disabled=false;
        status('صورتت را روبه‌روی دوربین نگه دار.');
        raf=requestAnimationFrame(frame);
      }else if(e.data.type==='result'){
        busy=false;landmarks=smoothLandmarks(landmarks,e.data.landmarks);
        status(landmarks?statusText():'صورت پیدا نشد. کمی روبه‌روی دوربین و در نور بیشتر قرار بگیر.');
        draw();
      }else if(e.data.type==='error'){
        stop('آینه آماده نشد. دوباره امتحان کن یا از مرورگر دیگری استفاده کن.');
      }
    };
    worker.onerror=()=>stop('بارگذاری آینه انجام نشد. دوباره امتحان کن.');
    initTimer=setTimeout(()=>stop('آماده‌سازی طول کشید. دوباره امتحان کن.'),60000);
    stream.getVideoTracks()[0].onended=()=>stop();
  }catch(e){
    if(token!==generation)return;
    const errors={
      NotAllowedError:'اجازهٔ دوربین داده نشد. از تنظیمات سایت در مرورگر، دسترسی دوربین را فعال کن.',
      NotFoundError:'دوربینی پیدا نشد. اتصال دوربین دستگاه را بررسی کن.',
      NotReadableError:'دوربین در دسترس نیست. برنامه‌های دیگری که از آن استفاده می‌کنند را ببند.'
    };
    stop(errors[e.name]||(e.message==='UNSUPPORTED'
      ?'این مرورگر دوربین را پشتیبانی نمی‌کند. سایت را با HTTPS در مرورگر اصلی دستگاه باز کن.'
      :'دوربین باز نشد. دوباره امتحان کن.'));
  }
}

async function frame(now){
  if(!activeCamera||!ready)return;
  raf=requestAnimationFrame(frame);
  if(mode==='procedure')draw();                   // keep the viewport at video rate
  if(busy||now-lastFrame<70||video.readyState<2)return;
  busy=true;lastFrame=now;
  const token=generation;
  try{
    const bitmap=await createImageBitmap(video,{resizeWidth:480,resizeHeight:Math.round(480*video.videoHeight/video.videoWidth)});
    if(token!==generation||!worker){bitmap.close();return;}
    worker.postMessage({type:'frame',bitmap,timestamp:now},[bitmap]);
  }catch{
    if(token===generation)stop('پردازش تصویر روی این مرورگر انجام نشد. مرورگر دیگری را امتحان کن.');
  }
}

/* ---------- cart -------------------------------------------------------- */
let toastTimer;
function toast(message){
  $('toast').textContent=message;$('toast').classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2500);
}
function renderCart(){
  $('count').textContent=fa.format([...cart.values()].reduce((a,b)=>a+b,0));
  $('cart-items').replaceChildren();
  if(!cart.size){
    const p=document.createElement('p');p.className='quiet';
    p.textContent='هنوز رنگی اضافه نکرده‌ای.';$('cart-items').append(p);return;
  }
  for(const [key,qty] of cart){
    const [pid,sid]=key.split(':');
    const item=products.find(p=>p.id===pid), shade=item.shades.find(s=>s.variantId===sid);
    const row=document.createElement('div');row.className='cart-row';
    const dot=document.createElement('span');dot.className='mini';dot.style.background=shade.color;
    const p=document.createElement('p');
    p.textContent=`${item.name}، ${item.palettes?'پالت':'کد'} ${fa.format(Number(sid))}، ${fa.format(qty)} عدد`;
    const remove=document.createElement('button');remove.className='ghost';remove.textContent='حذف';
    remove.setAttribute('aria-label',`حذف ${item.name} ${shade.name}`);
    remove.onclick=()=>{cart.delete(key);renderCart();};
    row.append(dot,p,remove);$('cart-items').append(row);
  }
}

/* ---------- wiring ------------------------------------------------------ */
$('mode-makeup').onclick=()=>setMode('makeup');
$('mode-procedure').onclick=()=>setMode('procedure');

$('shades').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();
  const list=visibleShades(), i=list.findIndex(s=>s.id===selected().id);
  const delta=['ArrowLeft','ArrowDown'].includes(e.key)?1:-1;
  select(list[(i+delta+list.length)%list.length].id);
  $('shades').querySelector(`[data-id="${selected().id}"]`).focus();
});
$('palette-select').onchange=()=>{
  const shade=product.shades.find(s=>s.variantId===$('palette-select').value);
  if(shade)select(shade.id);
};
$('intensity').oninput=()=>{
  makeupState[product.id].intensity=Number($('intensity').value);
  $('amount').textContent=pct($('intensity').value);draw();
};
$('fade').oninput=()=>{
  makeupState[product.id].fade=Number($('fade').value);
  $('fade-amount').textContent=pct($('fade').value);draw();
};
$('natural-blend').onchange=draw;
$('product-toggle').onclick=()=>{
  if(makeupState[product.id].enabled)makeupState[product.id].enabled=false;else enableProduct(product);
  updateLook();draw();
};
$('add').onclick=()=>{
  const shade=selected(), key=`${product.id}:${shade.variantId}`;
  cart.set(key,(cart.get(key)||0)+1);renderCart();
  toast(`${product.name} ${shade.name} به سبد نمونه اضافه شد.`);
};
$('basket').onclick=()=>{renderCart();$('cart').showModal();};
$('close').onclick=()=>$('cart').close();

$('strength').oninput=()=>{
  const value=Number($('strength').value);
  $('strength-amount').textContent=pct(value);
  if(currentProcedure)setStrength(currentProcedure,value);
};
$('procedure-reset').onclick=()=>{
  active.clear();
  for(const control of controls){
    overrides[control.id]=0;
    const input=$(`fine-${control.id}`);if(input)input.value='0';
    const amount=$(`fine-${control.id}-amount`);if(amount)amount.textContent=fa.format(0);
  }
  showProcedure(null);buildTray();updateSeam();draw();
};
for(const control of controls){
  const label=document.createElement('label');label.className='field';label.htmlFor=`fine-${control.id}`;
  const amount=document.createElement('output');amount.id=`fine-${control.id}-amount`;amount.textContent=fa.format(0);
  label.append(`${control.name} `,amount);
  const input=document.createElement('input');
  input.id=`fine-${control.id}`;input.type='range';input.min='-100';input.max='100';input.step='1';input.value='0';
  input.dataset.fine=control.id;
  input.oninput=()=>{
    overrides[control.id]=Number(input.value);
    amount.textContent=fa.format(Number(input.value));
    $('procedure-reset').hidden=!anyProcedure();
    updateSeam();draw();
  };
  $('fine-controls').append(label,input);
}

$('debug-on').onchange=()=>{debug.on=$('debug-on').checked;draw();};
$('debug-size').oninput=()=>{
  debug.labelSize=Number($('debug-size').value);
  $('debug-size-amount').textContent=fa.format(debug.labelSize);
  draw();
};
$('debug-highlight').onchange=()=>{debug.highlight=$('debug-highlight').checked;draw();};
$('debug-only').onchange=()=>{debug.onlyActive=$('debug-only').checked;draw();};

$('compare').onclick=()=>{
  before=!before;
  $('compare').setAttribute('aria-pressed',String(before));
  $('compare').textContent=before?'نمایش با آرایش':'نمایش بدون آرایش';
  draw();
};

/* seam dragging: the grip is a real slider, so it works from the keyboard too */
function seamFromEvent(event){
  const box=videoBox();
  seam=Math.min(1,Math.max(0,(event.clientX-box.rect.left-box.left)/box.width));
  placeSeam();draw();
}
$('seam').addEventListener('pointerdown',e=>{
  // Move first: capture is an enhancement, and it throws for a pointer id the
  // element does not own, which would otherwise abandon the drag.
  seamFromEvent(e);
  try{$('seam').setPointerCapture(e.pointerId);}catch{}
});
$('seam').addEventListener('pointermove',e=>{if(e.buttons)seamFromEvent(e);});
$('seam-grip').addEventListener('keydown',e=>{
  const step=e.key==='ArrowLeft'?-0.02:e.key==='ArrowRight'?0.02:0;
  if(!step)return;
  e.preventDefault();
  seam=Math.min(1,Math.max(0,seam+step));placeSeam();draw();
});

// The seam is positioned in pixels, so it has to be replaced when the box changes.
window.addEventListener('resize',()=>{if(seamOn)placeSeam();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&activeCamera)stop('با خارج‌شدن از صفحه، دوربین خاموش شد.');});
window.addEventListener('pagehide',()=>stop());
$('start').onclick=start;
$('stop').onclick=()=>stop();

selectProduct(products[0].id,false);
setMode('makeup');
renderCart();
placeSeam();

/* Optional agent hooks. */
function selectMakeup(input){
  const item=products.find(p=>p.id===input?.product);
  if(!item||!item.shades.some(s=>s.id===input?.id))throw new Error('Valid product and shade required');
  setMode('makeup');selectProduct(item.id);
  return select(input.id);
}
if(document.modelContext?.registerTool){
  const tool={
    name:'select_makeup_shade',
    description:"Select one of Roja's own sample shades and show it on the visible makeup combination. Does not start the camera or place an order.",
    inputSchema:{type:'object',properties:{
      product:{type:'string',enum:products.map(p=>p.id)},
      id:{type:'string',enum:[...new Set(products.flatMap(p=>p.shades.map(s=>s.id)))]}
    },required:['product','id'],additionalProperties:false},
    execute:selectMakeup
  };
  try{Promise.resolve(document.modelContext.registerTool(tool)).catch(()=>{});}catch{}
}
