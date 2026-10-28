import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGL } from './helpers/fakegl.mjs';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { PRIMITIVES } from '../engine/geometry.js';

function makeScene() {
  const { gl } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: 800, clientHeight: 600, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(800, 600, 1, 1);
  const scene = new Scene(r);
  scene.upload = (geo) => r.ctx.uploadMesh(geo);
  return scene;
}

function addBox(scene, name = 'box') {
  const n = new SceneNode(name);
  n.primitive = 'box';
  n.geometry = PRIMITIVES.box(1, 1, 1);
  n.mesh = scene.upload(n.geometry);
  n.material = defaultMaterial();
  scene.addNode(n);
  return n;
}

test('父子变换累乘到世界矩阵', () => {
  const scene = makeScene();
  const parent = addBox(scene, 'parent');
  const child = addBox(scene, 'child');
  parent.position = [10, 0, 0];
  child.position = [0, 2, 0];
  parent.add(child);
  scene.updateTransforms();
  assert.deepEqual([...child.worldMatrix.slice(12, 15)], [10, 2, 0]);
});

test('世界包围球随缩放变化', () => {
  const scene = makeScene();
  const n = addBox(scene);
  n.position = [0, 5, 0];
  n.scale = [2, 2, 2];
  scene.updateTransforms();
  assert.deepEqual(n.worldSphere.center, [0, 5, 0]);
  // 立方体包围球半径 sqrt(3)/2 ≈ 0.866，放大 2 倍
  assert.ok(Math.abs(n.worldSphere.radius - 0.866 * 2) < 0.01, String(n.worldSphere.radius));
});

test('射线拾取命中最近的物体', () => {
  const scene = makeScene();
  const near = addBox(scene, 'near');
  near.position = [0, 0, 0];
  const far = addBox(scene, 'far');
  far.position = [0, 0, -5];
  scene.camera.position = [0, 0, 5];
  scene.camera.target = [0, 0, 0];
  scene.updateTransforms();
  const hit = scene.pickRay([0, 0, 5], [0, 0, -1]);
  assert.equal(hit && hit.name, 'near');
});

test('射线没打中时返回 null', () => {
  const scene = makeScene();
  addBox(scene);
  scene.updateTransforms();
  assert.equal(scene.pickRay([10, 10, 10], [1, 0, 0]), null);
});

test('隐藏物体不可拾取', () => {
  const scene = makeScene();
  const n = addBox(scene);
  n.visible = false;
  scene.updateTransforms();
  assert.equal(scene.pickRay([0, 0, 5], [0, 0, -1]), null);
});

test('序列化往返保留变换与材质', () => {
  const scene = makeScene();
  const n = addBox(scene, 'painted');
  n.position = [1.5, 2, -3];
  n.setEulerDeg([0, 45, 0]);
  n.scale = [2, 3, 4];
  n.material.baseColor = [0.1, 0.2, 0.3, 1];
  n.material.metalness = 0.75;
  n.material.roughness = 0.2;
  scene.updateTransforms();
  const json = scene.toJSON();

  const scene2 = makeScene();
  scene2.loadJSON(JSON.parse(JSON.stringify(json)), (geo) => scene2.upload(geo));
  const n2 = scene2.root.children[0];
  assert.equal(n2.name, 'painted');
  assert.deepEqual(n2.position, [1.5, 2, -3]);
  assert.deepEqual(n2.scale, [2, 3, 4]);
  assert.ok(Math.abs(n2.material.metalness - 0.75) < 1e-6);
  assert.ok(Math.abs(n2.material.baseColor[2] - 0.3) < 1e-6);
  const e = n2.eulerDeg;
  assert.ok(Math.abs(e[1] - 45) < 0.01, JSON.stringify(e));
});

test('删除节点会移出层级', () => {
  const scene = makeScene();
  const n = addBox(scene);
  assert.equal(scene.root.children.length, 1);
  scene.removeNode(n);
  assert.equal(scene.root.children.length, 0);
  assert.equal(scene.selected, null);
});

test('包围盒忽略地面便于阴影拟合', () => {
  const scene = makeScene();
  const ground = addBox(scene, '地面');
  ground.geometry = PRIMITIVES.plane(200, 200);
  ground.mesh = scene.upload(ground.geometry);
  const small = addBox(scene, 'small');
  small.position = [0, 1, 0];
  scene.updateTransforms();
  const b = scene.bounds3D();
  assert.ok(b.radius < 20, `radius=${b.radius}`);
});

test('导入模型经 geometryKey 复原几何', () => {
  const scene = makeScene();
  const n = new SceneNode('导入件');
  n.geometryKey = 'geo-1';
  const geo = PRIMITIVES.torus(0.4, 0.15, 16, 8);
  n.geometry = geo;
  n.mesh = scene.upload(geo);
  n.material = defaultMaterial();
  scene.addNode(n);

  const json = JSON.parse(JSON.stringify(scene.toJSON()));
  assert.equal(json.root.children[0].geometryKey, 'geo-1');

  const scene2 = makeScene();
  let resolved = null;
  scene2.loadJSON(json, (g) => scene2.upload(g), () => null, (key) => {
    resolved = key;
    return geo;
  });
  assert.equal(resolved, 'geo-1');
  const n2 = scene2.root.children[0];
  assert.equal(n2.geometryKey, 'geo-1');
  assert.ok(n2.mesh, '几何应被重新上传');
  assert.equal(n2.geometry.indexCount, geo.indexCount);
});

test('缺少几何数据时节点仍保留但不渲染', () => {
  const scene = makeScene();
  const json = { root: { children: [{ name: '丢失', geometryKey: 'geo-none', material: {} }] } };
  scene.loadJSON(json, (g) => scene.upload(g), () => null, () => null);
  const n = scene.root.children[0];
  assert.equal(n.name, '丢失');
  assert.equal(n.mesh, null);
  assert.equal(scene.renderables().length, 0);
});
