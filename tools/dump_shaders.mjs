// 把引擎里的着色器按"运行期最终形态"（已注入 MAX_BONES）导出为文件，供构建期做严格编译校验。
import fs from "node:fs";
import path from "node:path";
import * as S from "../engine/shaders.js";
import { prepareSource } from "../engine/gl.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("用法: node dump_shaders.mjs <输出目录>");
  process.exit(1);
}

const PROGRAMS = [
  ["pbr", "MESH_VS", "MESH_FS"],
  ["shadow", "SHADOW_VS", "SHADOW_FS"],
  ["sky", "SKY_VS", "SKY_FS"],
  ["bloom", "FULLSCREEN_VS", "BLOOM_PREFS"],
  ["blur", "FULLSCREEN_VS", "BLUR_FS"],
  ["composite", "FULLSCREEN_VS", "COMPOSITE_FS"],
  ["copy", "FULLSCREEN_VS", "COPY_FS"],
  ["fxaa", "FULLSCREEN_VS", "FXAA_FS"],
  ["grid", "GRID_VS", "GRID_FS"],
  ["unlit", "UNLIT_VS", "UNLIT_FS"],
  ["bone", "BONE_VS", "BONE_FS"],
];

fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const [name, vs, fsName] of PROGRAMS) {
  fs.writeFileSync(path.join(outDir, `${name}.vert`), prepareSource(S[vs]));
  fs.writeFileSync(path.join(outDir, `${name}.frag`), prepareSource(S[fsName]));
  n += 2;
}
console.log(`导出 ${n} 个着色器`);
