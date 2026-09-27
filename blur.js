// A soft blur built only from drawImage scaling, the one canvas operation that behaves
// the same in every browser. Canvas shadows and filters do not: WebKit on iPhone draws
// shadows through Core Graphics with its own limits, and has long lacked canvas
// filters, so a blur that leaned on either could leave Safari with no makeup at all.
//
// The picture is shrunk until one pixel spans about the blur's reach — by halving,
// each step a clean 2×2 average — then grown back by doubling with bilinear smoothing.
// A fractional first step keeps the radius continuous, so a slider moves it smoothly.

const levels=[];
// Scratch canvases only ever grow, so a blur per frame does not reallocate memory.
function level(i,w,h){
  let c=levels[i];
  if(!c){c=document.createElement('canvas');levels[i]=c;}
  if(c.width<w+2||c.height<h+2){c.width=Math.max(c.width,w+2);c.height=Math.max(c.height,h+2);}
  const x=c.getContext('2d');
  x.imageSmoothingEnabled=true;
  // A 1px clear margin: bilinear sampling at the rectangle's edge must read nothing
  // left over from a larger earlier use.
  x.clearRect(0,0,w+2,h+2);
  return {c,x};
}

// Draws `box` of `src` into the same box of `dst`, blurred by about `radius` px (the
// standard deviation of the Gaussian it approximates). dst's globalAlpha and
// globalCompositeOperation apply to the result.
export function blurInto(dst,src,box,radius){
  if(!(radius>=.6)){dst.drawImage(src,box.x,box.y,box.w,box.h,box.x,box.y,box.w,box.h);return;}
  const shrink=Math.min(96,radius*2.4);
  const steps=Math.max(1,Math.floor(Math.log2(shrink)));
  const first=shrink/2**steps;
  const sizes=[[Math.max(1,Math.round(box.w/first)),Math.max(1,Math.round(box.h/first))]];
  for(let i=1;i<=steps;i++){const [w,h]=sizes[i-1];sizes.push([Math.max(1,Math.ceil(w/2)),Math.max(1,Math.ceil(h/2))]);}

  // down
  let {c:prev}=level(0,...sizes[0]);
  prev.getContext('2d').drawImage(src,box.x,box.y,box.w,box.h,0,0,sizes[0][0],sizes[0][1]);
  for(let i=1;i<=steps;i++){
    const {c,x}=level(i,...sizes[i]);
    x.drawImage(prev,0,0,sizes[i-1][0],sizes[i-1][1],0,0,sizes[i][0],sizes[i][1]);
    prev=c;
  }
  // up, into the levels just used on the way down
  for(let i=steps-1;i>=0;i--){
    const {c,x}=level(i,...sizes[i]);
    x.drawImage(prev,0,0,sizes[i+1][0],sizes[i+1][1],0,0,sizes[i][0],sizes[i][1]);
    prev=c;
  }
  const smoothing=dst.imageSmoothingEnabled;
  dst.imageSmoothingEnabled=true;
  dst.drawImage(prev,0,0,sizes[0][0],sizes[0][1],box.x,box.y,box.w,box.h);
  dst.imageSmoothingEnabled=smoothing;
}
