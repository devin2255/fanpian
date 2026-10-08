import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, clusterByScreen, MAX_HANG, EXPAND_ALL_MAX, COLLAPSE_THRESHOLD }
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
  const groups = clusterByScreen(placed, 40);
  assert.equal(groups.length, 2);
});

test('projectMercator：bounds 四角映射到画布四角', () => {
  const bounds = [73, 18, 135, 54];   // 中国大致范围
  const tl = projectMercator(73, 54, 1000, 800, bounds);
  const br = projectMercator(135, 18, 1000, 800, bounds);
  assert.ok(Math.abs(tl.x - 0) < 1 && Math.abs(tl.y - 0) < 1);
  assert.ok(Math.abs(br.x - 1000) < 1 && Math.abs(br.y - 800) < 1);
});
