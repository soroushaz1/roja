// Named procedures, each expressed as weights over the region controls in deform.js.
//
// A procedure's weights describe the visible change only. Nothing here models
// swelling, bruising, healing time, scarring, skin thickness or what any particular
// surgeon would achieve — each `note` says what the preview leaves out. `kind`,
// `lasts` and `recovery` are general, commonly quoted ranges, not advice: they vary
// with the person, the method and the practitioner.
import {controls, zeroAmounts, regions} from './deform.js?v=14';

export {regions};
export const kinds={surgery:'جراحی',injection:'تزریقی',nonsurgical:'غیرجراحی'};

export const procedures=[
  /* ---- nose ---- */
  {id:'rhinoplasty', region:'nose', kind:'surgery', name:'جراحی بینی', short:'بینی',
   summary:'باریک‌کردن تیغه و پره، ظریف‌کردن و کمی چرخش نوک بینی.',
   lasts:'دائمی', recovery:'حدود ۱ تا ۲ هفته تا برداشتن چسب و آتل؛ فرم نهایی ۱ تا ۲ سال بعد',
   note:'شکل نهایی بینی به ضخامت پوست و غضروف بستگی دارد و ماه‌ها پس از عمل تثبیت می‌شود. قوز بینی و نیم‌رخ در نمای روبه‌رو دیده نمی‌شوند.',
   variants:[
     {id:'natural',name:'طبیعی',weights:{'nose-bridge':-45,'nose-width':-50,'nose-tip':30,'nose-tip-size':-30}},
     {id:'semi',name:'نیمه‌فانتزی',weights:{'nose-bridge':-60,'nose-width':-70,'nose-tip':50,'nose-tip-size':-45}},
     {id:'fantasy',name:'فانتزی',weights:{'nose-bridge':-75,'nose-width':-85,'nose-tip':80,'nose-tip-size':-60}}
   ]},

  /* ---- lips ---- */
  {id:'lip-filler', region:'lips', kind:'injection', name:'تزریق ژل لب', short:'لب',
   summary:'پرتر شدن حجم لب؛ متعادل یا با تأکید روی لب بالا.',
   lasts:'معمولاً ۶ تا ۱۲ ماه', recovery:'تورم و گاهی کبودی چند روز',
   note:'نتیجه به نوع ژل، حجم تزریق و فرم طبیعی لب بستگی دارد و با گذشت زمان جذب می‌شود.',
   variants:[
     {id:'balanced',name:'متعادل',weights:{'lip-fullness':45,'lip-upper':30,'lip-lower':25}},
     {id:'upper',name:'تأکید لب بالا',weights:{'lip-fullness':20,'lip-upper':75,'lip-lower':10,'lip-lift':10}},
     {id:'full',name:'پرحجم',weights:{'lip-fullness':75,'lip-upper':40,'lip-lower':35}}
   ]},

  {id:'lip-lift', region:'lips', kind:'surgery', name:'لیفت لب بالا', short:'لیفت لب',
   summary:'کوتاه‌شدن فاصلهٔ زیر بینی تا لب و دیده‌شدن بیشتر لب بالا.',
   lasts:'دائمی', recovery:'بخیه‌ها حدود یک هفته؛ جای برش زیر بینی ماه‌ها کم‌رنگ می‌شود',
   note:'جای برش در قاعدهٔ بینی و تغییر لبخند در این پیش‌نمایش دیده نمی‌شود.',
   weights:{'lip-lift':75,'lip-upper':25}},

  {id:'lip-corner', region:'lips', kind:'injection', name:'لیفت گوشهٔ لب', short:'گوشهٔ لب',
   summary:'بالاتر آمدن گوشه‌های لب و حالت آرام‌تر دهان.',
   lasts:'بوتاکس حدود ۳ تا ۴ ماه؛ ژل معمولاً ۶ تا ۱۲ ماه', recovery:'معمولاً بدون دورهٔ نقاهت جدی',
   note:'حرکت لب هنگام حرف‌زدن و خندیدن در پیش‌نمایش ثابت در نظر گرفته شده است.',
   weights:{'lip-corners':75}},

  /* ---- cheeks ---- */
  {id:'cheek-filler', region:'cheeks', kind:'injection', name:'تزریق ژل گونه', short:'گونه',
   summary:'برجسته‌تر شدن استخوان گونه.',
   lasts:'معمولاً ۱۲ تا ۱۸ ماه', recovery:'تورم خفیف چند روز',
   note:'میزان برجستگی به محل تزریق و بافت زیرین بستگی دارد؛ این پیش‌نمایش تغییر سایه‌اندازی طبیعی پوست را نشان نمی‌دهد.',
   weights:{'cheek-volume':70}},

  {id:'buccal-fat', region:'cheeks', kind:'surgery', name:'برداشتن چربی گونه', short:'زیر گونه',
   summary:'گودتر شدن زیر استخوان گونه و باریک‌تر دیده‌شدن پایین صورت.',
   lasts:'دائمی', recovery:'تورم ۲ تا ۳ هفته؛ نتیجهٔ نهایی چند ماه بعد',
   note:'اثر آن با افزایش سن بیشتر می‌شود و برگشت‌پذیر نیست. مقدار چربی قابل برداشت در هر صورت متفاوت است.',
   weights:{'cheek-hollow':75}},

  {id:'temple-filler', region:'cheeks', kind:'injection', name:'تزریق ژل شقیقه', short:'شقیقه',
   summary:'پرشدن گودی شقیقه و نرم‌تر شدن خط کنار پیشانی.',
   lasts:'معمولاً ۱۲ تا ۱۸ ماه', recovery:'تورم خفیف چند روز',
   note:'اگر مو روی شقیقه باشد، تغییر در پیش‌نمایش کمتر دیده می‌شود.',
   weights:{'temple':75}},

  /* ---- jaw and chin ---- */
  {id:'jaw-contour', region:'jaw', kind:'surgery', name:'زاویه‌سازی فک', short:'فک',
   summary:'باریک‌تر شدن خط فک.',
   lasts:'بوتاکس حدود ۴ تا ۶ ماه؛ جراحی دائمی', recovery:'بوتاکس بدون نقاهت؛ جراحی تورم چند هفته',
   note:'بسته به روش (بوتاکس ماهیچهٔ جونده یا جراحی استخوان) نتیجه و ماندگاری کاملاً متفاوت است.',
   variants:[
     {id:'botox',name:'بوتاکس ماسه‌تر',kind:'injection',weights:{'jaw-width':-40}},
     {id:'surgery',name:'جراحی زاویهٔ فک',weights:{'jaw-width':-70,'chin-width':-15}}
   ]},

  {id:'chin-implant', region:'jaw', kind:'surgery', name:'پروتز چانه', short:'چانه',
   summary:'بلندتر و مشخص‌تر شدن چانه.',
   lasts:'پروتز دائمی؛ ژل معمولاً ۱۲ تا ۱۸ ماه', recovery:'پروتز حدود ۱ تا ۲ هفته؛ ژل چند روز',
   note:'این عمل بیشتر برجستگی رو به جلو ایجاد می‌کند؛ دوربین آن را فقط از نمای روبه‌رو نشان می‌دهد و اندازهٔ واقعی را نمی‌سنجد.',
   variants:[
     {id:'implant',name:'پروتز',weights:{'chin-length':50}},
     {id:'filler',name:'تزریق ژل',kind:'injection',weights:{'chin-length':30,'chin-width':-5}}
   ]},

  {id:'v-line', region:'jaw', kind:'surgery', name:'وی‌لاین', short:'وی‌لاین',
   summary:'باریک‌کردن فک و چانه برای فرم V شکل پایین صورت.',
   lasts:'دائمی', recovery:'تورم ۴ تا ۶ هفته؛ نتیجهٔ نهایی چند ماه بعد',
   note:'جراحی استخوان است و خطرهای خودش را دارد؛ تغییر عمق چانه در نمای روبه‌رو دیده نمی‌شود.',
   weights:{'jaw-width':-55,'chin-width':-55,'chin-length':15}},

  {id:'face-lift', region:'jaw', kind:'surgery', name:'لیفت صورت', short:'لیفت',
   summary:'کشیده‌شدن پوست افتادهٔ کنار چانه و خط فک.',
   lasts:'معمولاً ۷ تا ۱۰ سال', recovery:'۲ تا ۴ هفته',
   note:'تغییر کیفیت پوست، چین‌های ظریف و گردن در پیش‌نمایش دیده نمی‌شوند.',
   weights:{'jowl':80,'jaw-width':-10,'cheek-volume':10}},

  /* ---- eyes and brows ---- */
  {id:'blepharoplasty', region:'eyes', kind:'surgery', name:'جراحی پلک', short:'پلک',
   summary:'بازتر شدن شکاف پلک.',
   lasts:'معمولاً چندین سال', recovery:'کبودی و تورم ۱ تا ۲ هفته',
   note:'جراحی پلک بیشتر پوست اضافه و پف را برمی‌دارد؛ این پیش‌نمایش فقط بازشدگی را نشان می‌دهد، نه تغییر چین و پف پلک.',
   weights:{'eye-open':55,'brow-lift':15}},

  {id:'fox-eye', region:'eyes', kind:'surgery', name:'کانتوپلاستی / فاکس‌آی', short:'فاکس‌آی',
   summary:'کشیده‌تر و بالاتر شدن گوشهٔ بیرونی چشم و دم ابرو.',
   lasts:'نخ حدود چند ماه تا یک سال؛ کانتوپلاستی دائمی', recovery:'نخ چند روز؛ جراحی ۱ تا ۲ هفته',
   note:'حالت کشیدهٔ اول کار معمولاً با گذشت زمان کمتر می‌شود.',
   variants:[
     {id:'thread',name:'نخ فاکس‌آی',kind:'nonsurgical',weights:{'eye-tilt':45,'brow-tail':45}},
     {id:'canthoplasty',name:'کانتوپلاستی',weights:{'eye-tilt':75,'eye-size':12,'brow-tail':15}}
   ]},

  {id:'brow-lift', region:'eyes', kind:'surgery', name:'لیفت ابرو', short:'ابرو',
   summary:'بالاتر رفتن ابرو و باز شدن نگاه.',
   lasts:'جراحی چند سال؛ بوتاکس حدود ۳ تا ۴ ماه', recovery:'جراحی ۱ تا ۲ هفته',
   note:'نتیجه به روش لیفت و کشسانی پوست بستگی دارد و در روش‌های غیرجراحی موقتی است.',
   weights:{'brow-lift':70}},

  /* ---- skin ---- */
  {id:'botox', region:'skin', kind:'injection', name:'بوتاکس پیشانی و دور چشم', short:'بوتاکس',
   summary:'کم‌شدن خطوط پیشانی، بین ابرو و کنار چشم.',
   lasts:'حدود ۳ تا ۴ ماه', recovery:'بدون نقاهت؛ اثر پس از ۳ تا ۱۴ روز',
   note:'این پیش‌نمایش بافت پوست را صاف می‌کند؛ بی‌حرکتی عضلات هنگام اخم یا خنده دیده نمی‌شود.',
   weights:{'smooth-forehead':85,'smooth-eyes':65,'brow-lift':8}},

  {id:'undereye-filler', region:'skin', kind:'injection', name:'تزریق زیر چشم', short:'زیر چشم',
   summary:'کم‌شدن گودی و سایهٔ زیر چشم.',
   lasts:'معمولاً ۹ تا ۱۲ ماه یا بیشتر', recovery:'تورم و کبودی چند روز',
   note:'تیرگی ناشی از رنگدانهٔ پوست با تزریق برطرف نمی‌شود؛ پیش‌نمایش هر دو را کمی روشن می‌کند.',
   weights:{'undereye':80}},

  {id:'resurfacing', region:'skin', kind:'nonsurgical', name:'جوان‌سازی پوست', short:'پوست',
   summary:'یکدست‌تر و نرم‌تر شدن بافت پوست (لیزر، میکرونیدلینگ، پیلینگ).',
   lasts:'بسته به روش؛ معمولاً چند جلسه لازم است', recovery:'قرمزی چند روز تا یک هفته',
   note:'لک، منافذ باز و جای جوش واقعی ممکن است کمتر از پیش‌نمایش تغییر کنند.',
   weights:{'smooth-skin':70,'smooth-eyes':30}}
];

export const byId=id=>procedures.find(p=>p.id===id);

// The weights and kind in force for a procedure, given its selected variant.
export function resolve(procedure,variantId){
  const variant=procedure.variants?.find(v=>v.id===variantId)||procedure.variants?.[0];
  return {weights:variant?.weights||procedure.weights,kind:variant?.kind||procedure.kind,variant};
}

// Active procedures (id -> 0..100) collapse into one set of control amounts.
// Weights add, then clamp, so combinations behave predictably.
export function amountsFor(active, overrides, variants) {
  const amounts=zeroAmounts();
  for (const [id, strength] of active) {
    const procedure=byId(id);
    if (!procedure) continue;
    const {weights}=resolve(procedure,variants?.get(id));
    for (const [control, weight] of Object.entries(weights)) {
      amounts[control]+=weight*strength/100;
    }
  }
  for (const control of controls) {
    const manual=overrides?.[control.id];
    if (manual) amounts[control.id]+=manual;
    const low=control.texture?0:-100;
    amounts[control.id]=Math.max(low,Math.min(100,amounts[control.id]));
  }
  return amounts;
}
