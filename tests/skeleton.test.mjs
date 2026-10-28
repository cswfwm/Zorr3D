import { test } from 'node:test';
import assert from 'node:assert/strict';
import { m4, quat, v3, deg2rad } from '../engine/math.js';
import { Bone, Skeleton, computeWeights, skinPoint, MAX_BONES } from '../engine/skeleton.js';

// 两节骨骼：root 在原点，child 在 root 上方 1 个单位
function makeChain() {
  const root = new Bone('root', -1);
  const child = new Bone('child', 0);
  child.position = [0, 1, 0];
  const sk = new Skeleton([root, child]);
  sk.captureBindPose();
  return sk;
}

test('骨骼世界矩阵按父子层级累乘', () => {
  const sk = makeChain();
  sk.bones[0].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], Math.PI / 2);
  sk.update();
  // child 的本地偏移 (0,1,0) 被父级旋转 90° 后应落到 (-1,0,0)
  const w = sk.world[1];
  assert.ok(Math.abs(w[12] - -1) < 1e-5, `x=${w[12]}`);
  assert.ok(Math.abs(w[13]) < 1e-5, `y=${w[13]}`);
});

test('绑定姿势下蒙皮矩阵是单位阵', () => {
  const sk = makeChain();
  sk.update();
  for (let i = 0; i < sk.count; i++) {
    const o = i * 16;
    const expect = m4.create();
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(sk.skin[o + k] - expect[k]) < 1e-5, `骨骼 ${i} 第 ${k} 项 ${sk.skin[o + k]}`);
    }
  }
});

test('旋转根骨骼后，子骨骼顶点跟着动', () => {
  const sk = makeChain();
  const pos = [0, 1, 0]; // child 骨骼位置的顶点
  const idx = new Uint8Array([1, 0, 0, 0]);
  const w = new Float32Array([1, 0, 0, 0]);

  const before = skinPoint([0, 0, 0], pos, idx, w, sk.update());
  assert.ok(Math.abs(before[1] - 1) < 1e-5);

  sk.bones[0].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], deg2rad(90));
  const after = skinPoint([0, 0, 0], pos, idx, w, sk.update());
  assert.ok(Math.abs(after[0] - -1) < 1e-5, `x=${after[0]}`);
  assert.ok(Math.abs(after[1]) < 1e-5, `y=${after[1]}`);
});

// 三节竖直链：root(0,0,0) -> mid(0,1,0) -> tip(0,2,0)
function makeThree() {
  const root = new Bone('root', -1);
  const mid = new Bone('mid', 0);
  mid.position = [0, 1, 0];
  const tip = new Bone('tip', 1);
  tip.position = [0, 1, 0];
  const sk = new Skeleton([root, mid, tip]);
  sk.captureBindPose();
  return sk;
}

test('自动权重：顶点归给最近的骨骼且权重归一', () => {
  const sk = makeThree();
  const positions = [
    0, 0.0, 0,   // 正好在 root 关节上
    0, 2.05, 0,  // tip 骨骼延长段附近
  ];
  const { indices, weights } = computeWeights(positions, sk, { power: 6 });
  assert.equal(indices[0], 0, '靠近根部应绑定 root');
  assert.ok(weights[0] > 0.6, `权重 ${weights[0]}`);
  assert.equal(indices[4], 2, '上方顶点应绑定 tip');
  assert.ok(weights[4] > 0.6, `权重 ${weights[4]}`);
  for (const base of [0, 4]) {
    const sum = weights[base] + weights[base + 1] + weights[base + 2] + weights[base + 3];
    assert.ok(Math.abs(sum - 1) < 1e-5, `权重和 ${sum}`);
  }
});

test('自动权重在关节处是平滑过渡（有两个以上非零权重）', () => {
  const sk = makeThree();
  // y=1 正好是 root 与 mid 的关节位置
  const { weights } = computeWeights([0, 1, 0], sk, { power: 4 });
  const nz = [weights[0], weights[1], weights[2], weights[3]].filter((w) => w > 0.01).length;
  assert.ok(nz >= 2, `期望混合权重，实际 ${nz} 个`);
  // 骨骼中段则应接近硬绑定
  const mid = computeWeights([0, 0.5, 0], sk, { power: 4 }).weights;
  const midNz = [mid[0], mid[1], mid[2], mid[3]].filter((w) => w > 0.01).length;
  assert.equal(midNz, 1, '骨骼中段应只受一根骨骼影响');
});

test('序列化往返保留骨骼与逆绑定矩阵', () => {
  const sk = makeChain();
  sk.bones[0].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], 0.3);
  sk.update();
  const json = JSON.parse(JSON.stringify(sk.toJSON()));
  const sk2 = Skeleton.fromJSON(json);
  assert.equal(sk2.count, 2);
  assert.equal(sk2.bones[0].name, 'root');
  sk2.update();
  for (let k = 0; k < 16; k++) {
    assert.ok(Math.abs(sk2.skin[k] - sk.skin[k]) < 1e-5, `第 ${k} 项不一致`);
  }
});

test('恢复静止姿势', () => {
  const sk = makeChain();
  sk.bones[0].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], 1);
  sk.resetToRest();
  assert.equal(sk.bones[0].rotation[3], 1);
  assert.equal(sk.bones[0].rotation[2], 0);
});

test('骨骼末端位置可用于画骨架', () => {
  const sk = makeChain();
  const s0 = sk.restSegment(0);
  assert.deepEqual(s0.start.map((v) => +v.toFixed(3)), [0, 0, 0]);
  // root 无子骨骼位置的均值 = child 的 (0,1,0)
  assert.deepEqual(s0.end.map((v) => +v.toFixed(3)), [0, 1, 0]);
  void v3;
});

test('骨骼矩阵数组长度固定为 MAX_BONES，未用槽位是单位阵', () => {
  const sk = makeChain();
  sk.update();
  assert.equal(sk.skin.length, MAX_BONES * 16, '必须整块上传，长度固定');
  // 前两根骨骼是真实矩阵，其余必须是单位阵
  for (let i = sk.count; i < MAX_BONES; i++) {
    const o = i * 16;
    assert.equal(sk.skin[o], 1);
    assert.equal(sk.skin[o + 5], 1);
    assert.equal(sk.skin[o + 10], 1);
    assert.equal(sk.skin[o + 15], 1);
    assert.equal(sk.skin[o + 1], 0);
  }
});
