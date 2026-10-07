// Roja's sample shades. They are not another brand's, so nothing here reproduces a
// third party's names, codes, photographs or colours, and nothing here is sold: each
// product's `search` is the kind of product it is, and with a shade's name it becomes
// a search on the partner store (partner.js) for something like it.
//
// The hex values are the colours the mirror paints. A screen preview is not a
// measured match for a finished product: ambient light, camera white balance and
// natural skin tone all move the result.
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
  {id:'lips',name:'لب',hint:'رژ، مداد، برق لب'},
  {id:'hair',name:'مو',hint:'رنگ مو، مدل مو'}
];

// The hair is recoloured first: it is not on the face, and a fringe sits over nothing
// the face layers paint. A hairstyle is not a layer at all but a picture drawn over the
// mirror (hair.js), so it has no place here.
export const layerOrder=['hair','foundation','concealer','contour','blush','highlighter','eyeshadow','eyeliner','mascara','brow','lipliner','lipstick','gloss'];

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
   name:'کرم‌پودر مات', title:'کرم‌پودر مات با پوشش قابل‌تنظیم', region:'پوست', search:'کرم پودر مات',
   intensity:45, fade:60, finder:true,
   description:'۱۳ رنگ با زیرته‌ی گرم، خنثی و سرد. شدت را کم کن برای پوشش سبک، زیاد کن برای پوشش کامل.',
   limitation:'پوشاندن لک و جوش واقعی و ماندگاری روی پوست چرب در پیش‌نمایش دیده نمی‌شود.',
   shades:range('fnd',[
     ['عاجی','#EAC0BF'], ['صدفی','#EDD3B7'], ['روشن','#F3CEA6'], ['بژ روشن','#DDBAB0'],
     ['بژ','#DBBC9F'], ['بژ گرم','#E3BA96'], ['گندمی روشن','#DCB49A'], ['گندمی','#E0B78D'],
     ['گندمی گرم','#DBA88C'], ['برنزی روشن','#D1B38F'], ['برنزی','#D3A886'], ['برنزی تیره','#C4A27E'],
     ['گندمی تیره','#C68D62']])},

  {id:'tint', type:'foundation', category:'face', mode:'foundation', finish:'dewy',
   name:'کرم رنگی سبک', title:'کرم رنگی سبک با جلوهٔ درخشان', region:'پوست', search:'کرم رنگی',
   intensity:32, fade:65, finder:true,
   description:'پوشش سبک و طبیعی با ۸ رنگ؛ بافت پوست دیده می‌شود.',
   limitation:'جلوهٔ درخشان روی پوست چرب بیشتر از پیش‌نمایش است.',
   shades:range('tnt',[
     ['روشن سرد','#EDD2C0',{tone:'C'}],['روشن','#E8C8AC',{tone:'N'}],['روشن گرم','#E3C19C',{tone:'W'}],
     ['متوسط صورتی','#D6AE95',{tone:'C'}],['متوسط','#CFA482',{tone:'N'}],['متوسط گرم','#C69A70',{tone:'W'}],
     ['گندمی','#B08160',{tone:'N'}],['تیره','#8A5E42',{tone:'W'}]])},

  {id:'concealer', type:'concealer', category:'face', mode:'foundation', finish:'natural',
   name:'کانسیلر', title:'کانسیلر زیر چشم', region:'زیر چشم', search:'کانسیلر',
   intensity:45, fade:70, finder:true, lighter:true,
   description:'۸ رنگ، کمی روشن‌تر از پوست، برای روشن‌کردن گودی و تیرگی زیر چشم.',
   limitation:'تیرگی‌های عمیق زیر چشم معمولاً به لایهٔ اصلاح‌کنندهٔ رنگ هم نیاز دارند.',
   shades:range('cnc',[
     ['عاجی','#EDC6A5'], ['روشن','#E0B394'], ['بژ روشن','#D6B094'], ['بژ','#C8AE9E'],
     ['گندمی روشن','#C4A69A'], ['گندمی','#C69A85'], ['برنزی','#BE9B78'], ['برنزی تیره','#B3937D']])},

  {id:'contour', type:'contour', category:'face', mode:'shade', finish:'matte',
   name:'کانتور', title:'پودر کانتور مات', region:'زیر گونه و کنار بینی', search:'پودر کانتور',
   intensity:50, fade:70,
   description:'۵ رنگ سرد تا گرم برای سایه‌انداختن زیر استخوان گونه، شقیقه و کنار بینی.',
   limitation:'جای دقیق کانتور به فرم استخوان صورت بستگی دارد؛ با ابزار براش جابه‌جایش کن.',
   shades:range('ctr',[
     ['خاکی روشن','#C09565'], ['خاکی','#B48655'], ['خاکی گرم','#AC7E51'], ['قهوهٔ ملایم','#9E7350'],
     ['قهوهٔ تیره','#775840']])},

  {id:'powder-blush', type:'blush', category:'face', mode:'tint', finish:'matte',
   name:'رژگونهٔ پودری', title:'رژگونهٔ پودری', region:'گونه', search:'رژگونه پودری',
   intensity:40, fade:55,
   description:'پخش نرم و مات روی گونه با ۸ رنگ.',
   limitation:'شدت واقعی به مقدار برداشت و نوع براش بستگی دارد.',
   shades:range('pwd',[
     ['هلویی روشن','#E7AF9A'], ['شفتالو','#E4AC97'], ['گل‌بهی','#E1A995'], ['مرجانی','#DDA593'],
     ['زردآلویی','#DAA290'], ['گل‌محمدی','#D59D8D'], ['آجری ملایم','#D0998A'], ['خاکی گرم','#CB9587']])},

  {id:'cream-blush', type:'blush', category:'face', mode:'tint', finish:'cream',
   name:'رژگونهٔ کرمی', title:'رژگونهٔ کرمی', region:'گونه', search:'رژگونه کرمی',
   intensity:45, fade:55,
   description:'بافت کرمی با جلوهٔ مرطوب، ۶ رنگ.',
   limitation:'جلوهٔ مرطوب محصول فقط تقریبی نمایش داده می‌شود.',
   shades:range('crm',[
     ['شفتالوی کرمی','#EAAE97'], ['هلویی','#E6A994'], ['گل‌بهی کرمی','#E2A490'], ['مرجانی','#DD9F8C'],
     ['مسی','#D79886'], ['آجری','#D19281']])},

  {id:'highlighter', type:'highlighter', category:'face', mode:'glow', finish:'shimmer',
   name:'هایلایتر', title:'هایلایتر پودری', region:'بالای گونه، تیغهٔ بینی، بالای لب', search:'هایلایتر',
   intensity:40, fade:60,
   description:'۵ رنگ نوری برای برجسته‌کردن نقاطی که نور می‌گیرند.',
   limitation:'درخشش واقعی با زاویهٔ نور تغییر می‌کند؛ پیش‌نمایش آن را تقریبی نشان می‌دهد.',
   shades:range('hlt',[
     ['شامپاینی','#EBAEB9'], ['مرواریدی','#E6B5A7'], ['رزگلد','#E0AD9F'], ['هلویی','#DBA69D'],
     ['برنزی','#D0A18D']])},

  /* ---- eyes ---- */
  {id:'shadow', type:'eyeshadow', category:'eyes', mode:'pigment', finish:'matte',
   name:'سایهٔ تک‌رنگ', title:'سایهٔ چشم تک‌رنگ', region:'پلک', search:'سایه چشم تکی',
   intensity:59, fade:45,
   description:'۱۲ رنگ مات، شاین و متالیک برای ترکیب آزاد.',
   limitation:'درخشش ذرات شاین فقط تقریبی نمایش داده می‌شود.',
   shades:range('eye',[
     ['شامپاینی','#D9BFA4',{finish:'shimmer'}],['کرم مات','#C9AA90'],['هلوی مات','#C9917B'],['مسی','#B57553',{finish:'metallic'}],
     ['قهوهٔ شیری','#A0765F'],['کاکائویی','#7A5344'],['زیتونی','#7F7A55',{finish:'shimmer'}],['زغالی','#4E4A4C'],
     ['بادمجانی','#6B4566'],['آلویی','#8A5470',{finish:'shimmer'}],['آبی دودی','#5A6E84'],['سبز خزه','#5C7A67']])},

  {id:'palette', type:'eyeshadow', category:'eyes', mode:'pigment', finish:'matte',
   name:'پالت سایه', title:'پالت سایهٔ چهاررنگ', region:'پلک', search:'پالت سایه چشم',
   intensity:64, fade:50,
   description:'۵ پالت چهاررنگ. هر پالت کامل روی پلک می‌نشیند: رنگ روشن زیر ابرو و گوشهٔ داخلی، میانی در چین پلک، تیره در گوشهٔ بیرونی و رنگ تأکید روی پلک.',
   limitation:'جای هر رنگ الگوی رایج است؛ با براش می‌توانی پخش یا کمش کنی.',
   palettes,
   shades:palettes.map(p=>({id:`pal-${p.id}`,variantId:p.id,name:p.label,color:p.colors[1],colors:p.colors,
     pans:p.colors.map((c,i)=>({name:pans[i],color:c}))}))},

  {id:'liner', type:'eyeliner', category:'eyes', mode:'pigment', finish:'satin',
   name:'خط چشم', title:'خط چشم ماژیکی', region:'خط مژه', search:'خط چشم ماژیکی',
   intensity:82, fade:18,
   styles:[{id:'thin',name:'باریک'},{id:'classic',name:'کلاسیک'},{id:'wing',name:'گربه‌ای'},{id:'smudge',name:'دودی دور چشم'}],
   description:'۵ رنگ و چهار فرم کشیدن خط.',
   limitation:'فرم خط روی چشم‌های پف‌دار یا افتاده ممکن است متفاوت دیده شود.',
   shades:range('lnr',[['مشکی','#1A1416'],['قهوه‌ای','#4A3024'],['سرمه‌ای','#1F2A44'],['زیتونی','#3F4630'],['بادمجانی','#3E2238']])},

  {id:'mascara', type:'mascara', category:'eyes', mode:'pigment', finish:'satin',
   name:'ریمل', title:'ریمل', region:'مژه', search:'ریمل',
   intensity:77, fade:10,
   styles:[{id:'length',name:'بلندکننده'},{id:'volume',name:'حجم‌دهنده'}],
   description:'۳ رنگ، با فرمول بلندکننده یا حجم‌دهنده.',
   limitation:'مژه‌ها طرح‌وارند؛ پیش‌نمایش حالت و تیرگی خط مژه را نشان می‌دهد نه تک‌تک تارها.',
   shades:range('msc',[['مشکی','#141012'],['قهوه‌ای تیره','#3A2A22'],['سرمه‌ای','#1C2440']])},

  {id:'brow', type:'brow', category:'eyes', mode:'pigment', finish:'matte',
   name:'مداد ابرو', title:'مداد ابرو', region:'ابرو', search:'مداد ابرو',
   intensity:52, fade:35,
   description:'۶ رنگ برای پرکردن و یکدست‌کردن ابرو؛ بافت موها حفظ می‌شود.',
   limitation:'فرم ابرو تغییر نمی‌کند؛ فقط رنگ و پری آن.',
   shades:range('brw',[['بلوند','#9C7B5A'],['قهوه‌ای روشن','#7A5A42'],['فندقی','#634634'],['قهوه‌ای تیره','#4A3428'],['خاکستری تیره','#3E3A3A'],['مشکی نرم','#2A2224']])},

  /* ---- lips ---- */
  {id:'lipliner', type:'lipliner', category:'lips', mode:'pigment', finish:'matte',
   name:'مداد لب', title:'مداد لب', region:'دور لب', search:'مداد لب',
   intensity:71, fade:25,
   description:'۶ رنگ برای دورگیری و مشخص‌تر کردن فرم لب.',
   limitation:'کشیدن خط بیرون از مرز طبیعی لب در پیش‌نمایش شبیه‌سازی نمی‌شود.',
   shades:range('lpl',[
     ['نود','#C36879'], ['هلویی','#B66A67'], ['گل‌بهی','#D8443D'], ['آجری','#B25948'],
     ['اناری','#8A394B'], ['شرابی','#763829']])},

  {id:'velvet', type:'lipstick', category:'lips', mode:'pigment', finish:'velvet',
   name:'رژ مخملی', title:'رژ لب جامد مخملی', region:'لب', search:'رژ لب جامد مخملی',
   intensity:68, fade:45,
   description:'پوشش مات مخملی با ۱۲ رنگ، از نودهای گرم تا بادمجانی تیره.',
   limitation:'بافت مخملی تقریبی نمایش داده می‌شود؛ رنگ روی لب‌های تیره‌تر کمی متفاوت می‌نشیند.',
   shades:range('vlv',[
     ['نود صدفی','#D26A70'], ['نود گرم','#C47468'], ['شفتالو','#C06A5C'], ['هلویی','#C2555C'],
     ['مرجانی','#B55254'], ['گل‌بهی','#B84749'], ['آجری','#BA3B41'], ['قرمز کلاسیک','#BF2928'],
     ['اناری','#91414D'], ['آلبالویی','#AD1A14'], ['شرابی','#8D2F29'], ['خرمایی تیره','#76312C']])},

  {id:'liquid', type:'lipstick', category:'lips', mode:'pigment', finish:'matte',
   name:'رژ مایع مات', title:'رژ لب مایع مات', region:'لب', search:'رژ لب مایع مات',
   intensity:73, fade:35,
   description:'ماندگاری بالا و پوشش کامل با ۱۰ رنگ.',
   limitation:'رژ مایع روی لب کمی تیره‌تر از پیش‌نمایش می‌نشیند.',
   shades:range('mat',[
     ['نود مات','#BE7765'], ['صورتی خاکی','#B16A70'], ['هلوی مات','#B8555F'], ['مرجانی مات','#B54E57'],
     ['آجری','#C1393A'], ['قرمز مات','#C32A2D'], ['اناری','#9A3A45'], ['آلبالویی','#AB1B16'],
     ['شرابی','#922C21'], ['قهوهٔ سوخته','#652E2B']])},

  {id:'gloss', type:'gloss', category:'lips', mode:'pigment', finish:'gloss',
   name:'لیپ‌گلاس', title:'لیپ‌گلاس شفاف', region:'لب', search:'لیپ گلاس',
   intensity:38, fade:40,
   description:'۹ رنگ شفاف، به‌تنهایی یا روی رژ.',
   limitation:'براقیت با نور محیط عوض می‌شود؛ پیش‌نمایش آن را تقریبی نشان می‌دهد.',
   shades:range('gls',[
     ['بی‌رنگ','#E9D6CF'], ['صدفی','#E2C0B6'], ['هلوی روشن','#DFAE9E'], ['صورتی شفاف','#DCA0A2'],
     ['رزگلد','#D2968B',{finish:'shimmer'}], ['مرجانی براق','#D18C7F'], ['گل‌بهی','#CC8087'],
     ['تمشکی شفاف','#C4737E'], ['شرابی براق','#B2666A']])}
];

// Hair colours, shared by the dye and the hairstyles. Each is the colour the hair's
// average becomes; the strands' own light and shade are kept around it.
const HAIR=[
  ['مشکی','#1C1819'], ['قهوه‌ای تیره','#35251E'], ['شکلاتی','#4E3326'], ['بلوطی','#69412C'],
  ['فندقی','#835636'], ['کاراملی','#9C6A40'], ['عسلی','#B78A52'], ['بلوند تیره','#9A815F'],
  ['بلوند دودی','#A49A88'], ['بلوند روشن','#CBB088'], ['پلاتینی','#DAD2C4'], ['مسی','#A44F28'],
  ['ماهاگونی','#692B25'], ['شرابی','#5E1F2C'], ['رزگلد','#BF8A7F'], ['نقره‌ای','#9C9A9E']
];
products.push(
  {id:'hair-color', type:'hair', category:'hair', mode:'pigment', finish:'satin',
   name:'رنگ مو', title:'رنگ مو روی موی خودت', region:'مو', search:'رنگ مو',
   intensity:70, fade:40,
   description:'۱۶ رنگ، از مشکی تا پلاتینی و مسی. موی خودت از تصویر جدا می‌شود و فقط رنگش عوض می‌شود؛ حالت و سایه‌روشن تارها می‌ماند.',
   limitation:'نتیجهٔ واقعی رنگ به رنگ فعلی مو، دکلره و زمان ماندن رنگ بستگی دارد؛ روشن‌کردن موی تیره بدون دکلره به این روشنی نمی‌رسد.',
   mirrorText:'رنگ را عوض کن و همان لحظه روی موی خودت ببین. شدت را کم کن برای سایه‌ای ملایم، زیاد کن برای رنگ کامل. «محوشدن لبه» مرز مو و پوست را نرم‌تر یا تیزتر می‌کند. دو رنگ را کنار هم مقایسه کن یا زیر نورهای مختلف ببین.',
   shades:range('hcl',HAIR)},
  {id:'hairstyle', type:'hairstyle', category:'hair', mode:'pigment', finish:'satin', sell:false,
   name:'مدل مو', title:'مدل موی تازه روی سر خودت', region:'مو', search:'مدل مو',
   intensity:100, fade:35,
   styles:[{id:'bob',name:'باب'},{id:'pixie',name:'کوتاه'},{id:'bangs',name:'چتری'},
     {id:'long',name:'بلند صاف'},{id:'waves',name:'موج‌دار'},{id:'curls',name:'فر'}],
   description:'شش مدل، هر کدام در ۱۶ رنگ. مدل روی سرت می‌نشیند و با سرت حرکت می‌کند؛ با «شانه» می‌توانی مو را به هر طرف که خواستی حالت بدهی.',
   limitation:'مدل مو تصویری است که روی سر می‌نشیند و موی واقعی زیر آن پاک نمی‌شود؛ موی جمع‌شده یا کوتاه نتیجهٔ بهتری می‌دهد. پیش‌نمایش است، نه نتیجهٔ دقیق آرایشگاه.',
   mirrorText:'مدل و رنگ را عوض کن و همان لحظه روی سرت ببین. «شفافیت» مو را کم‌رنگ یا پررنگ می‌کند و «محوشدن لبه» لبهٔ آن را نرم‌تر. با «شانه» انگشتت را روی مو بکش تا به همان سمت حالت بگیرد.',
   shades:range('hst',HAIR)}
);

export const byProduct=id=>products.find(p=>p.id===id);

// Ready-made looks. Shade 'auto' means "the foundation shade that suits this face":
// the shade finder's pick if it has been run, otherwise whatever is selected.
export const looks=[
  {id:'natural', name:'روزانهٔ طبیعی', description:'پوست یکدست و سبک، گونهٔ هلویی و لب نود.',
   items:[['tint','auto',30],['powder-blush','pwd-1',28],['brow','brw-2',43],['mascara','msc-2',68,'length'],['velvet','vlv-1',59]]},
  {id:'office', name:'اداری', description:'پوشش متوسط، سایهٔ قهوه‌ای ملایم و خط چشم باریک.',
   items:[['foundation','auto',40],['concealer','auto',35],['powder-blush','pwd-3',26],['shadow','eye-5',49],['liner','lnr-2',71,'thin'],['mascara','msc-1',71,'length'],['brow','brw-3',49],['liquid','mat-2',68]]},
  {id:'evening', name:'مهمانی', description:'پلک رز، خط چشم گربه‌ای، هایلایت و رژ قرمز.',
   items:[['foundation','auto',55],['contour','ctr-2',35],['highlighter','hlt-1',45],['palette','pal-2',68],['liner','lnr-1',83,'wing'],['mascara','msc-1',82,'volume'],['brow','brw-4',54],['lipliner','lpl-3',68],['velvet','vlv-8',75]]},
  {id:'smoky', name:'اسموکی', description:'سایهٔ دودی، خط چشم پخش و لب نود.',
   items:[['foundation','auto',50],['contour','ctr-1',30],['palette','pal-3',71],['liner','lnr-1',82,'smudge'],['mascara','msc-1',82,'volume'],['brow','brw-4',54],['liquid','mat-2',64]]},
  {id:'bridal', name:'عروس', description:'پوست درخشان، پالت خاکی، رژ رز و برق لب.',
   items:[['foundation','auto',55],['concealer','auto',40],['highlighter','hlt-2',50],['cream-blush','crm-2',35],['palette','pal-1',64],['liner','lnr-2',77,'classic'],['mascara','msc-1',80,'volume'],['brow','brw-3',49],['lipliner','lpl-2',59],['velvet','vlv-6',68],['gloss','gls-1',49]]},
  {id:'bold', name:'لب پررنگ', description:'چهرهٔ ساده و رژ مات پررنگ.',
   items:[['tint','auto',30],['brow','brw-3',43],['mascara','msc-1',71,'length'],['lipliner','lpl-5',71],['liquid','mat-8',77]]}
];
