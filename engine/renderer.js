// 前向 PBR 渲染器：阴影贴图 → 场景（HDR）→ 泛光 → 合成 → FXAA。

import * as S from "./shaders.js";
import { m4, v3, clamp } from "./math.js";
import { GLContext } from "./gl.js";

export const defaultMaterial = () => ({
  baseColor: [0.8, 0.8, 0.8, 1],
  metalness: 0,
  roughness: 0.6,
  emissive: [0, 0, 0],
  opacity: 1,
  normalStrength: 1,
  baseMap: null,
  normalMap: null,
  mrMap: null,
  emissiveMap: null,
  emissiveIntensity: 1,
});

export class Renderer {
  constructor(canvas) {
    this.ctx = new GLContext(canvas);
    const { gl } = this.ctx;
    this.gl = gl;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.renderScale = 1;

    this.progMesh = this.ctx.program(S.MESH_VS, S.MESH_FS, "pbr");
    this.progShadow = this.ctx.program(S.SHADOW_VS, S.SHADOW_FS, "shadow");
    this.progSky = this.ctx.program(S.SKY_VS, S.SKY_FS, "sky");
    this.progPrefilter = this.ctx.program(S.FULLSCREEN_VS, S.BLOOM_PREFS, "bloomPrefilter");
    this.progBlur = this.ctx.program(S.FULLSCREEN_VS, S.BLUR_FS, "blur");
    this.progComposite = this.ctx.program(S.FULLSCREEN_VS, S.COMPOSITE_FS, "composite");
    this.progFxaa = this.ctx.program(S.FULLSCREEN_VS, S.FXAA_FS, "fxaa");
    this.progCopy = this.ctx.program(S.FULLSCREEN_VS, S.COPY_FS, "copy");
    this.progGrid = this.ctx.program(S.GRID_VS, S.GRID_FS, "grid");
    this.progUnlit = this.ctx.program(S.UNLIT_VS, S.UNLIT_FS, "unlit");
    this.progBone = this.ctx.program(S.BONE_VS, S.BONE_FS, "bone");
    this.gridGeo = null;

    this.fsQuad = this.createFullscreenQuad();
    this.whiteTex = this.ctx.texture2D({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    this.flatNormalTex = this.ctx.texture2D({ width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) });

    this.targets = null;
    this.shadow = { size: 2048, tex: null, fbo: null, matrix: m4.create(), enabled: true };

    this.stats = { drawCalls: 0, triangles: 0, objects: 0 };
    this._nm = new Float32Array(9);
    this._proj = m4.create();
    this._view = m4.create();
    this._vp = m4.create();
    this._identity = m4.create();
    this._lightView = m4.create();
    this._lightProj = m4.create();
  }

  createFullscreenQuad() {
    const { gl } = this;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  resize(cssWidth, cssHeight, pixelRatio, scale) {
    const w = Math.max(1, Math.floor(cssWidth * pixelRatio * scale));
    const h = Math.max(1, Math.floor(cssHeight * pixelRatio * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;
    this.gl.canvas.width = Math.floor(cssWidth * pixelRatio);
    this.gl.canvas.height = Math.floor(cssHeight * pixelRatio);
    this.disposeTargets();
    this.createTargets(w, h);
  }

  createTargets(w, h) {
    const { gl, ctx } = this;
    const sceneTex = ctx.hdrTexture(w, h);
    const sceneDepth = ctx.depthTexture(w, h);
    const sceneFbo = ctx.framebuffer(sceneTex, sceneDepth);

    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const bloomA = ctx.hdrTexture(hw, hh);
    const bloomB = ctx.hdrTexture(hw, hh);
    const bloomFboA = ctx.framebuffer(bloomA);
    const bloomFboB = ctx.framebuffer(bloomB);

    const hw2 = Math.max(1, w >> 2), hh2 = Math.max(1, h >> 2);
    const bloomC = ctx.hdrTexture(hw2, hh2);
    const bloomD = ctx.hdrTexture(hw2, hh2);
    const bloomFboC = ctx.framebuffer(bloomC);
    const bloomFboD = ctx.framebuffer(bloomD);

    // 合成结果先写到离屏纹理，最后由 FXAA / 直接拷屏输出
    const ldrTex = ctx.texture2D({ width: w, height: h, aniso: false });
    const ldrFbo = ctx.framebuffer(ldrTex);

    this.targets = {
      sceneTex, sceneDepth, sceneFbo,
      bloomA, bloomB, bloomFboA, bloomFboB,
      bloomC, bloomD, bloomFboC, bloomFboD,
      ldrTex, ldrFbo,
      w, h, hw, hh, hw2, hh2,
    };
    void gl;
  }

  disposeTargets() {
    const t = this.targets;
    if (!t) return;
    const { gl } = this;
    for (const k of ["sceneTex", "sceneDepth", "bloomA", "bloomB", "bloomC", "bloomD", "ldrTex"]) gl.deleteTexture(t[k]);
    for (const k of ["sceneFbo", "bloomFboA", "bloomFboB", "bloomFboC", "bloomFboD", "ldrFbo"]) gl.deleteFramebuffer(t[k]);
    this.targets = null;
  }

  setShadowSize(size) {
    if (size === this.shadow.size && this.shadow.tex) return;
    this.shadow.size = size;
    if (this.shadow.tex) this.gl.deleteTexture(this.shadow.tex);
    if (this.shadow.colorTex) this.gl.deleteTexture(this.shadow.colorTex);
    if (this.shadow.fbo) this.gl.deleteFramebuffer(this.shadow.fbo);
    const tex = this.ctx.depthTexture(size, size, true);
    const colorTex = this.ctx.hdrTexture(size, size);
    this.shadow.tex = tex;
    this.shadow.colorTex = colorTex;
    this.shadow.fbo = this.ctx.framebuffer(colorTex, tex);
  }

  /* ---------------- 阴影 ---------------- */

  // 用场景包围盒自动拟合正交投影，避免手调阴影范围
  computeShadowMatrix(sceneCenter, sceneRadius, sunDir) {
    const S = this.shadow;
    const r = Math.max(sceneRadius, 1);
    const up = Math.abs(sunDir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    // 先把中心对到纹素网格上，消除相机/场景移动带来的阴影边闪烁
    m4.lookAt(this._lightView, v3.add([0, 0, 0], sceneCenter, v3.scale([0, 0, 0], sunDir, r * 2.0)), sceneCenter, up);
    const texel = (2 * r) / S.size;
    const inLight = v3.transformMat4([0, 0, 0], sceneCenter, this._lightView);
    const snapped = [
      Math.round(inLight[0] / texel) * texel,
      Math.round(inLight[1] / texel) * texel,
      inLight[2],
    ];
    const invLight = m4.invert(m4.create(), this._lightView);
    const center = invLight ? v3.transformMat4([0, 0, 0], snapped, invLight) : sceneCenter;
    const eye = v3.add([0, 0, 0], center, v3.scale([0, 0, 0], sunDir, r * 2.0));
    m4.lookAt(this._lightView, eye, center, up);
    m4.ortho(this._lightProj, -r, r, -r, r, 0.05, r * 4.5);
    m4.multiply(S.matrix, this._lightProj, this._lightView);
    return S.matrix;
  }

  renderShadowMap(objects, sunDir, sceneCenter, sceneRadius) {
    const { gl, ctx } = this;
    const S = this.shadow;
    if (!S.enabled) return;
    this.setShadowSize(S.size);
    const mat = this.computeShadowMatrix(sceneCenter, sceneRadius, sunDir);
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.fbo);
    gl.viewport(0, 0, S.size, S.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); // 正面剔除减少 peter-panning
    const p = this.progShadow;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.get("uLightVP"), false, mat);
    const shadowSkinLoc = p.uniforms.get("uSkinMats");
    const shadowSkinnedLoc = p.uniforms.get("uSkinned");
    for (const obj of objects) {
      if (!obj.mesh || obj.castShadow === false) continue;
      gl.uniformMatrix4fv(p.uniforms.get("uModel"), false, obj.worldMatrix);
      if (obj.skeleton && obj.mesh.skinned) {
        gl.uniform1i(shadowSkinnedLoc, 1);
        gl.uniformMatrix4fv(shadowSkinLoc, false, obj.skeleton.skin);
      } else {
        gl.uniform1i(shadowSkinnedLoc, 0);
      }
      obj.mesh.draw();
    }
    gl.cullFace(gl.BACK);
  }

  /* ---------------- 主渲染 ---------------- */

  render(scene, camera, opts = {}) {
    const { gl, ctx } = this;
    const t = this.targets;
    if (!t) return;
    const quality = scene.environment;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.objects = 0;

    // 骨架更新：同一帧内每个骨架只算一次，避免重复的世界矩阵与 uniform 上传
    const skeletons = scene.skeletons ? scene.skeletons() : [];
    const frameStamp = (this._frameId = (this._frameId || 0) + 1);
    for (const sk of skeletons) {
      if (sk.dirty || sk._lastUpdate !== frameStamp) {
        sk.update();
        sk._lastUpdate = frameStamp;
      }
    }

    const sunDir = v3.normalize([0, 0, 0], scene.light.direction);
    const sunColor = scene.light.color;
    const sunIntensity = scene.light.intensity;

    // 场景包围球（阴影拟合用）
    const bounds = scene.bounds3D();
    if (this.shadow.enabled) {
      this.renderShadowMap(scene.renderables(), sunDir, bounds.center, bounds.radius);
    }

    // 相机矩阵
    const aspect = t.w / t.h;
    m4.perspective(this._proj, (camera.fov * Math.PI) / 180, aspect, camera.near, camera.far);
    m4.copy(this._view, camera.viewMatrix());
    m4.multiply(this._vp, this._proj, this._view);
    const invVP = m4.invert(m4.create(), this._vp);

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.sceneFbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 天空
    if (scene.showSky) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      const sp = this.progSky;
      gl.useProgram(sp.prog);
      gl.uniformMatrix4fv(sp.uniforms.get("uInvVP"), false, invVP);
      gl.uniform3fv(sp.uniforms.get("uSkyColor"), quality.skyColor);
      gl.uniform3fv(sp.uniforms.get("uGroundColor"), quality.groundColor);
      gl.uniform3fv(sp.uniforms.get("uHorizonColor"), quality.horizonColor);
      gl.uniform1f(sp.uniforms.get("uSkyIntensity"), quality.skyIntensity);
      gl.uniform3fv(sp.uniforms.get("uSunDir"), sunDir);
      gl.uniform3fv(sp.uniforms.get("uSunColor"), sunColor);
      gl.bindVertexArray(this.fsQuad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    }

    // 主通道
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    const p = this.progMesh;
    const u = p.uniforms;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(u.get("uVP"), false, this._vp);
    gl.uniform3fv(u.get("uLightDir"), sunDir);
    gl.uniform3fv(u.get("uLightColor"), sunColor);
    gl.uniform1f(u.get("uLightIntensity"), sunIntensity);
    gl.uniform3fv(u.get("uAmbientSky"), quality.skyColor);
    gl.uniform3fv(u.get("uAmbientGround"), quality.groundColor);
    gl.uniform3fv(u.get("uCamPos"), camera.position);
    gl.uniformMatrix4fv(u.get("uLightVP"), false, this.shadow.matrix);
    gl.uniform1f(u.get("uShadowTexel"), 1 / this.shadow.size);
    gl.uniform1f(u.get("uShadowStrength"), this.shadow.enabled ? 0.92 : 0);
    const fog = scene.environment.fog;
    gl.uniform3fv(u.get("uFogColor"), fog ? fog.color : scene.environment.horizonColor);
    gl.uniform1f(u.get("uFogNear"), fog ? fog.near : 1e6);
    gl.uniform1f(u.get("uFogFar"), fog ? fog.far : 1e7);
    gl.uniform1i(u.get("uReceiveShadow"), this.shadow.enabled ? 1 : 0);
    this._skinLoc = u.get("uSkinMats");
    this._skinnedLoc = u.get("uSkinned");

    // 纹理单元分配
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.flatNormalTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.shadow.tex);
    gl.uniform1i(u.get("uBaseMap"), 0);
    gl.uniform1i(u.get("uNormalMap"), 1);
    gl.uniform1i(u.get("uMRMap"), 2);
    gl.uniform1i(u.get("uEmissiveMap"), 3);
    gl.uniform1i(u.get("uShadowMap"), 4);

    const opaque = [];
    const transparent = [];
    const frustum = new Frustum(this._vp);
    for (const obj of scene.renderables()) {
      if (!obj.visible) continue;
      if (!frustum.testSphere(obj.worldSphere)) continue;
      (obj.material.opacity < 0.999 || obj.material.baseColor[3] < 0.999 ? transparent : opaque).push(obj);
    }
    // 不透明由近到远（提升 early-z 效率），透明由远到近
    const camPos = camera.position;
    opaque.sort((a, b) => v3.dist(a.worldSphere.center, camPos) - v3.dist(b.worldSphere.center, camPos));
    transparent.sort((a, b) => v3.dist(b.worldSphere.center, camPos) - v3.dist(a.worldSphere.center, camPos));

    // 合批：相同材质的物体排在一起，减少 uniform 设置与纹理绑定次数
    this.batchByMaterial(opaque);
    for (const obj of opaque) this.drawObject(obj, false);

    if (transparent.length) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const obj of transparent) this.drawObject(obj, true);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    if (scene.showGrid) this.drawGrid(scene, camera, this._vp);

    gl.bindVertexArray(null);

    // 泛光
    let bloomTex = null;
    if (scene.bloom.enabled) {
      bloomTex = this.renderBloom(t.sceneTex, t);
    }

    // 合成（先写到 LDR 纹理）
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.ldrFbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.disable(gl.DEPTH_TEST);
    const cp = this.progComposite;
    gl.useProgram(cp.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.sceneTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTex || this.whiteTex);
    gl.uniform1i(cp.uniforms.get("uScene"), 0);
    gl.uniform1i(cp.uniforms.get("uBloom"), 1);
    gl.uniform1f(cp.uniforms.get("uBloomStrength"), bloomTex ? scene.bloom.strength : 0);
    gl.uniform1f(cp.uniforms.get("uExposure"), scene.environment.exposure);
    gl.uniform1f(cp.uniforms.get("uVignette"), scene.environment.vignette);
    gl.uniform1i(cp.uniforms.get("uTonemap"), scene.environment.tonemap);
    gl.bindVertexArray(this.fsQuad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 输出到默认帧缓冲
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    if (scene.antialias === "fxaa") {
      const fp = this.progFxaa;
      gl.useProgram(fp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.ldrTex);
      gl.uniform1i(fp.uniforms.get("uTex"), 0);
      gl.uniform2f(fp.uniforms.get("uTexel"), 1 / t.w, 1 / t.h);
      gl.uniform1f(fp.uniforms.get("uSharpness"), 1.0);
    } else {
      const bp = this.progCopy;
      gl.useProgram(bp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.ldrTex);
      gl.uniform1i(bp.uniforms.get("uTex"), 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    void opts;
  }

  renderBloom(sceneTex, t) {
    const { gl } = this;
    const pre = this.progPrefilter;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.fsQuad);

    // 1) 亮度提取 + 半分辨率
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.bloomFboA);
    gl.viewport(0, 0, t.hw, t.hh);
    gl.useProgram(pre.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(pre.uniforms.get("uTex"), 0);
    gl.uniform1f(pre.uniforms.get("uThreshold"), 0.9);
    gl.uniform1f(pre.uniforms.get("uKnee"), 0.4);
    gl.uniform2f(pre.uniforms.get("uTexel"), 1 / t.w, 1 / t.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) 模糊链：1/2 → 1/4
    const blur = this.progBlur;
    gl.useProgram(blur.prog);
    gl.uniform1i(blur.uniforms.get("uTex"), 0);
    const pass = (srcTex, dstFbo, w, h, dx, dy) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(blur.uniforms.get("uDir"), dx / w, dy / h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(t.bloomA, t.bloomFboB, t.hw, t.hh, 1, 0);
    pass(t.bloomB, t.bloomFboA, t.hw, t.hh, 0, 1);
    pass(t.bloomA, t.bloomFboC, t.hw2, t.hh2, 1.4, 1.4);
    pass(t.bloomC, t.bloomFboD, t.hw2, t.hh2, 1.4, 0);
    pass(t.bloomD, t.bloomFboC, t.hw2, t.hh2, 0, 1.4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t.bloomC;
  }

  drawGrid(scene, camera, vp) {
    const { gl } = this;
    if (!this.gridGeo) {
      // 单位正方形，顶点在 xz 平面（着色器里乘 uSize 铺开）
      const geo = {
        positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1],
        normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
        vertexCount: 4,
        indexCount: 6,
      };
      this.gridGeo = this.ctx.uploadMesh(geo);
    }
    const p = this.progGrid;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.get("uVP"), false, vp);
    gl.uniform1f(p.uniforms.get("uSize"), 200);
    gl.uniform3f(p.uniforms.get("uCenter"), camera.target[0], 0, camera.target[2]);
    gl.uniform3fv(p.uniforms.get("uCamPos"), camera.position);
    gl.uniform1f(p.uniforms.get("uFade"), 120);
    gl.uniform3f(p.uniforms.get("uLineColor"), 0.42, 0.45, 0.5);
    gl.uniform3f(p.uniforms.get("uAxisX"), 0.85, 0.25, 0.3);
    gl.uniform3f(p.uniforms.get("uAxisZ"), 0.25, 0.45, 0.9);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.gridGeo.draw();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.stats.drawCalls++;
  }

  // 按材质分组排序：同一材质的物体相邻绘制，省掉重复的纹理绑定与 uniform 设置
  batchByMaterial(list) {
    const keyOf = (o) => {
      const m = o.material;
      return [
        m.baseMap ? "b" : "-",
        m.normalMap ? "n" : "-",
        m.mrMap ? "m" : "-",
        m.emissiveMap ? "e" : "-",
        m.metalness.toFixed(2),
        m.roughness.toFixed(2),
        m.baseColor.join(","),
        m.emissive.join(","),
        m.emissiveIntensity,
        m.opacity,
      ].join("|");
    };
    for (const o of list) o._batchKey = keyOf(o);
    // 只按材质键排序，同键保持原有近到远顺序（Array.sort 在现代引擎里是稳定的）
    list.sort((a, b) => (a._batchKey < b._batchKey ? -1 : a._batchKey > b._batchKey ? 1 : 0));
  }

  // 绘制骨架线框：每根骨骼一条线，末端用小球标出关节
  drawSkeleton(node, vp, camPos) {
    if (!node.skeleton || !node.geometry) return;
    const { gl } = this;
    const sk = node.skeleton;
    sk.update();

    // 线段顶点：绑定姿势下的骨骼位置，模型矩阵与网格一致
    const segs = sk.bones.map((_, i) => sk.restSegment(i));
    const verts = [];
    for (const sgm of segs) {
      verts.push(sgm.start[0], sgm.start[1], sgm.start[2]);
      verts.push(sgm.end[0], sgm.end[1], sgm.end[2]);
    }
    if (!this._boneLineGeo || this._boneLineCount !== segs.length) {
      if (this._boneVao) {
        gl.deleteVertexArray(this._boneVao);
        gl.deleteBuffer(this._boneVbo);
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this._boneVao = vao;
      this._boneVbo = vbo;
      this._boneLineCount = segs.length;
    }
    gl.bindVertexArray(this._boneVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._boneVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);

    const p = this.progBone;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.get("uModel"), false, node.worldMatrix);
    gl.uniformMatrix4fv(p.uniforms.get("uVP"), false, vp);
    gl.uniform3f(p.uniforms.get("uColor"), 1.0, 0.72, 0.2);
    gl.uniform1f(p.uniforms.get("uAlpha"), 1.0);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.LINES, 0, segs.length * 2);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    void camPos;
  }

  drawObject(obj, transparent) {
    const { gl } = this;
    const p = this.progMesh;
    const u = p.uniforms;
    const mat = obj.material;
    m4.normalMatrix(this._nm, obj.worldMatrix);
    gl.uniformMatrix4fv(u.get("uModel"), false, obj.worldMatrix);
    gl.uniformMatrix3fv(u.get("uNormalMatrix"), false, this._nm);
    gl.uniform4fv(u.get("uBaseColor"), mat.baseColor);
    gl.uniform1f(u.get("uMetalness"), mat.metalness);
    gl.uniform1f(u.get("uRoughness"), mat.roughness);
    gl.uniform3fv(u.get("uEmissive"), v3.scale([0, 0, 0], mat.emissive, mat.emissiveIntensity));
    gl.uniform1f(u.get("uOpacity"), mat.opacity);
    gl.uniform1f(u.get("uNormalStrength"), mat.normalStrength);
    gl.uniform1f(u.get("uTexLevelBias"), 0);

    // 蒙皮：uSkinMats 是全局 uniform，同一帧内绘制不同骨架必须重新上传，
    // 否则后一个骨架会套用前一个的矩阵（表现为人物散架）。
    if (obj.skeleton && obj.mesh.skinned) {
      if (obj.skeleton._drawnMatrix !== obj.skeleton.skin || obj.skeleton._drawnFrame !== this._frameId) {
        gl.uniformMatrix4fv(this._skinLoc, false, obj.skeleton.skin);
        obj.skeleton._drawnMatrix = obj.skeleton.skin;
        obj.skeleton._drawnFrame = this._frameId;
      }
      gl.uniform1i(this._skinnedLoc, 1);
    } else {
      gl.uniform1i(this._skinnedLoc, 0);
    }

    const bind = (unit, tex, flagUniform, hasFlag) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || (unit === 1 ? this.flatNormalTex : this.whiteTex));
      gl.uniform1i(u.get(flagUniform), tex ? 1 : 0);
      void hasFlag;
    };
    bind(0, mat.baseMap, "uHasBaseMap", true);
    bind(1, mat.normalMap, "uHasNormalMap", true);
    bind(2, mat.mrMap, "uHasMRMap", true);
    bind(3, mat.emissiveMap, "uHasEmissiveMap", true);

    obj.mesh.draw();
    this.stats.drawCalls++;
    this.stats.triangles += obj.mesh.indexCount / 3;
    this.stats.objects++;
    void transparent;
  }

  dispose() {
    this.disposeTargets();
    const { gl } = this;
    if (this._boneVao) gl.deleteVertexArray(this._boneVao);
    if (this._boneVbo) gl.deleteBuffer(this._boneVbo);
    if (this.shadow.tex) gl.deleteTexture(this.shadow.tex);
    if (this.shadow.fbo) gl.deleteFramebuffer(this.shadow.fbo);
  }
}

/* ---------------- 视锥剔除 ---------------- */

class Frustum {
  constructor(vp) {
    // 提取 6 个平面（列主序）
    const m = vp;
    const planes = this.planes || (this.planes = new Float32Array(24));
    const rows = [
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    ];
    rows.forEach((r, i) => {
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      planes[i * 4] = r[0] / l;
      planes[i * 4 + 1] = r[1] / l;
      planes[i * 4 + 2] = r[2] / l;
      planes[i * 4 + 3] = r[3] / l;
    });
  }

  testSphere(s) {
    const p = this.planes;
    const [cx, cy, cz] = s.center;
    const r = s.radius;
    for (let i = 0; i < 6; i++) {
      const d = p[i * 4] * cx + p[i * 4 + 1] * cy + p[i * 4 + 2] * cz + p[i * 4 + 3];
      if (d < -r) return false;
    }
    return true;
  }
}

// 由 math.js 引入，避免循环依赖
void clamp;
