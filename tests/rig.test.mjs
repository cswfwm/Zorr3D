import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quat, deg2rad } from '../engine/math.js';
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from '../engine/rig.js';
import { skinPoint } from '../engine/skeleton.js';

const findBone = (sk, name) => sk.indexOf(name);

test('人形骨架包含必要关节且父子关系正确', () => {
  const sk = createHumanSkeleton();
  const names = sk.bones.map((b) => b.name);
  for (const n of ['hips', 'spine', 'chest', 'head', 'upperArm.L', 'forearm.R', 'thigh.L', 'foot.R']) {
    assert.ok(names.includes(n), `缺少骨骼 ${n}`);
  }
  assert.equal(sk.bones[findBone(sk, 'head')].parent, findBone(sk, 'neck'));
  assert.equal(sk.bones[findBone(sk, 'shin.L')].parent, findBone(sk, 'thigh.L'));
  // 每根非根骨骼的父索引必须小于自身，保证拓扑有序
  sk.bones.forEach((b, i) => {
    if (b.parent >= 0) assert.ok(b.parent < i, `${b.name} 的父索引 ${b.parent} 应小于 ${i}`);
  });
});

test('人形网格的蒙皮数据完整且指向有效骨骼', () => {
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  assert.ok(geo.vertexCount > 500, `顶点数 ${geo.vertexCount}`);
  assert.equal(geo.skinIndices.length, geo.vertexCount * 4);
  assert.equal(geo.skinWeights.length, geo.vertexCount * 4);
  for (let i = 0; i < geo.vertexCount; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const bi = geo.skinIndices[i * 4 + k];
      assert.ok(bi < sk.count, `顶点 ${i} 指向不存在的骨骼 ${bi}`);
      sum += geo.skinWeights[i * 4 + k];
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, `顶点 ${i} 权重和 ${sum}`);
  }
});

test('人形整体高度合理（约 1.7~2.0 米）', () => {
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  const h = geo.bounds.max[1] - geo.bounds.min[1];
  assert.ok(h > 1.6 && h < 2.1, `身高 ${h}`);
});

test('抬手臂时手臂顶点跟着抬起', () => {
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  const i = findBone(sk, 'upperArm.L');

  // 找一个属于上臂、且离肩关节最远的顶点（靠近肘部，旋转位移最明显）
  let vi = -1;
  let best = -1;
  for (let v = 0; v < geo.vertexCount; v++) {
    if (geo.skinIndices[v * 4] !== i) continue;
    const y = geo.positions[v * 3 + 1];
    const d = Math.abs(y - 1.45);
    if (d > best) { best = d; vi = v; }
  }
  assert.ok(vi >= 0, '没有找到上臂顶点');

  const p = [geo.positions[vi * 3], geo.positions[vi * 3 + 1], geo.positions[vi * 3 + 2]];
  const idx = geo.skinIndices.subarray(vi * 4, vi * 4 + 4);
  const w = geo.skinWeights.subarray(vi * 4, vi * 4 + 4);

  const before = skinPoint([0, 0, 0], p, idx, w, sk.update());
  sk.bones[i].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], deg2rad(80));
  const after = skinPoint([0, 0, 0], p, idx, w, sk.update());

  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  assert.ok(moved > 0.05, `顶点几乎没动（${moved}）`);
  // 绕 Z 轴正向旋转 80° 会把左臂从垂下抬向外侧上方
  assert.ok(after[1] > before[1] + 0.05, `手臂应抬起：y ${before[1]} -> ${after[1]}`);
  assert.ok(after[0] > before[0], `应向外侧展开：x ${before[0]} -> ${after[0]}`);
});

test('五个内置动作都在骨骼上产生了实际变化', () => {
  const sk = createHumanSkeleton();
  const clips = createBuiltinClips(sk);
  assert.equal(clips.length, 5);
  for (const c of clips) {
    assert.ok(c.duration > 0.3, `${c.name} 时长过短`);
    assert.ok(c.tracks.length >= 4, `${c.name} 轨道过少`);
    // 采样中途某一帧，至少有一根骨骼与静止姿势不同
    const pose = c.tracks.map((tr) => ({ tr, mid: tr.rot ? tr.rot[Math.floor(tr.rot.length / 2)] : null }))
      .filter((x) => x.mid && Math.abs(x.mid[4] - 1) > 1e-3);
    assert.ok(pose.length >= 1, `${c.name} 没有产生旋转`);
  }
});
