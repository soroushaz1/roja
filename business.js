// The business page's part that talks to the server (server/billing.mjs): the prices the
// server charges, buying the professional plan through Zarinpal, what the page shows on
// the way back, and a shop's own panel, opened with its activation code.
//
// The activation code is kept in this browser's storage once shown, so the panel opens
// by itself next time; "forget the code here" removes it.
const API='/api/';
const SITE='https://pythonpath.ir/';
const CODE='roja-shop-code';
const $=id=>document.getElementById(id);
const fa=new Intl.NumberFormat('fa-IR');
const day=t=>new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'long'}).format(new Date(t));
const el=(tag,props={},...children)=>{
  const n=document.createElement(tag);
  for(const [k,v] of Object.entries(props)){
    if(k==='text')n.textContent=v;else if(k.startsWith('on'))n[k]=v;else if(v!=null&&v!==false)n.setAttribute(k,v===true?'':v);
  }
  n.append(...children.filter(c=>c!=null));
  return n;
};
const stored=()=>{try{return localStorage.getItem(CODE)||'';}catch{return '';}};
const store=code=>{try{code?localStorage.setItem(CODE,code):localStorage.removeItem(CODE);}catch{}};

async function call(path,body){
  const res=await fetch(API+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(data.error||res.status),{status:res.status,field:data.field,error:data.error});
  return data;
}
const FIELDS={name:'نام فروشگاه را بنویسید (۲ تا ۴۰ حرف).',origin:'نشانی سایت باید با https:// شروع شود، مثل https://shop.example.ir',
  search:'نشانی جست‌وجو باید با https:// شروع شود و {q} داشته باشد.',contact:'شمارهٔ موبایل درست نیست.',period:'مدت اشتراک را انتخاب کنید.'};
function explain(e){
  if(e.status===400)return FIELDS[e.field]||'اطلاعات فرم کامل نیست.';
  if(e.status===404)return 'این کد فعال‌سازی پیدا نشد. حروف و خط‌ها را دوباره نگاه کنید.';
  if(e.status===429)return 'چند بار پشت سر هم امتحان شد؛ یک دقیقه بعد دوباره بزنید.';
  if(e.status===503)return 'پرداخت آنلاین هنوز باز نشده است. پیام بدهید.';
  if(e.status===502)return 'درگاه زرین‌پال جواب نداد. چند دقیقه بعد دوباره امتحان کنید.';
  return 'اتصال برقرار نشد. اینترنت را بررسی کنید و دوباره بزنید.';
}
function showError(form,text){const p=form.querySelector('.form-error');p.textContent=text||'';p.hidden=!text;}
const snippet=id=>`<iframe src="${SITE}?shop=${id}"
        allow="camera; clipboard-write; web-share; fullscreen"
        style="width:100%;height:760px;border:0;border-radius:16px"
        title="Roja makeup mirror"></iframe>`;
function copyButton(text,label='کپی'){
  const b=el('button',{type:'button',class:'button ghost small',text:label});
  b.onclick=async()=>{try{await navigator.clipboard.writeText(text);b.textContent='کپی شد';setTimeout(()=>{b.textContent=label;},1600);}catch{}};
  return b;
}

/* ---- prices, and whether payment is open ---- */
async function plans(){
  try{
    const p=await call('plans');
    for(const n of document.querySelectorAll('[data-price]'))n.textContent=fa.format(p.periods[n.dataset.price].price);
    $('subscribe-form').hidden=!p.open;$('subscribe-closed').hidden=p.open;
    $('subscribe-form').querySelector('.sandbox').hidden=!p.sandbox;
  }catch{}
}

/* ---- buying ---- */
$('subscribe-form').onsubmit=async e=>{
  e.preventDefault();
  const form=e.target,data=Object.fromEntries(new FormData(form));
  let origin=data.origin.trim();
  if(origin&&!/^https?:\/\//i.test(origin))origin='https://'+origin;
  const button=form.querySelector('button[type=submit]');
  showError(form,'');button.disabled=true;button.textContent='در حال رفتن به درگاه…';
  try{
    const {url}=await call('pay/start',{period:data.period,shop:{name:data.name,origin,search:data.search.trim(),contact:data.contact.trim()}});
    location.href=url;
  }catch(err){showError(form,explain(err));button.disabled=false;button.textContent='پرداخت و فعال‌سازی';}
};

/* ---- back from Zarinpal ---- */
// Returns whether it has opened the panel itself.
function landed(){
  const h=new URLSearchParams(location.hash.slice(1));
  const pay=h.get('pay');
  if(!pay)return false;
  history.replaceState(null,'',location.pathname+location.search);
  const box=$('pay-result');box.hidden=false;
  if(pay==='ok'&&h.get('code')){
    const code=h.get('code'),id=h.get('shop');
    store(code);
    box.className='pay-result ok';
    box.replaceChildren(
      el('h3',{text:'اشتراک حرفه‌ای فعال شد'}),
      el('p',{text:'این کد فعال‌سازی شماست. جایی امن نگهش دارید: بدون آن نمی‌شود وضعیت را دید یا تمدید کرد، و دوباره نشان داده نمی‌شود.'}),
      el('p',{class:'code-row'},el('code',{dir:'ltr',class:'big-code',text:code}),copyButton(code)),
      el('p',{text:`شناسهٔ فروشگاه: ${id}. این کد را روی سایتتان بگذارید:`}),
      el('pre',{dir:'ltr'},el('code',{text:snippet(id)})),
      el('p',{},copyButton(snippet(id),'کپی کد آینه')));
    box.scrollIntoView({block:'start'});
    login(code);
    return true;
  }else if(pay==='renewed'||pay==='done'){
    box.className='pay-result ok';
    box.replaceChildren(el('h3',{text:pay==='renewed'?'اشتراک تمدید شد':'این پرداخت قبلاً ثبت شده است'}),
      el('p',{text:'وضعیت تازه در پنل فروشگاه، پایین همین بخش است.'}));
    box.scrollIntoView({block:'start'});
    if(stored()){login(stored());return true;}
  }else{
    box.className='pay-result failed';
    box.replaceChildren(el('h3',{text:'پرداخت انجام نشد'}),
      el('p',{text:'پرداخت لغو شد یا تأیید نشد. اگر مبلغی از حسابتان کم شده، بانک طی ۷۲ ساعت برمی‌گرداند. می‌توانید دوباره امتحان کنید.'}));
    box.scrollIntoView({block:'start'});
  }
  return false;
}

/* ---- the shop's panel ---- */
let current=null,code='';
async function login(c){
  const form=$('login-form');showError(form,'');
  try{current=await call('shop/login',{code:c});code=c;store(c);form.hidden=true;renderPanel();}
  catch(e){showError(form,explain(e));if(e.status===404&&c===stored())store('');}
}
$('login-form').onsubmit=e=>{e.preventDefault();login(new FormData(e.target).get('code').trim());};

function renderPanel(){
  const s=current,box=$('shop-panel');box.hidden=false;
  const left=Math.ceil((s.until-Date.now())/864e5);
  const status=s.active
    ?el('p',{class:'status ok',text:`فعال تا ${day(s.until)} (${fa.format(left)} روز دیگر)`})
    :el('p',{class:'status off',text:`تمام شده در ${day(s.until)}؛ آینه حالا پلن پایه را نشان می‌دهد.`});
  const renew=period=>{
    const b=el('button',{type:'button',class:period==='year'?'button':'button ghost',text:period==='year'?'تمدید یک‌ساله':'تمدید یک‌ماهه'});
    b.onclick=async()=>{b.disabled=true;try{location.href=(await call('pay/start',{period,code})).url;}catch(e){b.disabled=false;alert(explain(e));}};
    return b;
  };
  const edit=el('form',{class:'form'},
    el('label',{},'نام فروشگاه ',el('input',{name:'name',value:s.name,required:true,maxlength:'40'})),
    el('label',{},'نشانی سایت ',el('input',{name:'origin',value:s.origin,dir:'ltr',required:true})),
    el('label',{},'نشانی جست‌وجو ',el('input',{name:'search',value:s.search||'',dir:'ltr',placeholder:'https://shop.example.ir/search?q={q}'})),
    el('label',{},'شمارهٔ موبایل ',el('input',{name:'contact',value:s.contact||'',dir:'ltr'})),
    el('p',{class:'form-error',role:'alert',hidden:true}),
    el('button',{type:'submit',class:'button ghost',text:'ذخیرهٔ تغییرات'}));
  edit.onsubmit=async e=>{
    e.preventDefault();showError(edit,'');
    const d=Object.fromEntries(new FormData(edit));
    try{current=await call('shop/update',{code,name:d.name,origin:d.origin.trim(),search:d.search.trim(),contact:d.contact.trim()});renderPanel();}
    catch(err){showError(edit,explain(err));}
  };
  const forget=el('button',{type:'button',class:'linkish',text:'فراموش کردن کد در این مرورگر'});
  forget.onclick=()=>{store('');current=null;box.hidden=true;$('login-form').hidden=false;};
  box.replaceChildren(
    el('h3',{text:s.name}),
    el('p',{class:'quiet'},'شناسه: ',el('code',{dir:'ltr',text:s.id}),' · سایت: ',el('code',{dir:'ltr',text:s.origin})),
    status,
    el('div',{class:'row'},renew('month'),renew('year')),
    el('h4',{text:'کد آینه برای سایت شما'}),
    el('pre',{dir:'ltr'},el('code',{text:snippet(s.id)})),
    el('p',{},copyButton(snippet(s.id),'کپی کد آینه'),' ',el('a',{href:`${SITE}?shop=${s.id}`,target:'_blank',rel:'noopener',text:'باز کردن آینهٔ فروشگاه'})),
    el('p',{class:'quiet',text:'قابلیت‌های حرفه‌ای فقط روی همین نشانی سایت باز می‌شوند. اگر نشانی سایت عوض شد، اینجا درستش کنید.'}),
    el('details',{},el('summary',{text:'ویرایش اطلاعات فروشگاه'}),edit),
    forget);
}

plans();
if(!landed()&&stored())login(stored());
window.addEventListener('hashchange',landed);
