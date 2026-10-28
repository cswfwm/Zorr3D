// glTF 2.0 / GLB 解析。只取静态几何 + PBR 材质 + 节点变换，够编辑器用。
// 解析部分与 DOM 无关，便于在 Node 中单测。

import { computeTangents } from "./geometry.js";

const COMPONENT = {
  5120: { size: 1, ctor: Int8Array, norm: 127 },
  5121: { size: 1, ctor: Uint8Array, norm: 255 },
  5122: { size: 2, ctor: Int16Array, norm: 32767 },
  5123: { size: 2, ctor: Uint16Array, norm: 65535 },
  5125: { size: 4, ctor: Uint32Array, norm: 1 },
  5126: { size: 4, ctor: Float32Array, norm: 1 },
};

const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGLB(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error("不是有效的 GLB 文件");
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      const bytes = new Uint8Array(arrayBuffer, start, length);
      json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } else if (type === 0x004e4942) {
      bin = arrayBuffer.slice(start, start + length);
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error("GLB 缺少 JSON 块");
  return { json, bin };
}

function readAccessor(json, bin, accessorIndex, byteStrideOverride = null) {
  const acc = json.accessors[accessorIndex];
  if (!acc) return null;
  const bv = json.bufferViews[acc.bufferView];
  if (!bv) return null;
  const comp = COMPONENT[acc.componentType];
  const num = NUM_COMPONENTS[acc.type];
  const stride = byteStrideOverride ?? bv.byteStride ?? comp.size * num;
  const baseOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(acc.count * num);
  const dv = new DataView(bin);
  for (let i = 0; i < acc.count; i++) {
    const o = baseOffset + i * stride;
    for (let k = 0; k < num; k++) {
      const p = o + k * comp.size;
      let v;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(p, true); break;
        case 5125: v = dv.getUint32(p, true); break;
        case 5123: v = dv.getUint16(p, true); break;
        case 5122: v = dv.getInt16(p, true); break;
        case 5121: v = dv.getUint8(p); break;
        case 5120: v = dv.getInt8(p); break;
        default: v = 0;
      }
      if (acc.normalized && comp.norm > 1) v = Math.max(v / comp.norm, -1);
      out[i * num + k] = v;
    }
  }
  return out;
}

// 把 glTF 图元转成引擎几何格式（含去索引化后的切线计算）
export function gltfPrimitiveToGeometry(json, bin, prim) {
  const attrs = prim.attributes || {};
  if (attrs.POSITION === undefined) return null;
  const pos = readAccessor(json, bin, attrs.POSITION);
  const nrm = attrs.NORMAL !== undefined ? readAccessor(json, bin, attrs.NORMAL) : null;
  const uv = attrs.TEXCOORD_0 !== undefined ? readAccessor(json, bin, attrs.TEXCOORD_0) : null;
  let idx;
  if (prim.indices !== undefined) {
    idx = readAccessor(json, bin, prim.indices);
  } else {
    idx = new Float32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
  }
  const n = pos.length / 3;
  const positions = Array.from(pos);
  let normals;
  if (nrm) {
    normals = Array.from(nrm);
  } else {
    normals = new Array(pos.length).fill(0);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      const nz = e1[0] * e2[1] - e1[1] * e2[0];
      for (const o of [a, b, c]) {
        normals[o] += nx; normals[o + 1] += ny; normals[o + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    }
  }
  const uvs = uv ? Array.from(uv) : new Array(n * 2).fill(0);
  const indices = Array.from(idx);

  // 切线
  const tangents = computeTangents(positions, normals, uvs, indices);
  return {
    positions,
    normals,
    uvs,
    tangents,
    indices,
    vertexCount: n,
    indexCount: indices.length,
  };
}

// 材质：把 glTF pbrMetallicRoughness 映射成引擎材质
export function gltfMaterial(json, index) {
  const m = json.materials?.[index];
  const base = {
    baseColor: [1, 1, 1, 1],
    metalness: 0,
    roughness: 1,
    emissive: [0, 0, 0],
    emissiveIntensity: 1,
    opacity: 1,
    normalStrength: 1,
    baseMap: null,
    normalMap: null,
    mrMap: null,
    emissiveMap: null,
  };
  if (!m) return base;
  const p = m.pbrMetallicRoughness || {};
  if (p.baseColorFactor) base.baseColor = p.baseColorFactor.slice();
  if (p.metallicFactor !== undefined) base.metalness = p.metallicFactor;
  if (p.roughnessFactor !== undefined) base.roughness = p.roughnessFactor;
  if (m.emissiveFactor) base.emissive = m.emissiveFactor.slice();
  base.opacity = m.alphaMode === "BLEND" ? (base.baseColor[3] ?? 1) : 1;
  if (p.baseColorTexture) base.baseColorTexIndex = p.baseColorTexture.index;
  if (p.metallicRoughnessTexture) base.mrTexIndex = p.metallicRoughnessTexture.index;
  if (m.normalTexture) base.normalTexIndex = m.normalTexture.index;
  if (m.emissiveTexture) base.emissiveTexIndex = m.emissiveTexture.index;
  return base;
}

// 节点层级 → 可交给场景构建的普通描述
export function gltfToSceneGraph(json) {
  return (json.scenes?.[json.scene ?? 0]?.nodes || []).map((i) => nodeDesc(json, i));
}

function nodeDesc(json, index) {
  const n = json.nodes[index];
  const desc = {
    name: n.name || `节点${index}`,
    translation: n.translation || [0, 0, 0],
    rotation: n.rotation || [0, 0, 0, 1],
    scale: n.scale || [1, 1, 1],
    mesh: n.mesh ?? null,
    children: (n.children || []).map((c) => nodeDesc(json, c)),
  };
  if (n.matrix) {
    // 拆解矩阵到 TRS
    const m = n.matrix;
    desc.translation = [m[12], m[13], m[14]];
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    desc.scale = [sx, sy, sz];
    const rm = [
      m[0] / sx, m[1] / sx, m[2] / sx,
      m[4] / sy, m[5] / sy, m[6] / sy,
      m[8] / sz, m[9] / sz, m[10] / sz,
    ];
    const tr = rm[0] + rm[4] + rm[8];
    let q;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = [(rm[5] - rm[7]) / s, (rm[6] - rm[2]) / s, (rm[1] - rm[3]) / s, 0.25 * s];
    } else if (rm[0] > rm[4] && rm[0] > rm[8]) {
      const s = Math.sqrt(1 + rm[0] - rm[4] - rm[8]) * 2;
      q = [0.25 * s, (rm[1] + rm[3]) / s, (rm[6] + rm[2]) / s, (rm[5] - rm[7]) / s];
    } else if (rm[4] > rm[8]) {
      const s = Math.sqrt(1 + rm[4] - rm[0] - rm[8]) * 2;
      q = [(rm[1] + rm[3]) / s, 0.25 * s, (rm[5] + rm[7]) / s, (rm[6] - rm[2]) / s];
    } else {
      const s = Math.sqrt(1 + rm[8] - rm[0] - rm[4]) * 2;
      q = [(rm[6] + rm[2]) / s, (rm[5] + rm[7]) / s, 0.25 * s, (rm[1] - rm[3]) / s];
    }
    desc.rotation = q;
  }
  return desc;
}
