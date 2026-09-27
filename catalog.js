// Roja's own sample range. These are the shop's shades, not another brand's, so
// nothing here reproduces a third party's names, codes, photographs or colours.
//
// The hex values are the colours the mirror paints. A screen preview is not a
// measured match for a finished product: ambient light, camera white balance and
// natural skin tone all move the result. Prices are sample prices for the demo cart.
//
// `type` is the layer a product paints. One product per type is on the face at a
// time; types are painted in `layerOrder`, so a gloss sits on top of a lipstick and a
// blush on top of foundation. `mode` picks how the colour meets the skin (see the
// layer shader in stage.js) and `finish` how light plays on it.

const range=(prefix,entries)=>entries.map(([name,color,extra],i)=>({
  id:`${prefix}-${i+1}`, variantId:String(i+1), name, color, ...(extra||{})
}));

export const categories=[
  {id:'face',name:'صورت',hint:'پوست، گونه، کانتور'},
  {id:'eyes',name:'چشم و ابرو',hint:'سایه، خط چشم، ریمل'},
  {id:'lips',name:'لب',hint:'رژ، مداد، برق لب'}
];

export const layerOrder=['foundation','concealer','contour','blush','highlighter','eyeshadow','eyeliner','mascara','brow','lipliner','lipstick','gloss'];

export const finishes={
  matte:   {name:'مات'},
  velvet:  {name:'مخملی'},
  satin:   {name:'ساتن'},
  cream:   {name:'کرمی'},
  gloss:   {name:'براق'},
  shimmer: {name:'شاین'},
  metallic:{name:'متالیک'},
  natural: {name:'طبیعی'},
  dewy:    {name:'درخشان'}
};

const pans=['روشن','میانی','تیره','تأکید'];
const palettes=[
  {id:'1',label:'خاک رس',   colors:['#D9BFA4','#C08E6E','#6B4530','#B57553']},
  {id:'2',label:'گل سرخ',   colors:['#E6C3BC','#C98793','#71374B','#B8606E']},
  {id:'3',label:'دود و نقره',colors:['#D2CDD0','#8F8A94','#3A3740','#6E6A75']},
  {id:'4',label:'شب آبی',   colors:['#D5DCE4','#7E93AE','#2F4257','#536C8C']},
  {id:'5',label:'خزه',      colors:['#DCDCC0','#98AE84','#3F5B44','#8A8452']}
];

export const products=[
  /* ---- face ---- */
  {id:'foundation', type:'foundation', category:'face', mode:'foundation', finish:'matte',
   name:'کرم‌پودر مات', title:'کرم‌پودر مات با پوشش قابل‌تنظیم', region:'پوست', code:'ROJA / FND',
   intensity:45, fade:60, price:1450000, finder:true,
   description:'۱۳ رنگ با زیرته‌ی گرم، خنثی و سرد. شدت را کم کن برای پوشش سبک، زیاد کن برای پوشش کامل.',
   limitation:'پوشاندن لک و جوش واقعی و ماندگاری روی پوست چرب در پیش‌نمایش دیده نمی‌شود.',
   shades:range('fnd',[
     ['۱۰۰ عاجی سرد','#F2D8C9',{tone:'C'}],['۱۱۰ عاجی','#EFD3B8',{tone:'N'}],['۱۲۰ صدفی گرم','#EACDA8',{tone:'W'}],
     ['۱۳۰ بژ صورتی','#E2BCA5',{tone:'C'}],['۱۴۰ بژ روشن','#E0B994',{tone:'N'}],['۱۵۰ بژ طلایی','#D9B083',{tone:'W'}],
     ['۱۶۰ بژ طبیعی','#D1A585',{tone:'N'}],['۱۷۰ عسلی','#C99B72',{tone:'W'}],['۱۸۰ گندمی','#BD8D6A',{tone:'N'}],
     ['۱۹۰ کاراملی','#AE7C58',{tone:'W'}],['۲۰۰ برنزه','#9A6A4B',{tone:'N'}],['۲۱۰ کاکائویی','#7F5439',{tone:'W'}],
     ['۲۲۰ قهوه‌ای تیره','#5E3D2C',{tone:'N'}]])},

  {id:'tint', type:'foundation', category:'face', mode:'foundation', finish:'dewy',
   name:'کرم رنگی سبک', title:'کرم رنگی سبک با جلوهٔ درخشان', region:'پوست', code:'ROJA / TNT',
   intensity:32, fade:65, price:980000, finder:true,
   description:'پوشش سبک و طبیعی با ۸ رنگ؛ بافت پوست دیده می‌شود.',
   limitation:'جلوهٔ درخشان روی پوست چرب بیشتر از پیش‌نمایش است.',
   shades:range('tnt',[
     ['روشن سرد','#EDD2C0',{tone:'C'}],['روشن','#E8C8AC',{tone:'N'}],['روشن گرم','#E3C19C',{tone:'W'}],
     ['متوسط صورتی','#D6AE95',{tone:'C'}],['متوسط','#CFA482',{tone:'N'}],['متوسط گرم','#C69A70',{tone:'W'}],
     ['گندمی','#B08160',{tone:'N'}],['تیره','#8A5E42',{tone:'W'}]])},

  {id:'concealer', type:'concealer', category:'face', mode:'foundation', finish:'natural',
   name:'کانسیلر', title:'کانسیلر زیر چشم', region:'زیر چشم', code:'ROJA / CNC',
   intensity:45, fade:70, price:760000, finder:true, lighter:true,
   description:'۸ رنگ، کمی روشن‌تر از پوست، برای روشن‌کردن گودی و تیرگی زیر چشم.',
   limitation:'تیرگی‌های عمیق زیر چشم معمولاً به لایهٔ اصلاح‌کنندهٔ رنگ هم نیاز دارند.',
   shades:range('cnc',[
     ['صدفی روشن','#F4DCC8',{tone:'N'}],['عاجی','#EFD2B6',{tone:'N'}],['هلویی روشن','#EEC9A8',{tone:'W'}],
     ['بژ','#E1BC98',{tone:'N'}],['هلویی','#DDB08A',{tone:'W'}],['عسلی','#CFA27A',{tone:'W'}],
     ['کاراملی','#B88A63',{tone:'W'}],['هلویی تیره','#A27250',{tone:'W'}]])},

  {id:'contour', type:'contour', category:'face', mode:'shade', finish:'matte',
   name:'کانتور', title:'پودر کانتور مات', region:'زیر گونه و کنار بینی', code:'ROJA / CTR',
   intensity:35, fade:70, price:820000,
   description:'۵ رنگ سرد تا گرم برای سایه‌انداختن زیر استخوان گونه، شقیقه و کنار بینی.',
   limitation:'جای دقیق کانتور به فرم استخوان صورت بستگی دارد؛ با ابزار براش جابه‌جایش کن.',
   shades:range('ctr',[
     ['خاکستری سرد','#9C8175'],['قهوه‌ای خنثی','#8E6E5E'],['تافی','#946A52'],['قهوه‌ای گرم','#7C5845'],['اسپرسو','#5C4033']])},

  {id:'powder-blush', type:'blush', category:'face', mode:'tint', finish:'matte',
   name:'رژگونهٔ پودری', title:'رژگونهٔ پودری', region:'گونه', code:'ROJA / PWD',
   intensity:40, fade:55, price:740000,
   description:'پخش نرم و مات روی گونه با ۸ رنگ.',
   limitation:'شدت واقعی به مقدار برداشت و نوع براش بستگی دارد.',
   shades:range('pwd',[
     ['هلویی','#E08A70'],['گلبهی','#E08A85'],['رز ملایم','#D9808F'],['صورتی سرد','#D2769B'],
     ['مرجانی','#E47B62'],['زردآلویی','#E09A6A'],['گل‌محمدی','#CC6478'],['خاکی گرم','#BE7F6D']])},

  {id:'cream-blush', type:'blush', category:'face', mode:'tint', finish:'cream',
   name:'رژگونهٔ کرمی', title:'رژگونهٔ کرمی', region:'گونه', code:'ROJA / CRM',
   intensity:45, fade:55, price:790000,
   description:'بافت کرمی با جلوهٔ مرطوب، ۶ رنگ.',
   limitation:'جلوهٔ مرطوب محصول فقط تقریبی نمایش داده می‌شود.',
   shades:range('crm',[
     ['شفتالوی کرمی','#DE8B74'],['رز کرمی','#D77C88'],['تمشکی کرمی','#C25F7C'],
     ['مسی','#C97A5C'],['صورتی گرم','#DD8A92'],['آجری ملایم','#B96A5B']])},

  {id:'highlighter', type:'highlighter', category:'face', mode:'glow', finish:'shimmer',
   name:'هایلایتر', title:'هایلایتر پودری', region:'بالای گونه، تیغهٔ بینی، بالای لب', code:'ROJA / HLT',
   intensity:40, fade:60, price:860000,
   description:'۵ رنگ نوری برای برجسته‌کردن نقاطی که نور می‌گیرند.',
   limitation:'درخشش واقعی با زاویهٔ نور تغییر می‌کند؛ پیش‌نمایش آن را تقریبی نشان می‌دهد.',
   shades:range('hlt',[
     ['شامپاینی','#F3DFC1'],['صدفی','#F5E6E8'],['رزگلد','#EFC3AE'],['طلایی','#E9C98B'],['برنزی','#D4A373']])},

  /* ---- eyes ---- */
  {id:'shadow', type:'eyeshadow', category:'eyes', mode:'pigment', finish:'matte',
   name:'سایهٔ تک‌رنگ', title:'سایهٔ چشم تک‌رنگ', region:'پلک', code:'ROJA / EYE',
   intensity:45, fade:45, price:390000,
   description:'۱۲ رنگ مات، شاین و متالیک برای ترکیب آزاد.',
   limitation:'درخشش ذرات شاین فقط تقریبی نمایش داده می‌شود.',
   shades:range('eye',[
     ['شامپاینی','#D9BFA4',{finish:'shimmer'}],['کرم مات','#C9AA90'],['هلوی مات','#C9917B'],['مسی','#B57553',{finish:'metallic'}],
     ['قهوهٔ شیری','#A0765F'],['کاکائویی','#7A5344'],['زیتونی','#7F7A55',{finish:'shimmer'}],['زغالی','#4E4A4C'],
     ['بادمجانی','#6B4566'],['آلویی','#8A5470',{finish:'shimmer'}],['آبی دودی','#5A6E84'],['سبز خزه','#5C7A67']])},

  {id:'palette', type:'eyeshadow', category:'eyes', mode:'pigment', finish:'matte',
   name:'پالت سایه', title:'پالت سایهٔ چهاررنگ', region:'پلک', code:'ROJA / PAL',
   intensity:50, fade:50, price:1250000,
   description:'۵ پالت چهاررنگ. هر پالت کامل روی پلک می‌نشیند: رنگ روشن زیر ابرو و گوشهٔ داخلی، میانی در چین پلک، تیره در گوشهٔ بیرونی و رنگ تأکید روی پلک.',
   limitation:'جای هر رنگ الگوی رایج است؛ با براش می‌توانی پخش یا کمش کنی.',
   palettes,
   shades:palettes.map(p=>({id:`pal-${p.id}`,variantId:p.id,name:p.label,color:p.colors[1],colors:p.colors,
     pans:p.colors.map((c,i)=>({name:pans[i],color:c}))}))},

  {id:'liner', type:'eyeliner', category:'eyes', mode:'pigment', finish:'satin',
   name:'خط چشم', title:'خط چشم ماژیکی', region:'خط مژه', code:'ROJA / LNR',
   intensity:80, fade:18, price:690000,
   styles:[{id:'thin',name:'باریک'},{id:'classic',name:'کلاسیک'},{id:'wing',name:'گربه‌ای'},{id:'smudge',name:'دودی دور چشم'}],
   description:'۵ رنگ و چهار فرم کشیدن خط.',
   limitation:'فرم خط روی چشم‌های پف‌دار یا افتاده ممکن است متفاوت دیده شود.',
   shades:range('lnr',[['مشکی','#1A1416'],['قهوه‌ای','#4A3024'],['سرمه‌ای','#1F2A44'],['زیتونی','#3F4630'],['بادمجانی','#3E2238']])},

  {id:'mascara', type:'mascara', category:'eyes', mode:'pigment', finish:'satin',
   name:'ریمل', title:'ریمل', region:'مژه', code:'ROJA / MSC',
   intensity:70, fade:10, price:840000,
   styles:[{id:'length',name:'بلندکننده'},{id:'volume',name:'حجم‌دهنده'}],
   description:'۳ رنگ، با فرمول بلندکننده یا حجم‌دهنده.',
   limitation:'مژه‌ها طرح‌وارند؛ پیش‌نمایش حالت و تیرگی خط مژه را نشان می‌دهد نه تک‌تک تارها.',
   shades:range('msc',[['مشکی','#141012'],['قهوه‌ای تیره','#3A2A22'],['سرمه‌ای','#1C2440']])},

  {id:'brow', type:'brow', category:'eyes', mode:'pigment', finish:'matte',
   name:'مداد ابرو', title:'مداد ابرو', region:'ابرو', code:'ROJA / BRW',
   intensity:38, fade:35, price:520000,
   description:'۶ رنگ برای پرکردن و یکدست‌کردن ابرو؛ بافت موها حفظ می‌شود.',
   limitation:'فرم ابرو تغییر نمی‌کند؛ فقط رنگ و پری آن.',
   shades:range('brw',[['بلوند','#9C7B5A'],['قهوه‌ای روشن','#7A5A42'],['فندقی','#634634'],['قهوه‌ای تیره','#4A3428'],['خاکستری تیره','#3E3A3A'],['مشکی نرم','#2A2224']])},

  /* ---- lips ---- */
  {id:'lipliner', type:'lipliner', category:'lips', mode:'pigment', finish:'matte',
   name:'مداد لب', title:'مداد لب', region:'دور لب', code:'ROJA / LPL',
   intensity:60, fade:25, price:480000,
   description:'۶ رنگ برای دورگیری و مشخص‌تر کردن فرم لب.',
   limitation:'کشیدن خط بیرون از مرز طبیعی لب در پیش‌نمایش شبیه‌سازی نمی‌شود.',
   shades:range('lpl',[['نود','#A86B5E'],['رز','#A2505C'],['قرمز','#9E2530'],['آجری','#8E3E30'],['شرابی','#5E1F2E'],['کاکائویی','#5E3730']])},

  {id:'velvet', type:'lipstick', category:'lips', mode:'pigment', finish:'velvet',
   name:'رژ مخملی', title:'رژ لب جامد مخملی', region:'لب', code:'ROJA / VLV',
   intensity:55, fade:45, price:890000,
   description:'پوشش مات مخملی با ۱۲ رنگ، از نودهای گرم تا بادمجانی تیره.',
   limitation:'بافت مخملی تقریبی نمایش داده می‌شود؛ رنگ روی لب‌های تیره‌تر کمی متفاوت می‌نشیند.',
   shades:range('vlv',[
     ['نود صدفی','#B4796B'],['نود گرم','#A9685C'],['شفتالو','#C0705F'],['مرجانی','#D2624F'],
     ['گل‌بهی','#C75C63'],['رز کهنه','#B05663'],['آلبالویی','#9E2B3F'],['قرمز کلاسیک','#C02A34'],
     ['اناری','#A81F35'],['تمشکی','#8E2447'],['شرابی','#6E2136'],['بادمجانی','#4E2138']])},

  {id:'liquid', type:'lipstick', category:'lips', mode:'pigment', finish:'matte',
   name:'رژ مایع مات', title:'رژ لب مایع مات', region:'لب', code:'ROJA / MAT',
   intensity:62, fade:35, price:950000,
   description:'ماندگاری بالا و پوشش کامل با ۱۰ رنگ.',
   limitation:'رژ مایع روی لب کمی تیره‌تر از پیش‌نمایش می‌نشیند.',
   shades:range('mat',[
     ['صورتی خاکی','#B87A77'],['نود سرد','#A4736F'],['هلویی','#CC7A6A'],['گلبهی مات','#C76A6B'],
     ['سرخابی','#C33E63'],['قرمز مات','#B62634'],['آجری','#9E4033'],['زرشکی','#8C2135'],
     ['کاکائویی','#6F3B33'],['توتی تیره','#5E2135']])},

  {id:'gloss', type:'gloss', category:'lips', mode:'pigment', finish:'gloss',
   name:'لیپ‌گلاس', title:'لیپ‌گلاس شفاف', region:'لب', code:'ROJA / GLS',
   intensity:30, fade:40, price:620000,
   description:'۹ رنگ شفاف، به‌تنهایی یا روی رژ.',
   limitation:'براقیت با نور محیط عوض می‌شود؛ پیش‌نمایش آن را تقریبی نشان می‌دهد.',
   shades:range('gls',[
     ['بی‌رنگ','#EAD2CB'],['صدفی','#D8A899'],['هلوی روشن','#DD9585'],['صورتی شفاف','#DB8797'],['رزگلد','#C98274',{finish:'shimmer'}],
     ['مرجانی براق','#E0765F'],['تمشکی شفاف','#B85570'],['شرابی براق','#93394E'],['قهوه‌ای شیری','#A87465']])}
];

export const byProduct=id=>products.find(p=>p.id===id);

// Ready-made looks. Shade 'auto' means "the foundation shade that suits this face":
// the shade finder's pick if it has been run, otherwise whatever is selected.
export const looks=[
  {id:'natural', name:'روزانهٔ طبیعی', description:'پوست یکدست و سبک، گونهٔ هلویی و لب نود.',
   items:[['tint','auto',30],['powder-blush','pwd-1',28],['brow','brw-2',30],['mascara','msc-2',55,'length'],['velvet','vlv-1',45]]},
  {id:'office', name:'اداری', description:'پوشش متوسط، سایهٔ قهوه‌ای ملایم و خط چشم باریک.',
   items:[['foundation','auto',40],['concealer','auto',35],['powder-blush','pwd-3',26],['shadow','eye-5',35],['liner','lnr-2',60,'thin'],['mascara','msc-1',60,'length'],['brow','brw-3',35],['liquid','mat-2',55]]},
  {id:'evening', name:'مهمانی', description:'پلک رز، خط چشم گربه‌ای، هایلایت و رژ قرمز.',
   items:[['foundation','auto',55],['contour','ctr-2',35],['highlighter','hlt-1',45],['palette','pal-2',55],['liner','lnr-1',85,'wing'],['mascara','msc-1',80,'volume'],['brow','brw-4',40],['lipliner','lpl-3',55],['velvet','vlv-8',65]]},
  {id:'smoky', name:'اسموکی', description:'سایهٔ دودی، خط چشم پخش و لب نود.',
   items:[['foundation','auto',50],['contour','ctr-1',30],['palette','pal-3',60],['liner','lnr-1',80,'smudge'],['mascara','msc-1',80,'volume'],['brow','brw-4',40],['liquid','mat-2',50]]},
  {id:'bridal', name:'عروس', description:'پوست درخشان، پالت خاکی، رژ رز و برق لب.',
   items:[['foundation','auto',55],['concealer','auto',40],['highlighter','hlt-2',50],['cream-blush','crm-2',35],['palette','pal-1',50],['liner','lnr-2',70,'classic'],['mascara','msc-1',75,'volume'],['brow','brw-3',35],['lipliner','lpl-2',45],['velvet','vlv-6',55],['gloss','gls-1',35]]},
  {id:'bold', name:'لب پررنگ', description:'چهرهٔ ساده و رژ مات پررنگ.',
   items:[['tint','auto',30],['brow','brw-3',30],['mascara','msc-1',60,'length'],['lipliner','lpl-5',60],['liquid','mat-8',70]]}
];
