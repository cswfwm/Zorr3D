import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGLB, gltfPrimitiveToGeometry, gltfMaterial, gltfToSceneGraph } from '../engine/gltf.js';

// 构造一个最小 GLB：一个三角形 + 两级节点
function makeGLB() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const binParts = [];
  const bufferViews = [];
  let offset = 0;
  const push = (typed) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    while (bytes.byteLength % 4 !== 0) break;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    binParts.push(bytes);
    offset += bytes.byteLength;
    while (offset % 4 !== 0) { binParts.push(new Uint8Array(1)); offset++; }
  };
  push(positions);
  push(indices);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'parent', translation: [5, 0, 0], children: [1] },
      { name: 'child', translation: [0, 2, 0], mesh: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{
      name: 'red',
      pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.1, 1], metallicFactor: 0.1, roughnessFactor: 0.35 },
      emissiveFactor: [0.2, 0, 0],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLen = jsonBytes.byteLength + pad;
  const binLen = offset;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  new Uint8Array(buf, 20, jsonBytes.byteLength).set(jsonBytes);
  for (let i = 0; i < pad; i++) new Uint8Array(buf, 20 + jsonBytes.byteLength + i, 1)[0] = 0x20;
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN
  const binOut = new Uint8Array(buf, binStart + 8, binLen);
  let p = 0;
  for (const part of binParts) { binOut.set(part, p); p += part.byteLength; }
  return buf;
}

test('parseGLB 读出 JSON 与 BIN 块', () => {
  const glb = makeGLB();
  const { json, bin } = parseGLB(glb);
  assert.equal(json.nodes.length, 2);
  assert.equal(json.nodes[0].name, 'parent');
  assert.ok(bin.byteLength > 0);
});

test('解析图元几何与索引', () => {
  const { json, bin } = parseGLB(makeGLB());
  const geo = gltfPrimitiveToGeometry(json, bin, json.meshes[0].primitives[0]);
  assert.equal(geo.vertexCount, 3);
  assert.deepEqual(geo.positions.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(geo.indices, [0, 1, 2]);
  assert.equal(geo.tangents.length, 3 * 4);
  // 缺 NORMAL 时自动补齐且为单位向量
  const n = Math.hypot(geo.normals[0], geo.normals[1], geo.normals[2]);
  assert.ok(Math.abs(n - 1) < 1e-5);
});

test('材质映射保留 PBR 参数', () => {
  const { json } = parseGLB(makeGLB());
  const m = gltfMaterial(json, 0);
  assert.deepEqual(m.baseColor, [0.8, 0.1, 0.1, 1]);
  assert.equal(m.metalness, 0.1);
  assert.equal(m.roughness, 0.35);
  assert.deepEqual(m.emissive, [0.2, 0, 0]);
});

test('节点层级与默认变换', () => {
  const { json } = parseGLB(makeGLB());
  const nodes = gltfToSceneGraph(json);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'parent');
  assert.deepEqual(nodes[0].translation, [5, 0, 0]);
  assert.equal(nodes[0].children[0].name, 'child');
  assert.deepEqual(nodes[0].children[0].translation, [0, 2, 0]);
  assert.deepEqual(nodes[0].children[0].rotation, [0, 0, 0, 1]);
});

test('matrix 节点被拆解为 TRS', () => {
  const { json } = parseGLB(makeGLB());
  json.nodes.push({
    name: 'm',
    matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1],
  });
  json.scenes[0].nodes.push(2);
  const nodes = gltfToSceneGraph(json);
  assert.deepEqual(nodes[1].translation, [1, 2, 3]);
  assert.deepEqual(nodes[1].scale, [2, 2, 2]);
});

test('非 GLB 数据报错', () => {
  const bad = new ArrayBuffer(12);
  assert.throws(() => parseGLB(bad), /GLB/);
});
