/**
 * 地图墙页面：把「已上墙的照片」显示成中国地图上的**钉子 + 标记簇**。
 *
 * ── 形态（task-18 的用户裁决："地图为主：照片改小、点开才看大图"）──────────────
 *   地图是**主角**（铺满整块主体区：底色 + 国界 + 省界 + 轨迹 + 钉子），
 *   照片是**钉子旁边的一簇小圆点**（半径 1.9pt、最多 5 个，其余由「＋N」报出），
 *   大图在「点开钉子」的底部详情面板里（72×92 + 日期）。
 *   旧版"照片用线吊在钉子下、占 26×34"那套几何连同它的布局代码一起删掉了 ——
 *   那才是"地图一条、照片飘在空白里"的成因（见 core/render.ts 的文件头）。
 *
 * ── 这个页面只做三件事（几何**一行都不算**） ─────────────────────────────────
 *   1. **取数据**：`DecisionStore.walledIds()`（谁是上墙的，唯一判据）+ `LocationIndex`
 *      （它们在哪、什么时候拍的）；
 *   2. **调 core/render**：`fitBounds` 由照片坐标求出**视野框**、`fitViewToCanvas` 把它
 *      撑到与画布同比例（"默认铺满"）、`buildScene` 算钉子与标记、`badgeRectOf` 给「＋N」
 *      的位置；国界/省界/轨迹/钉子共用**同一个** `MapFrame`（`frame.bounds` 是唯一的
 *      经纬度范围来源）；
 *   3. **把数字摆到屏幕上**：标记用 `Circle` 放在 `钉子 + markers[k]` 上，
 *      国界/省界/轨迹用 `Shape` + `Path`。
 *   几何全部来自 `core/render.ts` —— 与 `tools/render-preview.ts` 产出的 SVG **逐点相同**，
 *   所以"在电脑上先看见"这件事是真的，不是近似。
 *
 * ── 渲染方式：国界/省界/轨迹用 Path/Shape，标记用 Circle 组件（不是 Canvas）──────
 *   选它的理由：
 *   · **几何已经是数字了**。`pinMarkers()` 给的就是相对钉子的偏移，`.position({x,y})`
 *     一对一；预览与设备共用同一个函数，不存在"两边各画一遍"的漂移。
 *   · **场景是算一次的**，不是每帧算。`buildScene` 只在「数据变了」或「画布尺寸变了」时跑；
 *     之后就是一堆静态节点（最坏 15 钉 × 5 点 = 75 个 `Circle` + 15 个钉点 + 15 条标签）——
 *     比旧版最坏 135 张 `Image` 少一个数量级，而每张 `Image` 都要解码、下采样与缓存。
 *   · **交互天然可用**：钉点/命中区各自是一个组件，`.onClick` 直接绑；用 Canvas 就得
 *     自己写命中检测。
 *   · **大图交给详情面板**：`Image(uri)` 只在面板里出现（最多 72×92 那么大的若干张），
 *     不需要为墙上的每个点都持有一张缩略图 —— 这是本形态在内存上最大的一处收益。
 *
 * ── 三个 `Shape`（国界 / 省界 / 轨迹）都显式给 viewPort，且等于自身尺寸 ────────
 *   ArkUI 的 `Shape` 用 `viewPort` 把"用户坐标"映射到组件自身尺寸（官方文档的每个例子
 *   都显式给了 viewPort 与 `Path().width()/height()`）。不给就等于把缩放语义交给默认值 ——
 *   真机上反馈"地图只占屏幕左上角一小块"就有这一层嫌疑。这里把 viewPort 写成
 *   `{x:0, y:0, width: boxW, height: boxH}`：**恒等映射**，画什么坐标就是什么位置，
 *   三个图层与 `.position()` 摆放的标记共用同一个坐标系，怎么都不会漂。
 *  *
 * ── 索引必须先 buildFrom **再** awaitIdle（两行都要）─────────────────────────
 *   见 `data/locationIndex.ets` 的契约：
 *   · 只 `buildFrom`：并发时它**返回快照**，可能少照片（"这张的 EXIF 还没读到"被误当成没地点）；
 *   · 只 `awaitIdle`：没有构建在跑时它立即返回**盘上现有的**索引，可能整个都是过期的。
 *   两行合起来才是"触发补读 + 等它稳定"。这里与 `PlaceStore.entryAfterIdle` 是同一个道理。
 *
 * ── 与预览刻意不同的一处（"设备上才成立"的理由）─────────────────────────────
 *   **地名标签用 8fp**（预览里是 6.5 用户单位）。预览是 2 倍图，8fp 与它的视觉大小同量级，
 *   但在真屏上是从"一道糊影"变成"能认出字"的那一档。宽度按字数估算，居中于钉子。
 *   标记的**半径与位置**一点不差（都读 core/render 的 `MARKER_R` / `pinMarkers`）——
 *   预览里数得出几个点，真机上就画几个点。
 *
 * ── 空态与退化 ──────────────────────────────────────────────────────────────
 *   · 一张都没上墙 → 告诉用户怎么把照片挂上来（不是留一片空白）；
 *   · 上墙了但**都没有地点** → 说清"墙上没有可挂的钉子"，别让用户以为是加载失败；
 *   · 国界/区划数据读不到 → 照常画钉子和标记（退化路径），页面上留一行说明。
 */
import { common } from '@kit.AbilityKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { CHINA_REGION } from '../core/projection';
import { parseAreaData } from '../core/areaData';
import {
  BADGE_H, BADGE_W, MARKER_COLOR, MARKER_R, MAX_MARKERS, PIN_COLOR, PIN_DOT_R, PIN_HALO_R,
  TRACK_COLOR, TRACK_WIDTH, VIEW_PAD_RATIO, badgeRectOf, buildScene, dateLabel, fitBounds,
  fitViewToCanvas, geoAspect, mapFillRatio, mapFrame, markerCountOf, outlinePath, panViewBy,
  parseOutline, PROVINCE_STROKE, PROVINCE_WIDTH, trajectoryPath, viewZoomOf, viewZoomRange,
  zoomViewAt
} from '../core/render';
import type { MapFrame, OutlineData, PinMarker, Rect, ScenePin, WallPhoto } from '../core/render';
// MAX_HANG 只在 core/placement.ts 里定义（设计 §6.2 的阈值那儿一份），render.ts 不转手导出。
import { MAX_HANG } from '../core/placement';
import { DecisionStore } from '../data/decisionStore';
import { LocationIndex, LocationEntry } from '../data/locationIndex';

/**
 * hilog 的 domain。
 *
 * 为什么从 `0x0000` 换成 `0x1234`：真机上抓不到这个页面的任何一行日志，而 `0x0000` 是
 * 系统/保留域（有些版本会把非系统进程往 0x0000 写的行丢掉）。`0x1234` 是应用可自选的普通域。
 * 同时每条诊断消息都带 `WALLDIAG` 前缀 —— 方便 `hdc shell hilog | findstr WALLDIAG` 一把捞全。
 */
const DOMAIN: number = 0x1234;
const TAG: string = 'WallPage';
/** 诊断消息前缀（见 DOMAIN 的注释）。 */
const DIAG: string = 'WALLDIAG';
const AREA_RAW_NAME: string = 'china_areas.json';
const OUTLINE_RAW_NAME: string = 'china_outline.json';
/**
 * 省级边界数据（`tools/build-provinces.ts` 产出，34 个省级行政区 / 107 环）。
 * 与国界**同一套解析与同一条 path 生成器**，只是颜色与线宽不同（见 core/render 的两个常量）。
 */
const PROVINCE_RAW_NAME: string = 'china_provinces.json';

/** 钉点标签的字号（fp）。见文件头"与预览刻意不同"的一处。 */
const LABEL_FP = 8;
/** 钉子的触摸命中区边长（pt）—— 钉点本身只有 3.4pt，手指点不到。 */
const HIT_SIZE = 32;
/**
 * 钉点与标签的竖直间距（pt）：标签基线在钉点外沿之上再抬这么多。
 * **与预览（`pinAnchorSvg` 里的 `PIN_HALO_R + 2.2`）同一个口径** —— 两边各写一个数
 * 就会变成"电脑上标签贴着钉子、真机上浮在半空"。
 */
const LABEL_LIFT = 2.2;

/**
 * 一个要画在墙上的**标记**（画布坐标 pt，圆心）。坐标 = 钉子 + `pinMarkers` 的偏移。
 * 它**没有尺寸**：圆的直径是全局常量 `MARKER_R`（见 core/render 的注释）。
 */
interface WallMarker { key: string; idx: number; x: number; y: number }
/** 一个钉子的锚点（钉点 + 名字标签 + 命中区 + 可选「＋N」）。 */
interface WallPin {
  idx: number;
  cx: number;
  cy: number;
  label: string;
  labelW: number;
  labelY: number;
  hitX: number;
  hitY: number;
  /** 「＋N」的文字（`markers` 少于照片数时才有）与它的位置（由 core 的 `badgeRectOf` 给）。 */
  badge: string;
  badgeX: number;
  badgeY: number;
  badgeW: number;
}

@Entry
@Component
struct WallPage {
  // 场景（算一次，画布尺寸或数据变化时重算）
  /** 墙上全部标记（每个都是一个小圆点）。坐标来自 core/render 的 `pinMarkers`。 */
  @State markers: WallMarker[] = [];
  /** 全部钉子的锚点（钉点 + 地名标签 + 命中区 + 可选「＋N」）。 */
  @State pinsView: WallPin[] = [];
  @State chinaPath: string = '';
  /**
   * 省级边界的 path。**与国界同一套机制**：同一个 `parseOutline` 解析、同一个 `outlinePath`
   * 生成（含视口剔除），区别只有颜色和线宽（`PROVINCE_STROKE` / `PROVINCE_WIDTH`）。
   * 读不到数据时是空串 → 那一层不画（退化路径，墙照样能用）。
   */
  @State provincePath: string = '';
  /** 旅行轨迹折线（按拍摄时间把钉子连起来）。见 core/render.trajectoryPath。 */
  @State trackPath: string = '';
  // 尺寸
  // `boxW×boxH` = **地图块** = 整个主体区。地图（底色 + 国界 + 省界）就是这整块区域。
  @State boxW: number = 0;
  @State boxH: number = 0;
  // `mapW/mapH/mapX/mapY` = 块里那个**不变形**的中国绘制框（居中）。见 core/render.MapFrame。
  // 为什么不叫"地图块高"：块高就是 `boxH`；`mapH` 是"能画出的最大的、不变形的中国"有多高。
  @State mapW: number = 0;
  @State mapH: number = 0;
  @State mapX: number = 0;
  @State mapY: number = 0;
  /** 地图填满度（框面积 / 可用区面积）。诊断行与验收都报这个数（见 core/render.mapFillRatio）。 */
  @State mapFill: number = 0;
  // 状态
  @State phase: number = 0;          // 0 读取中 / 1 完成 / 2 出错
  @State walledTotal: number = 0;    // 已上墙张数（decisionStore 说的）
  @State locatedTotal: number = 0;   // 其中有地点、真的能上墙的张数
  @State shownTotal: number = 0;     // 墙上真正画出来的**标记**数（不是照片数）
  @State note: string = '';          // 退化说明（国界/区划读不到时）
  @State selIndex: number = -1;      // 点开的钉子（-1 = 没点开）
  // ── 详情面板的数据（**必须是 @State，不能读 `this.pins`**）──────────────────
  // 理由（这是"点钉子闪一下"的第二个成因，修的是它的下半截）：
  //   · `pins` 是普通字段（`private pins: ScenePin[]`），**不是被观察的**；
  //   · `@Builder detail(pin)` 的参数是**按值**传的普通对象，ArkUI 也不观察它。
  // 于是"详情画什么"这件事只能靠"每次 `pins` 变时 `selIndex` 恰好也变"这个巧合来驱动 ——
  // 只要有一次 `pins` 变了而 `selIndex` 没变，面板就会显示**上一次**那个钉子的照片（静默的错）。
  // 把面板要用的东西拆成被观察的标量/数组，重绘判据就只依赖真正变了的东西。
  @State selName: string = '';       // 面板标题里的地名
  @State selShown: number = 0;       // 该钉子在墙上画出来的标记数（少于张数时面板会说明）
  @State selPhotos: WallPhoto[] = []; // 该钉子的**全部**照片（照片一张都没丢，点开就在这儿）
  // ── 诊断行（临时）────────────────────────────────────────────────────────────
  // 真机上抓不到 hilog，所以把同样的数字**画在屏幕上**：用户截一张图就等于把日志交回来了。
  // 这一行是为了拿 `boxW / boxH / mapH` 的真值（地图为什么小），定位完就该删掉。
  @State diag: string = '';

  private store: DecisionStore = new DecisionStore(getContext(this) as common.UIAbilityContext);
  private idx: LocationIndex = new LocationIndex(getContext(this) as common.UIAbilityContext);
  private photos: WallPhoto[] = [];      // 原始照片（重算场景用）
  private pins: ScenePin[] = [];         // 上一次算出的场景（点开详情时查它）
  private outlineData: OutlineData | undefined = undefined;
  /** 省级边界数据。形状与国界**同一个** `OutlineData`，所以解析/绘制都能复用。 */
  private provinceData: OutlineData | undefined = undefined;

  // ── 手势视野：双指缩放 + 拖动平移 + 重置（task-16 的第 3 件事）──────────────
  //
  // 用户原话：「还有地图应该支持缩放吧 默认铺满」。
  //
  // **手势的全部数学都在 `core/render` 的 `zoomViewAt` / `panViewBy` 里**（纯函数、有单测）。
  // 本页只做三件事，每一件都不含几何公式：
  //   ① 把手势事件给的 **vp 除以画布宽高** → 归一化位置（纯算术，不碰墨卡托）；
  //   ② 手势进行中**只改两个视觉变换**（下面四个 @State），一个几何都不重算；
  //   ③ 抬手时把视觉变换换算成新的视野框，**重算一次**几何。
  //
  // ── 为什么手势中不每帧重算几何（实测数据，见报告）────────────────────────────
  //   一次 `rebuild()` 的几何部分实测（Node/V8，真机那一档 7 张照片）：**4.8ms**，
  //   其中省界 path 3.8ms、国界 path 0.9ms、`buildScene` 0.1ms；239 张照片时 7.3ms。
  //   省界那 3.8ms 与照片数**无关**（11840 个点全量投影），所以"照片少就便宜"不成立。
  //   真机（ArkTS）只会更慢，而 60Hz 的预算是 16.7ms —— 每帧重算会占掉一大半，
  //   而且 `rebuild()` 会改 `markers` 数组（ForEach 的 key 里带坐标）→ **每帧重建全部
  //   `Circle` 组件**，那是肉眼可见的闪。
  //   所以：手势中只做视觉变换（标记、国界、省界、轨迹全在**同一层容器**里，
  //   一起缩放平移 → 它们在手势中的相对关系**逐点精确**），抬手才重算。
  //   ⚠️ 视觉与几何的**等价性**是"抬手不跳"的前提，推导见 `applyGestureVisual`。

  /** 手势中的视觉缩放（只作用在"缩放层"这一个容器上，不改任何几何）。 */
  @State gScale: number = 1;
  /** 手势中的视觉平移（vp，作用在"平移层"容器上）。两个容器**嵌套**，合成顺序因此无歧义。 */
  @State gTx: number = 0;
  @State gTy: number = 0;
  /** 当前是否就是"默认铺满"的视野（重置按钮的可用态 + 诊断行）。 */
  @State viewIsDefault: boolean = true;

  /** 默认铺满的视野（由数据 + 画布求出，见 `rebuild`）。**重置视野按钮**回到它。 */
  private defaultBounds: number[] = CHINA_REGION.bounds;
  /** 当前视野。`userMoved` 为假时每次 `rebuild` 都跟随数据/画布重算。 */
  private viewBounds: number[] = CHINA_REGION.bounds;
  /** 用户是否**动过**视野。动过之后，数据或画布变化不再把它拉回默认（那会打断用户）。 */
  private userMoved: boolean = false;
  /** 手势开始时的视野快照 —— 每一帧都从**它**算起，不叠加上一帧，所以不累积漂移。 */
  private gestureStartBounds: number[] = CHINA_REGION.bounds;
  /** 手势期间的累积量（只在抬手时才换算成视野）。 */
  private gK: number = 1;
  private gPx: number = 0;
  private gPy: number = 0;
  private gPanX: number = 0;
  private gPanY: number = 0;
  /** 同时在跑的手势个数：双指缩放与拖动可以并行，而**快照只能取一次**。 */
  private gestureCount: number = 0;

  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', `${DIAG} aboutToAppear：页面进入，开始 load()`);
    this.load();
  }

  /** 取数据 → 算场景。**不要**把 buildFrom 与 awaitIdle 合成一步（见文件头）。 */
  private async load(): Promise<void> {
    // 数据要重读了 → 之前点开的那个钉子已经不一定是同一个了，**这里**才是清选中项的地方。
    this.close();
    const walled: string[] = this.store.walledIds();
    this.walledTotal = walled.length;
    hilog.info(DOMAIN, TAG, '%{public}s', `${DIAG} load 开始：decisions 上墙 ${walled.length} 张（此时画布 ${this.boxW}×${this.boxH}）`);

    // 1) 区划数据：buildScene 内部要 nearestCounty 反查地名（退化路径）。
    //    读不到也继续 —— 有 place 的照片不依赖它，没有 place 的会退回坐标标签。
    const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    try {
      const bytes: Uint8Array = await ctx.resourceManager.getRawFileContent(AREA_RAW_NAME);
      parseAreaData(buffer.from(bytes).toString('utf-8'));   // 幂等，重复调用无害
    } catch (e) {
      this.note = '区划数据未装载：没有手选地点的照片会显示成坐标';
      hilog.warn(DOMAIN, TAG, '%{public}s', `区划数据读取失败：${errText(e)}`);
    }

    // 2) 国界。读不到就退化成"只有钉子和线"的墙（不是白屏）。
    try {
      const bytes: Uint8Array = await ctx.resourceManager.getRawFileContent(OUTLINE_RAW_NAME);
      this.outlineData = parseOutline(buffer.from(bytes).toString('utf-8'));
      if (this.outlineData === undefined) {
        this.note = appendNote(this.note, '国界数据解析失败：本次不画国界线');
        hilog.warn(DOMAIN, TAG, '%{public}s', `国界数据解析失败（${bytes.length} 字节）`);
      }
    } catch (e) {
      this.note = appendNote(this.note, '国界数据未装载：本次不画国界线');
      hilog.warn(DOMAIN, TAG, '%{public}s', `国界数据读取失败：${errText(e)}`);
    }

    // 2′) 省级边界。**与国界完全同一条路径**（同一个 parseOutline、同一个 OutlineData 形状），
    //     所以这里除了文件名之外没有第二套逻辑。读不到就只少一层线，页面上留一行说明。
    //     为什么要有它：用户原话「至少要有省级划分的边界线 现在整个地图都是一片」——
    //     只有国界时，放大到一座城之后内陆没有任何线，屏幕上就是一整片同一个颜色。
    try {
      const bytes: Uint8Array = await ctx.resourceManager.getRawFileContent(PROVINCE_RAW_NAME);
      this.provinceData = parseOutline(buffer.from(bytes).toString('utf-8'));
      if (this.provinceData === undefined) {
        this.note = appendNote(this.note, '省级边界解析失败：本次不画省界');
        hilog.warn(DOMAIN, TAG, '%{public}s', `省级边界解析失败（${bytes.length} 字节）`);
      }
    } catch (e) {
      this.note = appendNote(this.note, '省级边界未装载：本次不画省界');
      hilog.warn(DOMAIN, TAG, '%{public}s', `省级边界读取失败：${errText(e)}`);
    }

    // 3) 地点索引：**先触发补读，再等它稳定**（两行都要，契约见文件头）
    let entries: LocationEntry[] = [];
    try {
      await this.idx.buildFrom(walled);
      entries = await this.idx.awaitIdle();
    } catch (e) {
      // 索引失败不该让整页白屏：拿盘上现有的（可能是空），页面照常显示"没有可挂的钉子"。
      hilog.warn(DOMAIN, TAG, '%{public}s', `地点索引构建失败：${errText(e)}`);
      entries = this.idx.load();
    }

    // 4) 「上墙」这个资格由 decisionStore 定义 —— 索引里可能有没上墙的照片，必须过滤掉。
    //    用 Map 而不是嵌套循环：walled 可能上千条。
    const onWall: Map<string, boolean> = new Map<string, boolean>();
    for (let i = 0; i < walled.length; i++) { onWall.set(walled[i], true); }
    const photos: WallPhoto[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e: LocationEntry = entries[i];
      if (!onWall.has(e.photoId)) { continue; }
      const p: WallPhoto = { photoId: e.photoId, lat: e.lat, lon: e.lon, takenAt: e.takenAt };
      if (e.place !== undefined) { p.place = e.place; }
      if (e.manual === true) { p.manual = true; }
      photos.push(p);
    }
    photos.sort((a: WallPhoto, b: WallPhoto): number => (a.photoId < b.photoId ? -1 : (a.photoId > b.photoId ? 1 : 0)));
    this.photos = photos;
    this.phase = 1;
    this.rebuild();
    hilog.info(DOMAIN, TAG, '%{public}s',
      `${DIAG} load 结束：上墙 ${walled.length} 张，索引条目命中 ${photos.length} 张`
      + `，有地点的 ${this.locatedTotal} 张，标记 ${this.shownTotal} 个`
      + `，钉子 ${this.pins.length} 个，画布 ${this.boxW}×${this.boxH}`);
  }

  /**
   * 重算场景。**唯一**的几何入口 —— 只在「数据到了」「画布尺寸变了」或「手势抬手」时调用。
   * 画布尺寸没拿到（首帧之前）时什么都不做，等 `onAreaChange` 再来一次。
   *
   * ── 视野：三层，**顺序不能换**（本批加了第 ②③ 层）────────────────────────────
   *   ① `fitBounds(this.photos, VIEW_PAD_RATIO)` —— 由**照片数据**求出"能看到全部照片"
   *      的经纬度范围（一张有坐标的都没有 → 全国视野）。
   *   ② `fitViewToCanvas(...)` —— **默认铺满**：把它撑成与画布同比例，消掉 `mapFrame`
   *      的信箱空白（真机真值：376×663.71 的画布上框只有 309.1 宽、左右各空 33.45pt）。
   *   ③ **用户视野** `this.viewBounds` —— 手势缩放/平移的结果。`userMoved` 为假时
   *      它就等于 ② 的产物（每次重算都跟随数据）；为真时以它为准，
   *      但**仍然过一遍 `fitViewToCanvas`**：画布尺寸变了（旋转/分屏）时把手势留下的框
   *      重新对齐到新的画布比例。它对手势产物是**恒等**的（手势只做等比缩放与平移，
   *      比例一直等于画布比例），所以这一步不会在正常路径上动用户的视野。
   *
   * ⚠️ `bounds` **只算一次、只传一处**：国界、省界（`outlinePath`）与照片（`buildScene`）
   * 都从这**同一个** `MapFrame` 上读 `frame.bounds` —— 各传一套参数就会出现
   * "照片用新视野、地图还是旧视野"，照片整体飘到轮廓外面，而且两边都不报错。
   */
  private rebuild(): void {
    if (this.boxW <= 0 || this.boxH <= 0) {
      hilog.info(DOMAIN, TAG, '%{public}s',
        `${DIAG} rebuild 跳过：画布还没量到（boxW=${this.boxW} boxH=${this.boxH}）`);
      return;
    }
    // ① 数据视野（没有有效坐标 → 全国视野，与改动前一致）
    const vb: number[] | undefined = fitBounds(this.photos, VIEW_PAD_RATIO);
    const dataBounds: number[] = vb !== undefined ? vb : CHINA_REGION.bounds;
    // ② 默认铺满：撑成与画布同比例（框 ⊇ 数据；pt/度 不变、框绕数据长出去 → 照片不动）
    this.defaultBounds = fitViewToCanvas(dataBounds, this.boxW, this.boxH);
    // ③ 用户视野
    if (!this.userMoved) { this.viewBounds = this.defaultBounds; }
    const bounds: number[] = fitViewToCanvas(this.viewBounds, this.boxW, this.boxH);
    this.viewBounds = bounds;
    this.viewIsDefault = !this.userMoved;
    // 地图块 = 整个主体区（地图是这整块区域的底色）；框 = 块里那个不变形的视野。
    // 有界视野下 ②③ 让**框恒等于块**（信箱空白 0）；广域视野下框填不满块，
    // `mapFillRatio` 把那个比值报出来（诊断行/验收读的就是它）。
    const frame: MapFrame = mapFrame(this.boxW, this.boxH, bounds);
    this.mapX = r2(frame.x);
    this.mapY = r2(frame.y);
    this.mapW = r2(frame.w);
    this.mapH = r2(frame.h);
    this.mapFill = r2(mapFillRatio(frame));

    // 国界：坐标已按 frame 平移过（与钉子同一个坐标系）；投影用的 bounds 就是 frame.bounds，
    // 与 buildScene 读的是同一处（outlinePath 已经没有 bounds 参数了）；视口剔除也在里面
    let chinaPath: string = '';
    if (this.outlineData !== undefined) {
      chinaPath = outlinePath(this.outlineData.rings, frame);
    }
    this.chinaPath = chinaPath;

    // 省界：**同一个 outlinePath、同一个 frame**（含视口剔除）。放大到一座城时
    // 大部分环会被剔掉（真机 376×663.71 那一档实测 38/107 条可见），这是预期的：
    // 视野附近那些线会露出来，其余不画。
    let provincePath: string = '';
    if (this.provinceData !== undefined) {
      provincePath = outlinePath(this.provinceData.rings, frame);
    }
    this.provincePath = provincePath;

    const pins: ScenePin[] = buildScene(this.photos, frame, 1);
    this.pins = pins;
    // 轨迹：按拍摄时间把钉子连成一条折线（时间未知的排最后）。少于 2 个钉子时是空串。
    this.trackPath = trajectoryPath(pins);

    // 把场景摊成两个扁平数组：ForEach 只能遍历数组，而 Stack 里每一项是一个组件。
    // ── 标记（照片的**全部**画面表达）───────────────────────────────────────────
    // 位置 = 钉子 + `pin.markers[k]`（由 core 的 `pinMarkers` 算好，见它的三条性质）。
    // 本页**一个几何公式都没有**：这里只有加法。
    const markers: WallMarker[] = [];
    const pinsView: WallPin[] = [];
    for (let i = 0; i < pins.length; i++) {
      const p: ScenePin = pins[i];
      const n: number = p.photos.length;
      const ms: PinMarker[] = p.markers;
      for (let k = 0; k < ms.length; k++) {
        markers.push({
          key: `${p.pinId}#${k}`,
          idx: i,
          x: r2(p.x + ms[k].dx),
          y: r2(p.y + ms[k].dy)
        });
      }
      // 「＋N」：标记画不全时出现，它**就是**"这个钉子还有 N 张"。
      // 位置来自 core/render.badgeRectOf（右缘与最右那个标记对齐，绝不压点）。
      const b: Rect = badgeRectOf(p, ms);
      const label: string = n > 1 ? `${p.name} ·${n}` : p.name;
      const labelW: number = Math.round(label.length * LABEL_FP + 6);
      pinsView.push({
        idx: i,
        cx: r2(p.x),
        cy: r2(p.y),
        label: label,
        labelW: labelW,
        // 标签基线：钉点外沿（PIN_HALO_R）之上再抬 LABEL_LIFT，再留一个字号的高度。
        // 与预览的 `pinAnchorSvg` 同一个口径（差别只有字号：8fp vs 6.5 用户单位）。
        labelY: r2(p.y - PIN_HALO_R - LABEL_LIFT - LABEL_FP),
        hitX: r2(p.x - HIT_SIZE / 2),
        hitY: r2(p.y - HIT_SIZE / 2),
        badge: n > ms.length ? `+${n - ms.length}` : '',
        badgeX: r2(b.x),
        badgeY: r2(b.y),
        badgeW: r2(b.w)
      });
    }
    this.markers = markers;
    this.pinsView = pinsView;
    let located: number = 0;
    for (let i = 0; i < pins.length; i++) { located += pins[i].photos.length; }
    this.locatedTotal = located;
    this.shownTotal = markers.length;
    // ── 诊断（临时）：真机上抓不到 hilog，所以把同样的数字也画在屏幕上 ──────────
    // 要的就是这一行的真值：`boxW / boxH` 是 onAreaChange 给的**地图块**（整个主体区），
    // `图框 W×H@(x,y)` 是块里那个不变形的绘制框，`pathLen` 是国界 path 的字符数
    //（=0 就说明国界根本没画出来，那是另一类缺陷），`track` 是轨迹折线的字符数。
    //
    // 本形态新增三样，都是为了**真机一眼核对**：
    //   · `填满 x%`：`mapFillRatio` —— 框面积 / 可用区面积。**有界视野必须是 100%**
    //     （那就是"地图铺满"的字面意思）；广域视野会小于 100%，那时它是**预期的**
    //     （撑满块会把视野拉到南半球、中国反而更小 —— 见 core/render 的 MapFrame 注释）。
    //   · `pins N ｜ 标记 M`：M 是墙上真正画出来的圆点数（= 每个钉子的 min(张数, 5) 之和）。
    //     它与 `上墙` 的差额就是所有「＋N」的和 —— 照片一张都没丢，点开钉子就在面板里。
    //   · `国界 N 省界 N`：两条 path 的字符数。省界那个数**必须明显大于国界**
    //     （省界是内陆的线网、国界只是海岸线）；`省界 0` = 那一层根本没画出来。
    //   · `视野态` 与 `手势 k/T`：默认铺满 / 已改，以及可缩放的倍数区间。
    const diagBounds: string = `数据[${r2(dataBounds[0])},${r2(dataBounds[1])},${r2(dataBounds[2])},${r2(dataBounds[3])}]`
      + `→铺满[${r2(bounds[0])},${r2(bounds[1])},${r2(bounds[2])},${r2(bounds[3])}]`;
    // 缩放界限换算成"放大倍数"口径：最小 1×（= 视野框恒等于全国框）、最大 62/0.6 ≈ 103×。
    // **两个数都从 core 的 `viewZoomRange()` 读**，不再手写 `'1×'`。
    // 手写的那个 1× 曾经只是显示：经度跨度确实被夹在 62°，而同一个框的纬度能膨胀到 −20.6°
    // （用户看到的就是这个）。现在约束端（`containInChina`）与显示端读同一份定义，
    // `render.test.ts` 里有一条单测直接断言"显示的下界 == 反复缩小实际到达的下界"。
    const zoomRange: number[] = viewZoomRange();
    const zoomMin: number = zoomRange[0];
    const zoomMax: number = zoomRange[1];
    this.diag = `box ${r2(this.boxW)}×${r2(this.boxH)} ｜ 图框 ${this.mapW}×${this.mapH}@(${this.mapX},${this.mapY}) 填满 ${this.mapFill * 100}%`
      + ` ｜ 视野 ${diagBounds}${vb !== undefined ? '(数据)' : '(全国)'}`
      + ` ｜ 放大 ${r2(viewZoomOf(dataBounds))}×→${r2(viewZoomOf(bounds))}×`
      + ` ｜ pins ${pins.length} ｜ 标记 ${markers.length}`
      + ` ｜ 国界 ${chinaPath.length} 省界 ${provincePath.length} ｜ track ${this.trackPath.length}`
      + ` ｜ 视野态 ${this.viewIsDefault ? '默认铺满' : '已改'}（可缩 ${r2(zoomMin)}×~${r2(zoomMax)}×）`
      + ` ｜ 手势 k=${r2(this.gScale)} T=(${r2(this.gTx)},${r2(this.gTy)})`
      + ` ｜ 上墙 ${this.walledTotal} 命中 ${located} 标记 ${markers.length}`;
    hilog.info(DOMAIN, TAG, '%{public}s',
      `${DIAG} rebuild：boxW=${this.boxW} boxH=${this.boxH}`
      + ` blockH=${frame.blockH} mapW=${frame.w} mapH=${frame.h} mapX=${frame.x} mapY=${frame.y}`
      + ` mapFill=${this.mapFill}`
      + ` dataBounds=[${r2(dataBounds[0])},${r2(dataBounds[1])},${r2(dataBounds[2])},${r2(dataBounds[3])}]`
      + ` bounds=[${r2(bounds[0])},${r2(bounds[1])},${r2(bounds[2])},${r2(bounds[3])}]`
      + ` boundsFromData=${vb !== undefined}`
      + ` viewZoomData=${r2(viewZoomOf(dataBounds))} viewZoomFilled=${r2(viewZoomOf(bounds))}`
      + ` geoAspect=${geoAspect(bounds).toFixed(4)} canvasAspect=${(this.boxW / this.boxH).toFixed(4)}`
      + ` pins=${pins.length} markers=${markers.length}`
      + ` chinaPath.length=${chinaPath.length} provincePath.length=${provincePath.length}`
      + ` provinceRings=${this.provinceData === undefined ? 0 : this.provinceData.rings.length}`
      + ` trackPath.length=${this.trackPath.length}`
      + ` walled=${this.walledTotal} located=${located} markers=${markers.length}`);
    // ── 这里**不许**再写 `this.selIndex = -1` ────────────────────────────────
    // 这行曾经在：`rebuild()` 只在"数据到了"或"画布尺寸变了"时跑，而 `onAreaChange` 每次
    // 画布尺寸变化都会调它（页面刚进来时布局还没稳定 → 会连着跑好几次）。
    // 于是「点钉子 → selIndex=i → 紧接着一次 rebuild() 清成 -1」= 详情面板出现又消失
    // = 用户看到的"闪一下"。清选中项是**数据换了**才该做的事，已经挪到 `load()` 开头。
  }

  /**
   * 手势开始：取一次视野**快照**。之后的每一帧都从这份快照算起（不叠加上一帧），
   * 所以几百帧的手势也不会累积浮点漂移。
   *
   * 为什么用计数器而不是布尔：双指缩放与拖动可以在 `GestureGroup(Parallel)` 里**同时**跑
   * （用户在缩放的同时移动两指中点是很常见的），而快照只能在**第一个**手势开始时取一次 ——
   * 否则第二个手势一开始就把"用户已经缩放出来的视野"重新当成起点，画面会跳回去。
   */
  private gestureBegin(): void {
    if (this.gestureCount === 0) {
      this.gestureStartBounds = this.viewBounds.slice(0, this.viewBounds.length);
      this.gK = 1;
      this.gPx = this.boxW / 2;
      this.gPy = this.boxH / 2;
      this.gPanX = 0;
      this.gPanY = 0;
    }
    this.gestureCount++;
  }

  /**
   * 把"手势累积量"画成两个视觉变换。**这里一个几何公式都没有**，只有一次合成推导：
   *
   *   两个容器是**嵌套**的（平移层在外、缩放层在内），所以合成顺序无歧义：
   *     屏幕坐标' = T + ( C + k·(屏幕坐标 − C) ) = k·屏幕坐标 + (1−k)·C + T
   *   而我们要的手感是"绕**两指中点 P** 缩放 k 倍，再整体平移 D"：
   *     屏幕坐标' = P + k·(屏幕坐标 − P) + D = k·屏幕坐标 + (1−k)·P + D
   *   两式相减得到本函数写的那一行：
   *     **T = (1−k)·(P − C) + D**
   *
   * 这一步的等价性是**抬手不跳**的唯一前提：`gestureFinish` 用
   * `zoomViewAt(快照, k, P/画布) → panViewBy(..., D/画布)` 重算几何，而那正是上面第二条式子
   * 在经纬度空间里的同一件事（`projectMercator` 对经度线性、对纬度按 mercY 线性，
   * 所以"屏幕上绕 P 等比缩放" ≡ "视野框绕 P 对应的地理点等比缩放"）。
   */
  private applyGestureVisual(): void {
    const cx: number = this.boxW / 2;
    const cy: number = this.boxH / 2;
    this.gScale = this.gK;
    this.gTx = (1 - this.gK) * (this.gPx - cx) + this.gPanX;
    this.gTy = (1 - this.gK) * (this.gPy - cy) + this.gPanY;
  }

  /** 双指缩放的一帧。`event.scale` 是**相对手势开始**的累积倍数，正好就是快照的倍数。 */
  private pinchUpdate(e: GestureEvent): void {
    if (!(this.boxW > 0) || !(this.boxH > 0)) { return; }
    const k: number = Number(e.scale);
    if (!Number.isFinite(k) || !(k > 0)) { return; }
    const px: number = Number(e.pinchCenterX);
    const py: number = Number(e.pinchCenterY);
    // 两指中点变了说明用户在缩放的同时也在移动（或换了捏的位置）—— 跟着它走才对
    if (Number.isFinite(px)) { this.gPx = px; }
    if (Number.isFinite(py)) { this.gPy = py; }
    this.gK = k;
    this.applyGestureVisual();
  }

  /** 拖动的一帧。`event.offsetX/offsetY` 是**相对手势开始**的累积位移（vp）。 */
  private panUpdate(e: GestureEvent): void {
    const dx: number = Number(e.offsetX);
    const dy: number = Number(e.offsetY);
    if (Number.isFinite(dx)) { this.gPanX = dx; }
    if (Number.isFinite(dy)) { this.gPanY = dy; }
    this.applyGestureVisual();
  }

  /**
   * 手势结束（或取消）：把视觉变换**换算成新的视野框**，然后重算一次几何。
   *
   * 取消也照样提交（不是丢弃）：用户的手指确实移动过，画面已经跟着变了 ——
   * 这一刻把它弹回原样才是"跳"。取消与结束在这里的唯一区别是取消时最后一帧的位置
   * 可能不准，但那比"画面自己弹回去"轻得多。
   *
   * `moved` 为假（手指按下又抬起、没动）时**什么都不做**：不重算、不标记 `userMoved`。
   * 这一条直接决定了"点钉子"不会触发一次多余的几何重算。
   */
  private gestureFinish(): void {
    if (this.gestureCount > 0) { this.gestureCount--; }
    if (this.gestureCount > 0) { return; }
    const moved: boolean = this.gK !== 1 || this.gPanX !== 0 || this.gPanY !== 0;
    const ok: boolean = this.boxW > 0 && this.boxH > 0;
    let nb: number[] = this.gestureStartBounds;
    if (moved && ok) {
      if (this.gK !== 1) {
        nb = zoomViewAt(nb, this.gK, this.gPx / this.boxW, this.gPy / this.boxH);
      }
      if (this.gPanX !== 0 || this.gPanY !== 0) {
        nb = panViewBy(nb, this.gPanX / this.boxW, this.gPanY / this.boxH);
      }
    }
    // 视觉变换先归位，再重算 —— 两者在**同一次**状态更新里，所以看不到中间态
    this.gK = 1;
    this.gPanX = 0;
    this.gPanY = 0;
    this.gScale = 1;
    this.gTx = 0;
    this.gTy = 0;
    if (!moved || !ok) { return; }
    this.viewBounds = nb;
    this.userMoved = true;
    this.rebuild();
    hilog.info(DOMAIN, TAG, '%{public}s',
      `${DIAG} 手势结束：k=${this.gK} pan=(${this.gPanX},${this.gPanY})`
      + ` → 视野=[${r2(nb[0])},${r2(nb[1])},${r2(nb[2])},${r2(nb[3])}]`
      + ` 放大=${r2(viewZoomOf(nb))}× pins=${this.pins.length}`);
  }

  /** **重置视野**：一键回到"默认铺满"（`rebuild` 会重新由数据求出它，不存旧值）。 */
  private resetView(): void {
    this.userMoved = false;
    this.gK = 1;
    this.gPanX = 0;
    this.gPanY = 0;
    this.gScale = 1;
    this.gTx = 0;
    this.gTy = 0;
    this.rebuild();
    hilog.info(DOMAIN, TAG, '%{public}s', `${DIAG} 重置视野：回到默认铺满`);
  }

  /**
   * 点开一个钉子：看它挂着的（**全部**）照片。
   *
   * 把面板要用的三样东西**拷进 @State**（而不是让 `build()` 去读 `this.pins[i]`）：
   * `pins` 不是被观察的，详情面板的重绘必须由被观察的状态驱动 —— 见 `selName` 处的注释。
   * `slice()` 也顺带切断了对 `pins` 的别名依赖：之后哪怕场景重算出一批**新**的数组对象，
   * 面板显示的内容也不会跟着变。
   */
  private open(idx: number): void {
    if (idx < 0 || idx >= this.pins.length) { this.close(); return; }
    const pin: ScenePin = this.pins[idx];
    this.selName = pin.name;
    this.selShown = markerCountOf(pin);
    this.selPhotos = pin.photos.slice(0, pin.photos.length);
    this.selIndex = idx;
  }

  /** 关掉详情面板（也用于"数据要重读了"时把上一次的选择清干净）。 */
  private close(): void {
    this.selIndex = -1;
    this.selName = '';
    this.selShown = 0;
    this.selPhotos = [];
  }

  build() {
    Column() {
      // ── 顶部：返回 + 张数 ────────────────────────────────────────────────
      Row() {
        Text('‹ 返回').fontSize(15).fontColor('#1F6FEB').padding({ right: 12 })
          .onClick(() => { router.back(); })
        Text(`地图墙 ｜ ${this.pinsView.length} 个地点 · ${this.shownTotal} 个标记 / 上墙 ${this.walledTotal} 张`)
          .fontSize(15).fontWeight(FontWeight.Medium).layoutWeight(1)
        // ── 重置视野：一键回到"默认铺满"──────────────────────────────────
        // 放在**手势容器之外**（这一行在 Stack 外面），所以它不会被自己的手势缩放/平移，
        // 也不会与地图的拖动冲突 —— 一个"永远在原位"的按钮才找得到。
        // 已经在默认视野时变灰：不是禁用（点了也无害），而是告诉用户"你现在就是默认状态"。
        Text(this.viewIsDefault ? '已铺满' : '重置视野')
          .fontSize(13)
          .fontColor(this.viewIsDefault ? '#AAAAAA' : '#1F6FEB')
          .padding({ left: 10 })
          .onClick(() => { this.resetView(); })
      }
      .width('100%').padding({ left: 12, right: 12, top: 10, bottom: 8 })

      // ── 主体：整块都是地图（地图块 = 这个 Stack 的全部）─────────────────
      // 手势挂在这一层（最外），里面是**两层嵌套的变换容器**：
      //   Stack(平移层) → Stack(缩放层) → 底/国界/省界/轨迹/挂线/卡片/钉点
      // 为什么嵌套而不是把两个变换写在同一层：嵌套让"先缩放再平移"这个合成顺序
      // 在结构上就定死了，不依赖 ArkUI 对同层 translate+scale 的复合顺序 ——
      // 而那个顺序正是"抬手时画面跳不跳"的判据（推导见 `applyGestureVisual`）。
      Stack({ alignContent: Alignment.TopStart }) {
        Stack({ alignContent: Alignment.TopStart }) {
          Stack({ alignContent: Alignment.TopStart }) {
            // 地图块的底色 = 整个主体区。这一层就是"地图铺满主体区"最直接的体现：
            // 它替代了旧版那条只占上方 37% 的 `height(this.mapH)` 色带。
            Column().width('100%').height('100%').backgroundColor('#F2F7EF')

            // 国界：一条 path 装下 96 个环（不放 96 个组件）。
            // 坐标已经在 core/render.outlinePath 里按地图框平移过 —— 与钉子、卡片同一个坐标系。
            if (this.chinaPath.length > 0) {
              Shape() {
                Path().width(this.boxW).height(this.boxH).commands(this.chinaPath)
              }
              .width(this.boxW).height(this.boxH)
              .viewPort({ x: 0, y: 0, width: this.boxW, height: this.boxH })
              .fill('#E8F0E4').stroke('#BFD3B8').strokeWidth(0.8)
            }

            // 省界：与国界**同一套机制**的第二条 path。
            // ⚠️ 顺序不能反：国界那一层是**填充面**（陆地 `#E8F0E4`），省界是陆地内部的线 ——
            // 画在填充之前会被整块盖掉（症状："数据里 107 条环，图上一条都看不见"）。
            // 也不能放到轨迹/照片之后：省界是底图信息，不是内容。
            if (this.provincePath.length > 0) {
              Shape() {
                Path().width(this.boxW).height(this.boxH).commands(this.provincePath)
              }
              .width(this.boxW).height(this.boxH)
              .viewPort({ x: 0, y: 0, width: this.boxW, height: this.boxH })
              .fill(Color.Transparent).stroke(PROVINCE_STROKE).strokeWidth(PROVINCE_WIDTH)
              .strokeLineJoin(LineJoinStyle.Round)
            }

            // 旅行轨迹：按拍摄时间把钉子连成一条折线。画在国界/省界**之上**、标记**之下** ——
            // 它是"我走过哪里"的背景叙事，压住标记就成了噪声。
            if (this.trackPath.length > 0) {
              Shape() {
                Path().width(this.boxW).height(this.boxH).commands(this.trackPath)
              }
              .width(this.boxW).height(this.boxH)
              .viewPort({ x: 0, y: 0, width: this.boxW, height: this.boxH })
              .fill(Color.Transparent).stroke(TRACK_COLOR).strokeWidth(TRACK_WIDTH)
              .strokeOpacity(0.85)
              .strokeLineCap(LineCapStyle.Round).strokeLineJoin(LineJoinStyle.Round)
            }

            // ── 照片标记：钉子旁那一簇小圆点（**墙上照片的全部画面表达**）────────
            // 每个点一个 `Circle`，位置 = 钉子 + `pinMarkers` 的偏移（core 算好的）。
            // 旧版这里是 26×34 的 `Image` 卡片 + 一条挂线；本形态下**一张缩略图都不在墙上**
            // —— 大图在「点开钉子」的详情面板里，这是本批在内存与观感上的两处收益。
            //
            // ⚠️ ForEach 的 key 里**带坐标**：位置变了就重建组件（一次几何重算会重建这些点）。
            // 这正是"手势中不重算几何"的第二个理由（第一个是重算本身 ~4.8ms）：手势中只改
            // 外层容器的变换，这些 key 一个都不变 → 标记组件**一个都不重建**，只是被整体缩放/平移。
            ForEach(this.markers, (m: WallMarker) => {
              Circle()
                .width(MARKER_R * 2).height(MARKER_R * 2).fill(MARKER_COLOR)
                .position({ x: m.x - MARKER_R, y: m.y - MARKER_R })
            }, (m: WallMarker) => `${m.key}@${m.x},${m.y}`)

            // 钉点 + 地名标签 + 命中区（命中区是透明的，钉点只有 3.4pt，手指点不到）
            ForEach(this.pinsView, (a: WallPin) => {
              // 钉点的外圈（淡红描边）：让它在省界/轨迹上仍然跳得出来。**与预览同口径**
              // （`pinAnchorSvg` 里的 halo），只有颜色字符串与半径从 core 读，本页不另写数。
              Circle()
                .width(PIN_HALO_R * 2).height(PIN_HALO_R * 2)
                .fill(Color.Transparent).stroke(PIN_COLOR).strokeWidth(0.6).opacity(0.4)
                .position({ x: a.cx - PIN_HALO_R, y: a.cy - PIN_HALO_R })
              Circle()
                .width(PIN_DOT_R * 2).height(PIN_DOT_R * 2).fill(PIN_COLOR)
                .position({ x: a.cx - PIN_DOT_R, y: a.cy - PIN_DOT_R })
              Text(a.label)
                .fontSize(LABEL_FP).fontColor('#3F4A3C')
                .width(a.labelW).textAlign(TextAlign.Center)
                .position({ x: a.cx - a.labelW / 2, y: a.labelY })
              // 「＋N」：标记画不全时出现，点它等于点钉子。
              // 位置来自 core/render.badgeRectOf（右缘与最右那个标记对齐，绝不压点）。
              if (a.badge.length > 0) {
                Text(a.badge)
                  .fontSize(8).fontColor('#8A8A8A')
                  .width(a.badgeW + 8).textAlign(TextAlign.Center)
                  .position({ x: a.badgeX - 4, y: a.badgeY })
                  .onClick(() => { this.open(a.idx); })
              }
              // 命中区放**最后**：它是透明的、32vp 见方，点在钉点/标签/＋N 上都能落到它这里。
              Column()
                .width(HIT_SIZE).height(HIT_SIZE)
                .backgroundColor(Color.Transparent)
                .position({ x: a.hitX, y: a.hitY })
                .onClick(() => { this.open(a.idx); })
            }, (a: WallPin) => `${a.idx}@${a.cx},${a.cy}`)
          }
          // ── 缩放层（内）：绕自身中心缩放。手势中的**不动点**修正由 `gTx/gTy` 承担
          //    （见 applyGestureVisual 的推导：T = (1−k)·(P − C) + D）。
          .width('100%').height('100%')
          .scale({ x: this.gScale, y: this.gScale, centerX: '50%', centerY: '50%' })
        }
        // ── 平移层（外）：只做整体平移。两层嵌套 → 合成顺序在结构上定死。
        .width('100%').height('100%')
        .translate({ x: this.gTx, y: this.gTy })

        // ── 空态 / 读取中：**在手势容器之外** ──────────────────────────────
        // 它们是提示文字，不是地图内容：跟着缩放平移会变成"提示也一起放大"，
        // 而且空态时用户 pinch 一下就会看到字被拉花。设备侧本来就与预览不同
        // （提示在 Stack 外面、不占画布），这里是同一类"绘制上的差异"。
        // ⚠️ 位置用**块高的一半**（不是 `mapY`）：框可能只占块的一小半（广域视野），
        //    按 `mapY` 放会把提示挤到顶上那条带里。
        if (this.phase === 0) {
          Text('正在读取地点…').fontSize(13).fontColor('#999')
            .width('100%').textAlign(TextAlign.Center).position({ x: 0, y: this.boxH / 2 })
        } else if (this.phase === 1 && this.markers.length === 0) {
          Column() {
            Text(this.walledTotal === 0
              ? '墙上还没有照片。\n在刷卡页右滑收藏，再点「上墙」—— 上墙的照片会出现在这张地图上。'
              : `上墙的 ${this.walledTotal} 张都没有地点，墙上没有可放的钉子。\n上墙时如果照片没有 GPS，可以手选省 / 市 / 县，那个地点就会成为墙上的一个钉子。`)
              .fontSize(13).fontColor('#999').textAlign(TextAlign.Center)
          }
          .width('100%').padding({ left: 28, right: 28 }).position({ x: 0, y: this.boxH / 2 - 16 })
        }
      }
      .width('100%').layoutWeight(1).clip(true)
      // ── 手势：双指缩放 + 单指拖动 ────────────────────────────────────────
      // `GestureGroup(Parallel)`：两个手势**可以同时**跑（一边缩放一边移动两指中点是常见操作），
      // 快照只在第一个开始时取一次（见 `gestureBegin` 的计数器）。
      //
      // ⚠️ **与「点钉子」的冲突是怎么处理的**（工单点名要说明）：
      //   `PanGesture({ distance: 8 })` —— 平移要在手指移动 **8vp** 之后才激活。
      //   一次点按的移动通常 < 3vp，所以它**根本不会**激活平移，`.onClick` 照常触发。
      //   而"手指移动超过 8vp"本来就是**拖动**而不是点按 —— 那时不该打开钉子详情，
      //   让平移赢是对的（这也是地图类应用的通用手感）。
      //   换句话说：冲突不是"被吞掉了"，而是**用 8vp 的阈值把两种意图分开**。
      //   `HIT_SIZE = 32vp` 的命中区仍然是 32vp，没有因为手势而缩小。
      .gesture(
        GestureGroup(GestureMode.Parallel,
          PinchGesture({ fingers: 2 })
            .onActionStart(() => { this.gestureBegin(); })
            .onActionUpdate((e: GestureEvent) => { this.pinchUpdate(e); })
            .onActionEnd(() => { this.gestureFinish(); })
            .onActionCancel(() => { this.gestureFinish(); }),
          PanGesture({ fingers: 1, distance: 8 })
            .onActionStart(() => { this.gestureBegin(); })
            .onActionUpdate((e: GestureEvent) => { this.panUpdate(e); })
            .onActionEnd(() => { this.gestureFinish(); })
            .onActionCancel(() => { this.gestureFinish(); })
        )
      )
      .onAreaChange((_oldArea: Area, newArea: Area) => {
        // 拿到的宽高是 vp（与 pt 同数值），正是 core/render 需要的画布尺寸
        const w: number = Number(newArea.width);
        const h: number = Number(newArea.height);
        // **原值先记下来**：`Area.width/height` 的类型是 `Length`（number | string | Resource），
        // `Number()` 对它是不是可靠只能靠真值说话 —— 这一行会把 `Length` 的原样和转换结果
        // 一起打出来（`String(...)` 而不是 `Number(...)`，字符串带单位时会原形毕露）。
        hilog.info(DOMAIN, TAG, '%{public}s',
          `${DIAG} onAreaChange 原值 w="${String(newArea.width)}" h="${String(newArea.height)}"`
          + ` → Number 后 ${w}×${h}（旧 ${this.boxW}×${this.boxH}）`
          + ` 有限=${Number.isFinite(w) && Number.isFinite(h)}`);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
          && (Math.abs(w - this.boxW) > 0.5 || Math.abs(h - this.boxH) > 0.5)) {
          this.boxW = w;
          this.boxH = h;
          this.rebuild();
        }
      })

      // ── 退化说明（国界/区划读不到时才出现）─────────────────────────────
      if (this.note.length > 0) {
        Text(this.note).fontSize(10).fontColor('#B08A5A')
          .width('100%').padding({ left: 12, right: 12, bottom: 3 })
      }
      // ── 诊断行（临时）：让用户截一张图就等于把日志交回来（真机上 hilog 抓不到）──
      if (this.diag.length > 0) {
        Text(`诊断 ${this.diag}`).fontSize(9).fontColor('#B08A5A')
          .width('100%').padding({ left: 12, right: 12, bottom: 2 })
      }
      Text('双指缩放 · 拖动平移 · 点钉子或「＋N」看这个地点的全部照片').fontSize(10).fontColor('#AAA')
        .width('100%').padding({ left: 12, right: 12, bottom: 8 })

      // ── 点开钉子的详情：**这是看大图的地方**（本形态下墙上只有小圆点）────────
      // 判据只看 @State（`selIndex` / `selPhotos`），**不看 `this.pins`** —— 后者不是被观察的。
      if (this.selIndex >= 0 && this.selPhotos.length > 0) {
        this.detail()
      }
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }

  /**
   * 一个钉子的详情：地名、张数、**全部**照片（墙上只画了最多 `MAX_MARKERS` 个点）。
   *
   * 本形态下它就是"看大图"的唯一入口，也是"照片一张都没丢"的收口：
   * 墙上每个钉子最多画 `MAX_MARKERS = 5` 个点，其余全部在这里，尺寸 72×92（够读）。
   * 日期也在这里给（墙上没有可读字号的余地）。
   *
   * **不收参数**：数据全部从 `selName` / `selShown` / `selPhotos` 这三个 `@State` 读。
   * 收 `ScenePin` 参数会把它变成"按值传的普通对象"，ArkUI 不观察它（见 `selName` 处的注释）。
   *
   * @Builder 而不是子组件：它直接用 this，且只有这一处使用。
   */
  @Builder
  detail() {
    Column() {
      Row() {
        Text(`${this.selName} ·${this.selPhotos.length} 张`).fontSize(13).fontWeight(FontWeight.Medium).layoutWeight(1)
        Text('关闭').fontSize(13).fontColor('#1F6FEB')
          .onClick(() => { this.close(); })
      }
      .width('100%').padding({ bottom: 6 })

      // 只在"墙上没画全"时说明。`selShown` 是**画出来的圆点数**（= min(张数, MAX_MARKERS)）；
      // 这里是**全部**照片，一张都没少。旧的"受画布空间限制所以少挂 N 张"那套话术
      // 随卡片几何一起删掉了 —— 现在少画几个点与画布大小无关，是标记本身的上限。
      if (this.selShown > 0 && this.selShown < this.selPhotos.length) {
        Text(`墙上画了 ${this.selShown} 个标记（一个地点最多 ${MAX_MARKERS} 个），这里是全部 ${this.selPhotos.length} 张`)
          .fontSize(10).fontColor('#999').width('100%').padding({ bottom: 4 })
      }

      List({ space: 8 }) {
        ForEach(this.selPhotos, (p: WallPhoto) => {
          ListItem() {
            Column() {
              Image(p.photoId)
                .width(72).height(92).objectFit(ImageFit.Cover)
                .borderRadius(4).backgroundColor('#DCE8F5')
              Text(dateLabel(p.takenAt)).fontSize(9).fontColor('#666').padding({ top: 2 })
            }
          }
        }, (p: WallPhoto) => p.photoId)
      }
      .listDirection(Axis.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%').height(120)
    }
    .width('100%').padding({ left: 12, right: 12, top: 10, bottom: 12 })
    .backgroundColor('#FFFFFF')
    .border({ width: { top: 0.5 }, color: '#DDDDDD' })
  }
}

/** `takenAt` → 「2024-05-01」；0/负数 = 未知。规则**只由 core/render.dateLabel 定义**。 */
function r2(v: number): number { return Math.round(v * 100) / 100; }
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

function appendNote(prev: string, add: string): string {
  return prev.length === 0 ? add : `${prev}；${add}`;
}
