import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate, wallConversion }
  from './metrics.ts';

const ev = (decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action: 'fav', rolledBack });

test('空状态中位数为 0', () => {
  assert.equal(medianDecisionMs(emptyMetrics()), 0);
});

test('决策间隔中位数取中间值', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));    // 1000
  m = recordSwipe(m, ev(2200, 0));    // 2200
  m = recordSwipe(m, ev(1500, 0));    // 1500
  assert.equal(medianDecisionMs(m), 1500);
});

test('偶数个取中间两个的平均', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));
  m = recordSwipe(m, ev(2000, 0));
  assert.equal(medianDecisionMs(m), 1500);
});

test('回弹率 = 回弹数 / 总数', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0, true));
  m = recordSwipe(m, ev(1000, 0, false));
  m = recordSwipe(m, ev(1000, 0, false));
  m = recordSwipe(m, ev(1000, 0, false));
  assert.ok(Math.abs(rollbackRate(m) - 0.25) < 1e-9);
});

test('上墙转化率', () => {
  assert.ok(Math.abs(wallConversion(100, 20) - 0.2) < 1e-9);
});

test('收藏为 0 时转化率为 0，不除零', () => {
  assert.equal(wallConversion(0, 0), 0);
});

test('shownAt 晚于 decidedAt 时忽略该样本', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(500, 1000));
  assert.equal(m.events.length, 0);
});
