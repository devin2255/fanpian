import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { ClaimStore, pickPhotos } from '../data/claimStore';
import { DecisionStore } from '../data/decisionStore';
// 以下 import 是为了把 core 层留在 ArkTS 编译图内（Ruling 17）。
// 重要：必须出现在「值位置」——只当类型用会被 ArkTS 擦成 type-only import，
// 那些模块就不会被编译，而构建照样 BUILD SUCCESSFUL（假绿）。
// 判定真伪：编译后检查 entry/build/.../ets/core/<name>.protoBin 是否存在。
import { ClaimState, emptyClaimState } from '../core/claim';
import { GeoPoint, haversineMeters } from '../core/geo';
import { computeLayout, PlacedPin, PinLayout } from '../core/placement';
import { projectMercator, CHINA_REGION, Projected } from '../core/projection';
import { applyDecision, emptyDecision, Action, Decision } from '../core/queue';
import { emptyMetrics, MetricsState, medianDecisionMs } from '../core/metrics';

@Entry
@Component
struct ClaimPage {
  @State claimed: number = 0;
  @State msg: string = '';
  private ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  private store: ClaimStore = new ClaimStore(this.ctx);

  // ── 编译图守卫（Ruling 17）──────────────────────────────
  // 这些字段只为让 core/*.ts 进入 ArkTS 模块图，业务上不使用。
  // 若将来 ClaimPage 真正消费了这些模块，可以把这些守卫字段删掉。
  private claimShape: ClaimState = emptyClaimState();
  private homePoint: GeoPoint = { lat: 31.2495, lon: 121.4813 };
  private homeToBeijingM: number =
    haversineMeters({ lat: 31.2495, lon: 121.4813 }, { lat: 39.9042, lon: 116.4074 });
  private homeOnMap: Projected =
    projectMercator(121.4813, 31.2495, 900, 700, CHINA_REGION.bounds);
  private guardPins: PlacedPin[] = [{ pinId: 'p1', x: 100, y: 100 }];
  private guardCounts: Map<string, number> = new Map<string, number>([['p1', 5]]);
  private guardLayout: PinLayout[] = computeLayout(this.guardPins, this.guardCounts, 1);
  private guardAction: Action = 'fav';
  private guardDecision: Decision = applyDecision(emptyDecision('guard'), this.guardAction, 0);
  private guardMetrics: MetricsState = emptyMetrics();
  private guardMedianMs: number = medianDecisionMs(this.guardMetrics);

  aboutToAppear(): void {
    this.claimShape = this.store.load();
    this.claimed = this.claimShape.photos.length;
  }

  build() {
    Column({ space: 16 }) {
      Text('照片墙').fontSize(26).fontWeight(FontWeight.Bold)
      Text(`已认领 ${this.claimed} 张照片`).fontSize(15).fontColor('#666')
      Text('先认领一批照片。建议挑选一次旅行，这样马上就能看到地图墙。')
        .fontSize(13).fontColor('#999').textAlign(TextAlign.Center).padding({ left: 32, right: 32 })

      Button('认领照片')
        .fontSize(16).height(46).width(200)
        .onClick(() => { this.doPick(); })

      Button('开始刷照片')
        .fontSize(16).height(46).width(200)
        .onClick(() => { router.pushUrl({ url: 'pages/SwipePage' }); })

      Button('看收藏')
        .fontSize(16).height(46).width(200)
        .onClick(() => { router.pushUrl({ url: 'pages/FavPage' }); })

      Text(this.msg).fontSize(12).fontColor('#D33')
    }
    .width('100%').height('100%').justifyContent(FlexAlign.Center)
  }

  private async doPick(): Promise<void> {
    try {
      // 把「已认领但还没刷过」的照片作为**预选项**传给选图器：它们会以选中状态呈现，
      // 用户点系统「完成」即可一键把这批全部认领，不必再逐张重新点选。
      // 想加新的就在同一个网格里顺便多选几张 —— 新照片会被 addBatch/mergeBatch 追加为新批次。
      //
      // 判据必须与 SwipePage.aboutToAppear 的入队过滤**逐字一致**
      //（pages/SwipePage.ets 的 `d === undefined || d.state === 'unseen'`）：
      // 只有「没有决策记录」或「决策仍是 unseen」才算还没刷过。
      // 若两处判据漂移，会出现「选图器里没有它、队列里却有它」这类自相矛盾的状态。
      const claimed = this.store.load();
      const decisions = new DecisionStore(this.ctx).loadAll();
      const undecided: string[] = [];
      for (let i = 0; i < claimed.photos.length; i++) {
        const id = claimed.photos[i].photoId;
        const d = decisions.get(id);
        if (d === undefined || d.state === 'unseen') { undecided.push(id); }
      }
      const uris: string[] = await pickPhotos(undecided);
      if (uris.length === 0) { this.msg = '没有选中照片'; return; }
      // 「认领前」的张数直接复用上面那次 load 的结果（claimed），不再读一次盘：
      // addBatch 内部已经要 load() 一次，这里再 load 就是第三次全量读。
      // 预选功能让「点完成但不加新照片」成为高频路径：此时 uris 是回传的**全部**张数
      // （含早已认领的），按 uris.length 播报会高报成「本次认领 10 张」而实际一张都没新增。
      const before = claimed.photos.length;
      const next = this.store.addBatch(uris, Date.now());
      const added = next.photos.length - before;   // 真正新增的张数
      this.claimed = next.photos.length;
      this.msg = added > 0
        ? `本次认领 ${added} 张，累计 ${next.photos.length} 张`
        : `没有新增（这 ${next.photos.length} 张都在队列里了）`;
    } catch (e) {
      const err = e as BusinessError;
      this.msg = `认领失败：${err.code} ${err.message}`;
    }
  }
}
