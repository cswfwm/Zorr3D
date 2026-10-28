import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTrack, createPlayer, updatePlayer, jump, collectCoins,
  remainingCoins, gateOpen, reachedFinish, collideGate, groundHeightAt, LEVEL,
} from '../web/runner/level.js';

test('赛道生成：平台连续、金币在平台上、门在末尾', () => {
  const t = generateTrack({ seed: 7, segments: 12 });
  assert.ok(t.platforms.length >= 12);
  assert.ok(t.coins.length >= 20, `coins=${t.coins.length}`);
  // 金币必须落在某个平台范围内
  for (const c of t.coins) {
    assert.equal(groundHeightAt(c.x, c.z, t), 0, `金币悬空 z=${c.z}`);
  }
  // 门在终点线之前（玩家从 +Z 向 -Z 跑，门 z 应大于终点 z）
  assert.ok(t.gate.z > t.finish.z, `门 ${t.gate.z} 应在终点 ${t.finish.z} 之前`);
  assert.ok(t.length > 50);
});

test('同一 seed 生成结果一致', () => {
  const a = generateTrack({ seed: 42 });
  const b = generateTrack({ seed: 42 });
  assert.deepEqual(a.coins, b.coins);
  assert.deepEqual(a.platforms, b.platforms);
});

test('不同 seed 结果不同', () => {
  const a = generateTrack({ seed: 1 });
  const b = generateTrack({ seed: 2 });
  assert.notDeepEqual(a.coins, b.coins);
});

test('玩家按固定速度前进', () => {
  const t = generateTrack({ seed: 3 });
  const p = createPlayer(t.spawn);
  updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  for (let i = 0; i < 30; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  assert.ok(p.position[2] < t.spawn.z, '应沿 -Z 前进');
  assert.ok(p.distance > 4, `distance=${p.distance}`);
});

test('跳跃只能在地面触发', () => {
  const t = generateTrack({ seed: 4 });
  const p = createPlayer(t.spawn);
  assert.equal(jump(p), true);
  assert.equal(jump(p), false, '空中不能再跳');
  // 重力把玩家拉回地面
  for (let i = 0; i < 120; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  assert.ok(p.onGround);
  assert.ok(Math.abs(p.position[1] - 0.9) < 0.05, `y=${p.position[1]}`);
});

test('金币收集与计数', () => {
  const t = generateTrack({ seed: 5 });
  const p = createPlayer(t.spawn);
  const c = t.coins[0];
  p.position = [c.x, c.y, c.z];
  assert.equal(collectCoins(p, t.coins), 1);
  assert.equal(collectCoins(p, t.coins), 0, '同一枚不能拾取两次');
  assert.equal(remainingCoins(t.coins), t.coins.length - 1);
});

test('金币未拾取完时门关闭且挡住玩家', () => {
  const t = generateTrack({ seed: 6 });
  const p = createPlayer(t.spawn);
  assert.equal(gateOpen(t.coins), false);
  p.position = [0, 0.9, t.gate.z - 3];
  const blocked = collideGate(p, t, t.coins);
  assert.equal(blocked, true);
  assert.ok(p.position[2] >= t.gate.z - 1e-6, '被挡在门前');
  assert.equal(reachedFinish(p, t, t.coins), false);
});

test('金币拾取完后门打开并可到达终点', () => {
  const t = generateTrack({ seed: 6 });
  for (const c of t.coins) c.taken = true;
  assert.equal(gateOpen(t.coins), true);
  const p = createPlayer(t.spawn);
  p.position = [0, 0.9, t.gate.z - 3];
  assert.equal(collideGate(p, t, t.coins), false);
  p.position[2] = t.finish.z - 2;
  assert.equal(reachedFinish(p, t, t.coins), true);
});

test('掉出赛道：落到一定高度以下判定死亡', () => {
  const t = generateTrack({ seed: 8 });
  const p = createPlayer(t.spawn);
  p.position = [999, 0.9, t.spawn.z];
  // 悬空处没有地面，会持续下落
  for (let i = 0; i < 60 && p.alive; i++) updatePlayer(p, 1 / 60, { targetX: 999 }, t);
  assert.equal(p.alive, false);
});

test('土狼时间：刚离开平台边缘仍可起跳', () => {
  const t = generateTrack({ seed: 8 });
  const p = createPlayer(t.spawn);
  p.position = [999, 0.9, t.spawn.z]; // 悬空
  updatePlayer(p, 1 / 60, { targetX: 999 }, t);
  assert.equal(p.onGround, false);
  assert.equal(jump(p), true, '宽限期内应能跳');
});

test('落地宽限：刚落地的一小段时间内按跳也能起跳', () => {
  const t = generateTrack({ seed: 8 });
  const p = createPlayer(t.spawn);
  p.position[1] = 3.0;
  for (let i = 0; i < 60; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  assert.equal(jump(p), true, '地面上可跳');
  // 空中已超过土狼时间，且缓冲已过期 -> 不能起跳
  for (let i = 0; i < 22; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  if (!p.onGround) assert.equal(jump(p), false, '空中不能起跳');
  // 落地后立刻按跳，应能起跳
  landOnGround(p, t);
  assert.ok(p.landGrace > 0, '落地后应有宽限窗口');
  assert.equal(jump(p), true, '落地宽限内可以起跳');
});

test('跳跃缓冲：空中提前按跳，落地后窗口内生效', () => {
  const t = generateTrack({ seed: 8 });
  const p = createPlayer(t.spawn);
  p.position[1] = 3.0;
  for (let i = 0; i < 60; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  jump(p);
  for (let i = 0; i < 8; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  assert.equal(p.coyote, 0);
  assert.equal(jump(p), false, '空中按下不立刻起跳');
  assert.ok(p.jumpBuffer > 0, '但会记入缓冲');
  for (let i = 0; i < 30 && !p.onGround; i++) updatePlayer(p, 1 / 60, { targetX: 0 }, t);
  assert.ok(p.landGrace > 0, '落地后缓冲应转化为可起跳窗口');
  assert.equal(jump(p), true, '缓冲的按键应在落地后生效');
});

function landOnGround(p, t) {
  for (let i = 0; i < 120; i++) {
    updatePlayer(p, 1 / 60, { targetX: 0 }, t);
    if (p.onGround) return;
  }
}


test('横向移动收敛到目标跑道且不越界', () => {
  const t = generateTrack({ seed: 9 });
  const p = createPlayer(t.spawn);
  const laneX = (i) => (i - (LEVEL.laneWidth ? 1 : 1)) * LEVEL.laneWidth;
  for (let i = 0; i < 120; i++) updatePlayer(p, 1 / 60, { targetX: laneX(2) }, t);
  assert.ok(Math.abs(p.position[0] - laneX(2)) < 0.2);
});

test('金币必须落在平台上且留有余量（不会落在断层上）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const t = generateTrack({ seed, segments: 16, lanes: 3 });
    for (const c of t.coins) {
      // 金币中心在平台内，且离边缘至少 0.8 米，保证能被拾取
      let ok = false;
      for (const p of t.platforms) {
        if (Math.abs(c.x - p.x) <= p.w / 2 - 0.5 && Math.abs(c.z - p.z) <= p.d / 2 - 0.8) { ok = true; break; }
      }
      assert.ok(ok, `seed ${seed} 金币 (${c.x},${c.z}) 不在平台安全区内`);
    }
  }
});
