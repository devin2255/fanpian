/**
 * zoom 单测：缩放上下限与 clamp、Contain 显示尺寸、平移边界 clamp。
 *
 * 这三件事直接决定真机手感（能不能放大、放大后能不能拖、拖到头会不会露底色），
 * 而它们在真机上只能靠手试 —— 边界值对不对是**算得出来**的，所以在这里钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScale, isZoomed, containSize, clampOffset, resolveContentSize,
  SCALE_MIN, SCALE_MAX, ZOOM_EPS
} from './zoom.ts';
import type { ZoomSize, PanOffset } from './zoom.ts';

// ── 1. 缩放 clamp ──────────────────────────────────────────────────────────

test('上限是 4×、下限是 1×（本测试把这两个数钉死：改它们必须同时改测试）', () => {
  assert.equal(SCALE_MIN, 1);
  assert.equal(SCALE_MAX, 4);
});

test('clampScale：区间内原样返回（不改动用户捏出来的值）', () => {
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(1.37), 1.37);
  assert.equal(clampScale(2), 2);
  assert.equal(clampScale(4), 4);
  assert.equal(clampScale(SCALE_MIN), SCALE_MIN);
  assert.equal(clampScale(SCALE_MAX), SCALE_MAX);
});

test('clampScale：越界夹到边界（含"缩小"方向 —— 用户没要求缩小，1× 就顶住）', () => {
  assert.equal(clampScale(0), 1);
  assert.equal(clampScale(0.5), 1);
  assert.equal(clampScale(-3), 1);
  assert.equal(clampScale(4.0001), 4);
  assert.equal(clampScale(5), 4);
  assert.equal(clampScale(100), 4);
});

test('clampScale：非有限值一律回到 1×（NaN 会让 .scale() 渲染不可预期，且会污染手势模式判据）', () => {
  assert.equal(clampScale(Number.NaN), 1);
  assert.equal(clampScale(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampScale(Number.NEGATIVE_INFINITY), 1);
});

// ── 2. 「算不算已放大」：它是一指拖动"平移 vs 翻页"的模式开关 ────────────────

test('isZoomed：1× 及浮点误差范围内的值都算没放大（否则翻页会被静默改成平移）', () => {
  assert.equal(isZoomed(1), false);
  assert.equal(isZoomed(1 - ZOOM_EPS), false);
  assert.equal(isZoomed(1 + ZOOM_EPS), false, '边界上按"没放大"处理，宁可让翻页可用');
  assert.equal(isZoomed(1 + ZOOM_EPS / 2), false);
  // 真实场景：捏合回 1× 时连乘出来的 1.0000001
  assert.equal(isZoomed(1.0000001), false);
  assert.equal(isZoomed(0.9999998), false);
});

test('isZoomed：明确放大之后为真', () => {
  assert.equal(isZoomed(1.02), true);
  assert.equal(isZoomed(1.5), true);
  assert.equal(isZoomed(4), true);
});

test('isZoomed：非有限值一律 false（Infinity 不能把翻页永久锁死）', () => {
  assert.equal(isZoomed(Number.NaN), false);
  assert.equal(isZoomed(Number.POSITIVE_INFINITY), false);
  assert.equal(isZoomed(Number.NEGATIVE_INFINITY), false);
});

// ── 3. Contain 显示尺寸 ────────────────────────────────────────────────────

test('containSize：比例与卡片一致时正好铺满（无留边）', () => {
  // 3:4 的照片放进 300×400 的卡片
  assert.deepEqual(containSize(3000, 4000, 300, 400), { width: 300, height: 400 });
});

test('containSize：宽照片宽度顶满、上下留边；高照片高度顶满、左右留边', () => {
  // 16:9 放进 300×400 → 宽顶满
  const wide: ZoomSize = containSize(1920, 1080, 300, 400);
  assert.equal(wide.width, 300);
  assert.ok(Math.abs(wide.height - 300 / (1920 / 1080)) < 1e-9);
  assert.ok(wide.height < 400, '宽照片必然上下留边');
  // 9:16 放进 300×400 → 高顶满
  const tall: ZoomSize = containSize(1080, 1920, 300, 400);
  assert.equal(tall.height, 400);
  assert.ok(Math.abs(tall.width - 400 * (1080 / 1920)) < 1e-9);
  assert.ok(tall.width < 300, '高照片必然左右留边');
});

test('containSize：两条边都绝不超过盒子，且宽高比恒等于原图（多种比例扫一遍）', () => {
  const ratios: number[] = [0.2, 0.5, 0.75, 1, 1.3333, 1.7778, 3, 10];
  for (let i = 0; i < ratios.length; i++) {
    const r: number = ratios[i];
    const s: ZoomSize = containSize(1000 * r, 1000, 300, 400);
    assert.ok(s.width <= 300 + 1e-9, `比例 ${r}: 宽超出盒子`);
    assert.ok(s.height <= 400 + 1e-9, `比例 ${r}: 高超出盒子`);
    assert.ok(Math.abs(s.width / s.height - r) < 1e-9, `比例 ${r}: 宽高比被改坏`);
  }
});

test('containSize：退化输入返回 {0,0}（含义是"算不出显示尺寸"，调用点据此禁用平移）', () => {
  assert.deepEqual(containSize(0, 100, 300, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(100, 0, 300, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(-1, 100, 300, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(100, 100, 0, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(100, 100, 300, 0), { width: 0, height: 0 });
  assert.deepEqual(containSize(100, 100, -300, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(Number.NaN, 100, 300, 400), { width: 0, height: 0 });
  assert.deepEqual(containSize(100, 100, 300, Number.POSITIVE_INFINITY), { width: 0, height: 0 });
});

// ── 4. 平移边界 ────────────────────────────────────────────────────────────

test('clampOffset：1× 时恒为 {0,0}（这是"复位自动清掉平移"和"1× 不可能露底色"的共同保证）', () => {
  assert.deepEqual(clampOffset(999, -999, 300, 168.75, 300, 400, 1), { x: 0, y: 0 });
  assert.deepEqual(clampOffset(50, 50, 300, 400, 300, 400, 1), { x: 0, y: 0 });
});

test('clampOffset：两轴各自独立 —— 只有"放大到超出盒子的那一轴"才有余量', () => {
  // 16:9 显示尺寸 300×168.75 放进 300×400，放大 2× → 宽 600 超出 300（余量 150），高 337.5 仍不超出
  const r: PanOffset = clampOffset(999, 999, 300, 168.75, 300, 400, 2);
  assert.equal(r.x, 150);
  assert.equal(r.y, 0, '高度还没超出盒子 → 纵向不许动，否则会露出上下底色');
});

test('clampOffset：往两侧都夹住，且正好顶在边界上的值原样保留', () => {
  // 300×400 的内容放进 300×400 的盒子、放大 2× → 两轴余量都是 (边×2 − 边)/2 = 边长/2
  assert.deepEqual(clampOffset(-999, -999, 300, 400, 300, 400, 2), { x: -150, y: -200 });
  assert.deepEqual(clampOffset(999, 0, 300, 400, 300, 400, 2), { x: 150, y: 0 });
  assert.deepEqual(clampOffset(150, -200, 300, 400, 300, 400, 2), { x: 150, y: -200 });
  assert.deepEqual(clampOffset(100, 100, 300, 400, 300, 400, 2), { x: 100, y: 100 });
});

test('clampOffset：幂等（连续拖动时反复夹不会漂移）', () => {
  const once: PanOffset = clampOffset(12345, -999, 300, 400, 300, 400, 2.5);
  const twice: PanOffset = clampOffset(once.x, once.y, 300, 400, 300, 400, 2.5);
  assert.deepEqual(twice, once);
});

test('clampOffset：缩放变小时余量随之收缩，回到 1× 自动归零', () => {
  assert.equal(clampOffset(150, 0, 300, 400, 300, 400, 2).x, 150);
  assert.equal(clampOffset(150, 0, 300, 400, 300, 400, 1.5).x, 75);
  assert.equal(clampOffset(150, 0, 300, 400, 300, 400, 1).x, 0);
});

test('clampOffset：scale 非法时按 1× 处理（非有限）或按上限处理（越界），都不产生 NaN 位移', () => {
  assert.deepEqual(clampOffset(100, 100, 300, 400, 300, 400, Number.NaN), { x: 0, y: 0 });
  assert.deepEqual(clampOffset(100, 100, 300, 400, 300, 400, Number.POSITIVE_INFINITY), { x: 0, y: 0 });
  // 传 100 会被夹到 4×：余量 (300*4-300)/2 = 450
  assert.deepEqual(clampOffset(9999, 9999, 300, 400, 300, 400, 100), { x: 450, y: 600 });
});

test('clampOffset：位移非有限值时归零（NaN 一旦进入 offset 会让照片整块消失）', () => {
  assert.deepEqual(clampOffset(Number.NaN, 10, 300, 400, 300, 400, 2), { x: 0, y: 10 });
  assert.deepEqual(clampOffset(10, Number.POSITIVE_INFINITY, 300, 400, 300, 400, 2), { x: 10, y: 0 });
});

test('clampOffset：内容尺寸未知（{0,0}）时禁用平移 —— 不用卡片尺寸顶替（那会把照片推出卡片）', () => {
  assert.deepEqual(clampOffset(999, 999, 0, 0, 300, 400, 4), { x: 0, y: 0 });
  assert.deepEqual(clampOffset(999, 999, Number.NaN, 100, 300, 400, 4), { x: 0, y: 0 });
});

test('clampOffset 与 containSize / clampScale 串起来：4× 场景下的真实余量', () => {
  // 竖幅 3:4 照片（1080×1440）放进 300×400 卡片：显示尺寸正好 300×400
  const c: ZoomSize = containSize(1080, 1440, 300, 400);
  assert.deepEqual(c, { width: 300, height: 400 });
  const at4: PanOffset = clampOffset(99999, 99999, c.width, c.height, 300, 400, clampScale(9));
  assert.deepEqual(at4, { x: 450, y: 600 });
});

// ── 5. 实际绘制尺寸的三级判定链 ─────────────────────────────────────────────

test('resolveContentSize：框架报的绘制尺寸可用时优先用它（连旋转/取整都算好了，最忠实）', () => {
  // 16:9 照片放进 300×400：绘制内容 300×168.75 —— 装得进盒子 → 直接采用
  assert.deepEqual(resolveContentSize(300, 168.75, 1920, 1080, 300, 400), { width: 300, height: 168.75 });
  // 正好铺满（相等）也必须被采用：浮点相等不该被容差判成越界
  assert.deepEqual(resolveContentSize(300, 400, 300, 400, 300, 400), { width: 300, height: 400 });
});

test('resolveContentSize：绘制尺寸"装不进盒子"时必须弃用（这是单位不是 vp 的唯一可检测信号）', () => {
  // 同一个 16:9 照片，若平台回传的是 px（3x 屏 → 900×506.25），量纲验证必须挡住它，
  // 否则平移余量会大出 3 倍 → 一拖就把照片推出卡片露出底色。
  const r: ZoomSize = resolveContentSize(900, 506.25, 1920, 1080, 300, 400);
  const fallback: ZoomSize = containSize(1920, 1080, 300, 400);
  assert.deepEqual(r, fallback);
  assert.ok(r.width <= 300 + 1e-9 && r.height <= 400 + 1e-9);
});

test('resolveContentSize：绘制尺寸缺失（动图不触发 onComplete）→ 退回按固有尺寸算 Contain', () => {
  const src: ZoomSize = containSize(1080, 1920, 300, 400);
  assert.deepEqual(resolveContentSize(0, 0, 1080, 1920, 300, 400), src);
  assert.deepEqual(resolveContentSize(-1, 50, 1080, 1920, 300, 400), src);
  assert.deepEqual(resolveContentSize(Number.NaN, 50, 1080, 1920, 300, 400), src);
});

test('resolveContentSize：盒子未知时不能用绘制尺寸（判不出量纲）→ 继续退回固有尺寸（盒子未知则整体算不出）', () => {
  assert.deepEqual(resolveContentSize(300, 168.75, 1920, 1080, 0, 0), { width: 0, height: 0 });
});

test('resolveContentSize：两条信息都没有 → {0,0}（调用点据此禁用平移，绝不猜）', () => {
  assert.deepEqual(resolveContentSize(0, 0, 0, 0, 300, 400), { width: 0, height: 0 });
  assert.deepEqual(resolveContentSize(Number.POSITIVE_INFINITY, 10, Number.NaN, 10, 300, 400), { width: 0, height: 0 });
});

test('resolveContentSize 的结果可以直接喂给 clampOffset（4× 时两轴余量都算得出来）', () => {
  // 16:9 照片（1920×1080）在 300×400 卡片里的绘制内容是 300×168.75
  const c: ZoomSize = resolveContentSize(300, 168.75, 1920, 1080, 300, 400);
  const o: PanOffset = clampOffset(9999, 9999, c.width, c.height, 300, 400, 4);
  assert.equal(o.x, 450);      // 宽：(300×4 − 300)/2
  assert.equal(o.y, 137.5);    // 高：(168.75×4 − 400)/2 —— 放大 4× 之后纵向也终于能拖了
});
