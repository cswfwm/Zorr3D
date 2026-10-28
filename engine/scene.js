// 场景图：节点层级、变换、材质、包围体、拾取、序列化。

import { m4, v3, quat, rayAABB, rayTriangle, deg2rad, rad2deg } from "./math.js";
import { PRIMITIVES, computeBounds } from "./geometry.js";
import { Skeleton } from "./skeleton.js";
import { AnimationClip, AnimationPlayer } from "./animation.js";
import { defaultMaterial } from "./renderer.js";

let nextId = 1;

export class SceneNode {
  constructor(name = "节点") {
    this.id = nextId++;
    this.name = name;
    this.parent = null;
    this.children = [];
    this.position = [0, 0, 0];
    this.rotation = [0, 0, 0, 1]; // 四元数
    this.scale = [1, 1, 1];
    this.visible = true;
    this.castShadow = true;
    this.mesh = null; // GL 网格
    this.geometry = null; // 几何数据（用于拾取与包围体）
    this.material = null;
    this.primitive = null; // 程序化几何体类型，便于序列化
    this.geometryKey = null; // 导入模型的几何存储键
    this.skeleton = null;    // 带蒙皮时挂载的 Skeleton
    this.animator = null;    // 该节点的动画播放器
    this.worldMatrix = m4.create();
    this.localMatrix = m4.create();
    this.worldSphere = { center: [0, 0, 0], radius: 0 };
    this.bounds = null;
    this._dirty = true;
  }

  add(child) {
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    child.markDirty();
    return child;
  }

  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  }

  markDirty() {
    this._dirty = true;
    for (const c of this.children) c.markDirty();
  }

  setEuler(e) {
    quat.fromEulerXYZ(this.rotation, e[0], e[1], e[2]);
    this.markDirty();
  }

  get euler() {
    return quat.toEulerXYZ(this.rotation);
  }

  get eulerDeg() {
    return quat.toEulerXYZ(this.rotation).map(rad2deg);
  }

  setEulerDeg(d) {
    this.setEuler([deg2rad(d[0]), deg2rad(d[1]), deg2rad(d[2])]);
  }

  updateWorld(parentMatrix) {
    m4.fromTRS(this.localMatrix, this.position, this.rotation, this.scale);
    if (parentMatrix) m4.multiply(this.worldMatrix, parentMatrix, this.localMatrix);
    else m4.copy(this.worldMatrix, this.localMatrix);

    // 包围球变换到世界空间
    if (this.geometry) {
      if (!this.bounds) this.bounds = computeBounds(this.geometry);
      const c = v3.transformMat4([0, 0, 0], this.bounds.center, this.worldMatrix);
      const sx = v3.len(v3.transformDir([0, 0, 0], [1, 0, 0], this.worldMatrix));
      const sy = v3.len(v3.transformDir([0, 0, 0], [0, 1, 0], this.worldMatrix));
      const sz = v3.len(v3.transformDir([0, 0, 0], [0, 0, 1], this.worldMatrix));
      const s = Math.max(sx, sy, sz);
      this.worldSphere.center = c;
      this.worldSphere.radius = this.bounds.radius * s;
    }
    this._dirty = false;
    for (const c of this.children) c.updateWorld(this.worldMatrix);
  }

  traverse(fn) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }

  get path() {
    const parts = [];
    let n = this;
    while (n) {
      parts.unshift(n.name);
      n = n.parent;
    }
    return parts.join("/");
  }
}

export class Camera {
  constructor() {
    this.position = [0, 2, 6];
    this.target = [0, 0, 0];
    this.up = [0, 1, 0];
    this.fov = 55;
    this.near = 0.05;
    this.far = 500;
    this._view = m4.create();
  }

  viewMatrix() {
    return m4.lookAt(this._view, this.position, this.target, this.up);
  }

  // 轨道相机：围绕 target 旋转
  orbit(dx, dy, distance, minPitch = -1.5, maxPitch = 1.5) {
    const offset = v3.sub([0, 0, 0], this.position, this.target);
    let r = v3.len(offset);
    let pitch = Math.asin(Math.max(-1, Math.min(1, offset[1] / (r || 1))));
    let yaw = Math.atan2(offset[0], offset[2]);
    yaw -= dx;
    pitch = Math.max(minPitch, Math.min(maxPitch, pitch + dy));
    r = Math.max(0.2, distance ?? r);
    this.position = [
      this.target[0] + Math.sin(yaw) * Math.cos(pitch) * r,
      this.target[1] + Math.sin(pitch) * r,
      this.target[2] + Math.cos(yaw) * Math.cos(pitch) * r,
    ];
  }

  pan(dx, dy) {
    const right = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], v3.sub([0, 0, 0], this.target, this.position), this.up));
    const up = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], right, v3.sub([0, 0, 0], this.target, this.position)));
    const dist = v3.dist(this.position, this.target);
    const s = dist * 0.0016;
    v3.add(this.target, this.target, v3.add([0, 0, 0], v3.scale([0, 0, 0], right, -dx * s), v3.scale([0, 0, 0], up, dy * s)));
    v3.add(this.position, this.position, v3.add([0, 0, 0], v3.scale([0, 0, 0], right, -dx * s), v3.scale([0, 0, 0], up, dy * s)));
  }

  dolly(amount) {
    const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], this.position, this.target));
    const dist = v3.dist(this.position, this.target) * Math.exp(-amount);
    this.position = v3.add([0, 0, 0], this.target, v3.scale([0, 0, 0], dir, Math.max(0.2, dist)));
  }

  frame(center, radius) {
    this.target = [...center];
    const d = Math.max(radius * 2.2, 1);
    const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], this.position, this.target));
    this.position = v3.add([0, 0, 0], this.target, v3.scale([0, 0, 0], dir, d));
  }

  // 屏幕坐标 → 世界射线
  screenRay(nx, ny, aspect) {
    const invVP = m4.invert(m4.create(), m4.multiply(m4.create(), m4.perspective(m4.create(), deg2rad(this.fov), aspect, this.near, this.far), this.viewMatrix()));
    const near = v3.transformMat4([0, 0, 0], [nx, ny, -1], invVP);
    const far = v3.transformMat4([0, 0, 0], [nx, ny, 1], invVP);
    const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], far, near));
    return { origin: this.position.slice(), dir };
  }
}

export class Scene {
  constructor(renderer) {
    this.renderer = renderer;
    this.root = new SceneNode("场景");
    this.camera = new Camera();
    this.light = {
      direction: [-0.45, -0.85, -0.35],
      color: [1.0, 0.96, 0.9],
      intensity: 3.4,
    };
    this.environment = {
      skyColor: [0.16, 0.3, 0.62],
      horizonColor: [0.42, 0.55, 0.76],
      groundColor: [0.1, 0.09, 0.08],
      skyIntensity: 0.85,
      exposure: 1.0,
      vignette: 0.25,
      tonemap: 0,
      fog: null, // { color:[r,g,b], near, far }；null 表示关闭
    };
    this.bloom = { enabled: true, strength: 0.35 };
    this.showSky = true;
    this.showGrid = true;
    this.antialias = "fxaa";
    this.selected = null;
    this._renderables = [];
    this._boundsCache = null;
  }

  addNode(node) {
    this.root.add(node);
    this._boundsCache = null;
    this.updateTransforms();
    return node;
  }

  removeNode(node) {
    if (node.parent) node.parent.remove(node);
    node.traverse((n) => {
      if (n.mesh) n.mesh.release();
    });
    this._boundsCache = null;
    if (this.selected === node) this.selected = null;
  }

  updateTransforms() {
    this.root.updateWorld(null);
  }

  renderables() {
    const out = [];
    this.root.traverse((n) => {
      if (n.mesh && n.geometry && n.material) out.push(n);
    });
    this._renderables = out;
    return out;
  }

  // 场景中所有骨架（供渲染器每帧统一更新，避免重复计算）
  skeletons() {
    if (this._skeletonCache) return this._skeletonCache;
    const list = [];
    this.root.traverse((n) => {
      if (n.skeleton) list.push(n.skeleton);
    });
    this._skeletonCache = list;
    return list;
  }

  invalidateSkeletons() {
    this._skeletonCache = null;
  }

  bounds3D() {
    if (this._boundsCache) return this._boundsCache;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const n of this.renderables()) {
      if (n.name === "地面") continue;
      const s = n.worldSphere;
      if (!isFinite(s.radius) || s.radius <= 0) continue;
      min = [Math.min(min[0], s.center[0] - s.radius), Math.min(min[1], s.center[1] - s.radius), Math.min(min[2], s.center[2] - s.radius)];
      max = [Math.max(max[0], s.center[0] + s.radius), Math.max(max[1], s.center[1] + s.radius), Math.max(max[2], s.center[2] + s.radius)];
    }
    if (!isFinite(min[0])) {
      min = [-1, -1, -1]; max = [1, 1, 1];
    }
    const center = v3.scale([0, 0, 0], v3.add([0, 0, 0], min, max), 0.5);
    const radius = Math.max(v3.dist(center, max), 1);
    this._boundsCache = { min, max, center, radius };
    return this._boundsCache;
  }

  invalidateBounds() {
    this._boundsCache = null;
    this._skeletonCache = null;
  }

  /* ---------------- 拾取 ---------------- */

  pick(screenX, screenY, width, height) {
    const nx = (screenX / width) * 2 - 1;
    const ny = -((screenY / height) * 2 - 1);
    const ray = this.camera.screenRay(nx, ny, width / height);
    return this.pickRay(ray.origin, ray.dir);
  }

  pickRay(origin, dir) {
    let best = null;
    let bestT = Infinity;
    for (const node of this.renderables()) {
      if (!node.visible) continue;
      const s = node.worldSphere;
      // 先用世界包围球快速排除
      const oc = v3.sub([0, 0, 0], origin, s.center);
      const b = v3.dot(oc, dir);
      const c = v3.dot(oc, oc) - s.radius * s.radius;
      if (c > 0 && b > 0) continue;
      const inv = m4.invert(m4.create(), node.worldMatrix);
      if (!inv) continue;
      const lo = v3.transformMat4([0, 0, 0], origin, inv);
      const ld = v3.transformDir([0, 0, 0], dir, inv);
      const g = node.geometry;
      if (!node.bounds) node.bounds = computeBounds(g);
      const t0 = rayAABB(lo, ld, node.bounds.min, node.bounds.max);
      if (t0 < 0 || t0 > bestT) continue;
      // 精确三角形求交
      const idx = g.indices;
      const pos = g.positions;
      const a = [0, 0, 0], bb = [0, 0, 0], cc = [0, 0, 0];
      for (let i = 0; i < idx.length; i += 3) {
        const i0 = idx[i] * 3, i1 = idx[i + 1] * 3, i2 = idx[i + 2] * 3;
        v3.set(a, pos[i0], pos[i0 + 1], pos[i0 + 2]);
        v3.set(bb, pos[i1], pos[i1 + 1], pos[i1 + 2]);
        v3.set(cc, pos[i2], pos[i2 + 1], pos[i2 + 2]);
        const t = rayTriangle(lo, ld, a, bb, cc);
        if (t > 0 && t < bestT) {
          bestT = t;
          best = node;
        }
      }
    }
    return best;
  }

  /* ---------------- 序列化 ---------------- */

  toJSON() {
    const nodeToJSON = (n) => ({
      id: n.id,
      name: n.name,
      position: [...n.position],
      rotation: [...n.rotation],
      scale: [...n.scale],
      visible: n.visible,
      castShadow: n.castShadow,
      primitive: n.primitive,
      geometryKey: n.geometryKey || null,
      rig: n.rig || null,
      skeleton: n.skeleton ? n.skeleton.toJSON() : null,
      clip: n.clipJSON || null,
      material: n.material ? serializeMaterial(n.material) : null,
      children: n.children.map(nodeToJSON),
    });
    return {
      version: 1,
      camera: {
        position: [...this.camera.position],
        target: [...this.camera.target],
        fov: this.camera.fov,
        near: this.camera.near,
        far: this.camera.far,
      },
      light: JSON.parse(JSON.stringify(this.light)),
      environment: JSON.parse(JSON.stringify(this.environment)),
      bloom: JSON.parse(JSON.stringify(this.bloom)),
      showSky: this.showSky,
      showGrid: this.showGrid,
      antialias: this.antialias,
      root: nodeToJSON(this.root),
    };
  }

  loadJSON(data, uploadGeo, resolveTex, resolveGeo, resolveRig) {
    this.root.children.length = 0;
    this.root.children = [];
    this.selected = null;
    if (data.camera) {
      this.camera.position = data.camera.position;
      this.camera.target = data.camera.target;
      this.camera.fov = data.camera.fov ?? 55;
      this.camera.near = data.camera.near ?? 0.05;
      this.camera.far = data.camera.far ?? 500;
    }
    if (data.light) Object.assign(this.light, data.light);
    if (data.environment) Object.assign(this.environment, data.environment);
    if (data.bloom) Object.assign(this.bloom, data.bloom);
    this.showSky = data.showSky !== false;
    this.showGrid = !!data.showGrid;
    this.antialias = data.antialias ?? "fxaa";

    const build = (json, parent) => {
      const n = new SceneNode(json.name || "节点");
      n.position = json.position || [0, 0, 0];
      n.rotation = json.rotation || [0, 0, 0, 1];
      n.scale = json.scale || [1, 1, 1];
      n.visible = json.visible !== false;
      n.castShadow = json.castShadow !== false;
      if (json.primitive && PRIMITIVES[json.primitive]) {
        n.primitive = json.primitive;
        const geo = PRIMITIVES[json.primitive]();
        n.geometry = geo;
        n.mesh = uploadGeo(geo);
        n.material = deserializeMaterial(json.material, resolveTex);
      }
      if (json.geometryKey && resolveGeo) {
        const geo = resolveGeo(json.geometryKey);
        if (geo) {
          n.geometryKey = json.geometryKey;
          n.geometry = geo;
          n.mesh = uploadGeo(geo);
        }
        n.material = deserializeMaterial(json.material, resolveTex);
      } else if (!json.primitive && json.material) {
        n.material = deserializeMaterial(json.material, resolveTex);
      }
      if (json.skeleton) {
        n.skeleton = Skeleton.fromJSON(json.skeleton);
        n.skeleton.update();
        // 骨架网格由 role 标记重建（人形是程序化生成的，无需存顶点）
        if (json.rig === "human" && resolveRig) {
          const built = resolveRig(n.skeleton);
          if (built) {
            n.rig = "human";
            n.geometry = built;
            if (!n.mesh) n.mesh = uploadGeo(built);
          }
        }
        n.animator = new AnimationPlayer();
        if (json.clip) {
          n.clipJSON = json.clip;
          n.animator.play(AnimationClip.fromJSON(json.clip), { loop: true });
        }
      }
      if (parent) parent.add(n);
      for (const c of json.children || []) build(c, n);
      return n;
    };
    const rootJson = data.root || {};
    for (const c of rootJson.children || []) build(c, this.root);
    this.updateTransforms();
    this.invalidateBounds();
  }
}

export function serializeMaterial(m) {
  const tex = (t) => (t ? t.__name || null : null);
  return {
    baseColor: [...m.baseColor],
    metalness: m.metalness,
    roughness: m.roughness,
    emissive: [...m.emissive],
    emissiveIntensity: m.emissiveIntensity,
    opacity: m.opacity,
    normalStrength: m.normalStrength,
    baseMap: tex(m.baseMap),
    normalMap: tex(m.normalMap),
    mrMap: tex(m.mrMap),
    emissiveMap: tex(m.emissiveMap),
  };
}

export function deserializeMaterial(j, resolveTex = () => null) {
  const m = defaultMaterial();
  if (!j) return m;
  m.baseColor = j.baseColor || m.baseColor;
  m.metalness = j.metalness ?? 0;
  m.roughness = j.roughness ?? 0.6;
  m.emissive = j.emissive || [0, 0, 0];
  m.emissiveIntensity = j.emissiveIntensity ?? 1;
  m.opacity = j.opacity ?? 1;
  m.normalStrength = j.normalStrength ?? 1;
  m.baseMap = j.baseMap ? resolveTex(j.baseMap) : null;
  m.normalMap = j.normalMap ? resolveTex(j.normalMap) : null;
  m.mrMap = j.mrMap ? resolveTex(j.mrMap) : null;
  m.emissiveMap = j.emissiveMap ? resolveTex(j.emissiveMap) : null;
  return m;
}
