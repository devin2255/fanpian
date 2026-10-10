export interface SwipeEvent {
  photoId: string;
  shownAt: number;
  decidedAt: number;
  /**
   * 这次上报对应的动作，三个取值各自的来源：
   *   - 'fav' / 'archive' —— 一次**决定**（由卡片下方「收藏」/「归档」按钮触发）。
   *                          M1 把动作改成按钮之后已不存在"滑动决策"：'fav'/'archive'
   *                          既不是右滑/左滑产生的，也不携带任何方向信息。
   *   - 'none'           —— 一次**回弹**。来源只有一个：**手势没过阈值**
   *                          （ui/CardStack.ets 的 settle() → springBack(true)），
   *                          卡片弹回原位、未构成决策，rolledBack 为真。
   *                          注：队首下滑那一次回弹**有意不上报**（springBack(false)，
   *                          产品裁决「不算一次滑动尝试」），所以它不是 'none' 的来源。
   *   - 'wall'           —— 用户在卡片下方点「上墙」按钮（来源只有这一个），**不是一次
   *                          翻页/滑动手势的结果**：没有方向、没有位移、也没有越过任何阈值，
   *                          只是点了一下按钮（「这张直接上墙，不必先收藏」）。
   *
   * 'wall' 与上面几种「刷这张」的结局不同质，所以本文件里两个走"滑动口径"的指标
   *（medianDecisionMs / rollbackRate）都必须把它过滤掉：
   *   - 算进 rollbackRate 的分母 → 误操作率随「上墙」用得越多而越虚低
   *     （越常上墙越显得「回弹率 < 3%」达标）；
   *   - 混进 medianDecisionMs 的样本 → 「上墙」常常是照片刚出现就点下的即时判断，它的
   *     "耗时"（照片显示到点按钮的间隔）会把"一次决定要多久"这个口径的中位数污染掉。
   * 新增指标时请沿用同一口径：两个函数的判据都只是 `action !== 'wall'`，
   * 即 **'fav' / 'archive' / 'none' 一律计入、只有 'wall' 出局**。
   * 注：M1 改成按钮后 'fav'/'archive' 也不再由滑动产生，但这两个函数的口径**未随之变动**
   *（本轮只改注释、不改任何判定）；口径调整属于指标语义变更，须另开一批并同步
   * core/metrics.test.ts 的断言。
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

// ══════════════════════════════════════════════════════════════════════════════
// 以下为 Task 22 追加：落盘容量、样本量、达标判定。
//
// 上面所有函数（recordSwipe / medianDecisionMs / rollbackRate / wallConversion）
// **一字未改** —— 本节的判据全部由它们派生，口径只有一处定义。本节只追加三类东西：
//   1) 落盘容量与淘汰（capEvents）—— 事件数组不能无限增长，但它同时是"历史口径"的载体；
//   2) 与上面两个口径**同源**的样本量（medianSampleSize / rollbackDenominator / rollbackCount）
//      —— 页面必须把样本量摆在数值旁边；样本量若由页面自己数，就成了第二份口径，迟早漂移；
//   3) 达标判定（meetsXxxTarget / computeStats / verdictText）
//      —— 含"空数据 ≠ 达标"的区分（见 verdictOf 与 verdictText）。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 落盘事件数组的**硬上限**。超过就淘汰最旧的，直到 `MAX - SLACK`（低水位）。
 *
 * 为什么必须有上限：metrics 从本批起**落盘**（data/metricsStore.ets），
 * 而事件数组原本只在内存里活一个会话 —— 落盘之后它会跨进程、跨天累积，
 * 每张照片一条、每条含一个 file:// media URI（≈140 字节），不设限就是无界增长：
 * 读盘要整段 JSON.parse、每次刷卡 medianDecisionMs 要排序整个数组，两者都跑在 UI 线程上。
 *
 * 为什么是 2000：三个指标都是"中位数/比率"，2000 条的估计已经非常稳；
 * 而设备现状是 seen 188 条、决策约 100 条（`claimed 239`），2000 条装得下整个 M1 验收期
 * 还有十几倍余量。2000 条 ≈ 280 KB JSON，冷启动多读一次几毫秒，与 seen.json（≈480 KB）同量级。
 *
 * ⚠️ **淘汰会改变统计口径**（这是本文件里唯一一处"历史被改写"的地方，必须说清）：
 * 淘汰之后 medianDecisionMs / rollbackRate 反映的是**最近一段窗口**，不是全生命周期。
 * 选择"滚动窗口 + 如实显示已淘汰条数"（而不是"不淘汰"或"只存聚合量"）的理由：
 *   - 不淘汰：无界增长（见上），且真机上最终会变成"每次刷卡排序几万条"；
 *   - 只存聚合量（计数器）：中位数**无法**由计数器还原，除非改成直方图近似
 *     —— 那等于把"中位数"这个验收指标换成另一个量，属于指标语义变更，不该顺手做；
 *   - 滚动窗口 + 显示 dropped：读数永远是**可解释**的 —— 页面把"已记录 N 条 / 已淘汰 M 条"
 *     摆在指标旁边（见 StatsSnapshot.droppedCount），M > 0 时读者立刻知道这是近期读数，
 *     而不是被一个"覆盖全历史"的假象骗过去。
 */
export const MAX_METRIC_EVENTS = 2000;

/**
 * 淘汰的低水位：**超过上限时一次性淘汰到 MAX - SLACK**，而不是每次只砍一条。
 * 与 data/sessionStore.ets 的 SEEN_EVICT_SLACK 同一取舍：淘汰要先排序（O(n log n)，n = 2001），
 * 每次只砍一条就等于"在上限之上每刷一张排一次 2000 项"，而这是跑在 UI 线程上的刷卡热路径。
 * 低水位把它摊薄成"每新增 200 条排一次"。硬性上限仍是 MAX：
 * 任何时刻事件数 ≤ MAX_METRIC_EVENTS。
 */
export const METRIC_EVICT_SLACK = 200;

/** capEvents 的结果：保留的事件 + 本次淘汰的条数（调用方把它累加进"已淘汰"计数） */
export interface MetricsCap {
  events: SwipeEvent[];
  dropped: number;
}

/**
 * 把事件数组裁到上限：超出 `MAX_METRIC_EVENTS` 时淘汰**最旧的**，保留最新的 `MAX - SLACK` 条。
 *
 * 判据是 `decidedAt`（"这张是什么时候被决定的"），不是数组位置：
 * 落盘再读回来、以及将来若做合并导入，位置都不再等于时间序，而"最旧的"只该由时间定义。
 * 同一毫秒的并列用**原位置**兜底（位置靠前的先走），于是"淘汰哪些"是完全确定的
 * —— 不确定的淘汰顺序会让同一次刷卡在两台机器上得到不同的中位数。
 *
 * 返回值里的事件**保持原有顺序**（不按时间重排）：文件因此仍然是一份可读的时间线，
 * 且未超上限时原样返回**同一个数组引用**（热路径零拷贝，见 SwipePage 的调用点）。
 *
 * 顺序无关性：medianDecisionMs 内部自己排序、rollbackRate 只看计数，
 * 所以"保持原顺序"不影响任何指标读数。
 */
export function capEvents(events: SwipeEvent[]): MetricsCap {
  const n: number = events.length;
  // 未超上限：原样返回（**不是副本**）。调用方据此可以零成本地在热路径上调用本函数。
  if (n <= MAX_METRIC_EVENTS) { return { events: events, dropped: 0 }; }
  const keep: number = MAX_METRIC_EVENTS - METRIC_EVICT_SLACK;
  const order: number[] = [];
  for (let i = 0; i < n; i++) { order.push(i); }
  order.sort((a: number, b: number) => {
    const d: number = events[a].decidedAt - events[b].decidedAt;
    if (d !== 0) { return d; }
    return a - b;   // 并列：原位置靠前的（先入队的）先淘汰 —— 让淘汰结果完全确定
  });
  const dropCount: number = n - keep;
  const drop: boolean[] = [];
  for (let i = 0; i < n; i++) { drop.push(false); }
  for (let i = 0; i < dropCount; i++) { drop[order[i]] = true; }
  const kept: SwipeEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (!drop[i]) { kept.push(events[i]); }
  }
  return { events: kept, dropped: dropCount };
}

/** decodeEvents 的结果：合法事件 + 被丢弃的条数（读盘用；调用方只为告警计数） */
export interface EventsDecode {
  events: SwipeEvent[];
  skipped: number;
}

/**
 * 从**未经信任的 JSON** 里逐条校验事件（落盘文件的读侧边界层）。
 *
 * 为什么这层校验不能省：盘上的文件是**指标的唯一来源**。一个坏条目不是"少一条样本"这么轻：
 *   - action 不认识（例如写侧改过字段名、或有人手工编辑过）→ 它会既进回弹率的分母、
 *     又进中位数的样本，而页面无法为它给出任何口径说明
 *     —— 与 pages/SwipePage.ets 那道"未知动作不得进指标"的守卫同一个理由，只是这道在读侧；
 *   - rolledBack 不是布尔 → **整条丢掉**，不当成 false。猜 false 会把回弹率的分子改小、
 *     让读数偏向"达标"，正是 rollbackRate 注释里点名反对的"自证清白型失真"。
 * 换句话说：**读侧宁可丢样本，也绝不猜一个倾向于达标的默认值**（丢样本会让
 * hasSample 变小甚至归零 → 页面显示"还没有数据"，这是诚实的方向）。
 *
 * 判据与 recordSwipe 同源的部分：`decidedAt < shownAt` 视为脏数据丢弃（那里的规则一字不改，
 * 这里只是对**同一个规则**在读侧再执行一次 —— 盘上的文件可能来自旧版本或被手工改过）。
 */
export function decodeEvents(raw: SwipeEvent[]): EventsDecode {
  const out: SwipeEvent[] = [];
  let skipped = 0;
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e === null || e === undefined) { skipped = skipped + 1; continue; }
    if (typeof e.photoId !== 'string' || e.photoId === '') { skipped = skipped + 1; continue; }
    if (typeof e.action !== 'string' || !isKnownAction(e.action)) { skipped = skipped + 1; continue; }
    if (typeof e.shownAt !== 'number' || !Number.isFinite(e.shownAt)) { skipped = skipped + 1; continue; }
    if (typeof e.decidedAt !== 'number' || !Number.isFinite(e.decidedAt)) { skipped = skipped + 1; continue; }
    if (e.decidedAt < e.shownAt) { skipped = skipped + 1; continue; }
    if (typeof e.rolledBack !== 'boolean') { skipped = skipped + 1; continue; }
    out.push({
      photoId: e.photoId, shownAt: e.shownAt, decidedAt: e.decidedAt,
      action: e.action, rolledBack: e.rolledBack
    });
  }
  return { events: out, skipped: skipped };
}

/** 写侧唯一会产出的四个 action（与 SwipePage.handle() 的分派一一对应，见 SwipeEvent 注释） */
function isKnownAction(a: string): boolean {
  return a === 'fav' || a === 'archive' || a === 'wall' || a === 'none';
}

// ── 样本量：与上面两个口径**同源**（判据都只有一句 `action !== 'wall'`）──────────────
// 拆成两个导出（而不是一个共用的 swipeSampleSize）是刻意的：页面要分别写
// 「决策间隔的样本数」与「回弹率的分母」，两个名字各自对应一个函数，
// 将来某一个口径变了，页面上的标签会立刻跟着错、而不是被一个共用函数掩盖过去。

/** medianDecisionMs 的样本数（口径同它：排除 action === 'wall'） */
export function medianSampleSize(m: MetricsState): number {
  let n = 0;
  for (let i = 0; i < m.events.length; i++) {
    if (m.events[i].action !== 'wall') { n++; }
  }
  return n;
}

/** rollbackRate 的**分母**（口径同它：排除 action === 'wall'） */
export function rollbackDenominator(m: MetricsState): number {
  let n = 0;
  for (let i = 0; i < m.events.length; i++) {
    if (m.events[i].action !== 'wall') { n++; }
  }
  return n;
}

/** rollbackRate 的**分子**（回弹事件数，同样排除 wall） */
export function rollbackCount(m: MetricsState): number {
  let c = 0;
  for (let i = 0; i < m.events.length; i++) {
    const e = m.events[i];
    if (e.action === 'wall') { continue; }
    if (e.rolledBack) { c++; }
  }
  return c;
}

// ── spec §5.3 的三条验收目标与判定 ────────────────────────────────────────────
// 判定边界（**定义在这里，且被单测钉死**；边界值属于哪一侧见每条函数的注释）：
//   · 决策间隔中位数：**严格小于** 1200ms 才算达标 —— spec 原文是「< 1200 ms」，
//     所以**恰好 1200 不达标**（1200 是"没有满足小于"的那一侧）。
//   · 回弹率：**严格小于** 3% —— 同理，**恰好 3% 不达标**。
//   · 上墙转化率：**只剩下限**，`>= 15%` 即达标，**没有上界**（恰好 15% 达标、60% 达标、
//     100% 也达标）。
//   两条上界用严格小于、转化率用闭下限，不是随手选的：它们逐字对应 spec 的写法（「<」与「≥」）。
//
// 上墙转化率为什么**取消上界**（产品裁决，本轮唯一的口径变更）：
//   spec §5.3 原文写的是范围「15% ~ 30%」，本文件原先据此按**闭区间**判定
//   （恰好 15% 达标、恰好 30% 也达标、高于 30% 判未达标）。但设备真值是 **60%**
//   （walled 33、收藏池 faved ∪ walled = 55 → 33/55 = 60%），**超出上界**，
//   于是真机数据被自己的验收指标判成"未达标"—— 那是误报，不是发现。
//   裁决：**去掉上界，只要求 ≥ 15%**。理由是 spec 写 15%~30% 时假设的流程是
//   "先收藏，再从收藏里挑着上墙"（两步），这种漏斗里转化率天然低；而现在的「上墙」是
//   卡片下方四个按钮之一（**一步直达**），上墙本身就是直接动作、不经过收藏这道闸门，
//   转化率自然高。**60% 是行为事实，不是缺陷**，所以指标要跟着事实走。
//   历史脉络（供后人回溯）：上界不是被"调大"到某个更宽的数，而是被**删除**；
//   判据从"落在区间内"变成"不低于下限"。TARGET_CONVERSION_MAX 因此失去全部读者被一并删除
//   （它原先只有两个读者：下面的 meetsConversionTarget 与 pages/StatsPage.ets 的目标文案）。
export const TARGET_MEDIAN_MS = 1200;
export const TARGET_ROLLBACK_RATE = 0.03;
export const TARGET_CONVERSION_MIN = 0.15;

/** 决策间隔中位数是否达标（恰好 1200 → false） */
export function meetsMedianTarget(ms: number): boolean {
  return ms < TARGET_MEDIAN_MS;
}

/** 回弹率是否达标（恰好 0.03 → false） */
export function meetsRollbackTarget(rate: number): boolean {
  return rate < TARGET_ROLLBACK_RATE;
}

/**
 * 上墙转化率是否达标（**只判下限**）：恰好 0.15 → true；0.1499 → false；
 * 30% / 60% / 100% / 200% 等一切 `>= 15%` 的值 → **都 true**（上界已按产品裁决取消，
 * 理由见文件上方 TARGET_CONVERSION_MIN 的注释）。旧实现是 `>= MIN && <= MAX`，
 * 真机 60% 会在这里被读成 false —— 那个误报就是本次改动要消灭的东西。
 *
 * **名字为什么不改成 meetsConversionFloor**：这里的 `Target` 指的是 spec §5.3 的
 * **验收目标**本身，而不是"双侧区间"。三条判定是同族命名
 *（meetsMedianTarget / meetsRollbackTarget / meetsConversionTarget），族里的词义一致才可读；
 * 而"目标"从今天起就是单侧的"不低于 15%"，名字与语义仍然对得上。
 * 改成 floor 的收益只是把"下限"写进标识符，代价是与另外两条判定分家、并让所有调用点
 * 为一个不含新信息的词无谓改动 —— 语义变化已经由本注释与上面的常量注释说清，故保留原名。
 */
export function meetsConversionTarget(rate: number): boolean {
  return rate >= TARGET_CONVERSION_MIN;
}

/**
 * 一条指标的判定结果。**`hasSample` 与 `met` 必须分开**，这是"空数据不等于达标"的全部实现：
 *   - `hasSample === false` → 这条指标**不可判定**（页面必须显示"还没有数据"）；
 *   - `hasSample === true && met === false` → 量过了，没达到；
 * 若只留一个 `met` 布尔，空状态与"量了没达标"就无法区分 —— 而空状态下的读数是 0，
 * 0 < 1200 与 0 < 3% **都恰好落在达标一侧**（见 medianDecisionMs 的注释：空集合返回 0），
 * 一个布尔字段必然把"没数据"渲染成"达标"。所以区分必须在**类型层面**存在，
 * 而不是靠页面记得先判空。
 */
export interface TargetVerdict {
  hasSample: boolean;
  met: boolean;
  value: number;
}

/**
 * 造判定结果。**`met` 被强制与 `hasSample` 相与** —— 无样本时无论原始谓词算出什么，
 * `met` 一律为 false。于是"空数据被判达标"在本文件里是**结构性不可达**的：
 * 任何调用方都不可能通过构造出一个 `{hasSample:false, met:true}` 来绕过它。
 */
function verdictOf(hasSample: boolean, met: boolean, value: number): TargetVerdict {
  return { hasSample: hasSample, met: hasSample && met, value: value };
}

/**
 * 判定结果的**唯一**显示文本。页面不许自己拼这三个词（否则页面就拥有了第二种判定口径）。
 * 空数据在这里返回「还没有数据」而不是「达标」/「未达标」：
 * 前者说的是"不可判定"，后两者说的是"判定过了"，混用会让验收指标在空设备上看起来是绿的。
 */
export function verdictText(v: TargetVerdict): string {
  if (!v.hasSample) { return '还没有数据'; }
  return v.met ? '达标' : '未达标';
}

/**
 * 统计快照 = 「使用统计」页要显示的**全部**数字与判定。
 * 页面只做渲染（+ 格式化），不做任何计算 —— 这样"页面上的数是怎么来的"只有一处可查。
 */
export interface StatsSnapshot {
  /** 事件总条数（= 落盘窗口里的条数） */
  eventCount: number;
  /** 曾被容量淘汰的条数（> 0 时页面必须说明这是滚动窗口，见 MAX_METRIC_EVENTS） */
  droppedCount: number;
  medianMs: number;
  medianSample: number;
  medianVerdict: TargetVerdict;
  rollbackRate: number;
  rollbackCount: number;
  rollbackSample: number;
  rollbackVerdict: TargetVerdict;
  /** 收藏池 = faved + walled（见下） */
  favedPool: number;
  walled: number;
  conversion: number;
  conversionVerdict: TargetVerdict;
}

/**
 * 把三份原始数据合成一个统计快照。
 *
 * @param m 事件窗口（内存里的权威副本；页面从盘上读回来）
 * @param favedPool **收藏池**口径的张数 = `DecisionStore.favedIds().length`（= state 为 'faved' **或** 'walled'）
 * @param walled `DecisionStore.walledIds().length`
 * @param droppedCount 累计被淘汰的条数（0 = 这份窗口就是全部历史）
 *
 * 关于 `favedPool` 为什么必须**含已上墙的**（这是"转化率分母"的要害，别改成只数 'faved'）：
 *   `applyDecision(d, 'wall')` 把 state 直接写成 `'walled'`（core/queue.ts），
 *   被上墙的那张**不再**是 'faved'。若分母只数 `state === 'faved'`，那么每上墙一张，
 *   分母就**减一**、分子**加一** —— 分子把自己的分母吃掉。真机现状（walled 33 / faved 22）
 *   会读出 33/22 = 150%，那不是"转化率高"，那是分母算错了。
 *   用收藏池（55）读出 33/55 ≈ 60% —— 这个数读作"进过收藏这条路的照片里有多少挂上了墙"，
 *   是转化率唯一说得通的解释。口径由 `DecisionStore.favedIds()` 定义（那里已含 walled），
 *   这里只是把它的语义写下来。
 *
 * 空数据的分界（每条指标各自判，不设"整页空态"这种粗判据）：
 *   - 中位数/回弹率：`样本数 > 0` 才有样本（全是 'wall' 也算**没有**样本，见 medianDecisionMs 注释）；
 *   - 转化率：`收藏池 > 0` 才有样本（一张都没收藏时分母为 0，wallConversion 返回 0 —— 那个 0 是"不可判定"）。
 */
export function computeStats(
  m: MetricsState, favedPool: number, walled: number, droppedCount: number
): StatsSnapshot {
  const medSample: number = medianSampleSize(m);
  const med: number = medianDecisionMs(m);
  const rbSample: number = rollbackDenominator(m);
  const rbCount: number = rollbackCount(m);
  const rb: number = rollbackRate(m);
  const conv: number = wallConversion(favedPool, walled);
  return {
    eventCount: m.events.length,
    droppedCount: droppedCount,
    medianMs: med,
    medianSample: medSample,
    medianVerdict: verdictOf(medSample > 0, meetsMedianTarget(med), med),
    rollbackRate: rb,
    rollbackCount: rbCount,
    rollbackSample: rbSample,
    rollbackVerdict: verdictOf(rbSample > 0, meetsRollbackTarget(rb), rb),
    favedPool: favedPool,
    walled: walled,
    conversion: conv,
    conversionVerdict: verdictOf(favedPool > 0, meetsConversionTarget(conv), conv)
  };
}
