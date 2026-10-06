// The skin check: a few questions and, if there is one, a measurement of the bare face
// (skin-scan.js), turned into a skin profile and a morning and evening routine from
// Roja's sample skincare range.
//
// Two classifications are given, each as an estimate with a confidence:
// - Fitzpatrick phototype (I–VI) is defined by how skin answers the sun, so the burn
//   and tan question carries it; skin colour from the camera only nudges it.
// - Baumann skin type: four axes, oily/dry, sensitive/resistant, pigmented/non-pigmented
//   and wrinkled/tight, 16 types in all. The questionnaire is the instrument the system
//   was built on; the camera adds what a picture can show (shine, redness, spots, lines)
//   and says nothing about sensitivity on its own.
// Type is not the whole story: two people of one type can need different care, so the
// routine follows concern scores (0–100), not the four letters.
//
// This is cosmetic guidance. It does not diagnose a skin disease and says so.

export const questions=[
  {id:'oil',text:'بعد از شستن صورت و بدون زدن کرم، یکی دو ساعت بعد پوستت چه حالتی دارد؟',options:[
    ['-1','خیلی کشیده و خشک'],['-0.5','کمی خشک'],['0','معمولی'],['0.5','کمی چرب، بیشتر در پیشانی و بینی'],['1','چرب و براق در همه‌جا']]},
  {id:'sens',text:'محصولات پوستی معمولاً باعث سوزش، خارش یا قرمزی پوستت می‌شوند؟',options:[
    ['1','تقریباً همیشه'],['0.4','گاهی'],['-0.4','به‌ندرت'],['-1','تقریباً هیچ‌وقت']]},
  {id:'pig',text:'بعد از جوش، زخم یا التهاب، جای تیره روی پوستت می‌ماند؟',options:[
    ['1','بله، و هفته‌ها می‌ماند'],['0.4','گاهی'],['-0.4','به‌ندرت'],['-1','نه']]},
  {id:'lines',text:'وقتی صورتت آرام است، خط‌های ظریف یا چروک دیده می‌شود؟',options:[
    ['1','بله، به‌وضوح'],['0.3','چند خط کم‌رنگ'],['-0.3','فقط وقتی می‌خندم یا اخم می‌کنم'],['-1','نه']]},
  {id:'sun',text:'معمولاً چقدر زیر آفتاب هستی؟',options:[
    ['0','بیشتر در فضای بسته'],['0.5','روزی کمتر از یک ساعت بیرون'],['1','ساعت‌ها در بیرون']]},
  {id:'burn',text:'وقتی بدون ضدآفتاب مدتی در آفتاب تابستان می‌مانی، چه می‌شود؟',options:[
    ['1','همیشه می‌سوزم و برنزه نمی‌شوم'],['2','معمولاً می‌سوزم و کمی برنزه می‌شوم'],['3','گاهی کمی می‌سوزم و کم‌کم برنزه می‌شوم'],
    ['4','به‌ندرت می‌سوزم و راحت برنزه می‌شوم'],['5','تقریباً هیچ‌وقت نمی‌سوزم و زود تیره می‌شوم'],['6','هرگز نمی‌سوزم؛ پوستم خیلی تیره است'],['','نمی‌دانم']]},
  {id:'concern',text:'مهم‌ترین دغدغه‌ات دربارهٔ پوستت چیست؟',options:[
    ['acne','جوش'],['pigment','لک و تیرگی'],['dry','خشکی'],['red','قرمزی'],['aging','خط و چروک'],['pores','منافذ باز'],['texture','ناصافی بافت'],['prevent','فقط مراقبت و پیشگیری']]},
  {id:'using',multi:true,text:'الان از کدام‌ها استفاده می‌کنی؟',options:[
    ['cleanser','شوینده'],['moisturizer','مرطوب‌کننده'],['sunscreen','ضدآفتاب'],['vitc','ویتامین C'],['niacinamide','نیاسینامید'],
    ['retinoid','رتینوئید'],['acids','اسید (AHA/BHA)'],['azelaic','آزلائیک اسید']]},
  {id:'irritants',multi:true,text:'پوستت به کدام‌ها حساس است یا با آن‌ها تحریک می‌شود؟',options:[
    ['fragrance','عطر'],['acids','اسیدها'],['retinoid','رتینوئیدها'],['alcohol','الکل']]},
  {id:'age',text:'سن',options:[['u20','زیر ۲۰'],['20','۲۰ تا ۲۹'],['30','۳۰ تا ۳۹'],['40','۴۰ تا ۴۹'],['50','۵۰ و بالاتر']]},
  {id:'pregnant',text:'باردار هستی یا شیر می‌دهی؟',help:'بعضی مواد، مثل رتینوئیدها، در این دوره توصیه نمی‌شوند.',options:[['no','نه'],['yes','بله']]}
];
export const requiredQuestions=questions.filter(q=>!q.multi).map(q=>q.id);

// The kinds of skincare product a routine is made of. Each is searched for by its name
// on the partner store (partner.js); every one meant here is fragrance-free and has no
// drying alcohol.
const product=(id,name,size,color,extra)=>({id,name,kind:'skincare',
  shades:[{id:`${id}-1`,variantId:'1',name:size,color}],...extra});
export const skincare=[
  product('cleanser-gel','ژل شست‌وشوی ملایم','۲۰۰ میلی‌لیتر','#CFE6E8',{step:'cleanser',does:'بدون خشک‌کردن، چربی و آلودگی را می‌شوید.'}),
  product('cleanser-cream','کرم شست‌وشوی بدون کف','۲۰۰ میلی‌لیتر','#F1E6D8',{step:'cleanser',does:'پوست را بدون کشیدگی تمیز می‌کند و سد پوستی را حفظ می‌کند.'}),
  product('niacinamide','سرم نیاسینامید ۵٪','۳۰ میلی‌لیتر','#E9E2F5',{step:'treatment',does:'چربی و نمای منافذ را کم می‌کند، لک را کم‌رنگ‌تر و سد پوستی را قوی‌تر می‌کند.'}),
  product('vitamin-c','سرم ویتامین C پایدار','۳۰ میلی‌لیتر','#F7D58B',{step:'treatment',does:'آنتی‌اکسیدان؛ کنار ضدآفتاب، پوست را روشن‌تر و یکدست‌تر می‌کند.'}),
  product('bha','لوسیون سالیسیلیک اسید ۲٪','۱۰۰ میلی‌لیتر','#D6EBD2',{step:'treatment',does:'داخل منافذ را تمیز می‌کند و جوش و جوش سرسیاه را کم می‌کند.'}),
  product('azelaic','کرم آزلائیک اسید ۱۰٪','۳۰ میلی‌لیتر','#F3E3E7',{step:'treatment',does:'لک بعد از جوش، قرمزی و جوش را کم می‌کند و برای پوست حساس هم مناسب است.'}),
  product('retinal','سرم رتینال ۰٫۰۵٪','۳۰ میلی‌لیتر','#F4C9A0',{step:'treatment',does:'نوسازی پوست؛ خط‌های ظریف، ناصافی بافت و جوش را به‌مرور کم می‌کند.'}),
  product('hyaluronic','سرم هیالورونیک اسید','۳۰ میلی‌لیتر','#D4E4F7',{step:'hydration',does:'آب‌رسانی بدون سنگینی.'}),
  product('gel-cream','ژل‌کرم آبرسان سبک','۵۰ میلی‌لیتر','#DDF0EC',{step:'moisturizer',does:'رطوبت بدون براقی برای پوست چرب و مختلط.'}),
  product('ceramide','کرم سرامید ترمیم‌کننده','۵۰ میلی‌لیتر','#F2EBDD',{step:'moisturizer',does:'سد پوستی را ترمیم می‌کند و جلوی خشکی و تحریک را می‌گیرد.'}),
  product('spf-fluid','فلوئید ضدآفتاب SPF 50','۵۰ میلی‌لیتر','#FBEFD9',{step:'sunscreen',does:'محافظت گسترده از UVA و UVB، سبک و بی‌رنگ.'}),
  product('spf-tinted','ضدآفتاب رنگی مینرال SPF 50','۵۰ میلی‌لیتر','#D9A982',{step:'sunscreen',does:'فیلتر مینرال ملایم؛ اکسید آهنِ رنگ آن، جلوی نور مرئی را هم که لک را تیره‌تر می‌کند می‌گیرد.'})
];
export const skincareById=id=>skincare.find(p=>p.id===id);

export const concernNames={
  oiliness:'چربی',dryness:'خشکی',sensitivity:'حساسیت',redness:'قرمزی',acne:'جوش',
  pigmentation:'لک و ناهمرنگی',aging:'خط و چروک',texture:'منافذ و بافت',underEye:'تیرگی زیر چشم'
};
export const axes=[
  {id:'od',pos:'O',neg:'D',posName:'چرب',negName:'خشک'},
  {id:'sr',pos:'S',neg:'R',posName:'حساس',negName:'مقاوم'},
  {id:'pn',pos:'P',neg:'N',posName:'مستعد لک',negName:'بدون تمایل به لک'},
  {id:'wt',pos:'W',neg:'T',posName:'چروک‌پذیر',negName:'سفت'}
];
export const fitzNames=['','I','II','III','IV','V','VI'];

const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const ramp=(v,lo,hi)=>Number.isFinite(v)?clamp((v-lo)/(hi-lo),0,1)*100:NaN;
const blend=parts=>{        // [[value, weight]…], skipping values that are missing
  let s=0,w=0;for(const [v,k] of parts)if(Number.isFinite(v)){s+=v*k;w+=k;}
  return w?s/w:NaN;
};

// Several scans of the same face, one profile: the median of each number.
export function combineScans(scans){
  const good=scans.filter(Boolean);
  if(!good.length)return null;
  const med=list=>{const v=list.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[v.length>>1]:NaN;};
  const metrics={};
  for(const key of Object.keys(good[0].metrics))metrics[key]=med(good.map(s=>s.metrics[key]));
  const tone={};
  for(const key of ['L','a','b','ita','hue','chroma'])tone[key]=med(good.map(s=>s.tone[key]));
  tone.hex=good[good.length>>1].tone.hex;
  // Each quality check passes if it passed in most of the scans.
  const checks={};
  for(const {id} of good[0].quality)checks[id]=good.filter(s=>s.quality.find(q=>q.id===id)?.ok).length*2>good.length;
  return {metrics,tone,checks,samples:good.length,quality:Object.values(checks).every(Boolean)};
}

// What the picture shows, 0–100, on the scanner's fixed scale; it describes this camera
// picture, not a clinical grading. A measure is left out when the picture could not
// carry it: fine detail needs a near, sharp, frontal face; colour needs plain light.
export function imageScores(scan){
  if(!scan)return null;
  const m=scan.metrics,ok=scan.checks||{};
  const pass=(...ids)=>ids.every(id=>ok[id]!==false);
  const detail=pass('size','sharp','pose'),colour=pass('light','colour');
  const keep=(on,v)=>on?v:NaN;
  return {
    oil:keep(pass('light','pose'),ramp(m.shineT,.004,.05)),
    red:keep(colour,blend([[ramp(m.redness,9,22),.6],[ramp(m.redPatches,.02,.22),.4]])),
    acne:keep(detail&&colour,ramp(m.redSpots,.012,.07)),
    pigment:keep(detail&&colour&&pass('even'),blend([[ramp(m.darkSpots,.012,.08),.5],[ramp(m.uneven,.9,3),.5]])),
    texture:keep(detail,ramp(m.texture,.7,2.1)),
    lines:keep(detail,blend([[ramp(m.foreheadLines,.03,.35),.4],[ramp(m.crowLines,.5,1.8),.3],[ramp(m.underEyeLines,.5,1.8),.3]])),
    underEye:keep(colour&&pass('even'),ramp(m.underEyeDark,2,12))
  };
}

// Fitzpatrick from skin colour alone, by Individual Typology Angle (Chardon 1991).
export function fitzFromIta(ita){
  if(!Number.isFinite(ita))return null;
  return ita>55?1:ita>41?2:ita>28?3:ita>10?4:ita>-30?5:6;
}

const AGE={u20:-1,'20':-.6,'30':0,'40':.5,'50':1};
const BONUS={acne:'acne',pigment:'pigmentation',dry:'dryness',red:'redness',aging:'aging',pores:'texture',texture:'texture'};

export function assess({answers,scan}){
  const num=id=>answers[id]===''||answers[id]==null?NaN:Number(answers[id]);
  const img=imageScores(scan);
  const toAxis=v=>Number.isFinite(v)?v/50-1:NaN;          // 0..100 → -1..1
  const irritated=(answers.irritants||[]).length>0;
  const sun=num('sun'),age=AGE[answers.age]??NaN;

  // Fitzpatrick: the sun answer is the definition; the camera's colour a nudge.
  const fromSun=num('burn'),fromColour=scan&&scan.checks?.light!==false&&scan.checks?.colour!==false?fitzFromIta(scan.tone.ita):null;
  let fitz;
  if(Number.isFinite(fromSun)&&fromColour){
    fitz={type:clamp(Math.round(fromSun*.75+fromColour*.25),1,6),conf:clamp(86-Math.abs(fromSun-fromColour)*12,45,90),from:'both'};
  }else if(Number.isFinite(fromSun))fitz={type:fromSun,conf:72,from:'answers'};
  else if(fromColour)fitz={type:fromColour,conf:42,from:'image'};
  else fitz=null;

  // The four Baumann axes, each -1..1 (positive is the first letter), and how sure.
  const parts={
    od:{q:num('oil'),img:img?toAxis(img.oil):NaN,qw:.7,iw:.3},
    sr:{q:clamp(num('sens')+(irritated?.3:0),-1,1),img:img?toAxis(img.red):NaN,qw:.85,iw:.15},
    pn:{q:blend([[num('pig'),.8],[fitz?(fitz.type-3.5)/2.5:NaN,.2]]),img:img?toAxis(img.pigment):NaN,qw:.75,iw:.25},
    wt:{q:blend([[num('lines'),.55],[age,.3],[Number.isFinite(sun)?sun*2-1:NaN,.15]]),img:img?toAxis(img.lines):NaN,qw:.75,iw:.25}
  };
  const axisResult={};
  let code='';
  for(const axis of axes){
    const {q,img:i,qw,iw}=parts[axis.id];
    const v=blend([[q,qw],[i,iw]]);
    let conf=55+35*Math.abs(Number.isFinite(v)?v:0);
    if(Number.isFinite(q)&&Number.isFinite(i)&&Math.abs(i)>.2)conf+=Math.sign(q)===Math.sign(i)?8:-12;
    if(!Number.isFinite(i))conf-=5;
    if(axis.id==='sr')conf=Math.min(conf,82);                // a picture cannot measure sensitivity
    const value=Number.isFinite(v)?v:0;
    axisResult[axis.id]={value:+value.toFixed(3),conf:Math.round(clamp(conf,40,93)),letter:value>=0?axis.pos:axis.neg};
    code+=axisResult[axis.id].letter;
  }

  // Concerns, 0–100: what the user reports and what the picture shows.
  const fromAnswer=v=>Number.isFinite(v)?(v+1)*50:NaN;
  const c={
    oiliness:blend([[fromAnswer(num('oil')),.65],[img?.oil,.35]]),
    dryness:blend([[fromAnswer(-num('oil')),.75],[img?100-img.oil:NaN,.25]]),
    sensitivity:blend([[fromAnswer(num('sens')),.8],[irritated?100:20,.2]]),
    // Redness, spots, texture and the eye area are seen, not asked: no picture, no score.
    redness:Number.isFinite(img?.red)?blend([[img.red,.7],[fromAnswer(num('sens')),.3]]):NaN,
    acne:Number.isFinite(img?.acne)?blend([[img.acne,.75],[fromAnswer(num('oil')),.25]]):NaN,
    pigmentation:blend([[img?.pigment,.55],[fromAnswer(num('pig')),.45]]),
    aging:blend([[img?.lines,.4],[fromAnswer(num('lines')),.35],[fromAnswer(age),.25]]),
    texture:Number.isFinite(img?.texture)?blend([[img.texture,.7],[fromAnswer(num('oil')),.3]]):NaN,
    underEye:img?img.underEye:NaN
  };
  // The worry the user names counts, measured or not.
  const bonus=BONUS[answers.concern];
  if(bonus)c[bonus]=Number.isFinite(c[bonus])?Math.max(c[bonus]+20,45):60;
  const concerns={};
  for(const [k,v] of Object.entries(c))if(Number.isFinite(v))concerns[k]=Math.round(clamp(v,0,100));

  const profile={version:1,fitz,baumann:{code,axes:axisResult},concerns,
    image:img?Object.fromEntries(Object.entries(img).filter(([,v])=>Number.isFinite(v)).map(([k,v])=>[k,Math.round(v)])):null,
    tone:scan?{hex:scan.tone.hex,ita:Math.round(scan.tone.ita)}:null,
    imageQuality:scan?scan.quality:null};
  return {...profile,priorities:priorities(profile,answers),routine:routine(profile,answers)};
}

const PRIORITY={
  acne:'پیشگیری از جوش',pigmentation:'کم‌رنگ‌کردن لک و جلوگیری از لک تازه',redness:'آرام‌کردن قرمزی',
  sensitivity:'محافظت از سد پوستی',dryness:'آب‌رسانی و ترمیم سد پوستی',oiliness:'کنترل چربی',
  aging:'پیشگیری و کم‌کردن خط‌های ظریف',texture:'صاف‌ترکردن بافت و منافذ',underEye:'مراقبت از دور چشم'
};
export function priorities(profile){
  const list=['محافظت هرروزه از آفتاب'];
  for(const [k,v] of Object.entries(profile.concerns).sort((a,b)=>b[1]-a[1]))
    if(v>=45&&k!=='underEye'&&list.length<4)list.push(PRIORITY[k]);
  return list;
}

// The routine: a cleanser, at most two actives (one for sensitive skin), a moisturizer
// and, in the morning, sunscreen. Each step says why it is there.
export function routine(profile,answers){
  const c=profile.concerns,ax=profile.baumann.axes;
  const has=k=>(c[k]??0);
  const irritant=new Set(answers.irritants||[]);
  const pregnant=answers.pregnant==='yes';
  const oily=ax.od.letter==='O',sensitive=ax.sr.letter==='S'&&has('sensitivity')>=55;
  const step=(id,why,note='')=>({product:skincareById(id),why,note});

  const cleanser=oily&&!sensitive?step('cleanser-gel','پوستت به سمت چربی است؛ یک شویندهٔ ژلی ملایم چربی را بدون خشک‌کردن می‌برد.')
    :step('cleanser-cream',sensitive?'پوستت حساس است؛ شویندهٔ بدون کف کمترین آسیب را به سد پوستی می‌زند.':'پوستت به سمت خشکی است؛ شویندهٔ کرمی رطوبتش را نمی‌گیرد.');
  const moisturizer=oily&&!sensitive?step('gel-cream','رطوبت لازم بدون براقی و سنگینی.')
    :step('ceramide',sensitive?'سرامید سد پوستی را ترمیم می‌کند و تحمل پوست را برای مواد فعال بالا می‌برد.':'پوست خشک به لیپیدهای سد پوستی نیاز دارد.');
  const tinted=has('pigmentation')>=45||sensitive;
  const sunscreen=step(tinted?'spf-tinted':'spf-fluid',
    has('pigmentation')>=45?'مهم‌ترین قدم برای لک: بدون ضدآفتاب هیچ درمان لکی جواب نمی‌دهد. رنگ آن جلوی نور مرئی را هم می‌گیرد.'
      :sensitive?'فیلتر مینرال برای پوست حساس ملایم‌تر است.':'هر روز، حتی در خانه و روزهای ابری؛ مهم‌ترین قدم برای پیشگیری از لک و چروک.',
    'به اندازهٔ دو بند انگشت برای صورت و گردن؛ هر دو ساعت در بیرون تمدید شود.');

  // Night actives, in order of need.
  const night=[];
  const add=(id,why,note)=>{if(!night.some(s=>s.product.id===id))night.push(step(id,why,note));};
  const wants=[
    ['acne',45,()=>irritant.has('acids')?add('azelaic','برای جوش؛ چون اسیدها پوستت را تحریک می‌کنند، آزلائیک اسید ملایم‌تر است.','شب‌ها، یک لایهٔ نازک.')
      :add('bha','برای جوش و منافذ: سالیسیلیک اسید داخل منافذ را تمیز می‌کند.','شب‌ها، هفته‌ای ۳ بار شروع کن.')],
    ['pigmentation',45,()=>add('azelaic','برای لک و جای جوش؛ در بارداری هم قابل استفاده است.','شب‌ها، یک لایهٔ نازک.')],
    ['aging',45,()=>{
      if(pregnant)return;
      if(irritant.has('retinoid'))return;
      add('retinal','برای خط‌های ظریف و بافت: رتینوئیدها شناخته‌شده‌ترین مادهٔ ضدپیری‌اند.',
        sensitive?'هفته‌ای ۲ شب شروع کن و کم‌کم بیشتر کن؛ با سوزش شدید قطع کن.':'هفته‌ای ۲ تا ۳ شب شروع کن و کم‌کم هر شب.');}],
    ['redness',50,()=>add('azelaic','قرمزی را آرام می‌کند.','شب‌ها، یک لایهٔ نازک.')],
    ['texture',55,()=>irritant.has('acids')?null:add('bha','منافذ و ناصافی بافت را بهتر می‌کند.','شب‌ها، هفته‌ای ۲ تا ۳ بار.')]
  ].filter(([k,min])=>has(k)>=min).sort((a,b)=>has(b[0])-has(a[0]));
  for(const [,,run] of wants){if(night.length>=(sensitive?1:2))break;run();}
  if(night.some(s=>s.product.id==='bha')&&night.some(s=>s.product.id==='retinal'))
    for(const s of night)if(s.product.id==='bha'||s.product.id==='retinal')s.note='یک شب در میان: یک شب سالیسیلیک اسید، شب بعد رتینال؛ هرگز با هم.';

  // Morning active.
  let morning=null;
  if(has('pigmentation')>=45||has('aging')>=45)
    morning=sensitive?step('niacinamide','لک را کم‌رنگ‌تر و سد پوستی را قوی‌تر می‌کند و پوست حساس آن را خوب تحمل می‌کند.')
      :step('vitamin-c','آنتی‌اکسیدان؛ کنار ضدآفتاب در برابر لک و پیری پوست بیشتر محافظت می‌کند.');
  else if(has('oiliness')>=55||has('texture')>=55||has('redness')>=45)
    morning=step('niacinamide','چربی، نمای منافذ و قرمزی را کم می‌کند.');
  const hydration=has('dryness')>=55?step('hyaluronic','پوستت کم‌آب است؛ پیش از مرطوب‌کننده روی پوست کمی مرطوب بزن.'):null;

  const notes=[];
  if(pregnant)notes.push('در بارداری و شیردهی رتینوئیدها پیشنهاد نشده‌اند. پیش از شروع هر محصول جدید با پزشکت مشورت کن.');
  if(night.length)notes.push('هر محصول تازه را اول چند شب پشت گوش یا زیر فک امتحان کن. اگر سوزش، قرمزی یا پوسته‌پوسته شدن ماند، مصرفش را کم یا قطع کن.');
  notes.push('نتیجهٔ لک و چروک معمولاً بعد از ۸ تا ۱۲ هفته مصرف منظم دیده می‌شود.');

  return {
    morning:[cleanser,morning,hydration,moisturizer,sunscreen].filter(Boolean),
    evening:[cleanser,...night,hydration,moisturizer].filter(Boolean),
    notes
  };
}

// What a saved check keeps: the profile and the answers, never a picture.
export function record(result,answers){
  return {
    version:1,fitz:result.fitz?{type:result.fitz.type,conf:result.fitz.conf,from:result.fitz.from}:null,
    baumann:result.baumann.code,
    axes:Object.fromEntries(Object.entries(result.baumann.axes).map(([k,v])=>[k,{value:v.value,conf:v.conf}])),
    concerns:result.concerns,image:result.image,tone:result.tone,imageQuality:result.imageQuality,
    answers:Object.fromEntries(questions.map(q=>[q.id,q.multi?[...(answers[q.id]||[])]:(answers[q.id]??null)]))
  };
}
