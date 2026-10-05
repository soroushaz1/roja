// The skin check panel: take a picture of the bare face (or skip it), answer the
// questions, read the profile and the routine, and, only if asked, keep the result on
// the server to compare with later checks.
//
// The mirror (app.js) owns the camera and the landmarks. It calls tick() every frame
// while this panel is showing; the panel asks it for a measurement through scan()
// when it wants one, a few times a second at most.
import {questions,requiredQuestions,assess,combineScans,record,axes,fitzNames,concernNames} from './skin.js?v=19';

const QUALITY={
  size:'صورت به اندازهٔ کافی نزدیک است',
  pose:'سر صاف و روبه‌روی دوربین است',
  light:'نور صورت کافی است و جایی سفید نشده',
  even:'نور دو طرف صورت یکسان است',
  colour:'رنگ نور طبیعی است (نه زرد یا آبی)',
  sharp:'تصویر واضح است'
};
// On the web the API sits on this origin. In the Android app the page comes out of the
// APK, so there is nothing at a relative address and the app names the server it was
// built against. Knowing the address reaches nothing on its own: in the app the panel
// stays off the network until its owner turns saving on, below.
const API=window.RojaAndroid?.skinApi?.()||'api/skin';
const IN_APP=!!window.RojaAndroid;
const SCANS=6;

export function createSkinPanel({el,fa,pct,toman,toast,addToCart,scan,mirror}){
  const $=id=>document.getElementById(id);
  const answers={using:[],irritants:[]};
  let step='capture';               // capture | questions | result
  let live=null,lastScan=0,collecting=null,scanResult=null,result=null,saved=null;
  // Whether this panel may talk to the server at all. On the web it shares the page's
  // origin and always may; in the app, which otherwise never reaches the network, its
  // owner turns it on in renderFollow() first.
  let netOk=!IN_APP;

  /* ---- step 1: the picture ---- */
  function renderQuality(){
    const list=$('skin-quality'),state=mirror();
    if(state.native){
      list.replaceChildren(el('li',{class:'bad',text:'دوربین زندهٔ اپ اندروید هنوز برای تحلیل پوست آماده نیست. یک عکس انتخاب کن یا رُژا را در مرورگر باز کن.'}));
      $('skin-scan').disabled=true;return;
    }
    if(!state.source){list.replaceChildren(el('li',{text:'دوربین را روشن کن یا یک عکس انتخاب کن.'}));$('skin-scan').disabled=true;return;}
    if(!state.face){list.replaceChildren(el('li',{class:'bad',text:'صورت پیدا نشد.'}));$('skin-scan').disabled=true;return;}
    if(!live){list.replaceChildren(el('li',{text:'در حال بررسی تصویر…'}));$('skin-scan').disabled=true;return;}
    list.replaceChildren(...live.quality.map(q=>el('li',{class:q.ok?'ok':'bad',text:QUALITY[q.id]})));
    $('skin-scan').disabled=!!collecting;
    $('skin-scan').textContent=collecting?'بی‌حرکت بمان…':live.ok?'تحلیل تصویر':'با همین کیفیت تحلیل کن';
  }
  function tick(now){
    if(step!=='capture')return;
    const state=mirror();
    if(!state.source||!state.face||state.native){if(live||collecting){live=null;collecting=null;}renderQuality();return;}
    if(now-lastScan<(collecting?220:400))return;
    lastScan=now;
    const s=scan();
    if(s)live=s;
    if(collecting&&s){
      collecting.push(s);
      if(collecting.length>=SCANS){
        scanResult=combineScans(collecting);collecting=null;
        toast('تصویر تحلیل شد. حالا چند پرسش کوتاه.');
        go('questions');return;
      }
    }
    renderQuality();
  }
  $('skin-scan').onclick=()=>{collecting=[];renderQuality();};
  $('skin-skip').onclick=()=>{scanResult=null;go('questions');};

  /* ---- step 2: the questions ---- */
  function renderQuestions(){
    const box=$('skin-form');
    box.replaceChildren(...questions.map((q,n)=>{
      const name=`skin-q-${q.id}`;
      const opts=q.options.map(([value,text])=>{
        const input=el('input',{type:q.multi?'checkbox':'radio',name,value});
        if(q.multi)input.checked=answers[q.id].includes(value);
        else input.checked=answers[q.id]===value;
        input.onchange=()=>{
          if(q.multi)answers[q.id]=[...box.querySelectorAll(`[name="${name}"]:checked`)].map(i=>i.value);
          else answers[q.id]=value;
          updateDone();
        };
        return el('label',{class:'option'},input,el('span',{text}));
      });
      return el('fieldset',{class:'question'},
        el('legend',{},el('b',{text:fa.format(n+1)}),q.text),
        q.help?el('p',{class:'help',text:q.help}):null,
        q.multi?el('p',{class:'help',text:'هر چند مورد که درست است، یا هیچ‌کدام.'}):null,
        el('div',{class:'options'+(q.options.length>5?' many':'')},...opts));
    }));
    updateDone();
  }
  const missing=()=>requiredQuestions.filter(id=>answers[id]==null);
  function updateDone(){
    const left=missing().length;
    $('skin-done').disabled=left>0;
    $('skin-left').textContent=left?`${fa.format(left)} پرسش مانده.`:'';
  }
  $('skin-done').onclick=()=>{
    if(missing().length)return;
    result=assess({answers,scan:scanResult});saved=null;
    go('result');
  };
  $('skin-back').onclick=()=>go('capture');

  /* ---- step 3: the result ---- */
  const bar=(value,label)=>el('div',{class:'meter',role:'img','aria-label':`${label}: ${pct(value)}`},el('i',{style:{width:value+'%'}}));
  function productRow(s){
    const p=s.product,shade=p.shades[0];
    return el('li',{class:'routine-step'},
      el('span',{class:'mini',style:{background:shade.color}}),
      el('div',{},
        el('strong',{text:p.name}),el('small',{text:` · ${shade.name} · ${toman(p.price)}`}),
        el('p',{class:'help',text:s.why}),
        s.note?el('p',{class:'quiet',text:s.note}):null),
      el('button',{class:'ghost',type:'button','aria-label':`افزودن ${p.name} به سبد`,text:'سبد',onclick:()=>addToCart(p,shade)}));
  }
  function renderResult(){
    const r=result,box=$('skin-result-body');
    const fitz=r.fitz?el('div',{class:'profile-card'},
      el('p',{class:'eyebrow',text:'فوتوتایپ فیتزپاتریک'}),
      el('strong',{class:'big',text:`تیپ ${fitzNames[r.fitz.type]}`}),
      el('small',{text:`اطمینان ${pct(r.fitz.conf)} · ${{both:'از پرسش آفتاب و رنگ پوست',answers:'از پرسش آفتاب',image:'فقط از رنگ پوست در تصویر'}[r.fitz.from]}`}))
      :el('div',{class:'profile-card'},el('p',{class:'eyebrow',text:'فوتوتایپ فیتزپاتریک'}),el('small',{text:'بدون پاسخ پرسش آفتاب و بدون تصویر تعیین نمی‌شود.'}));
    const baumann=el('div',{class:'profile-card'},
      el('p',{class:'eyebrow',text:'تیپ پوستی باومن'}),
      el('strong',{class:'big',dir:'ltr',text:r.baumann.code}),
      el('ul',{class:'axes'},...axes.map(a=>{
        const v=r.baumann.axes[a.id];
        return el('li',{},el('b',{dir:'ltr',text:v.letter}),
          el('span',{text:v.letter===a.pos?a.posName:a.negName}),el('small',{text:`اطمینان ${pct(v.conf)}`}));
      })));
    const concerns=Object.entries(r.concerns).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
      el('li',{},el('span',{text:concernNames[k]}),bar(v,concernNames[k]),el('output',{text:fa.format(v)})));
    const all=[...r.routine.morning,...r.routine.evening].map(s=>s.product).filter((p,i,list)=>list.indexOf(p)===i);
    box.replaceChildren(...[
      el('div',{class:'profile'},fitz,baumann),
      r.imageQuality===false?el('p',{class:'note',text:'کیفیت تصویر کامل نبود؛ عددهایی که از تصویر آمده‌اند تقریبی‌ترند.'}):null,
      !r.image?el('p',{class:'help',text:'بدون تصویر: نتیجه فقط از پاسخ‌هاست.'}):null,
      el('h3',{text:'وضعیت پوست'}),
      el('ul',{class:'concerns'},...concerns),
      el('p',{class:'help',text:'۰ یعنی نشانه‌ای دیده یا گزارش نشده، ۱۰۰ یعنی خیلی زیاد. حساسیت از پرسش‌ها می‌آید؛ قرمزی، جوش، بافت و زیر چشم فقط از تصویر، و وقتی تصویر برایشان کافی نباشد نشان داده نمی‌شوند.'}),
      el('h3',{text:'اولویت‌ها'}),
      el('ol',{class:'priorities'},...r.priorities.map(t=>el('li',{text:t}))),
      el('h3',{text:'روتین صبح'}),
      el('ol',{class:'routine'},...r.routine.morning.map(productRow)),
      el('h3',{text:'روتین شب'}),
      el('ol',{class:'routine'},...r.routine.evening.map(productRow)),
      el('button',{class:'ghost wide',type:'button',text:'همهٔ محصولات روتین به سبد',onclick:()=>{all.forEach(p=>addToCart(p,p.shades[0],true));toast(`${fa.format(all.length)} محصول به سبد نمونه اضافه شد.`);}}),
      ...r.routine.notes.map(t=>el('p',{class:'quiet',text:t}))].filter(Boolean));
    renderFollow();
  }

  /* ---- keeping a result, by choice ---- */
  // A random key on this device names its results on the server. Whoever has the key
  // can read and delete them; it is sent in a header, never in an address.
  function deviceKey(){
    let key=null;
    try{key=localStorage.getItem('roja-skin-key');}catch{}
    if(!/^[0-9a-f]{32}$/.test(key||'')){
      key=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
      try{localStorage.setItem('roja-skin-key',key);}catch{}
    }
    return key;
  }
  async function call(method,path='',body){
    const response=await fetch(API+path,{method,cache:'no-store',
      headers:{'X-Roja-Key':deviceKey(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(!response.ok)throw Object.assign(new Error(`HTTP ${response.status}`),{status:response.status});
    return response.status===204?null:response.json();
  }
  const date=t=>new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium'}).format(new Date(t));
  async function renderFollow(){
    const box=$('skin-follow');
    // In the app, ask before the first request. Until this is answered the app makes no
    // network request of any kind, so the rest of the panel stays wholly on the phone.
    if(!netOk){
      box.replaceChildren(
        el('p',{class:'help',text:'این برنامه به‌خودی‌خود به اینترنت وصل نمی‌شود. اگر بخواهی نتیجهٔ این تحلیل روی سرور رُژا نگه داشته شود تا چند هفته بعد با تحلیل تازه مقایسه‌اش کنی، باید ارتباط با سرور را فعال کنی. عکس فرستاده نمی‌شود؛ فقط عددهای تحلیل و پاسخ‌هایت، و آن هم تنها اگر در گام بعد موافقت کنی.'}),
        el('div',{class:'row-actions'},el('button',{class:'ghost',type:'button',text:'فعال‌کردن ارتباط با سرور',
          onclick:()=>{netOk=true;renderFollow();}})));
      return;
    }
    const consent=el('input',{type:'checkbox',id:'skin-consent'});
    const save=el('button',{class:'primary',type:'button',disabled:'',text:saved?'ذخیره شد':'ذخیرهٔ نتیجه'});
    if(saved)save.disabled=true;
    consent.onchange=()=>{save.disabled=!consent.checked||!!saved;};
    save.onclick=async()=>{
      save.disabled=true;
      try{saved=await call('POST','',record(result,answers));toast('نتیجه ذخیره شد.');renderFollow();}
      catch(e){save.disabled=false;toast(e.status===429?'کمی بعد دوباره امتحان کن.':'ذخیره نشد. اتصال اینترنت را بررسی کن.');}
    };
    const feedback=saved?el('div',{class:'row-actions'},
      el('span',{class:'help',text:'این نتیجه با شناختی که از پوستت داری جور است؟'}),
      ...[[true,'بله'],[false,'نه']].map(([agree,text])=>el('button',{class:'ghost',type:'button',text,onclick:async e=>{
        try{await call('POST',`/${saved.id}/feedback`,{agree});e.target.closest('.row-actions').replaceChildren(el('span',{class:'help',text:'ممنون؛ این پاسخ به بهتر شدن تحلیل کمک می‌کند.'}));}
        catch{toast('ثبت نشد.');}}}))):null;
    const history=el('div',{class:'history'},el('p',{class:'quiet',text:'در حال خواندن نتیجه‌های قبلی…'}));
    box.replaceChildren(
      el('p',{class:'help',text:'اگر بخواهی، این نتیجه روی سرور رُژا نگه داشته می‌شود تا چند هفته بعد، با تحلیل تازه مقایسه‌اش کنی. فقط عددها و پاسخ‌هایت ذخیره می‌شود، نه عکس؛ و نام یا شماره‌ای از تو نمی‌خواهیم. هر وقت بخواهی همه را پاک می‌کنی.'}),
      el('label',{class:'check'},consent,'موافقم که نتیجه و پاسخ‌هایم (بدون عکس) ذخیره شود.'),
      el('div',{class:'row-actions'},save),
      ...[feedback,history].filter(Boolean));
    if(saved)consent.checked=true;
    try{
      const {items}=await call('GET');
      if(!items.length){history.replaceChildren();return;}
      history.replaceChildren(...[
        el('h3',{text:'نتیجه‌های قبلی'}),
        compareOldest(items),
        el('ul',{class:'past'},...items.map(it=>el('li',{},
          el('span',{text:date(it.created)}),el('b',{dir:'ltr',text:it.record.baumann}),
          el('small',{text:it.record.fitz?`فیتزپاتریک ${fitzNames[it.record.fitz.type]}`:''})))),
        el('button',{class:'ghost',type:'button',text:'پاک‌کردن همهٔ نتیجه‌های ذخیره‌شده',onclick:async()=>{
          try{await call('DELETE');saved=null;toast('همهٔ نتیجه‌ها از سرور پاک شد.');renderFollow();}catch{toast('پاک نشد. دوباره امتحان کن.');}
        }})].filter(Boolean));
    }catch(e){
      history.replaceChildren(el('p',{class:'quiet',text:e.status===404||e instanceof TypeError?'ذخیرهٔ نتیجه در این نسخه در دسترس نیست.':'نتیجه‌های قبلی خوانده نشد.'}));
      if(e.status===404||e instanceof TypeError){consent.disabled=true;save.disabled=true;}
    }
  }
  // The newest check against the first one kept, for the concerns both measured.
  function compareOldest(items){
    if(items.length<2)return null;
    const now=items[0].record.concerns,then=items[items.length-1].record.concerns;
    const rows=Object.keys(concernNames).filter(k=>k in now&&k in then).map(k=>{
      const d=now[k]-then[k];
      return el('li',{},el('span',{text:concernNames[k]}),
        el('span',{text:`${fa.format(then[k])} ← ${fa.format(now[k])}`}),
        el('small',{class:d<0?'down':d>0?'up':'',text:d?`${d>0?'+':'−'}${fa.format(Math.abs(d))}`:'بدون تغییر'}));
    });
    return el('div',{},
      el('p',{class:'help',text:`از ${date(items[items.length-1].created)} تا ${date(items[0].created)}. برای مقایسهٔ درست، هر بار در همان نور و همان فاصله عکس بگیر.`}),
      el('ul',{class:'concerns compare'},...rows));
  }

  $('skin-restart').onclick=()=>{scanResult=null;result=null;saved=null;go('capture');};

  function go(next,scroll=true){
    step=next;
    for(const [id,s] of [['skin-capture','capture'],['skin-questions','questions'],['skin-result','result']])$(id).hidden=step!==s;
    $('skin-steps').querySelectorAll('li').forEach((li,i)=>li.setAttribute('aria-current',String(['capture','questions','result'][i]===step)));
    if(step==='capture'){live=null;collecting=null;renderQuality();}
    if(step==='questions'){
      $('skin-scan-note').textContent=scanResult?`تصویر از ${fa.format(scanResult.samples)} نما تحلیل شد${scanResult.quality?'':'، با کیفیت ناکامل'}.`:'بدون تصویر؛ نتیجه فقط از پاسخ‌ها ساخته می‌شود.';
      renderQuestions();
    }
    if(step==='result')renderResult();
    if(scroll&&step!=='capture')$('panel-skin').scrollIntoView?.({block:'start',behavior:'smooth'});
  }
  go('capture',false);
  return {tick,get step(){return step;},refresh:renderQuality};
}
