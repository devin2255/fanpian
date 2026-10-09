import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { DecisionStore } from '../data/decisionStore';
import { SessionStore, takeSession } from '../data/sessionStore';
import { LocationIndex, LocationEntry } from '../data/locationIndex';
import { CardStack, QueueItem, CardEvent, SwipeRollback } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';
// 会话模型（product：没有认领动作，改为"指定张数 → 抽样 → 刷完问是否继续"）。
// 本页**消费**上一页存下的会话：cursor 是位置的唯一真相，advance 是唯一的"刷过一张"操作，
// isSessionDone 定义完成态，currentPhotoId 回答"当前该刷哪张"。
import { SwipeSession, isSessionDone, currentPhotoId, advance } from '../core/session';

// 卡片占「可用高度」的比例（与 CardStack.ets 的 .height('62%') 必须一致）。
// settle() 的位移阈值与 navOut() 的翻出距离都以「卡高」为基准（NAV_DISTANCE_RATIO = 0.28 是
// 卡高比例），而 onAreaChange 量到的是整个 Stack 的高（页面高减去顶部行），所以这里要乘回该比例。
// 横向模型取消后不再有宽度换算：宽度只影响布局，不参与任何阈值。
const CARD_HEIGHT_RATIO = 0.62;

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
  // 落盘防抖：内存 Map 是权威副本，落盘合并成 1 秒窗口内最多一次。
  // 每滑一张就 loadAll() + saveAll() 是「全量读 + 全量写」的同步 I/O，且跑在 UI 线程上；
  // Task 7 的「手感挺好」是在无落盘时测的，加落盘后必须把 I/O 从每决策 2 次压到每秒至多 1 次。
  private saveTimer: number = -1;
  private pendingSave: boolean = false;
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
    this.shownAt = Date.now();

    // 地点索引：增量读取 EXIF（时间 + GPS），供地图墙使用。
    // 不 await：它是后台性质的工作，不该阻塞刷卡页首帧。
    //
    // 输入 = 本会话的队列。任务书这里写的是 `claimed.photos`（ClaimStore.load() 的结果），
    // 那是「认领流程」还在时的写法：Task 8 之后本页已经不再读 ClaimStore（池子与抽样都在首页完成，
    // 本页只消费 takeSession() 取回的那一局），所以「已有的、在内存里的照片清单」就是 session.queue
    // —— 同样满足「复用现有变量、不要重复读盘」这条要求。它比 claimed 更贴合地图墙要看的东西：
    // 用户这次真正在刷的就是这一批。buildFrom 只读入参、不改它，所以传引用是安全的。
    const idx = new LocationIndex(this.ctx);
    idx.buildFrom(session.queue)
      .then((list: LocationEntry[]) => {
        let withGps = 0;
        for (let i = 0; i < list.length; i++) {
          if (list[i].lat !== 0 || list[i].lon !== 0) { withGps = withGps + 1; }
        }
        hilog.info(0x0000, 'PhotoWall', '%{public}s', `索引 ${list.length} 条，其中带 GPS ${withGps} 条`);
      })
      .catch((e: Error) => {
        hilog.warn(0x0000, 'PhotoWall', '%{public}s', `地点索引构建失败: ${e.message}`);
      });
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
  }

  build() {
    Column() {
      Row() {
        Text(`剩余 ${this.items.length - this.session.cursor}`).fontSize(13).fontColor('#666').layoutWeight(1)
        Text(`中位 ${this.medianMs}ms  回弹 ${this.rollbackPct}%`).fontSize(12).fontColor('#999')
        Button('收藏').fontSize(12).height(28).margin({ left: 10 })
          .onClick(() => { router.pushUrl({ url: 'pages/FavPage' }); })
      }.width('100%').padding(12)

      Stack() {
        // 完成态放在前面，卡片分支是它的 else —— 让"会话刷完 ⟺ 不渲染卡片"成为结构事实，
        // 空会话（queue 为空 → isSessionDone 为真）也因此不可能去取 items[0] 而越界。
        if (isSessionDone(this.session)) {
          Column() {
            Text('本会话刷完').fontSize(18).fontColor('#666')
            // 池子比要刷的张数少时（用户取消了补货）本会话会短一些，这里如实报数，
            // 免得用户以为"我要 100 张，怎么刷了 30 张就完了"是丢照片。
            Text(`本次共 ${this.items.length} 张`).fontSize(12).fontColor('#999').margin({ top: 6 })
            // 「继续刷 N 张」= 回首页（router.back()），而不是就地再抽一批。
            // 理由：抽样这件事只有一个正门 —— 张数选择 + 池子不够时的补货都在首页，
            // 就地重抽要么在刷照片页复制一份"读池子/补货/抽样"的逻辑（两处判据迟早漂移），
            // 要么就会绕过张数选择（用户没法改主意）。回首页还顺带把
            // 「这局刷完了，下一局要不要换个张数」这个决定权交回给用户，而张数已经在
            // AppStorage 里存着，首页打开时就是同一个数（见 pages/ClaimPage.ets 的 SIZE_KEY）。
            if (this.session.size > 0) {
              Button(`继续刷 ${this.session.size} 张`)
                .fontSize(14).height(40).width(200)
                .backgroundColor('#1F6FEB').fontColor('#FFFFFF')
                .margin({ top: 16 })
                .onClick(() => { this.goHome(); })
            } else {
              // 取不到会话的兜底态（见 aboutToAppear）：没有可继续的张数，给一个诚实的入口
              Button('回首页开始')
                .fontSize(14).height(40).width(200)
                .backgroundColor('#1F6FEB').fontColor('#FFFFFF')
                .margin({ top: 16 })
                .onClick(() => { this.goHome(); })
            }
            // 队尾也必须能回头：否则用户在最后一张上滑之后就再也看不到刚划走的那张，
            // 与「刚划走的还想再看一下要不要上墙」这个核心诉求直接冲突。
            // 但只有在**确实有可回看的照片**时才给这个按钮：会话为空时 cursor === 0，
            // navigate(1) 会在第一道守卫早退，这样渲染出来的是一个点了没反应的死按钮
            // —— 比不显示更糟（用户会以为 App 卡了）。完成态里 cursor 只可能是
            // queue.length（正常刷完）或 0（空会话），所以判据就是 cursor > 0。
            if (this.session.cursor > 0) {
              Button('← 返回上一张').fontSize(14).height(40).width(160)
                .backgroundColor('#1F6FEB').fontColor(Color.White)
                .margin({ top: 12 })
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
    .width('100%').height('100%').backgroundColor('#FAFAFA')
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
    // 位置在 recordSwipe 之后、applyDecision 之前：重复事件仍会进 metrics，但 'wall'
    // 已不参与滑动口径（见 core/metrics.ts），故不会污染回弹率与中位数。
    const already = this.decisions.get(photoId);
    if (already !== undefined && already.state !== 'unseen') {
      const atSlot: string = currentPhotoId(this.session);
      if (atSlot === photoId) {
        this.goTo(this.session.cursor + 1);
      }
      return;
    }

    const d = already === undefined ? emptyDecision(photoId) : already;
    // 三个合法动作各自映射：'wall' 必须显式映射为 'wall'，否则会落到 else 的
    // 'archive' 上——照片会被当场上墙，却在盘上被记成归档（决策丢失）。
    // 标注不能写成 `: string`：applyDecision 的第二参是 core/queue.ts 的 Action 联合，
    // 传 string 会编译失败（实测报错 "Argument of type 'string' is not assignable to
    // parameter of type 'Action'"）。这里收窄成实际可达的三值，既过编译又让
    // 「本函数只产出这三种」成为类型事实（将来加分支会被编译器要求显式处理）。
    let nextAction: 'fav' | 'archive' | 'wall' = 'archive';
    if (action === 'fav') { nextAction = 'fav'; }
    else if (action === 'wall') { nextAction = 'wall'; }
    const next = applyDecision(d, nextAction, now);
    this.decisions.set(photoId, next);
    // 落盘改防抖合并：内存 Map 已是权威副本，崩溃/被杀最多丢 1 秒内的决策
    this.scheduleSave();

    this.goTo(this.session.cursor + 1);
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
