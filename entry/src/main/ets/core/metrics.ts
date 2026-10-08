export interface SwipeEvent {
  photoId: string;
  shownAt: number;
  decidedAt: number;
  action: string;
  rolledBack: boolean;
}

export interface MetricsState { events: SwipeEvent[] }

export function emptyMetrics(): MetricsState {
  return { events: [] };
}

export function recordSwipe(m: MetricsState, e: SwipeEvent): MetricsState {
  if (e.decidedAt < e.shownAt) { return m; }   // 脏数据丢弃
  const events = m.events.slice();
  events.push(e);
  return { events: events };
}

export function medianDecisionMs(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  const arr = m.events
    .map((e: SwipeEvent) => e.decidedAt - e.shownAt)
    .sort((a: number, b: number) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * 回弹率 = 回弹事件数 / 全部事件数。
 *
 * 口径说明（有意如此，勿改成"按卡片数"）：spec §5.3 的指标是**误操作率**
 * ——「滑动尝试里有多少次被中途放弃」，而不是「多少张卡片曾出现过回弹」。
 * 一张卡片若被回弹后成功滑出，会贡献 2 个事件（1 回弹 + 1 决策），
 * 这正是"该卡片消耗了 2 次尝试"的忠实反映。
 *
 * 前提：同一次回弹不得重复上报（由 ui/CardStack.ets 的 150ms 防抖保证），
 * 否则分母与分子会同时被污染，指标失真。
 */
export function rollbackRate(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  let rb = 0;
  for (let i = 0; i < n; i++) { if (m.events[i].rolledBack) { rb++; } }
  return rb / n;
}

export function wallConversion(faved: number, walled: number): number {
  if (faved <= 0) { return 0; }
  return walled / faved;
}
