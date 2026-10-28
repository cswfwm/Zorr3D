// 用假 GL 跑通渲染管线，检查矩阵尺寸、绘制批次与不变量。
import { createFakeGL } from './helpers/fakegl.mjs';
import { Renderer, defaultMaterial } from '../engine/renderer.js';
import { Scene, SceneNode } from '../engine/scene.js';
import { PRIMITIVES } from '../engine/geometry.js';

const { gl, log } = createFakeGL();
const canvas = { width: 0, height: 0, clientWidth: 1280, clientHeight: 720, getContext: () => gl };
const r = new Renderer(canvas);
r.resize(1280, 720, 1, 1);

const scene = new Scene(r);
const up = (geo) => r.ctx.uploadMesh(geo);

const ground = new SceneNode('地面');
ground.geometry = PRIMITIVES.plane(24, 24);
ground.mesh = up(ground.geometry);
ground.material = defaultMaterial();
ground.castShadow = false;
ground.primitive = 'plane';

const box = new SceneNode('箱子');
box.geometry = PRIMITIVES.box(1, 1, 1);
box.mesh = up(box.geometry);
box.material = defaultMaterial();
box.position = [0, 0.5, 0];
box.primitive = 'box';

// 透明物体走单独通道
const glass = new SceneNode('玻璃');
glass.geometry = PRIMITIVES.sphere(0.5, 12, 8);
glass.mesh = up(glass.geometry);
glass.material = Object.assign(defaultMaterial(), { opacity: 0.4 });
glass.position = [1, 1, 0];

scene.addNode(ground);
scene.addNode(box);
scene.addNode(glass);
scene.showGrid = true;

log.draws.length = 0;
r.render(scene, scene.camera);

const checks = [];
const ok = (name, cond, extra = '') => { checks.push([name, cond, extra]); if (!cond) console.log('FAIL:', name, extra); };

ok('没有抛异常并产出绘制调用', log.draws.length > 0, `draws=${log.draws.length}`);
ok('矩阵 uniform 都是 16 长度', !log.badMatrix);
ok('法线矩阵是 9 长度', !log.badMatrix3);
ok('每个可见网格都画了一次', r.stats.objects === 3, `objects=${r.stats.objects}`);
ok('三角面统计大于 0', r.stats.triangles > 0, `tris=${r.stats.triangles}`);
ok('阴影贴图已创建', !!r.shadow.tex);

// 视锥剔除：把物体挪到相机背后应被剔除
box.position = [0, 0.5, 9999];
box.markDirty();
scene.updateTransforms();
r.render(scene, scene.camera);
ok('视野外物体被剔除', r.stats.objects === 2, `objects=${r.stats.objects}`);

// 关闭阴影后不再渲染阴影通道
r.shadow.enabled = false;
box.position = [0, 0.5, 0];
box.markDirty();
scene.updateTransforms();
r.render(scene, scene.camera);
ok('关闭阴影仍能正常渲染', r.stats.objects === 3);

console.log(checks.filter((c) => c[1]).length + '/' + checks.length + ' 通过');
process.exit(checks.every((c) => c[1]) ? 0 : 1);
