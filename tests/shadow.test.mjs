import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGL } from './helpers/fakegl.mjs';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { PRIMITIVES } from '../engine/geometry.js';

function rig() {
  const { gl, log } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: 640, clientHeight: 400, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(640, 400, 1, 1);
  const scene = new Scene(r);
  const n = new SceneNode('box');
  n.geometry = PRIMITIVES.box(1, 1, 1);
  n.mesh = r.ctx.uploadMesh(n.geometry);
  n.material = defaultMaterial();
  n.position = [0, 0.5, 0];
  scene.addNode(n);
  return { r, scene, log, n };
}

test('开启阴影时着色器收到 uReceiveShadow = 1', () => {
  const { r, scene, log } = rig();
  r.shadow.enabled = true;
  r.render(scene, scene.camera);
  assert.equal(log.uniformInts.get('uReceiveShadow'), 1);
});

test('关闭阴影时着色器收到 uReceiveShadow = 0', () => {
  const { r, scene, log } = rig();
  r.shadow.enabled = false;
  r.render(scene, scene.camera);
  assert.equal(log.uniformInts.get('uReceiveShadow'), 0);
});

test('阴影贴图按尺寸创建并可切换', () => {
  const { r } = rig();
  r.setShadowSize(512);
  assert.ok(r.shadow.tex);
  assert.equal(r.shadow.size, 512);
  const first = r.shadow.tex;
  r.setShadowSize(1024);
  assert.notEqual(r.shadow.tex, first);
  assert.equal(r.shadow.size, 1024);
});

test('阴影矩阵把场景中心投到贴图中心附近', () => {
  const { r, scene } = rig();
  scene.updateTransforms();
  const b = scene.bounds3D();
  const dir = [-0.44, -0.83, -0.34];
  const m = r.computeShadowMatrix(b.center, b.radius, dir);
  const clip = [0, 0, 0, 0];
  const c = b.center;
  clip[0] = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
  clip[1] = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
  clip[2] = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
  clip[3] = m[3] * c[0] + m[7] * c[1] + m[11] * c[2] + m[15];
  assert.ok(Math.abs(clip[0] / clip[3]) < 0.02, `x=${clip[0] / clip[3]}`);
  assert.ok(Math.abs(clip[1] / clip[3]) < 0.02, `y=${clip[1] / clip[3]}`);
  assert.ok(clip[2] / clip[3] > -1 && clip[2] / clip[3] < 1, 'z 应在裁剪体内');
});
