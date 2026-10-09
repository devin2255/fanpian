import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate, wallConversion }
  from './metrics.ts';

const ev = (decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action: 'fav', rolledBack });

// 需要显式指定 action 的用例用它：'none' = 回弹、'wall' = 点卡片上的「上墙」按钮。
const evAct = (action: string, decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action, rolledBack });

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

test('回弹率 = 回弹数 / 滑动尝试数', () => {
  let m = emptyMetrics();
  // 4 个事件全是滑动尝试（action 均为 'fav'）、没有 wall，
  // 所以「排除 wall」的新口径不影响这个断言的期望值（仍是 1/4）。
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

test('回弹率：空状态返回 0，不除零', () => {
  assert.equal(rollbackRate(emptyMetrics()), 0);
});

test('脏数据被丢弃后，状态仍可继续使用', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(500, 1000));   // 脏：decidedAt < shownAt → 丢弃
  assert.equal(m.events.length, 0);
  m = recordSwipe(m, ev(1000, 0));     // 合法
  assert.equal(m.events.length, 1, '丢弃脏数据后仍应能接受新样本');
  assert.equal(medianDecisionMs(m), 1000);
});

// ── 「上墙」事件必须被排除出滑动口径（spec §5.3 的指标是「误操作率」）──────────
// 上墙 = 在卡片上点一下按钮，不是一次滑动尝试；若算进分母，指标会随上墙用得越多
// 而越虚低（越常上墙越显得「回弹率 < 3%」达标，属自证清白型失真）。

test('回弹率的分母排除「上墙」事件（点按钮不是滑动尝试）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('none', 1000, 0, true));    // 1 次回弹（回弹事件的 action 是 'none'）
  m = recordSwipe(m, ev(1000, 0));                     // 1 次右滑收藏
  m = recordSwipe(m, evAct('wall', 1000, 0));          // 2 次点「上墙」
  m = recordSwipe(m, evAct('wall', 1000, 0));
  // 1 回弹 / (1 回弹 + 1 滑动) = 0.5；含 wall 的老口径会算成 1/4 = 0.25
  assert.ok(Math.abs(rollbackRate(m) - 0.5) < 1e-9);
});

test('回弹率：全部事件都是「上墙」时返回 0（分母为 0，不除零）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('wall', 1000, 0));
  m = recordSwipe(m, evAct('wall', 2000, 0));
  assert.equal(rollbackRate(m), 0);
});

test('中位决策耗时排除「上墙」事件（按钮决策与滑动决策不同质）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));                     // 滑动 1000ms
  m = recordSwipe(m, ev(2000, 0));                     // 滑动 2000ms
  m = recordSwipe(m, evAct('wall', 999999, 0));        // 上墙：照片刚出现就点，耗时极大也不得污染中位数
  // 排除 wall 后样本 = [1000, 2000] → 1500；含 wall 的老口径会变成 2000
  assert.equal(medianDecisionMs(m), 1500);
});

test('中位决策耗时：只有「上墙」事件时返回 0，不除零', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('wall', 1000, 0));
  assert.equal(medianDecisionMs(m), 0);
});
