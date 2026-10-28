



// MAX_BONES 宏由渲染器在编译前拼接（见 gl.js 的 prepareSource），
// 避免在模板字符串里插值：压缩后插值会退化成运行时表达式，静态检查拿不到真实数值。
const header = `#version 300 es
precision highp float;
precision highp int;
// Sampler types need explicit precision or the fragment shader fails to compile
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCube;
`;

const common = `
const float PI = 3.14159265359;

float distributionGGX(vec3 N, vec3 H, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

float geometrySchlickGGX(float NdotV, float rough) {
  float r = rough + 1.0;
  float k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

float geometrySmith(float NdotV, float NdotL, float rough) {
  return geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


vec3 skyColor(vec3 dir, vec3 zenith, vec3 horizon, vec3 ground) {
  float y = dir.y;
  if (y >= 0.0) return mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.55));
  return mix(horizon, ground, pow(clamp(-y, 0.0, 1.0), 0.45));
}


float sampleShadow(sampler2DShadow map, vec3 proj, float bias, vec2 texel) {
  float sum = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      sum += texture(map, vec3(proj.xy + vec2(float(x), float(y)) * texel * 1.2, proj.z - bias));
    }
  }
  return sum / 9.0;
}
`;

export const MESH_VS = header + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aTangent;
layout(location = 4) in uvec4 aBoneIndices;
layout(location = 5) in vec4 aBoneWeights;

uniform mat4 uModel;
uniform mat4 uVP;
uniform mat3 uNormalMatrix;

// Skinning matrices arrive as a uniform array: uSkinMats[i] is bone i's world * inverse-bind.
// A uniform array beats a bone texture here: no texel fetch or manual unpack, and no
// sampling precision issues on mobile GPUs. Unused slots are filled with identity on the CPU.
uniform mat4 uSkinMats[MAX_BONES];
uniform int uSkinned;
uniform int uBoneCount;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec4 vTangent;

mat4 skinMatrix() {
  int i0 = int(aBoneIndices.x);
  int i1 = int(aBoneIndices.y);
  int i2 = int(aBoneIndices.z);
  int i3 = int(aBoneIndices.w);
  mat4 m = uSkinMats[i0] * aBoneWeights.x;
  m += uSkinMats[i1] * aBoneWeights.y;
  m += uSkinMats[i2] * aBoneWeights.z;
  m += uSkinMats[i3] * aBoneWeights.w;
  return m;
}

void main() {
  vec4 localPos = vec4(aPos, 1.0);
  vec3 localNrm = aNormal;
  vec3 localTan = aTangent.xyz;
  if (uSkinned == 1) {
    mat4 sm = skinMatrix();
    localPos = sm * localPos;
    localNrm = mat3(sm) * localNrm;
    localTan = mat3(sm) * localTan;
  }
  vec4 wp = uModel * localPos;
  vWorldPos = wp.xyz;
  vNormal = normalize(uNormalMatrix * localNrm);
  vTangent = vec4(normalize(uNormalMatrix * localTan), aTangent.w);
  vUV = aUV;
  gl_Position = uVP * wp;
}
`;

export const MESH_FS = header + common + `
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec4 vTangent;

uniform vec4 uBaseColor;
uniform float uMetalness;
uniform float uRoughness;
uniform vec3 uEmissive;
uniform float uOpacity;
uniform float uNormalStrength;

uniform sampler2D uBaseMap;
uniform sampler2D uNormalMap;
uniform sampler2D uMRMap;
uniform sampler2D uEmissiveMap;
uniform int uHasBaseMap;
uniform int uHasNormalMap;
uniform int uHasMRMap;
uniform int uHasEmissiveMap;
uniform float uTexLevelBias;

uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uCamPos;

uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

uniform mat4 uLightVP;
uniform sampler2DShadow uShadowMap;
uniform float uShadowTexel;
uniform float uShadowStrength;   // 0 = no shadow, 1 = fully dark
uniform int uReceiveShadow;

layout(location = 0) out vec4 outColor;

void main() {
  vec3 albedo = uBaseColor.rgb;
  float alpha = uBaseColor.a * uOpacity;
  if (uHasBaseMap == 1) {
    vec4 t = texture(uBaseMap, vUV, uTexLevelBias);
    albedo *= t.rgb;
    alpha *= t.a;
  }
  if (alpha < 0.01) discard;

  float metallic = uMetalness;
  float rough = uRoughness;
  if (uHasMRMap == 1) {
    vec4 mr = texture(uMRMap, vUV, uTexLevelBias);
    rough *= mr.g;
    metallic *= mr.b;
  }
  rough = clamp(rough, 0.04, 1.0);

  vec3 N = normalize(vNormal);
  if (uHasNormalMap == 1) {
    vec3 T = normalize(vTangent.xyz);
    vec3 B = cross(N, T) * vTangent.w;
    vec3 tn = texture(uNormalMap, vUV, uTexLevelBias).xyz * 2.0 - 1.0;
    tn.xy *= uNormalStrength;
    N = normalize(mat3(T, B, N) * tn);
  }

  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(V + L);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotL = max(dot(N, L), 0.0);

  float shadow = 1.0;
  if (uReceiveShadow == 1) {
    vec4 lp = uLightVP * vec4(vWorldPos + N * 0.02, 1.0);
    vec3 proj = lp.xyz / lp.w * 0.5 + 0.5;
    if (proj.x > 0.0 && proj.x < 1.0 && proj.y > 0.0 && proj.y < 1.0 && proj.z < 1.0) {
      float bias = max(0.0015 * (1.0 - dot(N, L)), 0.0004);
      shadow = mix(1.0, sampleShadow(uShadowMap, proj, bias, vec2(uShadowTexel)), uShadowStrength);
    }
  }

  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
  float D = distributionGGX(N, H, rough);
  float G = geometrySmith(NdotV, NdotL, rough);
  vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);
  vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);

  vec3 radiance = uLightColor * uLightIntensity;
  vec3 direct = (kD * albedo / PI + specular) * radiance * NdotL * shadow;



  vec3 R = reflect(-V, N);
  vec3 envSpec = skyColor(mix(N, R, 1.0 - rough * 0.8), uAmbientSky * 1.5, uAmbientSky, uAmbientGround);
  vec3 envDiff = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);
  vec3 Fenv = fresnelSchlick(NdotV, F0);
  vec3 ambient = (kD * albedo * envDiff * 0.34 + envSpec * Fenv * (1.0 - rough * 0.75) * 0.55);

  vec3 color = direct + ambient;


  color += albedo * pow(1.0 - NdotV, 3.0) * 0.08;

  vec3 emissive = uEmissive;
  if (uHasEmissiveMap == 1) emissive *= texture(uEmissiveMap, vUV, uTexLevelBias).rgb;
  color += emissive;


  vec3 toCam = uCamPos - vWorldPos;
  float dist = length(toCam);
  float fog = clamp((dist - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.0, 1.0);
  fog = fog * fog * (3.0 - 2.0 * fog);
  color = mix(color, uFogColor, fog);

  outColor = vec4(color, alpha);
}
`;

export const SHADOW_VS = header + `
layout(location = 0) in vec3 aPos;
layout(location = 4) in uvec4 aBoneIndices;
layout(location = 5) in vec4 aBoneWeights;
uniform mat4 uModel;
uniform mat4 uLightVP;
uniform mat4 uSkinMats[MAX_BONES];
uniform int uSkinned;
void main() {
  vec4 p = vec4(aPos, 1.0);
  if (uSkinned == 1) {
    mat4 sm = uSkinMats[int(aBoneIndices.x)] * aBoneWeights.x
            + uSkinMats[int(aBoneIndices.y)] * aBoneWeights.y
            + uSkinMats[int(aBoneIndices.z)] * aBoneWeights.z
            + uSkinMats[int(aBoneIndices.w)] * aBoneWeights.w;
    p = sm * p;
  }
  gl_Position = uLightVP * uModel * p;
}
`;

export const SHADOW_FS = header + `
void main() {}
`;

export const SKY_VS = header + `
layout(location = 0) in vec3 aPos;
uniform mat4 uInvVP;
out vec3 vDir;
void main() {
  vec4 p = uInvVP * vec4(aPos.xy, 1.0, 1.0);
  vDir = p.xyz / p.w;
  gl_Position = vec4(aPos.xy, 1.0, 1.0);
}
`;

export const SKY_FS = header + common + `
in vec3 vDir;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uHorizonColor;
uniform float uSkyIntensity;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, uSkyColor, uHorizonColor, uGroundColor) * uSkyIntensity;
  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  c += uSunColor * (pow(sun, 900.0) * 6.0 + pow(sun, 24.0) * 0.25);
  outColor = vec4(c, 1.0);
}
`;


export const FULLSCREEN_VS = header + `
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;


export const BLOOM_PREFS = header + `
in vec2 vUV;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;
uniform vec2 uTexel;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 c = vec3(0.0);
  c += texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uTex, vUV + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(uTex, vUV + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(uTex, vUV + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float lum = max(c.r, max(c.g, c.b));
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, lum - uThreshold) / max(lum, 1e-4);
  outColor = vec4(c * contribution, 1.0);
}
`;

export const BLUR_FS = header + `
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;
layout(location = 0) out vec4 outColor;

void main() {

  vec3 c = texture(uTex, vUV).rgb * 0.227027;
  c += texture(uTex, vUV + uDir * 1.384615).rgb * 0.316216;
  c += texture(uTex, vUV - uDir * 1.384615).rgb * 0.316216;
  c += texture(uTex, vUV + uDir * 3.230769).rgb * 0.070270;
  c += texture(uTex, vUV - uDir * 3.230769).rgb * 0.070270;
  outColor = vec4(c, 1.0);
}
`;


export const COMPOSITE_FS = header + `
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uVignette;
uniform int uTonemap;
layout(location = 0) out vec4 outColor;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 reinhard(vec3 x) { return x / (x + vec3(1.0)); }

void main() {
  vec3 c = texture(uScene, vUV).rgb;
  vec3 b = texture(uBloom, vUV).rgb;
  c += b * uBloomStrength;
  c *= uExposure;
  if (uTonemap == 0) c = aces(c);
  else if (uTonemap == 1) c = reinhard(c);
  else c = clamp(c, 0.0, 1.0);

  vec2 q = vUV - 0.5;
  float vig = 1.0 - uVignette * dot(q, q) * 1.6;
  c *= clamp(vig, 0.0, 1.0);

  // linear -> sRGB
  c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}
`;


export const GRID_VS = header + `
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
uniform float uSize;
uniform vec3 uCenter;
out vec3 vWorld;
void main() {
  vec3 p = vec3(aPos.x * uSize + uCenter.x, 0.0, aPos.z * uSize + uCenter.z);
  vWorld = p;
  gl_Position = uVP * vec4(p, 1.0);
}
`;

export const GRID_FS = header + `
in vec3 vWorld;
uniform vec3 uCamPos;
uniform float uFade;
uniform vec3 uLineColor;
uniform vec3 uAxisX;
uniform vec3 uAxisZ;
layout(location = 0) out vec4 outColor;

float gridLine(vec2 coord, float scale) {
  vec2 g = abs(fract(coord / scale - 0.5) - 0.5) / fwidth(coord / scale);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec2 c = vWorld.xz;
  float minor = gridLine(c, 1.0) * 0.35;
  float major = gridLine(c, 10.0) * 0.6;
  float line = clamp(minor + major, 0.0, 1.0);
  float ax = 1.0 - smoothstep(0.0, fwidth(c.y) * 1.5 + 0.001, abs(c.y));
  float az = 1.0 - smoothstep(0.0, fwidth(c.x) * 1.5 + 0.001, abs(c.x));
  vec3 col = uLineColor * line;
  col = mix(col, uAxisX, ax * 0.9);
  col = mix(col, uAxisZ, az * 0.9);
  float alpha = max(line, max(ax, az));
  float dist = length(vWorld.xz - uCamPos.xz);
  alpha *= 1.0 - smoothstep(uFade * 0.45, uFade, dist);
  if (alpha < 0.002) discard;
  outColor = vec4(col, alpha);
}
`;


export const UNLIT_VS = header + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uVP;
uniform vec3 uColor;
uniform float uEmissiveBoost;
out vec3 vColor;
void main() {
  vColor = uColor * (1.0 + uEmissiveBoost);
  gl_Position = uVP * uModel * vec4(aPos, 1.0);
}
`;

export const UNLIT_FS = header + `
in vec3 vColor;
uniform float uAlpha;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(vColor, uAlpha);
}
`;


export const COPY_FS = header + `
in vec2 vUV;
uniform sampler2D uTex;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV);
}
`;


export const FXAA_FS = header + `
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharpness;
layout(location = 0) out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbM = texture(uTex, vUV).rgb;
  vec3 rgbNW = texture(uTex, vUV + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture(uTex, vUV + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture(uTex, vUV + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture(uTex, vUV + vec2( 1.0,  1.0) * uTexel).rgb;

  float lM = luma(rgbM);
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) {
    outColor = vec4(rgbM, 1.0);
    return;
  }
  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE))
  );
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel * uSharpness;

  vec3 rgbA = 0.5 * (
    texture(uTex, vUV + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture(uTex, vUV + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(uTex, vUV + dir * -0.5).rgb +
    texture(uTex, vUV + dir * 0.5).rgb
  );
  float lB = luma(rgbB);
  outColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

// 骨骼线框：把线段顶点直接画成 1px 粗细的线
export const BONE_VS = header + `
layout(location = 0) in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uVP;
void main() {
  gl_Position = uVP * uModel * vec4(aPos, 1.0);
}
`;

export const BONE_FS = header + `
uniform vec3 uColor;
uniform float uAlpha;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(uColor, uAlpha);
}
`;
