// Named procedures, each expressed as weights over the region controls in deform.js.
//
// A procedure's weights describe the shape change only. Nothing here models swelling,
// bruising, healing time, scarring, skin thickness or what any particular surgeon
// would achieve — each `note` says what the preview leaves out.
import {controls, zeroAmounts} from './deform.js?v=12';

export const procedures=[
  {id:'rhinoplasty', name:'جراحی بینی', short:'بینی',
   summary:'باریک‌کردن تیغه و پره و کمی چرخش نوک بینی.',
   note:'شکل نهایی بینی به ضخامت پوست و غضروف بستگی دارد و ماه‌ها پس از عمل تثبیت می‌شود. تورم اولیه در این پیش‌نمایش دیده نمی‌شود.',
   weights:{'nose-bridge':-60,'nose-width':-70,'nose-tip':45}},

  {id:'lip-filler', name:'تزریق ژل لب', short:'لب',
   summary:'پرتر شدن حجم لب بالا و پایین.',
   note:'نتیجه به نوع ژل، حجم تزریق و فرم طبیعی لب بستگی دارد و با گذشت زمان جذب می‌شود.',
   weights:{'lip-fullness':75}},

  {id:'cheek-filler', name:'تزریق ژل گونه', short:'گونه',
   summary:'برجسته‌تر شدن استخوان گونه.',
   note:'میزان برجستگی به محل تزریق و بافت زیرین بستگی دارد؛ این پیش‌نمایش تغییر سایه‌اندازی طبیعی پوست را نشان نمی‌دهد.',
   weights:{'cheek-volume':70}},

  {id:'buccal-fat', name:'برداشتن چربی گونه', short:'زیر گونه',
   summary:'گودتر شدن زیر استخوان گونه.',
   note:'اثر آن با افزایش سن بیشتر می‌شود و برگشت‌پذیر نیست. مقدار چربی قابل برداشت در هر صورت متفاوت است.',
   weights:{'cheek-hollow':70}},

  {id:'jaw-contour', name:'زاویه‌سازی فک', short:'فک',
   summary:'باریک‌تر شدن خط فک.',
   note:'بسته به روش (تزریق، بوتاکس ماهیچهٔ جونده یا جراحی استخوان) نتیجه و مدت ماندگاری کاملاً متفاوت است.',
   weights:{'jaw-width':60}},

  {id:'chin-implant', name:'پروتز چانه', short:'چانه',
   summary:'بلندتر و مشخص‌تر شدن چانه.',
   note:'پروتز بیشتر برجستگی رو به جلو ایجاد می‌کند؛ دوربین این برجستگی را فقط از نما نشان می‌دهد و اندازهٔ واقعی را نمی‌سنجد.',
   weights:{'chin-length':50}},

  {id:'blepharoplasty', name:'جراحی پلک', short:'پلک',
   summary:'بازتر شدن شکاف پلک.',
   note:'جراحی پلک بیشتر پوست اضافه و پف را برمی‌دارد؛ این پیش‌نمایش فقط بازشدگی را نشان می‌دهد، نه تغییر چین و پف پلک.',
   weights:{'eye-open':55,'brow-lift':15}},

  {id:'brow-lift', name:'لیفت ابرو', short:'ابرو',
   summary:'بالاتر رفتن ابرو و باز شدن نگاه.',
   note:'نتیجه به روش لیفت و کشسانی پوست بستگی دارد و در روش‌های غیرجراحی موقتی است.',
   weights:{'brow-lift':70}}
];

export const byId=id=>procedures.find(p=>p.id===id);

// Active procedures (id -> 0..100) collapse into one set of control amounts.
// Weights add, then clamp, so combinations behave predictably.
export function amountsFor(active, overrides) {
  const amounts=zeroAmounts();
  for (const [id, strength] of active) {
    const procedure=byId(id);
    if (!procedure) continue;
    for (const [control, weight] of Object.entries(procedure.weights)) {
      amounts[control]+=weight*strength/100;
    }
  }
  for (const control of controls) {
    const manual=overrides?.[control.id];
    if (manual) amounts[control.id]+=manual;
    amounts[control.id]=Math.max(-100,Math.min(100,amounts[control.id]));
  }
  return amounts;
}
