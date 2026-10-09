import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { ClaimStore } from '../data/claimStore';
import { DecisionStore } from '../data/decisionStore';
import { CardStack, QueueItem, CardEvent, SwipeRollback } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';

// 卡片占「可用高度」的比例（与 CardStack.ets 的 .height('62%') 必须一致）。
// settle() 的位移阈值与 navOut() 的翻出距离都以「卡高」为基准（NAV_DISTANCE_RATIO = 0.28 是
// 卡高比例），而 onAreaChange 量到的是整个 Stack 的高（页面高减去顶部行），所以这里要乘回该比例。
// 横向模型取消后不再有宽度换算：宽度只影响布局，不参与任何阈值。
const CARD_HEIGHT_RATIO = 0.62;

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  @State idx: number = 0;
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  @State cardH: number = 600;   // 兜底值 = 首帧尚未量出卡高时的假定卡高（与 CardStack 的 @Prop 兜底一致）
  private decisions: Map<string, Decision> = new Map();
  private metrics: MetricsState = emptyMetrics();
  private shownAt: number = Date.now();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  // 必须声明在 ctx 之后：字段初始化按声明顺序执行，提前会拿到 undefined 的 ctx
  private dStore: DecisionStore = new DecisionStore(this.ctx);
  // 落盘防抖：内存 Map 是权威副本，落盘合并成 1 秒窗口内最多一次。
  // 每滑一张就 loadAll() + saveAll() 是「全量读 + 全量写」的同步 I/O，且跑在 UI 线程上；
  // Task 7 的「手感挺好」是在无落盘时测的，加落盘后必须把 I/O 从每决策 2 次压到每秒至多 1 次。
  private saveTimer: number = -1;
  private pendingSave: boolean = false;
  private readonly SAVE_DEBOUNCE_MS: number = 1000;

  aboutToAppear(): void {
    const claimStore = new ClaimStore(this.ctx);
    const claimed = claimStore.load();
    const existing = this.dStore.loadAll();
    // 只把「尚未决策」的照片放进队列。否则杀掉 App 重开时，已经刷过的照片会全部
    // 重新出现，用户会认为「我的决策没保存」。
    // 这里用简单过滤，而不是 core/queue.ts 的 buildQueue：buildQueue 要用 takenAt 排序，
    // 而 ClaimedPhoto.takenAt 目前全是 0（EXIF 是 Task 9 的事），交给它排序只会退化成
    // 无意义排序，不如保持现有的「认领顺序倒序」更诚实（Task 9 再接真正的排序）。
    const fresh = claimed.photos.filter((p) => {
      const d = existing.get(p.photoId);
      return d === undefined || d.state === 'unseen';
    });
    // 注意：不能写成 .map((p) => ({ ... })) —— 对象字面量在 map 回调里
    // 拿不到显式声明的类型，ArkTS 会报 arkts-no-untyped-obj-literals。
    const q: QueueItem[] = fresh.map((p): QueueItem => {
      const one: QueueItem = { photoId: p.photoId, thumbUri: p.photoId };
      return one;
    });
    // 真实实现：用 EXIF 拍摄时间排序（Task 9），这里先按认领顺序倒序
    this.items = q.reverse();
    this.idx = 0;
    // 内存决策表必须从磁盘现状起步（不能是空 Map）：
    //   1) flushSave() 是**全量写**，空 Map 起步会把之前刷过的决策在首次落盘时整表抹掉；
    //   2) handle() 要拿 already 里的 deferCount / decidedAt 才保得住既有状态；
    //   3) navigate(1)（返回上一张）会 decisions.delete + dStore.remove，内存与盘必须同源。
    this.decisions = existing;
    this.shownAt = Date.now();
  }

  // 与 CardStack 的做法一致：页面卸载后定时器不得再改状态
  aboutToDisappear(): void {
    // 页面退出时把还没落盘的决策强制写下去，否则这次滑动就白刷了
    this.flushSave();
  }

  // aboutToDisappear 只在页面被「销毁」时触发；router.pushUrl 到收藏页时本页只是被盖住、
  // 并不销毁。若不在这里补一手，滑完 1 秒内点「收藏」，FavPage 读盘会读不到刚收藏的那张。
  onPageHide(): void {
    this.flushSave();
  }

  /** 决策只更新内存 Map；落盘合并到 1 秒窗口，避免每滑一张就全量读+写（UI 线程同步 I/O） */
  private scheduleSave(): void {
    this.pendingSave = true;
    // 关键：只在「还没有排程」时才开表 —— 这是合并窗口（throttle），不是纯尾部防抖。
    // 若每次都 clearTimeout 再重开（纯尾部防抖），连续快滑（间隔 < 1s）会把落盘无限推迟：
    // 一路连滑 30 张期间一次都不写，此刻被杀丢的就不是「1 秒内的决策」而是整段连滑，
    // 违背本任务「最多丢 1 秒」的前提。不重置则保证连滑期间每秒正好落一次盘。
    if (this.saveTimer === -1) {
      this.saveTimer = setTimeout(() => { this.flushSave(); }, this.SAVE_DEBOUNCE_MS);
    }
  }

  /** 把内存 Map 全量写盘。失败只告警（DecisionStore.saveAll 内部已 hilog.warn）。 */
  private flushSave(): void {
    if (this.saveTimer !== -1) { clearTimeout(this.saveTimer); this.saveTimer = -1; }
    if (!this.pendingSave) { return; }
    this.pendingSave = false;
    // 前提：this.decisions 自 aboutToAppear() 起就持有盘上原有的全部决策（那里是整表赋值），
    // 否则这次「全量写」会把之前刷过的决策抹掉。
    this.dStore.saveAll(this.decisions);
  }

  build() {
    Column() {
      Row() {
        Text(`剩余 ${this.items.length - this.idx}`).fontSize(13).fontColor('#666').layoutWeight(1)
        Text(`中位 ${this.medianMs}ms  回弹 ${this.rollbackPct}%`).fontSize(12).fontColor('#999')
        Button('收藏').fontSize(12).height(28).margin({ left: 10 })
          .onClick(() => { router.pushUrl({ url: 'pages/FavPage' }); })
      }.width('100%').padding(12)

      Stack() {
        if (this.idx < this.items.length) {
          CardStack({
            item: this.items[this.idx],
            cardHeight: this.cardH,
            canPrev: this.idx > 0,
            onDecide: (photoId: string, ev: CardEvent | SwipeRollback) => {
              this.handle(photoId, ev);
            }
          })
        } else {
          Column() {
            Text('今天的份刷完了').fontSize(18).fontColor('#666')
            // 队尾也必须能回头：否则用户在最后一张上滑之后就再也看不到刚划走的那张，
            // 与「刚划走的还想再看一下要不要上墙」这个核心诉求直接冲突。
            Button('← 返回上一张').fontSize(14).height(40).width(160)
              .backgroundColor('#1F6FEB').fontColor(Color.White)
              .margin({ top: 16 })
              .onClick(() => { this.navigate(1); })
          }
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
   * 卡片上报的唯一入口。按 kind 单向解码分派：
   *   'nav'            → 只翻页（不产生决策、不写盘、不进指标）；
   *   'decide'/'wall'  → 真实决定：进指标 + 落盘 + 推进 idx；
   *   'rollback'       → 回弹：只进指标（回弹率的唯一数据源），不消耗队列。
   */
  private handle(photoId: string, ev: CardEvent | SwipeRollback): void {
    // 翻页不产生决策：直接交给 navigate。放在最前 —— 下面的非法 action 守卫与 recordSwipe
    // 都不该被翻页事件触达（翻页既不是动作、也不该进验收指标的样本）。
    if (ev.kind === 'nav') { this.navigate(ev.payload.dir); return; }

    // 回弹只进指标、不消耗队列；真实决策才落盘并推进 idx。
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
    // 重复上报会让 idx 连跳、静默跳过照片（按钮与手势两条路径并发时可达：
    // 翻页的 210ms 翻出窗口由 CardStack 的 animating 闸门挡住；动作按钮在同一帧内被点两次
    // ——例如两指同点——则 @Prop item 要到下一帧才更新，第二次仍带着旧 photoId 进来）。
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

    this.idx = this.idx + 1;
    this.shownAt = Date.now();
  }

  /**
   * 翻页（卡片上滑 = 下一张 / 下滑或「← 返回」= 上一张）。
   *
   * 上一张的语义是「回到刚看过的那张并让它重新可决定」：所以必须把它的决策从内存与盘上
   * 一并撤销（dStore.remove 是当场写盘，不能只改内存——用户若在 1 秒防抖窗口内杀掉 App，
   * 盘上那条决策还在，下次启动时 aboutToAppear 会把它当「已决策」过滤掉，
   * 「回去重新决定」的意图就静默失效了）。这正是产品要的：回到刚划走的那张，
   * 再看一眼要不要上墙 / 收藏 / 归档。
   * 已知并接受的推论：返回一张**已上墙**的照片后改归档，那条 wall 决策被删掉，
   * 它会从上墙列表消失——这是「用户明确改主意」的正确结果，不加不可逆保护。
   *
   * 边界：idx 已在两端时早退（卡片侧也有一道对应的闸门 canPrev，避免白播一次翻出动画）。
   */
  private navigate(dir: number): void {
    if (dir > 0) {
      if (this.idx === 0) { return; }
      const prevIdx = this.idx - 1;
      const prevId = this.items[prevIdx].photoId;
      this.decisions.delete(prevId);
      this.dStore.remove(prevId);
      this.idx = prevIdx;
      this.shownAt = Date.now();
      return;
    }
    if (this.idx >= this.items.length) { return; }
    this.idx = this.idx + 1;
    this.shownAt = Date.now();
  }
}
