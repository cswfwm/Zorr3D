// 骨骼：层级、绑定姿势、蒙皮矩阵。纯数据与数学，不依赖 GL。

import { m4, v3 } from "./math.js";

export const MAX_BONES_PER_VERTEX = 4;
// 与着色器里的 MAX_BONES 必须一致：由 shaders.js 直接引用这个常量注入。
// 上限同时受顶点 uniform 预算限制：uSkinMats[N] 占 N*4 个 vec4，
// GLES3 只保证 MAX_VERTEX_UNIFORM_VECTORS >= 256，还要留给模型/相机等矩阵，
// 32 根骨骼（128 个 vec4）是移动端的安全值，人形角色只需 19 根。
export const MAX_BONES = 32;

// 骨骼的局部变换用 TRS 表示；position 是相对父骨骼的偏移
export class Bone {
  constructor(name, parent = -1) {
    this.name = name;
    this.parent = parent;
    this.position = [0, 0, 0];
    this.rotation = [0, 0, 0, 1];
    this.scale = [1, 1, 1];
  }

  clone() {
    const b = new Bone(this.name, this.parent);
    b.position = [...this.position];
    b.rotation = [...this.rotation];
    b.scale = [...this.scale];
    return b;
  }
}

export class Skeleton {
  constructor(bones = []) {
    if (bones.length > MAX_BONES) {
      throw new Error(`骨骼数 ${bones.length} 超过上限 ${MAX_BONES}`);
    }
    this.bones = bones;
    this.invBind = bones.map(() => m4.create());
    this.local = bones.map(() => m4.create());
    this.world = bones.map(() => m4.create());
    // 上传给 GPU 的 4x4 蒙皮矩阵（列主序，每根骨骼 16 个 float）。
    // 长度固定为 MAX_BONES * 16：GLSL 的数组 uniform 必须整块上传，
    // 少于声明长度时会读到未定义的槽位，部分驱动直接拒绝。
    this.skin = new Float32Array(MAX_BONES * 16);
    for (let i = 0; i < MAX_BONES; i++) {
      this.skin[i * 16] = 1;
      this.skin[i * 16 + 5] = 1;
      this.skin[i * 16 + 10] = 1;
      this.skin[i * 16 + 15] = 1;
    }
    this.dirty = true;
    this.restPose = null;
  }

  get count() {
    return this.bones.length;
  }

  indexOf(name) {
    return this.bones.findIndex((b) => b.name === name);
  }

  // 用当前姿势作为绑定姿势，并记录逆绑定矩阵
  captureBindPose() {
    this.update();
    for (let i = 0; i < this.bones.length; i++) {
      const inv = m4.invert(m4.create(), this.world[i]);
      this.invBind[i] = inv || m4.create();
    }
    this.restPose = this.bones.map((b) => ({
      position: [...b.position],
      rotation: [...b.rotation],
      scale: [...b.scale],
    }));
    this.dirty = true;
  }

  resetToRest() {
    if (!this.restPose) return;
    for (let i = 0; i < this.bones.length; i++) {
      const p = this.restPose[i];
      const b = this.bones[i];
      b.position = [...p.position];
      b.rotation = [...p.rotation];
      b.scale = [...p.scale];
    }
    this.dirty = true;
  }

  // 逐骨骼计算局部矩阵与世界矩阵
  update() {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      m4.fromTRS(this.local[i], b.position, b.rotation, b.scale);
    }
    for (let i = 0; i < this.bones.length; i++) {
      const parent = this.bones[i].parent;
      if (parent >= 0) m4.multiply(this.world[i], this.world[parent], this.local[i]);
      else m4.copy(this.world[i], this.local[i]);
    }
    // 蒙皮矩阵 = 世界矩阵 * 逆绑定矩阵
    const scratch = this._scratch || (this._scratch = m4.create());
    // 超出 MAX_BONES 的骨骼不上传（顶点索引仍会指向它们，因此构建骨架时就应受此限制）
    const limit = Math.min(this.bones.length, MAX_BONES);
    for (let i = 0; i < limit; i++) {
      m4.multiply(scratch, this.world[i], this.invBind[i]);
      this.skin.set(scratch, i * 16);
    }

    this.dirty = false;
    return this.skin;
  }

  // 骨骼末端的绑定姿势位置（用于画骨骼线框与计算权重）
  // 骨骼线段：起点是骨骼在世界空间的位置，终点是子骨骼的平均位置；
  // 叶子骨骼按自身朝向向下延伸一小段，便于可视化与权重计算。
  restSegment(i) {
    const startPos = [this.world[i][12], this.world[i][13], this.world[i][14]];
    const children = [];
    for (let k = 0; k < this.bones.length; k++) {
      if (this.bones[k].parent === i) children.push(k);
    }
    let endPos;
    if (children.length) {
      endPos = [0, 0, 0];
      for (const c of children) {
        const cp = this.world[c];
        endPos[0] += cp[12] / children.length;
        endPos[1] += cp[13] / children.length;
        endPos[2] += cp[14] / children.length;
      }
    } else {
      const dir = v3.normalize([0, 0, 0], [
        this.world[i][4],
        this.world[i][5],
        this.world[i][6],
      ]);
      endPos = v3.add([0, 0, 0], startPos, v3.scale([0, 0, 0], dir, 0.12));
    }
    return { start: startPos, end: endPos };
  }

  toJSON() {
    return {
      bones: this.bones.map((b) => ({
        name: b.name,
        parent: b.parent,
        position: [...b.position],
        rotation: [...b.rotation],
        scale: [...b.scale],
      })),
      invBind: this.invBind.map((m) => Array.from(m)),
      restPose: this.restPose,
    };
  }

  static fromJSON(data) {
    const sk = new Skeleton(data.bones.map((b) => {
      const bone = new Bone(b.name, b.parent);
      bone.position = b.position;
      bone.rotation = b.rotation;
      bone.scale = b.scale;
      return bone;
    }));
    if (data.invBind) {
      sk.invBind = data.invBind.map((arr) => Float32Array.from(arr));
    }
    sk.restPose = data.restPose || null;
    sk.dirty = true;
    return sk;
  }
}

/* ---------------- 蒙皮权重 ---------------- */

// 点到线段的距离
function distToSegment(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 按"到骨骼线段的距离"自动生成蒙皮权重。
 * 每个顶点取最近的 4 根骨骼，权重按 1/d^power 分配并归一化，
 * power 越大过渡越硬（更接近刚体），越小则更平滑。
 */
export function computeWeights(positions, skeleton, options = {}) {
  const power = options.power ?? 4;
  // 平滑半径：顶点正落在骨骼线段上时分母不会变成 0，关节处才能自然过渡
  const smooth = options.smooth ?? 0.08;
  const maxInfluences = options.maxInfluences ?? MAX_BONES_PER_VERTEX;
  const bones = skeleton.bones;
  const segments = bones.map((_, i) => skeleton.restSegment(i));

  const n = positions.length / 3;
  const indices = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  const scored = new Array(bones.length);

  for (let v = 0; v < n; v++) {
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    for (let b = 0; b < bones.length; b++) {
      const d = distToSegment(p, segments[b].start, segments[b].end);
      scored[b] = { b, w: 1 / Math.pow(d + smooth, power) };
    }
    scored.sort((x, y) => y.w - x.w || x.b - y.b);
    let sum = 0;
    const count = Math.min(maxInfluences, bones.length);
    for (let k = 0; k < count; k++) sum += scored[k].w;
    for (let k = 0; k < count; k++) {
      indices[v * 4 + k] = scored[k].b;
      weights[v * 4 + k] = scored[k].w / sum;
    }
    for (let k = count; k < 4; k++) {
      indices[v * 4 + k] = 0;
      weights[v * 4 + k] = 0;
    }
  }
  return { indices, weights };
}

// 用蒙皮矩阵在 CPU 端变换顶点（用于测试与拾取）
export function skinPoint(out, p, indices, weights, skinMatrices) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 4; k++) {
    const w = weights[k];
    if (w === 0) continue;
    const o = indices[k] * 16;
    const m = skinMatrices;
    x += (m[o] * p[0] + m[o + 4] * p[1] + m[o + 8] * p[2] + m[o + 12]) * w;
    y += (m[o + 1] * p[0] + m[o + 5] * p[1] + m[o + 9] * p[2] + m[o + 13]) * w;
    z += (m[o + 2] * p[0] + m[o + 6] * p[1] + m[o + 10] * p[2] + m[o + 14]) * w;
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
