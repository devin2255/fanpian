import { common } from '@kit.AbilityKit';
import { ClaimStore } from '../data/claimStore';
import { CardStack, QueueItem } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';

// 卡片占页面宽度的比例（与 CardStack.ets 的 .width('86%') 必须一致）。
// settle() 的位移阈值以「卡宽」为基准（spec 的 COMMIT_DISTANCE_RATIO = 0.28 是卡宽比例），
// 而 onAreaChange 量到的是页面宽，所以这里要乘回该比例。
const CARD_WIDTH_RATIO = 0.86;

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  @State idx: number = 0;
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  @State cardW: number = 360;   // 兜底值 = 首帧尚未量出卡宽时的假定卡宽；布局后由 onAreaChange 覆盖
  private decisions: Map<string, Decision> = new Map();
  private metrics: MetricsState = emptyMetrics();
  private shownAt: number = Date.now();
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;

  aboutToAppear(): void {
    const store = new ClaimStore(this.ctx);
    const claimed = store.load();
    // 注意：不能写成 .map((p) => ({ ... })) —— 对象字面量在 map 回调里
    // 拿不到显式声明的类型，ArkTS 会报 arkts-no-untyped-obj-literals。
    const q: QueueItem[] = claimed.photos.map((p): QueueItem => {
      const one: QueueItem = { photoId: p.photoId, thumbUri: p.photoId };
      return one;
    });
    // 真实实现：用 EXIF 拍摄时间排序（Task 9），这里先按认领顺序倒序
    this.items = q.reverse();
    this.idx = 0;
    this.shownAt = Date.now();
  }

  build() {
    Column() {
      Row() {
        Text(`剩余 ${this.items.length - this.idx}`).fontSize(13).fontColor('#666').layoutWeight(1)
        Text(`中位 ${this.medianMs}ms  回弹 ${this.rollbackPct}%`).fontSize(12).fontColor('#999')
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
    this.decisions.set(photoId, applyDecision(d, nextAction, now));
    this.idx = this.idx + 1;
    this.shownAt = Date.now();
  }
}
