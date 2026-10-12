import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { DecisionStore } from '../data/decisionStore';
// 设计令牌（**全项目唯一的视觉取值处**）。本页的层级规则与刷卡页共用同一条：
// **实心 `C_ACCENT`（+白字）= 主操作；`C_WALL`（浅赭 + 暖黑字）= 状态标记**。
// 所以「看地图墙」是实心强调块，而「墙上」角标才是那个与地图轨迹同色的浅赭，
// 两者不会互相冒充 —— 这条分工写在令牌表的 `C_WALL` 注释里。
import {
  C_ACCENT, C_BG, C_LINE, C_ON_PHOTO, C_SURFACE, C_TEXT, C_TEXT_DIM, C_WALL,
  F_CAPTION, F_LABEL, F_TITLE, LW_BORDER, R_MD, R_SM, S1, S2, S3, S4, S6
} from '../core/designTokens';

// 收藏页 = 决策落盘后的第一个「回头路」：上墙窗口期错过也不惩罚，随时能在这里补。
@Entry
@Component
struct FavPage {
  @State faved: string[] = [];
  @State walled: string[] = [];
  private store: DecisionStore = new DecisionStore(getContext(this) as common.UIAbilityContext);

  aboutToAppear(): void {
    this.faved = this.store.favedIds();
    this.walled = this.store.walledIds();
  }

  build() {
    Column() {
      // ── 标题行：两个数各占一档 ────────────────────────────────────────────
      // 旧版把它们拼在一行文字里（`收藏 12 张 ｜ 已上墙 8 张`，15fp 同色同重），
      // 于是"我攒下了多少"与"其中多少挂上墙了"读起来一样重 —— 而这一页的主角是**收藏**，
      // 上墙数是它的一个注释。现在：收藏 = F_TITLE 主文字色；上墙 = F_LABEL 次要色。
      Row() {
        Text(`收藏 ${this.faved.length} 张`)
          .fontSize(F_TITLE).fontWeight(FontWeight.Bold).fontColor(C_TEXT)
        Text(`已上墙 ${this.walled.length} 张`)
          .fontSize(F_LABEL).fontColor(C_TEXT_DIM)
          .margin({ left: S3 }).layoutWeight(1)
      }
      .width('100%').alignItems(VerticalAlign.Bottom)
      .padding({ left: S4, right: S4, top: S4, bottom: S3 })

      // ── 两个入口：并排一行（旧版是两行占满宽的实心块，把网格挤到屏幕下半）──
      // 层级：「看地图墙」是这一页的主操作（实心 `C_ACCENT` + 白字 4.94:1）；
      // 「使用统计」是只读看板（描边胶囊，`C_TEXT_DIM` 墨色 5.34:1）。
      // 旧版两个都是实心块（蓝 `#1F6FEB` + 灰蓝 `#5B6673`），且都是整屏宽 —— 两行加起来
      // 占掉约 100vp，而它们只是两个入口。并排之后省下的高度全部给了照片网格。
      Row({ space: S3 }) {
        // 看地图墙：把上墙的照片挂到中国地图上。上墙数为 0 也允许进 —— 那一页有自己的空态，
        // 而且"为什么墙上是空的"这件事只有在那一页才说得清（缺地点 / 缺 GPS）。
        Button('看地图墙')
          .fontSize(F_LABEL).fontWeight(FontWeight.Medium).height(44).layoutWeight(1)
          .borderRadius(R_MD)
          .backgroundColor(C_ACCENT).fontColor(C_ON_PHOTO)
          .onClick(() => { router.pushUrl({ url: 'pages/WallPage' }); })

        // 使用统计（spec §5.3 的三条验收指标）。入口选在本页的理由：
        //   1) 语义同类 —— 本页是"回头看看我攒下的东西"（收藏 / 地图墙），统计是同一类只读看板，
        //      放进首页（那是"开一局"的动作页）会让主流程的按钮越堆越多；
        //   2) **读数最新** —— 本页只能从刷照片页的顶部「收藏」按钮进来，而 router 跳转会让
        //      SwipePage 触发 onPageHide → flushSave()，指标在跳转的同一刻落盘，
        //      所以从这里进统计页读到的一定包含当前这一局刚刷出来的全部事件（不会差一个 1 秒窗口）。
        // 只读看板放在收藏页、与"看地图墙"并列，也免得用户以为它是个会改数据的开关。
        Button('使用统计')
          .fontSize(F_LABEL).height(44).layoutWeight(1)
          .borderRadius(R_MD)
          .backgroundColor(C_SURFACE).fontColor(C_TEXT_DIM)
          .border({ width: LW_BORDER, color: C_TEXT_DIM })
          .onClick(() => { router.pushUrl({ url: 'pages/StatsPage' }); })
      }
      .width('100%').padding({ left: S3, right: S3 }).margin({ bottom: S3 })

      if (this.faved.length === 0) {
        // 空状态：一张都没收藏时不留一片空白，顺便说明收藏从哪来
        Text('还没有收藏。右滑一张照片就会把它收进这里，收藏后可以挂上墙。')
          .fontSize(F_LABEL).fontColor(C_TEXT_DIM).textAlign(TextAlign.Center)
          .padding({ left: S6, right: S6 }).layoutWeight(1)
      } else {
        Grid() {
          ForEach(this.faved, (uri: string) => {
            GridItem() {
              // 这一层 Stack 只负责把「墙上」角标叠在图片右上角（GridItem 的 alignContent
              // 是「格内对齐」不是「叠加」，两个子组件没法靠它叠起来）。
              // 格子尺寸由下方的 GridItem.aspectRatio(1) 给定：之前缺的正是这层尺寸约束，
              // Image.height('100%') 去撑一个高度未定义的格子，才被拉成长竖条。
              Stack({ alignContent: Alignment.TopEnd }) {
                Image(uri).width('100%').height('100%').objectFit(ImageFit.Cover).borderRadius(R_SM)
                if (this.walled.indexOf(uri) >= 0) {
                  // 「墙上」角标 = `C_WALL`（浅赭）+ **暖黑字**（5.03:1）。
                  // 这是令牌表里唯一"深字压浅底"的组合：浅底 + 深字的可读性不比深底 + 白字差，
                  // 差的只是"重量"，而角标本来就该轻 —— 它是一张照片的状态，不是一个按钮。
                  // 用与地图轨迹**同一个值**，于是"挂在墙上的照片"在收藏页与地图上是同一个颜色。
                  Text('墙上').fontSize(F_CAPTION).fontColor(C_TEXT)
                    .backgroundColor(C_WALL).borderRadius(R_SM)
                    .padding({ left: S2, right: S2, top: S1, bottom: S1 })
                    .margin(S1)
                }
              }
            }
            // aspectRatio 在 GridItem 上可用：SDK 里 GridItemAttribute extends CommonMethod<GridItemAttribute>，
            // 而 aspectRatio(value: number) 就声明在 CommonMethod 上。列宽由 columnsTemplate 定，
            // 高度按 1:1 从列宽推出 → 方格。
            .aspectRatio(1)
          }, (uri: string) => uri)
        }
        .columnsTemplate('1fr 1fr 1fr').columnsGap(S2).rowsGap(S2)
        .layoutWeight(1).width('100%').padding({ left: S3, right: S3 })
      }
    }
    .width('100%').height('100%').backgroundColor(C_BG)
  }
}
