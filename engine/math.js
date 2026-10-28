// 向量与矩阵运算。矩阵按 WebGL 惯例列主序存储（m[col*4+row]）。

export const EPS = 1e-6;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

/* ---------------- vec3（数组形式，避免对象分配） ---------------- */

export const v3 = {
  create: (x = 0, y = 0, z = 0) => [x, y, z],
  clone: (a) => [a[0], a[1], a[2]],
  copy: (out, a) => {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  },
  set: (out, x, y, z) => {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  },
  add: (out, a, b) => v3.set(out, a[0] + b[0], a[1] + b[1], a[2] + b[2]),
  sub: (out, a, b) => v3.set(out, a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  mul: (out, a, b) => v3.set(out, a[0] * b[0], a[1] * b[1], a[2] * b[2]),
  scale: (out, a, s) => v3.set(out, a[0] * s, a[1] * s, a[2] * s),
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (out, a, b) => {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    return v3.set(out, x, y, z);
  },
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize: (out, a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > EPS ? v3.scale(out, a, 1 / l) : v3.set(out, 0, 0, 0);
  },
  lerp: (out, a, b, t) => v3.set(out, lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)),
  transformMat4: (out, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return v3.set(
      out,
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    );
  },
  transformDir: (out, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    return v3.set(
      out,
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    );
  },
  // 齐次变换，保留 w 分量（光栅化与裁剪需要）
  transformVec4: (out, m, v) => {
    const x = v[0], y = v[1], z = v[2], w = v[3] === undefined ? 1 : v[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
  },
};

/* ---------------- vec4 ---------------- */

export const v4 = {
  create: (x = 0, y = 0, z = 0, w = 0) => [x, y, z, w],
  clone: (a) => [a[0], a[1], a[2], a[3]],
  set: (out, x, y, z, w) => {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
  },
};

/* ---------------- quat（[x,y,z,w]） ---------------- */

export const quat = {
  create: () => [0, 0, 0, 1],
  clone: (q) => [q[0], q[1], q[2], q[3]],
  identity: (out) => {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
  },
  fromAxisAngle: (out, axis, rad) => {
    const h = rad * 0.5;
    const s = Math.sin(h);
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    out[0] = (axis[0] / n) * s;
    out[1] = (axis[1] / n) * s;
    out[2] = (axis[2] / n) * s;
    out[3] = Math.cos(h);
    return out;
  },
  fromEulerXYZ: (out, x, y, z) => {
    const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
    const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
    const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
    // 顺序 R = Rz * Ry * Rx（与 three.js 默认 XYZ 欧拉一致）
    out[0] = sx * cy * cz + cx * sy * sz;
    out[1] = cx * sy * cz - sx * cy * sz;
    out[2] = cx * cy * sz + sx * sy * cz;
    out[3] = cx * cy * cz - sx * sy * sz;
    return out;
  },
  toEulerXYZ: (q) => {
    const [x, y, z, w] = q;
    const m11 = 1 - 2 * (y * y + z * z);
    const m12 = 2 * (x * y - z * w);
    const m13 = 2 * (x * z + y * w);
    const m23 = 2 * (y * z - x * w);
    const m33 = 1 - 2 * (x * x + y * y);
    const m21 = 2 * (x * y + z * w);
    const m22 = 1 - 2 * (x * x + z * z);
    const ey = Math.asin(clamp(m13, -1, 1));
    let ex, ez;
    if (Math.abs(m13) < 0.9999999) {
      ex = Math.atan2(-m23, m33);
      ez = Math.atan2(-m12, m11);
    } else {
      ex = Math.atan2(m21, m22);
      ez = 0;
    }
    return [ex, ey, ez];
  },
  mul: (out, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  },
  normalize: (out, a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l; out[3] = a[3] / l;
    return out;
  },
  slerp: (out, a, b, t) => {
    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) {
      cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let s0, s1;
    if (1 - cos > 1e-6) {
      const omega = Math.acos(cos);
      const sin = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sin;
      s1 = Math.sin(t * omega) / sin;
    } else {
      s0 = 1 - t; s1 = t;
    }
    out[0] = s0 * ax + s1 * bx;
    out[1] = s0 * ay + s1 * by;
    out[2] = s0 * az + s1 * bz;
    out[3] = s0 * aw + s1 * bw;
    return out;
  },
};

/* ---------------- mat4 ---------------- */

export const mat4 = {
  create: () => {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  identity: (m) => {
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  copy: (out, a) => {
    out.set(a);
    return out;
  },
  multiply: (out, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
      out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
      out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
      out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
    }
    return out;
  },
  perspective: (out, fovyRad, aspect, near, far) => {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },
  ortho: (out, l, r, b, t, n, f) => {
    out.fill(0);
    out[0] = 2 / (r - l);
    out[5] = 2 / (t - b);
    out[10] = -2 / (f - n);
    out[12] = -(r + l) / (r - l);
    out[13] = -(t + b) / (t - b);
    out[14] = -(f + n) / (f - n);
    out[15] = 1;
    return out;
  },
  lookAt: (out, eye, center, up) => {
    const z = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], eye, center));
    let x = v3.cross([0, 0, 0], up, z);
    if (v3.len(x) < EPS) x = v3.cross(x, [up[2], up[0], up[1]], z);
    v3.normalize(x, x);
    const y = v3.cross([0, 0, 0], z, x);
    out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
    out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
    out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
    out[12] = -v3.dot(x, eye);
    out[13] = -v3.dot(y, eye);
    out[14] = -v3.dot(z, eye);
    out[15] = 1;
    return out;
  },
  fromTRS: (out, t, q, s) => {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = (1 - (yy + zz)) * s[0];
    out[1] = (xy + wz) * s[0];
    out[2] = (xz - wy) * s[0];
    out[3] = 0;
    out[4] = (xy - wz) * s[1];
    out[5] = (1 - (xx + zz)) * s[1];
    out[6] = (yz + wx) * s[1];
    out[7] = 0;
    out[8] = (xz + wy) * s[2];
    out[9] = (yz - wx) * s[2];
    out[10] = (1 - (xx + yy)) * s[2];
    out[11] = 0;
    out[12] = t[0];
    out[13] = t[1];
    out[14] = t[2];
    out[15] = 1;
    return out;
  },
  invert: (out, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },
  transpose: (out, a) => {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r * 4 + c];
    }
    return out;
  },
  // 法线矩阵：左上 3x3 的逆转置，写进 mat3（9 元素）
  normalMatrix: (out, a) => {
    const m = mat4.invert(mat4.create(), a) || mat4.create();
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8];
    out[3] = m[1]; out[4] = m[5]; out[5] = m[9];
    out[6] = m[2]; out[7] = m[6]; out[8] = m[10];
    return out;
  },
  transformPoint: (out, m, p) => v3.transformMat4(out, p, m),
};

/* ---------------- 几何工具 ---------------- */

// Möller–Trumbore 射线-三角求交，返回 t 或 -1
export function rayTriangle(ro, rd, a, b, c) {
  const e1 = v3.sub([0, 0, 0], b, a);
  const e2 = v3.sub([0, 0, 0], c, a);
  const p = v3.cross([0, 0, 0], rd, e2);
  const det = v3.dot(e1, p);
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  const t = v3.sub([0, 0, 0], ro, a);
  const u = v3.dot(t, p) * inv;
  if (u < 0 || u > 1) return -1;
  const q = v3.cross([0, 0, 0], t, e1);
  const v = v3.dot(rd, q) * inv;
  if (v < 0 || u + v > 1) return -1;
  return v3.dot(e2, q) * inv;
}

// 射线-AABB（slab 法），返回进入距离或 -1
export function rayAABB(ro, rd, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) < 1e-9) {
      if (ro[i] < min[i] || ro[i] > max[i]) return -1;
      continue;
    }
    const inv = 1 / rd[i];
    let t1 = (min[i] - ro[i]) * inv;
    let t2 = (max[i] - ro[i]) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmax < 0 ? -1 : Math.max(tmin, 0);
}

// 射线-平面（y = h），返回 t 或 -1
export function rayPlaneY(ro, rd, h = 0) {
  if (Math.abs(rd[1]) < 1e-9) return -1;
  const t = (h - ro[1]) / rd[1];
  return t < 0 ? -1 : t;
}

export { mat4 as m4 };
