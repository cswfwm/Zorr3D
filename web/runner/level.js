// 3D 跑酷的纯逻辑：赛道生成、金币收集、门的开合判定、玩家物理。
// 不依赖 WebGL/DOM，便于单元测试。

import { v3 } from "../../engine/math.js";

export const LEVEL = {
  laneWidth: 2.4,          // 三条跑道的宽度
  trackWidth: 8.4,
  startZ: 6,               // 起点在 +Z，向 -Z 跑
  segmentLength: 12,       // 每段长度
  gapChance: 0.16,         // 出现断层的概率
  coinValue: 1,
};

// 生成赛道：返回 { platforms:[{x,z,w,d}], coins:[{x,y,z}], gate:{z, width}, finish }
export function generateTrack({ seed = 1, segments = 14, lanes = 3 } = {}) {
  const rnd = mulberry32(seed);
  const platforms = [];
  const coins = [];
  const laneX = (i) => (i - (lanes - 1) / 2) * LEVEL.laneWidth;

  // 起点平台
  platforms.push({ x: 0, z: LEVEL.startZ, w: LEVEL.trackWidth, d: 10 });

  let z = LEVEL.startZ - 8;
  const gates = [];
  for (let s = 0; s < segments; s++) {
    // 断层宽度控制在一次跳跃可跨越的范围内（速度 9、跳跃初速 8.2、重力 26 → 水平约 5.6）
    const gap = s > 1 && rnd() < LEVEL.gapChance;
    if (gap) {
      z -= 2.2 + rnd() * 0.6;
    }
    const len = LEVEL.segmentLength * (0.7 + rnd() * 0.6);
    platforms.push({ x: 0, z: z - len / 2, w: LEVEL.trackWidth, d: len });

    // 每段放 1~2 排金币；z 必须留出边距，否则会落在平台边缘之外无法拾取
    const rows = 2;
    const margin = 1.2;
    for (let r = 0; r < rows; r++) {
      const lane = Math.floor(rnd() * lanes);
      const rowZ = z - margin - (r + 0.5) * ((len - margin * 2) / rows);
      for (let k = 0; k < 2; k++) {
        const cz = rowZ - k * 1.6;
        // 双枚金币中第二枚可能超出本段，越界则贴在本段末尾内侧
        const clampedZ = Math.min(rowZ, Math.max(z - len + margin, cz));
        coins.push({ x: laneX(lane), y: 1.0, z: clampedZ });
      }
    }
    z -= len + 2;
  }

  // 终点过渡平台 + 门 + 终点线：门必须在最后一段金币之后
  const finalLen = 6;
  platforms.push({ x: 0, z: z - finalLen / 2, w: LEVEL.trackWidth, d: finalLen });
  const gateZ = z - finalLen + 1.6;
  const finishZ = gateZ - 2.4;
  gates.push({ z: gateZ });
  return {
    platforms,
    coins,
    gate: { z: gateZ, width: LEVEL.trackWidth - 1.2, height: 4.2 },
    finish: { z: finishZ },
    spawn: { x: 0, y: 0.9, z: LEVEL.startZ },
    length: LEVEL.startZ - finishZ,
    gateLocked: true,
  };
}

// 玩家状态与物理推进
export function createPlayer(spawn) {
  return {
    position: [spawn.x, spawn.y, spawn.z],
    velocity: [0, 0, 0],
    lane: 1,
    onGround: true,
    coyote: COYOTE_TIME,  // 离开边缘后仍可起跳的宽限
    jumpBuffer: 0,        // 落地前/刚落地时按下的跳跃，在窗口内生效
    landGrace: 0,         // 刚落地后仍接受跳跃输入的时间
    speed: 9,
    alive: true,
    distance: 0,
  };
}

export const GRAVITY = -26;
export const JUMP_SPEED = 8.2;
export const COYOTE_TIME = 0.12;
export const JUMP_BUFFER_TIME = 0.3;

export function updatePlayer(p, dt, input, track) {
  // 横向：平滑靠近目标跑道
  const targetX = input.targetX;
  const dx = targetX - p.position[0];
  p.position[0] += dx * Math.min(1, dt * 12);

  // 前进：匀速向 -Z
  p.position[2] -= p.speed * dt;

  // 纵向
  p.velocity[1] += GRAVITY * dt;
  p.position[1] += p.velocity[1] * dt;

  // 缓冲计时先衰减，再判定落地，避免同帧内被清零
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);

  const groundY = groundHeightAt(p.position[0], p.position[2], track);
  const floor = groundY === null ? -Infinity : groundY + 0.9;
  if (p.position[1] <= floor) {
    p.position[1] = floor;
    p.velocity[1] = 0;
    const wasAirborne = !p.onGround;
    p.onGround = true;
    p.coyote = COYOTE_TIME;
    if (wasAirborne) p.landGrace = JUMP_BUFFER_TIME;
    if (p.jumpBuffer > 0) {
      // 空中提前按下的跳跃，在落地瞬间生效
      p.velocity[1] = JUMP_SPEED;
      p.onGround = false;
      p.coyote = 0;
      p.jumpBuffer = 0;
      p.landGrace = 0;
    }
  } else {
    p.onGround = false;
    p.coyote = Math.max(0, p.coyote - dt);
    p.landGrace = Math.max(0, p.landGrace - dt);
  }

  // 掉进断层
  if (p.position[1] < -3) p.alive = false;
  p.distance = track.spawn.z - p.position[2];
  return p;
}

export function jump(p) {
  if (!p.alive) return false;
  if (p.onGround || p.coyote > 0 || p.landGrace > 0) {
    p.velocity[1] = JUMP_SPEED;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    p.landGrace = 0;
    return true;
  }
  // 空中按下：记进缓冲，落地立即起跳
  p.jumpBuffer = JUMP_BUFFER_TIME;
  return false;
}

// 脚下平台高度；不在任何平台上返回 null
export function groundHeightAt(x, z, track) {
  for (const p of track.platforms) {
    const halfW = p.w / 2;
    const halfD = p.d / 2;
    if (Math.abs(x - p.x) <= halfW && Math.abs(z - p.z) <= halfD) return 0;
  }
  return null;
}

// 拾取金币：返回本次收集数量（并把已拾取标记上）
export function collectCoins(p, coins, radius = 0.95) {
  let n = 0;
  for (const c of coins) {
    if (c.taken) continue;
    const d = Math.hypot(c.x - p.position[0], (c.y - p.position[1]) * 0.8, c.z - p.position[2]);
    if (d <= radius) {
      c.taken = true;
      n += c.value || 1;
    }
  }
  return n;
}

export function remainingCoins(coins) {
  return coins.reduce((s, c) => s + (c.taken ? 0 : c.value || 1), 0);
}

// 门是否打开：金币全部收集
export function gateOpen(coins) {
  return remainingCoins(coins) === 0;
}

// 到达终点判定（必须门已打开）
export function reachedFinish(p, track, coins) {
  if (!p.alive) return false;
  if (p.position[2] > track.finish.z - 1.5) return false;
  return gateOpen(coins);
}

// 是否被未开的门挡住（把玩家限制在门前）
export function collideGate(p, track, coins) {
  const g = track.gate;
  if (gateOpen(coins)) {
    p.blockedByGate = false;
    return false;
  }
  // 关闭时按"墙"处理：只阻止继续前进，不回推（回推会把玩家挤离金币）
  const front = g.z + 0.7;
  if (p.position[2] < front) {
    p.position[2] = front;
    p.blockedByGate = true;
    return true;
  }
  p.blockedByGate = false;
  return false;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

void v3;
