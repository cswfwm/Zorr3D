import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere, cylinder, torus, plane, parseOBJ, computeBounds, PRIMITIVES } from '../engine/geometry.js';

const all = (geo) => {
  assert.ok(geo.positions.length > 0);
  assert.equal(geo.normals.length, geo.positions.length);
  assert.equal(geo.uvs.length, geo.positions.length - (geo.positions.length / 3) * 1 + 0 === 0 ? 0 : geo.positions.length / 3 * 2);
  assert.equal(geo.tangents.length, (geo.positions.length / 3) * 4);
  assert.equal(geo.indexCount, geo.indices.length);
  assert.ok(geo.indices.every((i) => i >= 0 && i < geo.vertexCount), '索引越界');
};

test('各程序化几何体结构完整', () => {
  for (const name of Object.keys(PRIMITIVES)) {
    const g = PRIMITIVES[name]();
    assert.ok(g.positions.length > 0, name);
    assert.equal(g.normals.length, g.positions.length, name);
    assert.equal(g.uvs.length, (g.positions.length / 3) * 2, name);
    assert.equal(g.tangents.length, (g.positions.length / 3) * 4, name);
    assert.ok(g.indices.every((i) => i >= 0 && i < g.vertexCount), name + ' 索引越界');
    assert.equal(g.indices.length % 3, 0, name);
  }
});

test('box 尺寸与法线正确', () => {
  const b = box(2, 4, 6);
  const bounds = computeBounds(b);
  assert.deepEqual(bounds.min.map((v) => +v.toFixed(5)), [-1, -2, -3]);
  assert.deepEqual(bounds.max.map((v) => +v.toFixed(5)), [1, 2, 3]);
  // 每个法线应是单位轴向量
  for (let i = 0; i < b.normals.length; i += 3) {
    const l = Math.hypot(b.normals[i], b.normals[i + 1], b.normals[i + 2]);
    assert.ok(Math.abs(l - 1) < 1e-5);
  }
  assert.equal(b.vertexCount, 24);
});

test('sphere 顶点落在球面上且法线与位置同向', () => {
  const r = 2;
  const s = sphere(r, 16, 12);
  for (let i = 0; i < s.positions.length; i += 3) {
    const l = Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]);
    assert.ok(Math.abs(l - r) < 1e-4);
    const d = (s.positions[i] * s.normals[i] + s.positions[i + 1] * s.normals[i + 1] + s.positions[i + 2] * s.normals[i + 2]) / (l * 1);
    assert.ok(Math.abs(d - 1) < 1e-4);
  }
});

test('cylinder/cone/torus/plane 法线为单位向量', () => {
  for (const g of [cylinder(), torus(), plane()]) {
    for (let i = 0; i < g.normals.length; i += 3) {
      const l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
      assert.ok(Math.abs(l - 1) < 1e-3, '法线长度 ' + l);
    }
  }
});

test('切线单位化且与法线正交', () => {
  const g = sphere(1, 12, 8);
  for (let i = 0; i < g.vertexCount; i++) {
    const nx = g.normals[i * 3], ny = g.normals[i * 3 + 1], nz = g.normals[i * 3 + 2];
    const tx = g.tangents[i * 4], ty = g.tangents[i * 4 + 1], tz = g.tangents[i * 4 + 2];
    const dot = nx * tx + ny * ty + nz * tz;
    assert.ok(Math.abs(dot) < 1e-3, '非正交 ' + dot);
    assert.ok(Math.abs(Math.hypot(tx, ty, tz) - 1) < 1e-3);
    assert.ok(Math.abs(g.tangents[i * 4 + 3]) === 1);
  }
});

test('parseOBJ 解析四边形并三角化', () => {
  const obj = `
# quad
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 1 0
f 1/1/1 2/2/1 3/3/1 4/4/1
`;
  const g = parseOBJ(obj);
  assert.equal(g.vertexCount, 4);
  assert.equal(g.indices.length, 6);
  assert.ok(Math.abs(g.normals[1] - 1) < 1e-6);
  assert.ok(g.uvs.length === 8);
});

test('parseOBJ 无 vn 时自动累加法线', () => {
  const obj = `
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`;
  const g = parseOBJ(obj);
  const l = Math.hypot(g.normals[0], g.normals[1], g.normals[2]);
  assert.ok(Math.abs(l - 1) < 1e-5);
  assert.ok(Math.abs(g.normals[2] - 1) < 1e-5);
});

test('parseOBJ 负索引', () => {
  const g = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  assert.equal(g.indices.length, 3);
});

test('plane 正面朝上（从 +Y 看逆时针）', () => {
  const p = plane(2, 2);
  const pos = p.positions, idx = p.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    assert.ok(ny > 0, `三角形 ${i / 3} 法线朝下（ny=${ny}）`);
  }
  // 面积合计应等于整块平面
  let area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    area += Math.abs(
      (pos[b * 3] - pos[a * 3]) * (pos[c * 3 + 2] - pos[a * 3 + 2]) -
      (pos[c * 3] - pos[a * 3]) * (pos[b * 3 + 2] - pos[a * 3 + 2]),
    ) / 2;
  }
  assert.ok(Math.abs(area - 4) < 1e-6, `面积 ${area}，应为 4`);
});

// 三角形绕序必须与顶点法线同向，否则会被背面剔除，只看到内壁
test('所有程序化几何体的三角形朝向与法线一致', () => {
  for (const name of Object.keys(PRIMITIVES)) {
    const g = PRIMITIVES[name]();
    const pos = g.positions, idx = g.indices;
    let bad = 0, total = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const area = Math.hypot(n[0], n[1], n[2]);
      if (area < 1e-9) continue; // 极点等退化三角形跳过
      total++;
      const d = n[0] * g.normals[a] + n[1] * g.normals[a + 1] + n[2] * g.normals[a + 2];
      if (d <= 0) bad++;
    }
    assert.equal(bad, 0, `${name}: ${bad}/${total} 个三角形朝向反了`);
    assert.ok(total > 0, `${name} 没有有效三角形`);
  }
});
