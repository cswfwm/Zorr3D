// 渲染跑酷场景（含带骨骼的玩家），检查人物是否站在跑道上、比例是否合适
import fs from 'node:fs';
import zlib from 'node:zlib';
import { m4, v3, deg2rad } from '../engine/math.js';
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from '../engine/rig.js';
import { AnimationPlayer } from '../engine/animation.js';
import { skinPoint } from '../engine/skeleton.js';
import { generateTrack, createPlayer } from '../web/runner/level.js';
import { PRIMITIVES } from '../engine/geometry.js';

const W = 640, H = 400;
const track = generateTrack({ seed: 3, segments: 16, lanes: 3 });
const p = createPlayer(track.spawn);
p.position[2] -= 6;
p.position[0] = 0;

const sk = createHumanSkeleton();
const geo = createHumanMesh(sk);
const clips = createBuiltinClips(sk);
const anim = new AnimationPlayer();
anim.play(clips[2], { loop: true });
anim.update(0.25, sk);

// 蒙皮后的世界顶点
const wpos = new Float32Array(geo.positions.length);
const wnrm = new Float32Array(geo.normals.length);
const skin = sk.update();
for (let v = 0; v < geo.vertexCount; v++) {
  const out = skinPoint([0, 0, 0],
    [geo.positions[v*3], geo.positions[v*3+1], geo.positions[v*3+2]],
    geo.skinIndices.subarray(v*4, v*4+4), geo.skinWeights.subarray(v*4, v*4+4), skin);
  wpos[v*3] = out[0] + p.position[0];
  wpos[v*3+1] = out[1] + p.position[1] - 0.9;
  wpos[v*3+2] = out[2] + p.position[2];
  const n = [geo.normals[v*3], geo.normals[v*3+1], geo.normals[v*3+2]];
  let nx=0,ny=0,nz=0;
  for (let k=0;k<4;k++){
    const w = geo.skinWeights[v*4+k]; if (!w) continue; const o = geo.skinIndices[v*4+k]*16;
    nx += (skin[o]*n[0]+skin[o+4]*n[1]+skin[o+8]*n[2])*w;
    ny += (skin[o+1]*n[0]+skin[o+5]*n[1]+skin[o+9]*n[2])*w;
    nz += (skin[o+2]*n[0]+skin[o+6]*n[1]+skin[o+10]*n[2])*w;
  }
  const l = Math.hypot(nx,ny,nz)||1;
  wnrm[v*3]=nx/l; wnrm[v*3+1]=ny/l; wnrm[v*3+2]=nz/l;
}

const camPos = [p.position[0], 4.2, p.position[2] + 7.4];
const camTgt = [p.position[0], p.position[1] + 1.1 - 0.9, p.position[2] - 5.5];
const proj = m4.perspective(m4.create(), deg2rad(62), W/H, 0.1, 260);
const vp = m4.multiply(m4.create(), proj, m4.lookAt(m4.create(), camPos, camTgt, [0,1,0]));

const zbuf = new Float32Array(W*H).fill(Infinity);
const cbuf = new Float32Array(W*H*3);
for (let y=0;y<H;y++) for (let x=0;x<W;x++){
  const t = Math.pow(1-y/H, 0.55), o=(y*W+x)*3;
  cbuf[o] = 0.62 + (0.12-0.62)*t; cbuf[o+1] = 0.72 + (0.24-0.72)*t; cbuf[o+2] = 0.86 + (0.5-0.86)*t;
}
const sun = v3.normalize([0,0,0],[0.35,0.9,0.25]);

function drawTri(a,b,c,color){
  const area=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
  if (Math.abs(area)<1e-9) return;
  const minX=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x))),maxX=Math.min(W-1,Math.ceil(Math.max(a.x,b.x,c.x)));
  const minY=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y))),maxY=Math.min(H-1,Math.ceil(Math.max(a.y,b.y,c.y)));
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    const px=x+0.5,py=y+0.5;
    const w0=((b.x-px)*(c.y-py)-(c.x-px)*(b.y-py))/area;
    const w1=((c.x-px)*(a.y-py)-(a.x-px)*(c.y-py))/area;
    const w2=1-w0-w1;
    if(w0<0||w1<0||w2<0)continue;
    const z=w0*a.z+w1*b.z+w2*c.z,o=y*W+x;
    if(z>=zbuf[o])continue;
    zbuf[o]=z;
    const n=[0,1,2].map(k=>w0*a.n[k]+w1*b.n[k]+w2*c.n[k]);
    const nl=Math.hypot(...n)||1;
    const ndl=Math.max(0,(n[0]*sun[0]+n[1]*sun[1]+n[2]*sun[2])/nl);
    for(let k=0;k<3;k++) cbuf[o*3+k]=color[k]*(0.35+0.85*ndl);
  }
}
function emit(posArr, nrmArr, idx, model, color){
  for(let i=0;i<idx.length;i+=3){
    const tri=[idx[i],idx[i+1],idx[i+2]].map(vi=>{
      const local=[posArr[vi*3],posArr[vi*3+1],posArr[vi*3+2]];
      const w=v3.transformMat4([0,0,0],local,model);
      const c=v3.transformVec4([0,0,0,0],vp,[w[0],w[1],w[2],1]);
      return {x:(c[0]/c[3]*0.5+0.5)*W,y:(0.5-c[1]/c[3]*0.5)*H,z:c[2]/c[3],w:c[3],
              n:v3.transformDir([0,0,0],[nrmArr[vi*3],nrmArr[vi*3+1],nrmArr[vi*3+2]],model)};
    });
    if(tri.some(t=>t.w<=0.01))continue;
    drawTri(tri[0],tri[1],tri[2],color);
  }
}
const I = m4.create();
const box = PRIMITIVES.box(1,1,1);
for (const pl of track.platforms) {
  const m = m4.fromTRS(m4.create(), [pl.x,-0.35,pl.z], [0,0,0,1], [pl.w,0.7,pl.d]);
  emit(box.positions, box.normals, box.indices, m, [0.22,0.24,0.3]);
}
const coin = PRIMITIVES.torus(0.34,0.11,12,6);
for (const c of track.coins.slice(0, 40)) {
  const m = m4.fromTRS(m4.create(), [c.x,c.y,c.z], [0,0.5,0.7,0.5], [1,1,1]);
  emit(coin.positions, coin.normals, coin.indices, m, [1,0.78,0.2]);
}
emit(wpos, wnrm, geo.indices, I, [0.95,0.96,1.0]);

const px = Buffer.alloc(W*H*3);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const o=y*W+x;
  for(let k=0;k<3;k++){
    let v=cbuf[o*3+k];
    v=(v*(2.51*v+0.03))/(v*(2.43*v+0.59)+0.14);
    v=Math.max(0,Math.min(1,v));
    px[o*3+k]=Math.round(Math.pow(v,1/2.2)*255);
  }
}
function crc32(b){let c,crc=0xffffffff;for(let n=0;n<b.length;n++){c=(crc^b[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
const raw=Buffer.alloc(H*(W*3+1));
for(let y=0;y<H;y++){raw[y*(W*3+1)]=0;px.copy(raw,y*(W*3+1)+1,y*W*3,(y+1)*W*3);}
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const b=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(b));return Buffer.concat([l,b,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
fs.writeFileSync(process.argv[2] || '/tmp/runner-rig.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]));
console.log('已输出', process.argv[2] || '/tmp/runner-rig.png');
