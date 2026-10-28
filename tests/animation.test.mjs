import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Skeleton } from '../engine/skeleton.js';
import {
  AnimationClip, AnimationPlayer, sampleTrack, buildClipFromFrames, snapshotPose, applyPose,
} from '../engine/animation.js';
import { quat, rad2deg } from '../engine/math.js';

function chain() {
  const a = new Bone('root', -1);
  const b = new Bone('arm', 0);
  b.position = [1, 0, 0];
  const sk = new Skeleton([a, b]);
  sk.captureBindPose();
  return sk;
}

test('采样：关键帧之间线性插值', () => {
  const keys = [[0, 0, 0, 0], [1, 10, 0, 0]];
  assert.deepEqual(sampleTrack(keys, 0.5, false), [5, 0, 0]);
  assert.deepEqual(sampleTrack(keys, 0, false), [0, 0, 0]);
  assert.deepEqual(sampleTrack(keys, 1, false), [10, 0, 0]);
});

test('采样：超出范围取端点', () => {
  const keys = [[1, 5, 0, 0], [2, 12, 0, 0]];
  assert.deepEqual(sampleTrack(keys, 0, false), [5, 0, 0]);
  assert.deepEqual(sampleTrack(keys, 9, false), [12, 0, 0]);
});

test('采样：四元数走 slerp', () => {
  const q0 = quat.fromEulerXYZ([0, 0, 0, 1], 0, 0, 0);
  const q1 = quat.fromEulerXYZ([0, 0, 0, 1], 0, Math.PI / 2, 0);
  const keys = [[0, ...q0], [1, ...q1]];
  const mid = sampleTrack(keys, 0.5, true);
  const e = quat.toEulerXYZ(mid);
  assert.ok(Math.abs(rad2deg(e[1]) - 45) < 0.5, `y=${rad2deg(e[1])}`);
});

test('buildClipFromFrames 由欧拉角关键帧生成四元数轨道', () => {
  const sk = chain();
  const clip = buildClipFromFrames('wave', 1, [
    [0, { arm: [0, 0, 0] }],
    [0.5, { arm: [0, 90, 0] }],
    [1, { arm: [0, 0, 0] }],
  ], sk);
  assert.equal(clip.tracks.length, 1);
  const tr = clip.tracks[0];
  assert.equal(tr.bone, 'arm');
  assert.equal(tr.rot.length, 3);
  // 中间帧应确实是 90 度
  const mid = sampleTrack(tr.rot, 0.5, true);
  assert.ok(Math.abs(rad2deg(quat.toEulerXYZ(mid)[1]) - 90) < 0.5);
});

test('播放器推进时间并写回骨骼', () => {
  const sk = chain();
  const clip = buildClipFromFrames('t', 1, [
    [0, { arm: [0, 0, 0] }],
    [1, { arm: [0, 90, 0] }],
  ], sk);
  const p = new AnimationPlayer();
  p.play(clip);
  p.update(0.5, sk);
  const e = quat.toEulerXYZ(sk.bones[1].rotation);
  assert.ok(Math.abs(rad2deg(e[1]) - 45) < 1, `y=${rad2deg(e[1])}`);
});

test('循环动作回绕，非循环动作停在末尾并回调', () => {
  const sk = chain();
  const clip = buildClipFromFrames('t', 1, [[0, { arm: [0, 0, 0] }], [1, { arm: [0, 90, 0] }]], sk);
  const p = new AnimationPlayer();
  p.play(clip, { loop: true });
  p.update(1.25, sk);
  assert.ok(p.time < 0.5, `time=${p.time}`);

  let finished = 0;
  const p2 = new AnimationPlayer();
  p2.onFinish = () => finished++;
  p2.play(clip, { loop: false });
  p2.update(3, sk);
  assert.equal(finished, 1);
  assert.equal(p2.playing, false);
});

test('目标骨骼名不存在时安全跳过', () => {
  const sk = chain();
  const clip = new AnimationClip('bad', 1, [{ bone: '不存在', rot: [[0, 0, 0, 0, 1]] }]);
  const p = new AnimationPlayer();
  p.play(clip);
  p.update(0.5, sk);
  assert.ok(true);
});

test('姿势快照与回写', () => {
  const sk = chain();
  sk.bones[1].rotation = quat.fromEulerXYZ([0, 0, 0, 1], 0, Math.PI / 2, 0);
  const pose = snapshotPose(sk);
  sk.bones[1].rotation = [0, 0, 0, 1];
  applyPose(sk, pose);
  const e = quat.toEulerXYZ(sk.bones[1].rotation);
  assert.ok(Math.abs(rad2deg(e[1]) - 90) < 0.5);
});

test('姿势按权重插值（淡入淡出）', () => {
  const sk = chain();
  sk.bones[1].rotation = [0, 0, 0, 1];
  const target = snapshotPose(sk);
  target[1].rotation = quat.fromEulerXYZ([0, 0, 0, 1], 0, Math.PI / 2, 0);
  applyPose(sk, target, 0.5);
  const e = quat.toEulerXYZ(sk.bones[1].rotation);
  assert.ok(Math.abs(rad2deg(e[1]) - 45) < 1, `y=${rad2deg(e[1])}`);
});

test('时间轴取姿势不影响当前骨骼状态', () => {
  const sk = chain();
  const clip = buildClipFromFrames('t', 1, [[0, { arm: [0, 0, 0] }], [1, { arm: [0, 90, 0] }]], sk);
  const before = [...sk.bones[1].rotation];
  const pose = AnimationPlayer.poseAt(clip, 1, sk);
  assert.deepEqual([...sk.bones[1].rotation], before);
  const e = quat.toEulerXYZ(pose[1].rotation);
  assert.ok(Math.abs(rad2deg(e[1]) - 90) < 1);
});
