// The mirror's shaders, in GLSL ES 1.00. The website (stage.js) and the Android app's
// renderer (android/…/MirrorRenderer.kt, which reads this very file out of the APK)
// compile the same source, so the two can never draw makeup differently.
//
// Plain template literals only: no interpolation, no backquotes inside. Fragment
// shaders get PRECISION prepended by whoever compiles them.

// Full precision wherever the GPU offers it. On iPhones mediump really is 16-bit, which
// overflows the shimmer noise and blurs fine detail; on most desktops it is 32-bit
// anyway, so a bug there never shows on a laptop.
export const PRECISION=`#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

export const MESH_VERT=`attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;
void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.,1.);}`;

// A grade of (1,1,1) multiplies by exactly one, so the plain view stays exact.
export const OUT_FRAG=`uniform sampler2D u_tex;uniform vec3 u_grade;varying vec2 v_uv;
void main(){vec4 c=texture2D(u_tex,v_uv);gl_FragColor=vec4(c.rgb*u_grade,c.a);}`;

// A mask onto the live face: the mesh at the landmarks, textured from the mask painted
// in face space. Only `u_box` of that space was kept (the rest is empty).
export const MASK_VERT=`attribute vec2 a_pos;attribute vec2 a_uv;varying vec2 v_uv;
void main(){v_uv=a_uv;gl_Position=vec4(a_pos,0.,1.);}`;

export const MASK_FRAG=`uniform sampler2D u_mask;uniform vec4 u_box;varying vec2 v_uv;
void main(){
  vec2 t=(v_uv-u_box.xy)/u_box.zw;
  float a=t.x<0.||t.y<0.||t.x>1.||t.y>1.?0.:texture2D(u_mask,t).a;
  gl_FragColor=vec4(0.,0.,0.,a);
}`;

// Full-frame passes map texture space onto itself, so every intermediate texture has
// the camera texture's orientation and all of them are sampled at the same v_uv.
export const QUAD_VERT=`attribute vec2 a_pos;varying vec2 v_uv;
void main(){v_uv=a_pos*.5+.5;gl_Position=vec4(a_pos,0.,1.);}`;

// 4 bilinear taps over a 4×4 block: a box filter for the local-mean pyramid.
export const DOWN_FRAG=`uniform sampler2D u_tex;uniform vec2 u_step;varying vec2 v_uv;
void main(){
  gl_FragColor=.25*(texture2D(u_tex,v_uv+u_step*vec2(-1.,-1.))+texture2D(u_tex,v_uv+u_step*vec2(1.,-1.))
                  +texture2D(u_tex,v_uv+u_step*vec2(-1.,1.))+texture2D(u_tex,v_uv+u_step*vec2(1.,1.)));
}`;

// One texel per layer: the mean colour of the frame under the layer's mask (from the
// low-resolution copy), and in alpha the brightness of the cheeks and forehead, which
// stands in for how much light is on the face.
export const STATS_FRAG=`
uniform sampler2D u_low;uniform sampler2D u_mask;uniform vec4 u_box;uniform vec4 u_probeA;uniform vec4 u_probeB;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
void main(){
  vec3 sum=vec3(0.);float w=0.;
  for(int j=0;j<6;j++)for(int i=0;i<6;i++){
    vec2 uv=mix(u_box.xy,u_box.zw,vec2((float(i)+.5)/6.,(float(j)+.5)/6.));
    float m=texture2D(u_mask,uv).a;
    sum+=texture2D(u_low,uv).rgb*m;w+=m;
  }
  vec3 mean=w>.05?sum/w:texture2D(u_low,(u_box.xy+u_box.zw)*.5).rgb;
  float face=.25*(luma(texture2D(u_low,u_probeA.xy).rgb)+luma(texture2D(u_low,u_probeA.zw).rgb)
                 +luma(texture2D(u_low,u_probeB.xy).rgb)+luma(texture2D(u_low,u_probeB.zw).rgb));
  gl_FragColor=vec4(mean,face);
}`;

// How a colour meets the skin. The colour is scaled to the light on the face, then
// modulated by how bright each pixel is relative to the region's mean, so lip creases,
// the shadow under the lower lip and the texture of the skin all show through the
// colour, as they do with real product. Finish then decides how the glints behave:
// matte flattens them, gloss sharpens them, shimmer scatters specks.
export const LAYER_FRAG=`
varying vec2 v_uv;
uniform sampler2D u_src;uniform sampler2D u_low;uniform sampler2D u_mask;uniform sampler2D u_stats;
uniform vec3 u_color;uniform float u_amount;uniform float u_mode;
uniform float u_detail;uniform float u_gloss;uniform float u_matte;uniform float u_shimmer;uniform float u_sheer;
uniform float u_smooth;uniform float u_bright;uniform vec2 u_texel;uniform float u_radius;uniform float u_time;uniform float u_lift;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 smoothed(vec3 c0){
  vec3 sum=c0;float wsum=1.;
  for(int i=0;i<16;i++){
    float fi=float(i),a=fi*2.39996,r=sqrt((fi+.5)/16.)*u_radius;
    vec3 c=texture2D(u_src,v_uv+vec2(cos(a),sin(a))*r*u_texel).rgb;
    vec3 d=c-c0;float w=exp(-dot(d,d)*90.);
    sum+=c*w;wsum+=w;
  }
  return sum/wsum;
}
void main(){
  vec4 src=texture2D(u_src,v_uv);
  float cover=texture2D(u_mask,v_uv).a;
  if(cover<=0.){gl_FragColor=src;return;}
  vec3 base=src.rgb;
  vec4 stats=texture2D(u_stats,vec2(.5));
  float Y=luma(base);
  float Yl=max(luma(texture2D(u_low,v_uv).rgb),.03);
  float Yr=max(luma(stats.rgb),.03);
  float light=clamp(mix(1.,stats.a/.58,.5),.72,1.12);
  float shade=clamp(Y/Yr,0.,2.5);
  float glint=max(Y-Yl,0.);
  vec3 col=u_color*light;
  float m=cover*u_amount;
  vec3 outc=base;
  if(u_mode<.5){
    float s=shade>1.?1.+(shade-1.)*(1.-.8*u_matte):shade;
    vec3 paint=col*mix(1.,s,u_detail);
    // A sheer product does not replace the skin, it washes over it: keep the pixel's
    // own luminance and take only the product's hue. Opaque products (liner, lashes)
    // keep u_sheer near zero and behave as before.
    vec3 wash=base*(u_color/max(luma(u_color),.05));
    outc=mix(base,mix(paint,wash,u_sheer),m);
  }else if(u_mode<1.5){
    float mx=max(max(u_color.r,u_color.g),max(u_color.b,.001));
    outc=mix(base,base*(u_color/mx),m);
  }else if(u_mode<2.5){
    // Contour is the only layer here, and at .78 it darkened by about seven per cent
    // at its default setting — below what anyone notices, which is why it read as
    // "not working".
    outc=mix(base,base*(u_color/max(luma(u_color),.05))*.62,m);
  }else if(u_mode<3.5){
    vec3 g=col*(.45+.55*smoothstep(.9,1.25,shade));
    outc=mix(base,1.-(1.-base)*(1.-g*.85),m);
  }else{
    // Skin only: a pixel far darker or brighter than the region (hair, a fringe,
    // a nostril) is left mostly alone.
    float away=abs(Y-Yr)/Yr;
    float skin=clamp(1.-(away-.3)*1.6,0.,1.);
    vec3 even=mix(base,smoothed(base),clamp(u_smooth*cover*skin,0.,1.));
    if(u_mode<4.5){
      float s=clamp(luma(even)/Yr,0.,2.);
      // Below the region's mean the layer inherits the shadow it sits in. A foundation
      // should (u_lift 0), but a concealer exists to cancel the dark under an eye, so
      // it lifts that floor back towards the product's own value.
      s=s>1.?1.+(s-1.)*(1.-.7*u_matte):mix(s,1.,u_lift);
      outc=mix(even,col*mix(1.,s,u_detail),m*skin);
    }else{
      outc=even*(1.+.24*u_bright*cover*skin);
      outc.b*=1.-.05*u_bright*cover*skin;
    }
  }
  outc+=u_gloss*cover*(smoothstep(.012,.18,glint)*.55*light+.045*shade);
  if(u_shimmer>0.){
    float n=hash(floor(gl_FragCoord.xy/1.5)+floor(u_time*5.));
    outc+=u_shimmer*(step(.982,n)*.38*cover*cover+smoothstep(.95,1.3,shade)*.14*cover)*mix(vec3(1.),u_color*1.2,.45);
  }
  gl_FragColor=vec4(clamp(outc,0.,1.),1.);
}`;
