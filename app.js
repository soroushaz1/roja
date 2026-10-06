import {products,categories,finishes,looks,byProduct} from './catalog.js?v=24';
import {layerSpecs,createMaskPainter,renderFallback,createSmoother,landmarksByType,frameLandmarks,hexToRgb} from './makeup.js?v=24';
import {createStage,layerModes} from './stage.js?v=24';
import {controls,regions,controlLandmarks,controlRange,deformers,textureLayers} from './deform.js?v=24';
import {procedures,byId,amountsFor,resolve,kinds} from './procedures.js?v=24';
import {renderDebug,nearest} from './debug.js?v=24';
import {createBrush,brushModes} from './brush.js?v=24';
import {metrics,measure,points as placed,symmetry,pose as poseOf} from './measure.js?v=24';
import {CANON,CANON_ASPECT,TRIANGLES} from './facemesh.js?v=24';
import {createSkinScanner} from './skin-scan.js?v=24';
import {createSkinPanel} from './skin-panel.js?v=24';
import {skincareById} from './skin.js?v=24';
import {count} from './usage.js?v=24';
import {currentShop,shopUrl,searchWords} from './shops.js?v=24';

const $=id=>document.getElementById(id);
// GitHub Pages ignores the ?v= query, and browsers and its CDN keep a page for up to ten
// minutes: just after a release, a page kept from the one before can be handed this
// newer script, which would then look for elements that page does not have. Such a
// page is loaded afresh, once; if it is still the old one, it says a new version is
// on its way instead of failing.
const RELEASE='24';
if(document.documentElement.dataset.release!==RELEASE){
  let tried=null;
  try{tried=sessionStorage.getItem('roja-reloaded');sessionStorage.setItem('roja-reloaded',RELEASE);}catch{}
  document.documentElement.dataset.ready='1';           // keeps the page's own error note quiet
  const status=$('status');
  if(tried!==RELEASE){
    if(status)status.textContent='نسخهٔ تازهٔ رُژا بار می‌شود…';
    location.reload();
  }else if(status)status.textContent='نسخهٔ تازهٔ رُژا در راه است؛ چند دقیقهٔ دیگر صفحه را دوباره باز کن.';
  throw new Error(`a page from an older release than ${RELEASE}: not started`);
}
const fa=new Intl.NumberFormat('fa-IR');
const fa1=new Intl.NumberFormat('fa-IR',{minimumFractionDigits:1,maximumFractionDigits:1});
const fa2=new Intl.NumberFormat('fa-IR',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=n=>fa.format(Math.round(n))+'٪';
const el=(tag,props={},...children)=>{
  const node=document.createElement(tag);
  for(const [k,v] of Object.entries(props)){
    if(k==='class')node.className=v;
    else if(k==='style')Object.assign(node.style,v);
    else if(k==='data')Object.assign(node.dataset,v);
    else if(k.startsWith('on'))node[k]=v;
    else if(k==='text')node.textContent=v;
    else node.setAttribute(k,v);
  }
  node.append(...children.filter(c=>c!=null&&c!==false));
  return node;
};

const video=$('video'), photo=$('photo'), overlay=$('overlay'), octx=overlay.getContext('2d');
// Inside the Android app (android/), the page talks to the app through this bridge:
// saving files, and keeping the screen on while the mirror is live.
const native=window.RojaAndroid||null;
// In the app the live camera is native (android/…/NativeMirror.kt): the camera, the
// tracking on the GPU and the drawing happen under the page, which shows through a hole
// where the mirror is. The page stays the interface and paints the masks.
let nativeMirror=(()=>{try{return !!native?.nativeMirror?.();}catch{return false;}})();
// Every browser on an iPhone is WebKit underneath; Chrome and Firefox there only change
// the settings screen that grants the camera. In-app browsers (Instagram, Telegram…)
// often have no camera at all.
const ua=navigator.userAgent;
const iOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const inApp=/Instagram|FBAN|FBAV|Telegram|Line\/|WhatsApp|Snapchat/i.test(ua);
function cameraHelp(){
  if(native)return 'در تنظیمات اندروید، بخش برنامه‌ها › رُژا › مجوزها، دوربین را روشن کن.';
  if(iOS&&/CriOS/.test(ua))return 'در تنظیمات آیفون، بخش Chrome، دسترسی Camera را روشن کن و صفحه را دوباره باز کن.';
  if(iOS&&/FxiOS/.test(ua))return 'در تنظیمات آیفون، بخش Firefox، دسترسی Camera را روشن کن و صفحه را دوباره باز کن.';
  if(iOS)return 'در Safari روی «aA» کنار نشانی بزن، «تنظیمات وب‌سایت» و بعد «دوربین» را روی «اجازه» بگذار.';
  return 'از تنظیمات سایت در مرورگر، دسترسی دوربین را فعال کن.';
}
const code=e=>` (کد: ${e?.name&&e.name!=='Error'?e.name:e?.message||'نامشخص'})`;
const debugCanvas=$('debug'), debugCtx=debugCanvas.getContext('2d');
const viewport=$('viewport');
// The shop this mirror sells for (shops.js), from the address; null on Roja's own demo,
// which then offers no buying, only the way to put the mirror on a shop. Inside a
// shop's page (an iframe) the page around it is that shop.
const shop=currentShop();
count('step','open');
const embedded=(()=>{try{return window.parent!==window;}catch{return true;}})();
document.documentElement.classList.toggle('has-shop',!!shop);
document.documentElement.classList.toggle('embedded',embedded);
// The app carries only the mirror: the shops' page is on the site.
if(native)document.querySelectorAll('a[href="business/"]').forEach(a=>{a.href='https://pythonpath.ir/business/';});
if(shop)document.querySelectorAll('.shop-name').forEach(n=>{n.textContent=shop.name;});
if(shop)$('basket').setAttribute('aria-label',`خرید آرایش روی صورت از ${shop.name}`);

/* ---------- state ------------------------------------------------------- */
let mode='makeup';                       // makeup | procedure | skin
let source=null;                         // {kind:'camera'|'photo', el, width, height, live, version}
let landmarks=null, poseAngles=null, blendshapes=null;
let stage=null, stageBroken=false;
let seam=0.5, seamOn=false, compare=false, pin=null;
let frozen=false, light='none';
let masksDirty=true, dirty=true, debugDirty=true, measureDirty=true;

// Skin products start from a middle shade, not the lightest one: the shade finder or
// the shopper moves it from there.
const makeupState=Object.fromEntries(products.map(p=>[p.id,{
  shade:(p.finder?p.shades[Math.floor(p.shades.length/2)]:p.shades[0]).id,
  intensity:p.intensity,fade:p.fade??45,enabled:p.id==='velvet',style:p.styles?.[0]?.id}]));
let product=byProduct('velvet');
let category=product.category;
const shots=[];

const active=new Map();                  // procedure id -> strength 0..100
const variants=new Map();                // procedure id -> variant id
let currentProcedure=null;
const overrides=Object.fromEntries(controls.map(c=>[c.id,0]));
let procGroup=null;

const brush=createBrush();
const brushState={on:false,mode:'blend',size:10,strength:{},target:'all'};
for(const m of brushModes)brushState.strength[m.id]=m.strength;
let brushPointer=null;

const painter=createMaskPainter();
const debug={on:false,points:true,mesh:false,contours:false,axes:false,masks:false,field:false,strokes:false,
  labelSize:10,highlight:true,onlyActive:false,find:null,hud:false,inspect:false};
let topology=null, maskView=null;
const maskTint=document.createElement('canvas');
const perf={frames:0,fps:0,since:0,draws:0,drawn:0,detections:0,hz:0,latency:0,inferMs:0,lastHud:0,maskMs:0,drawMs:0,lastError:'',trackerNote:''};
const ema=(old,v)=>old?old*.85+v*.15:v;
let finder={state:'idle',samples:[],tries:0,result:null};
let wantSkin=false;

const lights=[
  {id:'none',name:'نور فعلی',grade:null,swatch:'#8A7F85'},
  {id:'daylight',name:'روز، کنار پنجره',grade:[1.04,1.03,1.07],swatch:'#DCE8F5'},
  {id:'golden',name:'آفتاب عصر',grade:[1.12,.97,.80],swatch:'#F2B66B'},
  {id:'office',name:'مهتابی اداری',grade:[.94,1.02,1.08],swatch:'#C8E2E8'},
  {id:'evening',name:'مهمانی، نور گرم',grade:[.96,.80,.63],swatch:'#C9774A'},
  {id:'flash',name:'فلاش عکاسی',grade:[1.16,1.16,1.16],swatch:'#FFFFFF'}
];

const FINISH={
  matte:{gloss:0,matte:.9,shimmer:0,smooth:.55},
  velvet:{gloss:.06,matte:.6,shimmer:0},
  satin:{gloss:.22,matte:.2,shimmer:0},
  cream:{gloss:.3,matte:0,shimmer:0},
  gloss:{gloss:1,matte:0,shimmer:0},
  shimmer:{gloss:.25,matte:0,shimmer:.55},
  metallic:{gloss:.55,matte:0,shimmer:.3},
  natural:{gloss:.05,matte:.3,shimmer:0,smooth:.45},
  dewy:{gloss:.28,matte:0,shimmer:0,smooth:.3}
};
const DETAIL={lipstick:.9,gloss:.95,lipliner:.7,eyeshadow:.85,eyeliner:.25,mascara:.15,brow:.9,foundation:.85,concealer:.8};
// How much of the skin's own colour a product lets through, rather than replacing it.
// Liner and lashes really are opaque. A gloss is mostly skin with a hint of hue. A brow
// has to keep the hair showing or it reads as a block drawn on the face.
const SHEER={lipstick:.20,gloss:.62,lipliner:.15,eyeshadow:.40,eyeliner:.06,mascara:.10,brow:.55};

/* ---------- small helpers ----------------------------------------------- */
function paintRange(input){
  const min=Number(input.min||0),max=Number(input.max||100);
  input.style.setProperty('--fill',((Number(input.value)-min)/(max-min)*100)+'%');
}
function setRange(id,value){const input=$(id);input.value=value;paintRange(input);}
document.addEventListener('input',e=>{if(e.target.type==='range')paintRange(e.target);});

function frameSize(){return source?{w:source.width,h:source.height}:{w:640,h:480};}
function faceWidthPx(){
  if(!landmarks)return 0;
  const {w,h}=frameSize();
  return Math.hypot((landmarks[454].x-landmarks[234].x)*w,(landmarks[454].y-landmarks[234].y)*h);
}
function invalidate({masks=false,measure=false}={}){
  dirty=true;debugDirty=true;
  if(masks)masksDirty=true;
  if(measure)measureDirty=true;
}

let toastTimer;
function toast(message){
  $('toast').textContent=message;$('toast').classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2600);
}
function status(text){$('status').textContent=text;}

/* ---------- makeup ------------------------------------------------------ */
const shadeOf=(item,id)=>item.shades.find(s=>s.id===id)||item.shades[0];
const selected=()=>shadeOf(product,makeupState[product.id].shade);
const finishOf=(item,shade)=>shade.finish||item.finish;
function enableProduct(item){for(const other of products)if(other.type===item.type)makeupState[other.id].enabled=other.id===item.id;}
function swatchStyle(shade){
  return shade.colors
    ?`conic-gradient(${shade.colors[0]} 0 25%,${shade.colors[1]} 0 50%,${shade.colors[2]} 0 75%,${shade.colors[3]} 0)`
    :shade.color;
}

function renderShades(){
  $('shades').replaceChildren();
  for(const shade of product.shades){
    const b=el('button',{class:`shade f-${finishOf(product,shade)}`,type:'button',role:'radio','aria-label':shade.name,title:shade.name,data:{id:shade.id}});
    b.style.background=swatchStyle(shade);
    b.onclick=()=>select(shade.id);
    $('shades').append(b);
  }
}
function updateLook(){
  $('look-items').replaceChildren();
  for(const item of products.filter(p=>makeupState[p.id].enabled)){
    const shade=shadeOf(item,makeupState[item.id].shade);
    const chip=el('button',{class:'look-chip','aria-label':`حذف ${item.name} از آینه`,text:`${item.name} ${shade.name}`});
    chip.style.setProperty('--chip-color',shade.color);
    chip.onclick=()=>{makeupState[item.id].enabled=false;afterMakeupChange();};
    $('look-items').append(chip);
  }
  if(!$('look-items').childElementCount)
    $('look-items').append(el('span',{class:'quiet',text:'بدون آرایش. یک محصول و رنگ انتخاب کن یا یک استایل آماده را بزن.'}));
  $('product-toggle').textContent=makeupState[product.id].enabled?'برداشتن از صورت':'گذاشتن روی صورت';
  $('product-toggle').setAttribute('aria-pressed',String(makeupState[product.id].enabled));
  const any=products.some(p=>makeupState[p.id].enabled);
  $('add-look').disabled=$('save-look').disabled=$('link-look').disabled=!any;
  const on=products.filter(p=>makeupState[p.id].enabled).length;
  $('count').textContent=$('look-count').textContent=fa.format(on);
  if(mode==='makeup')updateTrayState();
}
function updateSelection(){
  const shade=selected(), state=makeupState[product.id];
  $('shade-name').textContent=shade.name;
  $('shade-code').textContent=`${product.palettes?'پالت':'رنگ'} ${fa.format(Number(shade.variantId))} از ${fa.format(product.shades.length)}`;
  if(shop)buyLink($('add'),product,shade);
  $('big-swatch').style.background=swatchStyle(shade);
  $('pick-swatch').style.background=swatchStyle(shade);
  $('pick-name').textContent=shade.name;
  $('pick-code').textContent=$('shade-code').textContent;
  $('shades').querySelectorAll('.shade').forEach(b=>{
    const checked=b.dataset.id===shade.id;
    b.setAttribute('aria-checked',String(checked));b.tabIndex=checked?0:-1;
  });
  $('product-finish').textContent=finishes[finishOf(product,shade)]?.name||'';
  setRange('fade',state.fade);$('fade-amount').textContent=pct(state.fade);
  setRange('intensity',state.intensity);$('amount').textContent=pct(state.intensity);
  $('style-options').querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.style===state.style)));
  updatePinButton();
  updateLook();afterMakeupChange(false);
}
function select(id){
  const shade=product.shades.find(s=>s.id===id);
  if(!shade)throw new Error('Unknown shade');
  makeupState[product.id].shade=id;enableProduct(product);
  updateSelection();count('shade',id);count('step','shade');
  return {product:product.id,id,variant:shade.variantId,name:shade.name};
}
function selectProduct(id,apply=true){
  const next=byProduct(id);
  if(!next)throw new Error('Unknown product');
  product=next;category=next.category;if(apply)enableProduct(next);
  const cat=categories.find(c=>c.id===next.category);
  $('product-kicker').textContent=`${cat?.name} · ${next.region}`;
  $('product-title').textContent=next.title;
  $('product-description').textContent=next.description;
  $('product-limitation').textContent=next.limitation;
  const skin=next.mode==='foundation';
  $('intensity-label').textContent=skin?'پوشش':'شدت رنگ';
  $('finder').hidden=!next.finder;
  renderFinder();
  $('style-field').hidden=!next.styles;
  $('style-options').replaceChildren(...(next.styles||[]).map(s=>el('button',{type:'button',role:'radio',data:{style:s.id},text:s.name,
    onclick:()=>{makeupState[product.id].style=s.id;enableProduct(product);updateSelection();}})));
  $('brush-target-product').textContent=`فقط ${next.name}`;
  if(brushState.target!=='all')brushState.target=next.type;
  renderShades();updateSelection();
  if(mode==='makeup')buildTray();
}
function afterMakeupChange(look=true){
  if(look)updateLook();
  saveSoon();
  invalidate({masks:true});
  updateSeam();
}

function applyLook(look){
  count('look',looks.includes(look)?look.id:look.id?'mine':'link');
  for(const item of products)makeupState[item.id].enabled=false;
  for(const [pid,shade,intensity,style,fade] of look.items){
    const item=byProduct(pid);if(!item)continue;
    const sid=shade==='auto'?(finder.result?.picks?.[pid]||makeupState[pid].shade):shade;
    Object.assign(makeupState[pid],{shade:sid,intensity,enabled:true,fade:fade??item.fade??45});
    if(style)makeupState[pid].style=style;
  }
  pin=null;
  // Land on the product a shopper is most likely to change next: the lipstick.
  const focus=look.items.find(i=>byProduct(i[0]).type==='lipstick')||look.items.find(i=>byProduct(i[0]).category==='lips')||look.items[0];
  selectProduct(focus[0],false);
  // A look with a skin product needs a shade that suits this face: measure it now
  // if that has not been done yet.
  const auto=look.items.some(([,shade])=>shade==='auto');
  if(auto&&!finder.result&&landmarks){
    finder.onDone=result=>{for(const [pid,shade] of look.items)if(shade==='auto'&&result.picks[pid])makeupState[pid].shade=result.picks[pid];
      updateSelection();};
    runFinder();
    toast(`استایل «${look.name}» روی صورت است. رنگ کرم‌پودر هم الان با پوستت هماهنگ می‌شود.`);
  }else toast(`استایل «${look.name}» روی صورت است. هر محصول را می‌توانی جدا عوض کنی.`);
}
function renderLooks(){
  $('looks').replaceChildren(...looks.map(look=>el('button',{class:'look-card',type:'button',onclick:()=>applyLook(look),data:{look:look.id}},
    lookDots(look.items),el('strong',{text:look.name}),el('small',{text:look.description}))));
  renderMyLooks();
}

/* ---- my looks, and a look as a link ------------------------------------ */
// A look is a list of [product, shade, intensity, style, fade]: the same shape as the
// ready-made ones, plus the edge. Kept on this device; a link carries it in the part
// after # , which the browser never sends to the server.
const MY_LOOKS='roja-looks';
function currentItems(){
  return products.filter(p=>makeupState[p.id].enabled).map(p=>{const st=makeupState[p.id];return [p.id,st.shade,st.intensity,st.style||'',st.fade];});
}
// Whatever came from storage or a link: only products and shades the catalogue has,
// levels in range, one product of each kind.
function cleanItems(items){
  const out=[], kinds=new Set();
  const level=v=>{v=Number(v);return Number.isFinite(v)?Math.round(Math.min(100,Math.max(0,v))):null;};
  for(const raw of Array.isArray(items)?items:[]){
    if(!Array.isArray(raw))continue;
    const [pid,sid,intensity,style,fade]=raw, item=byProduct(pid);
    if(!item||kinds.has(item.type)||!item.shades.some(x=>x.id===sid))continue;
    kinds.add(item.type);
    out.push([pid,sid,level(intensity)??item.intensity,item.styles?.some(x=>x.id===style)?style:'',level(fade)??item.fade??45]);
  }
  return out;
}
function myLooks(){
  let list=[];
  try{list=JSON.parse(localStorage.getItem(MY_LOOKS))||[];}catch{}
  return (Array.isArray(list)?list:[]).map(l=>({id:String(l?.id||''),name:String(l?.name||'').slice(0,30),items:cleanItems(l?.items)}))
    .filter(l=>l.id&&l.name&&l.items.length);
}
function storeMyLooks(list){
  try{localStorage.setItem(MY_LOOKS,JSON.stringify(list));return true;}catch{return false;}
}
function lookDots(items){
  return el('span',{class:'dots'},...items.slice(0,6).map(([pid,sid])=>{
    const item=byProduct(pid),shade=sid==='auto'?item.shades[Math.floor(item.shades.length/2)]:shadeOf(item,sid);
    return el('i',{style:{background:shade.color}});
  }));
}
function renderMyLooks(){
  const list=myLooks();
  $('my-looks-head').hidden=!list.length;
  $('my-looks').replaceChildren(...list.map(look=>el('div',{class:'mine-card'},
    el('button',{class:'look-card',type:'button',onclick:()=>applyLook(look),data:{look:look.id}},
      lookDots(look.items),el('strong',{text:look.name}),el('small',{text:`${fa.format(look.items.length)} محصول`})),
    el('button',{class:'look-del',type:'button','aria-label':`حذف استایل ${look.name}`,title:'حذف',text:'×',
      onclick:()=>{storeMyLooks(myLooks().filter(l=>l.id!==look.id));renderMyLooks();toast(`«${look.name}» حذف شد.`);}}))));
}
function saveMyLook(name){
  const items=currentItems();
  if(!items.length){toast('روی صورت آرایشی نیست که ذخیره شود.');return false;}
  const list=myLooks().filter(l=>l.name!==name);
  list.unshift({id:Date.now().toString(36),name,items});
  if(!storeMyLooks(list.slice(0,12))){toast('ذخیره ممکن نشد؛ حافظهٔ این مرورگر در دسترس نیست.');return false;}
  renderMyLooks();
  toast(`«${name}» در «استایل‌های من» ذخیره شد.`);
  return true;
}
function lookLink(){
  // The app's own pages live inside it; a link has to point at the site.
  const base=!native&&/^https?:$/.test(location.protocol)?location.origin+location.pathname:'https://pythonpath.ir/';
  // A look sent from a shop's mirror opens in that shop's mirror.
  return `${base}${shop?`?shop=${encodeURIComponent(shop.id)}`:''}#look=${encodeURIComponent(currentItems().map(i=>i.join('.')).join('~'))}`;
}
async function sendLookLink(){
  if(!currentItems().length){toast('روی صورت آرایشی نیست که لینکش فرستاده شود.');return;}
  const url=lookLink(), text='این ترکیب آرایش را روی صورت خودت در آینهٔ رُژا امتحان کن:';
  if(!native&&navigator.share){
    try{await navigator.share({title:'رُژا',text,url});count('share','link',{each:true});return;}catch(e){if(e?.name==='AbortError')return;}
  }
  try{await navigator.clipboard.writeText(url);count('share','link',{each:true});toast('لینک این ترکیب کپی شد. هر کس بازش کند، همین آرایش روی صورت خودش می‌نشیند.');}
  catch{toast('کپی لینک روی این مرورگر ممکن نشد.');}
}
// A link into the mirror, from a shared look or one of the site's own pages:
//   #look=…        that look on the face
//   #product=velvet  that product, on the face
//   #procedure=rhinoplasty  that procedure, at its usual strength
//   #skin          the skin check
// Taken out of the address once used, so a reload does not apply it again over later
// changes. Returns whether there was one.
function lookFromLink(){
  const m=/^#(look|product|procedure|skin)(?:=(.*))?$/.exec(location.hash);
  if(!m)return false;
  history.replaceState(null,'',location.pathname+location.search);
  const [,kind,value='']=m;
  if(kind==='skin'){setMode('skin');return true;}
  if(kind==='product'){
    if(byProduct(value)){setMode('makeup');selectProduct(value);}
    return true;
  }
  if(kind==='procedure'){
    if(byId(value)){setMode('procedure');activateProcedure(value);showProcedure(value);}
    return true;
  }
  let raw='';try{raw=decodeURIComponent(value);}catch{}
  const items=cleanItems(raw.split('~').map(part=>part.split('.')));
  if(!items.length){toast('این لینک استایلی ندارد که روی آینه بنشیند.');return true;}
  setMode('makeup');applyLook({name:'لینک',items});
  return true;
}

/* ---- the first-visit tour ---------------------------------------------- */
// Short notes, each next to the control it is about, the first time the mirror
// comes on. Skipped or finished, it does not come back.
const TOUR='roja-tour';
const tourSteps=[
  ['shades','رنگ را از اینجا انتخاب کن؛ همان لحظه روی صورتت می‌نشیند.'],
  ['tray','محصول را از اینجا عوض کن: رژ، سایه، خط چشم، کرم‌پودر و بقیه.'],
  ['brush-toggle','با «براش» رنگ را روی صورت پخش، محو یا پاک کن.'],
  ['compare','«مقایسه» خطی روی صورت می‌گذارد؛ بکشش تا با و بی آرایش را کنار هم ببینی.'],
  ['snap','عکس بگیر تا ذخیره‌اش کنی یا برای دوستت بفرستی.'],
  ['add',`هر رنگی را که پسندیدی، از اینجا در ${shop?.name||''} پیدا کن.`]
];
let tourAt=-1;
function tourSeen(){try{return localStorage.getItem(TOUR)==='done';}catch{return true;}}
function startTour(){
  if(tourAt>=0||tourSeen()||mode!=='makeup'||document.querySelector('dialog[open]'))return;
  tourAt=0;showTourStep();
}
function tourTarget(){
  for(;tourAt<tourSteps.length;tourAt++){
    const t=$(tourSteps[tourAt][0]);
    if(t&&t.offsetParent&&t.getClientRects().length)return t;
  }
  return null;
}
function showTourStep(){
  document.querySelector('.tour-target')?.classList.remove('tour-target');
  const t=tourTarget();
  if(!t){endTour();return;}
  t.classList.add('tour-target');
  t.scrollIntoView({block:'nearest'});
  $('tour-text').textContent=tourSteps[tourAt][1];
  $('tour-step').textContent=`${fa.format(tourAt+1)} از ${fa.format(tourSteps.length)}`;
  $('tour-next').textContent=tourAt===tourSteps.length-1?'تمام':'بعدی';
  $('tour').hidden=false;
  placeTour();
}
function placeTour(){
  if(tourAt<0)return;
  const t=$(tourSteps[tourAt][0]), box=$('tour');
  if(!t)return;
  // A toolbar button: beside the whole toolbar, so the note covers none of its buttons.
  const r=(t.closest('#toolbar')||t).getBoundingClientRect(), b=box.getBoundingClientRect(), gap=10, vw=innerWidth, vh=innerHeight;
  let top=r.bottom+gap, left=r.left+r.width/2-b.width/2;
  if(top+b.height>vh-8)top=r.top-gap-b.height;
  if(top<8)top=Math.min(vh-b.height-8,Math.max(8,r.top+r.height/2-b.height/2));
  if(t.closest('#toolbar')){
    const tr=t.getBoundingClientRect();
    top=Math.min(vh-b.height-8,Math.max(8,tr.top+tr.height/2-b.height/2));
    left=r.right+gap+b.width<vw-8?r.right+gap:r.left-gap-b.width;
  }
  box.style.top=`${Math.round(top)}px`;
  box.style.left=`${Math.round(Math.min(vw-b.width-8,Math.max(8,left)))}px`;
}
function endTour(){
  document.querySelector('.tour-target')?.classList.remove('tour-target');
  $('tour').hidden=true;tourAt=-1;
  try{localStorage.setItem(TOUR,'done');}catch{}
}

/* ---- the shade finder -------------------------------------------------- */
const srgbToLinear=c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);
function lab([r,g,b]){
  const [R,G,B]=[r,g,b].map(srgbToLinear);
  const x=(R*.4124+G*.3576+B*.1805)/.95047,y=R*.2126+G*.7152+B*.0722,z=(R*.0193+G*.1192+B*.9505)/1.08883;
  const f=t=>t>.008856?Math.cbrt(t):7.787*t+16/116;
  return [116*f(y)-16,500*(f(x)-f(y)),200*(f(y)-f(z))];
}
const luma=([r,g,b])=>r*.299+g*.587+b*.114;
function runFinder(){
  if(!landmarks){toast('اول صورتت باید روی آینه دیده شود.');return;}
  finder={state:'sampling',samples:[],tries:0,result:finder.result,onDone:finder.onDone};
  wantSkin=true;renderFinder();
}
function onSkin(sample){
  if(finder.state!=='sampling')return;
  finder.tries++;
  if(sample)finder.samples.push(sample.rgb);
  if(finder.samples.length>=5||finder.tries>=14){wantSkin=false;finishFinder();}
}
function finishFinder(){
  if(finder.samples.length<2){finder.state='failed';finder.onDone=null;renderFinder();return;}
  const median=k=>{const v=finder.samples.map(s=>s[k]).sort((a,b)=>a-b);return v[v.length>>1];};
  const rgb=[median(0),median(1),median(2)].map(v=>v/255);
  // The same light compensation the stage applies to the colour it paints, so a
  // shade that "matches" here also disappears into the skin on screen.
  const light=Math.max(.72,Math.min(1.12,1+(luma(rgb)/.58-1)*.5));
  const skin=lab(rgb.map(v=>Math.min(1,v/light)));
  const hue=Math.atan2(skin[2],skin[1])*180/Math.PI;
  const tone=hue>61?'W':hue<52?'C':'N';
  const picks={},scores={};
  for(const item of products.filter(p=>p.finder)){
    let best=null;
    for(const shade of item.shades){
      const s=lab(hexToRgb(shade.color));
      const target=item.lighter?[skin[0]+6,skin[1],skin[2]]:skin;
      let d=Math.hypot((s[0]-target[0])*1.1,s[1]-target[1],s[2]-target[2]);
      if(shade.tone&&shade.tone!==tone&&shade.tone!=='N')d+=3;
      if(!best||d<best.d)best={shade,d};
    }
    picks[item.id]=best.shade.id;scores[item.id]=Math.max(0,Math.round(100-best.d*3.2));
  }
  const hex='#'+rgb.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');
  const onDone=finder.onDone;
  finder={state:'done',samples:[],tries:0,result:{hex,tone,picks,scores}};
  renderFinder();
  if(onDone)onDone(finder.result);
  else toast('رنگ‌های پیشنهادی آماده است.');
}
function renderFinder(){
  const box=$('finder-result');
  $('finder-run').disabled=finder.state==='sampling';
  $('finder-run').textContent=finder.state==='sampling'?'در حال نمونه‌برداری از رنگ پوست…':finder.result?'دوباره اندازه بگیر':'پیدا کردن رنگ';
  if(finder.state==='failed'){box.hidden=false;box.replaceChildren(el('p',{class:'help',text:'رنگ پوست خوانده نشد. در نور یکنواخت‌تر و روبه‌روی دوربین دوباره امتحان کن.'}));return;}
  const r=finder.result;
  if(!r||!product.finder){box.hidden=true;return;}
  const toneName={W:'گرم (زرد و طلایی)',N:'خنثی',C:'سرد (صورتی)'}[r.tone];
  const rows=products.filter(p=>p.finder).map(item=>{
    const shade=shadeOf(item,r.picks[item.id]);
    return el('button',{class:'pick',type:'button',onclick:()=>{
      makeupState[item.id].shade=shade.id;selectProduct(item.id);
    }},el('i',{style:{background:shade.color}}),el('span',{text:`${item.name}: ${shade.name}`}),el('small',{text:`تطابق ${pct(r.scores[item.id])}`}));
  });
  box.hidden=false;
  box.replaceChildren(
    el('div',{class:'skin-row'},el('span',{class:'swatch',style:{background:r.hex}}),
      el('span',{},el('strong',{text:'رنگ پوست تخمینی'}),el('small',{class:'quiet',text:` · زیرته ${toneName}`}))),
    el('div',{class:'picks'},...rows),
    el('p',{class:'help',text:'تخمین از روی تصویر دوربین است و تعادل رنگ دوربین و نور اتاق آن را جابه‌جا می‌کند. پیش از خرید، رنگ را روی خط فک در نور روز امتحان کن.'}));
}

/* ---- A/B shade compare ------------------------------------------------- */
function updatePinButton(){
  const on=!!pin;
  $('pin-shade').setAttribute('aria-pressed',String(on));
  $('pin-shade').textContent=on
    ?`پایان مقایسه با ${shadeOf(byProduct(pin.product),pin.shade).name}`
    :'مقایسه با رنگ دیگر';
}
function togglePin(){
  if(pin){pin=null;}
  else{
    pin={product:product.id,shade:makeupState[product.id].shade};
    enableProduct(product);
    toast('حالا رنگ دیگری انتخاب کن. سمت چپ مرز، رنگ قبلی می‌ماند.');
  }
  updatePinButton();afterMakeupChange();
}
function pinnedStates(){
  if(!pin)return null;
  const item=byProduct(pin.product);
  const states=Object.fromEntries(Object.entries(makeupState).map(([k,v])=>[k,{...v}]));
  for(const other of products)if(other.type===item.type)states[other.id].enabled=false;
  states[item.id]={...states[item.id],shade:pin.shade,enabled:true};
  return states;
}

/* ---------- procedures -------------------------------------------------- */
const procedureAmounts=()=>amountsFor(active,overrides,variants);
const anyProcedure=()=>[...active.values()].some(v=>v>0)||controls.some(c=>overrides[c.id]!==0);

function showProcedure(id){
  currentProcedure=id;
  const procedure=byId(id);
  $('quick-procedure').hidden=!procedure||mode!=='procedure';
  $('procedure-reset').hidden=!anyProcedure();
  $('procedure-facts').hidden=!procedure;
  $('variant-field').hidden=!procedure?.variants;
  if(!procedure){
    $('procedure-kicker').textContent='عمل‌های زیبایی';
    $('procedure-title').textContent='یک عمل را انتخاب کن';
    $('procedure-summary').textContent='از نوار زیر آینه عملی را بزن تا نتیجهٔ تقریبی آن روی صورتت ساخته شود. برای دیدن چند عمل با هم، «ترکیب چند عمل با هم» را روشن کن.';
    $('procedure-note').textContent='';
    renderActiveList();
    return;
  }
  const {kind,variant}=resolve(procedure,variants.get(id));
  const strength=active.get(id)||0;
  $('procedure-kicker').textContent=`عمل‌های زیبایی · ${regions.find(r=>r.id===procedure.region)?.name}`;
  $('procedure-title').textContent=procedure.name;
  $('procedure-summary').textContent=procedure.summary;
  $('procedure-note').textContent=procedure.note;
  $('fact-kind').textContent=kinds[kind];
  $('fact-lasts').textContent=procedure.lasts;
  $('fact-recovery').textContent=procedure.recovery;
  $('variant-options').replaceChildren(...(procedure.variants||[]).map(v=>el('button',{type:'button',role:'radio',
    'aria-checked':String(v.id===variant?.id),data:{variant:v.id},text:v.name,
    onclick:()=>{variants.set(id,v.id);showProcedure(id);invalidate({masks:true,measure:true});}})));
  $('strength-label').textContent=`میزان ${procedure.name}`;
  setRange('strength',strength);$('strength-amount').textContent=pct(strength);
  renderActiveList();
}
function renderActiveList(){
  $('active-list').replaceChildren(...[...active].filter(([,v])=>v>0).map(([id,v])=>{
    const procedure=byId(id);
    return el('button',{type:'button','aria-current':String(id===currentProcedure),onclick:()=>showProcedure(id),
      title:'انتخاب برای تنظیم'},procedure.name,' ',el('b',{text:pct(v)}));
  }));
}
// One procedure at a time unless "combine" is on: picking another replaces the one
// shown, which is what most people expect. Combined, each one picked is added.
const COMBINE='roja-combine';
try{$('combine-procedures').checked=localStorage.getItem(COMBINE)==='1';}catch{}
function activateProcedure(id){
  if(active.has(id))return;
  if(!$('combine-procedures').checked)active.clear();
  setStrength(id,60);
}
function setStrength(id,value){
  if(value>0){active.set(id,value);count('procedure',id);}else active.delete(id);
  $('procedure-reset').hidden=!anyProcedure();
  buildTray();renderActiveList();updateSeam();invalidate({masks:true,measure:true});
}

/* ---------- the seam ---------------------------------------------------- */
function seamLabels(){
  if(mode==='procedure')return ['پیش از عمل','پس از عمل'];
  if(pin)return [shadeOf(byProduct(pin.product),pin.shade).name,selected().name];
  return ['بدون آرایش','با آرایش'];
}
function updateSeam(){
  seamOn=!!source&&(!!stage||!!source.native)&&(mode==='procedure'?anyProcedure():(compare||!!pin));
  $('seam').hidden=!seamOn;
  $('seam').classList.toggle('passive',brushActive());
  if(seamOn){
    const [before,after]=seamLabels();
    $('seam-before').textContent=before;$('seam-after').textContent=after;
    placeSeam();
  }
  $('compare').setAttribute('aria-pressed',String(mode==='makeup'?compare||!!pin:seamOn));
}
// object-fit:contain letterboxes the frame inside the stage, so the seam must be
// measured and drawn against the displayed frame rather than the whole element.
// Mixing the two puts the cut and the line in different places everywhere except
// dead centre, by half the letterbox width at the edges.
function videoBox(){
  const rect=viewport.getBoundingClientRect();
  const {w,h}=frameSize();
  const ratio=w/h||4/3;
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
// A pointer position as a point in frame pixels. The frame is mirrored on screen.
function framePoint(event){
  const box=videoBox(),{w,h}=frameSize();
  const fx=(event.clientX-box.rect.left-box.left)/box.width,fy=(event.clientY-box.rect.top-box.top)/box.height;
  return {x:(1-fx)*w,y:fy*h,inside:fx>=0&&fx<=1&&fy>=0&&fy<=1,
    screenX:event.clientX-box.rect.left,screenY:event.clientY-box.rect.top,scale:box.width/w};
}

/* ---------- tray -------------------------------------------------------- */
function buildTray(){
  const groups=$('tray-groups'),chips=$('tray-chips');
  groups.replaceChildren();chips.replaceChildren();
  if(mode==='makeup'){
    $('tray').setAttribute('aria-label','انتخاب محصول');
    for(const cat of categories){
      groups.append(el('button',{type:'button','aria-pressed':String(cat.id===category),data:{group:cat.id},text:cat.name,
        title:cat.hint,onclick:()=>{category=cat.id;updateTrayState();chips.querySelector(`[data-sep="${cat.id}"]`)?.scrollIntoView({inline:'start',block:'nearest'});}}));
      chips.append(el('span',{class:'tray-sep',data:{sep:cat.id},text:cat.name}));
      for(const item of products.filter(p=>p.category===cat.id)){
        const dot=el('i',{class:'dot'});
        chips.append(el('button',{class:'chip',type:'button',data:{product:item.id},'aria-pressed':String(item.id===product.id),
          onclick:()=>{selectProduct(item.id);showPane('color');}},dot,item.name));
      }
    }
    updateTrayState();
    chips.querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }else{
    $('tray').setAttribute('aria-label','انتخاب عمل');
    for(const region of regions){
      const list=procedures.filter(p=>p.region===region.id);
      if(!list.length)continue;
      groups.append(el('button',{type:'button','aria-pressed':String(region.id===procGroup),data:{group:region.id},text:region.name,
        onclick:()=>{procGroup=region.id;groups.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.group===region.id)));
          chips.querySelector(`[data-sep="${region.id}"]`)?.scrollIntoView({inline:'start',block:'nearest'});}}));
      chips.append(el('span',{class:'tray-sep',data:{sep:region.id},text:region.name}));
      for(const procedure of list){
        const strength=active.get(procedure.id)||0;
        const b=el('button',{class:'chip',type:'button',data:{procedure:procedure.id},'aria-pressed':String(strength>0)},procedure.name);
        if(strength>0)b.append(el('span',{class:'on',text:pct(strength)}));
        b.onclick=()=>{activateProcedure(procedure.id);showProcedure(procedure.id);};
        chips.append(b);
      }
    }
  }
}
function updateTrayState(){
  $('tray-chips').querySelectorAll('[data-product]').forEach(b=>{
    const item=byProduct(b.dataset.product),state=makeupState[item.id];
    b.setAttribute('aria-pressed',String(item.id===product.id));
    b.classList.toggle('on',state.enabled);
    b.querySelector('.dot').style.background=shadeOf(item,state.shade).color;
  });
  $('tray-groups').querySelectorAll('[data-group]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.group===category)));
}

/* ---------- modes ------------------------------------------------------- */
function statusText(){
  if(!source)return 'برای شروع، دوربین را روشن کن یا یک عکس انتخاب کن.';
  if(!landmarks){
    if(source.kind==='photo')return photoPasses>=PHOTO_PASSES?'در این عکس صورتی پیدا نشد. عکسی از روبه‌رو و با نور کافی انتخاب کن.':'در حال پیدا کردن صورت در عکس…';
    return 'صورتت را روبه‌روی دوربین نگه دار.';
  }
  if(poseAngles&&(Math.abs(poseAngles.yaw)>24||Math.abs(poseAngles.pitch)>22))
    return 'کمی مستقیم‌تر به دوربین نگاه کن تا نتیجه دقیق‌تر شود.';
  if(finder.state==='sampling')return 'بی‌حرکت بمان؛ رنگ پوست در حال اندازه‌گیری است…';
  if(mode==='skin')return 'تحلیل پوست: صورت بدون آرایش، روبه‌روی نور روز.';
  if(mode==='procedure')return anyProcedure()?'مرز روی تصویر را بکش تا پیش و پس از عمل را مقایسه کنی.':'یک عمل را از نوار زیر آینه انتخاب کن.';
  if(brushActive()){
    const m=brushModes.find(x=>x.id===brushState.mode);
    return `روی تصویر بکش: ${m.name}. ${frozen||source.kind==='photo'?'':'برای دقت بیشتر تصویر را ثابت کن.'}`;
  }
  if(pin)return 'مرز را بکش تا دو رنگ را کنار هم روی صورتت ببینی.';
  if(compare)return 'مرز را بکش تا با و بدون آرایش را مقایسه کنی.';
  if(frozen)return 'تصویر ثابت است. برای ادامه، دوباره «ثابت» را بزن.';
  return 'آرایش زنده است.';
}
function setMode(next){
  mode=next;
  // The tour is about the makeup controls; leaving them ends it.
  if(tourAt>=0&&mode!=='makeup')endTour();
  $('mode-makeup').setAttribute('aria-selected',String(mode==='makeup'));
  $('mode-procedure').setAttribute('aria-selected',String(mode==='procedure'));
  $('mode-skin').setAttribute('aria-selected',String(mode==='skin'));
  $('panel-makeup').hidden=mode!=='makeup';
  $('panel-procedure').hidden=mode!=='procedure';
  $('panel-skin').hidden=mode!=='skin';
  $('quick-makeup').hidden=mode!=='makeup';
  $('quick-procedure').hidden=mode!=='procedure'||!currentProcedure;
  $('tray').hidden=$('quick').hidden=mode==='skin';
  $('brush-toggle').hidden=mode!=='makeup';
  $('compare').hidden=$('light-toggle').hidden=mode==='skin';
  if(mode==='skin'){$('light-menu').hidden=true;$('light-toggle').setAttribute('aria-expanded','false');}
  $('badge').hidden=mode!=='procedure'||!source;
  $('badge-text').textContent='شبیه‌سازی تصویری، نه نتیجهٔ قطعی';
  if(mode!=='makeup'&&brushState.on)setBrush(false);
  buildTray();updateSeam();
  invalidate({masks:true,measure:true});
  status(statusText());
}

/* ---------- drawing ----------------------------------------------------- */
function ensureStage(){
  if(!stage&&!stageBroken){
    stage=createStage($('stage'));
    if(!stage){stageBroken=true;$('webgl-missing').hidden=false;}
    else{masksDirty=true;queueMicrotask(updateSeam);}
  }
  return stage;
}
function stageLayer(spec,face){
  const f=FINISH[spec.finish]||FINISH.matte;
  const intensity=Math.max(0,Math.min(1,spec.intensity/100));
  const detail=(DETAIL[spec.type]??.8)*($('natural-blend').checked?1:.3);
  const glossy=spec.type==='gloss'?1:Math.min(1,intensity*1.4);
  // The slider is a promise: at 40 the product covers 40. The old curve bent a pigment
  // up to 1-(1-i)², so a 55 turned into 80% coverage — the single biggest reason the
  // makeup read as paint rather than product.
  const amount=intensity*(spec.type==='gloss'?.9:1);
  // Turning off "blend with the skin's texture" should mean exactly that, so the sheer
  // pass — which exists to let the skin through — closes down with it.
  return {key:spec.key,color:hexToRgb(spec.color),amount,
    sheer:(SHEER[spec.type]??0)*($('natural-blend').checked?1:.2),
    lift:spec.type==='concealer'?.75:0,
    mode:layerModes[spec.mode],detail,gloss:(f.gloss||0)*glossy,matte:f.matte||0,
    shimmer:(f.shimmer||0)*Math.min(1,intensity*1.6),
    smooth:spec.mode==='foundation'?(f.smooth??.4)*Math.min(1,.45+intensity):0,radius:Math.max(2,face*.03),radiusK:.03};
}
function textureLayer(t,face){
  return {key:t.key,color:[1,1,1],amount:1,mode:layerModes.smooth,detail:0,gloss:0,matte:0,shimmer:0,
    smooth:t.smooth,bright:t.bright||0,radius:Math.max(2,face*.035),radiusK:.035};
}
// What the stage should draw right now: the "after" side, and the "before" side
// when the seam is showing.
function plan(){
  // The skin check looks at the bare face.
  if(mode==='skin')return {after:[],before:null,textures:[],amounts:null};
  if(mode==='makeup'){
    const after=layerSpecs(makeupState);
    let before=null;
    if(pin)before=layerSpecs(pinnedStates());
    else if(compare)before=[];
    return {after,before,textures:[],amounts:null};
  }
  const makeup=$('with-makeup').checked?layerSpecs(makeupState):[];
  const amounts=procedureAmounts();
  return {after:makeup,before:anyProcedure()?makeup:null,textures:textureLayers(amounts),amounts};
}
const TYPE_COLOR={foundation:'#E0B48C',concealer:'#F5D7B2',contour:'#8E6E5E',blush:'#FF6F91',highlighter:'#FFF1B8',
  eyeshadow:'#B388FF',eyeliner:'#40C4FF',mascara:'#00E5FF',brow:'#FFAB40',lipliner:'#FF5252',lipstick:'#FF1744',gloss:'#FF80AB',texture:'#69F0AE'};
// Masks are painted in the face's own front-on space (facemesh.js) and the stage
// carries them onto the live face each frame, so they are repainted only when what is
// on the face changes (a product, a setting, a brush stroke), never because it moved.
const FACE_W=768, FACE_H=Math.round(FACE_W*CANON_ASPECT);
const canonLandmarks=Array.from({length:CANON.length/2},(_,i)=>({x:CANON[i*2],y:CANON[i*2+1]}));
const maskCrop=document.createElement('canvas');
function maskSpecs(p){
  const specs=new Map();
  for(const s of [...p.after,...(p.before||[])])specs.set(s.key,s);
  for(const t of p.textures)specs.set(t.key,{key:t.key,type:'texture',zone:t.zone,fade:60});
  return specs;
}
function rebuildMasks(p){
  const maps=brush.maps(canonLandmarks,FACE_W,FACE_H);
  const specs=maskSpecs(p);
  const cx=maskCrop.getContext('2d',{willReadFrequently:!!source?.native});
  for(const spec of specs.values()){
    const canvas=painter.paint(spec,canonLandmarks,FACE_W,FACE_H,spec.type==='texture'?null:maps);
    // Only the painted part is uploaded; the stage treats the rest as empty.
    const b=painter.box,W=canvas.width,H=canvas.height;
    const x0=Math.floor(b.x*W),y0=Math.floor(b.y*H),x1=Math.ceil((b.x+b.w)*W),y1=Math.ceil((b.y+b.h)*H);
    const cw=Math.max(1,x1-x0),ch=Math.max(1,y1-y0);
    maskCrop.width=cw;maskCrop.height=ch;
    cx.drawImage(canvas,x0,y0,cw,ch,0,0,cw,ch);
    const uv={x:x0/W,y:y0/H,w:cw/W,h:ch/H};
    if(source?.native)sendMask(spec.key,cx,cw,ch,uv);
    else stage.setMask(spec.key,maskCrop,uv);
  }
  if(source?.native)native.mirrorKeep(JSON.stringify([...specs.keys()]));
  else stage.dropMasks(new Set(specs.keys()));
  masksDirty=false;
}
// A mask for the native renderer: one byte a pixel (its coverage), base64.
function sendMask(key,cx,w,h,uv){
  const rgba=cx.getImageData(0,0,w,h).data,alpha=new Uint8Array(w*h);
  for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];
  let text='';
  for(let i=0;i<alpha.length;i+=0x8000)text+=String.fromCharCode.apply(null,alpha.subarray(i,i+0x8000));
  native.mirrorMask(key,JSON.stringify([uv.x,uv.y,uv.w,uv.h]),w,h,btoa(text));
}
// The debug overlay's view of the masks, on the frame: painted the slow way, from the
// live landmarks, and only while that view is open.
function paintMaskView(p){
  const {w,h}=frameSize();
  if(!maskView)maskView=document.createElement('canvas');
  maskView.width=w;maskView.height=h;
  if(maskTint.width!==w||maskTint.height!==h){maskTint.width=w;maskTint.height=h;}
  const mv=maskView.getContext('2d'),t=maskTint.getContext('2d');
  const maps=brush.maps(landmarks,w,h);
  for(const spec of maskSpecs(p).values()){
    const canvas=painter.paint(spec,landmarks,w,h,spec.type==='texture'?null:maps);
    t.globalCompositeOperation='source-over';t.clearRect(0,0,w,h);t.drawImage(canvas,0,0,w,h);
    t.globalCompositeOperation='source-in';t.fillStyle=TYPE_COLOR[spec.type]||'#fff';t.fillRect(0,0,w,h);
    mv.drawImage(maskTint,0,0);
  }
}
// Both cheeks, the forehead and the chin: where the light on the face is read.
function probes(){
  return [50,280,151,199].flatMap(i=>[landmarks[i].x,landmarks[i].y]).map(v=>Math.min(.99,Math.max(.01,v)));
}
function draw(now=performance.now()){
  if(!source){ctxClear();return;}
  const {w,h}=frameSize();
  if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
  const p=plan();
  if(source.native){drawNative(p);return;}
  const gl=ensureStage();
  const face=faceWidthPx();
  if(gl){
    if(debug.on&&debug.masks&&landmarks&&(dirty||masksDirty))paintMaskView(p);
    if(masksDirty){const t=performance.now();rebuildMasks(p);perf.maskMs=ema(perf.maskMs,performance.now()-t);}
    const t=performance.now();
    const sync=source.kind==='camera'&&syncing();
    const ok=gl.draw({
      source:sync?shown:source.el,width:w,height:h,
      version:sync?`s${shownVersion}`:source.version,live:source.live&&!sync,landmarks,
      after:{layers:[...p.after.map(s=>stageLayer(s,face)),...p.textures.map(t=>textureLayer(t,face))],amounts:p.amounts},
      before:p.before?{layers:p.before.map(s=>stageLayer(s,face)),amounts:null}:null,
      seam:seamOn?1-seam:null,grade:mode==='skin'?null:lights.find(l=>l.id===light).grade,
      probes:landmarks?probes():null,time:now/1000
    });
    perf.drawMs=ema(perf.drawMs,performance.now()-t);perf.draws++;
    if(!ok&&sync){stepBroken=true;perf.lastError='in step: the frame could not be drawn';dirty=true;return;}
    if(ok){
      // The canvas covers the video exactly. The video stays visible underneath: iOS
      // pauses a muted video it thinks is hidden, which froze the camera on its first
      // frame, so the face was never found and no makeup ever appeared.
      $('stage').hidden=false;photo.hidden=true;
      octx.clearRect(0,0,w,h);overlay.classList.remove('natural');
    }
  }else{
    $('stage').hidden=true;video.style.visibility='';
    photo.hidden=source.kind!=='photo';
    overlay.classList.toggle('natural',$('natural-blend').checked);
    if(masksDirty||dirty){
      const specs=mode==='makeup'&&!compare?layerSpecs(makeupState):[];
      renderFallback(octx,specs,landmarks,painter,landmarks?brush.maps(landmarks,w,h):null);
      masksDirty=false;
    }
  }
  dirty=false;
}
function ctxClear(){octx.clearRect(0,0,overlay.width,overlay.height);}

// The landmarks driving what is on screen right now: the contours of each product
// that is switched on, or the anchors of every control a procedure is moving.
function activeLandmarks(){
  const set=new Set(frameLandmarks);
  if(mode==='skin')return set;
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
  if($('with-makeup').checked)
    for(const item of products)
      if(makeupState[item.id].enabled)
        for(const index of landmarksByType[item.type]||[])set.add(index);
  return set;
}

// Hundreds of numbered labels are not cheap, so this only redraws when the points,
// the selection or the settings actually change, not on every animation frame.
let debugDrawn=null,debugSettings='';
function drawDebug(){
  const on=debug.on&&!!source;
  debugCanvas.hidden=!on;
  if(!on){debugDrawn=null;return;}
  const {w,h}=frameSize();
  if(debugCanvas.width!==w||debugCanvas.height!==h){debugCanvas.width=w;debugCanvas.height=h;debugDrawn=null;}
  const set=activeLandmarks();
  const settings=JSON.stringify({...debug,hud:0,inspect:0})+[...set].join()+brush.version+mode+(masksDirty?1:0);
  if(landmarks===debugDrawn&&settings===debugSettings&&!debugDirty)return;
  debugDrawn=landmarks;debugSettings=settings;debugDirty=false;
  const amounts=mode==='procedure'?procedureAmounts():null;
  renderDebug(debugCtx,landmarks,{...debug,active:set,topology,
    defs:debug.field&&landmarks&&amounts?deformers(landmarks,w,h,amounts):null,
    masks:debug.masks&&maskView?maskView:null,
    strokes:debug.strokes&&landmarks?brush.outlines(landmarks,w,h):null});
  $('debug-count').textContent=set.size>frameLandmarks.length
    ? `${fa.format(set.size)} نقطه در این لحظه درگیرند.`
    : 'هیچ محصول یا عملی فعال نیست.';
}

/* ---------- measurements ------------------------------------------------ */
let lastMeasure=0;
function renderMeasure(now){
  if(mode!=='procedure'||!measureDirty||now-lastMeasure<180)return;
  lastMeasure=now;measureDirty=false;
  const table=$('measure-table');
  if(!landmarks){table.replaceChildren(el('span',{class:'empty',text:'صورت روی آینه نیست.'}));return;}
  const {w,h}=frameSize();
  const amounts=procedureAmounts();
  const before=measure(placed(landmarks,w,h));
  const after=measure(placed(landmarks,w,h,anyProcedure()?deformers(landmarks,w,h,amounts):null));
  const cells=[el('span',{class:'h',text:'اندازه'}),el('span',{class:'h',text:'پیش'}),el('span',{class:'h',text:'پس'}),el('span',{class:'h',text:'تغییر'})];
  const format=m=>m.unit==='×'?fa2.format(m.value):m.unit==='°'?fa1.format(m.value)+'°':fa1.format(m.value)+'٪';
  for(const metric of metrics){
    const a=before[metric.id],b=after[metric.id];
    const change=metric.id==='canthal'?b.value-a.value:(b.value-a.value)/(Math.abs(a.value)||1)*100;
    const moved=Math.abs(change)>=(metric.id==='canthal'?.3:.5);
    const cls=moved?'changed':'';
    const sign=change>0?'+':change<0?'−':'';
    cells.push(el('span',{class:cls,text:metric.name}),el('span',{class:cls,text:format(a)}),el('span',{class:cls,text:format(b)}),
      el('span',{class:`${cls} ${moved?(change>0?'up':'down'):''}`,text:moved?(metric.id==='canthal'?`${sign}${fa1.format(Math.abs(change))}°`:`${sign}${fa.format(Math.round(Math.abs(change)))}٪`):'—'}));
  }
  table.replaceChildren(...cells);
}

/* ---------- debug readout ----------------------------------------------- */
const EXPRESSIONS={jawOpen:'باز بودن دهان',mouthSmileLeft:'لبخند (چپ)',mouthSmileRight:'لبخند (راست)',eyeBlinkLeft:'پلک (چپ)',
  eyeBlinkRight:'پلک (راست)',browInnerUp:'بالا رفتن ابرو',browDownLeft:'اخم (چپ)',browDownRight:'اخم (راست)',mouthPucker:'غنچه‌کردن لب'};
function debugStats(){
  const {w,h}=frameSize();
  const specs=mode==='makeup'?layerSpecs(makeupState):plan().after;
  const amounts=mode==='procedure'?procedureAmounts():null;
  const defs=landmarks&&amounts?deformers(landmarks,w,h,amounts).length:0;
  const pts=landmarks?placed(landmarks,w,h):null;
  const top=(blendshapes||[]).filter(([n])=>n!=='_neutral').sort((a,b)=>b[1]-a[1]).slice(0,3);
  return [
    ['مسیر نمایش',source?.native?`native · ${nativeInfo.gpu||'OpenGL ES'}`:stage?'WebGL':stageBroken?'2D canvas':'—'],
    ['منبع',source?(source.kind==='photo'?'photo':frozen?'camera (frozen)':'camera'):'—'],
    ['فریم',source?`${w}×${h}`:'—'],
    ['نمایش',source?.native?`${nativeInfo.fps||0} fps (native)`:`${perf.drawn} fps (حلقه ${perf.fps})`],
    ['ردیابی',source?.native?`${nativeInfo.hz||0} Hz · native · ${nativeInfo.delegate||'—'}`
      :`${perf.hz} Hz · ${Math.round(perf.latency)} ms · ${tracker?(tracker.kind==='worker'?'worker':'main thread'):trackerStarting?'starting':'—'}${delegate?' · '+delegate:''}`],
    ['مدل',`${perf.inferMs.toFixed(1)} ms هر فریم${source?.native?(nativeInfo.note?' · '+nativeInfo.note.slice(0,60):''):gpuError?' · GPU: '+gpuError.slice(0,60):''}`],
    ['هماهنگی',source?.kind==='camera'?(source.native||syncing()?'فریم و نقاط هم‌زمان':'تصویر زنده'):'—'],
    ['هزینهٔ هر فریم',`masks ${perf.maskMs.toFixed(1)} ms · draw ${(source?.native?nativeInfo.draw||0:perf.drawMs).toFixed(1)} ms`],
    ['نقاط',landmarks?String(landmarks.length):'0'],
    ['پهنای صورت',landmarks?`${Math.round(faceWidthPx())} px`:'—'],
    ['زاویهٔ سر',poseAngles?`yaw ${poseAngles.yaw.toFixed(1)}° · pitch ${poseAngles.pitch.toFixed(1)}° · roll ${poseAngles.roll.toFixed(1)}°`:'—'],
    ['تقارن',pts?`${symmetry(pts).toFixed(0)} / 100`:'—'],
    ['لایه‌ها',`${specs.length} makeup · ${defs} deformers · ${brush.count} strokes`],
    ['حالت چهره',top.length?top.map(([n,s])=>`${EXPRESSIONS[n]||n} ${s.toFixed(2)}`).join('، '):'—'],
    ['مرورگر',`${iOS?'iOS · ':''}${(ua.match(/(CriOS|FxiOS|EdgiOS|Edg|OPR|Chrome|Firefox|Version)\/[\d.]+/)||[''])[0]}${inApp?' · in-app':''}`],
    ['آخرین خطا',perf.lastError||'—']
  ];
}
function updateHud(now){
  perf.frames++;
  if(now-perf.since>=1000){
    const k=1000/(now-perf.since);
    perf.fps=Math.round(perf.frames*k);perf.hz=Math.round(perf.detections*k);perf.drawn=Math.round(perf.draws*k);
    perf.frames=0;perf.detections=0;perf.draws=0;perf.since=now;
    // In step from 16 tracked frames a second, back to live below 12.
    inStep=source?.kind==='camera'&&(alwaysInStep||(inStep?perf.hz>=12:perf.hz>=16));
  }
  if(!debug.on&&!$('debug-panel').open)return;
  if(now-perf.lastHud<250)return;
  perf.lastHud=now;
  const stats=debugStats();
  $('debug-stats').replaceChildren(...stats.flatMap(([k,v])=>[el('dt',{text:k}),el('dd',{text:v})]));
  $('hud').hidden=!(debug.on&&debug.hud&&source);
  if(!$('hud').hidden)$('hud').textContent=stats.filter(([k])=>k!=='حالت چهره').map(([k,v])=>v).join('\n');
}
function exportData(){
  const {w,h}=frameSize();
  const amounts=procedureAmounts();
  return {
    app:'roja',version:13,time:new Date().toISOString(),
    frame:{width:w,height:h,source:source?.kind||null,frozen},
    landmarks:landmarks?landmarks.map(l=>[+l.x.toFixed(5),+l.y.toFixed(5),+(l.z||0).toFixed(5)]):null,
    pose:poseAngles,blendshapes:blendshapes?Object.fromEntries(blendshapes.map(([n,s])=>[n,+s.toFixed(4)])):null,
    measurements:landmarks?measure(placed(landmarks,w,h)):null,
    symmetry:landmarks?symmetry(placed(landmarks,w,h)):null,
    makeup:layerSpecs(makeupState).map(s=>({product:s.product,zone:s.zone||null,color:s.color,intensity:s.intensity,fade:s.fade,finish:s.finish,style:s.style||null})),
    procedures:{active:Object.fromEntries(active),variants:Object.fromEntries(variants),amounts:Object.fromEntries(Object.entries(amounts).filter(([,v])=>v))},
    brushStrokes:brush.count
  };
}

/* ---------- sources: camera and photo ----------------------------------- */
let stream=null,tracker=null,trackerStarting=false,trackerGeneration=0,ready=false,busy=false,activeSource=false;
let generation=0,raf=0,lastSent=0,sentAt=0,sentGen=-1,initTimer;
let photoPasses=0,sourceVersion=0;
const PHOTO_PASSES=8;
const smoother=createSmoother();
// The model on the GPU, off iPhones (where MediaPipe's GPU path is not dependable in
// WebKit); the tracker falls back to the CPU by itself if the GPU fails. ?gpu=0 keeps
// it on the CPU, ?gpu=force insists on the GPU, for comparing the two.
const params=new URLSearchParams(location.search),gpuParam=params.get('gpu');
// ?sync=always shows frames in step whatever the tracker's pace (for testing).
const alwaysInStep=params.get('sync')==='always';
const gpuQuery=gpuParam==='0'?'':gpuParam==='force'?'&gpu=force':iOS?'':'&gpu=1';
let delegate='', gpuError='';
// The fast path: a camera frame goes to the worker as a VideoFrame, with no copy.
let fastFrames=!iOS&&typeof VideoFrame==='function';
// Either way a copy of the frame sent is kept, and when its landmarks come back that
// very frame is shown with them: the makeup sits exactly on the face in the picture
// instead of trailing the live video by one tracking round-trip. The picture then
// moves at the tracker's pace, so this is done only while the tracker keeps up;
// below that, the live video with the latest landmarks looks better.
let inFlight=null, shown=null, shownAt=0, shownVersion=0, inStep=false;
// A camera frame that has not been measured yet (requestVideoFrameCallback), so the
// model never runs twice on the same picture.
let freshFrame=false, watching=0;
function watchFrames(){
  if(!video.requestVideoFrameCallback)return;
  const token=++watching;
  const tick=()=>{if(token!==watching||source?.kind!=='camera')return;freshFrame=true;video.requestVideoFrameCallback(tick);};
  video.requestVideoFrameCallback(tick);
}
function dropFrames(){
  inFlight?.close();inFlight=null;
  shown?.close();shown=null;
}
// A WebGL that cannot take the kept frame as a texture turns showing in step off.
let stepBroken=false;
const syncing=()=>inStep&&!stepBroken&&!!shown&&performance.now()-shownAt<400;

// The tracker runs in a worker. Where a worker cannot start MediaPipe (iPhones before
// iOS 17 have no WebGL inside workers) the same code runs on the page instead: a
// little slower, but the mirror works.
function onTracker(d){
  if(d.type==='progress'){showLoading(d.loaded,d.total);return;}
  if(d.type==='ready'){
    clearTimeout(initTimer);ready=true;topology=d.topology;showLoading(null);
    delegate=d.delegate||'CPU';if(d.gpuError)gpuError=d.gpuError;
    if(delegate!=='GPU')fastFrames=false;
    if(source){status(statusText());enableTools(true);}
  }else if(d.type==='skip'){
    busy=false;inFlight?.close();inFlight=null;
  }else if(d.type==='result'){
    busy=false;
    const frame=inFlight;inFlight=null;
    if(sentGen!==generation||!source){frame?.close();return;}
    perf.detections++;perf.latency=performance.now()-sentAt;perf.inferMs=ema(perf.inferMs,d.ms||0);
    if(frame){shown?.close();shown=frame;shownAt=performance.now();shownVersion++;}
    landmarks=smoother.smooth(d.landmarks,sentAt);
    if(landmarks)count('step','face');
    if(source.kind==='photo')photoPasses++;
    poseAngles=d.landmarks?poseOf(d.matrix):null;
    if(d.blendshapes)blendshapes=d.blendshapes;
    if('skin' in d)onSkin(d.skin);
    else if(wantSkin&&!d.landmarks)onSkin(null);
    $('guide').hidden=!!landmarks;
    status(landmarks||source.kind==='photo'?statusText():'صورت پیدا نشد. کمی روبه‌روی دوربین و در نور بیشتر قرار بگیر.');
    invalidate({measure:true});
  }else if(d.type==='error'){
    busy=false;inFlight?.close();inFlight=null;
    perf.lastError=`${d.stage||'tracker'}: ${d.message||''}`;
    if(d.recoverable){gpuError=d.message;fastFrames=false;return;}
    if(!ready&&tracker?.kind==='worker')useTracker('page',d.message);
    else shutdown('آینه روی این مرورگر آماده نشد. آخرین نسخهٔ مرورگر را امتحان کن.'+code({message:d.message}));
  }
}
function ensureTracker(){
  if(tracker||trackerStarting)return;
  let w=null;
  try{w=new Worker(new URL(`face-worker.js?v=24${gpuQuery}`,import.meta.url));}catch(e){perf.lastError=`worker: ${e.message}`;}
  if(!w){useTracker('page','no worker');return;}
  ready=false;busy=false;
  tracker={kind:'worker',post:(m,transfer)=>w.postMessage(m,transfer),close:()=>w.terminate()};
  w.onmessage=e=>onTracker(e.data);
  w.onerror=e=>{
    e.preventDefault?.();
    if(!ready)useTracker('page',e.message||'worker failed');
    else shutdown('بارگذاری آینه انجام نشد. دوباره امتحان کن.'+code({message:e.message}));
  };
  clearTimeout(initTimer);
  initTimer=setTimeout(()=>{if(!ready)shutdown('آماده‌سازی طول کشید. اتصال اینترنت را بررسی کن و دوباره امتحان کن.');},90000);
}
async function useTracker(kind,reason){
  if(tracker){tracker.close();tracker=null;}
  ready=false;busy=false;trackerStarting=true;
  perf.trackerNote=reason||'';
  const token=++trackerGeneration;
  try{
    const Vision=await import('./vendor/vision_bundle.mjs');
    await import('./face-core.js?v=24');
    const core=self.rojaFaceCore(Vision,new URL('./',import.meta.url).href);
    const found=await core.init('CPU',(loaded,total)=>{if(token===trackerGeneration)onTracker({type:'progress',loaded,total});});
    if(token!==trackerGeneration){core.close();return;}
    tracker={kind,post:m=>setTimeout(()=>{
      let out;
      try{out=core.handle(m);}catch(e){out={type:'error',stage:'detect',message:String(e?.message||e)};}
      finally{m.frame?.close?.();}
      onTracker(out);
    },0),close:()=>core.close()};
    trackerStarting=false;
    onTracker({type:'ready',topology:found,delegate:found.delegate});
  }catch(e){
    trackerStarting=false;
    if(token===trackerGeneration)shutdown('آینه روی این مرورگر آماده نشد. آخرین نسخهٔ Safari یا Chrome را امتحان کن.'+code(e));
  }
}
// How far the face model and its runtime have come down, on the mirror, while they do.
// From the cache it is over before it is seen; the first time it is ~15 MB.
const mb=new Intl.NumberFormat('fa-IR',{maximumFractionDigits:0});
const percent=new Intl.NumberFormat('fa-IR',{style:'percent'});
function showLoading(loaded,total){
  const box=$('loading');
  if(loaded==null||!total||!source){box.hidden=true;return;}
  const part=Math.min(.99,loaded/total);
  box.hidden=false;
  $('loading-bar').style.width=`${part*100}%`;
  $('loading-track').setAttribute('aria-valuenow',Math.round(part*100));
  $('loading-percent').textContent=percent.format(part);
  $('loading-text').textContent=`${mb.format(loaded/1048576)} از ${mb.format(total/1048576)} مگابایت`;
}
function shutdown(message){
  if(tracker)tracker.close();tracker=null;ready=false;busy=false;trackerStarting=false;trackerGeneration++;
  stop(message);
}
function enableTools(on){
  for(const id of ['compare','brush-toggle','snap','light-toggle'])$(id).disabled=!on;
  $('freeze').disabled=!on||source?.kind!=='camera';
}
function goLive(){
  $('welcome').hidden=true;viewport.classList.add('live');
  $('toolbar').hidden=false;$('stop').disabled=false;
  $('stop').lastChild.textContent=source.kind==='photo'?'بستن عکس':'خاموش‌کردن';
  $('guide').hidden=false;
  $('badge').hidden=mode!=='procedure';
  landmarks=null;poseAngles=null;photoPasses=0;
  overlay.width=source.width;overlay.height=source.height;
  enableTools(ready||!!source.native);
  count('step',source.kind==='photo'?'photo':'camera');
  if(!source.native)ensureTracker();
  native?.keepScreenOn?.(true);
  cancelAnimationFrame(raf);raf=requestAnimationFrame(frame);
  updateSeam();invalidate({masks:true,measure:true});
  setTimeout(startTour,1200);
}

function stop(message='دوربین خاموش شد.'){
  if(source?.native||nativeStarting){try{native.mirrorStop();}catch{}}
  nativeStarting=false;document.documentElement.classList.remove('native-live');lastPlan='';
  generation++;activeSource=false;busy=false;watching++;dropFrames();smoother.reset();
  cancelAnimationFrame(raf);
  if(stream)stream.getTracks().forEach(t=>t.stop());
  stream=null;video.srcObject=null;
  source=null;landmarks=null;poseAngles=null;blendshapes=null;frozen=false;
  $('freeze').setAttribute('aria-pressed','false');
  // dispose() loses the WebGL context to free the GPU at once, and a canvas hands a
  // lost context back forever; the next source needs a fresh canvas.
  if(stage){stage.dispose();stage=null;const fresh=$('stage').cloneNode(false);$('stage').replaceWith(fresh);}
  stageBroken=false;$('stage').hidden=true;video.style.visibility='';photo.hidden=true;
  $('webgl-missing').hidden=true;
  debugCanvas.hidden=true;debugDrawn=null;
  viewport.classList.remove('live');
  ctxClear();
  $('welcome').hidden=false;$('start').disabled=false;
  $('start').lastChild.textContent='روشن‌کردن دوربین';
  $('stop').disabled=true;$('toolbar').hidden=true;$('seam').hidden=true;seamOn=false;
  $('guide').hidden=true;$('badge').hidden=true;$('hud').hidden=true;$('loading').hidden=true;$('brush-cursor').hidden=true;$('tap-start').hidden=true;
  if(brushState.on)setBrush(false);
  enableTools(false);
  if(finder.state==='sampling'){finder.state='idle';wantSkin=false;renderFinder();}
  native?.keepScreenOn?.(false);
  status(message);
}

async function start(){
  if(activeSource&&(!source||source.kind==='camera'))return;
  if(source)stop('');
  activeSource=true;
  const token=++generation;
  $('start').disabled=true;$('start').lastChild.textContent='در حال آماده‌سازی…';
  if(nativeMirror){
    status('در حال روشن‌کردن دوربین…');
    nativeStarting=true;nativeToken=token;
    native.mirrorStart();
    return;
  }
  status('اجازهٔ دوربین را در مرورگر تأیید کن.');
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('UNSUPPORTED');
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}}});
    if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;video.srcObject=stream;
    const playing=await video.play().then(()=>true,()=>false);
    await videoSize(video);
    if(token!==generation)return;
    if(!video.videoWidth||!video.videoHeight)throw Object.assign(new Error('the camera sent no picture'),{name:'NoVideo'});
    source={kind:'camera',el:video,width:video.videoWidth,height:video.videoHeight,live:true,version:++sourceVersion};
    freshFrame=true;watchFrames();
    status(ready?'صورتت را روبه‌روی دوربین نگه دار.':'آماده‌سازی آینه. بار اول ممکن است کمی طول بکشد.');
    goLive();
    if(!playing)$('tap-start').hidden=false;
    stream.getVideoTracks()[0].onended=()=>stop();
  }catch(e){
    if(token!==generation)return;
    cameraFailed(e);
  }
}
// Why the camera did not start, in words, with where to allow it and an error code.
function cameraFailed(e){
  perf.lastError=`camera: ${e?.name||''} ${e?.message||''}`;
  const errors={
    NotAllowedError:'اجازهٔ دوربین داده نشد. '+cameraHelp()+' یا یک عکس انتخاب کن.',
    SecurityError:'اجازهٔ دوربین داده نشد. '+cameraHelp(),
    NotFoundError:'دوربینی پیدا نشد. می‌توانی به‌جای آن یک عکس انتخاب کنی.',
    OverconstrainedError:'دوربین این دستگاه تنظیم خواسته‌شده را ندارد. یک عکس انتخاب کن.',
    NotReadableError:'دوربین در دسترس نیست. برنامه‌های دیگری که از آن استفاده می‌کنند را ببند.',
    NoVideo:'دوربین روشن شد اما تصویری نفرستاد. صفحه را دوباره باز کن.',
    TrackerError:'ردیابی چهره روی این گوشی آماده نشد.'
  };
  stop((errors[e.name]||(e.message==='UNSUPPORTED'
    ?(inApp?'این صفحه در مرورگر داخلی یک برنامه باز شده که به دوربین دسترسی ندارد. آن را در Safari یا Chrome باز کن، یا یک عکس انتخاب کن.'
      :'این مرورگر دوربین را پشتیبانی نمی‌کند. سایت را با HTTPS در Safari یا Chrome باز کن، یا یک عکس انتخاب کن.')
    :'دوربین باز نشد. دوباره امتحان کن.'))+code(e));
}

/* ---------- the native mirror (inside the Android app) --------------------- */
let nativeStarting=false, nativeToken=0, nativeInfo={}, lastPlan='', nativeSkin=false, nativeExtras=false;
let snapWaiters=[];
// The mirror mesh, for the debug overlay (the browser tracker would supply it).
const meshTopology=(()=>{
  const seen=new Set(),pairs=[];
  for(let t=0;t<TRIANGLES.length;t+=3)for(const [a,b] of [[0,1],[1,2],[2,0]]){
    const i=TRIANGLES[t+a],j=TRIANGLES[t+b],key=i<j?i*1000+j:j*1000+i;
    if(!seen.has(key)){seen.add(key);pairs.push([i,j]);}
  }
  return {tesselation:pairs,contours:{}};
})();
// Where the mirror is, for the renderer under the page, in device pixels; and the hole
// the page leaves there so it shows through.
function placeNative(){
  if(!source?.native)return;
  const rect=viewport.getBoundingClientRect(),box=videoBox(),dpr=devicePixelRatio||1,r=Math.round;
  const radius=parseFloat(getComputedStyle(viewport).borderTopLeftRadius)||0;
  native.mirrorPlace(JSON.stringify({x:r(rect.left*dpr),y:r(rect.top*dpr),w:r(rect.width*dpr),h:r(rect.height*dpr),r:radius*dpr,
    px:r((rect.left+box.left)*dpr),py:r((rect.top+box.top)*dpr),pw:r(box.width*dpr),ph:r(box.height*dpr)}));
  const root=document.documentElement.style;
  root.setProperty('--hole-x',rect.left+'px');root.setProperty('--hole-y',rect.top+'px');
  root.setProperty('--hole-w',rect.width+'px');root.setProperty('--hole-h',rect.height+'px');
}
new ResizeObserver(()=>placeNative()).observe(viewport);
window.addEventListener('resize',()=>placeNative());
// What the renderer should draw, sent only when it changes.
function drawNative(p){
  if(masksDirty){const t=performance.now();rebuildMasks(p);perf.maskMs=ema(perf.maskMs,performance.now()-t);}
  const json=JSON.stringify({
    after:[...p.after.map(s=>stageLayer(s,0)),...p.textures.map(t=>textureLayer(t,0))],amounts:p.amounts,
    before:p.before?p.before.map(s=>stageLayer(s,0)):null,
    seam:seamOn?1-seam:null,grade:lights.find(l=>l.id===light).grade
  });
  if(json!==lastPlan){native.mirrorPlan(json);lastPlan=json;}
  octx.clearRect(0,0,overlay.width,overlay.height);
  dirty=false;
}
function nativePicture(){
  return new Promise(resolve=>{snapWaiters.push(resolve);native.mirrorSnapshot();}).then(url=>{
    if(!url)return null;
    const image=new Image();image.src=url;
    return image.decode().then(()=>image,()=>null);
  });
}
window.rojaNative={
  onStart(width,height){
    if(!nativeStarting||nativeToken!==generation){try{native.mirrorStop();}catch{}return;}
    nativeStarting=false;
    source={kind:'camera',native:true,el:null,width,height,live:true,version:++sourceVersion};
    ready=true;topology=meshTopology;lastPlan='';masksDirty=true;
    $('stage').width=width;$('stage').height=height;
    document.documentElement.classList.add('native-live');
    status('صورتت را روبه‌روی دوربین نگه دار.');
    goLive();
    placeNative();
  },
  onFrame(d){
    if(!source?.native)return;
    nativeInfo=d.st||nativeInfo;
    perf.detections++;perf.inferMs=nativeInfo.infer||0;
    if(d.size&&(d.size[0]!==source.width||d.size[1]!==source.height)){
      // The phone turned: the frame did too.
      source.width=d.size[0];source.height=d.size[1];
      $('stage').width=source.width;$('stage').height=source.height;
      overlay.width=source.width;overlay.height=source.height;
      placeNative();if(seamOn)placeSeam();
    }
    const lm=d.lm;
    landmarks=lm?Array.from({length:lm.length/3},(_,i)=>({x:lm[i*3],y:lm[i*3+1],z:lm[i*3+2]})):null;
    poseAngles=landmarks&&d.m?poseOf(d.m):null;
    if(d.bs)blendshapes=d.bs;
    if('skin' in d)onSkin(d.skin);
    if(wantSkin!==nativeSkin){nativeSkin=wantSkin;native.mirrorSkin(wantSkin);}
    const extras=debug.on||$('debug-panel').open;
    if(extras!==nativeExtras){nativeExtras=extras;native.mirrorExtras(extras);}
    $('guide').hidden=!!landmarks;
    status(landmarks?statusText():'صورت پیدا نشد. کمی روبه‌روی دوربین و در نور بیشتر قرار بگیر.');
    invalidate({measure:true});
  },
  onError(name,message){
    if(!nativeStarting&&!source?.native)return;
    // A phone the native tracker cannot run on still has the browser's: carry on there.
    if(name==='TrackerError'){
      perf.lastError=`native tracker: ${message}`;nativeMirror=false;
      stop('');start();return;
    }
    const token=generation;
    stop('');
    if(token+1===generation)cameraFailed(Object.assign(new Error(message||name),{name}));
  },
  onStop(){if(source?.native)stop('با خارج‌شدن از برنامه، دوربین خاموش شد.');},
  onSnapshot(url){const waiting=snapWaiters;snapWaiters=[];waiting.forEach(done=>done(url));}
};
// For the app's device tests: what the mirror is showing.
window.rojaState=()=>({kind:source?.kind||null,native:!!source?.native,width:source?.width||0,height:source?.height||0,
  face:!!landmarks,points:landmarks?landmarks.map(q=>[+q.x.toFixed(4),+q.y.toFixed(4)]):null,info:nativeInfo});

// The stream's size can arrive a moment after the stream itself.
function videoSize(v,ms=5000){
  if(v.videoWidth&&v.videoHeight)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);v.removeEventListener('loadedmetadata',done);v.removeEventListener('resize',done);resolve();};
    const timer=setTimeout(done,ms);
    v.addEventListener('loadedmetadata',done);v.addEventListener('resize',done);
  });
}
// Turning an iPhone swaps the camera's width and height mid-stream.
video.addEventListener('resize',()=>{
  if(source?.kind!=='camera'||!video.videoWidth||!video.videoHeight)return;
  if(video.videoWidth===source.width&&video.videoHeight===source.height)return;
  source.width=video.videoWidth;source.height=video.videoHeight;
  overlay.width=source.width;overlay.height=source.height;
  invalidate({masks:true,measure:true});
  if(seamOn)placeSeam();
});
// Some browsers only start a camera picture from a tap on the page itself.
$('tap-start').onclick=()=>{
  video.play().then(()=>{$('tap-start').hidden=true;invalidate();},e=>toast('تصویر شروع نشد.'+code(e)));
};

// A photo is drawn mirrored, so the CSS mirror that suits a selfie camera shows it
// the right way round and every other part of the pipeline stays the same.
async function openPhoto(file){
  if(!file)return;
  if(source)stop('');
  const token=++generation;
  status('در حال باز کردن عکس…');
  try{
    const bitmap=await createImageBitmap(file);
    if(token!==generation){bitmap.close();return;}
    const scale=Math.min(1,960/Math.max(bitmap.width,bitmap.height));
    const w=Math.round(bitmap.width*scale),h=Math.round(bitmap.height*scale);
    photo.width=w;photo.height=h;
    const x=photo.getContext('2d');x.save();x.translate(w,0);x.scale(-1,1);x.drawImage(bitmap,0,0,w,h);x.restore();
    bitmap.close();
    activeSource=true;
    source={kind:'photo',el:photo,width:w,height:h,live:false,version:++sourceVersion};
    goLive();
    status(ready?'در حال پیدا کردن صورت در عکس…':'آماده‌سازی آینه. بار اول ممکن است کمی طول بکشد.');
  }catch{
    stop('این فایل باز نشد. یک عکس JPG یا PNG انتخاب کن.');
  }
}

function frame(now){
  if(!source)return;
  raf=requestAnimationFrame(frame);
  detect(now);
  // In step with the tracker, a frame is drawn when its landmarks arrive (which marks
  // the mirror dirty), not on every display refresh. Natively, the page only sends
  // what changed.
  if(source.native?(dirty||masksDirty):((source.live&&!syncing())||dirty||masksDirty||hasShimmer()))draw(now);
  drawDebug();
  if(mode==='skin')skinPanel.tick(now);
  renderMeasure(now);
  updateHud(now);
}
function hasShimmer(){return plan().after.some(s=>(FINISH[s.finish]?.shimmer||0)>0);}
function detect(now){
  if(!ready||busy||!tracker||!source||source.native)return;
  if(source.kind==='camera'){
    if(video.readyState<2)return;
    if(frozen){
      if(landmarks&&!wantSkin)return;
      if(now-lastSent<100)return;
    }else{
      // Each camera frame once, as soon as the last one is measured. Without
      // requestVideoFrameCallback, at the camera's pace at most.
      if(!video.requestVideoFrameCallback)freshFrame=now-lastSent>=30;
      if(!freshFrame)return;
      // On the page itself a little less often, so the interface stays responsive.
      if(tracker.kind==='page'&&now-lastSent<80)return;
    }
  }else{
    if(photoPasses>=PHOTO_PASSES&&!wantSkin)return;
    if(now-lastSent<30)return;
  }
  busy=true;freshFrame=false;lastSent=now;sentAt=performance.now();sentGen=generation;
  const token=generation;
  grabFrame().then(({frame,transfer,keep})=>{
    if(token!==generation||!tracker){frame.close?.();keep?.close();busy=false;return;}
    inFlight?.close();inFlight=keep||null;
    tracker.post({type:'frame',frame,timestamp:sentAt,extras:debug.on||$('debug-panel').open,sample:wantSkin},transfer);
  }).catch(e=>{busy=false;perf.lastError=`frame: ${e?.message||e}`;
    if(token===generation)stop('پردازش تصویر روی این مرورگر انجام نشد. مرورگر دیگری را امتحان کن.'+code(e));});
}
// The frame the tracker measures, at most 640 px wide. Drawing the video into a 2D canvas works
// the same everywhere; createImageBitmap straight from a camera video, with resizing,
// does not (WebKit on iPhone was the trouble). No createImageBitmap at all: ImageData.
const frameCanvas=document.createElement('canvas');
function grabFrame(){
  if(fastFrames&&source.kind==='camera'&&tracker.kind==='worker'&&!frozen){
    try{
      const frame=new VideoFrame(video,{timestamp:Math.round(sentAt*1000)});
      return Promise.resolve({frame,transfer:[frame],keep:frame.clone()});
    }catch(e){fastFrames=false;perf.lastError=`VideoFrame: ${e?.message||e}`;}
  }
  const scale=Math.min(1,640/source.width);
  const w=Math.max(1,Math.round(source.width*scale)),h=Math.max(1,Math.round(source.height*scale));
  if(frameCanvas.width!==w||frameCanvas.height!==h){frameCanvas.width=w;frameCanvas.height=h;}
  const x=frameCanvas.getContext('2d',{willReadFrequently:!window.createImageBitmap});
  x.drawImage(source.el,0,0,w,h);
  if(window.createImageBitmap)return Promise.all([createImageBitmap(frameCanvas),
    source.kind==='camera'&&!frozen?createImageBitmap(frameCanvas):null]).then(([frame,keep])=>({frame,transfer:[frame],keep}));
  const frame=x.getImageData(0,0,w,h);
  return Promise.resolve({frame,transfer:[frame.data.buffer]});
}

/* ---------- tools on the mirror ----------------------------------------- */
const brushActive=()=>brushState.on&&mode==='makeup'&&!!source;
function setBrush(on){
  brushState.on=on;
  if(on)showPane('brush');
  $('brush-on').checked=on;
  $('brush-toggle').setAttribute('aria-pressed',String(on));
  viewport.classList.toggle('painting',brushActive());
  if(!on){$('brush-cursor').hidden=true;brush.end();brushPointer=null;}
  if(on&&mode==='makeup'&&$('panel-makeup').hidden===false)$('brush-card').scrollIntoView({block:'nearest',behavior:'smooth'});
  updateSeam();status(statusText());
}
function renderBrushModes(){
  $('brush-modes').replaceChildren(...brushModes.map(m=>el('button',{type:'button',role:'radio',data:{mode:m.id},
    'aria-checked':String(m.id===brushState.mode),text:m.name,onclick:()=>{
      brushState.mode=m.id;renderBrushModes();
      if(!brushState.on)setBrush(true);
    }})));
  const m=brushModes.find(x=>x.id===brushState.mode);
  $('brush-help').textContent=m.help;
  setRange('brush-strength',brushState.strength[m.id]);
  $('brush-strength-amount').textContent=pct(brushState.strength[m.id]);
  $('brush-strength').disabled=m.id==='restore';
  $('brush-cursor').dataset.mode=m.id;
  status(statusText());
}
function updateBrushInfo(){
  $('brush-undo').disabled=!brush.count;$('brush-clear').disabled=!brush.count;
  $('brush-count').textContent=brush.count?`${fa.format(brush.count)} حرکت براش روی صورت.`:'';
}
function moveCursor(point){
  const cursor=$('brush-cursor');
  if(!brushActive()||!point.inside||!landmarks){cursor.hidden=true;return;}
  const radius=brushState.size/100*faceWidthPx()*point.scale;
  cursor.hidden=false;
  cursor.style.left=point.screenX+'px';cursor.style.top=point.screenY+'px';
  cursor.style.width=cursor.style.height=radius*2+'px';
}

function toggleCompare(){
  if(mode!=='makeup')return;
  if(pin){pin=null;updatePinButton();compare=false;}
  else compare=!compare;
  if(!stage&&!source?.native)toast(compare?'نمایش بدون آرایش':'نمایش با آرایش');
  updateSeam();invalidate({masks:true});status(statusText());
}
function toggleFreeze(){
  if(source?.kind!=='camera')return;
  frozen=!frozen;
  $('freeze').setAttribute('aria-pressed',String(frozen));
  if(source.native)native.mirrorFreeze(frozen);
  else if(frozen)video.pause();else video.play().catch(()=>{});
  status(statusText());
}

// The mirror as it is now, as a canvas: what a snapshot saves and what the several-shade
// comparison is cut from. Null when there is nothing to take.
async function capture({marks=true}={}){
  if(!source)return null;
  const {w,h}=frameSize();
  // Natively, the picture comes from the renderer, as drawn.
  const picture=source.native?await nativePicture():null;
  if(source.native&&!picture)return null;
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');
  // Saved as seen: the preview is mirrored, so the saved picture is too.
  x.save();x.translate(w,0);x.scale(-1,1);
  if(picture)x.drawImage(picture,0,0,w,h);
  else if(stage&&!$('stage').hidden)x.drawImage($('stage'),0,0,w,h);
  else{
    x.drawImage(source.el,0,0,w,h);
    if($('natural-blend').checked)x.globalCompositeOperation='multiply';
    x.drawImage(overlay,0,0,w,h);x.globalCompositeOperation='source-over';
  }
  x.restore();
  if(seamOn&&marks){
    const sx=seam*w,s=Math.max(1,w/640);
    x.fillStyle='#D1AC3A';x.fillRect(sx-s,0,2*s,h);
    const [before,after]=seamLabels();
    x.font=`${13*s}px Estedad, Tahoma, sans-serif`;x.textBaseline='bottom';x.direction='rtl';
    const tag=(text,px,align)=>{x.textAlign=align;const m=x.measureText(text).width;
      x.fillStyle='#140C11CC';x.fillRect(align==='left'?px-6*s:px-m-6*s,h-30*s,m+12*s,22*s);x.fillStyle='#F4E3B0';x.fillText(text,px,h-12*s);};
    tag(before,12*s,'left');tag(after,w-12*s,'right');
  }
  if(marks)brandMark(x,w,Math.max(1,w/640));
  return c;
}
function brandMark(x,w,s){
  x.font=`800 ${15*s}px Estedad, Tahoma, sans-serif`;x.fillStyle='#FFFFFFB0';x.textAlign='right';x.textBaseline='top';x.direction='rtl';
  x.fillText('رُژا',w-12*s,10*s);
  // Where a shared picture came from, small enough not to sit on the look.
  x.font=`500 ${10*s}px Estedad, Tahoma, sans-serif`;x.fillStyle='#FFFFFF90';x.direction='ltr';
  x.fillText('pythonpath.ir',w-12*s,30*s);
}
async function snapshot(){
  const c=await capture();
  if(!c){if(source)toast('عکس گرفته نشد. دوباره امتحان کن.');return;}
  const label=mode==='skin'?'تحلیل پوست':mode==='procedure'
    ?([...active.keys()].map(id=>byId(id).short).join('، ')||'بدون عمل')
    :(products.filter(p=>makeupState[p.id].enabled).map(p=>`${p.name} ${shadeOf(p,makeupState[p.id].shade).name}`).join('، ')||'بدون آرایش');
  const shot=await addShot(c,label);
  if(!shot)return;
  $('flash').classList.remove('on');void $('flash').offsetWidth;$('flash').classList.add('on');
  toast('عکس گرفته شد. از «عکس‌ها» می‌توانی مقایسه، ذخیره یا ارسالش کنی.');
}
async function addShot(c,label){
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
  if(!blob){toast('ذخیرهٔ عکس روی این مرورگر ممکن نشد.');return null;}
  const shot={url:URL.createObjectURL(blob),blob,label,time:new Date(),picked:false};
  shots.unshift(shot);
  while(shots.length>12){URL.revokeObjectURL(shots.pop().url);}
  $('shots-count').textContent=fa.format(shots.length);
  return shot;
}

/* ---------- several shades side by side --------------------------------- */
// One picture of the face in each chosen shade of the current product, cut around the
// face and laid out together: the comparison a counter gives by swatching on the hand.
const multi={picked:[],shot:null,busy:false};
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
async function rendered(){
  for(let i=0;i<40&&masksDirty;i++)await nextFrame();
  await nextFrame();await nextFrame();
  if(source?.native)await new Promise(resolve=>setTimeout(resolve,350));
}
function openMulti(){
  const list=product.shades, at=list.findIndex(s=>s.id===selected().id);
  multi.picked=[0,1,2,3].map(i=>list[(at+i)%list.length].id).filter((id,i,a)=>a.indexOf(id)===i);
  renderMulti();
  $('multi-pick').hidden=false;$('multi-result').hidden=true;
  $('multi').showModal();
}
function renderMulti(){
  $('multi-shades').replaceChildren(...product.shades.map(shade=>el('button',{type:'button','aria-pressed':String(multi.picked.includes(shade.id)),
    onclick:()=>{
      const i=multi.picked.indexOf(shade.id);
      if(i>=0)multi.picked.splice(i,1);else{multi.picked.push(shade.id);if(multi.picked.length>4)multi.picked.shift();}
      renderMulti();
    }},el('i',{style:{background:swatchStyle(shade)}}),shade.name)));
  $('multi-run').disabled=multi.picked.length<2;
  $('multi-run').textContent=`ساختن تصویر مقایسه (${fa.format(multi.picked.length)} رنگ)`;
}
// The face's box in the saved (mirrored) picture, widened and made 3:4.
function faceBox(w,h){
  let x0=1,x1=0,y0=1,y1=0;
  for(const l of landmarks){x0=Math.min(x0,1-l.x);x1=Math.max(x1,1-l.x);y0=Math.min(y0,l.y);y1=Math.max(y1,l.y);}
  const cx=(x0+x1)/2*w, cy=(y0+y1)/2*h;
  let bh=(y1-y0)*h*1.45, bw=bh*3/4;
  bw=Math.max(bw,(x1-x0)*w*1.35);bh=bw*4/3;
  const fit=Math.min(1,w/bw,h/bh);bw*=fit;bh*=fit;
  return {x:Math.min(w-bw,Math.max(0,cx-bw/2)),y:Math.min(h-bh,Math.max(0,cy-bh/2)),w:bw,h:bh};
}
async function runMulti(){
  if(multi.busy)return;
  if(!source||!landmarks){toast('اول دوربین را روشن کن یا عکسی انتخاب کن تا صورت پیدا شود.');return;}
  multi.busy=true;$('multi-run').disabled=true;
  const state=makeupState[product.id], kept={...state}, keptEnabled=products.filter(p=>makeupState[p.id].enabled).map(p=>p.id);
  // Each picture whole, without the seam of a comparison that may be on.
  const keptSeam={compare,pin};compare=false;pin=null;updateSeam();
  const tiles=[];
  try{
    for(const sid of multi.picked){
      state.shade=sid;enableProduct(product);updateSelection();
      await rendered();
      const c=await capture({marks:false});
      if(!c||!landmarks)throw new Error('lost');
      tiles.push({canvas:c,box:faceBox(c.width,c.height),shade:shadeOf(product,sid)});
    }
  }catch{toast('تصویر مقایسه ساخته نشد. صورت را روبه‌روی دوربین نگه دار و دوباره امتحان کن.');}
  finally{
    Object.assign(state,kept);
    for(const p of products)makeupState[p.id].enabled=keptEnabled.includes(p.id);
    ({compare,pin}=keptSeam);updatePinButton();
    updateSelection();
    multi.busy=false;renderMulti();
  }
  if(tiles.length!==multi.picked.length)return;
  const cols=tiles.length===4?2:tiles.length, rows=Math.ceil(tiles.length/cols);
  const tw=360, th=480, bar=44, pad=8;
  const c=document.createElement('canvas');c.width=cols*tw+(cols+1)*pad;c.height=rows*(th+bar)+(rows+1)*pad;
  const x=c.getContext('2d');
  x.fillStyle='#140C11';x.fillRect(0,0,c.width,c.height);
  tiles.forEach((t,i)=>{
    const col=cols-1-(i%cols), row=Math.floor(i/cols);       // right to left, as the page reads
    const left=pad+col*(tw+pad), top=pad+row*(th+bar+pad);
    x.drawImage(t.canvas,t.box.x,t.box.y,t.box.w,t.box.h,left,top,tw,th);
    x.fillStyle='#1D1319';x.fillRect(left,top+th,tw,bar);
    x.fillStyle=t.shade.color;x.beginPath();x.arc(left+tw-24,top+th+bar/2,11,0,Math.PI*2);x.fill();
    x.fillStyle='#F6ECF1';x.font='600 16px Estedad, Tahoma, sans-serif';x.textAlign='right';x.textBaseline='middle';x.direction='rtl';
    x.fillText(t.shade.name,left+tw-44,top+th+bar/2);
    x.fillStyle='#9A8591';x.font='12px Estedad, Tahoma, sans-serif';x.textAlign='left';x.direction='ltr';
    x.fillText(`${product.name}`,left+12,top+th+bar/2);
  });
  brandMark(x,c.width,1);
  const shot=await addShot(c,`${product.name}: ${tiles.map(t=>t.shade.name).join('، ')}`);
  if(!shot)return;
  multi.shot=shot;shot.grid=true;
  $('multi-image').src=shot.url;$('multi-image').alt=shot.label;
  $('multi-share').hidden=!canShare(shot);
  $('multi-pick').hidden=true;$('multi-result').hidden=false;
  if(!$('multi').open)$('multi').showModal();
}
function renderGallery(){
  const list=$('gallery-shots');
  if(!shots.length){list.replaceChildren(el('p',{class:'empty',text:'هنوز عکسی نگرفته‌ای. روی آینه «عکس» را بزن.'}));$('gallery-compare').hidden=true;return;}
  const time=new Intl.DateTimeFormat('fa-IR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  list.replaceChildren(...shots.map((shot,i)=>{
    const pick=el('input',{type:'checkbox'});pick.checked=shot.picked;
    pick.onchange=()=>{
      shot.picked=pick.checked;
      const picked=shots.filter(s=>s.picked);
      if(picked.length>2){picked.find(s=>s!==shot).picked=false;}
      renderGallery();
    };
    return el('figure',{class:`shot${shot.picked?' picked':''}`,style:{margin:0}},
      el('img',{src:shot.url,alt:shot.label}),
      el('label',{},pick,'مقایسه'),
      el('div',{class:'shot-bar'},el('span',{text:`${time.format(shot.time)} · ${shot.label}`,title:shot.label}),
        el('a',{href:shot.url,download:`roja-${i+1}.png`,'aria-label':'ذخیرهٔ عکس',title:'ذخیره',
          onclick:e=>{if(native){e.preventDefault();saveBlob(shot.blob,`roja-${Date.now()}.png`);}}},icon('i-download')),
        ...(canShare(shot)?[el('button',{type:'button','aria-label':'اشتراک‌گذاری عکس',title:'اشتراک',onclick:()=>shareShot(shot)},icon('i-share'))]:[]),
        el('button',{type:'button','aria-label':'حذف عکس',title:'حذف',onclick:()=>{URL.revokeObjectURL(shot.url);shots.splice(shots.indexOf(shot),1);
          $('shots-count').textContent=fa.format(shots.length);renderGallery();}},icon('i-trash'))));
  }));
  const picked=shots.filter(s=>s.picked);
  $('gallery-compare').hidden=picked.length!==2;
  if(picked.length===2)$('gallery-compare').replaceChildren(...picked.map(s=>el('figure',{},el('img',{src:s.url,alt:s.label}),el('figcaption',{text:s.label}))));
}
// Straight to Instagram, Telegram, WhatsApp… through the phone's own share sheet, where
// the browser can hand over a file (most phones; not the Android app's WebView).
function shotFile(shot){return shot.file||=new File([shot.blob],`roja-${shot.time.getTime()}.png`,{type:'image/png'});}
function canShare(shot){try{return !native&&!!navigator.canShare?.({files:[shotFile(shot)]});}catch{return false;}}
async function shareShot(shot){
  try{
    await navigator.share({files:[shotFile(shot)],title:'رُژا',text:`${shot.label}، امتحان‌شده در آینهٔ رُژا: https://pythonpath.ir/`});
    count('share',shot.grid?'multi':'shot',{each:true});
  }
  catch(e){if(e?.name!=='AbortError')toast('اشتراک‌گذاری ممکن نشد. عکس را ذخیره کن و از گالری بفرست.');}
}
// A browser downloads the file; the Android app's WebView cannot download a blob:
// URL, so there the bytes go to the app, which saves them to the gallery or Downloads.
async function saveBlob(blob,name){
  if(native?.saveFile){
    const data=await new Promise((resolve,reject)=>{const r=new FileReader();
      r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
    const result=native.saveFile(data,name,blob.type||'application/octet-stream');
    toast(result==='saved'?(blob.type.startsWith('image/')?'در گالری، پوشهٔ Roja ذخیره شد.':'در پوشهٔ Download/Roja ذخیره شد.')
      :result==='picker'?'جای ذخیرهٔ فایل را انتخاب کن.':'ذخیره نشد. دوباره امتحان کن.');
    return;
  }
  const url=URL.createObjectURL(blob);
  const a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function icon(id){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','ico');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+id);svg.append(use);return svg;
}
function renderLights(){
  $('light-menu').replaceChildren(...lights.map(l=>el('button',{type:'button',role:'menuitemradio','aria-checked':String(l.id===light),
    onclick:()=>{light=l.id;renderLights();$('light-menu').hidden=true;$('light-toggle').setAttribute('aria-expanded','false');
      $('light-toggle').setAttribute('aria-pressed',String(light!=='none'));invalidate();
      if(light!=='none')toast(`پیش‌نمایش در «${l.name}». رنگ واقعی در آن نور هم همین‌قدر جابه‌جا می‌شود.`);}},
    el('i',{style:{background:l.swatch}}),l.name)));
}

/* ---------- buying, in the shop the mirror is for ------------------------ */
// Roja sells nothing. "Buy" leads to the shop's own page for the product, or its search
// for the kind of product and the shade's colour (shops.js). Inside the shop's page the
// shop is also told, by a message to its own origin only, so it can put the product in
// its cart; a shop that does (`cart`) keeps the visitor in the mirror.
function buyLink(link,item,shade){
  if(!shop){link.removeAttribute('href');return link;}
  link.href=shopUrl(shop,item,shade);
  link.onclick=e=>{
    count('buy',`${item.id}:${shade.variantId}`,{each:true});count('step','buy');
    if(embedded){
      try{window.parent.postMessage({type:'roja:buy',shop:shop.id,
        product:{id:item.id,name:item.name,type:item.type||item.kind},
        shade:{id:shade.id,name:shade.name,color:shade.color},
        query:searchWords(item,shade),url:link.href},shop.origin);}catch{}
      if(shop.cart){e.preventDefault();toast(`${item.name} ${shade.name} به سبد ${shop.name} رفت.`);return;}
    }
    if(native){e.preventDefault();openOutside(link.href);}
  };
  return link;
}
function renderBuy(){
  const items=products.filter(p=>makeupState[p.id].enabled);
  $('buy-items').replaceChildren(...items.map(item=>{
    const shade=shadeOf(item,makeupState[item.id].shade);
    return el('div',{class:'buy-row'},
      el('span',{class:'mini',style:{background:swatchStyle(shade)}}),
      el('p',{},item.name,el('small',{text:shade.name})),
      buyLink(el('a',{class:'ghost button',target:'_blank',rel:'noopener','aria-label':`${item.name} ${shade.name} در ${shop.name}`},
        `در ${shop.name}`,icon('i-out')),item,shade));
  }));
  if(!items.length)$('buy-items').append(el('p',{class:'quiet',text:'روی صورت آرایشی نیست. یک محصول یا یک استایل آماده را امتحان کن تا اینجا بیاید.'}));
}
function openBuy(){if(!shop)return;renderBuy();$('buy').showModal();}
function openOutside(url){
  if(native){location.href=url;return;}
  if(!window.open(url,'_blank','noopener'))location.href=url;
}

/* ---------- remembered between visits ----------------------------------- */
// The look on the face stays on this device, in its local storage,
// so a reload or the next visit starts where the last one stopped. Nothing here leaves
// the device. A saved product or shade the catalogue no longer has is skipped.
const SAVED='roja-saved';
let saveTimer=0;
function saveSoon(){clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,400);}
function saveNow(){
  clearTimeout(saveTimer);
  try{localStorage.setItem(SAVED,JSON.stringify({v:1,product:product.id,makeup:makeupState}));}catch{}
}
function restoreSaved(){
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem(SAVED));}catch{}
  if(saved?.v!==1)return false;
  const level=(v,fallback)=>Number.isFinite(v)&&v>=0&&v<=100?v:fallback;
  for(const [pid,s] of Object.entries(saved.makeup||{})){
    const item=byProduct(pid), state=makeupState[pid];
    if(!item||!state||!s||!item.shades.some(x=>x.id===s.shade))continue;
    state.shade=s.shade;state.enabled=!!s.enabled;
    state.intensity=level(s.intensity,state.intensity);state.fade=level(s.fade,state.fade);
    if(item.styles?.some(x=>x.id===s.style))state.style=s.style;
  }
  if(byProduct(saved.product)){product=byProduct(saved.product);category=product.category;}
  // Worth a word only when it differs from a first visit: more than the starting lipstick.
  return products.some(p=>makeupState[p.id].enabled!==(p.id==='velvet'));
}

/* ---------- the skin check ---------------------------------------------- */
// Measured from the picture the landmarks were found in: the camera video (paused
// when frozen) or the chosen photo. The native mirror keeps its frames to itself.
const skinScanner=createSkinScanner();
const skinPanel=createSkinPanel({el,fa,pct,toast,buyLink,shop,icon,
  mirror:()=>({source:!!source,native:!!source?.native,face:!!landmarks}),
  scan:()=>source&&!source.native&&landmarks?skinScanner.scan(source.el,source.width,source.height,landmarks,poseAngles):null});

/* ---------- the makeup panel's panes, and the theme ---------------------- */
// The makeup panel is three short panes: the shade's controls, the look on the face
// (with the ready-made ones), and the brush. Picking a product shows its controls;
// switching the brush on shows the brush.
function showPane(id){
  document.querySelectorAll('.panes [data-pane]').forEach(b=>{
    const on=b.dataset.pane===id;
    b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;
    $(`pane-${b.dataset.pane}-body`).hidden=!on;
  });
}
document.querySelectorAll('.panes [data-pane]').forEach(b=>{b.onclick=()=>showPane(b.dataset.pane);});
$('pane-color').closest('.panes').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight'].includes(e.key))return;
  const tabs=[...document.querySelectorAll('.panes [data-pane]')], i=tabs.findIndex(t=>t.getAttribute('aria-selected')==='true');
  const next=tabs[(i+(e.key==='ArrowLeft'?1:-1)+tabs.length)%tabs.length];   // right to left
  showPane(next.dataset.pane);next.focus();e.preventDefault();
});
// Light or dark: the system's unless the header switch chose one (kept on this device).
function currentTheme(){
  return document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
}
function paintThemeButton(){
  const dark=currentTheme()==='dark';
  $('theme').setAttribute('aria-label',dark?'حالت روشن':'حالت تیره');$('theme').title=dark?'حالت روشن':'حالت تیره';
  $('theme').querySelector('use').setAttribute('href',dark?'#i-sun':'#i-moon');
}
$('theme').onclick=()=>{
  const next=currentTheme()==='dark'?'light':'dark';
  document.documentElement.dataset.theme=next;
  try{localStorage.setItem('roja-theme',next);}catch{}
  paintThemeButton();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',paintThemeButton);
paintThemeButton();

/* ---------- wiring ------------------------------------------------------ */
$('mode-makeup').onclick=()=>setMode('makeup');
$('mode-procedure').onclick=()=>setMode('procedure');
$('mode-skin').onclick=()=>setMode('skin');

$('shades').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();
  const list=product.shades, i=list.findIndex(s=>s.id===selected().id);
  const delta=['ArrowLeft','ArrowDown'].includes(e.key)?1:-1;
  select(list[(i+delta+list.length)%list.length].id);
  $('shades').querySelector(`[data-id="${selected().id}"]`).focus();
});
$('intensity').oninput=()=>{
  makeupState[product.id].intensity=Number($('intensity').value);
  $('amount').textContent=pct($('intensity').value);invalidate({masks:true});saveSoon();
};
$('fade').oninput=()=>{
  makeupState[product.id].fade=Number($('fade').value);
  $('fade-amount').textContent=pct($('fade').value);invalidate({masks:true});saveSoon();
};
$('natural-blend').onchange=()=>invalidate({masks:true});
$('product-toggle').onclick=()=>{
  if(makeupState[product.id].enabled)makeupState[product.id].enabled=false;else enableProduct(product);
  afterMakeupChange();
};
$('add-look').onclick=openBuy;
$('clear-look').onclick=()=>{for(const item of products)makeupState[item.id].enabled=false;pin=null;updatePinButton();afterMakeupChange();};
$('pin-shade').onclick=togglePin;
$('multi-open').onclick=openMulti;
$('multi-run').onclick=runMulti;
$('multi-close').onclick=()=>$('multi').close();
$('multi-again').onclick=()=>{$('multi-pick').hidden=false;$('multi-result').hidden=true;};
$('multi-save').onclick=()=>{if(multi.shot)saveBlob(multi.shot.blob,`roja-${Date.now()}.png`);};
$('multi-share').onclick=()=>{if(multi.shot)shareShot(multi.shot);};
$('save-look').onclick=()=>{
  if(!currentItems().length){toast('روی صورت آرایشی نیست که ذخیره شود.');return;}
  $('save-look-form').hidden=false;$('look-name').value='';$('look-name').focus();
};
$('save-look-cancel').onclick=()=>{$('save-look-form').hidden=true;};
$('save-look-form').onsubmit=e=>{
  e.preventDefault();
  const name=$('look-name').value.trim().slice(0,30);
  if(name&&saveMyLook(name))$('save-look-form').hidden=true;
};
$('link-look').onclick=sendLookLink;
window.addEventListener('hashchange',lookFromLink);
$('tour-next').onclick=()=>{tourAt++;showTourStep();};
$('tour-skip').onclick=endTour;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&tourAt>=0)endTour();});
window.addEventListener('resize',placeTour);
$('finder-run').onclick=runFinder;
$('basket').onclick=openBuy;
$('close').onclick=()=>$('buy').close();
$('gallery-open').onclick=()=>{renderGallery();$('gallery').showModal();};
$('gallery-close').onclick=()=>$('gallery').close();
// The Android app: offered where it can be installed, or passed on to a phone with the
// QR code; not inside the app itself, and not on an iPhone, which has no app.
if(!native&&!iOS){
  const android=/Android/i.test(ua);
  $('app-open').hidden=false;
  $('welcome-app').hidden=!android;
  $('app-qr').hidden=android;                 // on the phone itself there is nothing to scan
}
// The reading pages are the website's, not the app's: in the app they open in the browser.
if(native)document.querySelectorAll('.footer-links a').forEach(a=>{a.href='https://pythonpath.ir/'+a.getAttribute('href');});
$('app-open').onclick=$('welcome-app-open').onclick=()=>$('app-dialog').showModal();
$('app-close').onclick=()=>$('app-dialog').close();
for(const dialog of [$('buy'),$('gallery'),$('app-dialog'),$('multi')])dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});

$('strength').oninput=()=>{
  const value=Number($('strength').value);
  $('strength-amount').textContent=pct(value);
  if(currentProcedure)setStrength(currentProcedure,value);
};
$('procedure-reset').onclick=()=>{
  active.clear();
  for(const control of controls){
    overrides[control.id]=0;
    const input=$(`fine-${control.id}`);if(input)setRange(input.id,0);
    const amount=$(`fine-${control.id}-amount`);if(amount)amount.textContent=fa.format(0);
  }
  showProcedure(null);buildTray();updateSeam();invalidate({masks:true,measure:true});
};
$('with-makeup').onchange=()=>{updateSeam();invalidate({masks:true});};
// Turned off with several on: keep the one being looked at.
$('combine-procedures').onchange=()=>{
  const on=$('combine-procedures').checked;
  try{localStorage.setItem(COMBINE,on?'1':'0');}catch{}
  if(!on&&active.size>1){
    const keep=active.has(currentProcedure)?currentProcedure:[...active.keys()].pop();
    const value=active.get(keep);
    active.clear();setStrength(keep,value);showProcedure(keep);
  }
  toast(on?'عمل‌ها با هم ترکیب می‌شوند: هر عملی که بزنی به قبلی‌ها اضافه می‌شود.':'هر بار یک عمل: عمل تازه جای قبلی را می‌گیرد.');
};
for(const region of regions){
  const list=controls.filter(c=>c.region===region.id);
  $('fine-controls').append(el('p',{class:'fine-group',text:region.name}));
  for(const control of list){
    const [min,max]=controlRange(control);
    const amount=el('output',{id:`fine-${control.id}-amount`,text:fa.format(0)});
    const label=el('label',{class:'field',for:`fine-${control.id}`,title:control.help},`${control.name} `,amount);
    const input=el('input',{id:`fine-${control.id}`,type:'range',min:String(min),max:String(max),step:'1',value:'0',data:{fine:control.id},'aria-describedby':`fine-${control.id}-help`});
    paintRange(input);
    input.oninput=()=>{
      overrides[control.id]=Number(input.value);
      amount.textContent=fa.format(Number(input.value));
      $('procedure-reset').hidden=!anyProcedure();
      updateSeam();invalidate({masks:true,measure:true});
    };
    $('fine-controls').append(label,input,el('p',{class:'help',id:`fine-${control.id}-help`,text:control.help}));
  }
}

/* brush controls */
$('brush-on').onchange=()=>setBrush($('brush-on').checked);
$('brush-toggle').onclick=()=>setBrush(!brushState.on);
$('brush-size').oninput=()=>{brushState.size=Number($('brush-size').value);$('brush-size-amount').textContent=pct(brushState.size);};
$('brush-strength').oninput=()=>{brushState.strength[brushState.mode]=Number($('brush-strength').value);$('brush-strength-amount').textContent=pct($('brush-strength').value);};
$('brush-target').querySelectorAll('button').forEach(b=>b.onclick=()=>{
  brushState.target=b.dataset.target==='all'?'all':product.type;
  $('brush-target').querySelectorAll('button').forEach(x=>x.setAttribute('aria-checked',String(x===b)));
});
$('brush-undo').onclick=()=>{brush.undo();updateBrushInfo();invalidate({masks:true});};
$('brush-clear').onclick=()=>{brush.clear();updateBrushInfo();invalidate({masks:true});toast('همهٔ اصلاح‌های براش برداشته شد.');};

/* painting, inspecting and the cursor */
viewport.addEventListener('pointerdown',e=>{
  if(!source||e.target.closest('.toolbar,#welcome,.seam-grip'))return;
  const q=framePoint(e);
  if(brushActive()){
    if(!landmarks){toast('صورت روی آینه نیست؛ براش روی صورت کار می‌کند.');return;}
    if(!q.inside)return;
    const {w,h}=frameSize();
    const m=brushState.mode;
    if(brush.begin({mode:m,target:brushState.target,size:brushState.size/100,strength:m==='restore'?1:brushState.strength[m]/100},landmarks,w,h,q.x,q.y)){
      brushPointer=e.pointerId;
      try{viewport.setPointerCapture(e.pointerId);}catch{}
      e.preventDefault();updateBrushInfo();invalidate({masks:true});
    }
  }else if(debug.on&&debug.inspect&&landmarks&&q.inside){
    const {w,h}=frameSize();
    const hit=nearest(landmarks,w,h,q.x,q.y);
    setFind(hit.index);
  }
});
viewport.addEventListener('pointermove',e=>{
  if(!source)return;
  const q=framePoint(e);
  moveCursor(q);
  if(brushPointer===e.pointerId&&brush.painting){
    const {w,h}=frameSize();
    if(brush.extend(landmarks,w,h,q.x,q.y))invalidate({masks:true});
  }else if(debug.on&&debug.inspect&&landmarks&&q.inside&&!brushActive()){
    const {w,h}=frameSize();
    const hit=nearest(landmarks,w,h,q.x,q.y);
    const l=landmarks[hit.index];
    const tip=$('inspect-tip');tip.hidden=false;
    tip.style.left=q.screenX+'px';tip.style.top=q.screenY+'px';
    tip.textContent=`#${hit.index}  x ${(l.x*w).toFixed(1)}  y ${(l.y*h).toFixed(1)}  z ${(l.z||0).toFixed(3)}`;
  }else $('inspect-tip').hidden=true;
});
const endStroke=e=>{if(brushPointer===e.pointerId){brush.end();brushPointer=null;updateBrushInfo();}};
viewport.addEventListener('pointerup',endStroke);
viewport.addEventListener('pointercancel',endStroke);
viewport.addEventListener('pointerleave',()=>{$('brush-cursor').hidden=true;$('inspect-tip').hidden=true;});

/* the mirror's toolbar */
$('compare').onclick=()=>{
  if(mode==='procedure'){toast(anyProcedure()?'مرز را روی تصویر بکش.':'اول یک عمل را انتخاب کن.');return;}
  toggleCompare();
};
$('freeze').onclick=toggleFreeze;
$('snap').onclick=snapshot;
$('light-toggle').onclick=()=>{
  const open=$('light-menu').hidden;
  $('light-menu').hidden=!open;$('light-toggle').setAttribute('aria-expanded',String(open));
};
$('fullscreen').onclick=()=>{
  if(document.fullscreenElement)document.exitFullscreen?.();
  else viewport.requestFullscreen?.().catch(()=>toast('تمام‌صفحه در این مرورگر در دسترس نیست.'));
};
// The app is full-screen already, and its WebView has no element full-screen.
if(!document.fullscreenEnabled||native)$('fullscreen').hidden=true;
document.addEventListener('click',e=>{
  if(!$('light-menu').hidden&&!e.target.closest('#light-menu,#light-toggle')){$('light-menu').hidden=true;$('light-toggle').setAttribute('aria-expanded','false');}
});

/* debug */
$('debug-on').onchange=()=>{debug.on=$('debug-on').checked;viewport.classList.toggle('inspecting',debug.on&&debug.inspect);invalidate({masks:debug.masks});};
for(const key of ['points','mesh','contours','axes','masks','field','strokes','hud','inspect'])
  $(`debug-${key}`).onchange=()=>{
    debug[key]=$(`debug-${key}`).checked;
    viewport.classList.toggle('inspecting',debug.on&&debug.inspect);
    if(!debug.inspect)$('inspect-tip').hidden=true;
    invalidate({masks:key==='masks'});
  };
$('debug-size').oninput=()=>{
  debug.labelSize=Number($('debug-size').value);
  $('debug-size-amount').textContent=fa.format(debug.labelSize);
  invalidate();
};
$('debug-highlight').onchange=()=>{debug.highlight=$('debug-highlight').checked;invalidate();};
$('debug-only').onchange=()=>{debug.onlyActive=$('debug-only').checked;invalidate();};
function setFind(index){
  debug.find=Number.isInteger(index)&&index>=0&&index<478?index:null;
  if(debug.find!==null&&String($('debug-find').value)!==String(index))$('debug-find').value=index;
  const info=$('debug-find-info');
  if(debug.find===null){info.textContent='';}
  else if(landmarks&&landmarks[debug.find]){
    const {w,h}=frameSize(),l=landmarks[debug.find];
    const uses=Object.entries(landmarksByType).filter(([,list])=>list.includes(debug.find)).map(([t])=>t)
      .concat(Object.entries(controlLandmarks).filter(([,list])=>list.includes(debug.find)).map(([c])=>c));
    info.textContent=`نقطهٔ ${fa.format(debug.find)}: x ${fa1.format(l.x*w)} ، y ${fa1.format(l.y*h)}${uses.length?` · در ${uses.join('، ')}`:''}`;
  }else info.textContent=`نقطهٔ ${fa.format(debug.find)}`;
  invalidate();
}
$('debug-find').oninput=()=>setFind($('debug-find').value===''?null:Number($('debug-find').value));
$('debug-export').onclick=()=>{saveBlob(new Blob([JSON.stringify(exportData(),null,1)],{type:'application/json'}),`roja-debug-${Date.now()}.json`);};
$('debug-copy').onclick=async()=>{
  try{await navigator.clipboard.writeText(JSON.stringify(exportData()));toast('داده‌های دیباگ کپی شد.');}
  catch{toast('کپی در این مرورگر اجازه داده نشد؛ از «دانلود JSON» استفاده کن.');}
};

/* seam dragging: the grip is a real slider, so it works from the keyboard too */
function seamFromEvent(event){
  const box=videoBox();
  seam=Math.min(1,Math.max(0,(event.clientX-box.rect.left-box.left)/box.width));
  placeSeam();invalidate();draw();
}
$('seam').addEventListener('pointerdown',e=>{
  // Move first: capture is an enhancement, and it throws for a pointer id the
  // element does not own, which would otherwise abandon the drag.
  seamFromEvent(e);
  try{$('seam').setPointerCapture(e.pointerId);}catch{}
  e.stopPropagation();
});
$('seam').addEventListener('pointermove',e=>{if(e.buttons)seamFromEvent(e);});
$('seam-grip').addEventListener('keydown',e=>{
  const step=e.key==='ArrowLeft'?-0.02:e.key==='ArrowRight'?0.02:0;
  if(!step)return;
  e.preventDefault();
  seam=Math.min(1,Math.max(0,seam+step));placeSeam();invalidate();
});

/* keyboard shortcuts, never while typing */
document.addEventListener('keydown',e=>{
  if(e.target.closest('input,select,textarea,[contenteditable]')||e.altKey)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&brush.count){e.preventDefault();$('brush-undo').click();return;}
  if(e.ctrlKey||e.metaKey||!source)return;
  const k=e.key.toLowerCase();
  if(k==='b'&&mode==='makeup')setBrush(!brushState.on);
  else if(k==='c')$('compare').click();
  else if(k==='f')toggleFreeze();
  else if(k==='s')snapshot();
  else if(k==='['||k===']'){
    brushState.size=Math.max(3,Math.min(30,brushState.size+(k===']'?2:-2)));
    setRange('brush-size',brushState.size);$('brush-size-amount').textContent=pct(brushState.size);
  }
});

// The seam is positioned in pixels, so it has to be replaced when the box changes.
window.addEventListener('resize',()=>{if(seamOn)placeSeam();});
document.addEventListener('fullscreenchange',()=>{if(seamOn)placeSeam();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveNow();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&source?.kind==='camera')stop('با خارج‌شدن از صفحه، دوربین خاموش شد.');});
window.addEventListener('pagehide',()=>{saveNow();stop();if(tracker){tracker.close();tracker=null;ready=false;}});
$('start').onclick=start;
$('photo-input').onchange=()=>{const file=$('photo-input').files[0];$('photo-input').value='';openPhoto(file);};
$('stop').onclick=()=>stop(source?.kind==='photo'?'عکس بسته شد.':'دوربین خاموش شد.');
// Dropping a photo on the mirror opens it too.
viewport.addEventListener('dragover',e=>{if([...e.dataTransfer.items].some(i=>i.type.startsWith('image/'))){e.preventDefault();}});
viewport.addEventListener('drop',e=>{const file=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(file){e.preventDefault();openPhoto(file);}});

renderBrushModes();
setRange('brush-size',brushState.size);$('brush-size-amount').textContent=pct(brushState.size);
renderLooks();renderLights();
const restored=restoreSaved();
selectProduct(product.id,false);
setMode('makeup');
updateBrushInfo();
placeSeam();
document.querySelectorAll('input[type=range]').forEach(paintRange);
if(!lookFromLink()&&restored)toast('آرایش دفعهٔ قبل برگشت. «پاک‌کردن آرایش» همه را از صورت برمی‌دارد.');

// The Android back button: close whatever is open on top first. Returns whether it
// did anything, so the app knows when to leave instead.
window.rojaBack=()=>{
  const dialog=document.querySelector('dialog[open]');
  if(dialog){dialog.close();return true;}
  if(tourAt>=0){endTour();return true;}
  if(!$('light-menu').hidden){$('light-menu').hidden=true;$('light-toggle').setAttribute('aria-expanded','false');return true;}
  if(brushState.on){setBrush(false);return true;}
  if(document.fullscreenElement){document.exitFullscreen?.();return true;}
  return false;
};

// Installed from the browser, the site keeps working offline (sw.js). Not in the app,
// which carries every file itself, and not on a development server, where a cache
// would serve yesterday's files.
if('serviceWorker' in navigator&&!native&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))
  navigator.serviceWorker.register('sw.js').catch(()=>{});
// Anything that breaks later says so, instead of leaving a silent mirror: the message
// is what a bug report needs, and the debug panel keeps the last one.
window.addEventListener('error',e=>{perf.lastError=String(e.message||e.error||'error');toast('خطا: '+perf.lastError);});
window.addEventListener('unhandledrejection',e=>{perf.lastError=String(e.reason?.message||e.reason||'error');toast('خطا: '+perf.lastError);});
document.documentElement.dataset.ready='1';

/* Optional agent hooks. */
function selectMakeup(input){
  const item=byProduct(input?.product);
  if(!item||!item.shades.some(s=>s.id===input?.id))throw new Error('Valid product and shade required');
  setMode('makeup');selectProduct(item.id);
  return select(input.id);
}
function applyLookTool(input){
  const look=looks.find(l=>l.id===input?.look);
  if(!look)throw new Error('Valid look required');
  setMode('makeup');applyLook(look);
  return {look:look.id,products:look.items.map(i=>i[0])};
}
if(document.modelContext?.registerTool){
  const tools=[{
    name:'select_makeup_shade',
    description:"Select one of Roja's sample shades and show it on the visible makeup combination. Does not start the camera or open a shop.",
    inputSchema:{type:'object',properties:{
      product:{type:'string',enum:products.map(p=>p.id)},
      id:{type:'string',enum:[...new Set(products.flatMap(p=>p.shades.map(s=>s.id)))]}
    },required:['product','id'],additionalProperties:false},
    execute:selectMakeup
  },{
    name:'apply_makeup_look',
    description:"Put one of Roja's ready-made looks (a full combination of its sample products) on the mirror. Does not start the camera or open a shop.",
    inputSchema:{type:'object',properties:{look:{type:'string',enum:looks.map(l=>l.id)}},required:['look'],additionalProperties:false},
    execute:applyLookTool
  }];
  for(const tool of tools)try{Promise.resolve(document.modelContext.registerTool(tool)).catch(()=>{});}catch{}
}
