// 在容器内把默认场景光栅化成 PNG：复用引擎的场景图、相机矩阵、光照参数，
// 用 CPU 做一次前向着色（Lambert + GGX + 环境项），用于核对几何、相机与光照数据是否正确。
// 注意：这里不复用 GLSL 着色器，只验证「场景数据 → 变换 → 着色」这条链路。

import fs from "node:fs";
import zlib from "node:zlib";
import { createFakeGL } from "./helpers/fakegl.mjs";
import { m4, v3, deg2rad } from "../engine/math.js";
import { Renderer, defaultMaterial } from "../engine/renderer.js";
import { Scene, SceneNode } from "../engine/scene.js";
import { PRIMITIVES } from "../engine/geometry.js";

const W = 640, H = 400;

function makeScene() {
  const { gl } = createFakeGL();
  const canvas = { width: 0, height: 0, clientWidth: W, clientHeight: H, getContext: () => gl };
  const r = new Renderer(canvas);
  r.resize(W, H, 1, 1);
  const scene = new Scene(r);
  const add = (name, geo, mat, pos, eulerDeg) => {
    const n = new SceneNode(name);
    n.geometry = geo;
    n.mesh = r.ctx.uploadMesh(geo);
    n.material = mat;
    n.position = pos;
    if (eulerDeg) n.setEulerDeg(eulerDeg);
    scene.addNode(n);
    return n;
  };
  const ground = defaultMaterial();
  ground.baseColor = [0.34, 0.35, 0.38, 1];
  ground.roughness = 0.92;
  add("地面", PRIMITIVES.plane(24, 24), ground, [0, 0, 0]).castShadow = false;

  const stone = defaultMaterial();
  stone.baseColor = [0.62, 0.6, 0.56, 1];
  stone.roughness = 0.7;
  add("石柱", PRIMITIVES.cylinder(0.5, 0.5, 2, 32), stone, [0, 1, 0]);

  const metal = defaultMaterial();
  metal.baseColor = [0.72, 0.74, 0.78, 1];
  metal.metalness = 1;
  metal.roughness = 0.28;
  add("金属方块", PRIMITIVES.box(1, 1, 1), metal, [-1.8, 0.5, 0.6], [0, 25, 0]);

  const glow = defaultMaterial();
  glow.baseColor = [0.9, 0.5, 0.2, 1];
  glow.emissive = [1.0, 0.42, 0.08];
  glow.emissiveIntensity = 1.4;
  glow.roughness = 0.2;
  add("发光球", PRIMITIVES.sphere(0.45, 32, 24), glow, [1.9, 1.3, -0.4]);

  scene.camera.position = [3.8, 3.4, 5.6];
  scene.camera.target = [0, 0.6, 0];
  scene.updateTransforms();
  return scene;
}

const sunDir = (scene) => {
  const L = v3.normalize([0, 0, 0], scene.light.direction);
  return v3.normalize([0, 0, 0], [-L[0], -L[1], -L[2]]);
};

function shade(obj, worldPos, normal, scene, lightScale = 1) {
  const mat = obj.material;
  const sun = sunDir(scene);
  const N = v3.normalize([0, 0, 0], normal);
  const V = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], scene.camera.position, worldPos));
  const ndl = Math.max(v3.dot(N, sun), 0);
  const ndv = Math.max(v3.dot(N, V), 1e-3);
  const half = v3.normalize([0, 0, 0], v3.add([0, 0, 0], sun, V));
  const ndh = Math.max(v3.dot(N, half), 0);
  const a = mat.roughness * mat.roughness;
  const d = (a * a) / (Math.PI * Math.pow(ndh * ndh * (a * a - 1) + 1, 2) + 1e-7);
  const fres = Math.pow(1 - ndv, 5);
  const kd = 1 - mat.metalness;
  const sky = scene.environment.skyColor;
  const amb = 0.35 + 0.35 * (N[1] * 0.5 + 0.5);
  const base = mat.baseColor;
  const radiance = scene.light.intensity;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const f0 = 0.04 + (base[i] - 0.04) * mat.metalness;
    // 与 MESH_FS 相同的能量形式：(kD*albedo/PI + spec) * radiance * NdotL
    const kD = kd;
    const diffuse = (kD * base[i] / Math.PI) * radiance * ndl * lightScale;
    // Cook-Torrance 的几何项在这里近似为 1/(4*NdotV*NdotL)*NdotL，抵消后用 D*F 估计
    const spec = (d * f0 * fres * 0.6) * radiance * 0.25 * lightScale;
    const envDiff = base[i] * kD * sky[i] * amb * 0.34;
    const envSpec = sky[i] * f0 * (1 - mat.roughness * 0.75) * (0.35 + 0.65 * fres) * 0.55;
    out[i] = diffuse + spec + envDiff + envSpec + mat.emissive[i] * mat.emissiveIntensity;
  }
  return out;
}

function render(scene, path) {
  const proj = m4.perspective(m4.create(), deg2rad(scene.camera.fov), W / H, scene.camera.near, scene.camera.far);
  const vp = m4.multiply(m4.create(), proj, scene.camera.viewMatrix());

  const zbuf = new Float32Array(W * H).fill(Infinity);
  const cbuf = new Float32Array(W * H * 3);
  // 天空背景：竖直渐变到地平线色（与 SKY_FS 的 skyColor 一致）
  const sky = scene.environment.skyColor;
  const horizon = scene.environment.horizonColor;
  for (let y = 0; y < H; y++) {
    const t = Math.pow(1 - y / H, 0.55);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      cbuf[o] = horizon[0] + (sky[0] - horizon[0]) * t;
      cbuf[o + 1] = horizon[1] + (sky[1] - horizon[1]) * t;
      cbuf[o + 2] = horizon[2] + (sky[2] - horizon[2]) * t;
    }
  }

  const camPos = scene.camera.position;
  const objs = scene.renderables();
  // 近似阴影：沿光线方向检查是否被其它物体的包围球挡住
  const sun = sunDir(scene);
  const occluders = objs.filter((o) => o.castShadow && o.name !== "地面");
  const inShadow = (p) => {
    for (const o of occluders) {
      const s2 = o.worldSphere;
      const oc = v3.sub([0, 0, 0], p, s2.center);
      const proj = v3.dot(oc, sun);
      if (proj <= 0) continue;
      const closest = v3.sub([0, 0, 0], oc, v3.scale([0, 0, 0], sun, proj));
      if (v3.len(closest) < s2.radius * 0.92) return true;
    }
    return false;
  };
  // 地面先画，其余按与地面顺序无关（有 z 缓冲）
  const ordered = [...objs.filter((o) => o.name === "地面"), ...objs.filter((o) => o.name !== "地面")];

  for (const obj of ordered) {
    const geo = obj.geometry;
    const mvp = m4.multiply(m4.create(), vp, obj.worldMatrix);
    const nm = m4.normalMatrix(new Float32Array(9), obj.worldMatrix);
    const pos = geo.positions, idx = geo.indices;
    for (let i = 0; i < idx.length; i += 3) {
      // 取三个顶点的齐次坐标，先对近裁剪面做多边形裁剪（真实 GPU 的行为）
      const corner = (vi) => {
        const p = [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]];
        const clip = v3.transformVec4([0, 0, 0, 0], mvp, [p[0], p[1], p[2], 1]);
        const nrm = [geo.normals[vi * 3], geo.normals[vi * 3 + 1], geo.normals[vi * 3 + 2]];
        return {
          clip,
          world: v3.transformMat4([0, 0, 0], p, obj.worldMatrix),
          n: [
            nm[0] * nrm[0] + nm[3] * nrm[1] + nm[6] * nrm[2],
            nm[1] * nrm[0] + nm[4] * nrm[1] + nm[7] * nrm[2],
            nm[2] * nrm[0] + nm[5] * nrm[1] + nm[8] * nrm[2],
          ],
        };
      };
      const poly = clipNear([corner(idx[i]), corner(idx[i + 1]), corner(idx[i + 2])]);
      if (poly.length < 3) continue;
      for (let t = 1; t + 1 < poly.length; t++) {
        const tri = [poly[0], poly[t], poly[t + 1]].map((v) => ({
          x: (v.clip[0] / v.clip[3] * 0.5 + 0.5) * W,
          y: (0.5 - v.clip[1] / v.clip[3] * 0.5) * H,
          z: v.clip[2] / v.clip[3],
          world: v.world,
          n: v.n,
        }));
        rasterizeTri(tri, obj);
      }
    }
  }

  function rasterizeTri(tri, obj) {
    const minX = Math.max(0, Math.floor(Math.min(tri[0].x, tri[1].x, tri[2].x)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(tri[0].x, tri[1].x, tri[2].x)));
    const minY = Math.max(0, Math.floor(Math.min(tri[0].y, tri[1].y, tri[2].y)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(tri[0].y, tri[1].y, tri[2].y)));
    const [a, b, cc] = tri;
    const area = (b.x - a.x) * (cc.y - a.y) - (cc.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b.x - px) * (cc.y - py) - (cc.x - px) * (b.y - py)) / area;
        const w1 = ((cc.x - px) * (a.y - py) - (a.x - px) * (cc.y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a.z + w1 * b.z + w2 * cc.z;
        const o = y * W + x;
        if (z >= zbuf[o]) continue;
        zbuf[o] = z;
        const world = [0, 1, 2].map((k) => w0 * a.world[k] + w1 * b.world[k] + w2 * cc.world[k]);
        const n = [0, 1, 2].map((k) => w0 * a.n[k] + w1 * b.n[k] + w2 * cc.n[k]);
        const shadowed = inShadow(world);
        const col = shade(obj, world, n, scene, shadowed ? 0.35 : 1);
        cbuf[o * 3] = col[0];
        cbuf[o * 3 + 1] = col[1];
        cbuf[o * 3 + 2] = col[2];
      }
    }
  }

  function clipNear(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = cur.clip[3] > 1e-4;
      const prevIn = prev.clip[3] > 1e-4;
      if (curIn !== prevIn) {
        const t = (1e-4 - prev.clip[3]) / (cur.clip[3] - prev.clip[3]);
        out.push(lerpCorner(prev, cur, t));
      }
      if (curIn) out.push(cur);
    }
    return out;
  }

  function lerpCorner(a, b, t) {
    const mix = (x, y) => x + (y - x) * t;
    return {
      clip: [0, 1, 2, 3].map((k) => mix(a.clip[k], b.clip[k])),
      world: [0, 1, 2].map((k) => mix(a.world[k], b.world[k])),
      n: [0, 1, 2].map((k) => mix(a.n[k], b.n[k])),
    };
  }

  const pixels = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * W + x;
      const qx = x / W - 0.5, qy = y / H - 0.5;
      const vig = 1 - 0.3 * (qx * qx + qy * qy) * 3;
      for (let k = 0; k < 3; k++) {
        let v = cbuf[o * 3 + k] * scene.environment.exposure;
        v = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
        v = Math.max(0, Math.min(1, v)) * vig;
        pixels[o * 3 + k] = Math.round(Math.pow(v, 1 / 2.2) * 255);
      }
    }
  }
  writePNG(path, W, H, pixels);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePNG(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
}

const out = process.argv[2] || "/tmp/zorr3d-scene.png";
render(makeScene(), out);
console.log("已输出", out);
