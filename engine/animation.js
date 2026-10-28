// 关键帧动画：轨道（每根骨骼一条）、采样、循环、多动作混合。
// 纯逻辑，可在 Node 中单测。

import { quat, lerp, clamp } from "./math.js";

/**
 * 一个动作。
 * tracks: [{ bone: <骨骼索引或名字>, pos: [[t, x,y,z], ...], rot: [[t, x,y,z,w], ...], scale: [...] }]
 * duration: 秒
 */
export class AnimationClip {
  constructor(name, duration, tracks = []) {
    this.name = name;
    this.duration = Math.max(duration, 0.0001);
    this.tracks = tracks;
    // 预排序，采样时可以用二分或线性扫描
    for (const tr of this.tracks) {
      if (tr.pos) tr.pos.sort((a, b) => a[0] - b[0]);
      if (tr.rot) tr.rot.sort((a, b) => a[0] - b[0]);
      if (tr.scale) tr.scale.sort((a, b) => a[0] - b[0]);
    }
  }

  toJSON() {
    return { name: this.name, duration: this.duration, tracks: this.tracks };
  }

  static fromJSON(data) {
    return new AnimationClip(data.name, data.duration, data.tracks || []);
  }
}

/**
 * 在关键帧数组中采样。
 * 返回 [x, y, z] 或 [x, y, z, w]；四元数走 slerp。
 */
export function sampleTrack(keys, time, isQuat) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) return keys[0].slice(1);
  if (time <= keys[0][0]) return keys[0].slice(1);
  const last = keys[keys.length - 1];
  if (time >= last[0]) return last.slice(1);

  // 线性扫描（轨道通常很短，二分带来的复杂度不划算）
  let lo = 0;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i][0] >= time) { lo = i - 1; break; }
  }
  const a = keys[lo], b = keys[lo + 1];
  const span = b[0] - a[0];
  const t = span > 1e-9 ? (time - a[0]) / span : 0;

  if (isQuat) {
    const qa = [a[1], a[2], a[3], a[4]];
    const qb = [b[1], b[2], b[3], b[4]];
    return quat.slerp([0, 0, 0, 1], qa, qb, t);
  }
  return [
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
    lerp(a[3], b[3], t),
  ];
}

/**
 * 动画播放器：管理当前动作、时间推进、循环，并把结果写回骨骼。
 */
export class AnimationPlayer {
  constructor() {
    this.clip = null;
    this.time = 0;
    this.speed = 1;
    this.loop = true;
    this.playing = false;
    this.onFinish = null;
    // 交叉淡入淡出
    this.fade = null;
  }

  play(clip, { loop = true, fade = 0, speed = 1 } = {}) {
    if (!clip) return;
    if (fade > 0 && this.clip) {
      // 把当前姿势冻结成快照，淡出到新动作
      this.fade = { from: this._snapshot || null, progress: 0, duration: fade };
    }
    this.clip = clip;
    this.time = 0;
    this.loop = loop;
    this.speed = speed;
    this.playing = true;
    return this;
  }

  stop() {
    this.playing = false;
  }

  // 推进时间并采样到骨骼
  update(dt, skeleton) {
    if (!this.clip || !skeleton) return;
    if (!this.playing) return;

    const prevTime = this.time;
    this.time += dt * this.speed;
    if (this.loop) {
      this.time %= this.clip.duration;
      if (this.time < 0) this.time += this.clip.duration;
    } else if (this.time >= this.clip.duration) {
      this.time = this.clip.duration;
      this.playing = false;
      if (this.onFinish) this.onFinish(this.clip);
    }
    void prevTime;
    this.apply(skeleton);
  }

  // 把当前时间的姿势写进骨骼
  apply(skeleton) {
    const clip = this.clip;
    if (!clip) return;
    const bones = skeleton.bones;
    for (const tr of clip.tracks) {
      const bi = typeof tr.bone === "number" ? tr.bone : skeleton.indexOf(tr.bone);
      if (bi < 0 || bi >= bones.length) continue;
      const bone = bones[bi];
      const p = sampleTrack(tr.pos, this.time, false);
      if (p) bone.position = p;
      const r = sampleTrack(tr.rot, this.time, true);
      if (r) bone.rotation = r;
      const s = sampleTrack(tr.scale, this.time, false);
      if (s) bone.scale = s;
    }
    skeleton.dirty = true;
  }

  // 在给定动作的某个时间点取姿势快照（用于淡入淡出 / 编辑器拖动时间轴）
  static poseAt(clip, time, skeleton) {
    const bones = skeleton.bones.map((b) => ({
      position: [...b.position],
      rotation: [...b.rotation],
      scale: [...b.scale],
    }));
    for (const tr of clip.tracks) {
      const bi = typeof tr.bone === "number" ? tr.bone : skeleton.indexOf(tr.bone);
      if (bi < 0) continue;
      const p = sampleTrack(tr.pos, time, false);
      const r = sampleTrack(tr.rot, time, true);
      const s = sampleTrack(tr.scale, time, false);
      if (p) bones[bi].position = p;
      if (r) bones[bi].rotation = r;
      if (s) bones[bi].scale = s;
    }
    return bones;
  }
}

/**
 * 程序化关键帧生成小工具：给一段"骨骼 → 角度"的曲线打关键帧。
 * frames: [[time, {boneName: [rx,ry,rz] 或 {pos, rot, scale}}], ...]
 */
export function buildClipFromFrames(name, duration, frames, skeleton) {
  const tracks = new Map();
  const ensure = (boneRef) => {
    const key = typeof boneRef === "number" ? boneRef : boneRef;
    if (!tracks.has(key)) tracks.set(key, { bone: boneRef, pos: [], rot: [], scale: [] });
    return tracks.get(key);
  };

  for (const [t, pose] of frames) {
    for (const [boneName, val] of Object.entries(pose)) {
      const tr = ensure(boneName);
      const bi = skeleton.indexOf(boneName);
      if (bi < 0) continue;
      if (Array.isArray(val)) {
        // 只给旋转（欧拉角，度）
        const q = quat.fromEulerXYZ(
          [0, 0, 0, 1],
          (val[0] * Math.PI) / 180,
          (val[1] * Math.PI) / 180,
          (val[2] * Math.PI) / 180,
        );
        tr.rot.push([t, q[0], q[1], q[2], q[3]]);
      } else {
        if (val.rot) {
          const q = quat.fromEulerXYZ(
            [0, 0, 0, 1],
            (val.rot[0] * Math.PI) / 180,
            (val.rot[1] * Math.PI) / 180,
            (val.rot[2] * Math.PI) / 180,
          );
          tr.rot.push([t, q[0], q[1], q[2], q[3]]);
        }
        if (val.pos) tr.pos.push([t, ...val.pos]);
        if (val.scale) tr.scale.push([t, ...val.scale]);
      }
    }
  }

  const out = [];
  for (const tr of tracks.values()) {
    const t2 = { bone: tr.bone };
    if (tr.pos.length) t2.pos = tr.pos;
    if (tr.rot.length) t2.rot = tr.rot;
    if (tr.scale.length) t2.scale = tr.scale;
    out.push(t2);
  }
  return new AnimationClip(name, duration, out);
}

// 把姿势快照写回骨骼（用于交叉淡入淡出的起点）
export function applyPose(skeleton, pose, weight = 1) {
  const w = clamp(weight, 0, 1);
  for (let i = 0; i < skeleton.bones.length; i++) {
    const dst = skeleton.bones[i];
    const src = pose[i];
    if (!src) continue;
    if (w >= 1) {
      dst.position = [...src.position];
      dst.rotation = [...src.rotation];
      dst.scale = [...src.scale];
    } else {
      dst.position = [
        lerp(dst.position[0], src.position[0], w),
        lerp(dst.position[1], src.position[1], w),
        lerp(dst.position[2], src.position[2], w),
      ];
      dst.rotation = quat.slerp([0, 0, 0, 1], dst.rotation, src.rotation, w);
      dst.scale = [
        lerp(dst.scale[0], src.scale[0], w),
        lerp(dst.scale[1], src.scale[1], w),
        lerp(dst.scale[2], src.scale[2], w),
      ];
    }
  }
  skeleton.dirty = true;
}

// 生成姿势快照
export function snapshotPose(skeleton) {
  return skeleton.bones.map((b) => ({
    position: [...b.position],
    rotation: [...b.rotation],
    scale: [...b.scale],
  }));
}
