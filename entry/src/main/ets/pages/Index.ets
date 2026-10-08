import { ClaimState, emptyClaimState } from '../core/claim';
import { GeoPoint, haversineMeters } from '../core/geo';
import { computeLayout, PlacedPin, PinLayout } from '../core/placement';
import { projectMercator, CHINA_REGION, Projected } from '../core/projection';
import { applyDecision, emptyDecision, Action, Decision } from '../core/queue';

// 本任务只做最小可用页面，不做任何 UI 功能。
// 这里的 ClaimState 字段是为了证明 core/*.ts 能被 ArkTS 编译器正常处理（分层规则见 Task 1 brief）。
// homePoint / homeToBeijingM 是为了把 core/geo.ts 拉进 ArkTS 模块图（Task 3 Ruling 9）。
// 注意：haversineMeters 必须出现在「值位置」——若只把 GeoPoint 当类型用，ArkTS 会把 import 擦成
// type-only（已实测），geo.ts 就不会被编译，构建照样 BUILD SUCCESSFUL 但 geo.protoBin 不会生成。
@Entry
@Component
struct Index {
  private claimState: ClaimState = emptyClaimState();
  private homePoint: GeoPoint = { lat: 31.2495, lon: 121.4813 };
  private homeToBeijingM: number =
    haversineMeters({ lat: 31.2495, lon: 121.4813 }, { lat: 39.9042, lon: 116.4074 });
  // 以下三个字段只为把 core/placement|projection|queue 拉进 ArkTS 模块图（Ruling 13）。
  // 必须出现在「值位置」——只当类型用会被擦成 type-only import，模块不会被编译（已实测）。
  private homeOnMap: Projected =
    projectMercator(121.4813, 31.2495, 900, 700, CHINA_REGION.bounds);
  private demoPins: PlacedPin[] = [{ pinId: 'p1', x: 100, y: 100 }];
  private demoCounts: Map<string, number> = new Map<string, number>([['p1', 5]]);
  private demoLayout: PinLayout[] = computeLayout(this.demoPins, this.demoCounts, 1);
  private demoAction: Action = 'fav';
  private demoDecision: Decision = applyDecision(emptyDecision('demo'), this.demoAction, 0);

  build() {
    Column() {
      Text('照片墙')
        .fontSize(24)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
