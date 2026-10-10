/**
 * anim 单测：动图**疑似判据**（后缀白名单）、帧数上限、每帧像素预算、解码目标尺寸、帧数组释放。
 *
 * 这四件事之所以要单测，是因为它们在真机上**只能靠 Profiler 与肉眼**判断
 * （"这张 gif 到底解了几帧""内存有没有降下来"），而它们的**判定逻辑**
 * 完全可以在 Node 上钉死。真机上剩下的不确定只有"平台有没有按 desiredSize 解"，
 * 那一条写在报告的"真机需验"里，不该混进这里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnimatedCandidate, shouldDecodeFrames, framePixelBudget, frameDecodeSize, releaseAll,
  ANIM_EXTENSIONS, MAX_ANIM_FRAMES, ANIM_TOTAL_PIXEL_BUDGET,
  ANIM_MIN_FRAME_PIXELS, ANIM_MAX_FRAME_PIXELS
} from './anim.ts';
import type { FrameLike, FrameSize } from './anim.ts';

// ── 1. 疑似判据：后缀白名单 ────────────────────────────────────────────────

test('疑似判据：gif / webp 命中，且大小写不敏感', () => {
  assert.equal(isAnimatedCandidate('file://media/Photo/12/IMG_001/a.gif'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/12/IMG_001/a.GIF'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/12/IMG_001/a.Gif'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/12/IMG_001/a.webp'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/12/IMG_001/a.WEBP'), true);
  assert.equal(isAnimatedCandidate('a.gif'), true);
});

test('疑似判据：query 与 fragment 不算后缀的一部分（先切掉再取后缀）', () => {
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.gif?networkid=1'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.gif#frag'), true);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.GIF?x=1#y'), true);
  // 反例：真后缀藏在 query 之后时不能被误判成命中（切掉后末段是 a.jpg）
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.jpg?v=.gif'), false);
});

test('疑似判据：静态格式一律不命中（含 SDK 明确不支持的 APNG）', () => {
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.jpg'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.jpeg'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.png'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.heic'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.heif'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.bmp'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a'), false);
});

test('疑似判据：目录名里的点不能当后缀（只看最后一段路径）', () => {
  assert.equal(isAnimatedCandidate('file://media/Photo/v1.2/a.jpg'), false);
  // 目录名以 .gif 结尾、文件名没有后缀 → 不能命中
  assert.equal(isAnimatedCandidate('file://media/Photo/gif.dir/a'), false);
});

test('疑似判据：四个退化输入一律 false（空串 / 无点 / 点在首位 / 点在末位）', () => {
  assert.equal(isAnimatedCandidate(''), false);
  assert.equal(isAnimatedCandidate('a'), false);
  assert.equal(isAnimatedCandidate('gif'), false);
  // 点在首位 = 隐藏文件名本身（`.gif` 这个名字没有后缀）
  assert.equal(isAnimatedCandidate('.gif'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/.gif'), false);
  // 点在末位 = 空后缀
  assert.equal(isAnimatedCandidate('a.'), false);
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.'), false);
  // 末段为空（URI 以 / 结尾）
  assert.equal(isAnimatedCandidate('file://media/Photo/1/a.gif/'), false);
});

test('白名单的内容与本测试的假设一致（改动白名单必须同时改这里）', () => {
  assert.deepEqual(ANIM_EXTENSIONS.slice().sort(), ['gif', 'webp']);
});

// ── 2. 帧数上限：权威判据是 getFrameCount() > 1 ─────────────────────────────

test('帧数判据：静态图（0/1）不解帧 —— 后缀命中的静态 gif 也走静态路径', () => {
  assert.equal(shouldDecodeFrames(0), false);
  assert.equal(shouldDecodeFrames(1), false);
});

test('帧数判据：2..240 帧解，超过上限退回静态第一帧', () => {
  assert.equal(shouldDecodeFrames(2), true);
  assert.equal(shouldDecodeFrames(30), true);
  assert.equal(shouldDecodeFrames(MAX_ANIM_FRAMES), true);
  assert.equal(shouldDecodeFrames(MAX_ANIM_FRAMES + 1), false);
  assert.equal(shouldDecodeFrames(100000), false);
});

test('帧数判据：非有限值与负数一律 false（不拿坏数据去乘内存）', () => {
  assert.equal(shouldDecodeFrames(Number.NaN), false);
  assert.equal(shouldDecodeFrames(Number.POSITIVE_INFINITY), false);
  assert.equal(shouldDecodeFrames(-5), false);
});

// ── 3. 每帧像素预算：帧越多、每帧越小，但两头都有夹子 ─────────────────────────

test('每帧预算：帧数少时不浪费（夹在上限）', () => {
  // 总预算 12 Mpx：帧数 ≤ 11 时摊出来都超过单帧上限（12M/11 = 1.09 Mpx > 1.048 Mpx）
  assert.equal(framePixelBudget(1), ANIM_MAX_FRAME_PIXELS);
  assert.equal(framePixelBudget(2), ANIM_MAX_FRAME_PIXELS);
  assert.equal(framePixelBudget(11), ANIM_MAX_FRAME_PIXELS);
  // 12 帧摊出来是 1,000,000 —— **刚好落在上限之下**，所以它不再被夹（这是刻意的：上限只是天花板）
  assert.equal(framePixelBudget(12), 1000000);
  assert.ok(framePixelBudget(12) < ANIM_MAX_FRAME_PIXELS);
});

test('每帧预算：中间段就是总预算除以帧数', () => {
  assert.equal(framePixelBudget(24), Math.floor(ANIM_TOTAL_PIXEL_BUDGET / 24));
  assert.equal(framePixelBudget(120), Math.floor(ANIM_TOTAL_PIXEL_BUDGET / 120));
});

test('每帧预算：帧数极大时夹在下限（宁可略超总预算，也不给马赛克）', () => {
  // 240 帧摊出来是 50000 px/帧，仍在下限之上
  assert.equal(framePixelBudget(MAX_ANIM_FRAMES), Math.floor(ANIM_TOTAL_PIXEL_BUDGET / MAX_ANIM_FRAMES));
  assert.ok(framePixelBudget(MAX_ANIM_FRAMES) >= ANIM_MIN_FRAME_PIXELS);
  // 1000 帧摊出来只有 12000 px/帧 → 顶到下限
  assert.equal(framePixelBudget(1000), ANIM_MIN_FRAME_PIXELS);
  assert.equal(framePixelBudget(100000), ANIM_MIN_FRAME_PIXELS);
});

test('每帧预算：非法帧数返回下限（调用点不该走到，但要给一个能用的值而不是 0）', () => {
  assert.equal(framePixelBudget(0), ANIM_MIN_FRAME_PIXELS);
  assert.equal(framePixelBudget(-3), ANIM_MIN_FRAME_PIXELS);
  assert.equal(framePixelBudget(Number.NaN), ANIM_MIN_FRAME_PIXELS);
  assert.equal(framePixelBudget(Number.POSITIVE_INFINITY), ANIM_MIN_FRAME_PIXELS);
});

test('每帧预算：随帧数单调不增（多了不会反而更费）', () => {
  let prev: number = Number.POSITIVE_INFINITY;
  for (let n = 1; n <= 400; n++) {
    const b: number = framePixelBudget(n);
    assert.ok(b <= prev, `帧数 ${n} 的预算 ${b} 不应大于上一档 ${prev}`);
    prev = b;
  }
});

// ── 4. 解码目标尺寸：保比例、不放大、下限 1 ────────────────────────────────

test('目标尺寸：按预算缩小，且宽高比与原图一致', () => {
  const s: FrameSize = frameDecodeSize(1920, 1080, ANIM_MAX_FRAME_PIXELS);
  assert.ok(s.width * s.height <= ANIM_MAX_FRAME_PIXELS, '乘积不得超过预算');
  assert.ok(s.width > 0 && s.height > 0);
  // floor 会带来至多 1px 的偏差，比例应非常接近
  const srcR: number = 1920 / 1080;
  const outR: number = s.width / s.height;
  assert.ok(Math.abs(outR - srcR) < 0.01, `比例偏差过大: ${outR} vs ${srcR}`);
  assert.equal(s.width, Math.floor(1920 * Math.sqrt(ANIM_MAX_FRAME_PIXELS / (1920 * 1080))));
});

test('目标尺寸：原图比预算小就原样返回（绝不放大）', () => {
  assert.deepEqual(frameDecodeSize(100, 80, ANIM_MAX_FRAME_PIXELS), { width: 100, height: 80 });
  // 恰好等于预算也原样
  assert.deepEqual(frameDecodeSize(100, 100, 10000), { width: 100, height: 100 });
});

test('目标尺寸：极小预算下两条边都不小于 1（0 是非法尺寸）', () => {
  // 1000×1000 配 1px 预算：f = 0.001 → 两条边都算成 1（floor 后正好是 1，不被下限改）
  assert.deepEqual(frameDecodeSize(1000, 1000, 1), { width: 1, height: 1 });
  // 极端横幅 10000×3 配 1px 预算：宽算成 57，**高会 floor 到 0** → 被下限抬成 1。
  // 这条正是下限存在的理由：不抬的话会传一个 height = 0 给 desiredSize（非法参数，解码报 401）。
  assert.deepEqual(frameDecodeSize(10000, 3, 1), { width: 57, height: 1 });
  // 极端竖幅同理（对称）
  assert.deepEqual(frameDecodeSize(3, 10000, 1), { width: 1, height: 57 });
});

test('目标尺寸：退化输入返回 {0,0}（含义是"给不出目标尺寸"，调用点据此不传 desiredSize）', () => {
  assert.deepEqual(frameDecodeSize(0, 100, 1000), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(100, 0, 1000), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(-100, 100, 1000), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(Number.NaN, 100, 1000), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(100, Number.POSITIVE_INFINITY, 1000), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(100, 100, 0), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(100, 100, -1), { width: 0, height: 0 });
  assert.deepEqual(frameDecodeSize(100, 100, Number.NaN), { width: 0, height: 0 });
});

// ── 5. 释放编排：三条必须成立的性质（真机上无法单测，但编排可以）────────────

/** 记帐假帧：记录自己有没有被释放，可选地按指令抛错/拒绝。 */
class FakeFrame implements FrameLike {
  readonly name: string;
  private mode: string;      // 'ok' | 'throw' | 'reject'
  released: boolean = false;
  constructor(name: string, mode: string) {
    this.name = name;
    this.mode = mode;
  }
  release(): Promise<void> {
    this.released = true;
    if (this.mode === 'throw') { throw new Error(`sync-fail:${this.name}`); }
    if (this.mode === 'reject') { return Promise.reject(new Error(`async-fail:${this.name}`)); }
    return Promise.resolve();
  }
}

test('释放：全部帧都被释放，返回释放帧数', () => {
  const a: FakeFrame = new FakeFrame('a', 'ok');
  const b: FakeFrame = new FakeFrame('b', 'ok');
  const c: FakeFrame = new FakeFrame('c', 'ok');
  const n: number = releaseAll([a, b, c]);
  assert.equal(n, 3);
  assert.equal(a.released, true);
  assert.equal(b.released, true);
  assert.equal(c.released, true);
});

test('释放：某一帧同步抛错不阻断后续帧（漏一帧只是漏一点内存，中断整批会把大头留下）', () => {
  const a: FakeFrame = new FakeFrame('a', 'ok');
  const boom: FakeFrame = new FakeFrame('boom', 'throw');
  const c: FakeFrame = new FakeFrame('c', 'ok');
  const d: FakeFrame = new FakeFrame('d', 'ok');
  const n: number = releaseAll([a, boom, c, d]);
  assert.equal(n, 3, '抛错的那一帧不计入成功数');
  assert.equal(a.released, true);
  assert.equal(boom.released, true, '它自己已经被调用过');
  assert.equal(c.released, true, '抛错之后的帧仍必须被释放');
  assert.equal(d.released, true);
});

test('释放：空数组 / 空洞元素不报错（换卡竞态下数组可能已经空了）', () => {
  assert.equal(releaseAll([]), 0);
  // 稀疏数组：list[0] 是空洞（运行期读到 undefined，而类型上仍是 FrameLike）。
  // 这是"类型合法但运行期有空位"的唯一构造方式 —— 守卫要挡的就是它。
  const sparse: FrameLike[] = [];
  sparse[1] = new FakeFrame('a', 'ok');
  assert.equal(releaseAll(sparse), 1);
  assert.equal(sparse[1].released, true);
});

test('释放：release() 返回被拒绝的 Promise 必须被吞掉（否则进程会因未处理 rejection 退出）', () => {
  // 这条断言的真正载体是**这次测试运行的退出码**：Node 默认把未处理的 Promise 拒绝
  // 当成致命错误（--unhandled-rejections=throw），所以只要 releaseAll 少挂一个 catch，
  // 本文件就会以非 0 退出码结束 —— 比在这里断言一个内部标志更强。
  const r: FakeFrame = new FakeFrame('reject', 'reject');
  const n: number = releaseAll([r]);
  assert.equal(n, 1);
  assert.equal(r.released, true);
});
