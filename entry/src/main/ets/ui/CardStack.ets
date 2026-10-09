// 刷照片的核心交互：一张可上下滑动的卡片（spec §5.1；M1 交互模型重构后）。
// 四个已验证的设计事实：
//   1. 上滑 = 下一张、下滑 = 上一张（抖音式翻页），翻页本身不产生决策；但下滑回到刚看过的那张时，
//      会把那张的决策从内存与盘上一并撤销，让它重新可决定（见 pages/SwipePage.ets 的 navigate）；
//   2. 三个动作（归档 / 上墙 / 收藏）与「← 返回」都是卡片外侧下方的按钮，卡片本体只承载翻页手势。
//      左右滑手势全部取消 —— 斜着滑时无法判定方向归属，与上下滑直接冲突；
//   3. 阈值必须同时落在「速度」与「位移」两个维度：轻轻一甩能过，拖到位也能过。
//      基准是**卡高**（不再是卡宽），卡高由父组件经 onAreaChange 传入（见 cardHeight）；
//   4. 队列边界（idx === 0，没有上一张）不播翻出动画而是普通回弹：翻出动画之后父组件只能原样
//      换回同一张，用户看到的是「卡片滑走又原地弹回」，比不响应更像故障（见 canPrev / canNav）。
//
// 另注：卡片翻出的时刻由 setTimeout(...,210) 回调；CardStack 自身不计时，
// 「这张照片显示了多久」由 SwipePage.shownAt 承担（它才是跨卡片持有度量的那一层）。

export const NAV_VELOCITY = 800;         // vp/s：轻轻一甩就翻页
export const NAV_DISTANCE_RATIO = 0.28;  // 卡高比例：拖到位也翻页
export const SPRING_BACK_MS = 150;

// 队列里的一张照片。定义在这里并导出：CardStack 自己要用它，
// SwipePage 也从这里 import（不要各自定义一份）。
export interface QueueItem { photoId: string; thumbUri: string }

/** 翻页方向：dir = 1 上一张（卡片向下走）、dir = -1 下一张（卡片向上走）。 */
export interface NavPayload { dir: number }

/** 一次真实的决定（只由卡片下方的动作按钮触发：归档 / 收藏）。 */
export interface DecidePayload { action: 'archive' | 'fav' }

/**
 * 卡片向父组件上报的事件（判别联合）。用它而非多个独立参数，是为了让**字面量/直赋值形态**的
 * 非法配对在编译期报错：'decide' 必须携带 action、'wall' 与 'nav' 各自携带自己的形态，
 * 所以「决定却不带 action」这类写法过不了编译，而不是被 SwipePage.handle() 的守卫静默丢弃
 *（那会让卡片飞走、决定静默丢失）。
 *
 * 边界（已知且当前无害，勿删消费侧的按 kind 解码）：TS 的多余属性检查只作用于「新鲜」字面量，
 * 因此把一个带多余字段的**变量**传进来仍能编译 —— 这是结构化类型的固有行为，与联合形态的选择无关。
 * 真正的防线是消费侧按 kind 单向解码（见 pages/SwipePage.ets 的 handle）：
 * 未知 kind 走不到任何写盘路径，多余字段也不可能回流影响决策与指标。
 * 另注：本联合不编码「出口 ↔ kind」的对应关系 —— 新增手势/按钮出口时需自行确认
 * 它上报的 kind 与实际行为一致（见 onDecide 上方的出口清单）。
 *
 * 'wall' 分支表示「这张直接上墙，不必先收藏」：用户看到照片的当下就可能已经有上墙判断，
 * 不必被迫先点收藏、再回来找入口。它不携带 action —— 上墙不是方向性决定。
 *
 * 'nav' 分支表示翻页（不产生决策）：dir = 1 上一张、dir = -1 下一张。
 * 注意：'skip' 与删除不在此列 —— 它们不是本页的滑动/按钮动作（跳过在长按菜单、删除另设路径）。
 *
 * ArkTS 硬约束决定了这里只能写成三个「具名 interface」的联合，而非内联对象类型：
 *   - arkts-no-obj-literals-as-types：内联对象字面量不能作为类型声明；
 *   - arkts-no-untyped-obj-literals：对象字面量必须对应显式声明的 class/interface，
 *     所以调用点用显式标注的局部变量构造，不把字面量直接塞进联合类型的参数位。
 * 这两条只影响「怎么写」，不改变上面「边界」所述的判别范围。
 */
export interface CardDecide { kind: 'decide'; payload: DecidePayload }
export interface CardWall { kind: 'wall' }
export interface CardNav { kind: 'nav'; payload: NavPayload }
export type CardEvent = CardDecide | CardWall | CardNav;

/**
 * 回弹（手势没到阈值，或队首下滑而队列里没有上一张）。它**刻意不是** CardEvent 的一支，
 * 而是与 CardEvent 并列的第二种上报类型：回弹不是「卡片做出的动作」，没有动作语义可判别，
 * 唯一用途是喂 core/metrics.ts 的 rollbackRate —— 「回弹率 < 3%」这条验收指标的**唯一数据源**。
 * 所以它必须继续由 springBack() 上报、必须继续被 SwipePage.handle() 解码
 *（rolledBack = true：只进指标、不消耗队列）。删掉它等于让回弹率的分子结构性恒为 0、指标恒"达标"。
 */
export interface SwipeRollback { kind: 'rollback' }

@Component
export struct CardStack {
  @Prop item: QueueItem;
  // 卡片实际高度（= 父组件量到的可用高度 × 0.62，见 SwipePage.ets 的 CARD_HEIGHT_RATIO）。
  // 600 只是父组件尚未量出高度时的兜底，不是判定依据：位移阈值与翻出距离都以它为准。
  @Prop cardHeight: number = 600;
  // 队列里是否还有上一张（父组件按 idx > 0 传入）。false 时「下滑 / ← 返回」不播翻出动画：
  // 父组件的 navigate(1) 只能早退，卡片飞出去之后会被原样换回同一张 = 用户看到「滑走又弹回」。
  @Prop canPrev: boolean = false;
  // 上报的是一次交互的「结果」：CardEvent（决定 / 上墙 / 翻页）或 SwipeRollback（回弹）。
  // 合法组合由类型编码，字面量形态下传错组合会在编译期报错，而不是运行期被 handle() 的守卫
  // 静默丢弃；变量形态可绕过（见 CardEvent 上方「边界」），且「出口 ↔ kind」对应不在编码范围内
  // —— 新增出口时请自行核对。当前七个出口：
  //   手势上滑 → 'nav'(dir=-1)、手势下滑 → 'nav'(dir=1)（队列边界时改为上报回弹）、
  //   卡片「← 返回」按钮 → 'nav'(dir=1)、「归档」按钮 → 'decide'/archive、
  //   「收藏」按钮 → 'decide'/fav、「上墙」按钮 → 'wall'、回弹 → 'rollback'。
  onDecide: (photoId: string, ev: CardEvent | SwipeRollback) => void = () => {};
  // dx：垂直模型下**没有任何写入路径**（手势只写 dy），保留它只为两件事：
  //   1) .translate({ x: this.dx }) 需要一个显式的横向分量；
  //   2) 所有「这张卡已定案 / 换卡归位」的出口都显式把它置 0 —— 组件实例是复用的
  //      （见 navOut 的 try/finally），万一将来重新引入横向位移，这里保证复用的实例
  //      不会带着旧偏移出现在下一张上。
  @State dx: number = 0;
  @State dy: number = 0;
  @State animating: boolean = false;   // 翻出动画期间为真，作为手势/按钮闸门（Ruling 27）；回弹不计入
  // 已经上报过决策（或翻页）的那张照片 —— 三个动作按钮与「← 返回」在 onDecide **之前**写它。
  // 翻页/决定都**不**设 animating 之外的保护：动作按钮要立即上报、不走 navOut 的 210ms 延迟，
  // 所以多指场景下「另一根手指在途的拖拽」会在 idx 已前进后继续写 dy，抬手时 settle() 会以
  // **新** photoId 上报 → 用户没打算决定的那张被静默消耗（批 15 修的缺陷）。
  // 这张记录是否让某个手势作废，由 isGestureVoided() 按「手势起点」判定（见该方法的说明）。
  private decidedId: string = '';
  // 本次手势「是在哪张卡上开始的」：onActionStart 里无条件记录，每次新手势刷新。
  // 作废判据必须依据它，而不是 this.item.photoId —— 定案/翻页后父组件重渲染会在约一帧内
  // 把 @Prop item 换成另一张，此后 item.photoId 已经不是那张卡了，而在途手势仍属于它：
  // 拿 item 去比会漏掉这个手势，那正是本缺陷的形态（手指会在换卡之后继续产生几百毫秒的 update）。
  private gestureId: string = '';
  private lastY: number = 0;
  private lastT: number = 0;
  private velocity: number = 0;
  private flyTimer: number = -1;       // navOut 的 setTimeout 句柄，卸载时必须清掉（Ruling 28）
  // springBack 的上报防抖窗口句柄：非 -1 表示「同一次回弹」尚未结束（Ruling 29）。
  // 它只影响是否重复上报，不是手势闸门——回弹期间仍可重新拖拽。
  private springTimer: number = -1;

  aboutToAppear(): void {
    this.dx = 0;
    this.dy = 0;
    this.velocity = 0;
  }

  // 组件卸载（用户 210ms 内返回上一页）后不能再回调 onDecide。
  aboutToDisappear(): void {
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); this.flyTimer = -1; }
    // 卸载也是「这张卡的回弹窗口到此为止」：不结束的话，残留 timer 的回调会晚于卸载触发。
    this.endSpringWindow();
  }

  /**
   * 结束当前这张卡的回弹上报窗口。任何「这张卡已经定案 / 已经翻页」的出口都必须调用：
   * 否则残留窗口会让下一张卡在窗口内的首次回弹被误判为「已上报」而静默丢弃
   * → rollbackRate 偏低（指标向"好看"方向失真）。
   * 现有出口：navOut()、三个动作按钮共用的 commit()。
   */
  private endSpringWindow(): void {
    if (this.springTimer !== -1) {
      clearTimeout(this.springTimer);
      this.springTimer = -1;
    }
  }

  /**
   * 这个手势是否已作废（不得再写 dy，也不得在 settle() 里上报）。
   * 两条互补判据，缺一不可：
   *   1) 手势起点卡就是刚定案的那张（decidedId 只由三个动作按钮写，翻页不写）—— 按钮路径必须
   *      **当场**作废：从按钮点击到 @Prop item 换卡之间还隔着约一帧，在途手指能在这段窗口里
   *      把 dy 写歪，而按钮刚显式归过零（见 commit() 里「归零」那段）。
   *   2) 手势起点卡已不是当前显示的那张 —— 换卡本身即作废。它让作废跨过换卡继续有效，
   *      并覆盖「decidedId 被下一次定案覆盖」的情形（两指连点两次按钮：第二次把
   *      decidedId 写成新卡后，判据 1 就认不出第一根手指的在途手势了）；而且不可逆 ——
   *      起点卡再也回不到当前位，所以一个被作废的手势终生作废。这正是不必在
   *      onActionStart 早退的前提：基线照常刷新，但刷新的基线永远用不到决策上。
   * 判据一律看「手势起点」而不是「当前显示的那张」：定案/翻页后约一帧内 item 就会换成
   * 另一张，用 item 比对会漏掉在途手势（它属于旧卡），那个漏网正是本缺陷的形态。
   * 空字符串表示「还没有记录」：此时不作废 —— 宁可少作废也不误作废，
   * 误作废会让这一页的手势整段失灵。
   */
  private isGestureVoided(): boolean {
    if (this.decidedId !== '' && this.gestureId === this.decidedId) { return true; }
    if (this.gestureId !== '' && this.gestureId !== this.item.photoId) { return true; }
    return false;
  }

  /** 翻页闸门：dir = 1（上一张）要求队列里确实还有上一张（canPrev 由父组件按 idx 传入）。 */
  private canNav(dir: number): boolean {
    if (dir > 0) { return this.canPrev; }
    // 下一张永远可达：走完最后一张时父组件会渲染「刷完了」，不再有卡片可以滑。
    return true;
  }

  build() {
    Column() {
      // 卡片本体：照片 + 翻页手势 + 位移。按钮**不在**这里 —— 按钮在卡片外侧下方一行，
      // 既完全不遮挡照片主体，也让手势命中区与按钮命中区互不重叠
      //（按钮不是本节点的子节点 → 点按钮不会同时起一个 PanGesture，手势仲裁最简单）。
      Stack() {
        Image(this.item.thumbUri)
          .width('100%').height('100%')
          .objectFit(ImageFit.Cover)
          .borderRadius(16)
      }
      // 62% 与 SwipePage.ets 的 CARD_HEIGHT_RATIO 是同一个事实的两处表达：
      // 改一处必须改另一处。父组件量到 Stack 高之后乘 0.62 作为 cardHeight 传进来，
      // 所以 @Prop cardHeight 与本节点的高度是同一个值（不是估算）。
      .width('100%').height('62%')
      .backgroundColor('#EEE')
      .borderRadius(16)
      .translate({ x: this.dx, y: this.dy })
      .gesture(
        PanGesture({ fingers: 1, distance: 5 })
          .onActionStart((e: GestureEvent) => {
            // 基线必须先刷新：若把闸门放在首行，一次跨越 210ms 边界的拖拽会保留
            // 上一次手势的 lastY/lastT，解禁后的首个 update 用陈旧基线算出巨大的
            // 伪速度（|Δ| > NAV_VELOCITY），使新卡片在几十 vp 拖动下被误判翻页。
            // 闸门职责由 onActionUpdate 与 settle() 承担，这里不早退。
            // 同理，作废也不在这里早退 —— 本回调是唯一刷新 lastY/lastT 与 gestureId 的地方：
            //   (a) 跳过基线刷新：一旦「闸门在两次手势之间解除」，解禁后的首个 update 就会用
            //       陈旧基线算伪速度（上一条注释讲的泄漏会原样重演）；
            //   (b) 跳过 gestureId 刷新：作废会自持 —— gestureId 停在旧卡、item 已是新卡，
            //       判据 2 恒真，连新手势也在守卫处被挡，gestureId 再也刷不了
            //       → 整页手势永久死锁（与 navOut 的 try/finally 要避免的死锁同类）。
            // 作废只在 update/settle 两道出口上按 isGestureVoided() 判定，基线照常刷新即可。
            this.gestureId = this.item.photoId;   // 手势归属：本手势是在这张卡上开始的
            this.lastY = e.offsetY;
            this.lastT = Date.now();
            this.velocity = 0;
          })
          .onActionUpdate((e: GestureEvent) => {
            if (this.animating) { return; }
            // 这张卡已定案/已翻页（例如另一根手指刚点了按钮），或本次手势的起点卡已经换走：
            // 作废它的后续手势，否则抬手时的 settle() 会以换卡后的新 photoId 上报，
            // 静默消耗一张用户没打算决定的照片。
            if (this.isGestureVoided()) { return; }
            const now = Date.now();
            const dt = now - this.lastT;
            if (dt > 0) { this.velocity = ((e.offsetY - this.lastY) / dt) * 1000; }
            this.lastY = e.offsetY;
            this.lastT = now;
            this.dy = e.offsetY;   // 只跟手写 dy：横向（dx）在本模型下没有写入路径
          })
          .onActionEnd((e: GestureEvent) => { this.settle(); })
      )

      // 四个按钮：卡片外侧、卡片下方一行等分（layoutWeight(1)）。位置取舍见 M1 报告：
      // 塞进卡片内会压住照片主体（违反「不遮挡」），放在卡片外还顺带避开了与卡片
      // PanGesture 的竞争。顺序按使用频率与危险度排：返回 / 归档 / 上墙 / 收藏。
      Row({ space: 8 }) {
        Button('← 返回')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapNav(1); })
        Button('归档')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapDecide('archive'); })
        Button('上墙')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#1F6FEB').fontColor('#FFFFFF')
          .onClick(() => { this.tapWall(); })
        Button('收藏')
          .fontSize(12).height(40).layoutWeight(1)
          .backgroundColor('#E6E6E6').fontColor('#333333')
          .onClick(() => { this.tapDecide('fav'); })
      }
      .width('100%').height(44)
    }
    // 86% 与 SwipePage.ets 的 CARD_WIDTH_RATIO 曾经是同一个事实的两处表达；横向模型取消后
    // 宽度不再参与任何阈值，那个常量已随之删除，这里的 86% 只是纯布局。
    .width('86%').height('100%')
    // 卡片 + 按钮行作为一个整体居中：比「卡片单独居中」整体上移半个按钮行（约 22vp），
    // 视觉位置与重构前基本一致，同时百分高度有确定的换算基准（= 父组件量到的高度）。
    .justifyContent(FlexAlign.Center)
  }

  private settle(): void {
    if (this.animating) { return; }   // 已在翻出动画中，忽略（防御性；正常路径已被手势闸门挡住）
    // 本次手势的卡已定案/已换走：作废，否则会以换卡后的新 photoId 记一次决定
    //（或记一次挂在下一张头上的伪回弹）—— 按钮路径没有 animating，这里是唯一出口闸门。
    if (this.isGestureVoided()) { return; }
    // 用真实卡高算位移阈值：600 只是父组件尚未量出高度时的兜底，不是判定依据。
    const h = this.cardHeight > 0 ? this.cardHeight : 600;
    const commitDist = h * NAV_DISTANCE_RATIO;
    const fast = Math.abs(this.velocity) > NAV_VELOCITY;
    const far = Math.abs(this.dy) > commitDist;

    if (this.dy < 0 && (fast || far)) {
      this.navOut(-1);          // 上滑 → 下一张
    } else if (this.dy > 0 && (fast || far)) {
      // 下滑 → 上一张。idx === 0（队首）时没有上一张：走普通回弹而不是 navOut ——
      // navOut 会先把卡片送出视野，而父组件的 navigate(1) 只能早退，卡片原地弹回 = 像故障。
      // 这一次手势确实没产生任何动作，所以照常计一次回弹（回弹率的语义就是「滑了但没结果」）。
      if (this.canNav(1)) { this.navOut(1); } else { this.springBack(); }
    } else {
      this.springBack();
    }
  }

  /**
   * 翻页出口：卡片先沿垂直方向移出视野，再在 210ms 后上报 'nav'（不产生决策）。
   * 注意翻页**不设** decidedId（前任论证：收益为零、代价为正 —— 它引入一条不自愈的永久作废
   * 路径）：换卡本身由 isGestureVoided() 的判据 2 作废，且判据 2 不可逆、覆盖所有换卡出口。
   */
  private navOut(dir: number): void {
    this.animating = true;
    // 翻页也是「这张卡到此为止」：不结束回弹窗口，残留窗口会吞掉下一张的首个回弹。
    this.endSpringWindow();
    const h = this.cardHeight > 0 ? this.cardHeight : 600;
    // dir = 1（上一张）卡片向下走；dir = -1（下一张）卡片向上走。
    // 1.2 倍卡高（= 0.744 倍可用高度）**不**足以让卡片完全离开视野（需要约 1.36 倍卡高），
    // 这是刻意的：210ms 的换卡与动画结束只差 10ms，留下的一小条卡片正好遮住「换成新照片」
    // 那一帧（若完全飞出，那一帧会露出页面底色 = 闪一下）。
    const outY = dir > 0 ? h * 1.2 : -h * 1.2;
    animateTo({ duration: 200, curve: Curve.EaseOut }, () => { this.dy = outY; });
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); }
    this.flyTimer = setTimeout(() => {
      this.flyTimer = -1;
      const p: NavPayload = { dir: dir };
      const ev: CardEvent = { kind: 'nav', payload: p };
      // 顺序：先上报（换卡）再归位位置。
      // 若先归位，会出现一帧「旧卡弹回中央」——连拍照片下新旧卡视觉几乎一样，
      // 用户会把「弹回来的旧卡」当成「照片没消失」。
      // try/finally：onDecide 抛错时也必须把闸门放下，否则实例复用会让整页手势死锁。
      try {
        this.onDecide(this.item.photoId, ev);
      } finally {
        // 归位一律**平赋值**，不要用 animateTo：节点被复用，动画会让已换新的照片
        // 继续渲染插值位姿 = 用户看到的「照片跳一下」。
        this.dy = 0;
        this.dx = 0;
        this.animating = false;
      }
    }, 210);
  }

  /**
   * 三个动作按钮（归档 / 上墙 / 收藏）共用的出口。三件事缺一不可：
   *   1) 结束回弹窗口（否则下一张的首个回弹会被残留窗口吞掉）；
   *   2) 平赋值归零位移（拖到一半时点按钮；不要 animateTo，理由同 navOut 的 finally）；
   *   3) **在 onDecide 之前**记下 decidedId —— onDecide 会同步换卡，之后 this.item
   *      已经不是这张卡了，而在途手势（另一根手指）仍以它为起点。判据 1 靠这条记录
   *      当场作废那个手势，否则它会以换卡后的**新** photoId 上报，静默消耗一张照片。
   */
  private commit(ev: CardEvent): void {
    // 与 onActionUpdate / settle() 同口径的闸门：翻出动画期间卡片视觉上已经飞走
    //（用户看到的是下一张的位置），但 idx 要等 navOut 的 210ms 回调才推进 ——
    // 这段窗口里 @Prop item 仍是已经飞走的那张，此刻再点一下（或另一只手指）
    // 会让同一张被上报两次 → SwipePage.handle() 跑两次 → idx 连跳两格
    // → 静默跳过一张照片。所以动画期间一律不接受按钮点击。
    if (this.animating) { return; }
    // 这张卡已定案，或本次在途手势的起点卡已经换走：不再接受新的动作上报。
    if (this.isGestureVoided()) { return; }
    this.endSpringWindow();
    // @State 不随 @Prop item 变化而自动重置 —— 组件实例是复用的（见 navOut 的 try/finally），
    // 新卡不会自己回到 dy = 0，所以归零必须显式做。
    this.dx = 0;
    this.dy = 0;
    // 注意：动作按钮**不**走 navOut() —— 那条路会设 animating 并延迟 210ms 才上报，
    // 而这里要立即上报（用户点的是动作，不是翻页）。所以上面只是把拖到一半的偏移归零，
    // 不涉及 animating；按钮在同一帧内被点两次（两指同点）时 @Prop item 尚未更新、
    // 第二次仍带着旧 photoId，这种重复由 SwipePage.handle() 的同 photoId 去重兜住。
    // 但「另一根手指还在拖这张卡」不同：idx 前进后它会以**新** photoId 上报，
    // 同 photoId 去重拦不住。所以定案必须当场记下，与上报同一个同步块。
    this.decidedId = this.item.photoId;
    this.onDecide(this.item.photoId, ev);
  }

  private tapDecide(action: 'archive' | 'fav'): void {
    const p: DecidePayload = { action: action };
    const ev: CardEvent = { kind: 'decide', payload: p };
    this.commit(ev);
  }

  /** 「上墙」= 当场把这张挂上地图，不必先收藏（上墙是从收藏里精选，两者不是互斥状态）。 */
  private tapWall(): void {
    const ev: CardEvent = { kind: 'wall' };
    this.commit(ev);
  }

  /** 「← 返回」= 下滑同一个出口。没有上一张时点了不响应（不播动画、不计指标）。 */
  private tapNav(dir: number): void {
    if (this.animating) { return; }
    if (this.isGestureVoided()) { return; }
    if (!this.canNav(dir)) { return; }
    this.navOut(dir);
  }

  private springBack(): void {
    // Ruling 29：rolledBack 是「回弹率 <3%」验收指标的唯一数据源，
    // 快速连划不得重复上报同一次回弹；但手势仍可继续（不设 animating）。
    const alreadyReported = this.springTimer !== -1;
    if (!alreadyReported) {
      // 回弹 = 用户犹豫过（或队首下滑没有上一张），计入回弹率（每张卡每个回弹窗口只计一次）
      const out: SwipeRollback = { kind: 'rollback' };
      this.onDecide(this.item.photoId, out);
    }
    // 旧窗口先结束、再开新窗口：等价于原来的「有就清掉、然后重设」，防抖语义不变。
    this.endSpringWindow();
    this.springTimer = setTimeout(() => { this.springTimer = -1; }, SPRING_BACK_MS);

    animateTo({ duration: SPRING_BACK_MS, curve: Curve.Friction }, () => {
      this.dx = 0;
      this.dy = 0;
    });
  }
}
