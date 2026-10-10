import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { DecisionStore } from '../data/decisionStore';

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
      Text(`收藏 ${this.faved.length} 张 ｜ 已上墙 ${this.walled.length} 张`)
        .fontSize(15).fontWeight(FontWeight.Medium).padding(16)

      // 看地图墙：把上墙的照片挂到中国地图上。上墙数为 0 也允许进 —— 那一页有自己的空态，
      // 而且"为什么墙上是空的"这件事只有在那一页才说得清（缺地点 / 缺 GPS）。
      Button('看地图墙')
        .fontSize(14)
        .backgroundColor('#1F6FEB')
        .width('90%')
        .margin({ bottom: 12 })
        .onClick(() => { router.pushUrl({ url: 'pages/WallPage' }); })

      // 使用统计（spec §5.3 的三条验收指标）。入口选在本页的理由：
      //   1) 语义同类 —— 本页是"回头看看我攒下的东西"（收藏 / 地图墙），统计是同一类只读看板，
      //      放进首页（那是"开一局"的动作页）会让主流程的按钮越堆越多；
      //   2) **读数最新** —— 本页只能从刷照片页的顶部「收藏」按钮进来，而 router 跳转会让
      //      SwipePage 触发 onPageHide → flushSave()，指标在跳转的同一刻落盘，
      //      所以从这里进统计页读到的一定包含当前这一局刚刷出来的全部事件（不会差一个 1 秒窗口）。
      // 只读看板放在收藏页、与"看地图墙"并列，也免得用户以为它是个会改数据的开关。
      Button('使用统计')
        .fontSize(14)
        .backgroundColor('#5B6673')
        .width('90%')
        .margin({ bottom: 12 })
        .onClick(() => { router.pushUrl({ url: 'pages/StatsPage' }); })

      if (this.faved.length === 0) {
        // 空状态：一张都没收藏时不留一片空白，顺便说明收藏从哪来
        Text('还没有收藏。右滑一张照片就会把它收进这里，收藏后可以挂上墙。')
          .fontSize(13).fontColor('#999').textAlign(TextAlign.Center)
          .padding({ left: 32, right: 32 }).layoutWeight(1)
      } else {
        Grid() {
          ForEach(this.faved, (uri: string) => {
            GridItem() {
              // 这一层 Stack 只负责把「墙上」角标叠在图片右上角（GridItem 的 alignContent
              // 是「格内对齐」不是「叠加」，两个子组件没法靠它叠起来）。
              // 格子尺寸由下方的 GridItem.aspectRatio(1) 给定：之前缺的正是这层尺寸约束，
              // Image.height('100%') 去撑一个高度未定义的格子，才被拉成长竖条。
              Stack({ alignContent: Alignment.TopEnd }) {
                Image(uri).width('100%').height('100%').objectFit(ImageFit.Cover).borderRadius(8)
                if (this.walled.indexOf(uri) >= 0) {
                  Text('墙上').fontSize(10).fontColor(Color.White)
                    .backgroundColor('#1F6FEB').borderRadius(6).padding({ left: 5, right: 5 })
                    .margin(4)
                }
              }
            }
            // aspectRatio 在 GridItem 上可用：SDK 里 GridItemAttribute extends CommonMethod<GridItemAttribute>，
            // 而 aspectRatio(value: number) 就声明在 CommonMethod 上。列宽由 columnsTemplate 定，
            // 高度按 1:1 从列宽推出 → 方格。
            .aspectRatio(1)
          }, (uri: string) => uri)
        }
        .columnsTemplate('1fr 1fr 1fr').columnsGap(8).rowsGap(8)
        .layoutWeight(1).width('100%').padding({ left: 12, right: 12 })
      }
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }
}
