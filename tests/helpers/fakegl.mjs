// 极简 WebGL2 模拟：只记录调用与状态，用于在 Node 中走通渲染代码路径。
export function createFakeGL() {
  const log = { calls: [], uniforms: {}, textures: 0, programs: 0, draws: [], uniformInts: new Map() };
  const GL = {};
  const enums = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86, TEXTURE_2D: 0x0de1, RGBA8: 0x8058, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, LINEAR_MIPMAP_LINEAR: 0x2703,
    FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5, DEPTH_COMPONENT24: 0x81a6, DEPTH_COMPONENT: 0x1902,
    UNSIGNED_INT: 0x1405, HALF_FLOAT: 0x140b, RGBA16F: 0x881a, NEAREST: 0x2600,
    TEXTURE_COMPARE_MODE: 0x884c, COMPARE_REF_TO_TEXTURE: 0x884d, TEXTURE_COMPARE_FUNC: 0x884e,
    LEQUAL: 0x0203, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406, TRIANGLES: 0x0004, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT_2: 0x1405,
    DEPTH_TEST: 0x0b71, CULL_FACE: 0x0b44, BLEND: 0x0be2, BACK: 0x0405, FRONT: 0x0404,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, MAX_TEXTURE_SIZE: 0x0d33, MAX_SAMPLES: 0x8d57,
    TEXTURE0: 0x84c0, UNPACK_FLIP_Y_WEBGL: 0x9240, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1, DEPTH_MASK: 0x0b72,
  };
  Object.assign(GL, enums);
  const mk = (n) => { log.calls.push(n); return {}; };
  GL.getExtension = () => null;
  GL.getParameter = (p) => {
    if (p === enums.MAX_TEXTURE_SIZE) return 4096;
    if (p === enums.MAX_SAMPLES) return 4;
    return 1;
  };
  GL.createShader = () => mk('createShader');
  GL.shaderSource = (s, src) => { s.src = src; };
  GL.compileShader = () => {};
  GL.getShaderParameter = () => true;
  GL.getShaderInfoLog = () => '';
  GL.createProgram = () => mk('createProgram');
  GL.attachShader = () => {};
  GL.linkProgram = () => {};
  GL.deleteShader = () => {};
  GL.getProgramParameter = (p, what) => (what === enums.LINK_STATUS ? true : UNIFORM_COUNT);
  GL.getProgramInfoLog = () => '';
  let uniIdx = 0;
  const UNIFORMS = ['uModel','uNormalMatrix','uVP','uBaseColor','uMetalness','uRoughness','uEmissive','uOpacity','uNormalStrength','uBaseMap','uNormalMap','uMRMap','uEmissiveMap','uHasBaseMap','uHasNormalMap','uHasMRMap','uHasEmissiveMap','uTexLevelBias','uLightDir','uLightColor','uLightIntensity','uAmbientSky','uAmbientGround','uCamPos','uLightVP','uShadowMap','uShadowTexel','uShadowStrength','uReceiveShadow','uTex','uBloomStrength','uExposure','uVignette','uTonemap','uScene','uBloom','uThreshold','uKnee','uTexel','uDir','uInvVP','uSkyColor','uGroundColor','uHorizonColor','uSkyIntensity','uSunDir','uSunColor','uAlpha','uColor','uEmissiveBoost','uSize','uCenter','uFade','uLineColor','uAxisX','uAxisZ','uSharpness','uSkinned','uSkinMats','uBoneCount'];
  const UNIFORM_COUNT = UNIFORMS.length;
  GL.getActiveUniform = (prog, i) => ({ name: UNIFORMS[i % UNIFORMS.length], size: 1, type: 0 });
  let locId = 0; GL.getUniformLocation = (p, name) => ({ id: ++locId, __name: name });
  void uniIdx;
  GL.createTexture = () => { log.textures++; return {}; };
  GL.bindTexture = () => {};
  GL.texImage2D = () => {};
  GL.texParameteri = () => {};
  GL.texParameterf = () => {};
  GL.generateMipmap = () => {};
  GL.createFramebuffer = () => ({});
  GL.bindFramebuffer = () => {};
  GL.framebufferTexture2D = () => {};
  GL.checkFramebufferStatus = () => enums.FRAMEBUFFER_COMPLETE;
  GL.deleteFramebuffer = () => {};
  GL.deleteTexture = () => {};
  GL.createVertexArray = () => ({});
  GL.bindVertexArray = () => {};
  GL.createBuffer = () => ({});
  GL.bindBuffer = () => {};
  GL.bufferData = () => {};
  GL.enableVertexAttribArray = () => {};
  GL.vertexAttribPointer = () => {};
  GL.vertexAttribIPointer = () => {};
  GL.disableVertexAttribArray = () => {};
  GL.vertexAttrib4f = () => {};
  GL.deleteVertexArray = () => {};
  GL.deleteBuffer = () => {};
  GL.useProgram = (p) => { log.currentProgram = p; };
  GL.uniformMatrix4fv = (loc, t, v) => {
    if (!v) log.badMatrix = true;
    else if (v.length % 16 !== 0) log.badMatrix = true;
    (log.matrix4Uploads || (log.matrix4Uploads = [])).push(v);
  };
  GL.uniformMatrix3fv = (loc, t, v) => { if (!v || v.length !== 9) log.badMatrix3 = true; };
  GL.uniform1f = () => {};
  GL.uniform1i = (loc, v) => { log.uniformInts.set(loc && loc.__name || String(loc && loc.id || 'anon'), v); };
  GL.uniform2f = () => {};
  GL.uniform2fv = () => {};
  GL.uniform3f = () => {};
  GL.uniform3fv = () => {};
  GL.uniform4fv = () => {};
  GL.viewport = () => {};
  GL.clearColor = () => {};
  GL.clear = () => {};
  GL.enable = () => {};
  GL.disable = () => {};
  GL.depthFunc = () => {};
  GL.depthMask = () => {};
  GL.cullFace = () => {};
  GL.blendFunc = () => {};
  GL.blendFuncSeparate = () => {};
  GL.activeTexture = () => {};
  GL.pixelStorei = () => {};
  GL.drawElements = (mode, count) => { log.draws.push(count / 3); GL.__draws = (GL.__draws||0)+1; };
  GL.drawArrays = (mode, first, count) => { log.draws.push(count); GL.__draws = (GL.__draws||0)+1; };
  GL.deleteProgram = () => {};
  GL.canvas = { width: 1280, height: 720 };
  return { gl: GL, log };
}
