// Developer overlay: every landmark the model returns, numbered, with the ones that
// are driving the current selection picked out — the lip contour while a lipstick is
// on, the nose anchors while rhinoplasty is applied, and so on.
//
// It draws on its own canvas rather than the makeup overlay, so the multiply blend
// used by «ترکیب رنگ با بافت پوست» never touches it.

const PLAIN='#3FD0F0';   // a point nothing is currently using
const ACTIVE='#FFC53D';  // a point driving what is on screen right now

export function renderDebug(context, landmarks, {labelSize=10, highlight=true, onlyActive=false, active=null}={}) {
  const {width,height}=context.canvas;
  context.clearRect(0,0,width,height);
  if(!landmarks||!landmarks.length) return 0;
  const scale=Math.max(width,height)/640;
  const lit=i=>highlight&&!!active&&active.has(i);
  // 468 labels at once are unreadable over the middle of a face, so the overlay can
  // be narrowed to whatever is in play.
  const shown=i=>!onlyActive||(!!active&&active.has(i));

  context.save();
  let count=0;
  for(let i=0;i<landmarks.length;i++){
    if(!shown(i))continue;
    count++;
    const marked=lit(i);
    context.beginPath();
    context.arc(landmarks[i].x*width, landmarks[i].y*height, (marked?2.4:1.3)*scale, 0, Math.PI*2);
    context.fillStyle=marked?ACTIVE:PLAIN;
    context.globalAlpha=marked?1:0.65;
    context.fill();
  }
  context.globalAlpha=1;

  if(labelSize>0){
    const size=labelSize*scale;
    context.font=`${size}px ui-monospace,Consolas,monospace`;
    context.textBaseline='middle';
    context.lineJoin='round';
    context.lineWidth=Math.max(2,size*0.3);
    context.strokeStyle='rgba(6,4,6,0.9)';
    for(let i=0;i<landmarks.length;i++){
      if(!shown(i))continue;
      context.save();
      // The canvas is mirrored in CSS, so flip each glyph back to stay readable.
      context.translate(landmarks[i].x*width, landmarks[i].y*height);
      context.scale(-1,1);
      const label=String(i);
      context.strokeText(label, size*0.35, -size*0.45);
      context.fillStyle=lit(i)?ACTIVE:'#E8F7FC';
      context.fillText(label, size*0.35, -size*0.45);
      context.restore();
    }
  }
  context.restore();
  return count;
}
