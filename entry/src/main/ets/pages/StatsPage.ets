/**
 * 「使用统计」页：把 spec §5.3 的三条验收指标（决策间隔中位数 / 回弹率 / 上墙转化率）
 * 从**落盘的历史数据**里算出来显示，并在每个数值旁标出目标与"达标 / 未达标 / 还没有数据"。
 *
 * 三条设计约束（都是要求，不是风格偏好）：
 *   1) **只读快照**：本页只 `load()`，**一处都不写**（没有 flush、没有 save、没有清空按钮）。
 *      看板页如果同时是写入口，"看到的数"与"盘上的数"就可能不是一个东西 —— 而本页的全部价值
 *      就在于它是一个可复核的历史读数。重置统计 = 让用户（或验收方）删掉 files/metrics.json，
 *      那条路径是 data/metricsStore.ets 的"首次运行"分支（静默空状态，不告警）。
 *   2) **页面不算数**：所有读数、样本量、判定都来自 `core/metrics.ts` 的 `computeStats`
 *      （纯函数，跑在 node 单测里）。本页只做字符串格式化与上色 ——
 *      页面上不会出现第二份"口径"，也就不会与单测钉住的那份漂移。
 *   3) **空数据不是达标**：判定文本一律走 `verdictText()`（`'还没有数据' | '达标' | '未达标'`），
 *      颜色由 `verdictColor()` 给（无样本 = 灰，**不是绿**）。
 *      空集合下中位数与回弹率都返回 0，而 0 < 1200ms、0 < 3% 都恰好为真 ——
 *      这正是 core/metrics.ts 注释里点名的陷阱，所以"不可判定"必须与"达标"在视觉上也不同。
 *
 * 入口：pages/FavPage 的「使用统计」按钮（理由见那里的注释）。
 * 数据来源：files/metrics.json（事件窗口）+ files/decisions.json（收藏池 / 已上墙张数）。
 */
import { common } from '@kit.AbilityKit';
import { MetricsStore, MetricsLoad } from '../data/metricsStore';
import { DecisionStore } from '../data/decisionStore';
import {
  emptyMetrics, computeStats, StatsSnapshot, TargetVerdict, verdictText,
  TARGET_MEDIAN_MS, TARGET_ROLLBACK_RATE, TARGET_CONVERSION_MIN, TARGET_CONVERSION_MAX,
  MAX_METRIC_EVENTS
} from '../core/metrics';

@Entry
@Component
struct StatsPage {
  // 初值 = 空状态（三条都不可判定）。aboutToAppear 里换成从盘上算出来的快照。
  // 用 @State 而不是普通字段：与仓库里其它页面一致，且快照本来就是"这一页的唯一数据"。
  @State stats: StatsSnapshot = computeStats(emptyMetrics(), 0, 0, 0);
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  // 两个 store 都必须声明在 ctx 之后：字段初始化按声明顺序执行，提前会拿到 undefined 的 ctx。
  private mStore: MetricsStore = new MetricsStore(this.ctx);
  private dStore: DecisionStore = new DecisionStore(this.ctx);

  aboutToAppear(): void {
    // 只读快照：读指标窗口 + 决策表，算一次，之后本页不再碰盘。
    const loaded: MetricsLoad = this.mStore.load();
    // 收藏池口径 = DecisionStore.favedIds()（**含已上墙的**：state 为 'faved' 或 'walled'）。
    // 必须用它当转化率分母：上墙会把 state 从 faved 改成 walled，只数 'faved' 会让分母被分子吃掉
    //（真机现状 walled 33 / faved 22 → 33/22 = 150%）。完整理由见 core/metrics.ts 的 computeStats。
    const favedPool: number = this.dStore.favedIds().length;
    const walled: number = this.dStore.walledIds().length;
    this.stats = computeStats(loaded.state, favedPool, walled, loaded.dropped);
  }

  /**
   * 判定色。**无样本必须是灰的**（不是绿也不是红）：空数据既不是"达标"也不是"未达标"，
   * 给它上绿色就等于把"没量过"说成"量过且合格"（本页要消灭的那个陷阱）。
   */
  private verdictColor(v: TargetVerdict): string {
    if (!v.hasSample) { return '#999999'; }
    return v.met ? '#1F9D55' : '#D33A2C';
  }

  /** 比率 → 「12.3%」。显示保留 1 位小数（判定用的是原始值，见页脚说明）。 */
  private pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
  }

  /**
   * 一条指标卡。抽成 @Builder 是因为三张卡的**结构完全相同**（标题 / 读数 / 目标 / 判定），
   * 手写三遍必然漂移 —— 而"每条都要在数值旁标出目标并明确是否达标"正是本页的验收要求。
   * 判定文本只走 `verdictText`（页面不拼这三个词），颜色只走 `verdictColor`。
   */
  @Builder
  metricCard(title: string, reading: string, target: string, v: TargetVerdict) {
    Column() {
      Row() {
        Text(title).fontSize(14).fontColor('#333333').layoutWeight(1)
        Text(verdictText(v)).fontSize(13).fontWeight(FontWeight.Bold).fontColor(this.verdictColor(v))
      }.width('100%')

      Row() {
        Text(reading).fontSize(24).fontWeight(FontWeight.Bold).fontColor(this.verdictColor(v))
        Text(`目标 ${target}`).fontSize(12).fontColor('#888888').margin({ left: 10 }).layoutWeight(1)
      }
      .width('100%').alignItems(VerticalAlign.Bottom).margin({ top: 4 })
    }
    .width('100%').alignItems(HorizontalAlign.Start)
    .padding(12).backgroundColor('#FFFFFF').borderRadius(10).margin({ bottom: 10 })
  }

  /** 样本量的一行：左标签右数值。样本量与指标数值同等重要（没有它指标无法被信任）。 */
  @Builder
  sampleRow(label: string, value: string) {
    Row() {
      Text(label).fontSize(12).fontColor('#666666').layoutWeight(1)
      Text(value).fontSize(12).fontColor('#333333')
    }
    .width('100%').padding({ top: 3, bottom: 3 })
  }

  /** 页脚的一条口径说明 */
  @Builder
  note(text: string) {
    Text(text).fontSize(11).fontColor('#888888').width('100%').margin({ bottom: 4 })
  }

  build() {
    Column() {
      Text('使用统计').fontSize(20).fontWeight(FontWeight.Bold).margin({ top: 16 })
      Text('spec §5.3 的三条验收指标，从落盘的历史数据算出来').fontSize(12).fontColor('#999999')
        .margin({ top: 4, bottom: 12 })

      Scroll() {
        Column() {
          // ── 空态横幅：三条**都**不可判定时才出现 ────────────────────────────
          // 逐条判定（而不是整页一个空态标志）是刻意的：一个从没收藏过、但已经刷过卡的用户，
          // 中位数/回弹率有样本、转化率没有 —— 那种情况下这一页仍然是"部分有数据"的。
          if (!this.stats.medianVerdict.hasSample && !this.stats.rollbackVerdict.hasSample
            && !this.stats.conversionVerdict.hasSample) {
            Text('还没有数据：这台设备上还没有产生任何可统计的记录。刷几张照片之后再进来看。'
              + '（空数据不会被判成「达标」—— 三条指标都会显示「还没有数据」。）')
              .fontSize(12).fontColor('#B26A00').width('100%')
              .padding(10).backgroundColor('#FFF6E5').borderRadius(8).margin({ bottom: 10 })
          }

          // ── 三条验收指标 ────────────────────────────────────────────────────
          this.metricCard('决策间隔中位数', `${Math.round(this.stats.medianMs)} ms`,
            `< ${TARGET_MEDIAN_MS} ms`, this.stats.medianVerdict)
          this.metricCard('回弹率', this.pct(this.stats.rollbackRate),
            `< ${this.pct(TARGET_ROLLBACK_RATE)}`, this.stats.rollbackVerdict)
          this.metricCard('上墙转化率', this.pct(this.stats.conversion),
            `${this.pct(TARGET_CONVERSION_MIN)} ~ ${this.pct(TARGET_CONVERSION_MAX)}`,
            this.stats.conversionVerdict)

          // ── 样本量：每一条都列出"参与计算的样本数" ──────────────────────────
          Column() {
            Text('样本量').fontSize(13).fontWeight(FontWeight.Medium).fontColor('#333333')
              .width('100%').margin({ bottom: 4 })
            this.sampleRow('决策间隔的样本数（排除「上墙」）', `${this.stats.medianSample} 次`)
            this.sampleRow('回弹率的分母（滑动尝试，排除「上墙」）', `${this.stats.rollbackSample} 次`)
            this.sampleRow('回弹率的分母 / 分子', `${this.stats.rollbackSample} / ${this.stats.rollbackCount}`)
            this.sampleRow('上墙转化率的分母（收藏池 = 收藏 + 已上墙）', `${this.stats.favedPool} 张`)
            this.sampleRow('上墙转化率的分子（已上墙）', `${this.stats.walled} 张`)
            this.sampleRow('已记录的刷卡事件', `${this.stats.eventCount} 条`)
            this.sampleRow('其中已被容量淘汰', `${this.stats.droppedCount} 条`)
          }
          .width('100%').alignItems(HorizontalAlign.Start)
          .padding(12).backgroundColor('#FFFFFF').borderRadius(10).margin({ bottom: 10 })

          // ── 口径说明（可复核性：每个数是怎么来的，都写在这一段里）──────────
          Column() {
            Text('口径说明').fontSize(13).fontWeight(FontWeight.Medium).fontColor('#333333')
              .width('100%').margin({ bottom: 6 })
            this.note('· 中位数与回弹率的分母都**排除「上墙」**事件：那是在卡片上点一下按钮，'
              + '不是一次滑动尝试（也没有越过任何阈值）。含它会让指标随「上墙」用得越多而越虚低。')
            this.note('· 回弹率 = 回弹次数 ÷ 滑动尝试次数。同一张卡"被回弹后成功划出"会贡献 2 次尝试，'
              + '这正是它消耗了 2 次尝试的忠实反映（不是按卡片数算）。')
            this.note('· 上墙转化率 = 已上墙 ÷ 收藏池（**收藏 + 已上墙**）。上墙会把照片从「收藏」'
              + '移入「已上墙」，所以分母必须含已上墙的，否则每上墙一张分母就少一张。')
            this.note('· 判定按**原始值**（未舍入），显示值四舍五入到 0.1%。')
            this.note('· 边界：中位数恰好 1200ms 算**不达标**、回弹率恰好 3% 算**不达标**'
              + '（spec 是「<」）；转化率恰好 15% / 30% 都算**达标**（spec 是范围，含端点）。')
            this.note('· 没有样本 = 「还没有数据」，**不是**达标：空集合下读数都是 0，'
              + '而 0 < 1200ms、0 < 3% 都恰好为真 —— 只看数值会把空设备读成绿的。')
            this.note(`· 事件窗口上限 ${MAX_METRIC_EVENTS} 条，超过就淘汰最旧的（留 ${MAX_METRIC_EVENTS} - 200 条）。`
              + '淘汰条数 > 0 时，中位数与回弹率只反映窗口内的样本（不是全生命周期）。')
            if (this.stats.eventCount > 0 && this.stats.medianSample === 0) {
              this.note(`· 已记录 ${this.stats.eventCount} 次刷卡，但**全部是「上墙」**：`
                + '按上面的口径它们不构成滑动样本，所以中位数与回弹率不可判定。')
            }
            this.note('· 本页**只读**：不做任何写入。要重置统计就删掉 files/metrics.json。')
          }
          .width('100%').alignItems(HorizontalAlign.Start)
          .padding({ left: 12, right: 12, top: 6, bottom: 6 })
        }
        .width('100%').alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1).width('100%').padding({ left: 16, right: 16 }).scrollBar(BarState.Off)
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }
}
