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
  ANIM_MIN_FRAME_PIXELS, ANIM_MAX_FRAME_PIXELS,
  decodeAnim, isStaticConclusion,
  ANIM_NOT_CANDIDATE, ANIM_CACHED_STATIC, ANIM_STATIC_FEW_FRAMES, ANIM_STATIC_ORIENTATION,
  ANIM_NO_HANDLE, ANIM_EMPTY_FRAMES, ANIM_FAILED, ANIM_READY
} from './anim.ts';
import type {
  FrameLike, FrameSize, AnimIo, AnimSourceHandle, AnimDecoded, AnimDecodeResult
} from './anim.ts';

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

// ── 4b. 目标尺寸（补强）：预算取**生产路径**的 `framePixelBudget(真实帧数)` ─────────
//
// 上面 4 条尺寸用例里只有一条覆盖降采样支，而且它的预算硬编码成 `ANIM_MAX_FRAME_PIXELS`
// （**单帧上限** 1.048 Mpx），生产路径传的却是 `framePixelBudget(count)`
// （`data/animSource.ets`：`const budget = framePixelBudget(count)`，count 是真实帧数）。
// 两者差一个数量级，于是下面两个**具体变异**在旧用例上完全看不见：
//   · `Math.floor` → `Math.round`：floor 是「乘积 ≤ 预算」的唯一保证，round 会越界；
//   · `f` 的基数从 `srcW * srcH` 换成 `Math.max(srcW, srcH)`：量纲错了，算出来的
//     尺寸**比原图还大** → 动图被放大解码 → 整条内存预算失效。
// 所以这一节用真实帧数驱动预算，并逐条钉死期望值（不是拿同一条公式再算一遍）。

/** 一条尺寸用例：真实帧数 → 生产预算 → 期望的解码目标尺寸。 */
interface SizeCase {
  srcW: number;
  srcH: number;
  frames: number;
  budget: number;
  wantW: number;
  wantH: number;
  note: string;
}

const SIZE_CASES: SizeCase[] = [
  // 240 = MAX_ANIM_FRAMES → 生产路径上**最小可达**的每帧预算（12 Mpx / 240 = 50000）。
  // 这就是"真机最坏内存档"：一张 4000×3000 的 240 帧长动图。
  { srcW: 4000, srcH: 3000, frames: 240, budget: 50000, wantW: 258, wantH: 193,
    note: '帧数上限档（可达的最坏档）：4000×3000 的 240 帧' },
  // 60 帧 = 常见 GIF。注意这一条的 floor 与 round **恰好同值**，见下面的反向证明。
  { srcW: 4032, srcH: 3024, frames: 60, budget: 200000, wantW: 516, wantH: 387,
    note: '常见 GIF 帧数：4032×3024 的 60 帧' },
  { srcW: 1920, srcH: 1080, frames: 120, budget: 100000, wantW: 421, wantH: 237,
    note: '1080p / 120 帧' },
  // 1000 帧 → 12000000/1000 = 12000 < 下限 → 夹到 25600。⚠️ 这一档在生产路径上**不可达**
  // （`shouldDecodeFrames` 把帧数锁在 ≤ 240，而 12000000/240 = 50000 > 25600），
  // 它作为纯函数边界登记在此，用来打穿与预算绝对值无关的变异。
  { srcW: 4000, srcH: 3000, frames: 1000, budget: 25600, wantW: 184, wantH: 138,
    note: '预算下限档（纯函数边界，生产不可达）：4000×3000 的 1000 帧' }
];

test('目标尺寸（生产预算档）：乘积 ≤ 预算、比例偏差 < 1%、两边 ≥ 1、绝不放大（补强）', () => {
  for (let i = 0; i < SIZE_CASES.length; i++) {
    const c: SizeCase = SIZE_CASES[i];
    // 预算必须由**真实帧数**算出，而不是硬编码单帧上限 —— 这正是旧用例缺的那一环。
    const budget: number = framePixelBudget(c.frames);
    assert.equal(budget, c.budget, `帧数 ${c.frames} 的预算应与表一致（${c.note}）`);
    const s: FrameSize = frameDecodeSize(c.srcW, c.srcH, budget);
    // 逐条钉死期望值：hardcode 才能拦住"公式被换掉但结果仍然自洽"的变异
    assert.equal(s.width, c.wantW, `${c.note}：宽`);
    assert.equal(s.height, c.wantH, `${c.note}：高`);
    // ① 宽高比偏差 < 1%（floor 至多带来 1px 偏差；极端长宽比另有专门用例）
    const srcR: number = c.srcW / c.srcH;
    const outR: number = s.width / s.height;
    assert.ok(Math.abs(outR - srcR) / srcR < 0.01,
      `${c.note}：比例偏差 ${(Math.abs(outR - srcR) / srcR * 100).toFixed(3)}% ≥ 1%`);
    // ② 乘积 ≤ 预算（floor 的直接后果）—— 内存预算成立的唯一算式
    assert.ok(s.width * s.height <= budget,
      `${c.note}：${s.width}×${s.height}=${s.width * s.height} 超过预算 ${budget}`);
    // ③ 两条边 ≥ 1（0 是非法 desiredSize，解码会报 401）
    assert.ok(s.width >= 1 && s.height >= 1, `${c.note}：两边都必须 ≥ 1`);
    // 附带：绝不放大（放大只会更糊、更占内存）
    assert.ok(s.width <= c.srcW && s.height <= c.srcH, `${c.note}：不得放大解码`);
  }
});

/**
 * 变异 A：把 `Math.floor` 换成 `Math.round`。**这不是源码**，只是"如果那样写会怎样"的影子函数
 * —— 反向证明用它，是为了说明上表的 ② 不是空的。
 */
function variantRound(srcW: number, srcH: number, budgetPx: number): FrameSize {
  const srcPixels: number = srcW * srcH;
  if (srcPixels <= budgetPx) { return { width: Math.round(srcW), height: Math.round(srcH) }; }
  const f: number = Math.sqrt(budgetPx / srcPixels);
  return { width: Math.round(srcW * f), height: Math.round(srcH * f) };
}

/**
 * 变异 B：把 `f` 的基数从 `srcW * srcH` 换成 `Math.max(srcW, srcH)`（量纲错了）。
 * 它算出来的边长会**超过原图** → 放大解码 → 内存预算整条失效。
 */
function variantMaxBase(srcW: number, srcH: number, budgetPx: number): FrameSize {
  const f: number = Math.sqrt(budgetPx / Math.max(srcW, srcH));
  return { width: Math.round(srcW * f), height: Math.round(srcH * f) };
}

test('目标尺寸：反向证明 —— round 变异会越界、换基数变异会放大解码（本测试有判别力）', () => {
  let roundOverflow: number = 0;
  for (let i = 0; i < SIZE_CASES.length; i++) {
    const c: SizeCase = SIZE_CASES[i];
    const budget: number = framePixelBudget(c.frames);
    const good: FrameSize = frameDecodeSize(c.srcW, c.srcH, budget);
    // 真函数：不越界（与上一条用例同源，这里再算一次是为了让"反例"与"正例"并排可读）
    assert.ok(good.width * good.height <= budget, `${c.note}：真函数不该越界`);
    const bad: FrameSize = variantRound(c.srcW, c.srcH, budget);
    if (bad.width * bad.height > budget) { roundOverflow = roundOverflow + 1; }
    // 变异 B 在**每一条**用例上都必须被抓到：它把短边也算成"比原图大"
    const mb: FrameSize = variantMaxBase(c.srcW, c.srcH, budget);
    assert.ok(mb.width > c.srcW,
      `${c.note}：换基数变异应放大解码（宽 ${mb.width} > 原图 ${c.srcW}），否则本用例没有判别力`);
    assert.ok(mb.width * mb.height > budget,
      `${c.note}：换基数变异应超出预算`);
  }
  // 诚实登记：4 条里有 3 条能被 round 变异打穿。剩下那条（4032×3024 / 60 帧）
  // 的 floor 与 round **恰好同值**（516.4→516、387.3→387），所以它拦不住 round ——
  // 它的判别力由变异 B 承担。写死 3 而不是 ≥1，是为了让"又有一条失效"必须改这里才能过。
  assert.equal(roundOverflow, 3, 'round 变异应恰好打穿 3 条用例（第 2 条 floor/round 同值）');
});

test('目标尺寸：下限 1 在**生产帧数档**下也会被行使（旧用例只在 budget=1 上试过）', () => {
  const b: number = framePixelBudget(1000);
  assert.equal(b, ANIM_MIN_FRAME_PIXELS);
  // 100000×3 配 25600：f = 0.29215，短边 3 × f = 0.876 → floor 到 **0**，
  // 必须被下限抬成 1 —— 否则会把 height = 0 传进 desiredSize（非法参数，解码报 401）。
  assert.deepEqual(frameDecodeSize(100000, 3, b), { width: 29211, height: 1 });
  // 对称：竖幅同样被抬
  assert.deepEqual(frameDecodeSize(3, 100000, b), { width: 1, height: 29211 });
  // ⚠️ 显式登记例外：这一档下 `width * height`（29211）**大于**预算（25600）。
  // 极端长宽比下"下限 1"与"乘积 ≤ 预算"不可兼得，仓里选了"宁可略超预算，也不传 0"
  // （`core/anim.ts:175` 的说明）。所以上表的 ② 断言只对常规长宽比成立，这里把例外写下来。
  assert.ok(29211 * 1 > b, '登记：极端长宽比下确实超预算，这是有意的取舍');
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

// ── 6. 负缓存策略（缺陷 D3）：只对**确定性结论**写，瞬时失败绝不写 ───────────────
//
// 这一节是 D3 的**可执行证据**。旧实现把"要不要记成永久结论"写在
// `data/animSource.ets` 的 try/catch / 各分支里（共 5 处），而那个文件 import `@kit.*`
// → 在 Node 上跑不起来，于是这条策略**没有任何测试能碰到它**。
// 现在流水线在 core（`decodeAnim`），平台能力经 `AnimIo` 注入，于是下面这些断言
// 可以用假实现真跑一遍 —— 尤其是工单点名要的「第一次抛、第二次成功」。

/** 记帐假句柄：按脚本决定每一步的结局，并记下 `close()` 有没有被调用。 */
class FakeHandle implements AnimSourceHandle<FakeFrame> {
  frameCount: number;
  orientation: string;
  width: number = 4000;
  height: number = 3000;
  /** `createPixelMapList` 返回的帧数；0 = 返回**空数组**（"一帧都没解出来"）。 */
  frameTotal: number;
  throwOnDecode: boolean = false;
  throwOnDelay: boolean = false;
  closed: boolean = false;
  /** 最后一次喂给 `createPixelMapList` 的 desiredSize（null = 从没调用过）。 */
  lastTarget: FrameSize | null = null;
  decoded: FakeFrame[] = [];

  constructor(frameCount: number, orientation: string, frameTotal: number) {
    this.frameCount = frameCount;
    this.orientation = orientation;
    this.frameTotal = frameTotal;
  }

  async getFrameCount(): Promise<number> {
    return this.frameCount;
  }

  async getImageSize(): Promise<FrameSize> {
    return { width: this.width, height: this.height };
  }

  async getOrientation(): Promise<string> {
    return this.orientation;
  }

  async createPixelMapList(target: FrameSize): Promise<FakeFrame[]> {
    this.lastTarget = target;
    if (this.throwOnDecode) { throw new Error('decode-oom'); }
    const out: FakeFrame[] = [];
    for (let i = 0; i < this.frameTotal; i++) { out.push(new FakeFrame(`f${i}`, 'ok')); }
    this.decoded = out;
    return out;
  }

  async getDelayTimeList(): Promise<number[]> {
    if (this.throwOnDelay) { throw new Error('delay-boom'); }
    return [];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * 假端口：前 `failTimes` 次 `open` **抛错**，之后每次都给一个正常句柄。
 * 这就是工单要求的"第一次抛、第二次成功"的载体。
 */
class FlakyIo implements AnimIo<FakeFrame> {
  failTimes: number;
  opens: number = 0;
  handles: FakeHandle[] = [];
  frameCount: number;
  orientation: string;
  frameTotal: number;
  /** 在句柄交给调用点**之前**改它的脚本（例如让 getDelayTimeList 抛）。 */
  prepare: (h: FakeHandle) => void = (h: FakeHandle) => {};

  constructor(failTimes: number, frameCount: number, orientation: string, frameTotal: number) {
    this.failTimes = failTimes;
    this.frameCount = frameCount;
    this.orientation = orientation;
    this.frameTotal = frameTotal;
  }

  async open(uri: string): Promise<AnimSourceHandle<FakeFrame> | undefined> {
    this.opens = this.opens + 1;
    if (this.opens <= this.failTimes) { throw new Error(`transient-oom#${this.opens}`); }
    const h: FakeHandle = new FakeHandle(this.frameCount, this.orientation, this.frameTotal);
    this.prepare(h);
    this.handles.push(h);
    return h;
  }
}

/** 假端口：永远给不出句柄（旧实现的第三个写点就在这里）。 */
class NoHandleIo implements AnimIo<FakeFrame> {
  opens: number = 0;

  async open(uri: string): Promise<AnimSourceHandle<FakeFrame> | undefined> {
    this.opens = this.opens + 1;
    return undefined;
  }
}

const RETRY_URI: string = 'file://media/Photo/9/big.gif';

test('D3「两次调用」：第一次抛错、第二次成功 —— 第二次仍能装载，且负缓存里没有该 uri', async () => {
  const cache: Map<string, boolean> = new Map();
  const io: FlakyIo = new FlakyIo(1, 30, '1', 30);

  // ── 第一次：平台抛错（内存压力 / fd 耗尽 / 文件被占用 —— 全是**瞬时**的）
  const first: AnimDecodeResult<FakeFrame> = await decodeAnim(RETRY_URI, io, cache);
  assert.equal(first.decoded, undefined);
  assert.equal(first.outcome, ANIM_FAILED);
  assert.ok(first.detail.includes('transient-oom#1'), '失败原因必须带上来（真机日志靠它）');
  assert.equal(cache.has(RETRY_URI), false, '瞬时失败**绝不能**写进负缓存 —— 这就是 D3');
  assert.equal(cache.size, 0, '负缓存必须一条都没写');
  assert.equal(io.opens, 1);

  // ── 第二次：同一张 uri、**同一个** cache，平台这次成功
  const second: AnimDecodeResult<FakeFrame> = await decodeAnim(RETRY_URI, io, cache);
  assert.equal(second.outcome, ANIM_READY, '第二次必须仍能装载（重试入口还在）');
  if (second.decoded === undefined) {
    assert.fail(`第二次应当装载成功，实际 outcome=${second.outcome}`);
  }
  const d2: AnimDecoded<FakeFrame> = second.decoded;
  assert.equal(d2.frames.length, 30);
  assert.equal(d2.frameCount, 30);
  assert.equal(d2.srcW, 4000);
  assert.equal(d2.budget, framePixelBudget(30));
  assert.equal(cache.has(RETRY_URI), false, '成功也不写负缓存（肯定结论不能缓存：帧离开卡时就被释放）');
  assert.equal(io.opens, 2, '第二次确实又开了一次文件 —— 这就是"坏文件每次滑回来重试一次"的代价');
  // 每次探测一个 fd：句柄必须被关掉
  assert.equal(io.handles.length, 1);
  assert.equal(io.handles[0].closed, true, '句柄必须在 finally 里被关上');
  // 交出去的帧**不能**被 core 释放（所有权已经转移给调用点）
  for (const f of io.handles[0].decoded) {
    assert.equal(f.released, false, '已交出去的帧不能被 core 的 finally 释放');
  }
});

test('D3：确定性结论**仍然**写负缓存（帧数 ≤ 1 / 超上限），且第二次一次文件都不开', async () => {
  const cache: Map<string, boolean> = new Map();
  const uri: string = 'file://media/Photo/9/static.webp';
  const io: FlakyIo = new FlakyIo(0, 1, '1', 0);   // getFrameCount() = 1 → 静态图

  const a: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(a.outcome, ANIM_STATIC_FEW_FRAMES);
  assert.equal(cache.get(uri), true, '确定性结论必须写缓存，否则每张静态 webp 每次滑回都要读一遍文件头');
  assert.equal(io.opens, 1);

  const b: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(b.outcome, ANIM_CACHED_STATIC);
  assert.equal(io.opens, 1, '命中负缓存时**一次文件都不开** —— 这是缓存存在的全部意义');

  // 帧数超上限（> MAX_ANIM_FRAMES）同样是确定性结论（帧数是文件头里的事实）
  const over: FlakyIo = new FlakyIo(0, MAX_ANIM_FRAMES + 1, '1', 0);
  const c: AnimDecodeResult<FakeFrame> = await decodeAnim('file://media/Photo/9/long.gif', over, cache);
  assert.equal(c.outcome, ANIM_STATIC_FEW_FRAMES);
  assert.equal(cache.get('file://media/Photo/9/long.gif'), true);
  assert.equal(over.handles[0].lastTarget, null, '帧数不合格时不该走到解帧');
});

test('D3：确定性结论**仍然**写负缓存（方向需静态路径摆正），且解帧之前就挡住', async () => {
  const cache: Map<string, boolean> = new Map();
  const uri: string = 'file://media/Photo/9/rot90.gif';
  const io: FlakyIo = new FlakyIo(0, 30, '6', 30);   // orientation 6 = Rotate 90 CW

  const a: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(a.outcome, ANIM_STATIC_ORIENTATION);
  assert.equal(a.detail, '6');
  assert.equal(cache.get(uri), true, '方向是文件里的事实 → 确定性结论 → 写缓存');
  // 方向判定发生在**解帧之前** → 一帧都不该解（这是省内存最直接的一刀）
  assert.equal(io.handles[0].lastTarget, null, '方向不对时不该调 createPixelMapList');
  assert.equal(io.handles[0].closed, true, '句柄仍然必须被关掉');
});

test('D3：createPixelMapList 返回空 = 没探到（内存压力的头号形态）→ 不写负缓存、下次还重试', async () => {
  const cache: Map<string, boolean> = new Map();
  const uri: string = 'file://media/Photo/9/huge.gif';
  // 帧数 30（权威判据通过，说明"它确实是动图"），但一帧都解不出来
  const io: FlakyIo = new FlakyIo(0, 30, '1', 0);

  const a: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(a.outcome, ANIM_EMPTY_FRAMES);
  assert.equal(a.decoded, undefined);
  assert.equal(cache.has(uri), false, '这一支必须**不写**负缓存 —— SDK 明说它"一次解出全部帧"，头号成因是内存压力');
  assert.equal(io.handles[0].closed, true);

  const b: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(b.outcome, ANIM_EMPTY_FRAMES);
  assert.equal(io.opens, 2, '第二次必须仍然开文件重试（用户还有重试入口）');
  assert.equal(cache.size, 0);
});

test('D3：平台给不出句柄 = 没探到 → 不写负缓存（第三个被去掉的写入点）', async () => {
  const cache: Map<string, boolean> = new Map();
  const uri: string = 'file://media/Photo/9/odd.gif';
  const io: NoHandleIo = new NoHandleIo();

  const a: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(a.outcome, ANIM_NO_HANDLE);
  assert.equal(cache.has(uri), false);
  const b: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(b.outcome, ANIM_NO_HANDLE);
  assert.equal(io.opens, 2, '给不出句柄也必须允许下次重试');
  assert.equal(cache.size, 0);
});

test('D3：解出帧**之后**才失败 —— 已解的帧必须被释放（否则每划一张漏一整套帧）', async () => {
  const cache: Map<string, boolean> = new Map();
  const uri: string = 'file://media/Photo/9/late-fail.gif';
  const io: FlakyIo = new FlakyIo(0, 30, '1', 30);
  // 让最后一步（读帧时长）抛：此时帧已经解出来了，所有权还在 core 手上
  io.prepare = (h: FakeHandle) => { h.throwOnDelay = true; };

  const r: AnimDecodeResult<FakeFrame> = await decodeAnim(uri, io, cache);
  assert.equal(r.outcome, ANIM_FAILED);
  assert.equal(cache.has(uri), false, '晚到的失败同样不写负缓存');
  const h: FakeHandle = io.handles[0];
  assert.equal(h.decoded.length, 30);
  for (const f of h.decoded) {
    assert.equal(f.released, true, '没交出去的帧必须由 core 的 finally 释放');
  }
  assert.equal(h.closed, true, '失败路径也必须关句柄（否则每失败一次漏一个 fd）');
});

test('D3：喂给 createPixelMapList 的 desiredSize 就是 frameDecodeSize(framePixelBudget(真实帧数))', async () => {
  const cache: Map<string, boolean> = new Map();
  const io: FlakyIo = new FlakyIo(0, 240, '1', 240);   // 240 = MAX_ANIM_FRAMES，最坏内存档
  io.prepare = (h: FakeHandle) => { h.width = 4000; h.height = 3000; };

  const r: AnimDecodeResult<FakeFrame> = await decodeAnim('file://media/Photo/9/240.gif', io, cache);
  assert.equal(r.outcome, ANIM_READY);
  if (r.decoded === undefined) { assert.fail('应当解帧成功'); }
  const t: FrameSize | null = io.handles[0].lastTarget;
  if (t === null) { assert.fail('必须调用过 createPixelMapList'); }
  // 与 D5 的参数化表是同一条事实的两种表述（这里走的是**整条生产流水线**）
  assert.deepEqual(t, { width: 258, height: 193 });
  assert.deepEqual(t, frameDecodeSize(4000, 3000, framePixelBudget(240)));
  assert.equal(r.decoded.budget, 50000);
  assert.equal(r.decoded.targetW, 258);
  assert.equal(r.decoded.targetH, 193);
});

test('D3：负缓存的判据**只有一个** —— 结局码真值表（未知结局按"没探到"处理）', () => {
  assert.equal(isStaticConclusion(ANIM_STATIC_FEW_FRAMES), true);
  assert.equal(isStaticConclusion(ANIM_STATIC_ORIENTATION), true);
  // 三种"没探到"：一个都不许写
  assert.equal(isStaticConclusion(ANIM_NO_HANDLE), false);
  assert.equal(isStaticConclusion(ANIM_EMPTY_FRAMES), false);
  assert.equal(isStaticConclusion(ANIM_FAILED), false);
  // 成功与"连文件都没开"的两支也不写（缓存对它们没有意义）
  assert.equal(isStaticConclusion(ANIM_READY), false);
  assert.equal(isStaticConclusion(ANIM_NOT_CANDIDATE), false);
  assert.equal(isStaticConclusion(ANIM_CACHED_STATIC), false);
  // 保守方向：认不出来的结局一律当"没探到"（宁可多试一次，也不要永久错误的结论）
  assert.equal(isStaticConclusion('garbage'), false);
});
