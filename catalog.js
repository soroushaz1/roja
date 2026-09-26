// Roja's own sample range. These are the shop's shades, not another brand's, so
// nothing here reproduces a third party's names, codes, photographs or colours.
//
// The hex values are the colours the mirror paints. A screen preview is not a
// measured match for a finished product: ambient light, camera white balance and
// natural skin tone all move the result.

const range=(prefix,entries)=>entries.map(([name,color],i)=>({
  id:`${prefix}-${i+1}`, variantId:String(i+1), name, color
}));

const pans=['روشن','میانی','تیره','تأکید'];
const palettes=[
  {id:'1',label:'خاک رس',  colors:['#D9BFA4','#C08E6E','#9A6446','#6B4530']},
  {id:'2',label:'گل سرخ',  colors:['#E0B4AE','#C98793','#A55A6E','#71374B']},
  {id:'3',label:'دود و نقره',colors:['#C9C3C6','#9A959E','#6E6A75','#45424C']},
  {id:'4',label:'شب آبی',  colors:['#AFC0D2','#7E93AE','#536C8C','#2F4257']},
  {id:'5',label:'خزه',     colors:['#C4C89E','#98AE84','#6C8A63','#3F5B44']}
];

export const products=[
  {id:'velvet', type:'lipstick', name:'رژ مخملی', title:'رژ لب جامد مخملی',
   region:'لب', code:'ROJA / VLV', intensity:55,
   description:'پوشش مات مخملی با ۱۲ رنگ، از نودهای گرم تا بادمجانی تیره.',
   limitation:'بافت مخملی و درخشش کم محصول در پیش‌نمایش بازسازی نمی‌شود.',
   shades:range('vlv',[
     ['نود صدفی','#B4796B'],['نود گرم','#A9685C'],['شفتالو','#C0705F'],['مرجانی','#D2624F'],
     ['گل‌بهی','#C75C63'],['رز کهنه','#B05663'],['آلبالویی','#9E2B3F'],['قرمز کلاسیک','#C02A34'],
     ['اناری','#A81F35'],['تمشکی','#8E2447'],['شرابی','#6E2136'],['بادمجانی','#4E2138']])},

  {id:'liquid', type:'lipstick', name:'رژ مایع مات', title:'رژ لب مایع مات',
   region:'لب', code:'ROJA / MAT', intensity:60,
   description:'ماندگاری بالا و پوشش کامل با ۱۰ رنگ.',
   limitation:'رژ مایع روی لب تیره‌تر از پیش‌نمایش می‌نشیند.',
   shades:range('mat',[
     ['صورتی خاکی','#B87A77'],['نود سرد','#A4736F'],['هلویی','#CC7A6A'],['گلبهی مات','#C76A6B'],
     ['سرخابی','#C33E63'],['قرمز مات','#B62634'],['آجری','#9E4033'],['زرشکی','#8C2135'],
     ['کاکائویی','#6F3B33'],['توتی تیره','#5E2135']])},

  {id:'gloss', type:'lipstick', name:'لیپ‌گلاس', title:'لیپ‌گلاس شفاف',
   region:'لب', code:'ROJA / GLS', intensity:32,
   description:'پوشش سبک و شفاف با ۸ رنگ، برای روی رژ یا به‌تنهایی.',
   limitation:'براقیت و ذرات شاین شبیه‌سازی نمی‌شوند؛ فقط رنگ پایه دیده می‌شود.',
   shades:range('gls',[
     ['صدفی','#D8A899'],['هلوی روشن','#DD9585'],['صورتی شفاف','#DB8797'],['رزگلد','#C98274'],
     ['مرجانی براق','#E0765F'],['تمشکی شفاف','#B85570'],['شرابی براق','#93394E'],['قهوه‌ای شیری','#A87465']])},

  {id:'powder-blush', type:'blush', name:'رژگونهٔ پودری', title:'رژگونهٔ پودری',
   region:'گونه', code:'ROJA / PWD', intensity:40,
   description:'پخش نرم و مات روی گونه با ۸ رنگ.',
   limitation:'شدت واقعی به مقدار برداشت و نوع براش بستگی دارد.',
   shades:range('pwd',[
     ['هلویی','#E08A70'],['گلبهی','#E08A85'],['رز ملایم','#D9808F'],['صورتی سرد','#D2769B'],
     ['مرجانی','#E47B62'],['زردآلویی','#E09A6A'],['گل‌محمدی','#CC6478'],['خاکی گرم','#BE7F6D']])},

  {id:'cream-blush', type:'blush', name:'رژگونهٔ کرمی', title:'رژگونهٔ کرمی',
   region:'گونه', code:'ROJA / CRM', intensity:45,
   description:'بافت کرمی با جلوهٔ مرطوب، ۶ رنگ.',
   limitation:'جلوهٔ مرطوب محصول در پیش‌نمایش دیده نمی‌شود.',
   shades:range('crm',[
     ['شفتالوی کرمی','#DE8B74'],['رز کرمی','#D77C88'],['تمشکی کرمی','#C25F7C'],
     ['مسی','#C97A5C'],['صورتی گرم','#DD8A92'],['آجری ملایم','#B96A5B']])},

  {id:'shadow', type:'eyeshadow', name:'سایهٔ تک‌رنگ', title:'سایهٔ چشم تک‌رنگ',
   region:'پلک', code:'ROJA / EYE', intensity:45,
   description:'۱۲ رنگ مات و ساتن برای ترکیب آزاد.',
   limitation:'اکلیل و جلوهٔ متالیک شبیه‌سازی نمی‌شوند.',
   shades:range('eye',[
     ['شامپاینی','#D9BFA4'],['کرم مات','#C9AA90'],['هلوی مات','#C9917B'],['مسی','#B57553'],
     ['قهوهٔ شیری','#A0765F'],['کاکائویی','#7A5344'],['زیتونی','#7F7A55'],['زغالی','#4E4A4C'],
     ['بادمجانی','#6B4566'],['آلویی','#8A5470'],['آبی دودی','#5A6E84'],['سبز خزه','#5C7A67']])},

  {id:'palette', type:'eyeshadow', name:'پالت سایه', title:'پالت سایهٔ چهاررنگ',
   region:'پلک', code:'ROJA / PAL', intensity:45,
   description:'۵ پالت چهاررنگ هماهنگ. اول پالت، بعد خانهٔ رنگ را انتخاب کن.',
   limitation:'هر خانه با رنگ پایه نمایش داده می‌شود.',
   palettes,
   shades:palettes.flatMap(p=>p.colors.map((color,i)=>({
     id:`pal-${p.id}-${i+1}`, variantId:p.id, pan:i+1,
     name:`${p.label} · ${pans[i]}`, shortName:pans[i], color})))}
];
