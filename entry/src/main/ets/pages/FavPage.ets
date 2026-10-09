import { common } from '@kit.AbilityKit';
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
