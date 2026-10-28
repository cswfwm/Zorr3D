// WebGL2 轻量封装：程序编译、纹理、帧缓冲、网格上传、错误诊断。

import { MAX_BONES } from "./skeleton.js";

export class GLContext {
  constructor(canvas) {
    const opts = {
      alpha: false,
      antialias: false, // 用 FXAA，避免 MSAA 在移动 GPU 上的高带宽
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    };
    const gl = canvas.getContext("webgl2", opts);
    if (!gl) throw new Error("此设备不支持 WebGL2");
    this.gl = gl;
    this.canvas = canvas;
    this.ext = {
      colorFloat: gl.getExtension("EXT_color_buffer_float"),
      floatBlend: gl.getExtension("EXT_float_blend"),
      aniso: gl.getExtension("EXT_texture_filter_anisotropic"),
      lose: gl.getExtension("WEBGL_lose_context"),
    };
    this.anisoMax = this.ext.aniso
      ? gl.getParameter(this.ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  compile(type, src, label) {
    const { gl } = this;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, prepareSource(src));
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || "";
      gl.deleteShader(sh);
      throw new Error(`[${label}] 着色器编译失败:\n${formatLog(log, src)}`);
    }
    return sh;
  }

  program(vsSrc, fsSrc, label = "program") {
    const { gl } = this;
    const vs = this.compile(gl.VERTEX_SHADER, vsSrc, label + ".vs");
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc, label + ".fs");
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`[${label}] 链接失败: ${log}`);
    }
    // 缓存 uniform / attribute 位置
    const uniforms = new Map();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const base = info.name.replace(/\[0\]$/, "");
      uniforms.set(base, gl.getUniformLocation(prog, info.name));
    }
    return { prog, uniforms, label };
  }

  texture2D({ width, height, data = null, internalFormat = null, format = null, type = null, filter = null, wrap = null, mipmap = false, aniso = true }) {
    const { gl } = this;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = filter ?? gl.LINEAR;
    const w = wrap ?? gl.CLAMP_TO_EDGE;
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      internalFormat ?? gl.RGBA8,
      width, height, 0,
      format ?? gl.RGBA,
      type ?? gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : filter ?? gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter ?? gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    if (aniso && this.anisoMax > 1) {
      gl.texParameterf(gl.TEXTURE_2D, this.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, this.anisoMax));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // 颜色附件纹理（浮点渲染目标）
  hdrTexture(width, height) {
    const { gl } = this;
    const float = this.ext.colorFloat;
    const internal = float ? gl.RGBA16F : gl.RGBA8;
    const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const tex = this.texture2D({ width, height, internalFormat: internal, format: gl.RGBA, type, aniso: false });
    return tex;
  }

  depthTexture(width, height, compare = false) {
    const { gl } = this;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, compare ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, compare ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (compare) {
      // sampler2DShadow 必须开启硬件比较，否则采样结果无定义
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  framebuffer(colorTex, depthTex = null) {
    const { gl } = this;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    if (depthTex) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("帧缓冲不完整: 0x" + status.toString(16));
    }
    return fbo;
  }

  // 上传网格到 VAO/VBO，返回可绘制对象
  uploadMesh(geo) {
    const { gl } = this;
    let meshBoneBuffer = null;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const count = geo.vertexCount;
    const interleaved = new Float32Array(count * 12);
    for (let i = 0; i < count; i++) {
      const o = i * 12;
      interleaved[o] = geo.positions[i * 3];
      interleaved[o + 1] = geo.positions[i * 3 + 1];
      interleaved[o + 2] = geo.positions[i * 3 + 2];
      interleaved[o + 3] = geo.normals[i * 3];
      interleaved[o + 4] = geo.normals[i * 3 + 1];
      interleaved[o + 5] = geo.normals[i * 3 + 2];
      interleaved[o + 6] = geo.uvs[i * 2];
      interleaved[o + 7] = geo.uvs[i * 2 + 1];
      interleaved[o + 8] = geo.tangents[i * 4];
      interleaved[o + 9] = geo.tangents[i * 4 + 1];
      interleaved[o + 10] = geo.tangents[i * 4 + 2];
      interleaved[o + 11] = geo.tangents[i * 4 + 3];
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

    const indexType = count > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      count > 65535 ? new Uint32Array(geo.indices) : new Uint16Array(geo.indices),
      gl.STATIC_DRAW,
    );

    const attr = (loc, size, offset) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 48, offset * 4);
    };
    attr(0, 3, 0);
    attr(1, 3, 3);
    attr(2, 2, 6);
    attr(3, 4, 8);

    // 蒙皮属性：骨骼索引走整数属性，避免 float->int 转换带来的精度问题
    const skinned = !!(geo.skinIndices && geo.skinWeights);
    if (skinned) {
      const boneBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, boneBuf);
      const packed = new Uint8Array(count * 8);
      for (let i = 0; i < count; i++) {
        packed[i * 8] = geo.skinIndices[i * 4];
        packed[i * 8 + 1] = geo.skinIndices[i * 4 + 1];
        packed[i * 8 + 2] = geo.skinIndices[i * 4 + 2];
        packed[i * 8 + 3] = geo.skinIndices[i * 4 + 3];
        // 权重用 8 位量化为 0..255，归一化后还原
        packed[i * 8 + 4] = Math.round(geo.skinWeights[i * 4] * 255);
        packed[i * 8 + 5] = Math.round(geo.skinWeights[i * 4 + 1] * 255);
        packed[i * 8 + 6] = Math.round(geo.skinWeights[i * 4 + 2] * 255);
        packed[i * 8 + 7] = Math.round(geo.skinWeights[i * 4 + 3] * 255);
      }
      gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_BYTE, 8, 0);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, 8, 4);
      meshBoneBuffer = boneBuf;
    } else {
      // 普通网格：蒙皮属性必须显式关闭。attribute 的 enable 状态属于 VAO，
      // 若沿用上一个 VAO 打开的 4/5 号槽位，会读到别的缓冲区里的野数据。
      gl.disableVertexAttribArray(4);
      gl.disableVertexAttribArray(5);
      // 关闭后仍要给出线性默认值，避免某些驱动把未定义值喂给着色器
      gl.vertexAttrib4f(4, 0, 0, 0, 0);
      gl.vertexAttrib4f(5, 0, 0, 0, 0);
    }
    gl.bindVertexArray(null);

    return {
      vao,
      vbo,
      ibo,
      boneBuffer: meshBoneBuffer,
      skinned: !!(geo.skinIndices && geo.skinWeights),
      indexCount: geo.indices.length,
      indexType,
      vertexCount: count,
      // 多个节点可共享同一个网格（如复制物体），用引用计数避免误释放
      _refs: 1,
      retain() {
        this._refs++;
        return this;
      },
      dispose: () => {
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(vbo);
        gl.deleteBuffer(ibo);
        if (meshBoneBuffer) gl.deleteBuffer(meshBoneBuffer);
      },
      release() {
        this._refs--;
        if (this._refs <= 0) this.dispose();
      },
      draw: () => {
        gl.bindVertexArray(vao);
        gl.drawElements(gl.TRIANGLES, geo.indices.length, indexType, 0);
      },
    };
  }
}

// GLSL 规定 #version 必须是源码的第一个记号：去掉任何前导空白，否则部分实现直接拒绝编译
export function prepareSource(src) {
  let out = src.replace(/^\s+/, "");
  if (!out.startsWith("#version")) {
    throw new Error("着色器源码必须以 #version 开头");
  }
  // 骨骼数组长度由这里注入，与 CPU 侧的 MAX_BONES 保持单一来源
  if (!/#define\s+MAX_BONES\s+\d+/.test(out)) {
    out = out.replace(/^(#version[^\n]*\n)/, `$1#define MAX_BONES ${MAX_BONES}\n`);
  }
  return out;
}

function formatLog(log, src) {
  const lines = src.split("\n");
  return log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/ERROR:\s*\d+:(\d+):(.*)/);
      if (m) {
        const ln = parseInt(m[1], 10);
        return `行 ${ln}: ${m[2].trim()}\n    > ${(lines[ln - 1] || "").trim()}`;
      }
      return l;
    })
    .join("\n");
}
