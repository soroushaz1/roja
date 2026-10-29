// Many pictures of one face, made into one shape.
//
// The tracker gives all 468 points of the face in 3D from every picture, but not all
// of it equally well: across the picture (x and y) a point is measured, while its
// depth is the model's guess from that one picture. A picture with the head turned
// measures across it what a front-on picture can only guess: how far the nose and the
// chin stand out. So the shape is solved for from all the pictures together. Each
// picture is laid over the shape as it stands (turned, scaled and moved, in closed
// form: Horn's quaternion method), and then every point is put where it agrees best
// with all of them: trusted fully across each picture, a tenth as much in depth (the
// tracker's depth leans towards the face it expects), and not at all where that
// picture saw the point edge-on or from behind, since there the tracker only places
// what it expects. A few rounds settle it.
//
// The shape stays in the first picture's own frame (its pixels, z on the scale of x,
// larger farther from the camera), so it reads like that picture's landmarks, and
// each picture's pose maps the shape into that picture.
import {WARP_TRIANGLES} from './head3d.js?v=29';

export const MESH=468;
// How much a point's depth is trusted against its place across the picture.
const DEPTH=.1;
// What holds a point that hardly any picture saw squarely where it was.
const HOLD=.05;

const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;

// The eigenvector of the largest eigenvalue of a symmetric matrix (rows of numbers),
// by Jacobi rotations.
function topEigenvector(A){
  const n=A.length,a=A.map(r=>r.slice()),v=a.map((_,i)=>a.map((_,j)=>i===j?1:0));
  for(let sweep=0;sweep<50;sweep++){
    let off=0;
    for(let p=0;p<n;p++)for(let q=p+1;q<n;q++)off+=a[p][q]*a[p][q];
    if(off<1e-22)break;
    for(let p=0;p<n;p++)for(let q=p+1;q<n;q++){
      if(Math.abs(a[p][q])<1e-300)continue;
      const theta=(a[q][q]-a[p][p])/(2*a[p][q]);
      const t=Math.sign(theta||1)/(Math.abs(theta)+Math.sqrt(theta*theta+1)),c=1/Math.sqrt(t*t+1),s=t*c;
      for(let k=0;k<n;k++){const akp=a[k][p],akq=a[k][q];a[k][p]=c*akp-s*akq;a[k][q]=s*akp+c*akq;}
      for(let k=0;k<n;k++){const apk=a[p][k],aqk=a[q][k];a[p][k]=c*apk-s*aqk;a[q][k]=s*apk+c*aqk;}
      for(let k=0;k<n;k++){const vkp=v[k][p],vkq=v[k][q];v[k][p]=c*vkp-s*vkq;v[k][q]=s*vkp+c*vkq;}
    }
  }
  let best=0;for(let i=1;i<n;i++)if(a[i][i]>a[best][best])best=i;
  return v.map(r=>r[best]);
}

// The turn, scale and shift that lay the points X over the points P, each pair
// weighted by w (all 1 if left out): P ≈ s·R·X + t. R is row by row.
export function fitPose(X,P,w=null){
  const n=Math.min(X.length,P.length);
  let W=0,cx={x:0,y:0,z:0},cp={x:0,y:0,z:0};
  for(let i=0;i<n;i++){const k=w?w[i]:1;if(!k)continue;W+=k;
    cx.x+=k*X[i].x;cx.y+=k*X[i].y;cx.z+=k*X[i].z;cp.x+=k*P[i].x;cp.y+=k*P[i].y;cp.z+=k*P[i].z;}
  if(!W)return {R:[[1,0,0],[0,1,0],[0,0,1]],s:1,t:{x:0,y:0,z:0}};
  cx={x:cx.x/W,y:cx.y/W,z:cx.z/W};cp={x:cp.x/W,y:cp.y/W,z:cp.z/W};
  // S[a][b]: the sum of x_a·p_b over the centred pairs.
  const S=[[0,0,0],[0,0,0],[0,0,0]];let xx=0;
  for(let i=0;i<n;i++){const k=w?w[i]:1;if(!k)continue;
    const a=sub(X[i],cx),b=sub(P[i],cp),A=[a.x,a.y,a.z],B=[b.x,b.y,b.z];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)S[r][c]+=k*A[r]*B[c];
    xx+=k*dot(a,a);}
  const [[Sxx,Sxy,Sxz],[Syx,Syy,Syz],[Szx,Szy,Szz]]=S;
  const [q0,qx,qy,qz]=topEigenvector([
    [Sxx+Syy+Szz,Syz-Szy,Szx-Sxz,Sxy-Syx],
    [Syz-Szy,Sxx-Syy-Szz,Sxy+Syx,Szx+Sxz],
    [Szx-Sxz,Sxy+Syx,-Sxx+Syy-Szz,Syz+Szy],
    [Sxy-Syx,Szx+Sxz,Syz+Szy,-Sxx-Syy+Szz]]);
  const R=[
    [q0*q0+qx*qx-qy*qy-qz*qz,2*(qx*qy-q0*qz),2*(qx*qz+q0*qy)],
    [2*(qy*qx+q0*qz),q0*q0-qx*qx+qy*qy-qz*qz,2*(qy*qz-q0*qx)],
    [2*(qz*qx-q0*qy),2*(qz*qy+q0*qx),q0*q0-qx*qx-qy*qy+qz*qz]];
  let xp=0;
  for(let i=0;i<n;i++){const k=w?w[i]:1;if(!k)continue;xp+=k*dot(sub(P[i],cp),apply(R,sub(X[i],cx)));}
  const s=xx>0?xp/xx:1,rc=apply(R,cx);
  return {R,s,t:{x:cp.x-s*rc.x,y:cp.y-s*rc.y,z:cp.z-s*rc.z}};
}
export const apply=(R,v)=>({x:R[0][0]*v.x+R[0][1]*v.y+R[0][2]*v.z,y:R[1][0]*v.x+R[1][1]*v.y+R[1][2]*v.z,z:R[2][0]*v.x+R[2][1]*v.y+R[2][2]*v.z});
export const place=(pose,v)=>{const r=apply(pose.R,v);return {x:pose.s*r.x+pose.t.x,y:pose.s*r.y+pose.t.y,z:pose.s*r.z+pose.t.z};};

// The pose, fitted twice: the second time without the points that sat far off the
// first fit (a mouth or eyes not quite as in the shape), so they do not pull it.
function robustPose(X,P,w){
  let pose=fitPose(X,P,w);
  const r=X.map((q,i)=>w[i]?Math.hypot(...Object.values(sub(place(pose,q),P[i]))):Infinity);
  const sorted=r.filter(Number.isFinite).sort((a,b)=>a-b),limit=3*(sorted[sorted.length>>1]||0)+1e-9;
  pose=fitPose(X,P,w.map((k,i)=>r[i]<=limit?k:0));
  return pose;
}

// Each point's normal, from the triangles round it, turned away from the inside of
// the head (behind the middle of the face, away from the nose).
export function normalsOf(X){
  const n=X.length,N=X.map(()=>({x:0,y:0,z:0}));
  let g={x:0,y:0,z:0};for(const q of X){g.x+=q.x/n;g.y+=q.y/n;g.z+=q.z/n;}
  const face=Math.hypot(...Object.values(sub(X[454],X[234])))||1,nose=sub(X[1],g),l=Math.hypot(nose.x,nose.y,nose.z)||1;
  const inside={x:g.x-nose.x/l*face*.4,y:g.y-nose.y/l*face*.4,z:g.z-nose.z/l*face*.4};
  for(let t=0;t<WARP_TRIANGLES.length;t+=3){
    const a=X[WARP_TRIANGLES[t]],b=X[WARP_TRIANGLES[t+1]],c=X[WARP_TRIANGLES[t+2]];
    const u=sub(b,a),v=sub(c,a);
    let m={x:u.y*v.z-u.z*v.y,y:u.z*v.x-u.x*v.z,z:u.x*v.y-u.y*v.x};
    const mid={x:(a.x+b.x+c.x)/3-inside.x,y:(a.y+b.y+c.y)/3-inside.y,z:(a.z+b.z+c.z)/3-inside.z};
    if(dot(m,mid)<0)m={x:-m.x,y:-m.y,z:-m.z};
    for(const i of [WARP_TRIANGLES[t],WARP_TRIANGLES[t+1],WARP_TRIANGLES[t+2]]){N[i].x+=m.x;N[i].y+=m.y;N[i].z+=m.z;}
  }
  return N.map(m=>{const k=Math.hypot(m.x,m.y,m.z)||1;return {x:m.x/k,y:m.y/k,z:m.z/k};});
}
// How squarely a picture with this pose saw a point with this normal: 1 face-on, 0
// edge-on or from behind. Its camera looks along +z.
export function squareness(pose,n){
  const c=-(pose.R[2][0]*n.x+pose.R[2][1]*n.y+pose.R[2][2]*n.z),k=Math.max(0,Math.min(1,(c-.08)/.35));
  return k*k*(3-2*k);
}

// The shape from every picture's points (each as points3 gives them; the first
// picture is the frame the shape is in), and each picture's pose: where the shape
// lies in it. With one picture, that picture's own points.
export function fuse(Ps,{rounds=3}={}){
  let X=Ps[0].slice(0,MESH).map(q=>({x:q.x,y:q.y,z:q.z}));
  const same={R:[[1,0,0],[0,1,0],[0,0,1]],s:1,t:{x:0,y:0,z:0}};
  if(Ps.length<2)return {X,poses:[same]};
  let seen=Ps.map(()=>new Array(MESH).fill(1)),poses;
  for(let round=0;round<rounds;round++){
    poses=Ps.map((P,v)=>robustPose(X,P.slice(0,MESH),seen[v]));
    const N=normalsOf(X);
    seen=poses.map(pose=>N.map(n=>squareness(pose,n)));
    X=X.map((q,i)=>{
      // The normal equations of the weighted least squares, held a little by where the
      // point is now.
      const M=[[HOLD,0,0],[0,HOLD,0],[0,0,HOLD]],b=[HOLD*q.x,HOLD*q.y,HOLD*q.z];
      Ps.forEach((P,v)=>{
        const w=seen[v][i];if(!w)return;
        const {R,s,t}=poses[v],p=P[i],m=[(p.x-t.x)/s,(p.y-t.y)/s,(p.z-t.z)/s];
        for(let k=0;k<3;k++){
          const r=R[k],c=w*(k===2?DEPTH:1);
          for(let a=0;a<3;a++){b[a]+=c*r[a]*m[k];for(let d=0;d<3;d++)M[a][d]+=c*r[a]*r[d];}
        }
      });
      return solve3(M,b)||q;
    });
  }
  poses=Ps.map((P,v)=>robustPose(X,P.slice(0,MESH),seen[v]));
  return {X,poses};
}
function solve3(M,b){
  const [[a,b1,c],[d,e,f],[g,h,i]]=M;
  const A=e*i-f*h,B=-(d*i-f*g),C=d*h-e*g,det=a*A+b1*B+c*C;
  if(Math.abs(det)<1e-12)return null;
  const inv=[[A,-(b1*i-c*h),b1*f-c*e],[B,a*i-c*g,-(a*f-c*d)],[C,-(a*h-b1*g),a*e-b1*d]];
  return {x:(inv[0][0]*b[0]+inv[0][1]*b[1]+inv[0][2]*b[2])/det,
    y:(inv[1][0]*b[0]+inv[1][1]*b[1]+inv[1][2]*b[2])/det,
    z:(inv[2][0]*b[0]+inv[2][1]*b[1]+inv[2][2]*b[2])/det};
}
