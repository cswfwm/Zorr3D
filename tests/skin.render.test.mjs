import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGL } from './helpers/fakegl.mjs';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from '../engine/rig.js';
import { MAX_BONES } from '../engine/skeleton.js';
import { quat } from '../engine/math.js';
import { AnimationPlayer } from '../engine/animation.js';

function rig() {
  const { gl, log } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: 640, clientHeight: 480, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(640, 480, 1, 1);
  const scene = new Scene(r);
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  const node = new SceneNode('角色');
  node.geometry = geo;
  node.mesh = r.ctx.uploadMesh(geo);
  node.material = defaultMaterial();
  node.skeleton = sk;
  node.animator = new AnimationPlayer();
  const clips = createBuiltinClips(sk);
  node.animator.play(clips[0], { loop: true });
  scene.addNode(node);
  scene.updateTransforms();
  return { r, scene, node, sk, log };
}

test('蒙皮网格上传后标记为 skinned 并生成骨骼缓冲', () => {
  const { node } = rig();
  assert.equal(node.mesh.skinned, true);
  assert.ok(node.mesh.boneBuffer, '应创建骨骼属性缓冲');
});

test('渲染时打开蒙皮开关并上传骨骼矩阵', () => {
  const { r, scene, sk, log } = rig();
  r.render(scene, scene.camera);
  assert.equal(log.uniformInts.get('uSkinned'), 1);
  // 骨骼数组必须按 MAX_BONES 整块上传，而不是按实际骨骼数
  const uploaded = log.matrix4Uploads && log.matrix4Uploads.some((m) => m.length === MAX_BONES * 16);
  assert.ok(uploaded, `应向 uSkinMats 上传 ${MAX_BONES}×16 的矩阵数组`);
  assert.equal(sk.skin.length, MAX_BONES * 16);
});

test('普通网格不会打开蒙皮开关', () => {
  const { r, scene, log } = rig();
  const box = new SceneNode('箱子');
  const geo = { positions: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1],
    uvs: [0,0, 1,0, 0,1], tangents: [1,0,0,1, 1,0,0,1, 1,0,0,1], indices: [0,1,2], vertexCount: 3, indexCount: 3 };
  box.geometry = geo;
  box.mesh = r.ctx.uploadMesh(geo);
  box.material = defaultMaterial();
  scene.addNode(box);
  scene.selected = null;
  log.uniformInts.clear();
  r.render(scene, scene.camera);
  // 最后一帧的物体若是箱子，则应写 0
  assert.ok([...log.uniformInts.values()].includes(0), '普通网格应收到 uSkinned=0');
});

test('动画推进后骨骼矩阵发生变化', () => {
  const { r, scene, sk } = rig();
  r.render(scene, scene.camera);
  const before = Float32Array.from(sk.skin);
  // 推进播放器
  for (let i = 0; i < 30; i++) sk.dirty = true;
  const node = scene.root.children[0];
  node.animator.update(0.6, sk);
  sk.update();
  const after = sk.skin;
  let diff = 0;
  for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i]);
  assert.ok(diff > 0.01, '骨骼矩阵应随动画变化');
});

test('同帧多具骨架各自拿到自己的骨骼矩阵（不会互相套用导致散架）', () => {
  const { gl, log } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: 640, clientHeight: 480, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(640, 480, 1, 1);
  const scene = new Scene(r);

  const mk = (x, angle) => {
    const sk = createHumanSkeleton();
    const geo = createHumanMesh(sk);
    const n = new SceneNode('角色');
    n.geometry = geo;
    n.mesh = r.ctx.uploadMesh(geo);
    n.material = defaultMaterial();
    n.skeleton = sk;
    n.position = [x, 0, 0];
    // 两具骨架姿势明显不同：一具抬起右臂
    const bi = sk.indexOf('upperArm.R');
    sk.bones[bi].rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], angle);
    sk.update();
    scene.addNode(n);
    return { n, sk };
  };

  const a = mk(-1.2, 1.2);
  const b = mk(1.2, 0);
  scene.updateTransforms();

  log.matrix4Uploads = [];
  r.render(scene, scene.camera);

  // 收集本帧上传过的骨骼数组（长度 == MAX_BONES*16）
  const uploads = (log.matrix4Uploads || []).filter((m) => m.length === MAX_BONES * 16);
  // 阴影通道 + 主通道，两具骨架至少各上传一次
  assert.ok(uploads.length >= 2, `应至少上传 2 次骨骼数组，实际 ${uploads.length}`);

  // 两具骨架的矩阵内容必须不同（说明没有被同一份数据覆盖）
  const uniq = new Set(uploads.map((m) => Array.from(m).map((v) => v.toFixed(4)).join(',')));
  assert.ok(uniq.size >= 2, '两具不同姿势的骨架不应上传完全相同的数据');

  // 且上传内容确实分别对应各自的 skin 数组
  const aKey = Array.from(a.sk.skin).map((v) => v.toFixed(4)).join(',');
  const bKey = Array.from(b.sk.skin).map((v) => v.toFixed(4)).join(',');
  const keys = new Set(uploads.map((m) => Array.from(m).map((v) => v.toFixed(4)).join(',')));
  assert.ok(keys.has(aKey), '第一具骨架的矩阵没有被上传');
  assert.ok(keys.has(bKey), '第二具骨架的矩阵没有被上传');
});
