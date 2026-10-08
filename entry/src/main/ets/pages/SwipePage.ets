import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { ClaimStore } from '../data/claimStore';
import { DecisionStore } from '../data/decisionStore';
import { CardStack, QueueItem } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';

// 卡片占页面宽度的比例（与 CardStack.ets 的 .width('86%') 必须一致）。
// settle() 的位移阈值以「卡宽」为基准（spec 的 COMMIT_DISTANCE_RATIO = 0.28 是卡宽比例），
// 而 onAreaChange 量到的是页面宽，所以这里要乘回该比例。
const CARD_WIDTH_RATIO = 0.86;

// 「上墙窗口期」（spec §5.2）：刚收藏完、照片还「热」着的时候问「要不要上墙」命中率最高；
// 错过也不惩罚——收藏页随时能补。
export const WALL_PROMPT_MS = 4000;

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  @State idx: number = 0;
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  @State cardW: number = 360;   // 兜底值 = 首帧尚未量出卡宽时的假定卡宽；布局后由 onAreaChange 覆盖
  // 非空 = 窗口期内的照片 id；按钮只在这段时间挂在卡片下方
  @State wallPromptFor: string = '';
  private decisions: Map<string, Decision> = new Map();
  private metrics: MetricsState = emptyMetrics();
  private shownAt: number = Date.now();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  // 必须声明在 ctx 之后：字段初始化按声明顺序执行，提前会拿到 undefined 的 ctx
  private dStore: DecisionStore = new DecisionStore(this.ctx);
  private wallTimer: number = -1;   // 窗口期的 setTimeout 句柄，卸载时必须清掉（与 CardStack 同规矩）

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
    // 内存决策表必须从磁盘现状起步（不能是空 Map）：promoteToWall() 要拿 prev，
    // 拿到 undefined 会把这张照片已有的 deferCount / decidedAt 抹掉。
    this.decisions = existing;
    this.shownAt = Date.now();
  }

  // 与 CardStack 的做法一致：页面卸载后定时器不得再改状态
  aboutToDisappear(): void {
    if (this.wallTimer !== -1) { clearTimeout(this.wallTimer); this.wallTimer = -1; }
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
            cardWidth: this.cardW,
            onDecide: (photoId: string, action: string, rolledBack: boolean) => {
              this.handle(photoId, action, rolledBack);
            }
          })
        } else {
          Text('今天的份刷完了').fontSize(18).fontColor('#666')
        }

        // 上墙窗口期：卡片下方浮出「挂上墙」，WALL_PROMPT_MS 后自动消失。
        // Stack 子组件上的 align 等价于覆盖 Stack 的 alignContent，所以卡片仍居中、按钮贴底。
        if (this.wallPromptFor !== '') {
          Button('挂上墙')
            .fontSize(15).height(42).width(160)
            .backgroundColor('#1F6FEB')
            .margin({ bottom: 32 })
            .align(Alignment.Bottom)
            .onClick(() => { this.promoteToWall(); })
        }
      }
      .layoutWeight(1).width('100%')
      .onAreaChange((oldVal: Area, newVal: Area) => {
        // 量到的是页面宽，换算成卡宽再交给 CardStack 的 settle()（阈值以卡宽为基准）。
        const w = Number(newVal.width);
        if (w > 0) { this.cardW = w * CARD_WIDTH_RATIO; }
      })
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }

  private handle(photoId: string, action: string, rolledBack: boolean): void {
    const now = Date.now();
    this.metrics = recordSwipe(this.metrics, {
      photoId: photoId, shownAt: this.shownAt, decidedAt: now,
      action: action, rolledBack: rolledBack
    });
    this.medianMs = Math.round(medianDecisionMs(this.metrics));
    this.rollbackPct = Math.round(rollbackRate(this.metrics) * 100);

    if (rolledBack) { return; }   // 回弹不消耗队列

    const prev = this.decisions.get(photoId);
    const d = prev === undefined ? emptyDecision(photoId) : prev;
    const nextAction = action === 'fav' ? 'fav' : 'archive';
    const next = applyDecision(d, nextAction, now);
    this.decisions.set(photoId, next);
    // 决策立即落盘：不落盘的话杀掉 App 重开，这次滑动就白刷了
    this.dStore.set(next);

    // 只对「右滑收藏」弹窗口期，归档不弹
    if (nextAction === 'fav') {
      this.wallPromptFor = photoId;
      if (this.wallTimer !== -1) { clearTimeout(this.wallTimer); }
      this.wallTimer = setTimeout(() => { this.wallPromptFor = ''; }, WALL_PROMPT_MS);
    }

    this.idx = this.idx + 1;
    this.shownAt = Date.now();
  }

  // 上墙 = 从收藏里精选（不是与收藏互斥的状态）：摘墙会回到 faved 而不是 unseen。
  private promoteToWall(): void {
    const id = this.wallPromptFor;
    if (id === '') { return; }
    const prev = this.decisions.get(id);
    const d = prev === undefined ? emptyDecision(id) : prev;
    const next = applyDecision(d, 'wall', Date.now());
    this.decisions.set(id, next);
    this.dStore.set(next);
    this.wallPromptFor = '';
    if (this.wallTimer !== -1) { clearTimeout(this.wallTimer); this.wallTimer = -1; }
  }
}
