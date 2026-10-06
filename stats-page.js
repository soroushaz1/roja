// The page behind stats.html: reads the anonymous counts from /api/stats with the key
// set on the server, and names every item from the site's own catalogue.
import {products,looks,byProduct} from './catalog.js';
import {procedures} from './procedures.js';
import {skincareById} from './skin.js';

const $=id=>document.getElementById(id);
const fa=new Intl.NumberFormat('fa-IR');
const pct=new Intl.NumberFormat('fa-IR',{style:'percent'});
const date=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{year:'numeric',month:'long',day:'numeric'});
const day=d=>date.format(new Date(`${d}T12:00:00Z`));
const el=(tag,attrs={},...kids)=>{
  const node=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){if(k==='text')node.textContent=v;else if(k==='style')Object.assign(node.style,v);else node.setAttribute(k,v);}
  node.append(...kids);return node;
};
const shadeById=new Map(products.flatMap(p=>p.shades.map(s=>[s.id,{p,s}])));
const names={
  shade:id=>{const x=shadeById.get(id);return x?{name:`${x.p.name}، ${x.s.name}`,color:x.s.color}:{name:id};},
  look:id=>({name:looks.find(l=>l.id===id)?.name||(id==='mine'?'استایل‌های ذخیره‌شده':id==='link'?'از لینک فرستاده‌شده':id)}),
  procedure:id=>({name:procedures.find(p=>p.id===id)?.name||id}),
  buy:key=>{
    const [pid,sid]=key.split(':'), item=byProduct(pid)||skincareById(pid), shade=item?.shades.find(s=>s.variantId===sid);
    return item?{name:`${item.name}، ${shade?.name||sid}`,color:shade?.color}:{name:key};
  },
  share:id=>({name:{shot:'عکس',multi:'تصویر چند رنگ',link:'لینک استایل'}[id]||id}),
  // From before Roja stopped selling: kept so older days still read.
  order:id=>({name:{whatsapp:'واتس‌اپ',telegram:'تلگرام',share:'فرستادن لیست'}[id]||id})
};
names.cart=names.buy;
const titles={shade:'رنگ‌های پرامتحان',look:'استایل‌ها',procedure:'عمل‌های زیبایی',buy:'باز‌شده در فروشگاه همکار',share:'اشتراک‌گذاری',cart:'افزوده به سبد (پیش از همکاری)',order:'سفارش (پیش از همکاری)'};

try{$('key').value=localStorage.getItem('roja-stats-key')||'';}catch{}
$('form').onsubmit=e=>{e.preventDefault();load();};
// Which mirror the counts are for: all of them, Roja's own site, or one shop's.
let data=null;
$('shop').onchange=()=>{if(data)render(data);};
if($('key').value)load();

async function load(){
  const key=$('key').value.trim();
  try{localStorage.setItem('roja-stats-key',key);}catch{}
  $('status').textContent='در حال خواندن…';
  try{
    const r=await fetch(`api/stats?days=${$('days').value}`,{headers:{'X-Roja-Stats-Key':key},cache:'no-store'});
    if(r.status===403){$('status').textContent='کلید درست نیست، یا روی سرور تنظیم نشده.';$('out').replaceChildren();return;}
    if(!r.ok)throw new Error(r.status);
    data=await r.json();
  }catch(e){$('status').textContent=`خواندن آمار ممکن نشد (${e.message}).`;return;}
  $('status').textContent=`از ${day(data.from)} تا ${day(data.to)}`;
  const picked=$('shop').value;
  $('shop').replaceChildren(el('option',{value:'*',text:'همهٔ آینه‌ها'}),el('option',{value:'',text:'سایت خود رُژا'}),
    ...Object.entries(data.shops||{}).map(([id,name])=>el('option',{value:id,text:`آینهٔ ${name}`})));
  $('shop').value=[...$('shop').options].some(o=>o.value===picked)?picked:'*';
  $('shop').hidden=false;
  render(data);
}

// How far visits got, each step counted once per visit, as a share of the visits.
const stepNames={open:'بازکردن صفحه',camera:'روشن‌کردن دوربین',photo:'انتخاب عکس',face:'پیداشدن صورت',shade:'امتحان یک رنگ',buy:'رفتن به فروشگاه'};

function render({from,to,rows:all}){
  const only=$('shop').value;
  const rows=only==='*'?all:all.filter(r=>(r[4]||'')===only);
  const by={};
  for(const [day,event,item,n] of rows){((by[event]||={})[item]=(by[event][item]||0)+n);}
  const sum=event=>Object.values(by[event]||{}).reduce((a,b)=>a+b,0);
  const kpi=(value,label)=>el('div',{class:'kpi'},el('b',{text:value}),el('span',{text:label}));

  // Activity per day: every count, so a quiet day shows as one.
  const perDay=new Map();
  for(let t=new Date(from+'T12:00:00Z');t.toISOString().slice(0,10)<=to;t=new Date(t.getTime()+864e5))perDay.set(t.toISOString().slice(0,10),0);
  for(const [day,event,,n] of rows)if(event!=='step')perDay.set(day,(perDay.get(day)||0)+n);
  const peak=Math.max(1,...perDay.values());

  const list=event=>{
    const items=Object.entries(by[event]||{}).sort((a,b)=>b[1]-a[1]).slice(0,15);
    const top=items[0]?.[1]||1;
    return el('section',{},el('h2',{text:titles[event]}),
      ...(items.length?items.map(([id,n])=>{
        const {name,color}=names[event](id);
        return el('div',{class:'row'},el('i',{style:{background:color||'transparent',borderColor:color?'#FFFFFF22':'transparent'}}),
          el('span',{class:'name',text:name,title:name}),el('b',{text:fa.format(n)}),
          el('span',{class:'bar'},el('s',{style:{width:`${n/top*100}%`}})));
      }):[el('p',{class:'empty',text:'هنوز چیزی ثبت نشده.'})]));
  };
  const steps=by.step||{}, opened=steps.open||0;
  const funnel=el('section',{style:{marginBottom:'12px'}},el('h2',{text:'مسیر بازدید'}),
    ...(opened?Object.keys(stepNames).map(id=>{
      const n=steps[id]||0;
      return el('div',{class:'row'},el('i',{style:{borderColor:'transparent'}}),
        el('span',{class:'name',text:stepNames[id]}),
        el('b',{class:'step'},el('span',{text:fa.format(n)}),...(id==='open'?[]:[el('small',{text:pct.format(n/opened)})])),
        el('span',{class:'bar'},el('s',{style:{width:`${Math.min(1,n/opened)*100}%`}})));
    }):[el('p',{class:'empty',text:'از این بازه هنوز مسیری ثبت نشده.'})]));
  $('out').replaceChildren(
    el('div',{class:'kpis'},
      kpi(fa.format(sum('shade')),'رنگ امتحان‌شده'),
      kpi(fa.format(sum('look')),'استایل امتحان‌شده'),
      kpi(fa.format(sum('buy')),'رفتن به فروشگاه همکار'),
      kpi(fa.format(sum('share')),'اشتراک‌گذاری')),
    funnel,
    el('section',{style:{marginBottom:'12px'}},el('h2',{text:'فعالیت روزانه'}),
      el('div',{class:'days'},...[...perDay].map(([d,n])=>el('div',{title:`${day(d)}: ${fa.format(n)}`,style:{height:`${n/peak*100}%`}})))),
    el('div',{class:'grid'},...['shade','look','buy','procedure','share',...['cart','order'].filter(e=>by[e])].map(list)));
}
