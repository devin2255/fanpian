import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, clusterByScreen, MAX_HANG, EXPAND_ALL_MAX, COLLAPSE_THRESHOLD, MIN_PIN_DIST_PT }
  from './placement.ts';
import { projectMercator } from './projection.ts';

const counts = (pairs: [string, number][]): Map<string, number> => {
  const m = new Map<string, number>();
  pairs.forEach(([k, v]) => m.set(k, v));
  return m;
};

test('≤3 个钉：全部展开（张数封顶 9）', () => {
  const pins = [
    { pinId: 'a', x: 0, y: 0 },
    { pinId: 'b', x: 200, y: 0 }
  ];
  const out = computeLayout(pins, counts([['a', 20], ['b', 2]]), 1);
  assert.equal(out.length, 2);
  assert.ok(pins.length <= EXPAND_ALL_MAX);
  assert.equal(out[0].expanded, true);
  assert.ok(out[0].count <= MAX_HANG);
  assert.equal(out[1].expanded, true);
});

test('4–15 个钉：只有张数 ≥3 的展开', () => {
  const pins: { pinId: string; x: number; y: number }[] = [];
  const c: [string, number][] = [];
  for (let i = 0; i < 5; i++) { pins.push({ pinId: `p${i}`, x: i * 200, y: 0 }); c.push([`p${i}`, i]); }
  const out = computeLayout(pins, counts(c), 1);
  // p0=0, p1=1, p2=2 不展开；p3=3, p4=4 展开
  assert.equal(out[0].expanded, false);
  assert.equal(out[1].expanded, false);
  assert.equal(out[2].expanded, false);
  assert.equal(out[3].expanded, true);
  assert.equal(out[4].expanded, true);
});

test('>15 个钉：全部收成钉', () => {
  const pins: { pinId: string; x: number; y: number }[] = [];
  const c: [string, number][] = [];
  for (let i = 0; i < COLLAPSE_THRESHOLD + 1; i++) {
    pins.push({ pinId: `p${i}`, x: i * 300, y: 0 });
    c.push([`p${i}`, 50]);
  }
  const out = computeLayout(pins, counts(c), 1);
  assert.equal(out.every((l) => !l.expanded), true);
});

test('缩放过小：忽略展开态', () => {
  const pins = [{ pinId: 'a', x: 0, y: 0 }];
  const out = computeLayout(pins, counts([['a', 10]]), 0.2);
  assert.equal(out[0].expanded, false);
});

test('clusterByScreen：40pt 内合并', () => {
  const placed = [
    { pinId: 'a', x: 100, y: 100 },
    { pinId: 'b', x: 120, y: 110 },   // 距 a 约 22pt → 合并
    { pinId: 'c', x: 400, y: 400 }    // 远 → 独立
  ];
  const groups = clusterByScreen(placed, MIN_PIN_DIST_PT);
  assert.equal(groups.length, 2);
});

test('projectMercator：bounds 四角映射到画布四角', () => {
  const bounds = [73, 18, 135, 54];   // 中国大致范围
  const tl = projectMercator(73, 54, 1000, 800, bounds);
  const br = projectMercator(135, 18, 1000, 800, bounds);
  assert.ok(Math.abs(tl.x - 0) < 1 && Math.abs(tl.y - 0) < 1);
  assert.ok(Math.abs(br.x - 1000) < 1 && Math.abs(br.y - 800) < 1);
});

test('clusterByScreen：链式相邻会连成一簇（根作 key，非索引作 key）', () => {
  // 三点等距 30pt，minDist=40：0-1 相邻、1-2 相邻、0-2 不相邻 → 单链接应连成一簇
  // 若误用索引作桶 key，会裂成 [[0],[1,2]] —— 此测试必须失败
  const placed = [
    { pinId: 'a', x: 0, y: 0 },
    { pinId: 'b', x: 30, y: 0 },
    { pinId: 'c', x: 60, y: 0 }
  ];
  const groups = clusterByScreen(placed, MIN_PIN_DIST_PT);
  assert.equal(groups.length, 1, '链式相邻的三个点应在同一簇');
  assert.equal(groups[0].length, 3);
  assert.deepEqual(groups[0].slice().sort((x: number, y: number) => x - y), [0, 1, 2]);
});

test('clusterByScreen：真正孤立的点各自成簇', () => {
  const placed = [
    { pinId: 'a', x: 0, y: 0 },
    { pinId: 'b', x: 30, y: 0 },     // 与 a 同簇
    { pinId: 'c', x: 500, y: 500 }   // 孤立
  ];
  const groups = clusterByScreen(placed, MIN_PIN_DIST_PT);
  assert.equal(groups.length, 2);
  // 找出含索引 2 的那一组，必须是单元素
  let solo: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].indexOf(2) >= 0) { solo = groups[i]; }
  }
  assert.deepEqual(solo, [2]);
});

test('clusterByScreen：乱序输入的链式相邻仍连成一簇（根作 key，非索引作 key）', () => {
  // 与上一条同一几何关系，只把输入顺序换成 0,2,1（30pt 点排在 60pt 点之后）。
  // 乱序下并查集的根不再是索引 0：此时若桶 key 误用索引 i，首插写 key=0、后续 get(根)=1，
  // 就会裂成 [[0],[1,2]]。这是唯一能真正钉死"根作 key"这一行代码的输入顺序。
  const placed = [
    { pinId: 'a', x: 0, y: 0 },
    { pinId: 'c', x: 60, y: 0 },
    { pinId: 'b', x: 30, y: 0 }
  ];
  const groups = clusterByScreen(placed, MIN_PIN_DIST_PT);
  assert.equal(groups.length, 1, '乱序输入的链式相邻三个点应在同一簇');
  assert.equal(groups[0].length, 3);
  assert.deepEqual(groups[0].slice().sort((x: number, y: number) => x - y), [0, 1, 2]);
});

test('projectMercator：纬度方向非线性（墨卡托，非 plate-carrée）', () => {
  const bounds = [73, 18, 135, 54];
  const w = 1000;
  const h = 800;
  // 中纬度 36°N 的 y：墨卡托约 447.3；若退化成线性映射则为 400（恰好是画布中线）
  const mid = projectMercator(100, 36, w, h, bounds);
  assert.ok(mid.y > 420 && mid.y < 475, `36°N 的 y 应 ≈447，实际 ${mid.y}`);
  assert.ok(Math.abs(mid.y - h / 2) > 20, '不得等于线性映射的 400');
  // 高纬度被放大：最上 9° 的屏幕跨度应大于最下 9°
  const y54 = projectMercator(100, 54, w, h, bounds).y;
  const y45 = projectMercator(100, 45, w, h, bounds).y;
  const y27 = projectMercator(100, 27, w, h, bounds).y;
  const y18 = projectMercator(100, 18, w, h, bounds).y;
  const topSpan = y45 - y54;
  const botSpan = y18 - y27;
  assert.ok(topSpan > botSpan, `上 9° 跨度(${topSpan.toFixed(1)}) 应大于下 9°(${botSpan.toFixed(1)})`);
});
