import {products,categories,finishes,looks,byProduct} from './catalog.js?v=14';
import {layerSpecs,createMaskPainter,renderFallback,smoothLandmarks,landmarksByType,frameLandmarks,hexToRgb} from './makeup.js?v=14';
import {createStage,layerModes} from './stage.js?v=14';
import {controls,regions,controlLandmarks,controlRange,deformers,textureLayers} from './deform.js?v=14';
import {procedures,byId,amountsFor,resolve,kinds} from './procedures.js?v=14';
import {renderDebug,nearest} from './debug.js?v=14';
import {createBrush,brushModes} from './brush.js?v=14';
import {metrics,measure,points as placed,symmetry,pose as poseOf} from './measure.js?v=14';

const $=id=>document.getElementById(id);
const fa=new Intl.NumberFormat('fa-IR');
const fa1=new Intl.NumberFormat('fa-IR',{minimumFractionDigits:1,maximumFractionDigits:1});
const fa2=new Intl.NumberFormat('fa-IR',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=n=>fa.format(Math.round(n))+'٪';
const toman=n=>fa.format(n)+' تومان';
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
// Every browser on an iPhone is WebKit underneath; Chrome and Firefox there only change
// the settings screen that grants the camera. In-app browsers (Instagram, Telegram…)
// often have no camera at all.
const ua=navigator.userAgent;
const iOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const inApp=/Instagram|FBAN|FBAV|Telegram|Line\/|WhatsApp|Snapchat/i.test(ua);
function cameraHelp(){
  if(iOS&&/CriOS/.test(ua))return 'در تنظیمات آیفون، بخش Chrome، دسترسی Camera را روشن کن و صفحه را دوباره باز کن.';
  if(iOS&&/FxiOS/.test(ua))return 'در تنظیمات آیفون، بخش Firefox، دسترسی Camera را روشن کن و صفحه را دوباره باز کن.';
  if(iOS)return 'در Safari روی «aA» کنار نشانی بزن، «تنظیمات وب‌سایت» و بعد «دوربین» را روی «اجازه» بگذار.';
  return 'از تنظیمات سایت در مرورگر، دسترسی دوربین را فعال کن.';
}
const code=e=>` (کد: ${e?.name&&e.name!=='Error'?e.name:e?.message||'نامشخص'})`;
const debugCanvas=$('debug'), debugCtx=debugCanvas.getContext('2d');
const viewport=$('viewport');

/* ---------- state ------------------------------------------------------- */
let mode='makeup';                       // makeup | procedure
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
const cart=new Map();
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
const perf={frames:0,fps:0,since:0,detections:0,hz:0,latency:0,lastHud:0,maskMs:0,drawMs:0,lastError:'',trackerNote:''};
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
  $('add-look').disabled=!products.some(p=>makeupState[p.id].enabled);
  if(mode==='makeup')updateTrayState();
}
function updateSelection(){
  const shade=selected(), state=makeupState[product.id];
  $('shade-name').textContent=shade.name;
  $('shade-code').textContent=`${product.code} / ${fa.format(Number(shade.variantId))}`;
  $('big-swatch').style.background=swatchStyle(shade);
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
  updateSelection();
  return {product:product.id,id,variant:shade.variantId,name:shade.name};
}
function selectProduct(id,apply=true){
  const next=byProduct(id);
  if(!next)throw new Error('Unknown product');
  product=next;category=next.category;if(apply)enableProduct(next);
  const cat=categories.find(c=>c.id===next.category);
  $('product-kicker').textContent=`روژا · ${cat?.name} · ${next.region}`;
  $('product-title').textContent=next.title;
  $('product-description').textContent=next.description;
  $('product-limitation').textContent=next.limitation;
  $('product-price').textContent=toman(next.price);
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
  invalidate({masks:true});
  updateSeam();
}

function applyLook(look){
  for(const item of products)makeupState[item.id].enabled=false;
  for(const [pid,shade,intensity,style] of look.items){
    const item=byProduct(pid);if(!item)continue;
    const sid=shade==='auto'?(finder.result?.picks?.[pid]||makeupState[pid].shade):shade;
    Object.assign(makeupState[pid],{shade:sid,intensity,enabled:true,fade:item.fade??45});
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
  $('looks').replaceChildren(...looks.map(look=>{
    const dots=el('span',{class:'dots'},...look.items.slice(0,6).map(([pid,sid])=>{
      const item=byProduct(pid),shade=sid==='auto'?item.shades[Math.floor(item.shades.length/2)]:shadeOf(item,sid);
      return el('i',{style:{background:shade.color}});
    }));
    return el('button',{class:'look-card',type:'button',onclick:()=>applyLook(look),data:{look:look.id}},
      dots,el('strong',{text:look.name}),el('small',{text:look.description}));
  }));
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
    :'مقایسهٔ این رنگ با رنگ دیگر';
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
    $('procedure-summary').textContent='از نوار زیر آینه عملی را بزن تا نتیجهٔ تقریبی آن روی صورتت ساخته شود. می‌توانی چند مورد را با هم ببینی.';
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
function setStrength(id,value){
  if(value>0)active.set(id,value);else active.delete(id);
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
  seamOn=!!source&&!!stage&&(mode==='procedure'?anyProcedure():(compare||!!pin));
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
          onclick:()=>selectProduct(item.id)},dot,item.name));
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
        b.onclick=()=>{
          if(!active.has(procedure.id))setStrength(procedure.id,60);
          showProcedure(procedure.id);
        };
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
  $('mode-makeup').setAttribute('aria-selected',String(mode==='makeup'));
  $('mode-procedure').setAttribute('aria-selected',String(mode==='procedure'));
  $('panel-makeup').hidden=mode!=='makeup';
  $('panel-procedure').hidden=mode!=='procedure';
  $('quick-makeup').hidden=mode!=='makeup';
  $('quick-procedure').hidden=mode!=='procedure'||!currentProcedure;
  $('brush-toggle').hidden=mode!=='makeup';
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
  // A pigment builds coverage fast: half the slider already reads as a real lipstick,
  // the top of it as full coverage. Sheer products (gloss) and skin products stay linear.
  const amount=spec.mode==='pigment'&&spec.type!=='gloss'?1-Math.pow(1-intensity,2):intensity*(spec.type==='gloss'?.9:1);
  return {key:spec.key,color:hexToRgb(spec.color),amount,
    mode:layerModes[spec.mode],detail,gloss:(f.gloss||0)*glossy,matte:f.matte||0,
    shimmer:(f.shimmer||0)*Math.min(1,intensity*1.6),
    smooth:spec.mode==='foundation'?(f.smooth??.4)*Math.min(1,.45+intensity):0,radius:Math.max(2,face*.03)};
}
function textureLayer(t,face){
  return {key:t.key,color:[1,1,1],amount:1,mode:layerModes.smooth,detail:0,gloss:0,matte:0,shimmer:0,
    smooth:t.smooth,bright:t.bright||0,radius:Math.max(2,face*.035)};
}
// What the stage should draw right now: the "after" side, and the "before" side
// when the seam is showing.
function plan(){
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
function rebuildMasks(p){
  const {w,h}=frameSize();
  const maps=brush.maps(landmarks,w,h);
  const specs=new Map();
  for(const s of [...p.after,...(p.before||[])])specs.set(s.key,s);
  for(const t of p.textures)specs.set(t.key,{key:t.key,type:'texture',zone:t.zone,fade:60});
  if(debug.on&&debug.masks){
    if(!maskView)maskView=document.createElement('canvas');
    maskView.width=w;maskView.height=h;
  }
  const mv=debug.on&&debug.masks?maskView.getContext('2d'):null;
  if(mv&&(maskTint.width!==w||maskTint.height!==h)){maskTint.width=w;maskTint.height=h;}
  for(const spec of specs.values()){
    const canvas=painter.paint(spec,landmarks,w,h,spec.type==='texture'?null:maps);
    stage.setMask(spec.key,canvas,painter.box);
    if(mv){
      const t=maskTint.getContext('2d');
      t.globalCompositeOperation='source-over';t.clearRect(0,0,w,h);t.drawImage(canvas,0,0,w,h);
      t.globalCompositeOperation='source-in';t.fillStyle=TYPE_COLOR[spec.type]||'#fff';t.fillRect(0,0,w,h);
      mv.drawImage(maskTint,0,0);
    }
  }
  stage.dropMasks(new Set(specs.keys()));
  masksDirty=false;
}
// Both cheeks, the forehead and the chin: where the light on the face is read.
function probes(){
  return [50,280,151,199].flatMap(i=>[landmarks[i].x,landmarks[i].y]).map(v=>Math.min(.99,Math.max(.01,v)));
}
function draw(now=performance.now()){
  if(!source){ctxClear();return;}
  const {w,h}=frameSize();
  if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
  const gl=ensureStage();
  const p=plan();
  const face=faceWidthPx();
  if(gl){
    if(masksDirty&&landmarks){const t=performance.now();rebuildMasks(p);perf.maskMs=ema(perf.maskMs,performance.now()-t);}
    const t=performance.now();
    const ok=gl.draw({
      source:source.el,width:w,height:h,version:source.version,live:source.live,landmarks,
      after:{layers:[...p.after.map(s=>stageLayer(s,face)),...p.textures.map(t=>textureLayer(t,face))],amounts:p.amounts},
      before:p.before?{layers:p.before.map(s=>stageLayer(s,face)),amounts:null}:null,
      seam:seamOn?1-seam:null,grade:lights.find(l=>l.id===light).grade,
      probes:landmarks?probes():null,time:now/1000
    });
    perf.drawMs=ema(perf.drawMs,performance.now()-t);
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
    ['مسیر نمایش',stage?'WebGL':stageBroken?'2D canvas':'—'],
    ['منبع',source?(source.kind==='photo'?'photo':frozen?'camera (frozen)':'camera'):'—'],
    ['فریم',source?`${w}×${h}`:'—'],
    ['نمایش',`${perf.fps} fps`],
    ['ردیابی',`${perf.hz} Hz · ${Math.round(perf.latency)} ms · ${tracker?(tracker.kind==='worker'?'worker':'main thread'):trackerStarting?'starting':'—'}`],
    ['هزینهٔ هر فریم',`masks ${perf.maskMs.toFixed(1)} ms · draw ${perf.drawMs.toFixed(1)} ms`],
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
  if(now-perf.since>=1000){perf.fps=Math.round(perf.frames*1000/(now-perf.since));perf.hz=Math.round(perf.detections*1000/(now-perf.since));perf.frames=0;perf.detections=0;perf.since=now;}
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

// The tracker runs in a worker. Where a worker cannot start MediaPipe (iPhones before
// iOS 17 have no WebGL inside workers) the same code runs on the page instead: a
// little slower, but the mirror works.
function onTracker(d){
  if(d.type==='ready'){
    clearTimeout(initTimer);ready=true;topology=d.topology;
    if(source){status(statusText());enableTools(true);}
  }else if(d.type==='result'){
    busy=false;
    if(sentGen!==generation||!source)return;
    perf.detections++;perf.latency=performance.now()-sentAt;
    landmarks=smoothLandmarks(landmarks,d.landmarks);
    if(source.kind==='photo')photoPasses++;
    poseAngles=d.landmarks?poseOf(d.matrix):null;
    if(d.blendshapes)blendshapes=d.blendshapes;
    if('skin' in d)onSkin(d.skin);
    else if(wantSkin&&!d.landmarks)onSkin(null);
    $('guide').hidden=!!landmarks;
    status(landmarks||source.kind==='photo'?statusText():'صورت پیدا نشد. کمی روبه‌روی دوربین و در نور بیشتر قرار بگیر.');
    invalidate({masks:true,measure:true});
  }else if(d.type==='error'){
    busy=false;
    perf.lastError=`${d.stage||'tracker'}: ${d.message||''}`;
    if(!ready&&tracker?.kind==='worker')useTracker('page',d.message);
    else shutdown('آینه روی این مرورگر آماده نشد. آخرین نسخهٔ مرورگر را امتحان کن.'+code({message:d.message}));
  }
}
function ensureTracker(){
  if(tracker||trackerStarting)return;
  let w=null;
  try{w=new Worker(new URL('face-worker.js?v=14',import.meta.url));}catch(e){perf.lastError=`worker: ${e.message}`;}
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
    await import('./face-core.js?v=14');
    const core=self.rojaFaceCore(Vision,new URL('./',import.meta.url).href);
    const found=await core.init();
    if(token!==trackerGeneration){core.close();return;}
    tracker={kind,post:m=>setTimeout(()=>{
      let out;
      try{out=core.handle(m);}catch(e){out={type:'error',stage:'detect',message:String(e?.message||e)};}
      finally{m.frame?.close?.();}
      onTracker(out);
    },0),close:()=>core.close()};
    trackerStarting=false;
    onTracker({type:'ready',topology:found});
  }catch(e){
    trackerStarting=false;
    if(token===trackerGeneration)shutdown('آینه روی این مرورگر آماده نشد. آخرین نسخهٔ Safari یا Chrome را امتحان کن.'+code(e));
  }
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
  enableTools(ready);
  ensureTracker();
  native?.keepScreenOn?.(true);
  cancelAnimationFrame(raf);raf=requestAnimationFrame(frame);
  updateSeam();invalidate({masks:true,measure:true});
}

function stop(message='دوربین خاموش شد.'){
  generation++;activeSource=false;busy=false;
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
  $('guide').hidden=true;$('badge').hidden=true;$('hud').hidden=true;$('brush-cursor').hidden=true;$('tap-start').hidden=true;
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
  status('اجازهٔ دوربین را در مرورگر تأیید کن.');
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('UNSUPPORTED');
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}}});
    if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;video.srcObject=stream;
    const playing=await video.play().then(()=>true,()=>false);
    await videoSize(video);
    if(token!==generation)return;
    if(!video.videoWidth||!video.videoHeight)throw Object.assign(new Error('the camera sent no picture'),{name:'NoVideo'});
    source={kind:'camera',el:video,width:video.videoWidth,height:video.videoHeight,live:true,version:++sourceVersion};
    status(ready?'صورتت را روبه‌روی دوربین نگه دار.':'آماده‌سازی آینه. بار اول ممکن است کمی طول بکشد.');
    goLive();
    if(!playing)$('tap-start').hidden=false;
    stream.getVideoTracks()[0].onended=()=>stop();
  }catch(e){
    if(token!==generation)return;
    perf.lastError=`camera: ${e?.name||''} ${e?.message||''}`;
    const errors={
      NotAllowedError:'اجازهٔ دوربین داده نشد. '+cameraHelp()+' یا یک عکس انتخاب کن.',
      SecurityError:'اجازهٔ دوربین داده نشد. '+cameraHelp(),
      NotFoundError:'دوربینی پیدا نشد. می‌توانی به‌جای آن یک عکس انتخاب کنی.',
      OverconstrainedError:'دوربین این دستگاه تنظیم خواسته‌شده را ندارد. یک عکس انتخاب کن.',
      NotReadableError:'دوربین در دسترس نیست. برنامه‌های دیگری که از آن استفاده می‌کنند را ببند.',
      NoVideo:'دوربین روشن شد اما تصویری نفرستاد. صفحه را دوباره باز کن.'
    };
    stop((errors[e.name]||(e.message==='UNSUPPORTED'
      ?(inApp?'این صفحه در مرورگر داخلی یک برنامه باز شده که به دوربین دسترسی ندارد. آن را در Safari یا Chrome باز کن، یا یک عکس انتخاب کن.'
        :'این مرورگر دوربین را پشتیبانی نمی‌کند. سایت را با HTTPS در Safari یا Chrome باز کن، یا یک عکس انتخاب کن.')
      :'دوربین باز نشد. دوباره امتحان کن.'))+code(e));
  }
}
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
  if(source.live||dirty||masksDirty||hasShimmer())draw(now);
  drawDebug();
  renderMeasure(now);
  updateHud(now);
}
function hasShimmer(){return plan().after.some(s=>(FINISH[s.finish]?.shimmer||0)>0);}
function detect(now){
  if(!ready||busy||!tracker||!source)return;
  if(source.kind==='camera'){
    if(frozen&&landmarks&&!wantSkin)return;
    // On the page itself, a little less often, so the interface stays responsive.
    if(now-lastSent<(tracker.kind==='page'?110:60)||video.readyState<2)return;
  }else{
    if(photoPasses>=PHOTO_PASSES&&!wantSkin)return;
    if(now-lastSent<30)return;
  }
  busy=true;lastSent=now;sentAt=performance.now();sentGen=generation;
  const token=generation;
  grabFrame().then(({frame,transfer})=>{
    if(token!==generation||!tracker){frame.close?.();busy=false;return;}
    tracker.post({type:'frame',frame,timestamp:now,extras:debug.on||$('debug-panel').open,sample:wantSkin},transfer);
  }).catch(e=>{busy=false;perf.lastError=`frame: ${e?.message||e}`;
    if(token===generation)stop('پردازش تصویر روی این مرورگر انجام نشد. مرورگر دیگری را امتحان کن.'+code(e));});
}
// The frame the tracker measures, 480 px wide. Drawing the video into a 2D canvas works
// the same everywhere; createImageBitmap straight from a camera video, with resizing,
// does not (WebKit on iPhone was the trouble). No createImageBitmap at all: ImageData.
const frameCanvas=document.createElement('canvas');
function grabFrame(){
  const w=480,h=Math.max(1,Math.round(480*source.height/source.width));
  if(frameCanvas.width!==w||frameCanvas.height!==h){frameCanvas.width=w;frameCanvas.height=h;}
  const x=frameCanvas.getContext('2d',{willReadFrequently:!window.createImageBitmap});
  x.drawImage(source.el,0,0,w,h);
  if(window.createImageBitmap)return createImageBitmap(frameCanvas).then(frame=>({frame,transfer:[frame]}));
  const frame=x.getImageData(0,0,w,h);
  return Promise.resolve({frame,transfer:[frame.data.buffer]});
}

/* ---------- tools on the mirror ----------------------------------------- */
const brushActive=()=>brushState.on&&mode==='makeup'&&!!source;
function setBrush(on){
  brushState.on=on;
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
  if(!stage)toast(compare?'نمایش بدون آرایش':'نمایش با آرایش');
  updateSeam();invalidate({masks:true});status(statusText());
}
function toggleFreeze(){
  if(source?.kind!=='camera')return;
  frozen=!frozen;
  $('freeze').setAttribute('aria-pressed',String(frozen));
  if(frozen)video.pause();else video.play().catch(()=>{});
  status(statusText());
}

function snapshot(){
  if(!source)return;
  const {w,h}=frameSize();
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');
  // Saved as seen: the preview is mirrored, so the saved picture is too.
  x.save();x.translate(w,0);x.scale(-1,1);
  if(stage&&!$('stage').hidden)x.drawImage($('stage'),0,0,w,h);
  else{
    x.drawImage(source.el,0,0,w,h);
    if($('natural-blend').checked)x.globalCompositeOperation='multiply';
    x.drawImage(overlay,0,0,w,h);x.globalCompositeOperation='source-over';
  }
  x.restore();
  if(seamOn){
    const sx=seam*w,s=Math.max(1,w/640);
    x.fillStyle='#D1AC3A';x.fillRect(sx-s,0,2*s,h);
    const [before,after]=seamLabels();
    x.font=`${13*s}px Estedad, Tahoma, sans-serif`;x.textBaseline='bottom';x.direction='rtl';
    const tag=(text,px,align)=>{x.textAlign=align;const m=x.measureText(text).width;
      x.fillStyle='#140C11CC';x.fillRect(align==='left'?px-6*s:px-m-6*s,h-30*s,m+12*s,22*s);x.fillStyle='#F4E3B0';x.fillText(text,px,h-12*s);};
    tag(before,12*s,'left');tag(after,w-12*s,'right');
  }
  const s=Math.max(1,w/640);
  x.font=`800 ${15*s}px Estedad, Tahoma, sans-serif`;x.fillStyle='#FFFFFFB0';x.textAlign='right';x.textBaseline='top';x.direction='rtl';
  x.fillText('رُژا',w-12*s,10*s);
  const label=mode==='procedure'
    ?([...active.keys()].map(id=>byId(id).short).join('، ')||'بدون عمل')
    :(products.filter(p=>makeupState[p.id].enabled).map(p=>`${p.name} ${shadeOf(p,makeupState[p.id].shade).name}`).join('، ')||'بدون آرایش');
  c.toBlob(blob=>{
    if(!blob){toast('ذخیرهٔ عکس روی این مرورگر ممکن نشد.');return;}
    shots.unshift({url:URL.createObjectURL(blob),blob,label,time:new Date(),picked:false});
    while(shots.length>12){URL.revokeObjectURL(shots.pop().url);}
    $('shots-count').textContent=fa.format(shots.length);
    $('flash').classList.remove('on');void $('flash').offsetWidth;$('flash').classList.add('on');
    toast('عکس گرفته شد. از «عکس‌ها» می‌توانی مقایسه یا ذخیره‌اش کنی.');
  },'image/png');
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
        el('button',{type:'button','aria-label':'حذف عکس',title:'حذف',onclick:()=>{URL.revokeObjectURL(shot.url);shots.splice(shots.indexOf(shot),1);
          $('shots-count').textContent=fa.format(shots.length);renderGallery();}},icon('i-trash'))));
  }));
  const picked=shots.filter(s=>s.picked);
  $('gallery-compare').hidden=picked.length!==2;
  if(picked.length===2)$('gallery-compare').replaceChildren(...picked.map(s=>el('figure',{},el('img',{src:s.url,alt:s.label}),el('figcaption',{text:s.label}))));
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

/* ---------- cart -------------------------------------------------------- */
function addToCart(item,shade,quiet=false){
  const key=`${item.id}:${shade.variantId}`;
  cart.set(key,(cart.get(key)||0)+1);renderCart();
  if(!quiet)toast(`${item.name} ${shade.name} به سبد نمونه اضافه شد.`);
}
function renderCart(){
  $('count').textContent=fa.format([...cart.values()].reduce((a,b)=>a+b,0));
  $('cart-items').replaceChildren();
  if(!cart.size){
    $('cart-items').append(el('p',{class:'quiet',text:'هنوز محصولی اضافه نکرده‌ای.'}));$('cart-total').hidden=true;return;
  }
  let sum=0;
  for(const [key,qty] of cart){
    const [pid,sid]=key.split(':');
    const item=byProduct(pid), shade=item.shades.find(s=>s.variantId===sid);
    sum+=item.price*qty;
    const change=d=>{const next=(cart.get(key)||0)+d;if(next<=0)cart.delete(key);else cart.set(key,next);renderCart();};
    $('cart-items').append(el('div',{class:'cart-row'},
      el('span',{class:'mini',style:{background:swatchStyle(shade)}}),
      el('p',{},`${item.name}، ${shade.name}`,el('small',{text:`${item.palettes?'پالت':'کد'} ${fa.format(Number(sid))}، ${toman(item.price*qty)}`})),
      el('div',{class:'qty'},
        el('button',{type:'button','aria-label':`یکی کمتر از ${item.name}`,onclick:()=>change(-1),text:'−'}),
        el('span',{text:fa.format(qty)}),
        el('button',{type:'button','aria-label':`یکی بیشتر از ${item.name}`,onclick:()=>change(1),text:'+'})),
      el('button',{class:'ghost',type:'button','aria-label':`حذف ${item.name} ${shade.name}`,text:'حذف',onclick:()=>{cart.delete(key);renderCart();}})));
  }
  $('cart-total').hidden=false;$('cart-sum').textContent=toman(sum);
}

/* ---------- wiring ------------------------------------------------------ */
$('mode-makeup').onclick=()=>setMode('makeup');
$('mode-procedure').onclick=()=>setMode('procedure');

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
  $('amount').textContent=pct($('intensity').value);invalidate({masks:true});
};
$('fade').oninput=()=>{
  makeupState[product.id].fade=Number($('fade').value);
  $('fade-amount').textContent=pct($('fade').value);invalidate({masks:true});
};
$('natural-blend').onchange=()=>invalidate({masks:true});
$('product-toggle').onclick=()=>{
  if(makeupState[product.id].enabled)makeupState[product.id].enabled=false;else enableProduct(product);
  afterMakeupChange();
};
$('add').onclick=()=>addToCart(product,selected());
$('add-look').onclick=()=>{
  const items=products.filter(p=>makeupState[p.id].enabled);
  for(const item of items)addToCart(item,shadeOf(item,makeupState[item.id].shade),true);
  toast(`${fa.format(items.length)} محصول ترکیب فعلی به سبد اضافه شد.`);
};
$('clear-look').onclick=()=>{for(const item of products)makeupState[item.id].enabled=false;pin=null;updatePinButton();afterMakeupChange();};
$('pin-shade').onclick=togglePin;
$('finder-run').onclick=runFinder;
$('basket').onclick=()=>{renderCart();$('cart').showModal();};
$('close').onclick=()=>$('cart').close();
$('gallery-open').onclick=()=>{renderGallery();$('gallery').showModal();};
$('gallery-close').onclick=()=>$('gallery').close();
for(const dialog of [$('cart'),$('gallery')])dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});

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
document.addEventListener('visibilitychange',()=>{if(document.hidden&&source?.kind==='camera')stop('با خارج‌شدن از صفحه، دوربین خاموش شد.');});
window.addEventListener('pagehide',()=>{stop();if(tracker){tracker.close();tracker=null;ready=false;}});
$('start').onclick=start;
$('photo-input').onchange=()=>{const file=$('photo-input').files[0];$('photo-input').value='';openPhoto(file);};
$('stop').onclick=()=>stop(source?.kind==='photo'?'عکس بسته شد.':'دوربین خاموش شد.');
// Dropping a photo on the mirror opens it too.
viewport.addEventListener('dragover',e=>{if([...e.dataTransfer.items].some(i=>i.type.startsWith('image/'))){e.preventDefault();}});
viewport.addEventListener('drop',e=>{const file=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(file){e.preventDefault();openPhoto(file);}});

renderBrushModes();
setRange('brush-size',brushState.size);$('brush-size-amount').textContent=pct(brushState.size);
renderLooks();renderLights();
selectProduct(product.id,false);
setMode('makeup');
renderCart();updateBrushInfo();
placeSeam();
document.querySelectorAll('input[type=range]').forEach(paintRange);

// The Android back button: close whatever is open on top first. Returns whether it
// did anything, so the app knows when to leave instead.
window.rojaBack=()=>{
  const dialog=document.querySelector('dialog[open]');
  if(dialog){dialog.close();return true;}
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
    description:"Select one of Roja's own sample shades and show it on the visible makeup combination. Does not start the camera or place an order.",
    inputSchema:{type:'object',properties:{
      product:{type:'string',enum:products.map(p=>p.id)},
      id:{type:'string',enum:[...new Set(products.flatMap(p=>p.shades.map(s=>s.id)))]}
    },required:['product','id'],additionalProperties:false},
    execute:selectMakeup
  },{
    name:'apply_makeup_look',
    description:"Put one of Roja's ready-made looks (a full combination of its own sample products) on the mirror. Does not start the camera or place an order.",
    inputSchema:{type:'object',properties:{look:{type:'string',enum:looks.map(l=>l.id)}},required:['look'],additionalProperties:false},
    execute:applyLookTool
  }];
  for(const tool of tools)try{Promise.resolve(document.modelContext.registerTool(tool)).catch(()=>{});}catch{}
}
