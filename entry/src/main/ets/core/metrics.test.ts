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

test('样本量：全是「上墙」→ 滑动样本为 0（点按钮不是滑动尝试）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('wall', 1000, 0));
  m = recordSwipe(m, evAct('wall', 2000, 0));
  assert.equal(m.events.length, 2, '事件本身是记下来的');
  assert.equal(medianSampleSize(m), 0, '但它们不构成滑动样本');
  assert.equal(rollbackDenominator(m), 0);
  assert.equal(rollbackCount(m), 0);
  // 与两个口径函数一致：没有样本时它们都返回 0
  assert.equal(medianDecisionMs(m), 0);
  assert.equal(rollbackRate(m), 0);
});

test('样本量：混合事件时精确计数（wall 出局，fav/archive/none 计入）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));                     // fav
  m = recordSwipe(m, evAct('archive', 1000, 0));        // archive
  m = recordSwipe(m, evAct('none', 1000, 0, true));     // 回弹
  m = recordSwipe(m, evAct('none', 1000, 0, true));     // 回弹
  m = recordSwipe(m, evAct('wall', 1000, 0));           // 上墙（出局）
  assert.equal(m.events.length, 5);
  assert.equal(medianSampleSize(m), 4);
  assert.equal(rollbackDenominator(m), 4);
  assert.equal(rollbackCount(m), 2);
  assert.ok(Math.abs(rollbackRate(m) - 0.5) < 1e-9);
  // 中位数样本 = [1000,1000,1000,1000]，与分母一致
  assert.equal(medianDecisionMs(m), 1000);
});

// ── 达标判定的边界值（恰好 1200 / 3% / 15% / 30%）────────────────────────────

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

test('边界：恰好 15% 与恰好 30% 都达标（spec 是范围「15% ~ 30%」，含端点）', () => {
  assert.equal(15 / 100, 0.15);
  assert.equal(30 / 100, 0.30);
  assert.equal(meetsConversionTarget(0.1499), false, '低于下限不达标');
  assert.equal(meetsConversionTarget(15 / 100), true, '恰好 15% 含在范围内');
  assert.equal(meetsConversionTarget(0.2), true);
  assert.equal(meetsConversionTarget(30 / 100), true, '恰好 30% 含在范围内');
  assert.equal(meetsConversionTarget(0.3001), false, '高于上限不达标');
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

test('空数据不等于达标：全是「上墙」时滑动指标仍不可判定（事件数 > 0 也不算有样本）', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('wall', 1000, 0));
  m = recordSwipe(m, evAct('wall', 1000, 0));
  const s = computeStats(m, 0, 0, 0);
  assert.equal(s.eventCount, 2);
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(verdictText(s.medianVerdict), '还没有数据');
  assert.equal(verdictText(s.rollbackVerdict), '还没有数据');
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

test('computeStats：全是 wall —— 滑动指标无样本，转化率照常可测', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, evAct('wall', 1000, 0));
  m = recordSwipe(m, evAct('wall', 1000, 0));
  const s = computeStats(m, 55, 33, 0);
  assert.equal(s.medianSample, 0);
  assert.equal(s.rollbackSample, 0);
  assert.equal(s.medianVerdict.hasSample, false);
  assert.equal(s.rollbackVerdict.hasSample, false);
  // 转化率与事件无关，只与决策表有关
  assert.equal(s.favedPool, 55);
  assert.equal(s.walled, 33);
  assert.ok(Math.abs(s.conversion - 0.6) < 1e-9);
  assert.equal(s.conversionVerdict.hasSample, true);
  // 60% 高于 30% 上限 → 未达标（真机现状就会读到这个数，见 computeStats 注释）
  assert.equal(s.conversionVerdict.met, false);
  assert.equal(verdictText(s.conversionVerdict), '未达标');
});

test('computeStats：混合 —— 三条读数同时可判定', () => {
  let m = emptyMetrics();
  m = recordSwipe(m, ev(1000, 0));                      // fav 1000ms
  m = recordSwipe(m, evAct('archive', 1600, 0));         // archive 1600ms
  m = recordSwipe(m, evAct('none', 900, 0, true));       // 回弹 900ms
  m = recordSwipe(m, evAct('wall', 50, 0));              // 上墙（不进滑动样本）
  const s = computeStats(m, 20, 4, 0);                   // 收藏池 20（含已上墙 4）
  assert.equal(s.eventCount, 4);
  assert.equal(s.medianSample, 3);
  assert.equal(s.medianMs, 1000, '样本 = [1000,1600,900] → 1000；混入 wall 的 50 会变成 900');
  assert.equal(s.medianVerdict.met, true);
  assert.equal(s.rollbackSample, 3);
  assert.equal(s.rollbackCount, 1);
  assert.ok(Math.abs(s.rollbackRate - 1 / 3) < 1e-9);
  assert.equal(s.rollbackVerdict.met, false, '33% > 3%');
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
