// 编辑器主程序：渲染循环、相机操作、选择、Gizmo、面板、撤销重做、存取。

import { m4, v3, clamp, deg2rad } from "../../engine/math.js";
import { PRIMITIVES, parseOBJ, computeBounds } from "../../engine/geometry.js";
import { Renderer, defaultMaterial } from "../../engine/renderer.js";
import { Scene, SceneNode } from "../../engine/scene.js";
import { Gizmo } from "../../engine/gizmo.js";
import { parseGLB, gltfPrimitiveToGeometry, gltfMaterial, gltfToSceneGraph } from "../../engine/gltf.js";
import { uploadRawTexture, stoneTexture, metalTexture } from "../../engine/textures.js";
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from "../../engine/rig.js";
import { AnimationPlayer, AnimationClip } from "../../engine/animation.js";

const $ = (sel) => document.querySelector(sel);
const state = {
  tool: "select",
  animating: true,   // 场景中存在角色时是否推进骨骼动画
  timelineClip: null, // 时间轴正在预览的动作
  timelineTime: 0,
  timelineScrub: false,
  showSkeleton: false,
  space: "world",
  snapMove: 0,
  snapRotate: 0,
  panel: null,
  playing: false,
  fps: 0,
  showGrid: true,
};

let renderer, scene, gizmo;
let canvas;
let vpMatrix = m4.create();
let dirty = true;
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 60;
const textures = {};

/* ---------------- 提示 ---------------- */

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function status(msg) {
  $("#status-text").textContent = msg;
}

/* ---------------- 初始化 ---------------- */

function init() {
  canvas = $("#viewport");
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:40px;color:#ff9a9a;font:13px/1.6 monospace;white-space:pre-wrap">${escapeHtml(String((err && err.message) || err))}</pre>`;
    return;
  }
  scene = new Scene(renderer);
  gizmo = new Gizmo(renderer);
  gizmo.setGeometryLib({
    box: PRIMITIVES.box,
    cylinder: () => PRIMITIVES.cylinder(),
    cone: () => PRIMITIVES.cone(),
    torus: () => PRIMITIVES.torus(),
    sphere: () => PRIMITIVES.sphere(),
  });
  scene.uploadGeo = (geo) => renderer.ctx.uploadMesh(geo);
  scene.updateTransforms();

  buildMaterials();
  buildDefaultScene();
  bindEvents();
  resize();
  syncPanelVisibility();
  requestAnimationFrame(loop);
  status("已就绪 · 点击层级里的物体开始编辑");
}

function buildMaterials() {
  textures.stone = stoneTexture(256, 7);
  textures.metal = metalTexture(256, 11);
  const ctx = renderer.ctx;
  textures.stoneBase = uploadRawTexture(ctx, textures.stone, { srgb: true });
  textures.stoneNormal = uploadRawTexture(ctx, { width: textures.stone.width, height: textures.stone.height, data: textures.stone.normal });
  textures.mrMap = uploadRawTexture(ctx, textures.metal);
  textures.stoneBase.__name = "stoneBase";
  textures.stoneNormal.__name = "stoneNormal";
  textures.mrMap.__name = "mrMap";
}

/* ---------------- 默认场景 ---------------- */

function buildDefaultScene() {
  const ground = new SceneNode("地面");
  ground.primitive = "plane";
  const gGeo = PRIMITIVES.plane(24, 24);
  ground.geometry = gGeo;
  ground.mesh = renderer.ctx.uploadMesh(gGeo);
  ground.material = defaultMaterial();
  ground.material.baseColor = [0.42, 0.43, 0.46, 1];
  ground.material.baseMap = textures.stoneBase;
  ground.material.normalMap = textures.stoneNormal;
  ground.material.roughness = 0.92;
  ground.material.metalness = 0;
  ground.castShadow = false;

  const pillar = new SceneNode("石柱");
  pillar.primitive = "cylinder";
  const pGeo = PRIMITIVES.cylinder(0.5, 0.5, 2, 32);
  pillar.geometry = pGeo;
  pillar.mesh = renderer.ctx.uploadMesh(pGeo);
  pillar.position = [0, 1, 0];
  pillar.material = defaultMaterial();
  pillar.material.baseMap = textures.stoneBase;
  pillar.material.normalMap = textures.stoneNormal;
  pillar.material.baseColor = [0.8, 0.79, 0.76, 1];
  pillar.material.roughness = 0.7;

  const orb = new SceneNode("发光球");
  orb.primitive = "sphere";
  const oGeo = PRIMITIVES.sphere(0.45, 32, 24);
  orb.geometry = oGeo;
  orb.mesh = renderer.ctx.uploadMesh(oGeo);
  orb.position = [1.8, 1.4, 0];
  orb.material = defaultMaterial();
  orb.material.baseColor = [0.9, 0.55, 0.2, 1];
  orb.material.metalness = 1;
  orb.material.roughness = 0.18;
  orb.material.mrMap = textures.mrMap;
  orb.material.emissive = [1.0, 0.45, 0.1];
  orb.material.emissiveIntensity = 1.6;

  const cube = new SceneNode("金属方块");
  cube.primitive = "box";
  const cGeo = PRIMITIVES.box(1, 1, 1);
  cube.geometry = cGeo;
  cube.mesh = renderer.ctx.uploadMesh(cGeo);
  cube.position = [-1.8, 0.5, 0.6];
  cube.setEulerDeg([0, 25, 0]);
  cube.material = defaultMaterial();
  cube.material.baseColor = [0.62, 0.66, 0.72, 1];
  cube.material.metalness = 1;
  cube.material.roughness = 0.28;
  cube.material.mrMap = textures.mrMap;

  cube.userData = { spin: [0, 0.6, 0] };
  orb.userData = { spin: [0, 1.1, 0] };

  scene.addNode(ground);
  scene.addNode(pillar);
  scene.addNode(orb);
  scene.addNode(cube);
  scene.camera.position = [3.8, 3.4, 5.6];
  scene.camera.target = [0, 0.6, 0];
  scene.showGrid = true;
  scene.selected = cube;
  renderTree();
  renderInspector();
}

/* ---------------- 渲染循环 ---------------- */

let lastTime = 0;
let frames = 0;
let fpsAccum = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr, renderer.renderScale || 1);
  dirty = true;
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0.016;
  lastTime = now;

  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    state.fps = frames / fpsAccum;
    frames = 0;
    fpsAccum = 0;
    $("#fps").textContent = `${state.fps.toFixed(0)} FPS`;
  }

  if (state.playing) {
    scene.root.traverse((n) => {
      if (n.userData && n.userData.spin) {
        n.setEuler(n.euler.map((v, i) => v + n.userData.spin[i] * dt));
      }
    });
  }

  // 骨骼动画：只要存在角色就推进，编辑时也能看到动作
  let animated = false;
  scene.root.traverse((n) => {
    if (n.animator && n.skeleton && (state.animating || state.playing)) {
      if (state.timelineScrub && n === scene.selected && state.timelineClip) {
        n.skeleton.bones && applyTimeline(n, state.timelineClip, state.timelineTime);
      } else {
        n.animator.update(dt, n.skeleton);
      }
      animated = true;
    }
  });

  if (!dirty && !state.playing && !animated) return;
  dirty = false;

  scene.updateTransforms();
  const w = renderer.width;
  const h = renderer.height;
  const aspect = w / h;
  m4.perspective(vpMatrix, deg2rad(scene.camera.fov), aspect, scene.camera.near, scene.camera.far);
  m4.multiply(vpMatrix, vpMatrix, scene.camera.viewMatrix());

  renderer.render(scene, scene.camera);

  // 骨架线框（仅在勾选"显示骨架"且选中角色时绘制）
  if (state.showSkeleton && scene.selected && scene.selected.skeleton) {
    const { gl } = renderer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    renderer.drawSkeleton(scene.selected, vpMatrix);
  }

  // Gizmo 叠加在默认帧缓冲上
  const { gl } = renderer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gizmo.draw(scene.selected, vpMatrix, canvas.clientWidth, canvas.clientHeight, scene.camera, [gl.canvas.width, gl.canvas.height]);

  const st = renderer.stats;
  $("#stats").textContent = `${st.objects} 物体 · ${st.drawCalls} 批次 · ${(st.triangles / 1000).toFixed(1)}k 三角面`;
}

function markDirty() {
  dirty = true;
}

/* ---------------- 相机与指针交互 ---------------- */

let pointer = { x: 0, y: 0, down: false, mode: null, lastX: 0, lastY: 0, id: null, moved: false };
let pointers = new Map();
let pinchDist = 0;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function bindEvents() {
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 120));

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, canvasPos(e));
    const p = canvasPos(e);
    pointer.down = true;
    pointer.moved = false;
    pointer.lastX = p.x;
    pointer.lastY = p.y;
    pointer.downX = p.x;
    pointer.downY = p.y;

    if (pointers.size === 2) {
      pointer.mode = "pinch";
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }

    const isMiddle = e.button === 1;
    const isRight = e.button === 2;
    const wantsCamera = isMiddle || isRight || e.shiftKey || e.altKey || e.ctrlKey;

    if (wantsCamera) {
      pointer.mode = isRight ? "pan" : "orbit";
      return;
    }

    // 先测 Gizmo
    if (scene.selected && state.tool !== "select") {
      const hit = gizmo.hitTest(scene.selected, p.x, p.y, canvas.clientWidth, canvas.clientHeight, vpMatrix);
      if (hit) {
        pushUndo("变换");
        gizmo.begin(scene.selected, hit, p.x, p.y, vpMatrix);
        pointer.mode = "gizmo";
        return;
      }
    }
    pointer.mode = "orbit";
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = canvasPos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (pointer.mode === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) scene.camera.dolly((d - pinchDist) * 0.01);
      pinchDist = d;
      markDirty();
      return;
    }

    if (!pointer.down) {
      if (scene.selected && state.tool !== "select") {
        const hit = gizmo.hitTest(scene.selected, p.x, p.y, canvas.clientWidth, canvas.clientHeight, vpMatrix);
        if (hit !== gizmo.hover) {
          gizmo.hover = hit;
          canvas.style.cursor = hit ? "pointer" : "default";
          markDirty();
        }
      }
      return;
    }

    const dx = p.x - pointer.lastX;
    const dy = p.y - pointer.lastY;
    pointer.lastX = p.x;
    pointer.lastY = p.y;
    if (Math.abs(p.x - pointer.downX) + Math.abs(p.y - pointer.downY) > 3) pointer.moved = true;

    if (pointer.mode === "orbit") {
      scene.camera.orbit(dx * 0.008, dy * 0.008);
      markDirty();
    } else if (pointer.mode === "pan") {
      scene.camera.pan(dx, dy);
      markDirty();
    } else if (pointer.mode === "gizmo" && gizmo.dragging) {
      gizmo.update(p.x, p.y, vpMatrix, canvas.clientWidth, canvas.clientHeight, state.snapMove, scene.camera);
      markDirty();
      renderInspectorTransform();
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!pointer.down) return;
    pointer.down = false;
    const p = canvasPos(e);
    if (pointer.mode === "gizmo") {
      gizmo.end();
      scene.updateTransforms();
      scene.invalidateBounds();
      renderInspector();
      status("变换完成");
    } else if (pointer.mode === "orbit" && !pointer.moved) {
      const node = scene.pick(p.x, p.y, canvas.clientWidth, canvas.clientHeight);
      selectNode(node);
    }
    pointer.mode = null;
    markDirty();
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    scene.camera.dolly(-e.deltaY * 0.0015);
    markDirty();
  }, { passive: false });

  // 键盘
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveScene(); return; }
    if (k === "q") setTool("select");
    else if (k === "w") setTool("move");
    else if (k === "e") setTool("rotate");
    else if (k === "r") setTool("scale");
    else if (k === "f") frameSelected();
    else if (k === "g") { scene.showGrid = !scene.showGrid; markDirty(); }
    else if (k === "delete" || k === "backspace") deleteSelected();
  });

  // 拖放导入
  const body = document.body;
  body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("dragging"); });
  body.addEventListener("dragleave", () => body.classList.remove("dragging"));
  body.addEventListener("drop", (e) => {
    e.preventDefault();
    body.classList.remove("dragging");
    if (e.dataTransfer.files.length) importFile(e.dataTransfer.files[0]);
  });

  // 顶栏
  document.querySelectorAll("#topbar button").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn.dataset.act));
  });
  document.querySelectorAll("#toolbar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tool) setTool(btn.dataset.tool);
      else if (btn.dataset.gizmo) toggleSpace();
      else if (btn.dataset.act === "frame") frameSelected();
    });
  });

  $("#file-open").addEventListener("change", (e) => {
    if (e.target.files[0]) loadSceneFile(e.target.files[0]);
    e.target.value = "";
  });
  $("#file-model").addEventListener("change", (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = "";
  });
}

/* ---------------- 工具与选择 ---------------- */

function setTool(tool) {
  state.tool = tool;
  gizmo.mode = tool;
  document.querySelectorAll("#toolbar button[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  markDirty();
}

function toggleSpace() {
  state.space = state.space === "world" ? "local" : "world";
  gizmo.space = state.space;
  $("#btn-space").textContent = state.space === "world" ? "世界" : "局部";
  markDirty();
}

function selectNode(node) {
  scene.selected = node;
  renderTree();
  renderInspector();
  markDirty();
  if (node) status(`已选中：${node.name}`);
  else status("未选中");
}

function frameSelected() {
  const n = scene.selected;
  if (!n) return;
  const s = n.worldSphere;
  scene.camera.frame(s.center, Math.max(s.radius, 0.3));
  markDirty();
}

function deleteSelected() {
  const n = scene.selected;
  if (!n) return;
  pushUndo("删除物体");
  scene.removeNode(n);
  scene.invalidateBounds();
  renderTree();
  renderInspector();
  markDirty();
  toast(`已删除 ${n.name}`);
}

/* ---------------- 撤销 / 重做 ---------------- */

function snapshot() {
  return JSON.stringify(scene.toJSON());
}

function pushUndo(label) {
  undoStack.push({ label, data: snapshot() });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function restore(data, label) {
  scene.loadJSON(JSON.parse(data), (geo) => renderer.ctx.uploadMesh(geo), resolveTexture, resolveGeometry, buildRigGeometry);
  state.showGrid = scene.showGrid;
  renderTree();
  renderInspector();
  markDirty();
  status(label);
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) { toast("没有可撤销的操作"); return; }
  redoStack.push({ label: entry.label, data: snapshot() });
  restore(entry.data, `已撤销：${entry.label}`);
}

function redo() {
  const entry = redoStack.pop();
  if (!entry) { toast("没有可重做的操作"); return; }
  undoStack.push({ label: entry.label, data: snapshot() });
  restore(entry.data, `已重做：${entry.label}`);
}

/* ---------------- 顶栏动作 ---------------- */

function handleAction(act) {
  switch (act) {
    case "new": newScene(); break;
    case "open": $("#file-open").click(); break;
    case "save": saveScene(); break;
    case "add": showAddMenu(); break;
    case "import": $("#file-model").click(); break;
    case "undo": undo(); break;
    case "redo": redo(); break;
    case "play": togglePlay(); break;
    case "panel-view": togglePanel("view"); break;
    case "panel-outliner": togglePanel("outliner"); break;
    case "panel-inspector": togglePanel("inspector"); break;
    case "close-outliner": togglePanel("outliner"); break;
    case "close-inspector": togglePanel("inspector"); break;
    case "close-view": togglePanel("view"); break;
    default: break;
  }
}

function newScene() {
  if (!confirm("新建会清空当前场景，确定？")) return;
  scene.loadJSON({ root: { children: [] } }, (geo) => renderer.ctx.uploadMesh(geo), resolveTexture, resolveGeometry, buildRigGeometry);
  const ground = new SceneNode("地面");
  ground.primitive = "plane";
  ground.geometry = PRIMITIVES.plane(24, 24);
  ground.mesh = renderer.ctx.uploadMesh(ground.geometry);
  ground.material = defaultMaterial();
  ground.material.baseMap = textures.stoneBase;
  ground.material.normalMap = textures.stoneNormal;
  ground.material.roughness = 0.85;
  ground.castShadow = false;
  scene.addNode(ground);
  scene.selected = null;
  undoStack.length = 0;
  redoStack.length = 0;
  renderTree();
  renderInspector();
  markDirty();
  toast("已新建场景");
}

function togglePlay() {
  state.playing = !state.playing;
  const btn = $("#btn-play");
  btn.textContent = state.playing ? "■ 停止" : "▶ 运行";
  btn.classList.toggle("active", state.playing);
  $("#toolbar").style.opacity = state.playing ? ".45" : "1";
  const hasRig = !!scene.root.children.find((c) => c.skeleton) ||
    (() => { let f = false; scene.root.traverse((n) => { if (n.skeleton) f = true; }); return f; })();
  status(state.playing ? (hasRig ? "运行中（角色动画播放）" : "运行中") : "已停止");
  state.animating = true;
  markDirty();
}

function togglePanel(name) {
  state.panel = state.panel === name ? null : name;
  syncPanelVisibility();
}

function syncPanelVisibility() {
  const narrow = window.innerWidth <= 820;
  const map = { outliner: "#outliner", inspector: "#inspector", view: "#viewpanel" };
  for (const [key, sel] of Object.entries(map)) {
    const el = $(sel);
    if (key === "view") {
      el.classList.toggle("hidden", state.panel !== "view");
      continue;
    }
    if (narrow) el.classList.toggle("open", state.panel === key);
    else el.classList.remove("open", "hidden");
  }
  if (state.panel === "view") renderViewPanel();
}

/* ---------------- 添加菜单 ---------------- */

function showAddMenu() {
  const menu = $("#add-menu");
  const items = [
    ["box", "立方体"], ["sphere", "球体"], ["cylinder", "圆柱"],
    ["cone", "圆锥"], ["torus", "圆环"], ["plane", "平面"],
    ["character", "角色（白模）"],
  ];
  menu.innerHTML = "";
  for (const [type, label] of items) {
    const b = document.createElement("button");
    b.textContent = `＋ ${label}`;
    b.addEventListener("click", () => {
      if (type === "character") addCharacter();
      else addPrimitive(type);
      menu.classList.add("hidden");
    });
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  const close = (e) => {
    if (!menu.contains(e.target) && e.target.dataset.act !== "add") {
      menu.classList.add("hidden");
      document.removeEventListener("pointerdown", close);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close), 0);
}

function addPrimitive(type) {
  pushUndo(`添加${type}`);
  const node = new SceneNode(labelFor(type));
  node.primitive = type;
  const geo = PRIMITIVES[type]();
  node.geometry = geo;
  node.mesh = renderer.ctx.uploadMesh(geo);
  node.material = defaultMaterial();
  node.position = [0, type === "plane" ? 0 : 0.5, 0];
  // 放在相机前方，避免新增物体看不见
  const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], scene.camera.target, scene.camera.position));
  const dist = Math.min(v3.dist(scene.camera.position, scene.camera.target), 6);
  node.position = v3.add([0, 0, 0], scene.camera.position, v3.scale([0, 0, 0], dir, dist * 0.6));
  node.position[1] = Math.max(node.position[1], type === "plane" ? 0 : 0.5);
  scene.addNode(node);
  scene.invalidateBounds();
  selectNode(node);
  frameSelected();
  toast(`已添加 ${node.name}`);
}

// 时间轴拖动：直接把某一时刻的姿势写到骨骼上
function applyTimeline(node, clip, time) {
  const pose = AnimationPlayer.poseAt(clip, time, node.skeleton);
  for (let i = 0; i < node.skeleton.bones.length; i++) {
    const b = node.skeleton.bones[i];
    const p = pose[i];
    b.position = p.position;
    b.rotation = p.rotation;
    b.scale = p.scale;
  }
  node.skeleton.dirty = true;
}

/* ---------------- 角色（带骨骼的人形白模） ---------------- */

const characterClips = [];

function addCharacter() {
  pushUndo("添加角色");
  const node = new SceneNode("角色");
  const sk = createHumanSkeleton();
  const geo = createHumanMesh(sk);
  node.geometry = geo;
  node.mesh = renderer.ctx.uploadMesh(geo);
  node.skeleton = sk;
  node.rig = "human";
  node.primitive = null;
  node.geometryKey = null;

  // 白模材质：偏冷的高粗糙度表面，动画时明暗变化清楚
  const mat = defaultMaterial();
  mat.baseColor = [0.86, 0.87, 0.9, 1];
  mat.roughness = 0.62;
  mat.metalness = 0.04;
  node.material = mat;

  // 内置动作；默认播放待机
  const clips = createBuiltinClips(sk);
  node.clips = clips;
  node.animator = new AnimationPlayer();
  node.animator.play(clips[0], { loop: true });
  node.clipJSON = clips[0].toJSON();
  node.clipName = clips[0].name;

  const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], scene.camera.target, scene.camera.position));
  const dist = Math.min(v3.dist(scene.camera.position, scene.camera.target), 6);
  node.position = v3.add([0, 0, 0], scene.camera.position, v3.scale([0, 0, 0], dir, dist * 0.55));
  node.position[1] = 0;

  scene.addNode(node);
  scene.invalidateBounds();
  scene.invalidateSkeletons();
  playing = true;
  selectNode(node);
  toast(`已添加角色（${sk.count} 根骨骼 · ${(geo.indexCount / 3) | 0} 面）`);
}

// 切换角色的动作
function playClip(node, clip) {
  if (!node || !node.animator) return;
  node.animator.play(clip, { loop: true, fade: 0.18 });
  node.clipJSON = clip.toJSON();
  node.clipName = clip.name;
  playing = true;
  markDirty();
}

function labelFor(type) {
  return { box: "立方体", sphere: "球体", cylinder: "圆柱", cone: "圆锥", torus: "圆环", plane: "平面" }[type] || type;
}

/* ---------------- 层级树 ---------------- */

function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  const build = (node, container) => {
    if (node === scene.root && node.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "场景为空，用「＋ 添加」创建物体";
      container.appendChild(empty);
      return;
    }
    for (const child of node.children) {
      const row = document.createElement("div");
      row.className = "node-row" + (child === scene.selected ? " selected" : "");
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = child.children.length ? "▾" : "";
      const eye = document.createElement("span");
      eye.className = "eye" + (child.visible ? "" : " off");
      eye.textContent = child.visible ? "◉" : "○";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        child.visible = !child.visible;
        renderTree();
        markDirty();
      });
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = child.name;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = child.primitive || (child.material ? "模型" : "");
      row.append(caret, eye, name, kind);
      row.addEventListener("click", () => selectNode(child));
      container.appendChild(row);
      if (child.children.length) {
        const kids = document.createElement("div");
        kids.className = "node-children";
        container.appendChild(kids);
        build(child, kids);
      }
    }
  };
  const wrapper = document.createElement("div");
  build(scene.root, wrapper);
  tree.appendChild(wrapper);

  const rootRow = document.createElement("div");
  rootRow.className = "node-row";
  rootRow.innerHTML = `<span class="caret">▾</span><span class="name" style="color:var(--text-dim)">场景根节点</span>`;
  rootRow.addEventListener("click", () => selectNode(null));
  tree.prepend(rootRow);
}

/* ---------------- 属性面板 ---------------- */

function field(label, content) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  wrap.appendChild(l);
  wrap.appendChild(content);
  return wrap;
}

function numInput(value, onChange, step = 0.01) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = fmt(value);
  input.addEventListener("change", () => onChange(parseFloat(input.value) || 0));
  return input;
}

function vec3Input(values, onChange, step = 0.01) {
  const box = document.createElement("div");
  box.className = "vec";
  const inputs = values.map((v, i) => {
    const input = numInput(v, (nv) => {
      const next = values.slice();
      next[i] = nv;
      onChange(next);
    }, step);
    box.appendChild(input);
    return input;
  });
  box.update = (vals) => inputs.forEach((inp, i) => { inp.value = fmt(vals[i]); });
  return box;
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000);
}

function renderInspectorTransform() {
  const n = scene.selected;
  if (!n || !inspectorRefs.pos) return;
  inspectorRefs.pos.update(n.position);
  inspectorRefs.rot.update(n.eulerDeg);
  inspectorRefs.scl.update(n.scale);
}

let inspectorRefs = {};

function renderInspector() {
  const body = $("#inspector-body");
  body.innerHTML = "";
  inspectorRefs = {};
  const n = scene.selected;

  if (!n) {
    const g = document.createElement("div");
    g.className = "group";
    g.innerHTML = `<h4>场景</h4><div class="hint">未选中物体。点击视口中的物体或层级树中的条目。</div>`;
    body.appendChild(g);
    renderEnvironment(body);
    return;
  }

  // 基础信息
  const g0 = document.createElement("div");
  g0.className = "group";
  g0.innerHTML = `<h4>对象</h4>`;
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = n.name;
  nameInput.addEventListener("change", () => {
    pushUndo("重命名");
    n.name = nameInput.value || "节点";
    renderTree();
  });
  g0.appendChild(field("名称", nameInput));
  const visWrap = document.createElement("label");
  visWrap.className = "field";
  const vis = document.createElement("input");
  vis.type = "checkbox";
  vis.checked = n.visible;
  vis.addEventListener("change", () => {
    n.visible = vis.checked;
    renderTree();
    markDirty();
  });
  visWrap.append(vis, document.createTextNode(" 可见"));
  g0.appendChild(visWrap);
  body.appendChild(g0);

  // 变换
  const g1 = document.createElement("div");
  g1.className = "group";
  g1.innerHTML = `<h4>变换</h4>`;
  const pos = vec3Input(n.position, (v) => {
    pushUndoThrottled("移动");
    n.position = v;
    n.markDirty();
    scene.invalidateBounds();
    markDirty();
  });
  const rot = vec3Input(n.eulerDeg, (v) => {
    pushUndoThrottled("旋转");
    n.setEulerDeg(v);
    markDirty();
  }, 1);
  const scl = vec3Input(n.scale, (v) => {
    pushUndoThrottled("缩放");
    n.scale = v.map((x) => (Math.abs(x) < 1e-4 ? 1e-4 : x));
    n.markDirty();
    scene.invalidateBounds();
    markDirty();
  });
  inspectorRefs = { pos, rot, scl };
  g1.appendChild(field("位置", pos));
  g1.appendChild(field("旋转°", rot));
  g1.appendChild(field("缩放", scl));
  body.appendChild(g1);

  if (n.skeleton) renderRig(body, n);
  if (n.material) renderMaterial(body, n);

  // 操作
  const g3 = document.createElement("div");
  g3.className = "group";
  g3.innerHTML = `<h4>操作</h4>`;
  const btns = document.createElement("div");
  btns.className = "row-btns";
  const mkBtn = (text, fn, cls = "") => {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    return b;
  };
  btns.appendChild(mkBtn("聚焦", frameSelected));
  btns.appendChild(mkBtn("复制", () => duplicateNode(n)));
  btns.appendChild(mkBtn("删除", () => deleteSelected(), "danger"));
  g3.appendChild(btns);

  // 动画（播放模式自转）
  const spinWrap = document.createElement("label");
  spinWrap.className = "field";
  const spin = document.createElement("input");
  spin.type = "checkbox";
  spin.checked = !!(n.userData && n.userData.spin);
  spin.addEventListener("change", () => {
    n.userData = n.userData || {};
    n.userData.spin = spin.checked ? [0, 0.8, 0] : null;
    if (!spin.checked) delete n.userData.spin;
  });
  spinWrap.append(spin, document.createTextNode(" 运行时自转"));
  g3.appendChild(spinWrap);
  body.appendChild(g3);

  renderEnvironment(body);
}

let lastUndoTime = 0;
function pushUndoThrottled(label) {
  const now = performance.now();
  if (now - lastUndoTime > 700) {
    pushUndo(label);
    lastUndoTime = now;
  }
}

function duplicateNode(n) {
  pushUndo("复制物体");
  const clone = new SceneNode(n.name + " 副本");
  clone.primitive = n.primitive;
  clone.geometry = n.geometry;
  clone.mesh = n.mesh.retain();
  clone.material = { ...n.material, baseColor: [...n.material.baseColor], emissive: [...n.material.emissive] };
  clone.position = v3.add([0, 0, 0], n.position, [0.6, 0, 0]);
  clone.rotation = [...n.rotation];
  clone.scale = [...n.scale];
  clone.castShadow = n.castShadow;
  (n.parent || scene.root).add(clone);
  scene.updateTransforms();
  scene.invalidateBounds();
  selectNode(clone);
  toast("已复制");
}

/* ---------------- 角色属性：动作与时间轴 ---------------- */

function renderRig(body, node) {
  const g = document.createElement("div");
  g.className = "group";
  g.innerHTML = `<h4>角色 · ${node.skeleton.count} 根骨骼</h4>`;

  // 动作列表
  const clips = node.clips || [];
  if (clips.length) {
    const row = document.createElement("div");
    row.className = "row-btns";
    for (const c of clips) {
      const b = document.createElement("button");
      b.textContent = c.name;
      if (node.clipName === c.name) b.classList.add("active");
      b.addEventListener("click", () => {
        pushUndo("切换动作");
        playClip(node, c);
        state.timelineClip = c;
        state.timelineTime = 0;
        renderInspector();
      });
      row.appendChild(b);
    }
    g.appendChild(row);

    // 时间轴
    const current = clips.find((c) => c.name === node.clipName) || clips[0];
    state.timelineClip = current;
    const timeline = document.createElement("input");
    timeline.type = "range";
    timeline.min = "0";
    timeline.max = String(current.duration);
    timeline.step = "0.01";
    timeline.value = String(state.timelineTime);
    timeline.addEventListener("pointerdown", () => {
      state.timelineScrub = true;
      node.animator.playing = false;
    });
    timeline.addEventListener("input", () => {
      state.timelineTime = parseFloat(timeline.value);
      node.animator.time = state.timelineTime;
      applyTimeline(node, current, state.timelineTime);
      markDirty();
    });
    timeline.addEventListener("pointerup", () => {
      state.timelineScrub = false;
      node.animator.playing = true;
      markDirty();
    });
    timeline.addEventListener("change", () => {
      state.timelineScrub = false;
      node.animator.playing = true;
    });
    g.appendChild(field("时间轴", timeline));

    const info = document.createElement("div");
    info.className = "hint";
    info.textContent = `${current.name} · ${current.duration.toFixed(2)} 秒 · ${current.tracks.length} 条骨骼轨道`;
    g.appendChild(info);
  }

  // 动画开关
  const toggle = document.createElement("label");
  toggle.className = "field";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.animating;
  cb.addEventListener("change", () => {
    state.animating = cb.checked;
    markDirty();
  });
  toggle.append(cb, document.createTextNode(" 播放骨骼动画"));
  g.appendChild(toggle);

  // 显示骨架
  const skel = document.createElement("label");
  skel.className = "field";
  const cb2 = document.createElement("input");
  cb2.type = "checkbox";
  cb2.checked = !!state.showSkeleton;
  cb2.addEventListener("change", () => {
    state.showSkeleton = cb2.checked;
    markDirty();
  });
  skel.append(cb2, document.createTextNode(" 显示骨架"));
  g.appendChild(skel);

  body.appendChild(g);
}

function renderMaterial(body, node) {
  const m = node.material;
  const g = document.createElement("div");
  g.className = "group";
  g.innerHTML = `<h4>材质</h4>`;

  const color = document.createElement("input");
  color.type = "color";
  color.value = toHex(m.baseColor);
  color.addEventListener("input", () => {
    const c = fromHex(color.value);
    m.baseColor = [c[0], c[1], c[2], m.baseColor[3]];
    markDirty();
  });
  color.addEventListener("change", () => pushUndo("改颜色"));
  g.appendChild(field("颜色", color));

  const metal = slider(0, 1, 0.01, m.metalness, (v) => {
    m.metalness = v;
    markDirty();
  }, () => pushUndo("改金属度"));
  g.appendChild(field("金属度", metal));

  const rough = slider(0.02, 1, 0.01, m.roughness, (v) => {
    m.roughness = v;
    markDirty();
  }, () => pushUndo("改粗糙度"));
  g.appendChild(field("粗糙度", rough));

  const emColor = document.createElement("input");
  emColor.type = "color";
  emColor.value = toHex(m.emissive);
  emColor.addEventListener("input", () => {
    m.emissive = fromHex(emColor.value).slice(0, 3);
    markDirty();
  });
  emColor.addEventListener("change", () => pushUndo("改自发光"));
  g.appendChild(field("自发光", emColor));

  const emInt = slider(0, 6, 0.1, m.emissiveIntensity, (v) => {
    m.emissiveIntensity = v;
    markDirty();
  }, () => pushUndo("改发光强度"));
  g.appendChild(field("发光强度", emInt));

  const opacity = slider(0, 1, 0.01, m.opacity, (v) => {
    m.opacity = v;
    markDirty();
  }, () => pushUndo("改不透明度"));
  g.appendChild(field("不透明度", opacity));

  const texRow = document.createElement("div");
  texRow.className = "row-btns";
  const addTex = (label, key, tex) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      pushUndo("切换贴图");
      m[key] = m[key] ? null : tex;
      renderInspector();
      markDirty();
    });
    b.classList.toggle("active", !!m[key]);
    return b;
  };
  texRow.appendChild(addTex("石材贴图", "baseMap", textures.stoneBase));
  texRow.appendChild(addTex("法线", "normalMap", textures.stoneNormal));
  texRow.appendChild(addTex("金属粗糙", "mrMap", textures.mrMap));
  g.appendChild(texRow);

  const shadowWrap = document.createElement("label");
  shadowWrap.className = "field";
  const cast = document.createElement("input");
  cast.type = "checkbox";
  cast.checked = node.castShadow;
  cast.addEventListener("change", () => {
    node.castShadow = cast.checked;
    markDirty();
  });
  shadowWrap.append(cast, document.createTextNode(" 投射阴影"));
  g.appendChild(shadowWrap);

  body.appendChild(g);
}

function slider(min, max, step, value, onInput, onChange) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onInput(parseFloat(input.value)));
  input.addEventListener("change", () => onChange && onChange());
  return input;
}

function toHex(c) {
  const h = (v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function fromHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ---------------- 环境设置面板 ---------------- */

function renderEnvironment(body) {
  const g = document.createElement("div");
  g.className = "group";
  g.innerHTML = `<h4>光照与环境</h4>`;
  const L = scene.light;

  const dir = vec3Input(L.direction, (v) => {
    L.direction = v3.normalize([0, 0, 0], v);
    markDirty();
  }, 0.05);
  g.appendChild(field("光方向", dir));

  const intensity = slider(0, 10, 0.1, L.intensity, (v) => {
    L.intensity = v;
    markDirty();
  }, () => pushUndo("改光照强度"));
  g.appendChild(field("光照强度", intensity));

  const sky = colorField("天空色", scene.environment.skyColor, (c) => {
    scene.environment.skyColor = c;
    markDirty();
  });
  g.appendChild(sky);

  const ground = colorField("地面色", scene.environment.groundColor, (c) => {
    scene.environment.groundColor = c;
    markDirty();
  });
  g.appendChild(ground);

  const exposure = slider(0.1, 3, 0.05, scene.environment.exposure, (v) => {
    scene.environment.exposure = v;
    markDirty();
  }, () => pushUndo("改曝光"));
  g.appendChild(field("曝光", exposure));

  const bloom = slider(0, 2, 0.02, scene.bloom.strength, (v) => {
    scene.bloom.strength = v;
    markDirty();
  }, () => pushUndo("改泛光"));
  g.appendChild(field("泛光", bloom));
  body.appendChild(g);
}

function colorField(label, rgb, onChange) {
  const input = document.createElement("input");
  input.type = "color";
  input.value = toHex(rgb);
  input.addEventListener("input", () => onChange(fromHex(input.value)));
  return field(label, input);
}

/* ---------------- 显示与画质面板 ---------------- */

function renderViewPanel() {
  const body = $("#view-body");
  body.innerHTML = "";
  const mkToggle = (label, get, set) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = get();
    input.addEventListener("change", () => {
      set(input.checked);
      markDirty();
    });
    wrap.append(input, document.createTextNode(" " + label));
    return wrap;
  };
  const g1 = document.createElement("div");
  g1.className = "group";
  g1.innerHTML = `<h4>显示</h4>`;
  g1.appendChild(mkToggle("网格地面", () => scene.showGrid, (v) => { scene.showGrid = v; }));
  g1.appendChild(mkToggle("天空", () => scene.showSky, (v) => { scene.showSky = v; }));
  g1.appendChild(mkToggle("阴影", () => renderer.shadow.enabled, (v) => { renderer.shadow.enabled = v; }));
  g1.appendChild(mkToggle("泛光", () => scene.bloom.enabled, (v) => { scene.bloom.enabled = v; }));
  body.appendChild(g1);

  const g2 = document.createElement("div");
  g2.className = "group";
  g2.innerHTML = `<h4>画质</h4>`;
  const aa = document.createElement("select");
  for (const [v, t] of [["fxaa", "FXAA"], ["none", "关闭"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (scene.antialias === v) o.selected = true;
    aa.appendChild(o);
  }
  aa.addEventListener("change", () => {
    scene.antialias = aa.value;
    markDirty();
  });
  g2.appendChild(field("抗锯齿", aa));

  const shadowSize = document.createElement("select");
  for (const s of [512, 1024, 2048]) {
    const o = document.createElement("option");
    o.value = String(s);
    o.textContent = `${s} × ${s}`;
    if (renderer.shadow.size === s) o.selected = true;
    shadowSize.appendChild(o);
  }
  shadowSize.addEventListener("change", () => {
    renderer.setShadowSize(parseInt(shadowSize.value, 10));
    markDirty();
  });
  g2.appendChild(field("阴影贴图", shadowSize));

  const res = document.createElement("select");
  for (const s of [0.6, 0.75, 1]) {
    const o = document.createElement("option");
    o.value = String(s);
    o.textContent = `${Math.round(s * 100)}%`;
    if (Math.abs(renderer.renderScale - s) < 0.01) o.selected = true;
    res.appendChild(o);
  }
  res.addEventListener("change", () => {
    renderer.renderScale = parseFloat(res.value);
    renderer.width = 0; // 强制重建
    resize();
  });
  g2.appendChild(field("渲染分辨率", res));
  body.appendChild(g2);

  const g3 = document.createElement("div");
  g3.className = "group";
  g3.innerHTML = `<h4>统计</h4><div class="hint" id="view-stats"></div>`;
  body.appendChild(g3);
  const upd = () => {
    const el = $("#view-stats");
    if (!el) return;
    el.textContent = `${renderer.width}×${renderer.height} 渲染 · ${renderer.stats.drawCalls} 批次 · 阴影 ${renderer.shadow.size}`;
    requestAnimationFrame(upd);
  };
  upd();
}

/* ---------------- 存取 ---------------- */

function saveScene() {
  const data = scene.toJSON();
  const json = JSON.stringify(data, null, 2);
  // 优先走本地服务保存到工程目录（容器内启动 serve.py 时可用）
  fetch("api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("服务未启用"))))
    .then((res) => toast(`已保存到 ${res.path}`))
    .catch(() => downloadJSON(json));
}

function downloadJSON(json) {
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "scene.z3d.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("已下载 scene.z3d.json");
}

function loadSceneFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      pushUndo("打开场景");
      scene.loadJSON(data, (geo) => renderer.ctx.uploadMesh(geo), resolveTexture, resolveGeometry, buildRigGeometry);
      renderTree();
      renderInspector();
      markDirty();
      toast(`已打开 ${file.name}`);
    } catch (err) {
      toast("场景文件解析失败：" + err.message, true);
    }
  };
  reader.readAsText(file);
}

/* ---------------- 模型导入 ---------------- */

async function importFile(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".glb") || name.endsWith(".gltf")) {
      await importGLTF(file);
    } else if (name.endsWith(".obj")) {
      const text = await file.text();
      const geo = parseOBJ(text);
      addImportedMesh(geo, file.name.replace(/\.[^.]+$/, ""), defaultMaterial());
    } else {
      toast("仅支持 .glb / .gltf / .obj", true);
    }
  } catch (err) {
    toast("导入失败：" + err.message, true);
  }
}

function addImportedMesh(geo, name, material) {
  pushUndo("导入模型");
  const node = new SceneNode(name);
  node.geometryKey = `geo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  saveGeometry(node.geometryKey, geo);
  node.geometry = geo;
  node.mesh = renderer.ctx.uploadMesh(geo);
  node.material = material;
  const bounds = computeBounds(geo);
  // 模型过大/过小时自动缩放到约 2 单位高
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const s = size > 0 ? 2 / size : 1;
  node.scale = [s, s, s];
  node.position = [0, (-bounds.min[1]) * s, 0];
  scene.addNode(node);
  scene.invalidateBounds();
  selectNode(node);
  frameSelected();
  toast(`已导入 ${name}（${geo.vertexCount} 顶点）`);
}

async function importGLTF(file) {
  const buf = await file.arrayBuffer();
  let json;
  let bin = null;
  if (file.name.toLowerCase().endsWith(".glb")) {
    const parsed = parseGLB(buf);
    json = parsed.json;
    bin = parsed.bin;
  } else {
    json = JSON.parse(new TextDecoder().decode(buf));
    if (json.buffers && json.buffers[0] && json.buffers[0].uri) {
      const uri = json.buffers[0].uri;
      if (uri.startsWith("data:")) {
        const b64 = uri.split(",")[1];
        const raw = atob(b64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        bin = arr.buffer;
      } else {
        throw new Error("外部 .bin 引用暂不支持，请导出为 .glb");
      }
    }
  }
  pushUndo("导入 glTF");
  const nodes = gltfToSceneGraph(json);
  const rootNode = new SceneNode(file.name.replace(/\.[^.]+$/, ""));
  const uploadGeo = (geo) => renderer.ctx.uploadMesh(geo);
  let total = 0;

  const buildNode = (desc) => {
    const n = new SceneNode(desc.name);
    n.position = desc.translation;
    n.rotation = desc.rotation;
    n.scale = desc.scale;
    if (desc.mesh !== null && json.meshes && json.meshes[desc.mesh]) {
      const mesh = json.meshes[desc.mesh];
      for (const prim of mesh.primitives || []) {
        const geo = gltfPrimitiveToGeometry(json, bin, prim);
        if (!geo) continue;
        const mat = gltfMaterial(json, prim.material ?? 0);
        const matObj = defaultMaterial();
        Object.assign(matObj, {
          baseColor: mat.baseColor,
          metalness: mat.metalness,
          roughness: mat.roughness,
          emissive: mat.emissive,
          opacity: mat.opacity,
        });
        const child = new SceneNode(`${desc.name}${mesh.primitives.length > 1 ? "·" + (prim.material ?? 0) : ""}`);
        child.geometryKey = `geo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        saveGeometry(child.geometryKey, geo);
        child.geometry = geo;
        child.mesh = uploadGeo(geo);
        child.material = matObj;
        total += geo.vertexCount;
        n.add(child);
      }
    }
    for (const c of desc.children || []) {
      n.add(buildNode(c));
    }
    return n;
  };
  for (const desc of nodes) rootNode.add(buildNode(desc));

  scene.addNode(rootNode);
  scene.invalidateBounds();
  selectNode(rootNode.children[0] || rootNode);
  frameSelected();
  toast(`已导入 ${file.name}（${total} 顶点）`);
}

/* ---------------- 启动 ---------------- */

/* 调试用：把当前画面导出为 PNG，便于在无界面的环境里核对渲染结果 */
window.zorr3dSnapshot = async () => {
  try {
    renderer.renderScale = 1;
    renderer.width = 0;
    resize();
    scene.updateTransforms();
    const aspect = renderer.width / renderer.height;
    m4.perspective(vpMatrix, deg2rad(scene.camera.fov), aspect, scene.camera.near, scene.camera.far);
    m4.multiply(vpMatrix, vpMatrix, scene.camera.viewMatrix());
    renderer.render(scene, scene.camera);
    return canvas.toDataURL("image/png");
  } catch (err) {
    return "ERROR: " + err.message;
  }
};

// 角色几何是程序化生成的：存档里只记录骨架，加载时按骨架重建网格
function buildRigGeometry(skeleton) {
  return createHumanMesh(skeleton);
}

function resolveTexture(name) {
  return textures[name] || null;
}

/* 导入模型的几何数据存在 localStorage，重开存档时可复原（单条上限约 40 万个浮点数） */
const GEO_PREFIX = "zorr3d:geo:";
const GEO_LIMIT_CHARS = 6 * 1024 * 1024;

function saveGeometry(key, geo) {
  try {
    const packed = {
      p: Float32Array.from(geo.positions),
      n: Float32Array.from(geo.normals),
      u: Float32Array.from(geo.uvs),
      t: Float32Array.from(geo.tangents),
      i: geo.vertexCount > 65535 ? Uint32Array.from(geo.indices) : Uint16Array.from(geo.indices),
    };
    const json = JSON.stringify(packed);
    if (json.length > GEO_LIMIT_CHARS) {
      toast("模型过大，仅保存在当前会话中", true);
      return;
    }
    localStorage.setItem(GEO_PREFIX + key, json);
  } catch (err) {
    toast("几何存储失败：" + err.message, true);
  }
}

function resolveGeometry(key) {
  try {
    const raw = localStorage.getItem(GEO_PREFIX + key);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return {
      positions: Array.from(d.p),
      normals: Array.from(d.n),
      uvs: Array.from(d.u),
      tangents: Array.from(d.t),
      indices: Array.from(d.i),
      vertexCount: d.p.length / 3,
      indexCount: d.i.length,
    };
  } catch (err) {
    return null;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

window.addEventListener("DOMContentLoaded", init);
