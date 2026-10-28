// 程序化人形：不依赖外部模型文件，直接生成带骨骼的白色人偶。
// 每个身体部件是独立的圆柱/球，权重直接绑定到对应骨骼（刚体绑定），
// 关节处用轻微重叠遮住缝隙，比自动权重更稳定、开销也更低。

import { Bone, Skeleton } from "./skeleton.js";
import { cylinder, sphere, box, computeBounds } from "./geometry.js";
import { buildClipFromFrames } from "./animation.js";


export const HUMAN_BONES = [
  // 名字,       父索引
  ["hips", -1],
  ["spine", 0],
  ["chest", 1],
  ["neck", 2],
  ["head", 3],
  ["shoulder.L", 2],
  ["upperArm.L", 5],
  ["forearm.L", 6],
  ["hand.L", 7],
  ["shoulder.R", 2],
  ["upperArm.R", 9],
  ["forearm.R", 10],
  ["hand.R", 11],
  ["thigh.L", 0],
  ["shin.L", 13],
  ["foot.L", 14],
  ["thigh.R", 0],
  ["shin.R", 16],
  ["foot.R", 17],
];

// 关节点位置（单位：米，y 向上，面朝 -Z）
const JOINTS = {
  hips: [0, 0.95, 0],
  spine: [0, 0.16, 0],
  chest: [0, 0.18, 0],
  neck: [0, 0.2, 0],
  head: [0, 0.16, 0],
  "shoulder.L": [0.09, 0.14, 0],
  "upperArm.L": [0.11, 0, 0],
  "forearm.L": [0, -0.28, 0],
  "hand.L": [0, -0.26, 0],
  "shoulder.R": [-0.09, 0.14, 0],
  "upperArm.R": [-0.11, 0, 0],
  "forearm.R": [0, -0.28, 0],
  "hand.R": [0, -0.26, 0],
  "thigh.L": [0.1, -0.04, 0],
  "shin.L": [0, -0.42, 0],
  "foot.L": [0, -0.4, 0],
  "thigh.R": [-0.1, -0.04, 0],
  "shin.R": [0, -0.42, 0],
  "foot.R": [0, -0.4, 0],
};

export function createHumanSkeleton() {
  const bones = HUMAN_BONES.map(([name, parent]) => {
    const b = new Bone(name, parent);
    b.position = [...JOINTS[name]];
    return b;
  });
  const sk = new Skeleton(bones);
  sk.update();
  sk.captureBindPose();
  return sk;
}

/* ---------------- 部件定义 ---------------- */

// 每个部件：绑定骨骼、形状、尺寸、在骨骼局部空间的偏移
// 骨骼的局部 -Y 是"向下/向外"方向（与骨骼链方向一致）
const PARTS = [
  { bone: "hips", kind: "box", size: [0.26, 0.18, 0.16], offset: [0, 0.03, 0] },
  { bone: "spine", kind: "box", size: [0.24, 0.2, 0.15], offset: [0, 0.09, 0] },
  { bone: "chest", kind: "box", size: [0.3, 0.24, 0.17], offset: [0, 0.1, 0] },
  { bone: "neck", kind: "cylinder", size: [0.05, 0.07], offset: [0, 0.03, 0] },
  { bone: "head", kind: "sphere", size: [0.115], offset: [0, 0.11, 0] },
  // 肩部球体绑在上臂（而不是 shoulder 骨骼）上：它要跟着手臂一起转，
  // 否则手臂抬起时肩头会露缝，看起来像断掉
  { bone: "upperArm.L", kind: "sphere", size: [0.068], offset: [0.02, 0, 0] },
  { bone: "upperArm.R", kind: "sphere", size: [0.068], offset: [-0.02, 0, 0] },
  { bone: "upperArm.L", kind: "cylinder", size: [0.052, 0.055], offset: [0, -0.14, 0], len: 0.28 },
  { bone: "upperArm.R", kind: "cylinder", size: [0.052, 0.055], offset: [0, -0.14, 0], len: 0.28 },
  { bone: "forearm.L", kind: "cylinder", size: [0.045, 0.05], offset: [0, -0.13, 0], len: 0.26 },
  { bone: "forearm.R", kind: "cylinder", size: [0.045, 0.05], offset: [0, -0.13, 0], len: 0.26 },
  { bone: "hand.L", kind: "sphere", size: [0.048], offset: [0, -0.04, 0] },
  { bone: "hand.R", kind: "sphere", size: [0.048], offset: [0, -0.04, 0] },
  { bone: "thigh.L", kind: "cylinder", size: [0.06, 0.07], offset: [0, -0.21, 0], len: 0.42 },
  { bone: "thigh.R", kind: "cylinder", size: [0.06, 0.07], offset: [0, -0.21, 0], len: 0.42 },
  { bone: "thigh.L", kind: "sphere", size: [0.065], offset: [0, 0, 0] },
  { bone: "thigh.R", kind: "sphere", size: [0.065], offset: [0, 0, 0] },
  { bone: "shin.L", kind: "cylinder", size: [0.05, 0.055], offset: [0, -0.2, 0], len: 0.4 },
  { bone: "shin.R", kind: "cylinder", size: [0.05, 0.055], offset: [0, -0.2, 0], len: 0.4 },
  { bone: "foot.L", kind: "box", size: [0.09, 0.07, 0.2], offset: [0, -0.03, -0.05] },
  { bone: "foot.R", kind: "box", size: [0.09, 0.07, 0.2], offset: [0, -0.03, -0.05] },
];

// 把几何体沿局部 -Y 轴拉伸成"骨骼包裹"的形状
function limbGeometry(kind, size, len) {
  if (kind === "sphere") return sphere(size[0], 20, 14);
  if (kind === "box") return box(size[0], size[1], size[2]);
  const [top, bottom] = size;
  return cylinder(top, bottom, len ?? 0.2, 20, true);
}

/**
 * 生成人形网格：
 * 返回 { positions, normals, uvs, tangents, indices, skinIndices, skinWeights }
 * 每个顶点只受一根骨骼影响（刚体绑定），权重为 1。
 */
export function createHumanMesh(skeleton) {
  const positions = [], normals = [], uvs = [], indices = [], skinIndices = [], skinWeights = [];

  for (const part of PARTS) {
    const boneIndex = skeleton.indexOf(part.bone);
    if (boneIndex < 0) continue;
    const bone = skeleton.bones[boneIndex];
    const geo = limbGeometry(part.kind, part.size, part.len);

    // 部件在骨骼的绑定世界空间里放置：骨骼的偏移量是相对父级的，
    // 直接用骨骼世界矩阵，保证父子骨骼一起运动时部件不会错位。
    const worldPos = [skeleton.world[boneIndex][12], skeleton.world[boneIndex][13], skeleton.world[boneIndex][14]];
    const q = mat3ToQuat(skeleton.world[boneIndex]);

    const base = positions.length / 3;
    const n = geo.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const p = [geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]];
      const np = rotateVec(q, [
        p[0] + part.offset[0],
        p[1] + part.offset[1],
        p[2] + part.offset[2],
      ]);
      positions.push(np[0] + worldPos[0], np[1] + worldPos[1], np[2] + worldPos[2]);
      const nn = rotateVec(q, [geo.normals[i * 3], geo.normals[i * 3 + 1], geo.normals[i * 3 + 2]]);
      normals.push(nn[0], nn[1], nn[2]);
      uvs.push(geo.uvs[i * 2], geo.uvs[i * 2 + 1]);
      skinIndices.push(boneIndex, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
    for (let i = 0; i < geo.indices.length; i++) indices.push(base + geo.indices[i]);
  }

  // 切线：人形是纯色白模，法线贴图用不上，给默认值即可
  const tangents = new Array((positions.length / 3) * 4).fill(0);
  for (let i = 0; i < positions.length / 3; i++) {
    tangents[i * 4] = 1;
    tangents[i * 4 + 3] = 1;
  }

  const geo = {
    positions,
    normals,
    uvs,
    tangents,
    indices,
    vertexCount: positions.length / 3,
    indexCount: indices.length,
    skinIndices: new Uint8Array(skinIndices),
    skinWeights: new Float32Array(skinWeights),
  };
  geo.bounds = computeBounds(geo);
  return geo;
}

// 从世界矩阵的 3x3 部分恢复旋转（人形骨骼没有非均匀缩放）
function mat3ToQuat(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [
    m[0] / sx, m[1] / sx, m[2] / sx,
    m[4] / sy, m[5] / sy, m[6] / sy,
    m[8] / sz, m[9] / sz, m[10] / sz,
  ];
  const tr = r[0] + r[4] + r[8];
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (r[7] - r[5]) / s; y = (r[2] - r[6]) / s; z = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    w = (r[7] - r[5]) / s; x = 0.25 * s; y = (r[1] + r[3]) / s; z = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    w = (r[2] - r[6]) / s; x = (r[1] + r[3]) / s; y = 0.25 * s; z = (r[5] + r[7]) / s;
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    w = (r[3] - r[1]) / s; x = (r[2] + r[6]) / s; y = (r[5] + r[7]) / s; z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

function rotateVec(q, v) {
  const [x, y, z, w] = q;
  // q * v * q^-1
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

// 骨骼的世界位置（用于画骨架线框）
export function boneSegments(skeleton) {
  skeleton.update();
  return skeleton.bones.map((b, i) => skeleton.restSegment(i));
}

/* ---------------- 内置动作 ---------------- */

// 用"关节名 → 欧拉角（度）"的关键帧快速搭动作
function clip(name, duration, frames, skeleton) {
  return buildClipFromFrames(name, duration, frames, skeleton);
}

// 待机：轻微呼吸与手臂摆动
export function idleClip(skeleton) {
  const f = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8 * 2.4;
    const s = Math.sin((i / 8) * Math.PI * 2);
    f.push([t, {
      spine: [s * 1.2, 0, 0],
      chest: [s * 1.6, 0, 0],
      head: [-s * 0.8, s * 2.5, 0],
      "upperArm.L": [0, 0, -4 + s * 1.5],
      "upperArm.R": [0, 0, 4 - s * 1.5],
      "forearm.L": [-6 - s * 2, 0, 0],
      "forearm.R": [-6 - s * 2, 0, 0],
    }]);
  }
  return clip("待机", 2.4, f, skeleton);
}

// 行走：四肢交替摆动
export function walkClip(skeleton) {
  const frames = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 1.1;
    const a = (i / steps) * Math.PI * 2;
    const s = Math.sin(a), c = Math.cos(a);
    frames.push([t, {
      hips: [0, s * 4, 0],
      spine: [2, -s * 3, 0],
      chest: [1, s * 2, 0],
      "thigh.L": [s * 26, 0, 0],
      "thigh.R": [-s * 26, 0, 0],
      "shin.L": [Math.max(0, -s) * 34, 0, 0],
      "shin.R": [Math.max(0, s) * 34, 0, 0],
      "foot.L": [-s * 10, 0, 0],
      "foot.R": [s * 10, 0, 0],
      "upperArm.L": [-s * 20, 0, -5],
      "upperArm.R": [s * 20, 0, 5],
      "forearm.L": [-18 - Math.max(0, s) * 12, 0, 0],
      "forearm.R": [-18 - Math.max(0, -s) * 12, 0, 0],
    }]);
    void c;
  }
  return clip("行走", 1.1, frames, skeleton);
}

// 奔跑：更大的步幅与前倾
export function runClip(skeleton) {
  const frames = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 0.72;
    const a = (i / steps) * Math.PI * 2;
    const s = Math.sin(a);
    frames.push([t, {
      hips: [6, s * 6, 0],
      spine: [10, -s * 4, 0],
      chest: [6, s * 3, 0],
      head: [-8, 0, 0],
      "thigh.L": [s * 46, 0, 0],
      "thigh.R": [-s * 46, 0, 0],
      "shin.L": [Math.max(0, -s) * 70, 0, 0],
      "shin.R": [Math.max(0, s) * 70, 0, 0],
      "foot.L": [-s * 16, 0, 0],
      "foot.R": [s * 16, 0, 0],
      "upperArm.L": [-s * 48, 0, -8],
      "upperArm.R": [s * 48, 0, 8],
      "forearm.L": [-70, 0, 0],
      "forearm.R": [-70, 0, 0],
    }]);
  }
  return clip("奔跑", 0.72, frames, skeleton);
}

// 挥手
export function waveClip(skeleton) {
  const frames = [];
  for (let i = 0; i <= 6; i++) {
    const t = (i / 6) * 1.6;
    const s = Math.sin((i / 6) * Math.PI * 4);
    frames.push([t, {
      "shoulder.R": [0, 0, -14],
      "upperArm.R": [0, 0, -88],
      "forearm.R": [0, 0, -26 + s * 22],
      "hand.R": [0, 0, s * 10],
      head: [0, -10, 0],
      chest: [0, -6, 0],
    }]);
  }
  return clip("挥手", 1.6, frames, skeleton);
}

// 跳跃：下蹲、起跳、张开、落地
export function jumpClip(skeleton) {
  return clip("跳跃", 1.2, [
    [0, { "thigh.L": [-10, 0, 0], "thigh.R": [-10, 0, 0], "shin.L": [20, 0, 0], "shin.R": [20, 0, 0], hips: [4, 0, 0] }],
    [0.18, { "thigh.L": [-45, 0, 0], "thigh.R": [-45, 0, 0], "shin.L": [80, 0, 0], "shin.R": [80, 0, 0], spine: [18, 0, 0], "upperArm.L": [40, 0, 0], "upperArm.R": [40, 0, 0] }],
    [0.42, { "thigh.L": [20, 0, 0], "thigh.R": [-5, 0, 0], "shin.L": [10, 0, 0], "shin.R": [45, 0, 0], spine: [-6, 0, 0], "upperArm.L": [-150, 0, -10], "upperArm.R": [-150, 0, 10] }],
    [0.8, { "thigh.L": [-20, 0, 0], "thigh.R": [-20, 0, 0], "shin.L": [55, 0, 0], "shin.R": [55, 0, 0], spine: [10, 0, 0], "upperArm.L": [10, 0, -20], "upperArm.R": [10, 0, 20] }],
    [1.2, { "thigh.L": [0, 0, 0], "thigh.R": [0, 0, 0], "shin.L": [0, 0, 0], "shin.R": [0, 0, 0], spine: [0, 0, 0], "upperArm.L": [0, 0, -4], "upperArm.R": [0, 0, 4] }],
  ], skeleton);
}

export const BUILTIN_CLIPS = [
  ["待机", idleClip],
  ["行走", walkClip],
  ["奔跑", runClip],
  ["挥手", waveClip],
  ["跳跃", jumpClip],
];

export function createBuiltinClips(skeleton) {
  return BUILTIN_CLIPS.map(([, fn]) => fn(skeleton));
}
