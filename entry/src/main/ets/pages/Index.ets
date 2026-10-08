import { ClaimState, emptyClaimState } from '../core/claim';
import { GeoPoint, haversineMeters } from '../core/geo';

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
