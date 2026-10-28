// 3D 跑酷运行端：用 Zorr3D 引擎渲染赛道、金币与终点门。
// 金币未集齐时门关闭并挡住去路；集齐后门向两侧滑开即可通关。

import { m4, v3, deg2rad } from "../../engine/math.js";
import { PRIMITIVES } from "../../engine/geometry.js";
import { createHumanSkeleton, createHumanMesh, createBuiltinClips } from "../../engine/rig.js";
import { AnimationPlayer } from "../../engine/animation.js";
import { Renderer, defaultMaterial } from "../../engine/renderer.js";
import { Scene, SceneNode } from "../../engine/scene.js";
import {
  generateTrack, createPlayer, updatePlayer, jump, collectCoins,
  remainingCoins, gateOpen, reachedFinish, collideGate, LEVEL,
} from "./level.js";

const $ = (s) => document.querySelector(s);

const GAME = {
  state: "ready", // ready | playing | won | lost
  coins: 0,
  totalCoins: 0,
  gateOpenAmount: 0,
  bestDistance: 0,
  shake: 0,
};

let renderer, scene, camera;
let canvas;
let track, player;
let playerNode, gateLeft, gateRight, coinNodes = [];
let playerClips = null;
let playerClipName = "奔跑";
let vpMatrix = m4.create();
let lastTime = 0;
let fpsFrames = 0;
let fpsAccum = 0;
let audioCtx = null;

const input = { targetX: 0, jumpQueued: false };

/* ---------------- 初始化 ---------------- */

function init() {
  canvas = $("#game");
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    showFatal(err);
    return;
  }
  scene = new Scene(renderer);
  camera = scene.camera;

  // 画面取向：固定视角，稍微俯视
  scene.environment.skyColor = [0.12, 0.24, 0.5];
  scene.environment.horizonColor = [0.62, 0.72, 0.86];
  scene.environment.groundColor = [0.08, 0.09, 0.12];
  scene.environment.exposure = 1.05;
  scene.environment.vignette = 0.35;
  // 远处雾化到地平线色，让长赛道有纵深
  scene.environment.fog = { color: [0.34, 0.42, 0.55], near: 45, far: 165 };
  scene.light.direction = [-0.35, -0.9, -0.25];
  scene.light.intensity = 3.0;
  scene.showGrid = false;
  scene.bloom.enabled = true;
  scene.bloom.strength = 0.45;
  scene.antialias = "fxaa";

  buildLevel(1);
  bindControls();
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 150));
  requestAnimationFrame(loop);
  showOverlay("ready");
  updateHud();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 移动端适当降低渲染分辨率，稳定 60 帧
  const scale = window.innerWidth < 700 ? 0.8 : 1;
  renderer.renderScale = scale;
  renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr, scale);
}

/* ---------------- 场景构建 ---------------- */

function buildLevel(seed) {
  track = generateTrack({ seed, segments: 16, lanes: 3 });
  GAME.totalCoins = track.coins.length;
  GAME.coins = 0;
  GAME.gateOpenAmount = 0;
  GAME.gateWarned = false;
  GAME.gateAnnounced = false;
  player = createPlayer(track.spawn);
  input.targetX = 0;

  // 清空旧节点
  scene.root.children.slice().forEach((n) => scene.removeNode(n));
  coinNodes = [];

  const up = (geo) => renderer.ctx.uploadMesh(geo);

  // 平台
  const platGeo = PRIMITIVES.box(1, 1, 1);
  const trackMat = defaultMaterial();
  trackMat.baseColor = [0.22, 0.24, 0.3, 1];
  trackMat.roughness = 0.75;
  trackMat.metalness = 0.05;
  for (const p of track.platforms) {
    const n = new SceneNode("跑道");
    n.geometry = platGeo;
    n.mesh = up(platGeo);
    n.material = trackMat;
    n.position = [p.x, -0.35, p.z];
    n.scale = [p.w, 0.7, p.d];
    n.castShadow = false;
    scene.addNode(n);
    // 跑道边缘亮条，帮助判断边界
    const edge = new SceneNode("边线");
    edge.geometry = platGeo;
    edge.mesh = up(platGeo);
    const em = defaultMaterial();
    em.baseColor = [0.1, 0.5, 0.9, 1];
    em.emissive = [0.1, 0.4, 0.9];
    em.emissiveIntensity = 0.9;
    edge.material = em;
    edge.position = [p.x, 0.02, p.z];
    edge.scale = [p.w + 0.04, 0.06, 0.12];
    edge.castShadow = false;
    scene.addNode(edge);
  }

  // 远景地面：铺在赛道下方，避免赛道像悬在空中
  const floorGeo = PRIMITIVES.plane(900, 1600);
  const floorMat = defaultMaterial();
  floorMat.baseColor = [0.045, 0.055, 0.085, 1];
  floorMat.roughness = 0.95;
  floorMat.metalness = 0;
  const floor = new SceneNode("远景地面");
  floor.geometry = floorGeo;
  floor.mesh = up(floorGeo);
  floor.material = floorMat;
  floor.position = [0, -14, track.finish.z * 0.5 + track.spawn.z * 0.5];
  floor.castShadow = false;
  scene.addNode(floor);

  // 金币
  const coinGeo = PRIMITIVES.torus(0.34, 0.11, 24, 12);
  const coinMat = defaultMaterial();
  coinMat.baseColor = [1.0, 0.78, 0.2, 1];
  coinMat.metalness = 1;
  coinMat.roughness = 0.22;
  coinMat.emissive = [1.0, 0.62, 0.05];
  coinMat.emissiveIntensity = 0.55;
  for (const c of track.coins) {
    c.value = 1;
    const n = new SceneNode("金币");
    n.geometry = coinGeo;
    n.mesh = up(coinGeo);
    n.material = coinMat;
    n.position = [c.x, c.y, c.z];
    n.setEulerDeg([0, 0, 90]);
    n.scale = [1, 1, 1];
    n.castShadow = false;
    n.userData = { coin: c };
    scene.addNode(n);
    coinNodes.push(n);
  }

  // 终点门
  const gateMat = defaultMaterial();
  gateMat.baseColor = [0.55, 0.3, 0.75, 1];
  gateMat.metalness = 0.6;
  gateMat.roughness = 0.35;
  gateMat.emissive = [0.35, 0.1, 0.6];
  gateMat.emissiveIntensity = 0.7;
  const gateGeo = PRIMITIVES.box(1, 1, 1);
  const halfW = track.gate.width / 2;
  const mkDoor = (side) => {
    const n = new SceneNode("门");
    n.geometry = gateGeo;
    n.mesh = up(gateGeo);
    n.material = { ...gateMat, baseColor: [...gateMat.baseColor], emissive: [...gateMat.emissive] };
    n.position = [side * halfW / 2, track.gate.height / 2, track.gate.z];
    n.scale = [halfW, track.gate.height, 0.5];
    scene.addNode(n);
    return n;
  };
  gateLeft = mkDoor(-1);
  gateRight = mkDoor(1);

  // 终点光环（门后地面）
  const ringGeo = PRIMITIVES.plane(track.gate.width, 3);
  const ringMat = defaultMaterial();
  ringMat.baseColor = [0.15, 0.85, 0.6, 1];
  ringMat.emissive = [0.1, 0.9, 0.55];
  ringMat.emissiveIntensity = 1.2;
  const ring = new SceneNode("终点线");
  ring.geometry = ringGeo;
  ring.mesh = up(ringGeo);
  ring.material = ringMat;
  ring.position = [0, 0.03, track.finish.z - 1.2];
  scene.addNode(ring);

  // 玩家：带骨骼的人形白模，跑步时播放奔跑动作
  playerNode = new SceneNode("玩家");
  const sk = createHumanSkeleton();
  const bodyGeo = createHumanMesh(sk);
  const bodyMat = defaultMaterial();
  bodyMat.baseColor = [0.95, 0.96, 1.0, 1];
  bodyMat.metalness = 0.1;
  bodyMat.roughness = 0.5;
  playerNode.geometry = bodyGeo;
  playerNode.mesh = up(bodyGeo);
  playerNode.material = bodyMat;
  playerNode.skeleton = sk;
  playerNode.animator = new AnimationPlayer();
  const clips = createBuiltinClips(sk);
  playerClips = { run: clips[2], jump: clips[4] };
  playerNode.animator.play(playerClips.run, { loop: true });
  // 人形原点在脚底，跑酷里把模型抬高到地面之上
  playerNode.position = [0, 0, 0];
  scene.addNode(playerNode);

  scene.updateTransforms();
  updateCamera(0);
}

/* ---------------- 控制 ---------------- */

function bindControls() {
  const laneTarget = (i) => (i - 1) * LEVEL.laneWidth;
  let laneIndex = 1;

  const moveLane = (delta) => {
    laneIndex = Math.max(0, Math.min(2, laneIndex + delta));
    input.targetX = laneTarget(laneIndex);
  };

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowleft", "a"].includes(k)) { moveLane(-1); e.preventDefault(); }
    else if (["arrowright", "d"].includes(k)) { moveLane(1); e.preventDefault(); }
    else if ([" ", "arrowup", "w"].includes(k)) { input.jumpQueued = true; e.preventDefault(); }
    else if (k === "r") restart();
    else if (k === "enter" && GAME.state !== "playing") startGame();
  });

  // 触摸滑动
  let sx = 0, sy = 0, swiping = false;
  canvas.addEventListener("pointerdown", (e) => {
    sx = e.clientX; sy = e.clientY; swiping = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!swiping) return;
    swiping = false;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (GAME.state !== "playing") { startGame(); return; }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 24) moveLane(dx > 0 ? 1 : -1);
    else if (dy < -24) input.jumpQueued = true;
  });
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  // 屏幕按钮（移动端）
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = btn.dataset.action;
      if (a === "left") moveLane(-1);
      else if (a === "right") moveLane(1);
      else if (a === "jump") input.jumpQueued = true;
      else if (a === "start") startGame();
      else if (a === "restart") restart();
    });
  });
  // 提供闭包内 laneIndex 的同步
  GAME.resetLane = () => { laneIndex = 1; input.targetX = 0; };
}

/* ---------------- 声音（WebAudio 合成，无外部资源） ---------------- */

function beep(freq, dur = 0.09, type = "sine", gain = 0.05) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (err) {
    void err;
  }
}

/* ---------------- 主循环 ---------------- */

function loop(now) {
  requestAnimationFrame(loop);
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
  lastTime = now;

  if (GAME.state === "playing") {
    step(dt);
  } else {
    animateIdle(dt);
  }

  render();
}

function step(dt) {
  if (input.jumpQueued) {
    if (jump(player)) beep(520, 0.08, "triangle", 0.04);
    input.jumpQueued = false;
  }

  updatePlayer(player, dt, input, track);

  // 金币拾取
  const got = collectCoins(player, track.coins);
  if (got > 0) {
    GAME.coins += got;
    beep(880 + Math.min(GAME.coins, 12) * 25, 0.07, "sine", 0.045);
    for (const n of coinNodes) {
      if (n.userData.coin.taken && !n.hidden) {
        n.hidden = true;
        n.visible = false;
      }
    }
    updateHud();
  }

  // 门
  const open = gateOpen(track.coins);
  const target = open ? 1 : 0;
  GAME.gateOpenAmount += (target - GAME.gateOpenAmount) * Math.min(1, dt * 3.2);
  const halfW = track.gate.width / 2;
  const slide = GAME.gateOpenAmount * (halfW + 0.4);
  gateLeft.position[0] = -halfW / 2 - slide;
  gateRight.position[0] = halfW / 2 + slide;
  gateLeft.markDirty();
  gateRight.markDirty();

  if (open && !GAME.gateAnnounced) {
    GAME.gateAnnounced = true;
    beep(300, 0.5, "sawtooth", 0.05);
    setTimeout(() => beep(600, 0.5, "sine", 0.05), 120);
    showToast("金币已集齐，终点门已打开！");
    updateHud();
  }

  // 门未开时挡住玩家，并提示还差多少
  if (collideGate(player, track, track.coins)) {
    const left = remainingCoins(track.coins);
    if (!GAME.gateWarned) {
      GAME.gateWarned = true;
      showToast(`门还锁着：还差 ${left} 枚金币`);
      beep(220, 0.2, "square", 0.05);
    }
  } else {
    GAME.gateWarned = false;
  }

  // 玩家姿态与骨骼动画
  playerNode.position = [player.position[0], player.position[1] - 0.9, player.position[2]];
  playerNode.setEulerDeg([0, 0, clamp((input.targetX - player.position[0]) * -9, -14, 14)]);

  if (playerNode.animator && playerNode.skeleton) {
    // 起跳时切到跳跃动作，落地后回到奔跑
    const wantJump = !player.onGround && player.velocity[1] > 0.5;
    const wantName = wantJump ? "跳跃" : "奔跑";
    if (wantName !== playerClipName && playerClips) {
      playerClipName = wantName;
      playerNode.animator.play(playerClips[wantJump ? "jump" : "run"], { loop: !wantJump });
    }
    playerNode.animator.update(dt, playerNode.skeleton);
  }

  // 金币自转与浮动
  const t = performance.now() / 1000;
  for (let i = 0; i < coinNodes.length; i++) {
    const n = coinNodes[i];
    if (n.hidden) continue;
    n.position[1] = n.userData.coin.y + Math.sin(t * 3 + i) * 0.12;
    n.setEulerDeg([0, (t * 160 + i * 22) % 360, 90]);
  }

  updateCamera(dt);
  scene.updateTransforms();
  GAME.bestDistance = Math.max(GAME.bestDistance, player.distance);

  // 结算
  if (!player.alive) {
    GAME.state = "lost";
    beep(180, 0.35, "sawtooth", 0.06);
    showOverlay("lost");
  } else if (reachedFinish(player, track, track.coins)) {
    GAME.state = "won";
    beep(660, 0.14, "sine", 0.06);
    setTimeout(() => beep(880, 0.14, "sine", 0.06), 140);
    setTimeout(() => beep(1180, 0.3, "sine", 0.06), 280);
    showOverlay("won");
  }
  updateProgress();
}

function animateIdle(dt) {
  const t = performance.now() / 1000;
  for (let i = 0; i < coinNodes.length; i++) {
    const n = coinNodes[i];
    if (n.hidden) continue;
    n.position[1] = n.userData.coin.y + Math.sin(t * 2 + i) * 0.1;
    n.setEulerDeg([0, (t * 90 + i * 22) % 360, 90]);
  }
  if (playerNode) {
    playerNode.markDirty();
    if (playerNode.animator && playerNode.skeleton) {
      playerNode.animator.update(dt, playerNode.skeleton);
    }
  }
  updateCamera(dt);
  scene.updateTransforms();
}

// 相机在玩家后上方跟随，并轻微前视
const camOffset = [0, 3.2, 5.6];
function updateCamera(dt) {
  if (!player) return;
  const p = player.position;
  const target = [p[0] * 0.55, p[1] + 0.95, p[2] - 4.2];
  const desired = [p[0] * 0.55 + camOffset[0], camOffset[1], p[2] + camOffset[2]];
  const k = dt > 0 ? Math.min(1, dt * 7) : 1;
  if (dt === 0) {
    camera.position = [...desired];
    camera.target = [...target];
  } else {
    camera.position = v3.lerp([0, 0, 0], camera.position, desired, k);
    camera.target = v3.lerp([0, 0, 0], camera.target, target, k);
  }
  camera.fov = 58;
  camera.near = 0.1;
  camera.far = 260;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function render() {
  const w = renderer.width;
  const h = renderer.height;
  m4.perspective(vpMatrix, deg2rad(camera.fov), w / h, camera.near, camera.far);
  m4.multiply(vpMatrix, vpMatrix, camera.viewMatrix());
  renderer.render(scene, camera);

  fpsFrames++;
  fpsAccum += 1 / 60;
  if (fpsAccum >= 0.5) {
    $("#fps").textContent = `${Math.round(fpsFrames / fpsAccum)}`;
    fpsFrames = 0;
    fpsAccum = 0;
  }
}

/* ---------------- 界面 ---------------- */

function updateHud() {
  $("#coin-count").textContent = `${GAME.coins} / ${GAME.totalCoins}`;
  const open = gateOpen(track.coins);
  $("#gate-state").textContent = open ? "已开启" : "锁定";
  $("#gate-state").classList.toggle("open", open);
  $("#coin-bar").style.width = `${(GAME.totalCoins ? GAME.coins / GAME.totalCoins : 0) * 100}%`;
}

function updateProgress() {
  const pct = Math.max(0, Math.min(1, player.distance / Math.max(1, track.length)));
  $("#progress-fill").style.width = `${pct * 100}%`;
}

let toastTimer = 0;
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

function showOverlay(kind) {
  const ov = $("#overlay");
  const title = $("#ov-title");
  const sub = $("#ov-sub");
  const btn = $("#ov-btn");
  ov.classList.remove("hidden");
  ov.dataset.kind = kind;
  if (kind === "ready") {
    title.textContent = "金币之路";
    sub.innerHTML = "左右滑动换道 · 上滑跳跃<br>集齐所有金币，终点门才会打开";
    btn.textContent = "开始跑酷";
  } else if (kind === "won") {
    title.textContent = "通关！";
    sub.innerHTML = `用时 ${player.distance.toFixed(0)} 米 · 金币 ${GAME.coins}/${GAME.totalCoins}`;
    btn.textContent = "再跑一次";
  } else if (kind === "lost") {
    title.textContent = "跌出赛道";
    sub.innerHTML = `跑了 ${GAME.bestDistance.toFixed(0)} 米 · 金币 ${GAME.coins}/${GAME.totalCoins}`;
    btn.textContent = "重新开始";
  }
}

function hideOverlay() {
  $("#overlay").classList.add("hidden");
}

function startGame() {
  hideOverlay();
  GAME.state = "playing";
  beep(440, 0.1, "triangle", 0.04);
}

function restart() {
  hideOverlay();
  playerClipName = "奔跑";
  buildLevel(Math.floor(Math.random() * 100000) + 1);
  if (GAME.resetLane) GAME.resetLane();
  GAME.state = "playing";
  updateHud();
}

function showFatal(err) {
  const box = document.getElementById("fatal");
  if (!box) return;
  box.textContent = "启动失败：\n" + String((err && err.message) || err);
  box.style.display = "block";
  const ov = document.getElementById("overlay");
  if (ov) ov.classList.add("hidden");
  if (window.console) console.error(err);
}

// 任何未捕获异常都直接显示出来，便于在手机上定位
window.addEventListener("error", (e) => showFatal(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason));

window.addEventListener("DOMContentLoaded", init);
