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
   * 「上墙」在这一层的两个口径里处境**不同**（本文件最容易被顺手改错的一处）：
   *   - medianDecisionMs **继续排除** wall：它的"耗时"是「照片显示到点按钮」的间隔，
   *     与「滑向某一边犹豫了多久」不同质（按钮常常在照片刚出现时就被点，混进来会把
   *     中位数系统性拉低）。理由完整写在它自己的注释里，本批一字未改；
   *   - rollbackRate **从 batch-39 起计入** wall。旧口径排除它的前提是「wall 是必然成功的
   *     动作，含它会让指标看起来更好」—— 真机数据（wall 27 / fav 17 / none 4 / archive 3）
   *     把这个前提证伪了：wall 占 53%，而且**一次回弹完全可以发生在 wall 之前**
   *     （真机就有一张是 none → wall）。排除 wall 等于把"最终成功上墙的那次尝试"从分母里
   *     删掉、而分子里的那次回弹照算。完整推导见 rollbackRate 的注释。
   *
   * 注意 `action` **不是**判断"算不算一次尝试"的依据 —— batch-39 之后回弹率的单位是
   * 「一张照片的一次出现」，与 action 取什么值无关（见 rollbackRate）。
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
 * 刚出现时就被点，混进来会把中位数系统性拉低）。
 * ⚠️ batch-39 之后它与 rollbackRate **不再是同一个口径**（那边已计入 wall）：
 * 那边问的是"一次尝试有没有手滑"（与 action 无关），这边问的是"滑动这个动作犹豫了多久"
 *（与 action 强相关）。两者共用一句 `action !== 'wall'` 的历史在 batch-39 结束。
 *
 * ── batch-39 的检查结论：这里的**分母没有**回弹率那种同类缺陷 ──────────────────
 * 被要求检查的同类缺陷形态是「分母缩水、分子照算 ⇒ 比率被放大」。中位数不是比率、
 * 没有分子/分母，这个形态在结构上不存在。逐条对照：
 *   1) 排除 wall 不会"分子照算"：被排除的样本同时从**读数本身**里消失，
 *      没有任何留在分子里的量；
 *   2) 方向相反：wall 的耗时是"照片刚出现就点按钮"的**短**间隔，
 *      排除它会让中位数**偏高**（更难达标）—— 是保守，不是自证清白型失真。
 *      旧注释正是把这一点写成了排除的理由（"混进来会把中位数系统性拉低"），
 *      与回弹率那边"排除会让指标虚高"的方向正好相反，所以两处不能一起改。
 *   3) 残留的同形问题（**有意不修**）：一次"尝试组"内的重试会给中位数贡献多个样本
 *      （`none 1500ms` + `wall 2500ms` → 两个样本）。它与回弹率的缺陷同形，但**不是同一个量**：
 *      改它就等于把"一次决定要多久"换成"一次意图持续多久"，那是另一个指标的语义变更。
 *      本批的用户裁决只动回弹率口径，故此处一字不改；若将来要改，须另开一批并同步单测。
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

// ══════════════════════════════════════════════════════════════════════════════
// batch-39：回弹率改为按「尝试组」计数。以下三个函数是本口径的**唯一**定义处；
// rollbackDenominator / rollbackCount / rollbackRate 全部由它派生，不各数一遍
//（否则页面上的样本量与读数就可能来自两份会漂移的口径）。
// ══════════════════════════════════════════════════════════════════════════════

/** countAttemptGroups 的结果：尝试组数 + 其中出现过回弹的组数 */
export interface AttemptCounts {
  /** 尝试组总数 = 回弹率的**分母** */
  groups: number;
  /** 至少出现过一次回弹的组数 = 回弹率的**分子**（同组回弹多次也只算一次） */
  fumbled: number;
}

/**
 * 尝试组的分组键 = **同一张照片的同一次出现**（`photoId` + `shownAt`）。
 *
 * 分隔符用 `|`：photoId 是 media URI、shownAt 是毫秒数，两者都不含 `|`，
 * 所以拼接不产生歧义（不会出现两张不同的卡拼出同一个键）。
 * 为什么这两个字段足以定义"一次出现"、为什么不必新增字段 —— 论证见 rollbackRate 注释。
 */
function attemptKey(e: SwipeEvent): string {
  return `${e.photoId}|${e.shownAt}`;
}

/**
 * 按「尝试组」计数（回弹率分母与分子的**唯一**实现）。
 *
 * 单趟遍历、两个 Set：O(n)。n 的上界是 MAX_METRIC_EVENTS（2000），
 * 而本函数在刷卡热路径上会被调一次（pages/SwipePage.ets 每张都算 rollbackRate），
 * 所以刻意不做排序（O(n log n)）、也不为每组建对象。
 * 顺序无关：结果只由"哪些键出现过"决定，与事件在数组里的次序无关
 * —— capEvents 会保持原顺序、也可能按时间淘汰，两种情况下读数都一致。
 */
function countAttemptGroups(m: MetricsState): AttemptCounts {
  const seen: Set<string> = new Set();
  const fumbled: Set<string> = new Set();
  for (let i = 0; i < m.events.length; i++) {
    const e: SwipeEvent = m.events[i];
    const k: string = attemptKey(e);
    seen.add(k);
    if (e.rolledBack) { fumbled.add(k); }
  }
  return { groups: seen.size, fumbled: fumbled.size };
}

/**
 * 回弹率 = **出现过回弹的"尝试组"数** / **尝试组总数**。
 *
 * ── 口径的精确语义（batch-39 按用户裁决改写；旧口径的历史见本节末尾）──────────────
 *
 * **尝试组**（attempt group）= **一张照片的一次出现**。
 *   - 一次出现期间发生的**所有**事件（回弹 + 最终成功的那个动作）合成**一个**组；
 *   - 于是"同一张卡的连续重试算一次"：用户对这张照片的意图是一次，
 *     手滑不是第二次意图（用户原话：「手滑不是第二次意图」）；
 *   - 分母 = 组数；分子 = **其中至少出现过一次回弹**的组数（同一组回弹多次也只算一次）。
 *
 * 分母**包含 `action === 'wall'`**（旧口径排除它）。为什么必须包含：
 * 旧口径的前提是「wall 是必然成功的动作，算进去会让指标看起来更好」。真机数据
 * （51 条事件：wall 27 / fav 17 / none 4 / archive 3）把这个前提证伪了 ——
 *   - wall 占 53%，是用户一半以上的操作；
 *   - 而且**回弹可以发生在 wall 之前**（真机 3 张有重试的照片里，有 2 张是 none → wall）。
 * 排除 wall 于是变成"**分母缩水、分子照算**"：真机旧口径 4/(51-27) = 4/24 = 16.67%，
 * 而按真实发生过的事 4/47 = 8.51% —— 率被放大约 2 倍，且**越常用「上墙」就越虚高**。
 * 这正是旧注释里点名要防的"自证清白型失真"，只是方向反了：不是虚低，是虚高。
 *
 * ── 为什么"一次出现"可以由现有字段推出，**不需要新增字段** ────────────────────
 * 分组键 = `(photoId, shownAt)`，两者都是 SwipeEvent 已有的字段，依据是两条代码事实：
 *   1) `shownAt` 只在换卡时被重写一次（pages/SwipePage.ets 的 `goTo()` 末尾
 *      `this.shownAt = Date.now()`），而**回弹在 handle() 里早退、不换卡**
 *      （`if (rolledBack) { return; }` 在 goTo 之前）→ 回弹不会刷新 shownAt；
 *   2) `wall` 的**事件**在 handle() 里同刻记下（用的就是当前 shownAt），但它的**推进**
 *      在异步的 `applyWall()` 里（要先等地点索引、可能还要问用户地点）→ 这段窗口里
 *      卡片仍是当前这张、shownAt 不变。
 * 于是"同一张卡的一次出现"期间的全部事件**天然共享同一个 shownAt**，而任何一次换卡
 * 都必然刷新它 —— 真机上 `wall + none + wall`（同一张）×3 条正是这样落成一个组的。
 * 所以既不必要 sessionId/burstId 这类新字段，也不必要一个"重试时间窗"常量
 *（窗口常量会变成第二个口径：多长算"连续"得靠调参，而 shownAt 是**由代码结构保证**的）。
 *
 * **同一张照片在不同时间被独立刷两次** → 两次出现、两个 shownAt → **算 2 次**：
 * 那是两次真实意图（跨会话、或回到上一张重新决定），不该被折叠成一次。
 * 反之，同一组内重复上报（按钮同帧被点两次等）也只是同一个键被 add 两次，计数不变
 * —— 这层分组对重复上报是天然幂等的（旧口径下每条重复上报都会给分母 +1）。
 *
 * ── 历史脉络（本项目注释惯例：记下"为什么变成这样"）──────────────────────────
 *   - `76e8690` 初版：回弹数 / 滑动事件数；
 *   - `b49dd74` 写下「勿改成按卡片数」的判据，理由是「一张卡被回弹后成功滑出会贡献 2 个
 *     事件，这正是它消耗了 2 次尝试的忠实反映」；
 *   - `5c24f16` 排除 wall，理由是「点按钮不是滑动尝试，算进分母会让指标随上墙频率虚低」；
 *   - **batch-39 反转了 `b49dd74` 的判据**：那个理由假设"重试是第二次尝试"，而真机数据
 *     显示它是一次手滑（用户意图仍是一次），把它算成 2 次才是失真。同时反转了 `5c24f16`
 *     的前提（wall 并非必然成功）。两处反转的**唯一依据都是真机数据**，不是口味。
 *   - 若将来设备上出现"同一张卡在同一 shownAt 下其实是两次独立意图"的证据，
 *     要改的是**分组键**（而不是回去按事件数算）—— 那时再加字段、并同步本注释与单测。
 *
 * 前提（未变）：同一次回弹不得重复上报（由 ui/CardStack.ets 的 150ms 防抖保证）。
 * 分组对重复上报幂等，所以即便防抖失效，分母也不会再被重复上报放大 —— 这是本口径
 * 相对旧口径的一个附带好处。
 *
 * 空集合：分母为 0 → 返回 0 且**不可判定**（`hasSample` 由 `rollbackDenominator > 0`
 * 给出，见 computeStats）。"空集合 ≠ 达标"这条**没有退化**：全是 wall 时组数 > 0，
 * 所以那是"有样本、回弹率 0%"（真的达标）；一条事件都没有时才是"还没有数据"。
 */
export function rollbackRate(m: MetricsState): number {
  const c: AttemptCounts = countAttemptGroups(m);
  if (c.groups === 0) { return 0; }   // 空集合：分母为 0，不得除零（"不可判定"由 hasSample 表达）
  return c.fumbled / c.groups;
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

// ── 样本量：与各自的口径**同源**（batch-39 之后两者口径已分家）─────────────────
// 拆成两个导出（而不是一个共用的 swipeSampleSize）是刻意的：页面要分别写
// 「决策间隔的样本数」与「回弹率的分母」，两个名字各自对应一个函数，
// 将来某一个口径变了，页面上的标签会立刻跟着错、而不是被一个共用函数掩盖过去。
// batch-39 就是这条设计的一次兑现：回弹率改了口径，medianSampleSize **不动**、
// rollbackDenominator 跟着改 —— 若当初共用一个函数，这次就会把中位数的样本数一起改错。

/** medianDecisionMs 的样本数（口径同它：排除 action === 'wall'，按**事件**计） */
export function medianSampleSize(m: MetricsState): number {
  let n = 0;
  for (let i = 0; i < m.events.length; i++) {
    if (m.events[i].action !== 'wall') { n++; }
  }
  return n;
}

/**
 * rollbackRate 的**分母** = 尝试组数（口径同它：含 'wall'、同卡同一次出现只算一次）。
 * ⚠️ 这里不再是"事件数"：真机上 51 条事件只对应 47 个尝试组。
 */
export function rollbackDenominator(m: MetricsState): number {
  return countAttemptGroups(m).groups;
}

/**
 * rollbackRate 的**分子** = 出现过回弹的尝试组数（口径同它：含 'wall'、组内去重）。
 * 同一张照片在一次出现里回弹两次，这里只 +1 —— 用户的手滑只发生在一个意图上。
 */
export function rollbackCount(m: MetricsState): number {
  return countAttemptGroups(m).fumbled;
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
 *   - 中位数：`medianSampleSize > 0` 才有样本（全是 'wall' 时它仍是 0 → 中位数不可判定）；
 *   - 回弹率：`尝试组数 > 0` 才有样本 —— **含全是 'wall' 的事件**：wall 现在计入分母，
 *     所以"一批全是上墙的事件"是"有样本、回弹率 0%"，**不是**"还没有数据"。
 *     只有一条事件都没有（或全部被读侧丢弃）时才不可判定。这条区分是 batch-39 的口径
 *     变更带来的**唯一**判定变化，须与"空集合 ≠ 达标"一起看：
 *     空集合仍然不可判定（分母 0 → hasSample false），只是"全是 wall"不再属于空集合。
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
