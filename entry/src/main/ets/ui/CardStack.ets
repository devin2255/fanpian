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

@Component
export struct CardStack {
  @Prop item: QueueItem;
  @Prop cardWidth: number = 360;   // 由父组件经 onAreaChange 传入真实宽度，见 settle()
  onDecide: (photoId: string, action: string, rolledBack: boolean) => void = () => {};
  @State dx: number = 0;
  @State dy: number = 0;
  @State animating: boolean = false;   // 飞出动画期间为真，作为手势闸门（Ruling 27）；回弹不计入
  private lastX: number = 0;
  private lastT: number = 0;
  private velocity: number = 0;
  private flyTimer: number = -1;       // flyOut 的 setTimeout 句柄，卸载时必须清掉（Ruling 28）

  aboutToAppear(): void {
    this.dx = 0;
    this.dy = 0;
    this.velocity = 0;
  }

  // 组件卸载（用户 230ms 内返回上一页）后不能再回调 onDecide。
  aboutToDisappear(): void {
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); this.flyTimer = -1; }
  }

  build() {
    Column() {
      Image(this.item.thumbUri)
        .width('100%').height('100%')
        .objectFit(ImageFit.Cover)
        .borderRadius(16)
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
          if (this.animating) { return; }        // Ruling 27：飞出动画期间不接受新手势
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
    animateTo({ duration: 220, curve: Curve.EaseOut }, () => {
      this.dx = dir * 600;
      this.dy = this.dy + 40;
    });
    if (this.flyTimer !== -1) { clearTimeout(this.flyTimer); }
    this.flyTimer = setTimeout(() => {
      this.flyTimer = -1;
      this.onDecide(this.item.photoId, dir > 0 ? 'fav' : 'archive', false);
      // 组件实例会被复用给下一张卡片（aboutToAppear 不会再跑），必须在这里归位。
      this.dx = 0;
      this.dy = 0;
      this.animating = false;
    }, 230);
  }

  private springBack(): void {
    // 回弹 = 用户犹豫过，计入回弹率
    this.onDecide(this.item.photoId, 'none', true);
    animateTo({ duration: SPRING_BACK_MS, curve: Curve.Friction }, () => {
      this.dx = 0;
      this.dy = 0;
    });
  }
}
