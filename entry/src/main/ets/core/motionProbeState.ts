/**
 * 动态照片「为当前这张卡取对象」的**重试状态机**（缺陷 D4 的纯逻辑部分）。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────────────
 *   `ui/CardStack.ets` 里这套状态迁移原先只有一份实现，而它**依赖真机 UI 上下文**
 *   （`getUIContext().getHostContext()`）与 MediaLibraryKit —— 于是"瞬时失败之后到底还
 *   能不能重试""重试到底有没有上界""换卡之后旧结果会不会写脏新状态"这三件事
 *   **一条都测不了**（fix-batch-37 自己登记的诚实边界）。
 *   本文件把那三件事抽成**纯函数 + 纯数据结构**：零 `@kit.*`、零平台对象、零 I/O，
 *   Node 可以直接 import（`node --experimental-strip-types --test core/motionProbeState.test.ts`）。
 *
 * ── 模块**不**管什么（边界必须写清楚，否则会被误当成"状态机的一部分"）──────────
 *   · `MovingPhoto` 句柄：**不进这个模块**。所有权与释放路径全部留在 `CardStack`
 *     （`motionOwner` 是唯一持有者；`MovingPhoto` 没有 release API，"放手"只能靠唯一持有者
 *     丢掉引用 —— 把句柄搬进来会立刻造出第二个持有者）。
 *     本模块只用 `hasHandle: boolean` 描述"这次探测有没有拿到对象"。
 *   · `motionSeq`（递增序号凭据）：**留在 `CardStack`**。本模块把它当作调用方注入的
 *     不透明数字 `MotionProbeTicket.seq`，既不生成也不递增。理由：序号的递增时机与
 *     `releaseMotion()`（放手句柄）是同一件事的两面，拆开就会让"换卡即作废"这条路径
 *     出现两个执行者。
 *   · 日志、计时器、IPC、播放器：全部在 `CardStack` / `data/movingPhotoSource.ets`。
 *
 * ── 状态只有三个字段（刻意不复用旧实现的"一个字段两用"）──────────────────────
 *   `concludedId` —— **只写"已下结论"**（这张到底是不是动态照片，正负都算）。
 *   `inFlightId`  —— **只写"在途"**（探测已发出、结果还没回来）。
 *   `tries`       —— 本次「访问」已经用掉的尝试次数（上界见 `MOTION_PROBE_MAX_ATTEMPTS`）。
 *   旧实现把前两者合成一个字段，于是"这次没探到"与"确定不是动态照片"在状态上同形
 *   —— 而重新触发的唯一执行者是 `@Watch onItemChanged`，它第一件事就是按 photoId 去重，
 *   结果是**同一张卡在本会话内再也没有机会**（角标不亮、长按无反应、用户没有任何恢复动作）。
 */

/**
 * **一张卡在一次「访问」里最多发起几次探测**（缺陷 D4 的重试上界）。
 *
 * ── 为什么必须要有上界 ──────────────────────────────────────────────────────
 *   D4 的修法是"瞬时失败不写结论、留一个重试触发点"。但触发点挂在**用户交互**上
 *   （`PanGesture.onActionStart` 与长按），不设上界就变成"用户每拖一次就发一次 IPC"：
 *   一次探测的代价不是本地计算 —— 它是一次 `getAssets` 查库，失败时还要挂住
 *   `requestMovingPhoto` 的回调直到 `MOTION_REQUEST_TIMEOUT_MS`（5000ms）超时。
 *
 * ── 3 这个数是怎么来的 ─────────────────────────────────────────────────────
 *   · 第 1 次：进这张卡时自动发起（`aboutToAppear` / `onItemChanged`），用户什么都不用做；
 *   · 第 2、3 次：用户**明确地又碰了这张卡两次**（拖动 ≥5vp，或长按 500ms）。
 *     这正是那两类瞬时成因的自然恢复时间：IPC 抖动下一次交互就好，
 *     授权生效往往要等用户切回来/再点一次；
 *   · 上界 3 之后仍是"没探到"，大概率是**稳定失败**（这张确实取不到对象），
 *     再试只是把一次查库 + 最长 5s 的等待摊到每一次滑动上；
 *   · **同一张卡的并发也有上界**：配合 `inFlightId`，**这张卡**任意时刻最多 1 条在途 ——
 *     所以最坏情况是这张卡这次访问最多串行烧掉 3 × 5s 的后台等待，
 *     而不是一口气并发打出 3 条请求。
 *     ⚠️ 精确一点（别把它读成全局上界）：**跨卡换页**时旧卡那条探测可能还在跑
 *     （`requestMovingPhoto` 最长挂到超时），而新卡会各自发起自己的第 1 次。
 *     这个并发度由"用户 5s 内翻了几张卡"决定，是**旧实现就有的**行为，
 *     fix-batch-37 **没有改变**它（重试上界只作用在"同一张卡"这条轴上）。
 *
 * ── 为什么不是"整会话只试一次" ──────────────────────────────────────────────
 *   换走再滑回来 = 一次**新的访问**，预算重置（`newMotionProbeState()`）。这是有意的：
 *   重新访问是一次全新的环境（用户可见的动作），而"同一张卡上无限重试"才是要挡的东西。
 *
 * ⚠️ 上界**只挡"开始一次探测"**，从不挡"接收一个结果"：第 N 次（最后一次）探测成功时
 *    结果照样被接受、照样写结论 —— 否则"用满预算"就等于"永远不可能成功"。
 */
export const MOTION_PROBE_MAX_ATTEMPTS: number = 3;

/**
 * 状态机的全部状态。**纯数据**：没有方法、没有平台对象、没有句柄。
 * 每次迁移都返回**新的**对象（不原地改），所以任何一个中间态都可以被断言、被留档。
 */
export interface MotionProbeState {
  /** **已下结论**的 photoId（'' = 这张还没定论）。正结论（句柄到手）与负结论（确定不是）都写它。 */
  concludedId: string;
  /** **有在途探测**的 photoId（'' = 没有在途）。任意时刻最多一个非空值。 */
  inFlightId: string;
  /** 本次访问已经**用掉**的尝试次数（含"还没发出去就同步失败"的那些，见 `beginMotionProbe`）。 */
  tries: number;
}

/**
 * 拒绝一次探测的原因。四种都**互不相同**，因为它们在真机上的修法完全不同：
 *   · `empty-id`  —— 卡片还没有 photoId（没有可探的对象，不是失败）；
 *   · `concluded` —— 这张**已经定论**（正或负）→ 不该再花一次查库。这是"省下 IPC"的那一支；
 *   · `in-flight` —— 这张**已经有一条在途** → 不并发重发（重试不会把 IPC 乘起来）；
 *   · `budget`    —— 这次访问的**重试预算用完了**（上界见 `MOTION_PROBE_MAX_ATTEMPTS`）。
 */
export type MotionProbeDeny = 'none' | 'empty-id' | 'concluded' | 'in-flight' | 'budget';

/** 「开始一次探测」的判定结果。`allowed = false` 时 `state` **一字未改**（尝试没有被用掉）。 */
export interface MotionProbeBegin {
  /** 是否允许发起这次探测。 */
  allowed: boolean;
  /** 拒绝原因（`allowed = true` 时为 `'none'`）。 */
  deny: MotionProbeDeny;
  /**
   * 迁移后的状态（**调用方必须接住它**）。
   * `allowed = true` 时 `tries` 已经 +1 —— "同步失败也算一次"（见 `beginMotionProbe`）。
   * 此时 `state.tries` 就是这次的序号（从 1 开始），日志直接用它。
   */
  state: MotionProbeState;
}

/**
 * 一次**已经发出去**的探测的凭据：它是"这条结果属于哪一次探测"的唯一答案。
 * `seq` 由调用方（`CardStack` 的 `motionSeq`）注入 —— 本模块既不生成也不递增它。
 */
export interface MotionProbeTicket {
  /** 这次探测针对的 photoId。 */
  id: string;
  /** 这次探测的序号凭据（调用方每次发起都换一个新的，**绝不复用**）。 */
  seq: number;
}

/** [`armMotionProbe`] 的返回值：在途标记 + 凭据。 */
export interface MotionProbeArm {
  /** 这次探测的凭据；`settleMotionProbe` 只认它。 */
  ticket: MotionProbeTicket;
  /** 迁移后的状态（`inFlightId` 已置为这张，`concludedId` 已清）。 */
  state: MotionProbeState;
}

/**
 * 一次结果回来之后的**去向**。这就是题目要的"三类"，其中"确定性结论"按
 * `hasHandle` 再分成两小类（调用点要据此决定**要不要接管句柄**）：
 *
 *   ① **确定性结论** —— 以后不再探测这张（`concludedId` 被写上）
 *        · `ready`    —— 正结论：**句柄到手**（调用点必须接管并持有它）；
 *        · `negative` —— 负结论：data 层确定"这张不是动态照片"（`concluded === true`）；
 *   ② **瞬时失败** `missed` —— 查库 0 条 / 请求超时 / 回传空 / IPC 抖动 / 取不到宿主 Context。
 *        **不写结论** ⇒ 下一次与这张卡的交互**可以**再发起一次（上界见常量说明）。
 *   ③ **结果过期** `stale` —— 这条结果已经不算数了。**状态一字不动**，
 *        句柄由调用点当场放手（`hasHandle` 那一份）。
 */
export type MotionSettleOutcome = 'stale' | 'negative' | 'missed' | 'ready';

/**
 * 一次探测的"真相"，**由 data 层给出**（`data/movingPhotoSource.ets::MotionProbeResult`）。
 * 两个字段刻意都留着：
 *   · 只给 `hasHandle` 的话，"确定不是动态照片"与"这次没探到"完全同形 ——
 *     而前者可以就此定案，后者**必须**留着重试的机会；
 *   · 只给 `concluded` 的话，调用点还得再判一次有没有对象 —— 两个并排写出来，
 *     "什么算结论"这件事就是读得到的，不用去猜哪一支算了 `confirmedNoMotion`。
 */
export interface MotionProbeVerdict {
  /** data 层的 `MotionProbeResult.concluded`：这次探测**有定论**吗（正或负）。 */
  concluded: boolean;
  /** 这次探测**有没有拿到对象**（对应 `MotionProbeResult.handle !== undefined`）。 */
  hasHandle: boolean;
}

/** [`settleMotionProbe`] 的返回值。 */
export interface MotionProbeSettle {
  /** 这条结果的去向（见 `MotionSettleOutcome`）。 */
  outcome: MotionSettleOutcome;
  /**
   * 迁移后的状态。`outcome === 'stale'` 时它与入参**逐字段相同**（过期结果不得影响新状态）；
   * 其余三种都已经解除在途标记（失败也算"这次探测结束了"）。
   */
  state: MotionProbeState;
}

/**
 * 「一次新的访问」的初始状态：没有结论、没有在途、预算满格。
 * 调用点是 `CardStack.onItemChanged`（换卡）与 `aboutToDisappear`（卸载）——
 * 两个都是"这张卡从此不再需要任何状态"的时刻。
 */
export function newMotionProbeState(): MotionProbeState {
  return { concludedId: '', inFlightId: '', tries: 0 };
}

/**
 * 允许开始一次探测吗？**允许的话顺手把这次尝试记上**。
 *
 * 四道闸，顺序与 `CardStack.ensureMotionForCurrent` **逐字相同**（顺序有意义：
 * `empty-id` 最便宜、`budget` 是最后一道；顺序不同只会改日志里的拒绝原因，
 * 但它决定了"上界用尽时日志说哪一句话"，不该随手换）。
 *
 * ⚠️ 这次调用**不代表探测已经发出去了**：调用点接着要去取宿主 Context，那一步可能
 * 失败（抛异常 / 返回 undefined）。本函数**刻意**在这个时候就把 `tries` +1：
 *   · 上界的作用是"这张卡不会被无限重试"，而不是"只数真正发出去的 IPC"；
 *   · 少一个计数器就少一处可以写错的地方（"同步失败要不要计数"是一个没人会记得的约定）。
 * 所以 `tries` 的语义是"**尝试**次数"，`state.tries` 在 `allowed = true` 时就是这次的序号。
 *
 * ⚠️ 本函数**不**碰 `concludedId`（只有 `armMotionProbe` 才清它，因为"结论"要一直留到
 * 换卡为止）—— 但闸 ① 已经保证"这张没定过论"，所以清不清对这张卡都不可观测。
 */
export function beginMotionProbe(
  s: MotionProbeState, id: string, maxAttempts: number
): MotionProbeBegin {
  // ① 没有 photoId：没有可探的对象（不是失败，也不是"探过了"）。
  if (id === '') {
    return { allowed: false, deny: 'empty-id', state: s };
  }
  // ② 已经**下过结论**（含"确定不是动态照片"）→ 不再探。这是"结论"与"没探到"的分界。
  if (s.concludedId === id) {
    return { allowed: false, deny: 'concluded', state: s };
  }
  // ③ 已有一条在途 → 不并发重发（保证任意时刻最多 1 条在途 IPC）。
  if (s.inFlightId === id) {
    return { allowed: false, deny: 'in-flight', state: s };
  }
  // ④ 重试上界。`>=` 而不是 `>`：`maxAttempts = 0` 表示"这次访问一次都不许探"。
  if (s.tries >= maxAttempts) {
    return { allowed: false, deny: 'budget', state: s };
  }
  const next: MotionProbeState = {
    concludedId: s.concludedId,
    inFlightId: s.inFlightId,
    tries: s.tries + 1
  };
  return { allowed: true, deny: 'none', state: next };
}

/**
 * 「这次探测真的发出去了」—— 置在途标记并发出凭据。
 *
 * 它与 `beginMotionProbe` **分开**是必须的：中间隔着一步平台调用（取宿主 Context），
 * 而那一步失败时**绝不能**置在途（否则这张卡会被闸 ③ 永久挡住，而闸 ② 又没写结论
 * —— 那就成了 D4 的另一种死法）。
 *
 * 它同时做 `CardStack.releaseMotion()` 里那两件"为新探测腾位置"的事（**同步发生**）：
 *   · 清 `concludedId` —— 上一次的结论不属于这一次（闸 ② 已保证它不是这张的，所以是幂等的）；
 *   · 清 `inFlightId` 再写新的 —— 换卡时可能残留旧卡的在途标记。
 * ⚠️ **不碰 `tries`**：那是预算。放在这里清零等于"每次尝试都把上界清掉"
 *    （`CardStack` 那边有一模一样的注释，指向同一个坑）。
 *
 * `seq` 必须是调用方**刚刚递增出来**的新序号；本模块不生成它（见文件头的边界说明）。
 */
export function armMotionProbe(s: MotionProbeState, id: string, seq: number): MotionProbeArm {
  const next: MotionProbeState = {
    concludedId: '',
    inFlightId: id,
    tries: s.tries
  };
  const ticket: MotionProbeTicket = { id: id, seq: seq };
  return { ticket: ticket, state: next };
}

/**
 * 一条探测结果回来了 —— **第一件事是判定它还算不算数**，第二件事才是它算哪一类。
 *
 * ── 三条过期判据（**一条都没有删**，与 `fix-batch-37` 逐字同源）────────────────
 *   ① `ticket.seq !== currentSeq` —— 期间又发起过一次探测 / 换过卡
 *      （`CardStack.releaseMotion` 会 +1）。**这一条不可省**：换卡时若旧卡与新卡
 *      恰好是同一个 id（滑走再滑回来），判据 ② 与 ③ 都会为假，只有序号能分辨。
 *   ② `s.inFlightId !== ticket.id` —— 这条结果对应的那次探测已经不是"当前在途"的那次。
 *   ③ `currentId !== ticket.id` —— 这张卡已经被换走。
 *   三条都**独立充分**：任一条成立就丢弃。
 *
 * ── ⚠️ 判据 ② 为什么用 `inFlightId` 而**不是** `concludedId`（本批最关键的一条）────
 *   fix-batch-37 之前，这第三个条件读的是"已下结论"那个字段（当时的 `motionForId`，
 *   一个字段两用）。拆状态之后若照抄旧写法，就会出现这个死法：
 *   **一次成功的重试**在 `settle` 里先写下了"已结论"，于是同一次 `settle` 后面任何
 *   再读 `concludedId` 的地方都会认为"这条结果对应的探测已经不是当前那次" →
 *   **结果被误判过期、到手的句柄被当场释放** → 角标永远不亮，而日志写的是"结果已过期"。
 *   `inFlightId` 的语义是"**在途**"，它只在"这条结果被接受"时被清空 —— 于是
 *   "成功重试"与"过期结果"在状态上**不可能同形**。这是拆成两个字段之后必须同步改的一处。
 *
 * ── 三条判据都不成立时（结果被接受）────────────────────────────────────────
 *   先**解除在途标记**（成败都算：这次探测到此结束，此后只看 `concludedId` 说话），再分流：
 *   · `hasHandle`      → `ready`（正结论）→ 写结论；
 *   · `!hasHandle && concluded` → `negative`（负结论）→ 写结论；
 *   · `!hasHandle && !concluded` → `missed`（瞬时失败）→ **不写结论** ⇒ 允许重试。
 *
 * ⚠️ 判 `hasHandle` 在前、`concluded` 在后，与 `CardStack.onMotionLoaded` 的
 *    `if (h === undefined)` 逐字同款：**对象到手就是正结论**，不需要 data 层再说一遍。
 *
 * ⚠️ 上界**不在这里生效**：`tries` 已经用满时，第 N 次探测的结果**照样**被接受。
 *    否则"把预算用满"就等于"这张卡永远不可能成功"。
 */
export function settleMotionProbe(
  s: MotionProbeState,
  ticket: MotionProbeTicket,
  currentId: string,
  currentSeq: number,
  v: MotionProbeVerdict
): MotionProbeSettle {
  if (ticket.seq !== currentSeq || s.inFlightId !== ticket.id || currentId !== ticket.id) {
    // **状态一字不动**：过期结果既不得写结论，也不得动在途标记（它属于**新的**那次探测）。
    return { outcome: 'stale', state: s };
  }
  if (!v.hasHandle) {
    if (v.concluded) {
      // 确定性**负**结论：只有这一支（除正结论外）写 concludedId —— 此后这张不再探测，
      // 这是真正省下一次查库的那一支。
      const done: MotionProbeState = {
        concludedId: ticket.id, inFlightId: '', tries: s.tries
      };
      return { outcome: 'negative', state: done };
    }
    // **瞬时失败**：不写结论 ⇒ 下一次与这张卡的交互**可以**再发起一次（上界见常量说明）。
    const missed: MotionProbeState = {
      concludedId: s.concludedId, inFlightId: '', tries: s.tries
    };
    return { outcome: 'missed', state: missed };
  }
  // 正结论：句柄到手。句柄本身**不进本模块** —— 调用点据 `outcome === 'ready'` 接管它。
  const ready: MotionProbeState = {
    concludedId: ticket.id, inFlightId: '', tries: s.tries
  };
  return { outcome: 'ready', state: ready };
}

/**
 * 「放手当前这份结论 / 在途」—— 清 `concludedId` 与 `inFlightId`，**保留 `tries`**。
 *
 * 对应 `CardStack.releaseMotion()` 的状态那一半（另一半是平台动作：`motionSeq` +1、
 * 放手 `MotionHandle`、`motionReady = false`）。两者必须一起做，理由是一个真实的死法：
 * **在途标记与"已下结论"是两个字段（D4），所以必须一起清** —— 只清结论不清在途，
 * 下一次探测会被闸③ 挡在门外（"在途"永远为真）；只清在途不清结论，
 * 下一次探测会被闸② 挡住（"这张已经探过了"）。
 *
 * ⚠️ **刻意不动 `tries`**：`ensureMotionForCurrent` 每次尝试都会在发出去之前调它一次，
 *    在这里清零等于**每次尝试都把重试上界清掉** —— 上界就形同虚设。
 *    预算的唯一重置点是"换卡 / 卸载"（`newMotionProbeState()`）。
 */
export function releaseMotionProbe(s: MotionProbeState): MotionProbeState {
  const next: MotionProbeState = {
    concludedId: '', inFlightId: '', tries: s.tries
  };
  return next;
}

/** 这张卡**已经下过结论**吗（→ 角标与长按闸门读的就是它）。`id = ''` 恒为 false。 */
export function isMotionConcluded(s: MotionProbeState, id: string): boolean {
  if (id === '') { return false; }
  return s.concludedId === id;
}

/** 这张卡**有一条在途探测**吗。`id = ''` 恒为 false。 */
export function isMotionInFlight(s: MotionProbeState, id: string): boolean {
  if (id === '') { return false; }
  return s.inFlightId === id;
}

/** 本次访问已用掉的尝试次数（上界见 `MOTION_PROBE_MAX_ATTEMPTS`）。 */
export function motionAttempts(s: MotionProbeState): number {
  return s.tries;
}

/** 还有几次尝试可用（`maxAttempts` 已经用尽时返回 0，不会返回负数）。 */
export function motionAttemptsLeft(s: MotionProbeState, maxAttempts: number): number {
  const left: number = maxAttempts - s.tries;
  return left > 0 ? left : 0;
}
