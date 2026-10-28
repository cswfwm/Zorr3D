import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as S from '../engine/shaders.js';

// 与渲染器实际使用的着色器一一对应；GLSL ES 3.00 的严格校验交给 glslangValidator，
// 它能抓到 WebGL 实现层同样会拒绝的问题（例如采样器缺少精度限定符）。
const PROGRAMS = [
  ['pbr', 'MESH_VS', 'MESH_FS'],
  ['shadow', 'SHADOW_VS', 'SHADOW_FS'],
  ['sky', 'SKY_VS', 'SKY_FS'],
  ['bloom', 'FULLSCREEN_VS', 'BLOOM_PREFS'],
  ['blur', 'FULLSCREEN_VS', 'BLUR_FS'],
  ['composite', 'FULLSCREEN_VS', 'COMPOSITE_FS'],
  ['copy', 'FULLSCREEN_VS', 'COPY_FS'],
  ['fxaa', 'FULLSCREEN_VS', 'FXAA_FS'],
  ['grid', 'GRID_VS', 'GRID_FS'],
  ['unlit', 'UNLIT_VS', 'UNLIT_FS'],
];

const hasValidator = (() => {
  try {
    execFileSync('glslangValidator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('所有着色器都有 #version 300 es 且不含 WebGL1 语法', () => {
  for (const [, vs, fsName] of PROGRAMS) {
    for (const name of [vs, fsName]) {
      const src = S[name];
      assert.ok(src, `${name} 不存在`);
      assert.ok(src.startsWith('#version 300 es'), `${name} 缺少 GLSL ES 3.00 版本声明`);
      assert.ok(!/\battribute\b|\bvarying\b|\btexture2D\s*\(/.test(src), `${name} 含 WebGL1 语法`);
    }
  }
});

test('片元着色器声明了采样器精度', () => {
  for (const [, , fsName] of PROGRAMS) {
    const src = S[fsName];
    assert.ok(/precision\s+(lowp|mediump|highp)\s+sampler2D/.test(src), `${fsName} 缺少 sampler2D 精度`);
  }
});

test('glslang 严格编译全部着色器', { skip: !hasValidator && '未安装 glslangValidator' }, async () => {
  const dir = fs.mkdtempSync('/tmp/glsl-');
  try {
    for (const [prog, vs, fsName] of PROGRAMS) {
      const vPath = path.join(dir, `${prog}.vert`);
      const fPath = path.join(dir, `${prog}.frag`);
      // 用与运行期一致的源码（注入 MAX_BONES 之后再编译）
      const { prepareSource } = await import('../engine/gl.js');
      fs.writeFileSync(vPath, prepareSource(S[vs]));
      fs.writeFileSync(fPath, prepareSource(S[fsName]));
      for (const file of [vPath, fPath]) {
        try {
          execFileSync('glslangValidator', [file], { encoding: 'utf8' });
        } catch (err) {
          assert.fail(`${path.basename(file)} 编译失败:\n${err.stdout || err.message}`);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('着色器源码经过规范化后才能交给驱动', async () => {
  const { prepareSource } = await import('../engine/gl.js');
  const { MESH_FS, MESH_VS } = S;
  for (const src of [MESH_VS, MESH_FS]) {
    const out = prepareSource('\n\n  ' + src);
    assert.ok(out.startsWith('#version'), '前导空白应被剥离');
    assert.ok(out.includes('void main'));
  }
  assert.throws(() => prepareSource('precision highp float;'), /#version/);
});

test('着色器源码只含 ASCII（避免压缩后出现 \\u 转义导致驱动拒绝）', () => {
  for (const [name, src] of Object.entries(S)) {
    if (typeof src !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7F]/.test(src), `${name} 含非 ASCII 字符`);
  }
});

test('着色器与 JS 共用同一份 MAX_BONES（编译前注入，不依赖运行时插值）', async () => {
  const { MAX_BONES } = await import('../engine/skeleton.js');
  const { prepareSource } = await import('../engine/gl.js');
  const compiled = prepareSource(S.MESH_VS);
  const m = compiled.match(/#define\s+MAX_BONES\s+(\d+)/);
  assert.ok(m, '编译前的源码里应有 MAX_BONES 宏');
  assert.equal(Number(m[1]), MAX_BONES, `注入值 ${m[1]} 与 JS 常量 ${MAX_BONES} 不一致`);
  // 源码本身不得含插值占位符（压缩后不会被求值）
  assert.ok(!/\$\{/.test(S.MESH_VS), '着色器源码不应含 ${} 占位符');
  for (const name of ['MESH_VS', 'SHADOW_VS']) {
    const u = S[name].match(/uniform\s+mat4\s+uSkinMats\[(\w+)\]/);
    assert.ok(u, `${name} 缺少 uSkinMats 数组`);
    assert.equal(u[1], 'MAX_BONES', `${name} 的数组长度应为宏`);
  }
});

test('骨骼 uniform 数组不超过顶点 uniform 预算', async () => {
  const { MAX_BONES } = await import('../engine/skeleton.js');
  // GLES3 规范保证 MAX_VERTEX_UNIFORM_VECTORS >= 256；骨骼数组占 MAX_BONES*4 个 vec4，
  // 还要给 uModel/uVP/uNormalMatrix/阴影矩阵等留出空间，因此上限 32。
  const boneVec4 = MAX_BONES * 4;
  assert.ok(boneVec4 <= 128, `骨骼数组占用 ${boneVec4} 个 vec4，超出移动端安全预算`);
  assert.ok(MAX_BONES >= 20, '至少要能放下 19 根骨骼的人形');
});
