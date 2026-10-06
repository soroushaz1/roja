// Builds the site's static pages from the same data the mirror uses, so a search engine
// (and anyone without a camera) can find and read them: one page per procedure and per
// makeup product, an index of each, the questions people ask, the privacy note, and the
// sitemap. Each page leads into the mirror with that item already chosen.
//
//   node tools/build-pages.mjs           # writes the pages
//   node tools/build-pages.mjs --check   # fails if a committed page is out of date
//
// The output is committed, like the rest of the site: there is still no build step to
// serve it. Run this after changing procedures.js, catalog.js or the text below.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {products,categories,finishes} from '../catalog.js';
import {procedures,regions,kinds} from '../procedures.js';
import {skincare} from '../skin.js';
import {contact} from '../shops.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SITE='https://pythonpath.ir/';
const check=process.argv.includes('--check');
const fa=new Intl.NumberFormat('fa-IR');

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Pages sit in folders (procedures/rhinoplasty/index.html) for clean addresses, and link
// to each other relatively, so they also work from a sub-path such as /roja/.
const up=dir=>dir?'../'.repeat(dir.split('/').length):'';

function page({dir,title,description,h1,lead,body,crumbs=[],jsonld=[]}){
  const r=up(dir), url=SITE+(dir?dir+'/':'');
  const trail=[{name:'رُژا',url:SITE},...crumbs.map(c=>({name:c.name,url:SITE+c.dir+'/'}))];
  const ld=[...(crumbs.length?[{'@context':'https://schema.org','@type':'BreadcrumbList',
    itemListElement:trail.map((c,i)=>({'@type':'ListItem',position:i+1,name:c.name,item:c.url}))}]:[]),...jsonld];
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#140C11">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="رُژا">
<meta property="og:locale" content="fa_IR">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}icons/share.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${r}favicon.svg">
<link rel="preload" href="${r}fonts/Estedad-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${r}pages.css">
${ld.map(x=>`<script type="application/ld+json">${JSON.stringify(x).replace(/</g,'\\u003c')}</script>`).join('\n')}
</head>
<body>
<header class="top">
  <a class="brand" href="${r}">رُژا <span>آینهٔ زنده</span></a>
  <nav aria-label="صفحه‌ها">
    <a href="${r}makeup/">آرایش</a>
    <a href="${r}procedures/">عمل‌های زیبایی</a>
    <a href="${r}faq/">پرسش‌ها</a>
    <a href="${r}business/">برای فروشگاه‌ها</a>
  </nav>
</header>
<main>
${crumbs.length?`<nav class="crumbs" aria-label="مسیر"><a href="${r}">رُژا</a>${crumbs.map((c,i)=>i===crumbs.length-1
    ?` › <span aria-current="page">${esc(c.name)}</span>`:` › <a href="${r}${c.dir}/">${esc(c.name)}</a>`).join('')}</nav>`:''}
<h1>${esc(h1)}</h1>
${lead?`<p class="lead">${esc(lead)}</p>`:''}
${body(r)}
</main>
<footer>
  <p>رُژا آینه‌ای زنده در مرورگر است. تصویر دوربین روی همین دستگاه پردازش می‌شود و جایی فرستاده یا ذخیره نمی‌شود.</p>
  <p><a href="${r}">آینه</a> · <a href="${r}makeup/">آرایش</a> · <a href="${r}procedures/">عمل‌های زیبایی</a> · <a href="${r}faq/">پرسش‌ها</a> · <a href="${r}business/">برای فروشگاه‌ها</a> · <a href="${r}privacy/">حریم خصوصی</a></p>
</footer>
</body>
</html>
`;
}
const cta=(href,text)=>`<p class="cta"><a class="button" href="${href}">${esc(text)}</a></p>`;
const NOT_MEDICAL='این پیش‌نمایش فقط شبیه‌سازی تصویری تغییر شکل است، نه پیش‌بینی نتیجه. تورم، کبودی، بهبود، ضخامت پوست و کار هر جراح را در نظر نمی‌گیرد. مدت ماندگاری و دورهٔ نقاهت، بازه‌های رایج و کلی‌اند، نه توصیهٔ پزشکی. برای هر تصمیم درمانی با پزشک متخصص مشورت کن.';
const COLOUR_NOTE='رنگ‌ها نمونه‌ای روی صفحه‌اند، نه اندازه‌گیری دقیق محصول؛ نور محیط، دوربین و رنگ طبیعی پوست، چیزی را که می‌بینی جابه‌جا می‌کنند.';

const out=new Map();      // relative path -> content

/* ---- procedures ---- */
for(const p of procedures){
  const region=regions.find(r=>r.id===p.region);
  const related=procedures.filter(x=>x.region===p.region&&x.id!==p.id);
  const dir=`procedures/${p.id}`;
  out.set(`${dir}/index.html`,page({dir,
    title:`شبیه‌سازی ${p.name} روی صورت خودت | رُژا`,
    description:`نتیجهٔ تقریبی ${p.name} را پیش از تصمیم، زنده روی صورت خودت ببین. ${p.summary} ماندگاری: ${p.lasts}.`,
    h1:`شبیه‌سازی ${p.name}`,
    lead:p.summary,
    crumbs:[{name:'عمل‌های زیبایی',dir:'procedures'},{name:p.name,dir}],
    body:r=>`
<dl class="facts">
  <div><dt>نوع</dt><dd>${esc(kinds[p.kind]||p.kind)}</dd></div>
  <div><dt>ناحیه</dt><dd>${esc(region?.name||'')}</dd></div>
  <div><dt>ماندگاری</dt><dd>${esc(p.lasts)}</dd></div>
  <div><dt>دورهٔ نقاهت</dt><dd>${esc(p.recovery)}</dd></div>
</dl>
${p.variants?.length>1?`<h2>حالت‌ها</h2><p>در آینه می‌توانی بین ${p.variants.map(v=>`«${esc(v.name)}»`).join('، ')} جابه‌جا شوی و شدت را با یک لغزنده کم و زیاد کنی.</p>`:''}
<h2>در آینه چه می‌بینی</h2>
<p>دوربین را روشن کن یا یک عکس روبه‌رو انتخاب کن. ${esc(p.name)} روی صورت خودت اعمال می‌شود و با حرکت سر همراهت می‌آید. خط برنجی را روی صورت بکش تا قبل و بعد را کنار هم ببینی. جدول اندازه‌ها نشان می‌دهد پیش‌نمایش چه چیزی را چقدر عوض کرده است. با روشن کردن «ترکیب چند عمل با هم» می‌توانی چند عمل را با هم ببینی، و آرایش را هم روی صورت نگه داری.</p>
${p.note?`<p class="note">${esc(p.note)}</p>`:''}
${cta(`${r}#procedure=${p.id}`,`دیدن ${p.name} روی صورت خودم`)}
<p class="disclaimer">${NOT_MEDICAL}</p>
${related.length?`<h2>عمل‌های دیگر ${esc(region?.name||'')}</h2><ul class="links">${related.map(x=>`<li><a href="../${x.id}/">${esc(x.name)}</a></li>`).join('')}</ul>`:''}`}));
}
out.set('procedures/index.html',page({dir:'procedures',
  title:'شبیه‌سازی عمل‌های زیبایی روی صورت خودت | رُژا',
  description:`نتیجهٔ تقریبی ${fa.format(procedures.length)} عمل زیبایی، از جراحی بینی و فیلر لب تا لیفت صورت و بوتاکس، را زنده روی صورت خودت ببین. بدون ارسال تصویر.`,
  h1:'شبیه‌سازی عمل‌های زیبایی',
  lead:'پیش از مشاوره، تصویری تقریبی از تغییر شکل را روی صورت خودت ببین: زنده با دوربین یا روی یک عکس، و همه‌چیز روی همین دستگاه.',
  crumbs:[{name:'عمل‌های زیبایی',dir:'procedures'}],
  body:r=>`
${regions.map(region=>{
  const list=procedures.filter(p=>p.region===region.id);
  return list.length?`<h2>${esc(region.name)}</h2><ul class="cards">${list.map(p=>`<li><a href="${p.id}/"><strong>${esc(p.name)}</strong><span>${esc(p.summary)}</span></a></li>`).join('')}</ul>`:'';
}).join('\n')}
${cta(`${r}#procedure=${procedures[0].id}`,'باز کردن آینه')}
<p class="disclaimer">${NOT_MEDICAL}</p>`}));

/* ---- makeup ---- */
for(const item of products){
  const cat=categories.find(c=>c.id===item.category);
  const related=products.filter(x=>x.category===item.category&&x.id!==item.id);
  const dir=`makeup/${item.id}`;
  const shadeWord=item.palettes?'پالت':'رنگ';
  out.set(`${dir}/index.html`,page({dir,
    title:`امتحان آنلاین ${item.title} روی صورت خودت | رُژا`,
    description:`${item.title} را پیش از خرید روی صورت خودت امتحان کن: ${fa.format(item.shades.length)} ${shadeWord}، زنده با دوربین. ${item.description}`,
    h1:`امتحان ${item.title}`,
    lead:item.description,
    crumbs:[{name:'آرایش',dir:'makeup'},{name:item.name,dir}],
    body:r=>`
<dl class="facts">
  <div><dt>دسته</dt><dd>${esc(cat?.name||'')}</dd></div>
  <div><dt>جای استفاده</dt><dd>${esc(item.region)}</dd></div>
  <div><dt>پوشش</dt><dd>${esc(finishes[item.finish]?.name||'')}</dd></div>
  <div><dt>تعداد ${shadeWord}</dt><dd>${fa.format(item.shades.length)}</dd></div>
</dl>
<h2>${shadeWord}‌ها</h2>
<ul class="shades">${item.shades.map(s=>`<li><i style="background:${esc(s.colors?`linear-gradient(90deg,${s.colors.join(',')})`:s.color)}"></i>${esc(s.name)}</li>`).join('')}</ul>
${item.styles?.length?`<p>مدل‌ها: ${item.styles.map(s=>esc(s.name)).join('، ')}.</p>`:''}
<h2>در آینه چه می‌توانی بکنی</h2>
<p>${shadeWord} را عوض کن و همان لحظه روی صورتت ببین. شدت رنگ و محوشدن لبه را تنظیم کن، با براش پخش یا محوش کن، دو ${shadeWord} را کنار هم مقایسه کن یا تا چهار ${shadeWord} را در یک تصویر کنار هم بچین. با پیش‌نمایش نور می‌بینی زیر نور روز، مهتابی یا نور گرم مهمانی چطور دیده می‌شود.${item.finder?' «پیداکردن رنگ» از روی پوست گونه، پیشانی و چانه، نزدیک‌ترین رنگ را پیشنهاد می‌دهد.':''}</p>
${cta(`${r}#product=${item.id}`,`امتحان ${item.name} روی صورت خودم`)}
<p class="disclaimer">${esc(item.limitation)} ${COLOUR_NOTE}</p>
${related.length?`<h2>محصولات دیگر ${esc(cat?.name||'')}</h2><ul class="links">${related.map(x=>`<li><a href="../${x.id}/">${esc(x.name)}</a></li>`).join('')}</ul>`:''}`}));
}
out.set('makeup/index.html',page({dir:'makeup',
  title:'امتحان آنلاین آرایش روی صورت خودت | رُژا',
  description:`رژ لب، کرم‌پودر، سایه، خط چشم، ریمل و ${fa.format(products.length)} محصول دیگر را پیش از خرید، زنده روی صورت خودت امتحان کن. تصویر از گوشی‌ات بیرون نمی‌رود.`,
  h1:'امتحان آنلاین آرایش',
  lead:'هر محصول را با رنگ‌هایش روی صورت خودت ببین، پیش از اینکه بخری.',
  crumbs:[{name:'آرایش',dir:'makeup'}],
  body:r=>`
${categories.map(cat=>{
  const list=products.filter(p=>p.category===cat.id);
  return `<h2>${esc(cat.name)}</h2><ul class="cards">${list.map(p=>`<li><a href="${p.id}/"><strong>${esc(p.title)}</strong><span>${esc(p.description)}</span>
    <em class="dots">${p.shades.slice(0,8).map(s=>`<i style="background:${esc(s.color)}"></i>`).join('')}</em></a></li>`).join('')}</ul>`;
}).join('\n')}
${cta(r,'باز کردن آینه')}
<p class="disclaimer">${COLOUR_NOTE}</p>`}));

/* ---- questions ---- */
const faq=[
  ['آیا تصویر صورتم جایی فرستاده یا ذخیره می‌شود؟','نه. تصویر دوربین یا عکسی که انتخاب می‌کنی روی همین دستگاه پردازش می‌شود و هیچ‌جا فرستاده یا ذخیره نمی‌شود. فقط عکسی که خودت می‌گیری در همین صفحه نگه داشته می‌شود تا ذخیره یا ارسالش کنی.'],
  ['رنگی که در آینه می‌بینم دقیقاً رنگ محصول است؟','نه دقیقاً. رنگ‌ها نمونه‌ای روی صفحه‌اند. نور محیط، دوربین و رنگ طبیعی پوستت چیزی را که می‌بینی جابه‌جا می‌کنند. با «پیش‌نمایش نور» می‌توانی ببینی همان رنگ زیر نور روز، مهتابی یا نور گرم چطور دیده می‌شود.'],
  ['شبیه‌سازی عمل زیبایی نتیجهٔ واقعی را نشان می‌دهد؟','نه. پیش‌نمایش فقط تغییر شکل را تقریبی و تصویری نشان می‌دهد. تورم، بهبود، ضخامت پوست و کار هر جراح در آن نیست. برای تصمیم درمانی حتماً با پزشک متخصص مشورت کن.'],
  ['تحلیل پوست بیماری پوستی را تشخیص می‌دهد؟','نه. تحلیل پوست یک ارزیابی آرایشی و مراقبتی است: نوع پوست (فیتزپاتریک و باومن)، چند امتیاز و یک روتین صبح و شب. اگر جوش شدید، قرمزی پایدار یا خالی داری که تغییر می‌کند، پیش پزشک متخصص پوست برو.'],
  ['چرا دوربین روشن نمی‌شود؟','دوربین فقط روی HTTPS کار می‌کند و باید اجازهٔ دسترسی به آن را بدهی. مرورگرهای داخل اپ‌ها (اینستاگرام، تلگرام و…) معمولاً دوربین ندارند؛ صفحه را در Chrome یا Safari باز کن. اگر دوربین در دسترس نیست، می‌توانی یک عکس روبه‌رو انتخاب کنی.'],
  ['روی چه گوشی‌ها و مرورگرهایی کار می‌کند؟','Chrome، Edge، Firefox و Samsung Internet روی اندروید و کامپیوتر؛ Safari و Chrome روی آیفون و آیپد؛ و Safari روی مک. اپ اندروید رُژا هم آینه را روان‌تر اجرا می‌کند.'],
  ['بدون اینترنت هم کار می‌کند؟','بعد از اولین بار که دوربین روشن شود، مدل تشخیص صورت (حدود ۱۵ مگابایت) ذخیره می‌شود و اگر سایت را نصب کرده باشی، آینه بدون اینترنت هم کار می‌کند.'],
  ['رنگ کرم‌پودر مناسب پوستم را چطور پیدا کنم؟','در کرم‌پودر، کرم رنگی یا کانسیلر، «پیداکردن رنگ» را بزن. چند لحظه رنگ گونه، پیشانی و چانه‌ات خوانده می‌شود و نزدیک‌ترین رنگ، با تخمینی از زیرپوست، پیشنهاد می‌شود.'],
  ['چطور یک ترکیب آرایش را برای دوستم بفرستم؟','در «ترکیب فعلی روی صورت»، «فرستادن لینک» را بزن. هر کس لینک را باز کند، همان آرایش روی صورت خودش می‌نشیند. می‌توانی ترکیب را با یک اسم در «استایل‌های من» هم ذخیره کنی.'],
  ['محصولی را که پسندیدم از کجا بخرم؟','رُژا چیزی نمی‌فروشد. وقتی آینه را روی سایت یک فروشگاه باز می‌کنی، دکمهٔ خرید تو را به همان محصول یا محصولات مشابه در آن فروشگاه می‌برد و خرید، قیمت و ارسال با خود فروشگاه است.'],
  ['من فروشگاه دارم؛ می‌توانم این آینه را روی سایتم بگذارم؟','بله. صفحهٔ «رُژا برای فروشگاه‌ها» نشان می‌دهد آینه چطور با یک قطعه کد روی سایت شما می‌نشیند و دکمهٔ خرید به محصولات خودتان می‌رود.'],
  ['آرایشم بعد از بستن صفحه می‌ماند؟','بله. آرایش روی صورت و استایل‌های ذخیره‌شده روی همین دستگاه، در حافظهٔ مرورگر، نگه داشته می‌شوند و جایی فرستاده نمی‌شوند.']
];
out.set('faq/index.html',page({dir:'faq',
  title:'پرسش‌های رایج دربارهٔ آینهٔ رُژا | رُژا',
  description:'پاسخ پرسش‌های رایج دربارهٔ رُژا: حریم خصوصی تصویر، دقت رنگ‌ها، شبیه‌سازی عمل‌های زیبایی، تحلیل پوست، دوربین و خرید.',
  h1:'پرسش‌های رایج',
  crumbs:[{name:'پرسش‌ها',dir:'faq'}],
  jsonld:[{'@context':'https://schema.org','@type':'FAQPage',mainEntity:faq.map(([q,a])=>({'@type':'Question',name:q,acceptedAnswer:{'@type':'Answer',text:a}}))}],
  body:r=>`
${faq.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}
${cta(r,'باز کردن آینه')}`}));

/* ---- privacy ---- */
out.set('privacy/index.html',page({dir:'privacy',
  title:'حریم خصوصی | رُژا',
  description:'تصویر دوربین در رُژا روی همان دستگاه پردازش می‌شود و هیچ‌جا فرستاده یا ذخیره نمی‌شود. اینجا دقیقاً نوشته‌ایم چه چیزی کجا می‌ماند.',
  h1:'حریم خصوصی',
  lead:'کوتاهش این است: تصویر صورتت هرگز از دستگاهت بیرون نمی‌رود. اینجا دقیقاً نوشته‌ایم چه چیزی کجا می‌ماند.',
  crumbs:[{name:'حریم خصوصی',dir:'privacy'}],
  body:r=>`
<h2>تصویر دوربین و عکس‌ها</h2>
<p>تصویر دوربین، یا عکسی که انتخاب می‌کنی، روی همین دستگاه پردازش می‌شود و هیچ‌جا فرستاده یا ذخیره نمی‌شود. مدل تشخیص صورت هم از خود همین سایت بارگیری می‌شود و روی دستگاه اجرا می‌شود. تنها پیکسل‌هایی که خوانده می‌شوند همان‌هایی‌اند که خودت می‌خواهی: عکسی که می‌گیری (تا وقتی ذخیره یا ارسالش کنی در همین صفحه می‌ماند)، چند لکهٔ کوچک پوست هنگام پیداکردن رنگ کرم‌پودر که به یک رنگ میانگین تبدیل می‌شوند، و هنگام تحلیل پوست، تصویر صورت که روی همین صفحه به چند عدد تبدیل و رها می‌شود.</p>
<h2>آنچه روی دستگاه خودت می‌ماند</h2>
<p>آرایش روی صورت و استایل‌هایی که ذخیره می‌کنی، در حافظهٔ مرورگر همین دستگاه نگه داشته می‌شوند تا دفعهٔ بعد سر جایشان باشند. این‌ها جایی فرستاده نمی‌شوند و با پاک‌کردن داده‌های سایت در مرورگر پاک می‌شوند.</p>
<h2>لینک یک ترکیب آرایش</h2>
<p>وقتی لینک یک ترکیب را می‌فرستی، ترکیب در بخشی از نشانی است که بعد از # می‌آید و مرورگر آن را به سرور نمی‌فرستد.</p>
<h2>نتیجهٔ تحلیل پوست</h2>
<p>فقط اگر خودت تیک بزنی و ذخیره کنی، نتیجه (امتیازها و پاسخ‌ها، بدون هیچ تصویری، نام یا حساب کاربری) روی سرور نگه داشته می‌شود تا بتوانی چند هفته بعد با آن مقایسه کنی. یک کلید تصادفی که روی دستگاهت ساخته می‌شود نتیجه‌ها را نام‌گذاری می‌کند و روی سرور فقط هش آن ذخیره می‌شود. از همان صفحه می‌توانی همه را پاک کنی.</p>
<h2>آمار ناشناس</h2>
<p>برای اینکه بدانیم کدام رنگ‌ها و استایل‌ها بیشتر امتحان می‌شوند و کدام محصول بیشتر در فروشگاه باز می‌شود، فقط شمار روزانه ثبت می‌شود؛ مثلاً «رنگ نود صدفی امروز ۱۲ بار امتحان شد». هیچ شناسه، کوکی، نشانی IP یا ساعتی نگه داشته نمی‌شود و نمی‌شود از آن فهمید چه کسی چه چیزی را امتحان کرده است. از اپ اندروید آماری فرستاده نمی‌شود.</p>
<h2>خرید</h2>
<p>رُژا چیزی نمی‌فروشد. در آینه‌ای که روی سایت یک فروشگاه است، دکمهٔ خرید فقط نشانی آن فروشگاه را باز می‌کند یا به صفحهٔ همان فروشگاه خبر می‌دهد کدام محصول و رنگ را انتخاب کرده‌ای؛ تصویر صورت هیچ‌وقت همراهش نیست. هرچه بعد از آن پیش می‌آید، با فروشگاه است.</p>
<p>شمار ناشناس «کدام محصول در فروشگاه باز شد» هم مثل باقی آمار، فقط به‌صورت شمار روزانه ثبت می‌شود.</p>
${cta(r,'باز کردن آینه')}`}));

/* ---- for shops ---- */
// The mirror as something a shop puts on its own site: what it does for the shop, the
// code, the message a shop's cart can listen for, and who to ask.
const SNIPPET=`<iframe src="${SITE}?shop=YOUR-SHOP"
        allow="camera; clipboard-write; web-share; fullscreen"
        style="width:100%;height:760px;border:0;border-radius:16px"
        title="Roja makeup mirror"></iframe>`;
const LISTEN=`window.addEventListener('message', e => {
  if (e.origin !== '${SITE.replace(/\/$/,'')}' || e.data?.type !== 'roja:buy') return;
  // e.data.product  {id: 'velvet', name, type}   the product
  // e.data.shade    {id: 'vlv-8', name, color}    the shade, color as '#BF2928'
  // e.data.query    the words a search uses: product kind + shade name
  // e.data.url      that product's address in your shop
  addToCart(e.data);   // your own cart
});`;
const shadeCount=products.reduce((a,p)=>a+p.shades.length,0);
const wa=/^\d{8,15}$/.test(contact.whatsapp)?`https://wa.me/${contact.whatsapp}?text=${encodeURIComponent('سلام، دربارهٔ گذاشتن آینهٔ رُژا روی سایت فروشگاهمان سؤال دارم.')}`:'';
const tg=/^[A-Za-z]\w{3,31}$/.test(contact.telegram)?`https://t.me/${contact.telegram}`:'';
out.set('business/index.html',page({dir:'business',
  title:'آینهٔ امتحان آرایش برای سایت فروشگاه شما | رُژا',
  description:`آینهٔ زندهٔ رُژا را روی سایت فروشگاه آرایشی خودتان بگذارید: مشتری رژ، کرم‌پودر و سایه را پیش از خرید روی صورت خودش می‌بیند و دکمهٔ خرید به محصول شما می‌رود. بدون ارسال تصویر.`,
  h1:'آینهٔ رُژا، روی سایت فروشگاه شما',
  lead:'مشتری پیش از خرید، رنگ رژ، کرم‌پودر و سایه را زنده روی صورت خودش می‌بیند؛ و دکمهٔ خرید مستقیم به محصول در فروشگاه شما می‌رود.',
  crumbs:[{name:'برای فروشگاه‌ها',dir:'business'}],
  body:r=>`
<dl class="facts">
  <div><dt>محصول</dt><dd>${fa.format(products.length)} نوع، ${fa.format(shadeCount)} رنگ</dd></div>
  <div><dt>مراقبت پوست</dt><dd>تحلیل پوست و روتین با ${fa.format(skincare.length)} نوع محصول</dd></div>
  <div><dt>نصب</dt><dd>یک قطعه کد؛ بدون برنامه و بدون سرور</dd></div>
  <div><dt>حریم خصوصی</dt><dd>تصویر صورت از گوشی مشتری بیرون نمی‌رود</dd></div>
</dl>
<h2>برای فروشگاه چه فایده‌ای دارد</h2>
<ul class="benefits">
  <li><strong>تصمیم مطمئن‌تر</strong><span>بزرگ‌ترین تردید در خرید آنلاین آرایش، رنگ است. مشتری رنگ را روی صورت خودش می‌بیند، نه روی عکس یک مدل.</span></li>
  <li><strong>مرجوعی کمتر</strong><span>کرم‌پودر و کانسیلر با «پیدا کردن رنگ» از روی رنگ پوست خود مشتری پیشنهاد می‌شوند.</span></li>
  <li><strong>ماندن بیشتر در سایت</strong><span>استایل‌های آماده، مقایسهٔ دو رنگ کنار هم، براش و عکس گرفتن؛ و هر استایل با یک لینک برای دوست فرستاده می‌شود.</span></li>
  <li><strong>بدون دردسر حقوقی تصویر</strong><span>همهٔ پردازش روی دستگاه مشتری است؛ هیچ تصویری به سرور شما یا ما نمی‌رسد که نگه‌داری‌اش مسئولیت داشته باشد.</span></li>
</ul>
<h2>در عمل ببینید</h2>
<p>آینه را با یک «فروشگاه نمونه» باز کنید، رنگی را امتحان کنید و دکمهٔ خرید را بزنید؛ جایی که در سایت شما صفحهٔ محصول باز می‌شود، به همین صفحه برمی‌گردید.</p>
${cta(`${r}?shop=demo`,'باز کردن آینه با فروشگاه نمونه')}
<div class="note" id="buy-demo"><p><strong>اینجا صفحهٔ محصول شما بود.</strong> در سایت شما، دکمهٔ خرید به صفحهٔ همین محصول، یا جست‌وجوی همین نوع و رنگ، در فروشگاه خودتان می‌رود؛ یا محصول بی‌آنکه مشتری آینه را ترک کند، به سبد شما اضافه می‌شود.</p></div>
<h2>چطور روی سایت شما می‌نشیند</h2>
<ol class="steps">
  <li>نام فروشگاه و نشانی جست‌وجوی سایتتان را می‌گیریم، یا اگر بخواهید، نشانی صفحهٔ محصول برای هر رنگ؛ و فروشگاه شما با یک شناسه به آینه اضافه می‌شود.</li>
  <li>این کد را در هر صفحه‌ای که می‌خواهید می‌گذارید (به جای <code dir="ltr">YOUR-SHOP</code>، شناسهٔ فروشگاه شما):</li>
</ol>
<pre dir="ltr"><code>${esc(SNIPPET)}</code></pre>
<p>یا فقط یک لینک: <code dir="ltr">${SITE}?shop=YOUR-SHOP</code>؛ برای دکمه‌ای در منو، بنر یا صفحهٔ هر محصول، با <code dir="ltr">#product=velvet</code> برای باز شدن روی همان محصول.</p>
<h3>محصول، مستقیم در سبد شما</h3>
<p>اگر بخواهید مشتری از آینه بیرون نرود، صفحهٔ شما به پیام <code dir="ltr">roja:buy</code> گوش می‌دهد و محصول را خودش به سبد اضافه می‌کند. پیام فقط به نشانی سایت شما فرستاده می‌شود و تصویری همراهش نیست:</p>
<pre dir="ltr"><code>${esc(LISTEN)}</code></pre>
<h2>با محصولات خود شما</h2>
<p>رنگ‌های فعلی آینه نمونه‌اند. می‌توانیم رنگ‌های محصولات خودتان را، با نام و صفحهٔ هرکدام، به آینهٔ فروشگاهتان اضافه کنیم تا مشتری دقیقاً همان چیزی را امتحان کند که می‌خرد. گزارش ناشناس روزانه هم می‌گیرید: کدام رنگ‌ها بیشتر امتحان شده‌اند و کدام محصول از آینه در فروشگاه باز شده است.</p>
<h2>گفت‌وگو</h2>
<p>برای راه‌اندازی، قیمت، یا دیدن آینه با محصولات خودتان، پیام بدهید:</p>
<p class="cta contact">${wa?`<a class="button" href="${wa}" rel="noopener">واتس‌اپ</a>`:''} ${tg?`<a class="button ghost" href="${tg}" rel="noopener">تلگرام</a>`:''}</p>
<p class="disclaimer">${COLOUR_NOTE} پیش‌نمایش عمل‌های زیبایی و تحلیل پوست هم در آینه هست و می‌تواند روی سایت شما روشن یا خاموش باشد.</p>`}));

/* ---- sitemap, robots ---- */
const urls=['',...[...out.keys()].map(k=>k.replace(/index\.html$/,''))];
out.set('sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u=>`  <url><loc>${SITE}${u}</loc></url>`).join('\n')}
</urlset>
`);
out.set('robots.txt',`User-agent: *
Disallow: /api/
Disallow: /stats.html

Sitemap: ${SITE}sitemap.xml
`);

/* ---- write, or check ---- */
let stale=[];
for(const [rel,content] of out){
  const file=path.join(root,rel);
  const old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  if(old===content)continue;
  if(check){stale.push(rel);continue;}
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,content);
  console.log('wrote',rel);
}
if(check){
  if(stale.length){console.error(`out of date (run node tools/build-pages.mjs):\n  ${stale.join('\n  ')}`);process.exit(1);}
  console.log(`${out.size} pages up to date`);
}
