// 程序化几何体：返回 { positions, normals, uvs, tangents, indices }
// 顶点数据均为普通数组，upload 时转成 typed array。

function build(positions, normals, uvs, tangents, indices) {
  return {
    positions,
    normals,
    uvs,
    tangents,
    indices,
    vertexCount: positions.length / 3,
    indexCount: indices.length,
  };
}

// 由位置/uv 生成切线（含手性 w），用于法线贴图
export function computeTangents(positions, normals, uvs, indices) {
  const n = positions.length / 3;
  const tan = new Float32Array(n * 4);
  const bitan = new Float32Array(n * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    const u0 = indices[i] * 2, u1 = indices[i + 1] * 2, u2 = indices[i + 2] * 2;
    const e1x = positions[i1] - positions[i0], e1y = positions[i1 + 1] - positions[i0 + 1], e1z = positions[i1 + 2] - positions[i0 + 2];
    const e2x = positions[i2] - positions[i0], e2y = positions[i2 + 1] - positions[i0 + 1], e2z = positions[i2 + 2] - positions[i0 + 2];
    const du1 = uvs[u1] - uvs[u0], dv1 = uvs[u1 + 1] - uvs[u0 + 1];
    const du2 = uvs[u2] - uvs[u0], dv2 = uvs[u2 + 1] - uvs[u0 + 1];
    const r = du1 * dv2 - du2 * dv1;
    const f = r !== 0 ? 1 / r : 0;
    const tx = (e1x * dv2 - e2x * dv1) * f;
    const ty = (e1y * dv2 - e2y * dv1) * f;
    const tz = (e1z * dv2 - e2z * dv1) * f;
    const bx = (e2x * du1 - e1x * du2) * f;
    const by = (e2y * du1 - e1y * du2) * f;
    const bz = (e2z * du1 - e1z * du2) * f;
    for (const v of [i0, i1, i2]) {
      tan[v] += tx; tan[v + 1] += ty; tan[v + 2] += tz;
      bitan[v] += bx; bitan[v + 1] += by; bitan[v + 2] += bz;
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 3, t = i * 4;
    const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
    let tx = tan[t], ty = tan[t + 1], tz = tan[t + 2];
    // Gram-Schmidt 正交化
    const d = nx * tx + ny * ty + nz * tz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-6) {
      // 球极点、UV 缝合线等退化顶点：切线累加相互抵消，取任意与法线正交的方向
      const helper = Math.abs(ny) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      tx = helper[1] * nz - helper[2] * ny;
      ty = helper[2] * nx - helper[0] * nz;
      tz = helper[0] * ny - helper[1] * nx;
      l = Math.hypot(tx, ty, tz) || 1;
    }
    tan[t] = tx / l; tan[t + 1] = ty / l; tan[t + 2] = tz / l;
    const cx = ny * tan[t + 2] - nz * tan[t + 1];
    const cy = nz * tan[t] - nx * tan[t + 2];
    const cz = nx * tan[t + 1] - ny * tan[t];
    tan[t + 3] = cx * bitan[o] + cy * bitan[o + 1] + cz * bitan[o + 2] < 0 ? -1 : 1;
  }
  return tan;
}

export function box(w = 1, h = 1, d = 1) {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  faces.forEach((f, fi) => {
    const base = fi * 4;
    for (const v of f.v) {
      positions.push(...v);
      normals.push(...f.n);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return build(positions, normals, uvs, computeTangents(positions, normals, uvs, indices), indices);
}

export function plane(w = 1, d = 1) {
  const x = w / 2, z = d / 2;
  // 顶点顺序须保证从 +Y 方向看是逆时针（正面朝上），否则会被背面剔除
  const positions = [-x, 0, z, x, 0, z, x, 0, -z, -x, 0, -z];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const indices = [0, 1, 2, 0, 2, 3];
  return build(positions, normals, uvs, computeTangents(positions, normals, uvs, indices), indices);
}

export function sphere(radius = 0.5, segments = 32, rings = 24) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
      uvs.push(u, v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      // 绕序需保证从外侧看是逆时针，否则会被背面剔除
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return build(positions, normals, uvs, computeTangents(positions, normals, uvs, indices), indices);
}

export function cylinder(radiusTop = 0.5, radiusBottom = 0.5, height = 1, segments = 32, caps = true) {
  const positions = [], normals = [], uvs = [], indices = [];
  const hy = height / 2;
  const slope = (radiusBottom - radiusTop) / height;
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const theta = u * Math.PI * 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    const nl = Math.hypot(1, slope);
    // 上下两个顶点，法线在斜面里
    positions.push(c * radiusTop, hy, s * radiusTop);
    normals.push(c / nl, slope / nl, s / nl);
    uvs.push(u, 1);
    positions.push(c * radiusBottom, -hy, s * radiusBottom);
    normals.push(c / nl, slope / nl, s / nl);
    uvs.push(u, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    // a=上顶点, b=下顶点；朝外逆时针
    indices.push(a, c, b, b, c, d);
  }
  if (caps) {
    for (const [r, y, ny, flip] of [[radiusTop, hy, 1, false], [radiusBottom, -hy, -1, true]]) {
      if (r <= 0) continue;
      const center = positions.length / 3;
      positions.push(0, y, 0); normals.push(0, ny, 0); uvs.push(0.5, 0.5);
      const start = positions.length / 3;
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
        normals.push(0, ny, 0);
        uvs.push(Math.cos(theta) * 0.5 + 0.5, Math.sin(theta) * 0.5 + 0.5);
      }
      for (let i = 0; i < segments; i++) {
        // 上盖朝 +Y，下盖朝 -Y
        if (flip) indices.push(center, start + i, start + i + 1);
        else indices.push(center, start + i + 1, start + i);
      }
    }
  }
  return build(positions, normals, uvs, computeTangents(positions, normals, uvs, indices), indices);
}

export function cone(radius = 0.5, height = 1, segments = 32) {
  return cylinder(0.0001, radius, height, segments, true);
}

// 环形圆环
export function torus(radius = 0.4, tube = 0.15, seg = 48, tseg = 24) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let j = 0; j <= tseg; j++) {
    const v = (j / tseg) * Math.PI * 2;
    for (let i = 0; i <= seg; i++) {
      const u = (i / seg) * Math.PI * 2;
      const cx = Math.cos(u) * radius, cz = Math.sin(u) * radius;
      const nx = Math.cos(u) * Math.cos(v), ny = Math.sin(v), nz = Math.sin(u) * Math.cos(v);
      positions.push(cx + nx * tube, ny * tube, cz + nz * tube);
      normals.push(nx, ny, nz);
      uvs.push(i / seg, j / tseg);
    }
  }
  for (let j = 0; j < tseg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + seg + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return build(positions, normals, uvs, computeTangents(positions, normals, uvs, indices), indices);
}

export const PRIMITIVES = {
  box: () => box(1, 1, 1),
  sphere: () => sphere(0.5, 32, 24),
  cylinder: () => cylinder(0.5, 0.5, 1, 32),
  cone: () => cone(0.5, 1, 32),
  torus: () => torus(0.4, 0.15, 48, 24),
  plane: () => plane(1, 1),
};

// 统一网格包围球（本地空间），用于视锥剔除与拾取
export function computeBounds(geo) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const p = geo.positions;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (let i = 0; i < p.length; i += 3) {
    radius = Math.max(radius, Math.hypot(p[i] - center[0], p[i + 1] - center[1], p[i + 2] - center[2]));
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center, radius };
}

// 解析 OBJ 文本（v / vn / vt / f，支持多边形与四边形分组三角化）
export function parseOBJ(text) {
  const positions = [], normalsIn = [], uvsIn = [];
  const vmap = [];
  const indices = [];
  let hasNormals = false, hasUvs = false;
  const lines = text.split(/\r?\n/);
  const resolve = (token, arr, kind) => {
    const parts = token.split('/');
    let idx;
    if (kind === 0) {
      idx = parseInt(parts[0], 10);
      return idx > 0 ? idx - 1 : vmap.length + idx;
    }
    if (kind === 1) {
      if (parts[1] === undefined || parts[1] === '') return -1;
      idx = parseInt(parts[1], 10);
      hasUvs = true;
      return idx > 0 ? idx - 1 : uvsIn.length / 2 + idx;
    }
    if (parts[2] === undefined || parts[2] === '') return -1;
    idx = parseInt(parts[2], 10);
    hasNormals = true;
    return idx > 0 ? idx - 1 : normalsIn.length / 3 + idx;
  };
  const cornerKey = (vi, ti, ni) => `${vi}/${ti}/${ni}`;
  const cornerMap = new Map();
  const outPos = [], outNrm = [], outUv = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    if (sp[0] === 'v') {
      positions.push(+sp[1], +sp[2], +sp[3]);
    } else if (sp[0] === 'vt') {
      uvsIn.push(+sp[1], 1 - (+sp[2] || 0));
    } else if (sp[0] === 'vn') {
      normalsIn.push(+sp[1], +sp[2], +sp[3]);
    } else if (sp[0] === 'f') {
      const corners = sp.slice(1).map((tok) => {
        const vi = resolve(tok, positions, 0);
        const ti = resolve(tok, uvsIn, 1);
        const ni = resolve(tok, normalsIn, 2);
        const key = cornerKey(vi, ti, ni);
        let idx = cornerMap.get(key);
        if (idx === undefined) {
          idx = outPos.length / 3;
          cornerMap.set(key, idx);
          outPos.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
          if (ti >= 0) outUv.push(uvsIn[ti * 2], uvsIn[ti * 2 + 1]);
          else outUv.push(0, 0);
          if (ni >= 0) outNrm.push(normalsIn[ni * 3], normalsIn[ni * 3 + 1], normalsIn[ni * 3 + 2]);
          else outNrm.push(0, 0, 0);
        }
        return idx;
      });
      for (let i = 2; i < corners.length; i++) indices.push(corners[0], corners[i - 1], corners[i]);
    }
  }
  // 缺失法线时按面法线累加
  if (!hasNormals) {
    outNrm.length = 0;
    for (let i = 0; i < outPos.length / 3; i++) outNrm.push(0, 0, 0);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const e1 = [outPos[b] - outPos[a], outPos[b + 1] - outPos[a + 1], outPos[b + 2] - outPos[a + 2]];
      const e2 = [outPos[c] - outPos[a], outPos[c + 1] - outPos[a + 1], outPos[c + 2] - outPos[a + 2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      const nz = e1[0] * e2[1] - e1[1] * e2[0];
      for (const o of [a, b, c]) {
        outNrm[o] += nx; outNrm[o + 1] += ny; outNrm[o + 2] += nz;
      }
    }
    for (let i = 0; i < outNrm.length; i += 3) {
      const l = Math.hypot(outNrm[i], outNrm[i + 1], outNrm[i + 2]) || 1;
      outNrm[i] /= l; outNrm[i + 1] /= l; outNrm[i + 2] /= l;
    }
  }
  void hasUvs;
  return build(outPos, outNrm, outUv, computeTangents(outPos, outNrm, outUv, indices), indices);
}
