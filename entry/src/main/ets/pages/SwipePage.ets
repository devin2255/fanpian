import { common } from '@kit.AbilityKit';
import { ClaimStore } from '../data/claimStore';
import { CardStack, QueueItem } from '../ui/CardStack';
import { Decision, emptyDecision, applyDecision } from '../core/queue';
import { MetricsState, emptyMetrics, recordSwipe, medianDecisionMs, rollbackRate } from '../core/metrics';

@Entry
@Component
struct SwipePage {
  @State items: QueueItem[] = [];
  @State idx: number = 0;
  @State medianMs: number = 0;
  @State rollbackPct: number = 0;
  @State cardW: number = 360;   // 兜底值，首帧布局后由 onAreaChange 覆盖为真实宽度
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
        const w = Number(newVal.width);
        if (w > 0) { this.cardW = w; }
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
