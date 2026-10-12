import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DecisionStore } from '../data/decisionStore';
import { SessionStore, takeSession } from '../data/sessionStore';
import { MetricsStore, MetricsLoad } from '../data/metricsStore';
import { LocationEntry } from '../data/locationIndex';
import { PlaceStore } from '../data/placeStore';
import { CardStack, QueueItem, CardEvent, SwipeRollback } from '../ui/CardStack';
import { PlaceOutcome, pickPlace, toastReading } from '../ui/PlacePicker';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { hasPlace, formatPlace } from '../core/placePick';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate, capEvents, MetricsCap } from '../core/metrics';
// 会话模型（product：没有认领动作，改为"指定张数 → 抽样 → 刷完问是否继续"）。
// 本页**消费**上一页存下的会话：cursor 是位置的唯一真相，advance 是唯一的"刷过一张"操作，
// isSessionDone 定义完成态，currentPhotoId 回答"当前该刷哪张"。
import { SwipeSession, isSessionDone, currentPhotoId, advance } from '../core/session';
// 设计令牌（**全项目唯一的视觉取值处**）。本页只换视觉：顶部行的高度、`CARD_HEIGHT_RATIO`
// 的乘数、以及 CardStack 的手势/动画一行未动 —— 见 build() 顶部那段的说明。
import {
  C_ACCENT, C_BG, C_LINE, C_ON_PHOTO, C_SURFACE, C_TEXT, C_TEXT_DIM,
  F_CAPTION, F_LABEL, F_TITLE, LW_BORDER, R_MD, R_SM, S2, S3, S4
} from '../core/designTokens';

// 卡片占「可用高度」的比例（与 CardStack.ets 的 .height('62%') 必须一致）。
// settle() 的位移阈值与 navOut() 的翻出距离都以「卡高」为基准（NAV_DISTANCE_RATIO = 0.28 是
// 卡高比例），而 onAreaChange 量到的是整个 Stack 的高（页面高减去顶部行），所以这里要乘回该比例。
// 横向模型取消后不再有宽度换算：宽度只影响布局，不参与任何阈值。
//
// ⚠️ 本批（batch-41）记一条**算出来的**不变量，专门挡住下一个人拿这个常量去修
//    「照片上方空白太大」（用户反馈的原话是「留那么多空白干什么？」）：
//    `CardStack` 的根 Column 把「卡片 + 按钮行」整体居中，照片又在卡片里居中 ——
//    两重居中叠加之后：照片上沿 = 顶行下沿 + (可用高 − 按钮行 − 照片高)/2，
//    与 `CARD_HEIGHT_RATIO` **完全无关**。改这个数只能移动卡片的上下边，
//    以及被它读走的两个量（位移阈值 = 卡高 × `NAV_DISTANCE_RATIO`；翻出距离 = 卡高 × 1.2），
//    照片一个像素都不动 —— 验算：0.50 / 0.62 / 0.78 三档，照片上沿恒为 293.3pt
//    （376×809.14 屏、1.4396 的横幅照片，脚本 fix-batch-41-layout.mjs 现算，报告 §2）。
//    要缩小那段空白，唯一有效的旋钮是**照片本身变大**，也就是 `ui/CardStack.ets` 的卡宽。
const CARD_HEIGHT_RATIO = 0.62;

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 把 catch 到的值转成一行可打印文本（与 data/locationIndex.ets 的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  // 本会话：**位置的唯一真相**（session.cursor 就是"刷到第几张"）。
  // 刻意不再保留一个 idx 副本：两份进度迟早漂移，而完成态（isSessionDone）、
  // canPrev（cursor > 0）、卡片取值（items[cursor]）三处必须永远指向同一个数。
  // 用 @State 持有整对象：每次换卡都是整对象替换（advance 返回新对象 / 后退时显式构造），
  // 替换即触发重渲染，不依赖对 cursor 的深层观测。
  @State session: SwipeSession = { size: 0, queue: [], cursor: 0 };
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  @State cardH: number = 600;   // 兜底值 = 首帧尚未量出卡高时的假定卡高（与 CardStack 的 @Prop 兜底一致）
  private decisions: Map<string, Decision> = new Map();
  private metrics: MetricsState = emptyMetrics();
  private shownAt: number = Date.now();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  // 必须声明在 ctx 之后：字段初始化按声明顺序执行，提前会拿到 undefined 的 ctx
  private dStore: DecisionStore = new DecisionStore(this.ctx);
  // 「看过」的存取（同一层规矩：内存为权威、落盘防抖）。它必须声明在 ctx 之后，理由同上。
  private sStore: SessionStore = new SessionStore(this.ctx);
  // 手动选地点（本批新增）：上墙时若这张照片没有地点，问用户省→市→县并记下来。
  // 同样声明在 ctx 之后 —— 它内部也会 new LocationIndex(ctx)。
  private pStore: PlaceStore = new PlaceStore(this.ctx);
  // 指标落盘（Task 22）。它必须声明在 ctx 之后，理由同上。
  // 「已淘汰条数」单独存：它是"这份统计覆盖了多少历史"的答案，页面要显示它
  //（淘汰会改变统计口径，见 core/metrics.ts 的 MAX_METRIC_EVENTS）。
  private mStore: MetricsStore = new MetricsStore(this.ctx);
  private metricsDropped: number = 0;
  // ── 进行中的上墙请求（见 beginWall）─────────────────────────────────────────
  // 上墙流程是**异步**的（要先 awaitIdle 确认这张到底有没有 GPS），而卡片按钮在等待期间
  // 仍可点。若不管，同一张被点两次「上墙」就会弹两个选择器（第二个叠在第一个上），
  // 用户取消一个、确认一个，最终状态取决于两个回调谁后到 —— 不可预测。
  // 用一个**递增序号**当凭据：只有"最后一次请求"（wallLiveSeq）的回调与后续步骤才有效，
  // 旧请求在恢复执行时发现凭据已换，静默退出（不弹、不写、不推进）。
  private wallSeq: number = 0;
  private wallLiveSeq: number = 0;
  // 落盘防抖：内存 Map 是权威副本，落盘合并成 1 秒窗口内最多一次。
  // 每滑一张就 loadAll() + saveAll() 是「全量读 + 全量写」的同步 I/O，且跑在 UI 线程上；
  // Task 7 的「手感挺好」是在无落盘时测的，加落盘后必须把 I/O 从每决策 2 次压到每秒至多 1 次。
  private saveTimer: number = -1;
  private pendingSave: boolean = false;
  // 指标自己的脏标记（**不复用** pendingSave）：一次纯回弹/纯翻页没有决策要写，
  // 不该让 flushSave 去全量重写 decisions.json（与 scheduleSeenSave 同理）。
  private metricsDirty: boolean = false;
  private readonly SAVE_DEBOUNCE_MS: number = 1000;

  aboutToAppear(): void {
    // 数据源 = 上一页（首页）存下的会话；取走即清空（takeSession）——
    // 一局会话只能被消费一次，杜绝"再次进入本页时把上一局的队列从头再刷一遍"。
    // 详见 data/sessionStore.ets 的 takeSession 说明。
    const taken: SwipeSession | undefined = takeSession();
    // 取不到会话时的兜底：空队列。唯一入口（pages/ClaimPage 的「开始刷照片」）一定先
    // setSession，所以这是防御性分支 —— 空队列让本页直接进完成态，用户点一下就回首页重开，
    // 而不是在这一页上看到一个读不出内容的卡片位。这里**不**猜着抽样：
    // 抽样必须经过首页的张数选择与（池子不够时的）补货。
    let session: SwipeSession = { size: 0, queue: [], cursor: 0 };
    if (taken !== undefined) { session = taken; }
    // 队列 → 卡片形态。photoId 本身就是 URI（系统选图器回传的就是 file://media/... 的 uri），
    // 所以 thumbUri 直接复用它，与改版前的做法一致。
    // 这里**不**再去重：queue 由 sampleSession 产出，"同一会话内不重复"是 core 的契约
    //（core/session.ts 的 dedupe + pickRandom 的部分 Fisher-Yates，单测「同一会话内不重复」覆盖）。
    // 更要紧的是 items 必须与 queue **一一对应**：本页靠 items[session.cursor] 取卡片，
    // 一旦这里悄悄少放一张，items.length 就小于 queue.length → isSessionDone 永远不为真
    // → 刷到最后会卡在一个"没有卡片、也没有完成态"的页面上（残影般的空态，只能杀 App）。
    // 针对"重复入队"的运行期自愈仍在 handle() 里（第二道防线），不受这里影响。
    const q: QueueItem[] = [];
    for (let i = 0; i < session.queue.length; i++) {
      const pid: string = session.queue[i];
      const one: QueueItem = { photoId: pid, thumbUri: pid };
      q.push(one);
    }
    this.items = q;
    this.session = session;
    // 内存决策表必须从磁盘现状起步（不能是空 Map）：
    //   1) flushSave() 是**全量写**，空 Map 起步会把之前刷过的决策在首次落盘时整表抹掉；
    //   2) handle() 要拿 already 里的 deferCount / decidedAt 才保得住既有状态；
    //   3) navigate(1)（返回上一张）会 decisions.delete + dStore.remove，内存与盘必须同源。
    this.decisions = this.dStore.loadAll();
    // 指标也必须从**盘上的历史**起步（Task 22），理由与上一行完全一致：
    //   1) flushSave() 的指标落盘是**全量写**，空数组起步会把之前刷过的全部事件在首次落盘时抹掉
    //      —— 那正是本批要修的问题（指标要能从历史数据算，而不是只能当场看）；
    //   2) 顶部那行读数（中位 / 回弹）本来就是这个状态的派生量，不一起恢复的话，
    //      进页面时会先显示 0，与本页内存里真实的历史不一致。
    const loadedMetrics: MetricsLoad = this.mStore.load();
    this.metrics = loadedMetrics.state;
    this.metricsDropped = loadedMetrics.dropped;
    this.medianMs = Math.round(medianDecisionMs(this.metrics));
    this.rollbackPct = Math.round(rollbackRate(this.metrics) * 100);
    this.shownAt = Date.now();
  }

  // 与 CardStack 的做法一致：页面卸载后定时器不得再改状态
  aboutToDisappear(): void {
    // 页面退出时把还没落盘的决策强制写下去，否则这次滑动就白刷了
    this.flushSave();
  }

  // aboutToDisappear 只在页面被「销毁」时触发；router.pushUrl 到收藏页时本页只是被盖住、
  // 并不销毁。若不在这里补一手，滑完 1 秒内点「收藏」，FavPage 读盘会读不到刚收藏的那张。
  // 「看过」也挂在同一条收尾链上（见 flushSave）——它同样是"丢了就影响下一局优先级"的状态。
  onPageHide(): void {
    this.flushSave();
  }

  /** 决策只更新内存 Map；落盘合并到 1 秒窗口，避免每滑一张就全量读+写（UI 线程同步 I/O） */
  private scheduleSave(): void {
    this.pendingSave = true;
    this.armSaveTimer();
  }

  /**
   * 「看过」的落盘挂同一个 1 秒窗口，但**不**置 pendingSave。
   * 置了的话，一次纯翻页（没有任何决策）也会让 flushSave 去全量重写 decisions.json：
   * 既是白干的同步 I/O，也让"有待落盘的决策"这个标记失去意义（读它的人会以为有决策待写）。
   */
  private scheduleSeenSave(): void {
    this.armSaveTimer();
  }

  /**
   * 指标的落盘也挂**同一个** 1 秒窗口（Task 22），同样**不**置 pendingSave（理由同上）。
   *
   * 本方法是"指标不在热路径上做 IO"的全部实现，两行都不碰盘：
   *   · `metricsDirty = true` 只置一个布尔；
   *   · `armSaveTimer()` 里 `if (this.saveTimer === -1)` 才 `setTimeout` —— 已有排程时不重置，
   *     所以它是**合并窗口**（连滑期间每秒正好落一次盘），而不是会把落盘无限推迟的尾部防抖。
   * 真正的 `mStore.save()` 只在 flushSave() 里调用（全项目唯一调用点，见那里的注释）。
   */
  private scheduleMetricsSave(): void {
    this.metricsDirty = true;
    this.armSaveTimer();
  }

  /**
   * 开表。关键：只在「还没有排程」时才开 —— 这是合并窗口（throttle），不是纯尾部防抖。
   * 若每次都 clearTimeout 再重开（纯尾部防抖），连续快滑（间隔 < 1s）会把落盘无限推迟：
   * 一路连滑 30 张期间一次都不写，此刻被杀丢的就不是「1 秒内的决策」而是整段连滑，
   * 违背本任务「最多丢 1 秒」的前提。不重置则保证连滑期间每秒正好落一次盘。
   */
  private armSaveTimer(): void {
    if (this.saveTimer === -1) {
      this.saveTimer = setTimeout(() => { this.flushSave(); }, this.SAVE_DEBOUNCE_MS);
    }
  }

  /** 把内存里的决策与「看过」落盘。失败只告警（两个 store 的写盘内部都已 hilog.warn）。 */
  private flushSave(): void {
    if (this.saveTimer !== -1) { clearTimeout(this.saveTimer); this.saveTimer = -1; }
    if (this.pendingSave) {
      this.pendingSave = false;
      // 前提：this.decisions 自 aboutToAppear() 起就持有盘上原有的全部决策（那里是整表赋值），
      // 否则这次「全量写」会把之前刷过的决策抹掉。
      this.dStore.saveAll(this.decisions);
    }
    // 「看过」有自己的脏标记与独立文件（seen.json），只是共用这个窗口与页面退出的时机。
    // 它未脏时内部直接返回，所以这里不必再判一次。
    this.sStore.flush();
    // 指标同理（自己一个文件 metrics.json、自己一个脏标记）。这段是**全项目唯一**的指标写盘点：
    // 它只被 armSaveTimer 的定时器回调、aboutToDisappear、onPageHide 三条收尾路径触达，
    // 刷卡热路径（handle / goTo / putDecision）一次都到不了这里 —— 这就是"不每张都写盘"的证据。
    if (this.metricsDirty) {
      this.metricsDirty = false;
      // 前提：this.metrics 自 aboutToAppear 起就持有盘上原有的全部事件（那里是整体赋值），
      // 否则这次「全量写」会把之前刷过的指标抹掉。
      this.mStore.save(this.metrics, this.metricsDropped);
    }
  }

  build() {
    Column() {
      // ── 顶部行（本批：只换视觉，**不动尺寸**）────────────────────────────────
      // ⚠️ 这一行的**高度必须保持不变**（12vp 上下内边距 + 28vp 的按钮 = 52vp）：
      //    它直接决定下方 Stack 的高度，而 `cardH` 是"量到的 Stack 高 × CARD_HEIGHT_RATIO"
      //    —— 屏幕上的位移阈值与翻出距离都以它为准。所以本批在这行里**只改样式不改高度**：
      //    「收藏」按钮仍是 28vp 高（没有借机把它抬到 44vp 的触摸目标）—— 手感优先。
      // 三个元素的信息层级（左 → 右，由重到轻）：
      //    剩余张数 = `C_TEXT` / 13fp（这一屏唯一的"进度"读数，所以用主文字色）；
      //    中位/回弹 = `C_TEXT_DIM` / 11fp（**给开发者与验收看的**读数，不该与进度抢）；
      //    收藏入口 = 描边小胶囊（导航，不是内容动作）。
      // 旧版这里还有一个隐性问题：「收藏」是 ArkUI 的**默认按钮样式**（系统蓝的实心胶囊）——
      // 那是一个我们没写过、却真实存在的硬编码色，它让"跳页"看起来像"主操作"。
      Row() {
        Text(`剩余 ${this.items.length - this.session.cursor}`).fontSize(F_LABEL).fontColor(C_TEXT).layoutWeight(1)
        Text(`中位 ${this.medianMs}ms  回弹 ${this.rollbackPct}%`).fontSize(F_CAPTION).fontColor(C_TEXT_DIM)
        Button('收藏')
          .fontSize(F_CAPTION).height(28)
          .borderRadius(R_SM)
          .backgroundColor(C_SURFACE).fontColor(C_TEXT_DIM)
          .border({ width: LW_BORDER, color: C_LINE })
          .padding({ left: S3, right: S3 })
          .margin({ left: S2 })
          .onClick(() => { router.pushUrl({ url: 'pages/FavPage' }); })
      }.width('100%').padding(S3)

      Stack() {
        // 完成态放在前面，卡片分支是它的 else —— 让"会话刷完 ⟺ 不渲染卡片"成为结构事实，
        // 空会话（queue 为空 → isSessionDone 为真）也因此不可能去取 items[0] 而越界。
        if (isSessionDone(this.session)) {
          Column() {
            // 「刷完了」是一个**状态**，不是正文：用 F_TITLE 而不是旧版的 18fp + `#666`
            // （旧值其实达标，但"一句话用灰字"读起来像提示，而不像"这一局结束了"）。
            Text('本会话刷完').fontSize(F_TITLE).fontColor(C_TEXT)
            // 池子比要刷的张数少时（用户取消了补货）本会话会短一些，这里如实报数，
            // 免得用户以为"我要 100 张，怎么刷了 30 张就完了"是丢照片。
            Text(`本次共 ${this.items.length} 张`).fontSize(F_LABEL).fontColor(C_TEXT_DIM).margin({ top: S2 })
            // 「继续刷 N 张」= 回首页（router.back()），而不是就地再抽一批。
            // 理由：抽样这件事只有一个正门 —— 张数选择 + 池子不够时的补货都在首页，
            // 就地重抽要么在刷照片页复制一份"读池子/补货/抽样"的逻辑（两处判据迟早漂移），
            // 要么就会绕过张数选择（用户没法改主意）。回首页还顺带把
            // 「这局刷完了，下一局要不要换个张数」这个决定权交回给用户，而张数已经在
            // AppStorage 里存着，首页打开时就是同一个数（见 pages/ClaimPage.ets 的 SIZE_KEY）。
            // 层级：这里是**完成态**，「继续刷」是唯一的主操作 → 实心强调块；
            // 「返回上一张」是回看（次要）→ 描边胶囊。旧版两个都是系统默认的蓝色实心块，
            // 于是"结束这一局"与"再看一眼刚划走的"一样重。
            if (this.session.size > 0) {
              Button(`继续刷 ${this.session.size} 张`)
                .fontSize(F_LABEL).fontWeight(FontWeight.Medium).height(44).width(220)
                .borderRadius(R_MD)
                .backgroundColor(C_ACCENT).fontColor(C_ON_PHOTO)
                .margin({ top: S4 })
                .onClick(() => { this.goHome(); })
            } else {
              // 取不到会话的兜底态（见 aboutToAppear）：没有可继续的张数，给一个诚实的入口
              Button('回首页开始')
                .fontSize(F_LABEL).fontWeight(FontWeight.Medium).height(44).width(220)
                .borderRadius(R_MD)
                .backgroundColor(C_ACCENT).fontColor(C_ON_PHOTO)
                .margin({ top: S4 })
                .onClick(() => { this.goHome(); })
            }
            // 队尾也必须能回头：否则用户在最后一张上滑之后就再也看不到刚划走的那张，
            // 与「刚划走的还想再看一下要不要上墙」这个核心诉求直接冲突。
            // 但只有在**确实有可回看的照片**时才给这个按钮：会话为空时 cursor === 0，
            // navigate(1) 会在第一道守卫早退，这样渲染出来的是一个点了没反应的死按钮
            // —— 比不显示更糟（用户会以为 App 卡了）。完成态里 cursor 只可能是
            // queue.length（正常刷完）或 0（空会话），所以判据就是 cursor > 0。
            if (this.session.cursor > 0) {
              Button('← 返回上一张').fontSize(F_LABEL).height(44).width(180)
                .borderRadius(R_MD)
                .backgroundColor(C_SURFACE).fontColor(C_TEXT_DIM)
                .border({ width: LW_BORDER, color: C_TEXT_DIM })
                .margin({ top: S3 })
                .onClick(() => { this.navigate(1); })
            }
          }
        } else {
          CardStack({
            item: this.items[this.session.cursor],
            cardHeight: this.cardH,
            canPrev: this.session.cursor > 0,
            onDecide: (photoId: string, ev: CardEvent | SwipeRollback) => {
              this.handle(photoId, ev);
            },
            // 「主页面」= 回首页。导航不在 onDecide 的内容事件流里（见 CardStack 的 onHome）。
            onHome: () => { this.goHome(); }
          })
        }
      }
      .layoutWeight(1).width('100%')
      .onAreaChange((oldVal: Area, newVal: Area) => {
        // 量到的是 Stack 的高（页面高减去顶部行），换算成卡高再交给 CardStack：
        // 位移阈值与翻出距离都以卡高为基准。
        const h = Number(newVal.height);
        if (h > 0) { this.cardH = h * CARD_HEIGHT_RATIO; }
      })
    }
    .width('100%').height('100%').backgroundColor(C_BG)
  }

  /**
   * ── 换卡出口：全页**唯一**改变进度的地方，也是「看过」记账的唯一位置 ─────────────
   *
   * 为什么记账点必须在这里，而不是在动作按钮里：产品要求「每刷过一张（无论用户是否点了
   * 动作按钮）都标记为已看过」。若把标记写进 handle() 的决策分支，那么"滑过去没做决定"的
   * 照片永远不会被记为看过，抽样优先级立刻失真 —— 它们会一直以"没见过"的身份被优先抽中，
   * 而这恰恰是用户最不想再看到的那批。所以标记必须落在**离开这张**的那一刻，
   * 而不是「对这张做了决定」的那一刻。
   *
   * 覆盖性论证：本页所有会让「当前这张」被换掉的路径，都只能通过改 this.session 的 cursor
   * 实现，而 this.session 在初始化之后**只有本函数**赋值（字段初值与 aboutToAppear 的
   * 初始化在外）。于是枚举 cursor 的写入点就等于枚举全部离开路径：
   *   1) 点动作按钮（归档 / 上墙 / 收藏）→ handle() 决策分支 → goTo(cursor + 1)
   *   2) 上滑翻页（下一张）→ handle() 的 'nav' 分派 → navigate(-1) → goTo(cursor + 1)
   *   3) 下滑回看（上一张）→ handle() 的 'nav' 分派 → navigate(1) → goTo(cursor - 1)
   *      —— 这条最容易漏：它是"往回走"，但同样把当前这张丢下了（用户已经看过它）。
   *         漏掉它，"看过"里就会缺掉所有被回看跳过的照片。
   *   4) 重复上报的自愈分支（同一张被重复入队时跳过它）→ goTo(cursor + 1)
   *   5) 完成态里点「← 返回上一张」→ navigate(1) → goTo(items.length - 1)：
   *      此时没有"当前那张"（cursor === queue.length），下面的越界判断直接跳过记账。
   *
   * 两个被否掉的候选记账点（都不可用）：
   *   - onPageHide：本页被 pushUrl 盖住（例如点「收藏」进收藏页）时也会触发，而那时
   *     当前这张**还在屏幕上**，用户回来还能决定它 —— 提前记成"看过"是错的。
   *   - aboutToDisappear：同样把"离开这张"与"离开这一页"混为一谈，且队尾那张根本没被离开。
   *
   * 记账一律发生在改 cursor **之前**：改完再从 items[cur] 取就取到下一张了。
   */
  private goTo(next: number): void {
    const cur: number = this.session.cursor;
    if (cur >= 0 && cur < this.items.length) {
      // 离开 items[cur]：点了动作按钮、上滑、下滑回看，都走这一行。
      // 传单元素数组（SessionStore.markSeen 是批量签名），
      // 于是"记账次数"与"离开过的照片张数"严格一一对应。
      this.sStore.markSeen([this.items[cur].photoId], Date.now());
      this.scheduleSeenSave();
    }
    // 换卡。前进走 core 的 advance（会话模型里「刷过一张」正是这个操作，它返回新对象、
    // 不共享 queue 数组）；后退 core 没有对应函数（advance 只 +1），只能显式构造一个新会话
    // —— 内容与顺序都不动，只改 cursor。两支都**不**改 this.items（队列的卡片形态，
    // 会话期间恒定），所以 items.length === session.queue.length 始终成立，
    // 这正是上面用 items[cur] 取卡片、下面用 items[cursor] 渲染卡片的安全前提。
    if (next === cur + 1) {
      this.session = advance(this.session);
    } else {
      this.session = { size: this.session.size, queue: this.session.queue.slice(), cursor: next };
    }
    // 决策耗时基线：不重置的话下一张的「决策耗时」会从这张的显示时刻起算，污染 medianDecisionMs
    this.shownAt = Date.now();
  }

  /**
   * 卡片上报的唯一入口。按 kind 单向解码分派：
   *   'nav'            → 只翻页（不产生决策、不写盘、不进指标）；
   *   'decide'/'wall'  → 真实决定：进指标 + 落盘 + 推进会话；
   *   'rollback'       → 回弹：只进指标（回弹率的唯一数据源），不消耗队列。
   */
  private handle(photoId: string, ev: CardEvent | SwipeRollback): void {
    // 翻页不产生决策：直接交给 navigate。放在最前 —— 下面的非法 action 守卫与 recordSwipe
    // 都不该被翻页事件触达（翻页既不是动作、也不该进验收指标的样本）。
    if (ev.kind === 'nav') { this.navigate(ev.payload.dir); return; }

    // 回弹只进指标、不消耗队列；真实决策才落盘并推进会话。
    // 判别联合已保证不存在「回弹却带真实决策动作」这种组合（那会让卡片飞走、决策静默丢失）。
    const rolledBack: boolean = ev.kind === 'rollback';
    const action: string = rolledBack ? 'none'
      : (ev.kind === 'wall' ? 'wall'
        : (ev.kind === 'decide' ? ev.payload.action : ''));

    // 先挡住非法 action：它既不该被当成归档写盘，也不该进入验收指标
    //（进入 metrics 会污染 medianDecisionMs 的样本与 rollbackRate 的分母）。
    // 守卫必须在 recordSwipe 之前（放到之后会让未知动作污染指标），
    // 并用 rolledBack 放行回弹路径——回弹事件是「回弹率」的唯一数据源，
    // 若把它一并拦掉，回弹率的分子会结构性恒为 0、指标恒显示"达标"。
    // 'wall' 必须一并放行：它是「卡片上直接上墙」这条合法路径（kind: 'wall'，
    // 见 ui/CardStack.ets 的 CardEvent），不是未知动作——漏放行会让按钮点了没反应。
    // 类型层面已由 CardEvent 判别联合保证（'rollback' 不携带 action、'decide'
    // 只携带 'fav' / 'archive'、'wall' 单独一支），此处保留仅为运行期防御：将来若有人
    // 用 `as` 断言绕过类型检查（或退回旧的 onDecide(id, 'none') 形态），这道守卫仍能拦住
    // 未知动作，不让它静默归档或污染指标。
    // 它的地位：对任何合法的 CardEvent / SwipeRollback 取值，这个分支不可达（挡的不是正常路径），
    // 挡的是经 `as` 断言洗过的值——例如 `{kind:'none'} as Object as CardEvent`
    // 这类双重断言仍能编译，类型系统拦不住它。所以它不是「可证不可达」的死代码，
    // 不要因为「类型已保证」就把它删掉。
    if (!rolledBack && action !== 'fav' && action !== 'archive' && action !== 'wall') { return; }

    const now = Date.now();
    this.metrics = recordSwipe(this.metrics, {
      photoId: photoId, shownAt: this.shownAt, decidedAt: now,
      action: action, rolledBack: rolledBack
    });
    // 容量上限（Task 22）：只在**真的淘汰了**的时候才换引用 —— 未超上限时 capEvents 原样返回
    // **同一个数组**（不拷贝），所以这一行在热路径上的成本就是一次比较。
    // 淘汰把窗口向前滚动，淘汰条数累加后在「使用统计」页如实显示（见 core/metrics.ts）。
    const capped: MetricsCap = capEvents(this.metrics.events);
    if (capped.dropped > 0) {
      this.metrics = { events: capped.events };
      this.metricsDropped = this.metricsDropped + capped.dropped;
    }
    // 只置脏 + 开表，**不落盘**（每张都写盘是 UI 线程上的全量同步 I/O）。
    // 放在回弹早退**之前**：回弹事件是回弹率的分子，它同样必须被记下来。
    this.scheduleMetricsSave();
    this.medianMs = Math.round(medianDecisionMs(this.metrics));
    this.rollbackPct = Math.round(rollbackRate(this.metrics) * 100);

    if (rolledBack) { return; }   // 回弹不消耗队列

    // 第二道防线：同一张照片在一次队列里只应被决策一次。
    // 走到这里有两种来源，它们要的 cursor 行为**正好相反**，所以不能一律 return：
    //   (a) 同一次决策被重复上报：翻页的 210ms 翻出窗口由 CardStack 的 animating 闸门挡住；
    //       动作按钮在同一帧内被点两次（例如两指同点）时 @Prop item 要到下一帧才更新，
    //       第二次仍带着**旧 photoId** 进来。这条路上第一条事件已经推进过 cursor，再推进就会
    //       静默跳过一张**未决策**的照片（队列少一张、「剩余」多减一）。
    //   (b) 同一张因**重复入队**再次出现（例如认领时预选项回传的 URI 与首次认领形式不同，
    //       core/claim.ts 的 mergeBatch 按 URI 全等去重会失效）：第一次滑掉它时 cursor 已经前进，
    //       第二次出现时它必然已被决策。若这里只 return 不推进，卡片动画照播而序号不动
    //       → 同一张无限循环、四个按钮看似失效 = **硬锁**（与刚修完的 decidedId 自锁同类）。
    //       重复入队必须是可自愈的：推进 cursor 把它跳过，用户无感。
    // 判据 = **上报的 photoId 是否仍是当前槽位那张**：是 → 队列把已决策的照片又发了一次，
    // 跳过并前进（自愈）；不是 → 这是对上一张的陈旧重复上报，只 return 不推进。
    // 安全性（可证）：只有「当前槽位那张**已被决策**」时才推进，所以被跳过的必定是已决策项，
    // 这条路径不可能吃掉一张未决策的照片。
    // 顺带守住 cursor 边界：currentPhotoId 在刷完时返回 ''（它内部就是
    // `cursor < 0 || cursor >= queue.length` 的守卫），此时 atSlot 为空串、与任何 photoId
    // 都不相等 → 一律不推进。否则 cursor 会超过 queue.length，顶部会显示「剩余 -1」，
    // 且完成态的「← 返回上一张」（判据 cursor > 0）会去读 items[cursor-1] 而越界。
    // 判据用 state !== 'unseen' 而不是「是否出现过」：core/queue.ts 的 defer 会把照片
    // 重置回 'unseen'（applyDecision 的 skip 分支）——那是有意的重新决策，不能被挡住。
    // 本批只做 fav/archive/wall，SwipePage 不产生 skip/unfav（nextAction 的取值被收窄成三值、
    // 三个动作按钮只传 'archive' / 'fav' / 'wall'），所以今天没有任何路径会把已决策的照片
    // 重新放回队列；将来接上 defer 入队时这条去重会自动放行重决策。
    // 注意 navigate(1)（返回上一张）让照片重新可决定走的是**删掉决策**（内存 delete + 盘上
    // dStore.remove）而不是把它置回 'unseen'：删掉之后这里 get 到 undefined，同样自动放行。
    // 位置在 recordSwipe 之后、applyDecision 之前：重复事件仍会进 metrics。
    // ⚠️ 旧措辞「但 'wall' 已不参与滑动口径……故不会污染回弹率与中位数」是**旧口径**的话，
    // batch-39（58ff624）起不再成立：'wall' 现在**计入回弹率的分母**，只有中位数仍排除它
    //（见 core/metrics.ts 的 rollbackRate / medianDecisionMs）。按现行口径逐条复核：
    //   - 分子（出现过回弹的尝试组）：能走到这道守卫的重复上报都是**决策** —— 回弹根本到不了这里，
    //     handle() 在它上面那支 `if (rolledBack) { return; }` 就早退了，而回弹的重复上报另由
    //     springBack 的 150ms 防抖（SPRING_BACK_MS）挡住。决策的 rolledBack 恒为 false
    //     → 结构上不可能把某一组标成"手滑过"，分子不受影响；
    //   - 分母（尝试组 = photoId|shownAt）：分组只对**同一个键**幂等（见 rollbackRate 注释）。
    //     上面 (a)(b) 两种情形要分开看：(a) 的重复上报发生在 goTo() 之后，shownAt 已被刷成
    //     下一张的时刻 → 会多出一个分组键，幅度与旧口径"每条重复事件给分母 +1"相同，不是
    //     batch-39 引入的（wall 路径的 goTo 在异步 applyWall 里，同帧重复仍是同一个键）；
    //     (b) 本来就是"同一张的第二次出现"，按新口径算 2 个组正是它的定义（见 rollbackRate
    //     注释里"同一张照片在不同时间被独立刷两次 → 算 2 次"）。本批只如实记下，不改逻辑。
    //   - 中位数：'wall' 照旧被排除（口径一字未动）；fav/archive 的重复上报会给样本 +1 ——
    //     那是 medianDecisionMs 注释第 3 条里"有意不修"的同类残留。
    const already = this.decisions.get(photoId);
    if (already !== undefined && already.state !== 'unseen') {
      const atSlot: string = currentPhotoId(this.session);
      if (atSlot === photoId) {
        this.goTo(this.session.cursor + 1);
      }
      return;
    }

    // 「上墙」在本批**不走下面那条同步路径**：它要先确认这张有没有地点，没有就问用户
    //（省→市→县三级下拉），整段是异步的，所以决策由流程终点 applyWall() 落（见 beginWall）。
    // 分支点必须在这道去重守卫**之后**：对同一张的重复 wall 上报要先被上面自愈掉，
    // 否则会给同一张弹两次选择器（第二次叠在第一次上）。
    // 于是到达下面的 action 只可能是 'fav' / 'archive'，类型也据此收窄 ——
    // 传 string 会编译失败（applyDecision 的第二参是 core/queue.ts 的 Action 联合），
    // 收窄成实际可达的两值既过编译，又让"wall 不从这条路径落决策"成为类型事实。
    if (action === 'wall') { this.beginWall(photoId); return; }

    let nextAction: 'fav' | 'archive' = 'archive';
    if (action === 'fav') { nextAction = 'fav'; }
    this.putDecision(photoId, nextAction, now);

    this.goTo(this.session.cursor + 1);
  }

  /**
   * 决策的唯一落盘点：写进内存 Map **并**排程落盘（两件事必须成对，理由见 scheduleSave）。
   *
   * 单独抽出来，是因为本批多了**第二条决策路径**（上墙：先问地点再落决策，见 beginWall）。
   * 两条路径若各抄一份"emptyDecision → applyDecision → set → scheduleSave"，
   * 将来给 Decision 加字段（例如"决策来源"）时必然只改一处 —— 那类偏差不会报错，
   * 只会让一半数据的字段是默认值。所以落盘点只有一个。
   */
  private putDecision(photoId: string, action: 'fav' | 'archive' | 'wall', now: number): void {
    const already: Decision | undefined = this.decisions.get(photoId);
    const d: Decision = already === undefined ? emptyDecision(photoId) : already;
    this.decisions.set(photoId, applyDecision(d, action, now));
    this.scheduleSave();
  }

  /**
   * 「上墙」的第 0 步：确认这张照片**有地点可用**，没有就问用户（省 → 市 → 县）。
   *
   * 为什么要异步、为什么必须 `awaitIdle()`：
   *   地点索引（data/locationIndex.ets）是**后台增量构建**的 —— ClaimPage 开一局时
   *   刻意不 await 就启动它（"它是后台性质的工作，不该阻塞跳转"）。所以用户点「上墙」的
   *   那一刻，这张照片的 EXIF 很可能**还没读**。此刻同步 load() 得到的是半成品索引，
   *   会把"还没读到"误判成"没有 GPS" → 给一张本来有 GPS 的照片弹选择器；而用户一旦选了，
   *   那条 manual 会**永久**压住 EXIF（本批的核心规则，且没有任何入口能撤销）。
   *   所以要等索引稳定（awaitIdle：返回时没有构建在跑）再判。
   *
   * 已知取舍（写进报告）：索引还在构建时点「上墙」会有可感知的等待（首局可能要数秒，
   * 索引要读几百张 EXIF）。用 toast 把"在等什么"说出来，而不是让按钮看起来失灵。
   */
  private beginWall(photoId: string): void {
    this.wallSeq = this.wallSeq + 1;
    const token: number = this.wallSeq;
    this.wallLiveSeq = token;
    // 只有**真的在等**才提示：索引构建没在跑时，awaitIdle() 只花一次 load()，
    // 弹 toast 反而会闪一下。isBuilding() 是"要不要提示"的判据，不是"稳不稳定"的判据
    //（后者只能用 awaitIdle，见它的注释）。
    if (this.pStore.isBuilding()) { toastReading(this.getUIContext()); }
    this.resolveWallPlace(photoId, token);
  }

  /**
   * 上墙流程的中间段（等索引 → 三条守卫 → 有地点就直接上墙，没有就问用户）。
   *
   * 三条守卫缺一不可，每一条都对应"等待期间用户还能操作"这一事实：
   *   ① 凭据：用户可能对**另一张**又点了上墙 —— 旧请求必须作废，否则会给一张已经离开
   *      屏幕的照片弹选择器，用户还以为是给当前这张选的；
   *   ② 已有决策：用户可能已经点了归档/收藏（按钮在等待期间可用）—— 那张已经有结局了，
   *      不该被这次上墙改写（用户后来的明确决定优先于先前的上墙意图）；
   *   ③ 已离开槽位：用户可能上滑翻了页 —— 不能当着**别的**照片弹选择器。
   * 三条都是"放弃本次上墙"，且都**不写盘、不推进**（放弃 = 什么都没发生）。
   */
  private async resolveWallPlace(photoId: string, token: number): Promise<void> {
    // awaitIdle 内部吞掉构建失败的异常（返回盘上现状），所以这里不会抛；
    // 仍然包一层 try：上墙是用户按出来的动作，任何意外都不该让这张卡进入"点了没反应"
    // 且没有任何日志的状态。
    let entry: LocationEntry | undefined = undefined;
    try {
      entry = await this.pStore.entryAfterIdle(photoId);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `上墙前读地点索引失败（按"没有地点"处理）: ${errText(e)}`);
      entry = undefined;
    }
    if (token !== this.wallLiveSeq) { return; }                    // ① 已被更新的一次上墙请求取代
    if (this.decisions.get(photoId) !== undefined) { return; }     // ② 等待期间这张已有别的结局
    if (hasPlace(entry)) {
      // 有地点（EXIF GPS，或此前手选过）→ 直接上墙，与改版前完全一致。
      // 打一行来源日志：真机上这是"手动有没有真的压住 EXIF"最直接的证据。
      hilog.info(DOMAIN, TAG, '%{public}s',
        `上墙：${photoId} 使用${this.pStore.sourceOf(entry) === 'manual' ? '手选' : 'EXIF'}地点`);
      this.applyWall(photoId);
      return;
    }
    if (currentPhotoId(this.session) !== photoId) { return; }      // ③ 已离开这张
    // 没有地点：交给用户选（省→市→县三级下拉）。
    pickPlace(this.getUIContext(), this.ctx, (o: PlaceOutcome) => {
      this.onPlaceResolved(photoId, token, o);
    });
  }

  /**
   * 选择器的结局。**取消必须干净**：不落决策、不推进、不写盘 —— 用户不该因为改主意
   * 而被记上一笔，也不该被推着往前走（卡片留在原位，四个按钮和滑动手势都照常可用：
   * CardStack 的 commit() 只作废"按钮按下时正在途中的那次手势"，不是把这张卡锁死）。
   */
  private onPlaceResolved(photoId: string, token: number, o: PlaceOutcome): void {
    if (token !== this.wallLiveSeq) { return; }
    if (o.kind === 'cancelled') {
      hilog.info(DOMAIN, TAG, '%{public}s', '上墙已取消（未选地点）：未产生决策、未推进队列、未写盘');
      return;
    }
    if (this.decisions.get(photoId) !== undefined) {
      // 结构上到不了（选择器是模态的，弹着的时候点不到别的按钮）；留着是为了万一平台把它
      // 做成非模态：那时用户后来的决定（归档/收藏）不该被他更早的一次上墙覆盖。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `地点已选（${o.hit.province}/${o.hit.city}/${o.hit.county}），但这张已有别的决策，放弃上墙`);
      return;
    }
    // 显示名在这里生成、随地点一起落盘（**不在 setManual 里现算**：那样 core 的 formatPlace
    // 就得被 data 层 import，而"格式"这件事只该有一个定义处，见 core/placePick.formatPlace）。
    // 它必须与 hit 来自同一个对象，所以就在这一行现算 —— 不存在"名字与坐标对不上"的可能。
    const name: string = formatPlace(o.hit);
    const ok: boolean = this.pStore.setManual(photoId, o.hit, name, Date.now());
    if (!ok) {
      // 地点没写进去（photoId 空 / 坐标非法 —— 正常情况下结构上不可达，见 setManual）。
      // 仍然继续上墙：用户点的是「上墙」，那是他的主要意图；地点写失败由上面那行 warn 记录。
      hilog.warn(DOMAIN, TAG, '%{public}s', `手选地点未能写入，本次上墙将没有地点: ${photoId}`);
    } else if (name === '') {
      // 名字为空是**合法但异常**的组合（hit 来自 findCounty，省/市/县都是真名字，不该全空）：
      // 地点已经写进去了（上墙照常），只是地图上这个钉子暂时没有标签。留一行日志便于真机定位。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `手选地点已写入但没有显示名（formatPlace 返回空串）: ${photoId} ${o.hit.province}/${o.hit.city}/${o.hit.county}`);
    }
    this.applyWall(photoId);
  }

  /**
   * 上墙的终点：落决策 + （必要时）推进。**wall 决策只在这里落**。
   *
   * 与 handle() 的滑动决策共用 putDecision()，所以"写内存 + 排程落盘"仍然只有一处；
   * 这里额外管的是**推进条件**：只有这张**仍在当前槽位**时才 goTo(cursor + 1)。
   * 理由：等索引、等用户选地点这段时间里用户可能已经上滑翻页，那时 items[cursor]
   * 已经是另一张照片了，再推进就会**静默跳过一张没被决策的照片** ——
   * 正是 handle() 里那道 atSlot 守卫要防的事，这里必须防同一件事。
   * 不在槽位上时照样落决策（那张照片确实被上墙了）但不推进（新卡的位置已经对了）。
   */
  private applyWall(photoId: string): void {
    const now: number = Date.now();
    this.putDecision(photoId, 'wall', now);
    if (currentPhotoId(this.session) === photoId) {
      this.goTo(this.session.cursor + 1);
    } else {
      hilog.info(DOMAIN, TAG, '%{public}s',
        `上墙已记录但不推进：这张已不在当前槽位（用户在这期间翻过页）: ${photoId}`);
    }
  }

  /**
   * 「主页面」= 回首页（认领页 pages/ClaimPage）。用 router.back() 而不是
   * router.pushUrl({url:'pages/ClaimPage'})：
   *
   * ClaimPage 是用 pushUrl 打开本页的（见 pages/ClaimPage.ets 的「开始刷照片」按钮），
   * 所以本页上面**就是**栈里的 ClaimPage（首屏 @Entry）。back() 弹出本页即回到它
   *（SDK：back() 不带 url 时「returns to the previous page, and the page is not rebuilt」
   * —— ClaimPage 实例还在栈里，回去不需要重建、耗时更短）。完成态的「继续刷 N 张」
   * 也走这条路：回到那个实例，张数选择原样停在同一张数上（另有一份存在 AppStorage 里的
   * SIZE_KEY 兜住"万一被重建"的情形，见 pages/ClaimPage.ets）。
   *
   * 不用 pushUrl：那会往栈里再压一个 ClaimPage，把原来的 ClaimPage 留在下面 ——
   * 首页变成「首页之上还有一个首页」，之后再也回不到底部那一层，返回栈只会越长越深。
   *
   * 落盘链（这条正是我们要的，未落盘的决策与"看过"必须写下去）：
   *   1) 本页是被 pushUrl 压上来的，back() 会把它弹出栈 → 框架先触发 onPageHide()
   *      （SDK：onPageHide 在「router 管理的页面被隐藏」时触发，含路由跳转场景，
   *      见 ets/component/common.d.ts 的 onPageHide 说明）；
   *   2) 页面随即从栈上弹出、实例被回收 → aboutToDisappear() 也会触发。
   * 两条回调都调了 flushSave()，所以同步 I/O 无论如何都会跑一次：即便将来某条路径只触发其中一条，
   * 决策（以及本局的"看过"）也不会留在内存里丢掉 —— 这正是 onPageHide 当初存在的理由。
   * 推论：本方法**不需要**自己调 flushSave()，重复调用只是多一次 pendingSave 检查。
   * 前提：本页的按钮可点时本页必然是栈顶（FavPage 是被 pushUrl 压上来的整页，一旦打开本页就被盖住、
   * 卡片按钮不再可点），所以这里的 back() 弹掉的必定是本页 —— 「弹回本页而非首页」不可达。
   */
  private goHome(): void {
    router.back();
  }

  /**
   * 翻页（卡片上滑 = 下一张 / 下滑 = 上一张）。
   *
   * 上一张的语义是「回到刚看过的那张并让它重新可决定」：所以必须把它的决策从内存与盘上
   * 一并撤销（dStore.remove 是当场写盘，不能只改内存——用户若在 1 秒防抖窗口内杀掉 App，
   * 盘上那条决策还在，下次启动时会被当成"已决策"）。这正是产品要的：回到刚划走的那张，
   * 再看一眼要不要上墙 / 收藏 / 归档。放回抽样下照片本来就会再出现，所以"返回时撤销决策"
   * 依然合理：它让用户能改主意，而不是被自己上一次的手滑锁死。
   * 已知并接受的推论：返回一张**已上墙**的照片后改归档，那条 wall 决策被删掉，
   * 它会从上墙列表消失——这是「用户明确改主意」的正确结果，不加不可逆保护。
   *
   * 关于「看过」：本函数**只**撤销决策，绝不撤销"看过"标记 —— 看过就是看过了。
   * 三条证据：
   *   a) 这里动的只有 decisions（内存）与 dStore（decisions.json），根本没有碰 SessionStore；
   *   b) SessionStore **刻意不提供**"取消看过"的接口（见 data/sessionStore.ets 的 markSeen
   *      注释），所以"连带撤销"在结构上不可达，不靠调用点自觉；
   *   c) 两个 photoId 甚至不是同一张：被撤销决策的是 items[cursor - 1]（**要回去的那张**），
   *      而 goTo 里记账的是 items[cursor]（**要离开的那张**）—— 不存在误伤。
   *
   * 边界：cursor 已在两端时早退（卡片侧也有一道对应的闸门 canPrev，避免白播一次翻出动画）。
   */
  private navigate(dir: number): void {
    if (dir > 0) {
      if (this.session.cursor === 0) { return; }
      const prevIdx: number = this.session.cursor - 1;
      const prevId: string = this.items[prevIdx].photoId;
      this.decisions.delete(prevId);
      this.dStore.remove(prevId);
      this.goTo(prevIdx);
      return;
    }
    if (this.session.cursor >= this.items.length) { return; }
    this.goTo(this.session.cursor + 1);
  }
}
