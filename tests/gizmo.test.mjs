import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGL } from './helpers/fakegl.mjs';
import { m4, v3, quat, deg2rad } from '../engine/math.js';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { PRIMITIVES } from '../engine/geometry.js';
import { Gizmo } from '../engine/gizmo.js';

const W = 1000, H = 800;

function setup() {
  const { gl } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: W, clientHeight: H, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(W, H, 1, 1);
  const scene = new Scene(r);
  const box = new SceneNode('box');
  box.primitive = 'box';
  box.geometry = PRIMITIVES.box(1, 1, 1);
  box.mesh = r.ctx.uploadMesh(box.geometry);
  box.material = defaultMaterial();
  scene.addNode(box);
  scene.camera.position = [0, 0, 8];
  scene.camera.target = [0, 0, 0];
  scene.updateTransforms();
  const gizmo = new Gizmo(r);
  gizmo.setGeometryLib({
    box: PRIMITIVES.box,
    cylinder: () => PRIMITIVES.cylinder(),
    cone: () => PRIMITIVES.cone(),
    torus: () => PRIMITIVES.torus(),
    sphere: () => PRIMITIVES.sphere(),
  });
  const vp = m4.multiply(m4.create(), m4.perspective(m4.create(), deg2rad(55), W / H, 0.1, 500), scene.camera.viewMatrix());
  return { r, scene, box, gizmo, vp };
}

test('世界坐标 X 轴在屏幕上可被命中', () => {
  const { box, gizmo, vp } = setup();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  const tip = gizmo.project([1, 0, 0], vp, W, H);
  const midX = (center[0] + tip[0]) / 2, midY = (center[1] + tip[1]) / 2;
  assert.equal(gizmo.hitTest(box, midX, midY, W, H, vp), 'x');
  assert.notEqual(gizmo.hitTest(box, center[0] + 200, center[1] - 150, W, H, vp), 'x');
});

test('沿 X 轴拖动只改变 X 且方向正确', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  const tip = gizmo.project([1, 0, 0], vp, W, H);
  const startX = (center[0] + tip[0]) / 2;
  gizmo.begin(box, 'x', startX, center[1], vp);
  gizmo.update(tip[0] + 50, center[1], vp, W, H, 0, scene.camera);
  assert.ok(box.position[0] > 0.1, `x=${box.position[0]}`);
  assert.ok(Math.abs(box.position[1]) < 1e-6);
  assert.ok(Math.abs(box.position[2]) < 1e-6);
});

test('反向拖动产生反向位移', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  gizmo.begin(box, 'x', center[0] + 40, center[1], vp);
  gizmo.update(center[0] - 40, center[1], vp, W, H, 0, scene.camera);
  assert.ok(box.position[0] < -0.05, `x=${box.position[0]}`);
});

test('吸附把位移量化到整数', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  const tip = gizmo.project([1, 0, 0], vp, W, H);
  gizmo.begin(box, 'x', center[0], center[1], vp);
  gizmo.update(tip[0] * 1.37, center[1], vp, W, H, 1, scene.camera);
  assert.equal(box.position[0], Math.round(box.position[0]));
});

test('Y 轴拖动受世界重力方向影响', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  gizmo.begin(box, 'y', center[0], center[1], vp);
  gizmo.update(center[0], center[1] - 60, vp, W, H, 0, scene.camera);
  assert.ok(box.position[1] > 0.1, `y=${box.position[1]}`);
});

test('旋转以轴心之外的鼠标角度驱动', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'rotate';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  gizmo.begin(box, 'y', center[0] + 50, center[1], vp);
  gizmo.update(center[0], center[1] + 50, vp, W, H, 0, scene.camera);
  const e = box.eulerDeg;
  assert.ok(Math.abs(e[1]) > 5, `euler=${JSON.stringify(e)}`);
});

test('缩放轴向上拖动放大，反向缩小', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'scale';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  const tip = gizmo.project([1, 0, 0], vp, W, H);
  gizmo.begin(box, 'x', tip[0] / 2, center[1], vp);
  gizmo.update(tip[0], center[1], vp, W, H, 0, scene.camera);
  assert.ok(box.scale[0] > 1, `scale=${box.scale[0]}`);
  assert.ok(Math.abs(box.scale[1] - 1) < 1e-6, '只有 X 被缩放');
});

test('整体缩放在三条轴上等比变化', () => {
  const { scene, box, gizmo, vp } = setup();
  gizmo.mode = 'scale';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  gizmo.begin(box, 'all', center[0], center[1], vp);
  gizmo.update(center[0] + 80, center[1], vp, W, H, 0, scene.camera);
  assert.ok(box.scale[0] > 1);
  assert.ok(Math.abs(box.scale[0] - box.scale[1]) < 1e-6);
  assert.ok(Math.abs(box.scale[1] - box.scale[2]) < 1e-6);
});

test('选择工具下不产生命中', () => {
  const { box, gizmo, vp } = setup();
  gizmo.mode = 'select';
  assert.equal(gizmo.hitTest(box, 500, 400, W, H, vp), null);
});

test('父节点带旋转时子节点位移仍在世界空间正确', () => {
  const { scene, gizmo, vp } = setup();
  const child = new SceneNode('child');
  child.geometry = PRIMITIVES.box(1, 1, 1);
  child.mesh = scene.upload ? scene.upload(child.geometry) : null;
  child.material = defaultMaterial();
  const parent = scene.root.children[0];
  parent.rotation = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], Math.PI / 2);
  parent.add(child);
  parent.markDirty();
  scene.updateTransforms();
  gizmo.mode = 'move';
  const center = gizmo.project([0, 0, 0], vp, W, H);
  const tip = gizmo.project([1, 0, 0], vp, W, H);
  gizmo.begin(child, 'x', center[0], center[1], vp);
  gizmo.update(tip[0], center[1], vp, W, H, 0, scene.camera);
  // 父级绕 Z 旋转 90°，世界 +X 对应本地 -Y
  assert.ok(child.position[1] < -0.1, `local=${JSON.stringify(child.position)}`);
});

void v3;
