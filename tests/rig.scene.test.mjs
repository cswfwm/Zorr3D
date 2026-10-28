import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGL } from './helpers/fakegl.mjs';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from '../engine/rig.js';
import { AnimationPlayer } from '../engine/animation.js';

function rig() {
  const { gl, log } = createFakeGL();
  const r = new Renderer({ width: 0, height: 0, clientWidth: 640, clientHeight: 480, getContext: () => gl });
  r.resize(640, 480, 1, 1);
  return { r, scene: new Scene(r), log };
}

function addCharacter(scene, r) {
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  const n = new SceneNode('角色');
  n.geometry = geo;
  n.mesh = r.ctx.uploadMesh(geo);
  n.material = defaultMaterial();
  n.skeleton = sk;
  n.rig = 'human';
  const clips = createBuiltinClips(sk);
  n.animator = new AnimationPlayer();
  n.animator.play(clips[2], { loop: true });
  n.clipJSON = clips[2].toJSON();
  scene.addNode(n);
  scene.updateTransforms();
  return n;
}

test('角色存入存档后能完整恢复（骨架 + 动作 + 网格）', () => {
  const { r, scene } = rig();
  addCharacter(scene, r);
  const json = JSON.parse(JSON.stringify(scene.toJSON()));
  const saved = json.root.children[0];
  assert.equal(saved.rig, 'human');
  assert.equal(saved.skeleton.bones.length, 19);
  assert.equal(saved.clip.name, '奔跑');

  const { r: r2, scene: scene2 } = rig();
  let rebuilt = 0;
  scene2.loadJSON(
    json,
    (g) => r2.ctx.uploadMesh(g),
    () => null,
    () => null,
    (sk) => { rebuilt++; return createHumanMesh(sk); },
  );
  const n = scene2.root.children[0];
  assert.equal(rebuilt, 1, '应重建一次角色几何');
  assert.equal(n.rig, 'human');
  assert.equal(n.skeleton.count, 19);
  assert.ok(n.mesh, '应重新上传网格');
  assert.equal(n.mesh.skinned, true);
  assert.equal(n.animator.clip.name, '奔跑');
  assert.equal(scene2.renderables().length, 1);
});

test('恢复后的角色能正常渲染并触发蒙皮', () => {
  const { r, scene, log } = rig();
  addCharacter(scene, r);
  const json = JSON.parse(JSON.stringify(scene.toJSON()));
  const { r: r2, scene: scene2, log: log2 } = rig();
  scene2.loadJSON(json, (g) => r2.ctx.uploadMesh(g), () => null, () => null, (sk) => createHumanMesh(sk));
  scene2.updateTransforms();
  log2.uniformInts.clear();
  r2.render(scene2, scene2.camera);
  assert.equal(log2.uniformInts.get('uSkinned'), 1);
  void log;
});

test('没有骨架数据的普通节点不受影响', () => {
  const { r, scene } = rig();
  const n = new SceneNode('箱子');
  n.geometry = { positions: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1],
    uvs: [0,0, 1,0, 0,1], tangents: [1,0,0,1, 1,0,0,1, 1,0,0,1], indices: [0,1,2], vertexCount: 3, indexCount: 3 };
  n.mesh = r.ctx.uploadMesh(n.geometry);
  n.material = defaultMaterial();
  scene.addNode(n);
  const json = JSON.parse(JSON.stringify(scene.toJSON()));
  const { r: r2, scene: scene2 } = rig();
  scene2.loadJSON(json, (g) => r2.ctx.uploadMesh(g), () => null, () => null, () => null);
  assert.equal(scene2.root.children[0].skeleton, null);
});
