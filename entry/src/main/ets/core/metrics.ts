export interface SwipeEvent {
  photoId: string;
  shownAt: number;
  decidedAt: number;
  /**
   * 这次上报对应的动作：
   *   - 'fav' / 'archive' —— 一次**滑动决策**（右滑收藏 / 左滑归档）；
   *   - 'none'           —— 一次**回弹**（卡片弹回原位、未构成决策，rolledBack 为真）；
   *   - 'wall'           —— 用户在卡片上点「上墙」按钮，**不是一次滑动尝试**：
   *                         没有方向、没有位移、也没有越过任何阈值，只是点了一下按钮。
   *
   * 'wall' 与滑动不同质，所以本文件里所有"滑动口径"的指标（medianDecisionMs /
   * rollbackRate）都必须把它过滤掉：
   *   - 算进 rollbackRate 的分母 → 误操作率随「上墙」用得越多而越虚低
   *     （越常上墙越显得「回弹率 < 3%」达标）；
   *   - 混进 medianDecisionMs 的样本 → 按钮决策的耗时分布与滑动决策完全不同质，
   *     会把"滑动决策耗时"这个口径的中位数污染掉。
   * 新增指标时请沿用同一口径：**点按钮的事件不参与滑动度量**。
   */
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

/**
 * 滑动决策耗时的中位数（ms）。
 *
 * 口径：只取**滑动**事件（'fav' / 'archive' 决策 + 'none' 回弹）。
 * 必须排除 action === 'wall' —— 那是「在卡片上点一下按钮」，它的"耗时"是
 * 「照片显示到点按钮」的间隔，与「滑向某一边犹豫了多久」不同质（按钮常常在照片
 * 刚出现时就被点，混进来会把中位数系统性拉低）。这与 rollbackRate 用同一口径：
 * 点按钮的事件不参与滑动度量。
 */
export function medianDecisionMs(m: MetricsState): number {
  const arr: number[] = [];
  for (let i = 0; i < m.events.length; i++) {
    const e = m.events[i];
    if (e.action === 'wall') { continue; }
    arr.push(e.decidedAt - e.shownAt);
  }
  const n = arr.length;
  if (n === 0) { return 0; }   // 无滑动样本（空状态、或全是上墙）：不得除零
  arr.sort((a: number, b: number) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * 回弹率 = 回弹事件数 / **滑动尝试**事件数。
 *
 * 口径说明（有意如此，勿改成"按卡片数"）：spec §5.3 的指标是**误操作率**
 * ——「滑动尝试里有多少次被中途放弃」，而不是「多少张卡片曾出现过回弹」。
 * 一张卡片若被回弹后成功滑出，会贡献 2 个事件（1 回弹 + 1 决策），
 * 这正是"该卡片消耗了 2 次尝试"的忠实反映。
 *
 * 分母必须排除 action === 'wall'：那是在卡片上点「上墙」按钮，不是一次滑动尝试
 * （没有方向、没有位移、没有阈值判定）。把它算进分母会让指标随「上墙」使用频率
 * 升高而虚低——越常上墙越显得达标，属自证清白型失真：
 *   真实 r/s，若刷了 w 次上墙，读数会变成 r/(s+w)。
 * 回弹事件（action 为 'none'）与滑动决策都必须留在两个计数里，只有 'wall' 出局。
 *
 * 前提：同一次回弹不得重复上报（由 ui/CardStack.ets 的 150ms 防抖保证），
 * 否则分母与分子会同时被污染，指标失真。
 */
export function rollbackRate(m: MetricsState): number {
  let n = 0;
  let rb = 0;
  for (let i = 0; i < m.events.length; i++) {
    if (m.events[i].action === 'wall') { continue; }   // 点按钮 ≠ 滑动尝试，不进分母
    n++;
    if (m.events[i].rolledBack) { rb++; }
  }
  if (n === 0) { return 0; }   // 全是 wall（或空）：分母为 0，不得除零
  return rb / n;
}

export function wallConversion(faved: number, walled: number): number {
  if (faved <= 0) { return 0; }
  return walled / faved;
}
