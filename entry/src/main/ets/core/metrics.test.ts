import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate, wallConversion,
  // Task 22 追加
  MAX_METRIC_EVENTS, METRIC_EVICT_SLACK, capEvents, decodeEvents,
  medianSampleSize, rollbackDenominator, rollbackCount,
  meetsMedianTarget, meetsRollbackTarget, meetsConversionTarget,
  verdictText, computeStats
} from './metrics.ts';

const ev = (decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action: 'fav', rolledBack });

// 需要显式指定 action 的用例用它：'none' = 回弹、'wall' = 点卡片上的「上墙」按钮。
const evAct = (action: string, decidedAt: number, shownAt: number, rolledBack = false) =>
  ({ photoId: 'p', shownAt, decidedAt, action, rolledBack });

// batch-39 的用例用它：**尝试组 = 同一张照片的同一次出现**（`photoId` + `shownAt`），
// 所以这四条必须都能显式指定。ev/evAct 把两者写死成 'p' / 0，只够表达"单张单次"。
const evFull = (photoId: string, shownAt: number, decidedAt: number, action: string, rolledBack = false) =>
  ({ photoId, shownAt, decidedAt, action, rolledBack });

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
  // 且 4 条**互不相同**（默认 ev() 的 photoId 恒为 'p'、shownAt 恒为 0 —— 见下方
  // batch-39 用例：那 4 条会被算成同一个尝试组。本用例只关心 1/4 这个比值，
  // 所以逐条给出不同的 shownAt，让它们各自成为一个组。）
  m = recordSwipe(m, ev(1000, 0, true));
  m = recordSwipe(m, ev(1000, 10, false));
  m = recordSwipe(m, ev(1000, 20, false));
  m = recordSwipe(m, ev(1000, 30, false));
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

// ══════════════════════════════════════════════════════════════════════════════
// batch-39：回弹率改为「按每张照片的滑动尝试」算（用户裁决，逐字：
//   「改口径：按"每张照片的滑动尝试"算」）
//
// 单位 = **尝试组** = 一张照片的一次出现（`photoId` + `shownAt`）。两条要求：
//   · 分母 = 每次真正的尝试（**含 wall**，也含同一张卡的重试）；
//   · 同一张卡的连续重试**算一次**（「用户对这张照片的意图是一次，手滑不是第二次意图」）。
// 旧口径的两条前提都被真机数据（51 条事件）推翻：既不该"按事件数"（重试给分母 +1），
// 也不该"排除 wall"（wall 占 53%，排除它 = 分母缩水、分子照算 → 率虚高近 2 倍）。
// ══════════════════════════════════════════════════════════════════════════════

test('batch-39：同卡 wall + none(回弹) + wall 三条事件 → 分母只算 1、分子 1', () => {
  // 这正是真机上 IMG_20261003_184352.jpg 的形态（wall + 回弹 + wall）。
  // 三条共享同一个 shownAt：上墙的事件在 handle() 里同刻记下、推进却在异步的 applyWall() 里，
  // 而回弹在 handle() 里早退不换卡 —— 依据见 core/metrics.ts 的 rollbackRate 注释。
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 5300, 'wall'));
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 6100, 'none', true));   // 第一次没滑够 → 弹回
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 6900, 'wall'));         // 再滑一次成功
  assert.equal(m.events.length, 3, '三条事件都要留在历史里（口径变的是统计单位，不是记录）');
  assert.equal(rollbackDenominator(m), 1, '分母 = 1 个尝试组（旧口径会算成 3）');
  assert.equal(rollbackCount(m), 1, '分子 = 1：这一组手滑过');
  assert.ok(Math.abs(rollbackRate(m) - 1) < 1e-9, '1/1 = 100% —— 这一次意图确实手滑了');
  // 再补一张"只上墙、没回弹"的对照卡：只有它能把这三种口径区分开 ——
  //   新口径（尝试组）→ 2 组、1 组手滑 → 50%；
  //   旧口径（事件数、排除 wall）→ 分母只剩那条 'none' → 1/1 = 100%。
  // 少了这张对照卡，"wall + none + wall"单独一组的读数在两种口径下**恰好都是 1/1**，
  // 这条用例就会对旧口径免疫 —— 变异测试里它会活下来（实测过）。
  m = recordSwipe(m, evFull('IMG_B.jpg', 9000, 9500, 'wall'));
  assert.equal(rollbackDenominator(m), 2, '对照卡是第 2 个尝试组（旧口径在这里仍是 1）');
  assert.equal(rollbackCount(m), 1);
  assert.ok(Math.abs(rollbackRate(m) - 0.5) < 1e-9, '旧口径会算成 1/1 = 100%');
});

test('batch-39：同一组内回弹两次也只算一个分子（组内去重）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 5300, 'none', true));
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 6100, 'none', true));
  m = recordSwipe(m, evFull('IMG_A.jpg', 5000, 6900, 'wall'));
  assert.equal(rollbackDenominator(m), 1);
  assert.equal(rollbackCount(m), 1, '用户的手滑只发生在**一个**意图上，不该算成 2');
  assert.ok(Math.abs(rollbackRate(m) - 1) < 1e-9);
});

test('batch-39：纯 wall 序列（无回弹）→ 分子 0', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 300, 'wall'));   // 三张不同的照片 = 三个尝试组
  m = recordSwipe(m, evFull('B.jpg', 200, 400, 'wall'));
  m = recordSwipe(m, evFull('C.jpg', 300, 500, 'wall'));
  assert.equal(rollbackDenominator(m), 3, 'wall 计入分母');
  assert.equal(rollbackCount(m), 0, '没有回弹 → 分子 0');
  assert.equal(rollbackRate(m), 0);
});

test('batch-39：全部是「上墙」→ **有样本**、回弹率 0%（不再判成"不可判定"）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 300, 'wall'));
  m = recordSwipe(m, evFull('B.jpg', 200, 400, 'wall'));
  assert.equal(rollbackDenominator(m), 2, '旧口径在这里得到 0（分母为 0 → 不可判定）');
  assert.equal(rollbackCount(m), 0);
  assert.equal(rollbackRate(m), 0);
  const s = computeStats(m, 0, 2, 0);
  assert.equal(s.rollbackVerdict.hasSample, true, '有样本 —— 旧口径下不可能出现的判定');
  assert.equal(s.rollbackVerdict.met, true, '有样本且 0% < 3% → 真的达标');
  assert.equal(verdictText(s.rollbackVerdict), '达标');
  // 但**中位数**仍不可判定：wall 依旧不进它的样本 —— 两条指标的口径在 batch-39 分家了
  assert.equal(s.medianSample, 0);
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(verdictText(s.medianVerdict), '还没有数据');
});

test('batch-39：同一张照片在不同时间被独立刷两次（shownAt 相距很远）→ 分母算 2 次', () => {
  // 本批定义的边界：尝试组 = 同一次**出现**。shownAt 只在换卡时刷新
  //（SwipePage.goTo 末尾），所以"两次出现"必然是两个 shownAt = 两次真实意图，
  // **不**折叠 —— 折叠它们是"按照片张数算"，那是另一个指标。
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('IMG_X.jpg', 1000, 1500, 'fav'));              // 第一次出现：收藏
  m = recordSwipe(m, evFull('IMG_X.jpg', 600000, 600400, 'none', true));   // 十分钟后又被刷到：手滑
  assert.equal(rollbackDenominator(m), 2, '两次出现 = 2 次尝试（不是 1 次，也不是 3 次）');
  assert.equal(rollbackCount(m), 1);
  assert.ok(Math.abs(rollbackRate(m) - 0.5) < 1e-9);
  // 对照：两条共享同一个 shownAt（= 同一次出现里的重试）→ 分母只有 1
  let m2 = emptyMetrics();
  m2 = recordSwipe(m2, evFull('IMG_X.jpg', 1000, 1500, 'fav'));
  m2 = recordSwipe(m2, evFull('IMG_X.jpg', 1000, 1900, 'none', true));
  assert.equal(rollbackDenominator(m2), 1, '同一 shownAt = 同一次出现 = 1 次意图');
  assert.ok(Math.abs(rollbackRate(m2) - 1) < 1e-9);
});

test('batch-39：重复上报同一事件不放大分母（旧口径下每条重复都给分母 +1）', () => {
  // CardStack 的防抖挡的是"同一次回弹重复上报"，但按钮同帧被点两次等路径仍可能重复上报
  //（SwipePage.handle 的 recordSwipe 在去重守卫**之前**）。分组对重复上报天然幂等。
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 300, 'wall'));
  m = recordSwipe(m, evFull('A.jpg', 100, 300, 'wall'));   // 同一次出现、同一动作，重复上报
  assert.equal(m.events.length, 2);
  assert.equal(rollbackDenominator(m), 1, '同一个键 add 两次，组数不变');
  assert.equal(rollbackRate(m), 0);
});

// ── 真机数据 fixture（本轮最有价值的用例）─────────────────────────────────────
// 51 条事件，控制器已核：wall 27 / fav 17 / none(回弹) 4 / archive 3。
// 其中 3 张有连续重试（用户要给这张上墙 → 第一次没滑够弹回 → 再滑一次成功）：
//   IMG_20261003_184352.jpg ×3 = wall + none + wall
//   IMG_20261003_134612.jpg ×2 = none + wall
//   IMG_20261005_143005.jpg ×2 = none + wall
// 旧口径：分母 = 51 - 27 = 24 → 4/24 = 16.67%；
// 新口径：47 个尝试组 → 4/47 ≈ 8.51%。

/** 真机 51 条事件（同一张重试的三/两条共享同一个 shownAt = 同一次出现） */
const deviceEvents = () => {
  const out = [];
  // 3 张有重试的照片（7 条事件 → 3 个尝试组）
  out.push(evFull('IMG_20261003_184352.jpg', 1000, 1300, 'wall'));
  out.push(evFull('IMG_20261003_184352.jpg', 1000, 2100, 'none', true));
  out.push(evFull('IMG_20261003_184352.jpg', 1000, 2900, 'wall'));
  out.push(evFull('IMG_20261003_134612.jpg', 2000, 2400, 'none', true));
  out.push(evFull('IMG_20261003_134612.jpg', 2000, 3100, 'wall'));
  out.push(evFull('IMG_20261005_143005.jpg', 3000, 3300, 'none', true));
  out.push(evFull('IMG_20261005_143005.jpg', 3000, 4000, 'wall'));
  // 其余 44 条：每张一次出现（23 条 wall + 17 条 fav + 1 条 none + 3 条 archive）
  for (let i = 0; i < 23; i++) { out.push(evFull(`w${i}.jpg`, 10000 + i * 100, 10500 + i * 100, 'wall')); }
  for (let i = 0; i < 17; i++) { out.push(evFull(`f${i}.jpg`, 20000 + i * 100, 20500 + i * 100, 'fav')); }
  out.push(evFull('n0.jpg', 30000, 30600, 'none', true));   // 第 4 次回弹：独立发生，后面没有再试
  for (let i = 0; i < 3; i++) { out.push(evFull(`a${i}.jpg`, 40000 + i * 100, 40500 + i * 100, 'archive')); }
  return out;
};

test('真机 fixture：51 条事件 → 分母 47 / 分子 4 → 8.51%（旧口径 16.67%）', () => {
  const evs = deviceEvents();
  const m = { events: evs };
  // 先钉住 fixture 本身与真机一致（否则下面的换算没有意义）
  assert.equal(evs.length, 51, '51 条事件');
  let wallN = 0, favN = 0, noneN = 0, archiveN = 0, rbN = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.action === 'wall') { wallN++; }
    if (e.action === 'fav') { favN++; }
    if (e.action === 'none') { noneN++; }
    if (e.action === 'archive') { archiveN++; }
    if (e.rolledBack) { rbN++; }
  }
  assert.equal(wallN, 27, 'wall 27');
  assert.equal(favN, 17, 'fav 17');
  assert.equal(noneN, 4, 'none(回弹) 4');
  assert.equal(archiveN, 3, 'archive 3');
  assert.equal(rbN, 4, '回弹事件 4 条');

  // 旧口径（本批要消灭的那个）：分母排除 wall、按**事件**数 → 4/24 = 16.67%
  const oldDen = evs.length - wallN;
  assert.equal(oldDen, 24, '旧分母 = 51 - 27 = 24');
  assert.ok(Math.abs(rbN / oldDen - 0.16666666666666666) < 1e-9, '旧读数 = 16.67%');

  // 新口径：47 个尝试组，其中 4 组手滑过
  assert.equal(rollbackDenominator(m), 47, '分母 = 47 个尝试组');
  assert.equal(rollbackCount(m), 4, '分子 = 4 组（3 张重试 + 1 次独立回弹）');
  const rate = rollbackRate(m);
  assert.ok(Math.abs(rate - 4 / 47) < 1e-9, '4/47 ≈ 8.51%');
  // 8.51% 仍然 > 3% → 未达标（本批只是修正读数，没有把失败改成通过）
  assert.equal(meetsRollbackTarget(rate), false, '8.5% 仍高于 3% → 未达标');
  assert.ok(rate < rbN / oldDen, '新读数必须**低于**旧读数（旧口径是虚高）');
  // 判定层
  const s = computeStats(m, 55, 33, 0);
  assert.equal(s.rollbackSample, 47);
  assert.equal(s.rollbackCount, 4);
  assert.equal(s.rollbackVerdict.hasSample, true);
  assert.equal(verdictText(s.rollbackVerdict), '未达标');
  // 口径变更**不牵连**中位数与转化率：中位数样本仍是 51 - 27 = 24 条事件
  assert.equal(s.medianSample, 24, '中位数仍按事件计、仍排除 wall（口径不许动）');
  assert.ok(Math.abs(s.conversion - 0.6) < 1e-9, '转化率 33/55 = 60% 不受影响');
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

// ══════════════════════════════════════════════════════════════════════════════
// Task 22：落盘容量淘汰 / 样本量 / 达标判定（含边界值） / 「空 ≠ 达标」
// ══════════════════════════════════════════════════════════════════════════════

/** 造 n 条事件，photoId = p0..p{n-1}，decidedAt = 0..n-1（升序 = 位置序 = 时间序），shownAt 恒 0 */
const seq = (n: number, action = 'fav', rolledBack = false) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ photoId: `p${i}`, shownAt: 0, decidedAt: i, action, rolledBack });
  }
  return out;
};

// ── 容量淘汰：给定 N 条 → 淘汰后剩多少、淘汰的是哪些 ──────────────────────────

test('capEvents：未超上限时原样返回（同一个数组引用、dropped 为 0）', () => {
  const evs = seq(10);
  const cap = capEvents(evs);
  assert.equal(cap.dropped, 0);
  assert.equal(cap.events.length, 10);
  // 必须是**同一个引用**：热路径上每次刷卡都会调它，未超上限时不许有拷贝
  assert.equal(cap.events, evs);
});

test('capEvents：恰好等于上限不淘汰', () => {
  const cap = capEvents(seq(MAX_METRIC_EVENTS));
  assert.equal(cap.dropped, 0);
  assert.equal(cap.events.length, MAX_METRIC_EVENTS);
});

test('capEvents：超上限 1 条时一次性淘汰到低水位（MAX - SLACK）', () => {
  const cap = capEvents(seq(MAX_METRIC_EVENTS + 1));
  const keep = MAX_METRIC_EVENTS - METRIC_EVICT_SLACK;
  assert.equal(cap.events.length, keep);
  assert.equal(cap.dropped, MAX_METRIC_EVENTS + 1 - keep);
  // 硬性上限无论如何都不能被突破
  assert.ok(cap.events.length <= MAX_METRIC_EVENTS);
});

test('capEvents：淘汰的是 decidedAt 最旧的那些（保留最新的 keep 条）', () => {
  const cap = capEvents(seq(MAX_METRIC_EVENTS + 1));   // decidedAt = 0..2000
  const keep = MAX_METRIC_EVENTS - METRIC_EVICT_SLACK;
  const oldestKept = MAX_METRIC_EVENTS + 1 - keep;      // 被淘汰掉的条数
  assert.equal(cap.events[0].decidedAt, oldestKept, '第一条保留的应是第 dropped 条');
  assert.equal(cap.events[cap.events.length - 1].decidedAt, MAX_METRIC_EVENTS);
  // 被淘汰的那些一条都不许还在
  for (let i = 0; i < cap.events.length; i++) {
    assert.ok(cap.events[i].decidedAt >= oldestKept, `decidedAt=${cap.events[i].decidedAt} 应已被淘汰`);
  }
  // 剩下的 photoId 互不重复、数量正确（没有重复保留）
  const ids = new Set(cap.events.map((e) => e.photoId));
  assert.equal(ids.size, keep);
});

test('capEvents：保留原有顺序（文件仍是一条可读的时间线）', () => {
  // 刻意乱序：位置序 ≠ 时间序
  const evs = seq(MAX_METRIC_EVENTS + 1).reverse();
  const cap = capEvents(evs);
  for (let i = 1; i < cap.events.length; i++) {
    // 原数组是降序的，所以保留段仍应是降序
    assert.ok(cap.events[i - 1].decidedAt > cap.events[i].decidedAt, '顺序不应被重排');
  }
});

test('capEvents：decidedAt 并列时按原位置淘汰（淘汰结果完全确定）', () => {
  const n = MAX_METRIC_EVENTS + 1;
  const evs = [];
  for (let i = 0; i < n; i++) {
    // 全部同一毫秒：此时"最旧的"只能由位置定义（位置靠前的先淘汰）
    evs.push({ photoId: `p${i}`, shownAt: 0, decidedAt: 7, action: 'fav', rolledBack: false });
  }
  const cap = capEvents(evs);
  const keep = MAX_METRIC_EVENTS - METRIC_EVICT_SLACK;
  const dropCount = n - keep;
  assert.equal(cap.dropped, dropCount);
  assert.equal(cap.events.length, keep);
  assert.equal(cap.events[0].photoId, `p${dropCount}`, '并列时应淘汰位置靠前的那些');
});

test('capEvents：淘汰后滚动窗口仍能算指标（口径不被破坏）', () => {
  const evs = seq(MAX_METRIC_EVENTS + 1);   // 全 'fav'、rolledBack=false、decidedAt-shownAt = i
  const cap = capEvents(evs);
  const m = { events: cap.events };
  assert.equal(rollbackRate(m), 0);
  // 窗口内 decidedAt 连续：[dropped, MAX]（shownAt 恒 0，所以间隔 = decidedAt）；
  // 条数是偶数 → 中位数取中间两个的平均（首尾均值）
  const firstKept = cap.dropped;
  assert.equal(m.events.length, MAX_METRIC_EVENTS - METRIC_EVICT_SLACK);
  assert.equal(medianDecisionMs(m), (firstKept + MAX_METRIC_EVENTS) / 2);
});

// ── 读侧解码：坏条目必须被丢掉（宁可少样本，也不猜一个偏向达标的默认值）────────

test('decodeEvents：合法条目全部保留', () => {
  const d = decodeEvents(seq(3));
  assert.equal(d.skipped, 0);
  assert.equal(d.events.length, 3);
});

test('decodeEvents：未知 action 整条丢掉（读侧与 SwipePage 那道守卫同源）', () => {
  const raw = [
    { photoId: 'a', shownAt: 0, decidedAt: 100, action: 'fav', rolledBack: false },
    { photoId: 'b', shownAt: 0, decidedAt: 100, action: 'unknown', rolledBack: false },
    { photoId: 'c', shownAt: 0, decidedAt: 100, action: '', rolledBack: false }
  ];
  const d = decodeEvents(raw);
  assert.equal(d.skipped, 2);
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].photoId, 'a');
});

test('decodeEvents：rolledBack 非布尔 → 整条丢掉，不猜 false（不制造偏向达标的读数）', () => {
  const raw = [
    { photoId: 'a', shownAt: 0, decidedAt: 100, action: 'none', rolledBack: undefined },
    { photoId: 'b', shownAt: 0, decidedAt: 100, action: 'none', rolledBack: 'true' },
    { photoId: 'c', shownAt: 0, decidedAt: 100, action: 'fav', rolledBack: true }
  ];
  const d = decodeEvents(raw);
  assert.equal(d.skipped, 2, '缺字段与非布尔的都要丢');
  assert.equal(d.events.length, 1);
  // 若把前两条当成 rolledBack=false，回弹率会从 1/1 变成 1/3 —— 恰好是"看起来更好"
  assert.equal(rollbackDenominator({ events: d.events }), 1);
  assert.equal(rollbackRate({ events: d.events }), 1);
});

test('decodeEvents：null / 空 photoId / 非有限数 / decidedAt<shownAt 全部丢掉', () => {
  const raw = [
    null,
    { photoId: '', shownAt: 0, decidedAt: 100, action: 'fav', rolledBack: false },
    { photoId: 'a', shownAt: NaN, decidedAt: 100, action: 'fav', rolledBack: false },
    { photoId: 'b', shownAt: 0, decidedAt: Infinity, action: 'fav', rolledBack: false },
    { photoId: 'c', shownAt: 0, decidedAt: '100', action: 'fav', rolledBack: false },
    { photoId: 'd', shownAt: 500, decidedAt: 100, action: 'fav', rolledBack: false },
    { photoId: 'e', shownAt: 0, decidedAt: 100, action: 'fav', rolledBack: false }
  ];
  const d = decodeEvents(raw);
  assert.equal(d.events.length, 1);
  assert.equal(d.skipped, 6);
  assert.equal(d.events[0].photoId, 'e');
});

test('decodeEvents：全部非法 → 0 条事件（坏文件读成"还没有数据"，而不是伪造样本）', () => {
  const d = decodeEvents([null, { photoId: 1 }, { }]);
  assert.equal(d.events.length, 0);
  assert.equal(d.skipped, 3);
});

// ── 样本量：与口径同源 ────────────────────────────────────────────────────────

test('样本量：空集合三个计数都是 0', () => {
  const m = emptyMetrics();
  assert.equal(medianSampleSize(m), 0);
  assert.equal(rollbackDenominator(m), 0);
  assert.equal(rollbackCount(m), 0);
});

test('样本量：单条滑动决策 → 1 / 1 / 0', () => {
  const m = recordSwipe(emptyMetrics(), ev(1000, 0));
  assert.equal(medianSampleSize(m), 1);
  assert.equal(rollbackDenominator(m), 1);
  assert.equal(rollbackCount(m), 0);
});

test('样本量：全是「上墙」→ 中位数样本 0，但回弹率**有**分母（batch-39 口径分家）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 1000, 'wall'));
  m = recordSwipe(m, evFull('B.jpg', 200, 2000, 'wall'));
  assert.equal(m.events.length, 2, '事件本身是记下来的');
  assert.equal(medianSampleSize(m), 0, 'wall 不进中位数样本（口径未变）');
  assert.equal(rollbackDenominator(m), 2, 'wall **进**回弹率分母（batch-39 反转）');
  assert.equal(rollbackCount(m), 0);
  // 两个口径函数各自与自己的一致：中位数返回 0（无样本）、回弹率返回 0（有样本、0 回弹）
  assert.equal(medianDecisionMs(m), 0);
  assert.equal(rollbackRate(m), 0);
});

test('样本量：混合事件时精确计数（中位数排除 wall、回弹率含 wall 且按组去重）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('p1', 0, 1000, 'fav'));                  // 组1
  m = recordSwipe(m, evFull('p2', 0, 1000, 'archive'));              // 组2
  m = recordSwipe(m, evFull('p3', 0, 1000, 'none', true));           // 组3（回弹）
  m = recordSwipe(m, evFull('p3', 0, 1200, 'none', true));           // 组3 的第二次回弹
  m = recordSwipe(m, evFull('p4', 0, 1000, 'wall'));                 // 组4（含 wall）
  assert.equal(m.events.length, 5);
  assert.equal(medianSampleSize(m), 4, '中位数：5 - 1 条 wall = 4 个样本');
  assert.equal(rollbackDenominator(m), 4, '回弹率：5 条事件 → 4 个尝试组（含 wall 那组）');
  assert.equal(rollbackCount(m), 1, '只有组3 手滑过（它回弹了两次，仍算 1）');
  assert.ok(Math.abs(rollbackRate(m) - 0.25) < 1e-9);
  // 中位数样本 = [1000,1000,1000,1200] → 中间两个的平均
  assert.equal(medianDecisionMs(m), 1000);
});

// ── 达标判定的边界值（1200 / 3% / 15%；转化率**只有下限**，无上界）─────────────

test('边界：恰好 1200ms 不达标（spec 是「< 1200 ms」）', () => {
  assert.equal(meetsMedianTarget(1199), true);
  assert.equal(meetsMedianTarget(1200), false, '恰好 1200 属于"没有满足小于 1200"');
  assert.equal(meetsMedianTarget(1201), false);
});

test('边界：恰好 3% 不达标（spec 是「< 3%」）', () => {
  assert.equal(meetsRollbackTarget(0.0299), true);
  // 3/100 与字面量 0.03 在 IEEE754 下是同一个双精度数，所以这里的相等是精确的
  assert.equal(3 / 100, 0.03);
  assert.equal(meetsRollbackTarget(3 / 100), false, '恰好 3% 属于"没有满足小于 3%"');
  assert.equal(meetsRollbackTarget(0.0301), false);
});

// ── 转化率的边界（**产品裁决：只有下限，无上界**）──────────────────────────────
// 旧口径是 spec §5.3 的闭区间 15%~30%；设备真值 60% 超出上界被判"未达标"，
// 于是裁决去掉上界、只要求 ≥ 15%。以下 6 条把新口径的每一侧都钉死。
// 注意：谓词（meetsConversionTarget）与判定（computeStats 的 conversionVerdict）
// 是两层，两条都要钉 —— 谓词管"数值够不够"，判定还额外管"有没有样本"。

test('边界：恰好 15% 达标（下限是闭的）', () => {
  // 15/100 与字面量 0.15 在 IEEE754 下是同一个双精度数，所以这里的相等是精确的
  assert.equal(15 / 100, 0.15);
  assert.equal(meetsConversionTarget(15 / 100), true, '恰好 15% 落在下限上 → 达标（闭下限）');
  assert.equal(meetsConversionTarget(0.1501), true);
  assert.equal(meetsConversionTarget(0.2), true, '20%（原区间中段）新旧口径都达标');
});

test('边界：14.9% 不达标（下限之下）', () => {
  assert.equal(meetsConversionTarget(0.1499), false, '14.99% 差一点点也算不达标');
  assert.equal(meetsConversionTarget(14.9 / 100), false, '14.9% → 不达标');
  assert.equal(meetsConversionTarget(0), false, '0% 更在下限之下');
});

test('边界：30% 仍达标 —— 但**理由变了**：不再是"含在区间里"，而是"高于下限"', () => {
  // 本用例是"改判据不改结论"的那一条：30% 在旧口径下达标是因为它等于上界（含端点），
  // 在新口径下达标是因为**任何 ≥ 15% 的值都达标**、上界已不存在。意图写在断言消息里。
  assert.equal(30 / 100, 0.30);
  assert.equal(meetsConversionTarget(30 / 100), true, '30% ≥ 15% → 达标（不是因为"含端点"）');
  // 旧口径里 > 30% 判未达标；新口径下"高于上界"这个概念已经不存在，故 30.01% 也达标
  assert.equal(meetsConversionTarget(0.3001), true, '旧口径下它"高于上限"→未达标；上界取消后无此判据');
});

test('边界：60% 达标 —— **设备真值**（walled 33 / 收藏池 55），取消上界的直接原因', () => {
  // fixture 就是真机现状：walled 33、faved 22 → 收藏池 = 22 + 33 = 55（口径见 computeStats）
  const rate = wallConversion(22 + 33, 33);
  assert.ok(Math.abs(rate - 0.6) < 1e-9, '设备真值 = 33/55 = 60%');
  // 这一条就是本次修改的核心：旧口径（<= 0.30）下它是 false（真机被自己的验收指标误判）
  assert.equal(meetsConversionTarget(rate), true, '60% ≥ 15% → 达标：行为事实，不是缺陷');
  // 判定层同样要翻过来（原来这里断言的是"未达标"）
  const s = computeStats(emptyMetrics(), 55, 33, 0);
  assert.equal(s.conversionVerdict.hasSample, true);
  assert.equal(s.conversionVerdict.met, true);
  assert.equal(verdictText(s.conversionVerdict), '达标');
});

test('边界：100% / 200% 仍达标 —— 上界取消后高值不再算失败', () => {
  // 这两个值在旧口径下都因"高于上界 30%"而失败；上界删除后，判据里根本没有可以让高值失败的分支。
  // 保留这条断言是为了防止有人日后"顺手"再加回一个上界而不改测试。
  assert.equal(meetsConversionTarget(1.0), true, '100%（收藏的每一张都上了墙）达标');
  assert.equal(meetsConversionTarget(2.0), true, '200%（异常高值）也达标：判据里已无上界');
  // 判定层一致（100% 且收藏池 > 0 → 达标）
  const s = computeStats(emptyMetrics(), 10, 10, 0);
  assert.ok(Math.abs(s.conversion - 1.0) < 1e-9);
  assert.equal(s.conversionVerdict.met, true);
  assert.equal(verdictText(s.conversionVerdict), '达标');
});

test('边界：0% 不达标，且"空 ≠ 达标"不受下限口径影响（三层保证逐层钉死）', () => {
  // 第 1 层（谓词）：0 不满足 >= 15% —— 改口径没有把它变成 true
  assert.equal(meetsConversionTarget(0), false);
  // 第 2 层（判定类型）：无样本（收藏池 0）时 hasSample=false 且 met=false
  const empty = computeStats(emptyMetrics(), 0, 0, 0);
  assert.equal(empty.conversion, 0, '空的分母 → wallConversion 返回 0');
  assert.equal(empty.conversionVerdict.hasSample, false);
  assert.equal(empty.conversionVerdict.met, false, 'verdictOf 强制 met = hasSample && met');
  // 第 3 层（唯一文案）：无样本说"还没有数据"，**不许**说"未达标"/"达标"
  assert.equal(verdictText(empty.conversionVerdict), '还没有数据');
  assert.notEqual(verdictText(empty.conversionVerdict), '达标');
  assert.notEqual(verdictText(empty.conversionVerdict), '未达标');
  // 对照：**有**样本且为 0% → 这才是真正的"未达标"（与"不可判定"是两个词）
  const zero = computeStats(emptyMetrics(), 10, 0, 0);
  assert.equal(zero.conversionVerdict.hasSample, true);
  assert.equal(zero.conversionVerdict.met, false);
  assert.equal(verdictText(zero.conversionVerdict), '未达标');
});

// ── 「空数据 ≠ 达标」：把这条钉死 ─────────────────────────────────────────────
// 陷阱的具体形态：空集合下 medianDecisionMs / rollbackRate 都返回 0，
// 而 0 < 1200 与 0 < 3% 都恰好为真 —— 只看数值不看样本量，空设备会显示"达标"。

test('空数据不等于达标：中位数与回弹率都不可判定，verdictText 是「还没有数据」', () => {
  const s = computeStats(emptyMetrics(), 0, 0, 0);
  // 先证明陷阱真实存在：原始谓词在 0 上是 true
  assert.equal(meetsMedianTarget(0), true, '0ms 本身是"达标"的 —— 这正是陷阱');
  assert.equal(meetsRollbackTarget(0), true, '0% 本身是"达标"的 —— 这正是陷阱');
  // 但判定结果必须是否定的，且原因是"没有样本"
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(s.medianVerdict.met, false);
  assert.equal(s.rollbackVerdict.hasSample, false);
  assert.equal(s.rollbackVerdict.met, false);
  assert.equal(verdictText(s.medianVerdict), '还没有数据');
  assert.equal(verdictText(s.rollbackVerdict), '还没有数据');
  assert.notEqual(verdictText(s.medianVerdict), '达标');
  assert.notEqual(verdictText(s.rollbackVerdict), '达标');
  // 转化率同样不可判定（收藏池为 0）
  assert.equal(s.conversionVerdict.hasSample, false);
  assert.equal(verdictText(s.conversionVerdict), '还没有数据');
  assert.equal(s.eventCount, 0);
  assert.equal(s.droppedCount, 0);
});

test('空数据不等于达标：全是「上墙」时**中位数**仍不可判定，但回弹率已有样本（batch-39）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 1000, 'wall'));
  m = recordSwipe(m, evFull('B.jpg', 200, 1000, 'wall'));
  const s = computeStats(m, 0, 0, 0);
  assert.equal(s.eventCount, 2);
  // 中位数：wall 不进样本 → 记了事件也仍不可判定
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(verdictText(s.medianVerdict), '还没有数据');
  // 回弹率：wall 现在计入分母 → 有样本（0% 回弹 = 真的达标，不是"还没有数据"）
  assert.equal(s.rollbackSample, 2);
  assert.equal(s.rollbackVerdict.hasSample, true);
  assert.equal(verdictText(s.rollbackVerdict), '达标');
});

test('空数据不等于达标：verdictText 只在真有样本时才可能说「达标」', () => {
  // 有样本且数值达标 → 「达标」
  const m = recordSwipe(emptyMetrics(), ev(500, 0));
  const s = computeStats(m, 10, 2, 0);
  assert.equal(s.medianVerdict.hasSample, true);
  assert.equal(verdictText(s.medianVerdict), '达标');
  assert.equal(verdictText(s.rollbackVerdict), '达标');   // 0 回弹
  // 有样本但没达标 → 「未达标」（与"不可判定"是三个不同的词）
  const m2 = recordSwipe(emptyMetrics(), ev(5000, 0));
  const s2 = computeStats(m2, 10, 2, 0);
  assert.equal(s2.medianVerdict.hasSample, true);
  assert.equal(verdictText(s2.medianVerdict), '未达标');
  // 三个词的集合互不重叠
  const words = new Set([
    verdictText(s.medianVerdict), verdictText(s2.medianVerdict), verdictText(computeStats(emptyMetrics(), 0, 0, 0).medianVerdict)
  ]);
  assert.equal(words.size, 3);
});

// ── computeStats 的统计口径（空 / 单条 / 全 wall / 混合，各断言一次）──────────

test('computeStats：空集合 —— 三个读数按 core 约定为 0，但三条判定都不可判定', () => {
  const s = computeStats(emptyMetrics(), 0, 0, 0);
  assert.equal(s.medianMs, 0);
  assert.equal(s.medianSample, 0);
  assert.equal(s.rollbackRate, 0);
  assert.equal(s.rollbackSample, 0);
  assert.equal(s.rollbackCount, 0);
  assert.equal(s.conversion, 0);
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(s.rollbackVerdict.hasSample, false);
  assert.equal(s.conversionVerdict.hasSample, false);
});

test('computeStats：单条 —— 中位数就是那一条的间隔', () => {
  const m = recordSwipe(emptyMetrics(), ev(900, 100));   // 800ms
  const s = computeStats(m, 0, 0, 0);
  assert.equal(s.medianMs, 800);
  assert.equal(s.medianSample, 1);
  assert.equal(s.medianVerdict.hasSample, true);
  assert.equal(s.medianVerdict.met, true);
  assert.equal(s.rollbackSample, 1);
  assert.equal(s.rollbackCount, 0);
  assert.equal(s.rollbackVerdict.met, true);
  assert.equal(s.eventCount, 1);
});

test('computeStats：全是 wall —— 中位数无样本，回弹率**有**样本，转化率照常可测', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('A.jpg', 100, 1000, 'wall'));
  m = recordSwipe(m, evFull('B.jpg', 200, 1000, 'wall'));
  const s = computeStats(m, 55, 33, 0);
  assert.equal(s.medianSample, 0);
  assert.equal(s.medianVerdict.hasSample, false, '中位数仍不可判定（wall 不进它的样本）');
  // batch-39：回弹率的分母含 wall → 这里有 2 个尝试组、0 次回弹
  assert.equal(s.rollbackSample, 2);
  assert.equal(s.rollbackCount, 0);
  assert.equal(s.rollbackRate, 0);
  assert.equal(s.rollbackVerdict.hasSample, true);
  assert.equal(s.rollbackVerdict.met, true);
  assert.equal(verdictText(s.rollbackVerdict), '达标');
  // 转化率与事件无关，只与决策表有关
  assert.equal(s.favedPool, 55);
  assert.equal(s.walled, 33);
  assert.ok(Math.abs(s.conversion - 0.6) < 1e-9);
  assert.equal(s.conversionVerdict.hasSample, true);
  // 60% ≥ 15% → **达标**。这是上一批产品裁决的核心：旧口径（闭区间 15%~30%）在这里读出
  // 「未达标」，而真机 33/55 = 60% 是行为事实（「上墙」是一步直达的按钮，不必先收藏），
  // 不是缺陷 —— 上界被删除后，这个数不再是"失败"。
  assert.equal(s.conversionVerdict.met, true);
  assert.equal(verdictText(s.conversionVerdict), '达标');
});

test('computeStats：混合 —— 三条读数同时可判定', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evFull('p1', 0, 1000, 'fav'));                 // 组1：1000ms
  m = recordSwipe(m, evFull('p2', 0, 1600, 'archive'));             // 组2：1600ms
  m = recordSwipe(m, evFull('p3', 0, 900, 'none', true));           // 组3：回弹 900ms
  m = recordSwipe(m, evFull('p4', 0, 50, 'wall'));                  // 组4：上墙（不进中位数样本）
  const s = computeStats(m, 20, 4, 0);                   // 收藏池 20（含已上墙 4）
  assert.equal(s.eventCount, 4);
  assert.equal(s.medianSample, 3);
  assert.equal(s.medianMs, 1000, '样本 = [1000,1600,900] → 1000；混入 wall 的 50 会变成 900');
  assert.equal(s.medianVerdict.met, true);
  // batch-39：回弹率分母含 wall → 4 个尝试组、其中 1 组手滑
  assert.equal(s.rollbackSample, 4, '4 条事件 = 4 个尝试组（含 wall 那组）');
  assert.equal(s.rollbackCount, 1);
  assert.ok(Math.abs(s.rollbackRate - 0.25) < 1e-9);
  assert.equal(s.rollbackVerdict.met, false, '25% > 3%');
  assert.ok(Math.abs(s.conversion - 0.2) < 1e-9);
  assert.equal(s.conversionVerdict.met, true);
});

test('computeStats：淘汰条数原样带出来（> 0 时页面必须说明这是滚动窗口）', () => {
  const s = computeStats(emptyMetrics(), 0, 0, 12345);
  assert.equal(s.droppedCount, 12345);
});

test('computeStats：转化率的分母是收藏池（含已上墙），不是"当前 state 为 faved"的张数', () => {
  // 真机现状（walled 33 / faved 22）：若分母只数 faved，会读出 150%
  assert.ok(Math.abs(wallConversion(22, 33) - 1.5) < 1e-9, '只数 faved 会读出 150% —— 分母被分子吃掉');
  const s = computeStats(emptyMetrics(), 22 + 33, 33);
  assert.ok(Math.abs(s.conversion - 33 / 55) < 1e-9);
});
