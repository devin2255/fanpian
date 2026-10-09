// 刷照片的核心交互：一张可拖拽的卡片（spec §5.1）。
// 三个已验证的设计事实：
//   1. 左滑是「归档」不是删除（删除是另一个更慢的动作，Task 8 再做）；
//   2. 垂直手势不承载决策——dy 只跟手/参与飞出，不进入判定；
//   3. 阈值必须同时落在「速度」与「位移」两个维度：轻轻一甩能过，拖到位也能过。
//
// 另注：卡片飞出的时刻由 setTimeout(...,230) 回调；CardStack 自身不计时，
// 「这张照片显示了多久」由 SwipePage.shownAt 承担（它才是跨卡片持有度量的那一层）。

export const COMMIT_VELOCITY = 800;
export const COMMIT_DISTANCE_RATIO = 0.28;
export const SPRING_BACK_MS = 150;

// 队列里的一张照片。定义在这里并导出：CardStack 自己要用它，
// SwipePage 也从这里 import（不要各自定义一份）。
export interface QueueItem { photoId: string; thumbUri: string }

/**
 * 一次滑动的结果（判别联合）。用它而非 (action, rolledBack) 两个独立参数，是为了让
 * **字面量/直赋值形态**的非法配对在编译期报错：'rollback' 分支不携带 action、
 * 'decision' 分支必须携带 action，所以 onDecide(id, 'none', false) 这类写法过不了编译，
 * 而不是被 SwipePage.handle() 的守卫静默丢弃（那会让卡片飞走、决策静默丢失）。
 *
 * 边界（已知且当前无害）：TypeScript 的多余属性检查只作用于「新鲜」字面量，
 * 因此把一个带多余 action 字段的**变量**传给 'rollback' 分支仍能编译通过 ——
 * 这是结构化类型的固有行为，与联合形态的选择无关。
 * 真正的防线是消费侧按 kind 单向解码（见 pages/SwipePage.ets 的 handle）：
 * 回弹分支的 action 恒为常量 'none'，多余字段不可能回流影响决策与指标。
 * 另注：本联合只编码 action↔rolledBack 的配对，不编码「出口↔kind」对应 ——
 * 新增手势出口时需自行确认它上报的 kind 与实际行为一致。
 *
 * 'wall' 分支（kind: 'wall'）表示「这张直接上墙，不必先收藏」：用户看到照片的当下
 * 就可能已经有上墙判断，不必被迫先右滑收藏、再回来点顶部入口。它不含 action 字段 ——
 * 上墙不是方向性决定（没有「滑向哪边」可言），所以它既不复用 'decision' 的
 * action↔配对约束，也不会被 SwipePage 的解码误当成归档。
 *
 * 注意：'skip' 与删除不在此列 —— 它们不是滑动手势（跳过在长按菜单、删除另设路径）。
 *
 * ArkTS 硬约束决定了这里只能写成两个「具名 interface」的联合，而非内联对象类型：
 *   - arkts-no-obj-literals-as-types：内联对象字面量不能作为类型声明；
 *   - arkts-no-untyped-obj-literals：对象字面量必须对应显式声明的 class/interface，
 *     所以调用点用显式标注的局部变量构造，不把字面量直接塞进联合类型的参数位。
 * 这两条只影响「怎么写」，不改变上面「边界」所述的判别范围。
 */
export interface SwipeDecision { kind: 'decision'; action: 'fav' | 'archive' }
export interface SwipeWall { kind: 'wall' }
export interface SwipeRollback { kind: 'rollback' }
export type SwipeOutcome = SwipeDecision | SwipeWall | SwipeRollback;

@Component
export struct CardStack {
  @Prop item: QueueItem;
  @Prop cardWidth: number = 360;   // 由父组件经 onAreaChange 传入真实宽度，见 settle()
  // 上报的是一次滑动的「结果」（SwipeOutcome 判别联合）：合法配对由类型编码，
  // 字面量形态下传错组合（例如回弹却带 action）会在编译期报错，而不是运行期被
  // handle() 的守卫静默丢弃；变量形态可绕过（见 SwipeOutcome 上方「边界」），
  // 且「出口↔kind」对应不在编码范围内 —— 新增出口时请自行核对。
  // 当前四个出口：右滑 → 'decision'/fav、左滑 → 'decision'/archive、
  // 卡片上「上墙」按钮 → 'wall'（当场上墙，不经收藏）、回弹 → 'rollback'。
  onDecide: (photoId: string, outcome: SwipeOutcome) => void = () => {};
  @State dx: number = 0;
  @State dy: number = 0;
  @State animating: boolean = false;   // 飞出动画期间为真，作为手势闸门（Ruling 27）；回弹不计入
  private lastX: number = 0;
  private lastT: number = 0;
  private velocity: number = 0;
  private flyTimer: number = -1;       // flyOut 的 setTimeout 句柄，卸载时必须清掉（Ruling 28）
  // springBack 的上报防抖窗口句柄：非 -1 表示「同一次回弹」尚未结束（Ruling 29）。
  // 它只影响是否重复上报，不是手势闸门——回弹期间仍可重新拖拽。
  private springTimer: number = -1;

  aboutToAppear(): void {
    this.dx = 0;
    this.dy = 0;
    this.velocity = 0;
  }

  // 组件卸载（用户 230ms 内返回上一页）后不能再回调 onDecide。
  aboutToDisappear(): void {
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); this.flyTimer = -1; }
    if (this.springTimer !== -1) { clearTimeout(this.springTimer); this.springTimer = -1; }
  }

  build() {
    Column() {
      // 卡片内容层：照片 + 叠在「卡片内侧底部」的「上墙」按钮。
      // 这里的 Stack 尺寸 = 卡片本身（100% x 100%），所以 alignContent: Bottom
      // 只把按钮放到卡片底边，不会像页面级 Stack 那样把它甩到屏幕底部去
      // （那个坑：卡片居中只占 62% 高，页面级 Bottom 的按钮会离卡片 19% 页高）。
      Stack({ alignContent: Alignment.Bottom }) {
        Image(this.item.thumbUri)
          .width('100%').height('100%')
          .objectFit(ImageFit.Cover)
          .borderRadius(16)

        // 「上墙」= 当场把这张挂上地图，不必先收藏（真机反馈后新增的第三入口）。
        // 位置：卡片内侧底部、半透明（#CC 前缀 = 80% 不透明），只压住照片下沿，
        // 不遮挡主体。它刻意不写自己的 translate/rotate —— 它是卡片根节点的子节点，
        // 随卡片一起位移与倾斜（写了会与父节点的 transform 叠加成双倍位移）。
        Button('上墙')
          .fontSize(13).height(34).width(96)
          .backgroundColor('#CC1F6FEB')
          .margin({ bottom: 12 })
          .onClick(() => {
            const out: SwipeWall = { kind: 'wall' };
            this.onDecide(this.item.photoId, out);
          })
      }
      .width('100%').height('100%')
    }
    // 86% 与 SwipePage.ets 的 CARD_WIDTH_RATIO 是同一个事实的两处表达：改一处必须改另一处。
    .width('86%').height('62%')
    .backgroundColor('#EEE')
    .borderRadius(16)
    .translate({ x: this.dx, y: this.dy })
    .rotate({ angle: this.dx / 24 })
    .gesture(
      PanGesture({ fingers: 1, distance: 5 })
        .onActionStart((e: GestureEvent) => {
          // 基线必须先刷新：若把闸门放在首行，一次跨越 230ms 边界的拖拽会保留
          // 上一次手势的 lastX/lastT，解禁后的首个 update 用陈旧基线算出巨大的
          // 伪速度（|Δ| > 800），使新卡片在几十 vp 拖动下被误判 fav/archive。
          // 闸门职责由 onActionUpdate 与 settle() 承担，这里不早退。
          this.lastX = e.offsetX;
          this.lastT = Date.now();
          this.velocity = 0;
        })
        .onActionUpdate((e: GestureEvent) => {
          if (this.animating) { return; }
          const now = Date.now();
          const dt = now - this.lastT;
          if (dt > 0) { this.velocity = ((e.offsetX - this.lastX) / dt) * 1000; }
          this.lastX = e.offsetX;
          this.lastT = now;
          this.dx = e.offsetX;
          this.dy = e.offsetY;
        })
        .onActionEnd((e: GestureEvent) => { this.settle(); })
    )
  }

  private settle(): void {
    if (this.animating) { return; }   // 已在飞出动画中，忽略（防御性；正常路径已被手势闸门挡住）
    // 用真实宽度算位移阈值：360 只是父组件尚未量出宽度时的兜底，不是判定依据。
    const w = this.cardWidth > 0 ? this.cardWidth : 360;
    const commitDist = w * COMMIT_DISTANCE_RATIO;
    const fast = Math.abs(this.velocity) > COMMIT_VELOCITY;
    const far = Math.abs(this.dx) > commitDist;

    if (this.dx > 0 && (fast || far)) {
      this.flyOut(1);
    } else if (this.dx < 0 && (fast || far)) {
      this.flyOut(-1);
    } else {
      this.springBack();
    }
  }

  private flyOut(dir: number): void {
    this.animating = true;
    // 决策已生效、这张卡的回弹窗口就此结束：残留窗口属于「上一张卡」，
    // 不能让下一张卡（实例复用）的首次回弹被误判为「已上报」。
    if (this.springTimer !== -1) { clearTimeout(this.springTimer); this.springTimer = -1; }
    // 飞出距离按卡宽推导，确保卡片完全离开视野（硬编码 600 在宽屏上可能只挪到边上）
    const w = this.cardWidth > 0 ? this.cardWidth : 360;
    const outX = dir * (w * 1.4);
    animateTo({ duration: 220, curve: Curve.EaseOut }, () => {
      this.dx = outX;
      this.dy = this.dy + 40;
    });
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); }
    this.flyTimer = setTimeout(() => {
      this.flyTimer = -1;
      const act: 'fav' | 'archive' = dir > 0 ? 'fav' : 'archive';
      const out: SwipeDecision = { kind: 'decision', action: act };
      // 顺序：先上报（换下一张卡）再归位位置。
      // 若先归位，会出现一帧「旧卡弹回中央」——连拍照片下新旧卡视觉几乎一样，
      // 用户会把「弹回来的旧卡」当成「照片没消失」。
      // try/finally：onDecide 抛错时也必须把闸门放下，否则实例复用会让整页手势死锁。
      try {
        this.onDecide(this.item.photoId, out);
      } finally {
        this.dx = 0;
        this.dy = 0;
        this.animating = false;
      }
    }, 230);
  }

  private springBack(): void {
    // Ruling 29：rolledBack 是「回弹率 <3%」验收指标的唯一数据源，
    // 快速连划不得重复上报同一次回弹；但手势仍可继续（不设 animating）。
    const alreadyReported = this.springTimer !== -1;
    if (!alreadyReported) {
      // 回弹 = 用户犹豫过，计入回弹率（每张卡每个回弹窗口只计一次）
      const out: SwipeRollback = { kind: 'rollback' };
      this.onDecide(this.item.photoId, out);
    }
    if (this.springTimer !== -1) { clearTimeout(this.springTimer); }
    this.springTimer = setTimeout(() => { this.springTimer = -1; }, SPRING_BACK_MS);

    animateTo({ duration: SPRING_BACK_MS, curve: Curve.Friction }, () => {
      this.dx = 0;
      this.dy = 0;
    });
  }
}
