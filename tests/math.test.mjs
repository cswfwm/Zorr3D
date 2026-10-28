import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  m4, v3, quat, rayTriangle, rayAABB, rayPlaneY, deg2rad,
} from '../engine/math.js';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearV = (a, b, eps = 1e-5) => a.forEach((v, i) => near(v, b[i], eps));

test('mat4 单位矩阵与乘法', () => {
  const I = m4.create();
  const t = m4.create();
  m4.fromTRS(t, [1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
  const r = m4.multiply(m4.create(), I, t);
  nearV([...r], [...t]);
});

test('fromTRS 平移/旋转/缩放组合', () => {
  const q = quat.fromAxisAngle([0, 0, 0], [0, 1, 0], deg2rad(90));
  const m = m4.fromTRS(m4.create(), [0, 0, 0], q, [2, 2, 2]);
  const p = v3.transformMat4([0, 0, 0], [1, 0, 0], m);
  nearV([p[0], p[1], p[2]], [0, 0, -2], 1e-4);
});

test('invert 与乘法互逆', () => {
  const m = m4.fromTRS(m4.create(), [3, -2, 5], quat.fromEulerXYZ([0, 0, 0], 0.3, 0.8, -0.2), [1.5, 2, 0.5]);
  const inv = m4.invert(m4.create(), m);
  const prod = m4.multiply(m4.create(), m, inv);
  const I = m4.create();
  nearV([...prod], [...I], 1e-4);
});

test('perspective 把近裁面映射到 -1', () => {
  const p = m4.perspective(m4.create(), deg2rad(60), 1.5, 0.1, 100);
  const pt = v3.transformMat4([0, 0, 0], [0, 0, -0.1], p);
  near(pt[2], -1, 1e-4);
  const far = v3.transformMat4([0, 0, 0], [0, 0, -100], p);
  near(far[2], 1, 1e-4);
});

test('lookAt 朝向目标', () => {
  const m = m4.lookAt(m4.create(), [0, 5, 10], [0, 0, 0], [0, 1, 0]);
  const o = v3.transformMat4([0, 0, 0], [0, 0, 0], m);
  nearV([o[0], o[1], o[2]], [0, 0, -11.1803], 1e-3);
  const fwd = v3.transformDir([0, 0, 0], [0, 0, -1], m);
  near(fwd[1], 0.4472, 1e-3);
});

test('欧拉角与四元数往返一致', () => {
  const e = [0.2, -0.7, 1.1];
  const q = quat.fromEulerXYZ([0, 0, 0, 1], e[0], e[1], e[2]);
  const back = quat.toEulerXYZ(q);
  nearV(back, e, 1e-4);
});

test('射线命中三角形与未命中', () => {
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0];
  assert.ok(rayTriangle([0.2, 0.2, 1], [0, 0, -1], a, b, c) > 0);
  assert.equal(rayTriangle([5, 5, 1], [0, 0, -1], a, b, c), -1);
});

test('射线与 AABB / 地面求交', () => {
  const t = rayAABB([0, 5, 0], [0, -1, 0], [-1, -1, -1], [1, 1, 1]);
  near(t, 4, 1e-5);
  assert.equal(rayAABB([10, 5, 0], [0, -1, 0], [-1, -1, -1], [1, 1, 1]), -1);
  near(rayPlaneY([0, 4, 0], [0, -1, 0], 0), 4, 1e-6);
  assert.equal(rayPlaneY([0, 4, 0], [0, 1, 0], 0), -1);
});

test('slerp 两端点稳定', () => {
  const a = quat.fromEulerXYZ([0, 0, 0, 1], 0, 0, 0);
  const b = quat.fromEulerXYZ([0, 0, 0, 1], 0, Math.PI / 2, 0);
  const m = quat.slerp([0, 0, 0, 1], a, b, 0.5);
  const e = quat.toEulerXYZ(m);
  near(e[1], Math.PI / 4, 1e-4);
});
