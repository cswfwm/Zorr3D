// 变换 Gizmo：在裁剪空间里做命中测试，拖动时把屏幕位移映射为轴向移动量。

import { m4, v3, quat, rad2deg } from "./math.js";

const AXIS_COLORS = {
  x: [0.93, 0.28, 0.32],
  y: [0.45, 0.85, 0.3],
  z: [0.28, 0.55, 0.95],
  all: [0.85, 0.85, 0.9],
};

export class Gizmo {
  constructor(renderer) {
    this.r = renderer;
    this.mode = "move";
    this.space = "world";
    this.hover = null;
    this.dragging = null;
    this.size = 92; // 屏幕像素半径
    this.geo = null;
    this._geoLib = null;
    this._ensure();
  }

  _ensure() {
    if (this.geo || !this._geoLib) return;
    const { box, cylinder, torus, cone, sphere } = this._geoLib;
    this.geo = {
      box: this.r.ctx.uploadMesh(box(1, 1, 1)),
      cylinder: this.r.ctx.uploadMesh(cylinder(0.5, 0.5, 1, 16, true)),
      cone: this.r.ctx.uploadMesh(cone(0.5, 1, 16)),
      torus: this.r.ctx.uploadMesh(torus(0.5, 0.06, 32, 10)),
      sphere: this.r.ctx.uploadMesh(sphere(0.5, 16, 12)),
    };
  }

  setGeometryLib(lib) {
    this._geoLib = lib;
    this._ensure();
  }

  // 把世界点投到像素
  project(p, vp, w, h) {
    const c = v3.transformMat4([0, 0, 0], p, vp);
    return [(c[0] * 0.5 + 0.5) * w, (0.5 - c[1] * 0.5) * h, c[2]];
  }

  // 命中测试：返回 'x' | 'y' | 'z' | 'all' | null
  hitTest(node, mouseX, mouseY, width, height, vp) {
    if (this.mode === "select") return null;
    const origin = [node.worldMatrix[12], node.worldMatrix[13], node.worldMatrix[14]];
    const center = this.project(origin, vp, width, height);
    const axes = this.worldAxes(node);
    const S = this.size;
    const threshold = this.mode === "rotate" ? 9 : 7;

    if (this.mode === "move") {
      // 轴向线段 + 箭头
      for (const key of ["x", "y", "z"]) {
        const a = v3.add([0, 0, 0], origin, v3.scale([0, 0, 0], axes[key], this.worldScale(node, vp, width, height, S)));
        const b = this.project(a, vp, width, height);
        const d = distToSegment(mouseX, mouseY, center[0], center[1], b[0], b[1]);
        if (d < threshold) return key;
      }
      // 中心自由移动
      if (Math.hypot(mouseX - center[0], mouseY - center[1]) < 12) return "all";
    } else if (this.mode === "rotate") {
      for (const key of ["x", "y", "z"]) {
        // 圆环：以投影中心为圆心、半径随距离变化
        const edge = v3.add([0, 0, 0], origin, v3.scale([0, 0, 0], axes[key === "x" ? "y" : "x"], this.worldScale(node, vp, width, height, S)));
        const ep = this.project(edge, vp, width, height);
        const rad = Math.hypot(ep[0] - center[0], ep[1] - center[1]);
        const d = Math.abs(Math.hypot(mouseX - center[0], mouseY - center[1]) - rad);
        if (d < threshold && rad > 6) return key;
      }
    } else if (this.mode === "scale") {
      for (const key of ["x", "y", "z"]) {
        const a = v3.add([0, 0, 0], origin, v3.scale([0, 0, 0], axes[key], this.worldScale(node, vp, width, height, S)));
        const b = this.project(a, vp, width, height);
        const d = distToSegment(mouseX, mouseY, center[0], center[1], b[0], b[1]);
        if (d < threshold) return key;
      }
      if (Math.hypot(mouseX - center[0], mouseY - center[1]) < 12) return "all";
    }
    return null;
  }

  // 让 gizmo 在世界空间保持固定的屏幕像素长度
  worldScale(node, vp, width, height, pixels) {
    const origin = [node.worldMatrix[12], node.worldMatrix[13], node.worldMatrix[14]];
    const o = this.project(origin, vp, width, height);
    const e = this.project(v3.add([0, 0, 0], origin, [1, 0, 0]), vp, width, height);
    const perUnit = Math.hypot(e[0] - o[0], e[1] - o[1]);
    if (perUnit < 1e-5) return 1;
    return pixels / perUnit;
  }

  worldAxes(node) {
    const m = node.worldMatrix;
    if (this.space === "local") {
      return {
        x: v3.normalize([0, 0, 0], [m[0], m[1], m[2]]),
        y: v3.normalize([0, 0, 0], [m[4], m[5], m[6]]),
        z: v3.normalize([0, 0, 0], [m[8], m[9], m[10]]),
      };
    }
    return { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  }

  // 拖动开始
  begin(node, axis, mouseX, mouseY, vp) {
    const origin = [node.worldMatrix[12], node.worldMatrix[13], node.worldMatrix[14]];
    const axes = this.worldAxes(node);
    const axisDir = axis === "all" ? [0, 0, 0] : axes[axis];
    const center = this.project(origin, vp, this._w || 1, this._h || 1);
    this.dragging = {
      node,
      axis,
      startX: mouseX,
      startY: mouseY,
      origin: [...origin],
      axisDir: [...axisDir],
      startPos: [...node.position],
      startRot: [...node.rotation],
      startScale: [...node.scale],
      startEuler: node.euler,
      startWorldRot: mat4ToQuat(node.worldMatrix),
      parentWorldRot: node.parent ? mat4ToQuat(node.parent.worldMatrix) : null,
      centerScreen: center,
      latest: null,
    };
    return this.dragging;
  }

  // 拖动更新：返回新变换（已写入 node）
  update(mouseX, mouseY, vp, width, height, snap, camera) {
    const d = this.dragging;
    if (!d) return;
    const node = d.node;
    this._w = width;
    this._h = height;

    if (this.mode === "move") {
      const worldDelta = this.screenToWorldDelta(d, mouseX, mouseY, vp, width, height, camera);
      let local = worldDelta;
      if (node.parent) {
        const inv = m4.invert(m4.create(), node.parent.worldMatrix);
        if (inv) {
          const p0 = v3.transformMat4([0, 0, 0], d.startPos, node.parent.worldMatrix);
          const p1 = v3.add([0, 0, 0], p0, worldDelta);
          local = v3.sub([0, 0, 0], v3.transformMat4([0, 0, 0], p1, inv), d.startPos);
        }
      }
      const next = v3.add([0, 0, 0], d.startPos, local);
      if (snap > 0) {
        if (d.axis === "all") next.forEach((v, i) => { next[i] = Math.round(v / snap) * snap; });
        else {
          const idx = { x: 0, y: 1, z: 2 }[d.axis];
          next[idx] = Math.round(next[idx] / snap) * snap;
        }
      }
      node.position = next;
    } else if (this.mode === "rotate") {
      const angle = this.screenAngle(d, mouseX, mouseY, vp, width, height);
      const q = quat.fromAxisAngle([0, 0, 0, 1], d.axisDir, angle);
      // 世界旋转叠加到起始旋转，再换算回父空间
      let world = quat.mul([0, 0, 0, 1], q, d.startWorldRot);
      if (snap > 0) {
        const e = quat.toEulerXYZ(world);
        const s = (snap * Math.PI) / 180;
        world = quat.fromEulerXYZ([0, 0, 0, 1], Math.round(e[0] / s) * s, Math.round(e[1] / s) * s, Math.round(e[2] / s) * s);
      }
      if (d.parentWorldRot) {
        const inv = [-d.parentWorldRot[0], -d.parentWorldRot[1], -d.parentWorldRot[2], d.parentWorldRot[3]];
        node.rotation = quat.normalize([0, 0, 0, 1], quat.mul([0, 0, 0, 1], inv, world));
      } else {
        node.rotation = quat.normalize([0, 0, 0, 1], world);
      }
    } else if (this.mode === "scale") {
      const k = this.screenScaleFactor(d, mouseX, mouseY, width, height);
      const factor = Math.max(0.01, 1 + k);
      if (d.axis === "all") node.scale = d.startScale.map((v) => Math.max(0.01, v * factor));
      else {
        const idx = { x: 0, y: 1, z: 2 }[d.axis];
        const next = [...node.scale];
        next[idx] = Math.max(0.01, d.startScale[idx] * factor);
        node.scale = next;
      }
    }
    node.markDirty();
    d.latest = {
      position: [...node.position],
      rotation: [...node.rotation],
      scale: [...node.scale],
    };
  }

  // 屏幕平移 → 世界位移（沿 gizmo 轴投影）
  screenToWorldDelta(d, mx, my, vp, width, height) {
    const originS = this.project(d.origin, vp, width, height);
    if (d.axis === "all") {
      // 平行于屏幕的平面：用相机的 right/up 换算
      const cam = this._camera;
      const dist = cam ? v3.dist(cam.position, d.origin) : 5;
      const wpp = (2 * dist * Math.tan((cam ? cam.fov : 55) * Math.PI / 360)) / height;
      const right = cam ? v3.normalize([0, 0, 0], v3.cross([0, 0, 0], v3.sub([0, 0, 0], cam.target, cam.position), cam.up)) : [1, 0, 0];
      const up = cam ? v3.normalize([0, 0, 0], v3.cross([0, 0, 0], right, v3.sub([0, 0, 0], cam.target, cam.position))) : [0, 1, 0];
      return v3.add([0, 0, 0], v3.scale([0, 0, 0], right, (mx - d.startX) * wpp), v3.scale([0, 0, 0], up, -(my - d.startY) * wpp));
    }
    // 轴投影：把轴延伸到屏幕上，计算鼠标位移在轴屏幕方向上的分量
    const far = v3.add([0, 0, 0], d.origin, v3.scale([0, 0, 0], d.axisDir, 1));
    const farS = this.project(far, vp, width, height);
    const ax = farS[0] - originS[0];
    const ay = farS[1] - originS[1];
    const len2 = ax * ax + ay * ay;
    if (len2 < 1e-6) return [0, 0, 0];
    const t = ((mx - d.startX) * ax + (my - d.startY) * ay) / len2;
    return v3.scale([0, 0, 0], d.axisDir, t);
  }

  screenAngle(d, mx, my, vp, width, height) {
    const c = this.project(d.origin, vp, width, height);
    const a0 = Math.atan2(d.startY - c[1], d.startX - c[0]);
    const a1 = Math.atan2(my - c[1], mx - c[0]);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // 轴背向相机时方向应反转，避免"转反了"
    const viewDir = this._camera ? v3.normalize([0, 0, 0], v3.sub([0, 0, 0], d.origin, this._camera.position)) : [0, 0, -1];
    const facing = v3.dot(d.axisDir, viewDir) < 0 ? 1 : -1;
    return delta * facing;
  }

  screenScaleFactor(d, mx, my, width, height) {
    const c = d.centerScreen;
    const r0 = Math.max(1, Math.hypot(d.startX - c[0], d.startY - c[1]));
    const r1 = Math.hypot(mx - c[0], my - c[1]);
    return (r1 - r0) / 80;
  }

  end() {
    const info = this.dragging;
    this.dragging = null;
    return info;
  }

  /* ---------------- 绘制 ---------------- */

  draw(node, vp, width, height, camera, viewport) {
    if (!node || this.mode === "select") return;
    const { gl } = this.r;
    const p = this.r.progUnlit;
    // 命中测试用 CSS 像素，绘制投影用帧缓冲像素，两者需各自的视口尺寸
    const fbW = viewport ? viewport[0] : width;
    const fbH = viewport ? viewport[1] : height;
    this._w = width;
    this._h = height;
    this._camera = camera;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.get("uVP"), false, vp);
    gl.uniform1f(p.uniforms.get("uAlpha"), 1);
    gl.uniform1f(p.uniforms.get("uEmissiveBoost"), 0.25);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const origin = [node.worldMatrix[12], node.worldMatrix[13], node.worldMatrix[14]];
    const axes = this.worldAxes(node);
    const S = this.worldScale(node, vp, fbW, fbH, this.size * (fbW / Math.max(width, 1)));
    const active = this.dragging ? this.dragging.axis : this.hover;

    const drawPart = (geoKey, matrix, color, alpha = 1) => {
      gl.uniformMatrix4fv(p.uniforms.get("uModel"), false, matrix);
      gl.uniform3fv(p.uniforms.get("uColor"), color);
      gl.uniform1f(p.uniforms.get("uAlpha"), alpha);
      this.geo[geoKey].draw();
    };

    const model = m4.create();
    const tmp = m4.create();
    const axisMatrix = (dir, length, offset) => {
      // 构造把单位 Y 轴对齐到 dir 的矩阵
      const dirN = v3.normalize([0, 0, 0], dir);
      const up = Math.abs(dirN[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
      const x = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], up, dirN));
      const z = v3.cross([0, 0, 0], dirN, x);
      m4.identity(model);
      model[0] = x[0]; model[1] = x[1]; model[2] = x[2];
      model[4] = dirN[0]; model[5] = dirN[1]; model[6] = dirN[2];
      model[8] = z[0]; model[9] = z[1]; model[10] = z[2];
      const pos = v3.add([0, 0, 0], origin, v3.scale([0, 0, 0], dirN, offset));
      model[12] = pos[0]; model[13] = pos[1]; model[14] = pos[2];
      const sx = length * 0.055, sy = length * 0.5, sz = length * 0.055;
      m4.multiply(tmp, model, m4.fromTRS(m4.create(), [0, 0, 0], [0, 0, 0, 1], [sx, sy, sz]));
      return tmp;
    };

    if (this.mode === "move" || this.mode === "scale") {
      for (const key of ["x", "y", "z"]) {
        const isActive = active === key;
        const color = isActive ? [1, 0.85, 0.2] : AXIS_COLORS[key];
        drawPart("cylinder", axisMatrix(axes[key], S, S * 0.45), color);
        const endMatrix = axisMatrix(axes[key], S, S * 0.95);
        if (this.mode === "move") {
          // 箭头：圆锥（用单位矩阵缩放后平移）
          const dirN = v3.normalize([0, 0, 0], axes[key]);
          const pos = v3.add([0, 0, 0], origin, v3.scale([0, 0, 0], dirN, S * 1.02));
          const coneM = m4.fromTRS(m4.create(), pos, quatFromDir(dirN), [S * 0.12, S * 0.22, S * 0.12]);
          drawPart("cone", coneM, color);
        } else {
          const boxM = m4.fromTRS(m4.create(), [
            origin[0] + axes[key][0] * S,
            origin[1] + axes[key][1] * S,
            origin[2] + axes[key][2] * S,
          ], [0, 0, 0, 1], [S * 0.11, S * 0.11, S * 0.11]);
          drawPart("box", boxM, color);
        }
        void endMatrix;
      }
      if (active === "all") {
        const c = m4.fromTRS(m4.create(), origin, [0, 0, 0, 1], [S * 0.1, S * 0.1, S * 0.1]);
        drawPart("sphere", c, [1, 0.85, 0.2]);
      } else {
        const c = m4.fromTRS(m4.create(), origin, [0, 0, 0, 1], [S * 0.06, S * 0.06, S * 0.06]);
        drawPart("sphere", c, AXIS_COLORS.all);
      }
    } else if (this.mode === "rotate") {
      for (const key of ["x", "y", "z"]) {
        const isActive = active === key;
        const color = isActive ? [1, 0.85, 0.2] : AXIS_COLORS[key];
        const normal = axes[key];
        const up = Math.abs(normal[1]) > 0.99 ? [0, 1, 0] : v3.normalize([0, 0, 0], v3.cross([0, 0, 0], normal, [0, 1, 0]));
        const xAxis = v3.cross([0, 0, 0], up, normal);
        m4.identity(model);
        model[0] = xAxis[0]; model[1] = xAxis[1]; model[2] = xAxis[2];
        model[4] = up[0]; model[5] = up[1]; model[6] = up[2];
        model[8] = normal[0]; model[9] = normal[1]; model[10] = normal[2];
        model[12] = origin[0]; model[13] = origin[1]; model[14] = origin[2];
        const m2 = m4.fromTRS(m4.create(), [0, 0, 0], [0, 0, 0, 1], [S * 0.95, S * 0.95, S * 0.95]);
        drawPart("torus", m4.multiply(m4.create(), model, m2), color, isActive ? 1 : 0.92);
      }
    }

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function quatFromDir(dir) {
  const up = Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const x = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], up, dir));
  const z = v3.cross([0, 0, 0], dir, x);
  const m = m4.create();
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = dir[0]; m[5] = dir[1]; m[6] = dir[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  return mat4ToQuat(m);
}

function mat4ToQuat(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [
    m[0] / sx, m[1] / sx, m[2] / sx,
    m[4] / sy, m[5] / sy, m[6] / sy,
    m[8] / sz, m[9] / sz, m[10] / sz,
  ];
  const tr = r[0] + r[4] + r[8];
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (r[7] - r[5]) / s;
    y = (r[2] - r[6]) / s;
    z = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    w = (r[7] - r[5]) / s;
    x = 0.25 * s;
    y = (r[1] + r[3]) / s;
    z = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    w = (r[2] - r[6]) / s;
    x = (r[1] + r[3]) / s;
    y = 0.25 * s;
    z = (r[5] + r[7]) / s;
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    w = (r[3] - r[1]) / s;
    x = (r[2] + r[6]) / s;
    y = (r[5] + r[7]) / s;
    z = 0.25 * s;
  }
  return quat.normalize([0, 0, 0, 1], [x, y, z, w]);
}

void rad2deg;
