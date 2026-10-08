import { ClaimState, emptyClaimState } from '../core/claim';

// 本任务只做最小可用页面，不做任何 UI 功能。
// 这里的 ClaimState 字段是为了证明 core/*.ts 能被 ArkTS 编译器正常处理（分层规则见 Task 1 brief）。
@Entry
@Component
struct Index {
  private claimState: ClaimState = emptyClaimState();

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
