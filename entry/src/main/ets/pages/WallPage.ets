/**
 * 地图墙页面：把「已上墙的照片」挂在中国地图上。
 *
 * ── 这个页面只做三件事（几何**一行都不算**） ─────────────────────────────────
 *   1. **取数据**：`DecisionStore.walledIds()`（谁是上墙的，唯一判据）+ `LocationIndex`
 *      （它们在哪、什么时候拍的）；
 *   2. **调 core/render**：`fitBounds` 由照片坐标求出**视野框**（本批新增：地图缩放到
 *     用户的足迹范围，而不是永远画整个中国）、`buildScene` 算钉子与挂载方案、
 *     国界与照片共用**同一个** `MapFrame`（`frame.bounds` 是唯一的经纬度范围来源）；
 *   3. **把数字摆到屏幕上**：卡片用 `Image` 放在 `hangRects` 给的坐标上，国界用 `Shape`+`Path`。
 *   几何全部来自 `core/render.ts` —— 与 `tools/render-preview.ts` 产出的 SVG **逐点相同**，
 *   所以"在电脑上先看见"这件事是真的，不是近似。
 *
 * ── 渲染方式：国界/轨迹用 Path/Shape，照片用 Image 组件（不是 Canvas）────────
 *   选它的理由（性能判断写在下面）：
 *   · **照片必须是真的照片**。`Image(uri)` 由 ArkUI 负责异步解码、按显示尺寸下采样、
 *     内存紧张时自动回收缓存 —— 这些正是最容易被自己写坏的部分。改成 `Canvas.drawImage`
 *     就得自己持有每张的 `PixelMap` 并管理生命周期（最坏 15 钉 × 9 张 = 135 张 26×34vp
 *     的卡片按 3 倍屏解码约 135×32KB ≈ 4MB，看起来不多，但一旦用户在详情里看大图就会
 *     翻几倍，而释放时机得自己判）。**这份复杂度换不来任何东西**。
 *   · **几何已经是数字了**。`hangRects()` 给的就是画布坐标，`.position({x,y})` 一对一；
 *     预览与设备共用同一个函数，不存在"两边各画一遍"的漂移。
 *   · **场景是算一次的**，不是每帧算。`buildScene` 只在「数据变了」或「画布尺寸变了」时跑；
 *     之后就是一堆静态节点，ArkUI 不重排就什么都不做。节点数上界：候选钉子 ≤ 15 个
 *     （`placement.COLLAPSE_THRESHOLD`），每个最多挂 `MAX_HANG = 9` 张 → 最坏 135 张卡片 + 
 *     15 个钉点 + 15 条标签。这个数量级对 ArkUI 是静态布局，不在热路径上。
 *   · **交互天然可用**：钉点/角标/卡片各自是一个组件，`.onClick` 直接绑；用 Canvas 就得
 *     自己写命中检测。
 *
 * ── 三个 `Shape`（国界 / 轨迹 / 挂线）都显式给 viewPort，且等于自身尺寸 ────────
 *   ArkUI 的 `Shape` 用 `viewPort` 把"用户坐标"映射到组件自身尺寸（官方文档的每个例子
 *   都显式给了 viewPort 与 `Path().width()/height()`）。不给就等于把缩放语义交给默认值 ——
 *   真机上反馈"地图只占屏幕左上角一小块"就有这一层嫌疑。这里把 viewPort 写成
 *   `{x:0, y:0, width: boxW, height: boxH}`：**恒等映射**，画什么坐标就是什么位置，
 *   三个图层与 `.position()` 摆放的卡片共用同一个坐标系，怎么都不会漂。
 *  *
 * ── 索引必须先 buildFrom **再** awaitIdle（两行都要）─────────────────────────
 *   见 `data/locationIndex.ets` 的契约：
 *   · 只 `buildFrom`：并发时它**返回快照**，可能少照片（"这张的 EXIF 还没读到"被误当成没地点）；
 *   · 只 `awaitIdle`：没有构建在跑时它立即返回**盘上现有的**索引，可能整个都是过期的。
 *   两行合起来才是"触发补读 + 等它稳定"。这里与 `PlaceStore.entryAfterIdle` 是同一个道理。
 *
 * ── 与预览刻意不同的两处（都是"设备上才成立"的理由）─────────────────────────
 *   1. **卡片上不叠日期文字**。`HANG_PHOTO_W×H = 26×34` 是预览与设备共用的几何，而预览里
 *      那个 `font-size 4.2`（SVG 用户单位）在真机上约等于 2pt 印字，糊成一团。设备侧卡片
 *      直接就是照片本身；**日期改在「点开钉子」的详情里显示**（那里字号正常、还能看大图）。
 *   2. **地名标签用 8fp**（预览里是 6.5 用户单位）。预览是 2 倍图，8fp 与它的视觉大小同量级，
 *      但在真屏上是从"一道糊影"变成"能认出字"的那一档。宽度按字数估算，居中于钉子。
 *
 * ── 空态与退化 ──────────────────────────────────────────────────────────────
 *   · 一张都没上墙 → 告诉用户怎么把照片挂上来（不是留一片空白）；
 *   · 上墙了但**都没有地点** → 说清"墙上没有可挂的钉子"，别让用户以为是加载失败；
 *   · 国界/区划数据读不到 → 照常画钉子和照片（退化路径），页面上留一行说明。
 */
import { common } from '@kit.AbilityKit';
import { buffer } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { CHINA_REGION } from '../core/projection';
import { parseAreaData } from '../core/areaData';
import {
  HANG_GAP, HANG_PHOTO_H, HANG_PHOTO_W, TRACK_COLOR, TRACK_WIDTH, VIEW_PAD_RATIO,
  badgeRect, buildScene, dateLabel, fitBounds, fitViewToCanvas, geoAspect, hangBottom, hangOffsets, hangRects,
  mapFrame, outlinePath, parseOutline, trajectoryPath, viewZoomOf
} from '../core/render';
import type { CardRect, HangOffset, MapFrame, OutlineData, ScenePin, WallPhoto } from '../core/render';
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

/** 挂载区底部的留白（pt）：给"点开钉子"的提示条留位置。 */
const BOTTOM_RESERVE = 26;
/** 钉点标签的字号（fp）。见文件头"与预览刻意不同"的第 2 条。 */
const LABEL_FP = 8;
/** 钉子的触摸命中区边长（pt）—— 钉点本身只有 3~4pt，手指点不到。 */
const HIT_SIZE = 32;

/** 一张要画在墙上的卡片（画布坐标 pt，左上角）。坐标来自 core/render.hangRects。 */
interface WallCard { uri: string; x: number; y: number }
/** 一个钉子的锚点（钉点 + 名字标签 + 命中区）。 */
interface WallAnchor { idx: number; cx: number; cy: number; dotD: number; label: string; labelW: number; labelY: number; hitX: number; hitY: number }
/** 一个「+N」角标（挂不全时出现）。 */
interface WallBadge { idx: number; x: number; y: number; w: number; text: string }

@Entry
@Component
struct WallPage {
  // 场景（算一次，画布尺寸或数据变化时重算）
  @State cards: WallCard[] = [];
  @State anchors: WallAnchor[] = [];
  @State badges: WallBadge[] = [];
  @State chinaPath: string = '';
  @State linkPath: string = '';
  /** 旅行轨迹折线（按拍摄时间把钉子连起来）。见 core/render.trajectoryPath。 */
  @State trackPath: string = '';
  // 尺寸
  // `boxW×boxH` = **地图块** = 整个主体区。地图是这整块区域的底色，照片浮在它上面。
  @State boxW: number = 0;
  @State boxH: number = 0;
  // `mapW/mapH/mapX/mapY` = 块里那个**不变形**的中国绘制框（居中）。见 core/render.MapFrame。
  // 为什么不叫"地图块高"：块高就是 `boxH`；`mapH` 是"能画出的最大的、不变形的中国"有多高。
  @State mapW: number = 0;
  @State mapH: number = 0;
  @State mapX: number = 0;
  @State mapY: number = 0;
  // 状态
  @State phase: number = 0;          // 0 读取中 / 1 完成 / 2 出错
  @State walledTotal: number = 0;    // 已上墙张数（decisionStore 说的）
  @State locatedTotal: number = 0;   // 其中有地点、真的能上墙的张数
  @State shownTotal: number = 0;     // 实际挂出来的张数
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
  @State selShown: number = 0;       // 该钉子在墙上真正挂出来的张数
  @State selPhotos: WallPhoto[] = []; // 该钉子的**全部**照片（挂出来的 + 没挂出来的）
  // ── 诊断行（临时）────────────────────────────────────────────────────────────
  // 真机上抓不到 hilog，所以把同样的数字**画在屏幕上**：用户截一张图就等于把日志交回来了。
  // 这一行是为了拿 `boxW / boxH / mapH` 的真值（地图为什么小），定位完就该删掉。
  @State diag: string = '';

  private store: DecisionStore = new DecisionStore(getContext(this) as common.UIAbilityContext);
  private idx: LocationIndex = new LocationIndex(getContext(this) as common.UIAbilityContext);
  private photos: WallPhoto[] = [];      // 原始照片（重算场景用）
  private pins: ScenePin[] = [];         // 上一次算出的场景（点开详情时查它）
  private outlineData: OutlineData | undefined = undefined;

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
      + `，有地点的 ${this.locatedTotal} 张，实挂 ${this.shownTotal} 张`
      + `，钉子 ${this.pins.length} 个，画布 ${this.boxW}×${this.boxH}`);
  }

  /**
   * 重算场景。**唯一**的几何入口 —— 只在「数据到了」或「画布尺寸变了」时调用。
   * 画布尺寸没拿到（首帧之前）时什么都不做，等 `onAreaChange` 再来一次。
   *
   * ── 视野：由**照片数据**求出，不再是整个中国（本批的核心改动）────────────────
   * `fitBounds(this.photos, VIEW_PAD_RATIO)` 给出"能看到全部照片"的那一块经纬度范围，
   * 然后 `mapFrame` 把这块范围放进画布。设备真值（3 个城市、7 张有坐标）下这会把地图
   * 从"整个中国（经度 62°）"拉近到"经度 6.578°"—— 放大 9.4 倍，地图第一次真的铺满屏幕。
   *
   * `vb === undefined`（一张有坐标的都没有）→ 退回 `CHINA_REGION.bounds`，
   * 与改动前逐点一致（空墙 / 全无 GPS 的那两种退化路径不能变）。
   *
   * ⚠️ `bounds` **只算一次、只传一处**：国界（`outlinePath`）与照片（`buildScene`）
   * 都从这**同一个** `MapFrame` 上读 `frame.bounds` —— 各传一套参数就会出现
   * "照片用新视野、国界还是全国视野"，照片整体飘到地图轮廓外面，而且两边都不报错。
   */
  private rebuild(): void {
    if (this.boxW <= 0 || this.boxH <= 0) {
      hilog.info(DOMAIN, TAG, '%{public}s',
        `${DIAG} rebuild 跳过：画布还没量到（boxW=${this.boxW} boxH=${this.boxH}）`);
      return;
    }
    // 视野框：① 由照片坐标求出"装得下全部照片"的范围（没有有效坐标 → 全国视野）
    const vb: number[] | undefined = fitBounds(this.photos, VIEW_PAD_RATIO);
    const dataBounds: number[] = vb !== undefined ? vb : CHINA_REGION.bounds;
    // ② **默认铺满**：把数据框撑成**与画布同比例**，消掉 mapFrame 的信箱空白。
    //    为什么必须有第 ② 步（真机真值）：box 376×663.71 而数据框的墨卡托比只有 0.4661，
    //    相除之后 mapFrame 只能 contain → 图框 309.1×663.71@(33.45,0)，**左右各空 33.45pt**。
    //    撑开只作用在"没被限制"的那根轴上，所以框 ⊇ 数据（照片一张都不会跑出去），
    //    而且 pt/度 不变、框是**绕数据**长出去的 → 照片在屏幕上**一动都不动**（单测钉住 Δ=0）。
    const bounds: number[] = fitViewToCanvas(dataBounds, this.boxW, this.boxH);
    // 地图块 = 整个主体区（地图是这整块区域的底色）；框 = 块里那个不变形的视野（居中）。
    const frame: MapFrame = mapFrame(this.boxW, this.boxH, bounds);
    this.mapX = r2(frame.x);
    this.mapY = r2(frame.y);
    this.mapW = r2(frame.w);
    this.mapH = r2(frame.h);
    // 挂载区底：与 buildScene 内部**同一个** hangBottom（两边各算一遍就会漂移）
    const bottom: number = hangBottom(frame, { canvasH: this.boxH, footer: BOTTOM_RESERVE });

    // 国界：坐标已按 frame 平移过（与钉子同一个坐标系）；投影用的 bounds 就是 frame.bounds，
    // 与 buildScene 读的是同一处（outlinePath 已经没有 bounds 参数了）；视口剔除也在里面
    let chinaPath: string = '';
    if (this.outlineData !== undefined) {
      chinaPath = outlinePath(this.outlineData.rings, frame);
    }
    this.chinaPath = chinaPath;

    const pins: ScenePin[] = buildScene(this.photos, frame, 1, { canvasH: this.boxH, footer: BOTTOM_RESERVE });
    this.pins = pins;
    // 轨迹：按拍摄时间把钉子连成一条折线（时间未知的排最后）。少于 2 个钉子时是空串。
    this.trackPath = trajectoryPath(pins);

    // 把场景摊成三个扁平数组：ForEach 只能遍历数组，而 Stack 里每一项是一个组件。
    const cards: WallCard[] = [];
    const anchors: WallAnchor[] = [];
    const badges: WallBadge[] = [];
    const links: string[] = [];
    let shownTotal: number = 0;
    for (let i = 0; i < pins.length; i++) {
      const p: ScenePin = pins[i];
      const n: number = p.photos.length;
      const shown: number = p.expanded && p.shown > 0 && p.shown <= n ? p.shown : 0;
      if (shown > 0) {
        const offs: HangOffset[] = hangOffsets(shown, p.spread);
        for (let k = 0; k < shown; k++) {
          links.push(`M${r2(p.x)} ${r2(p.y)}L${r2(p.x + offs[k].dx)} ${r2(p.y + HANG_GAP + offs[k].dy)}`);
        }
        const rects: CardRect[] = hangRects(p.x, p.y, shown, p.spread, this.boxW, bottom);
        for (let k = 0; k < shown && k < rects.length; k++) {
          cards.push({ uri: p.photos[k].photoId, x: r2(rects[k].x), y: r2(rects[k].y) });
        }
        shownTotal += shown;
        if (n > shown) {
          // 「+N」的位置**必须**用 core/render 的 badgeRect：那个矩形参与了 planPin 的避让，
          // 位置自己再算一遍就会与"判据以为它在哪儿"漂移（旧代码写死 x-8/w16，与 BADGE_W=10 不符）。
          const b: CardRect = badgeRect(p.x, p.y, shown, p.spread);
          badges.push({
            idx: i, x: r2(b.x), y: r2(b.y), w: r2(b.w), text: `+${n - shown}`
          });
        }
      }
      const dotD: number = shown > 0 ? 4.4 : 6.8;
      const label: string = n > 1 ? `${p.name} ·${n}` : p.name;
      const labelW: number = Math.round(label.length * LABEL_FP + 6);
      anchors.push({
        idx: i, cx: r2(p.x), cy: r2(p.y), dotD: dotD, label: label, labelW: labelW,
        labelY: r2(p.y - dotD / 2 - 3.4 - LABEL_FP),
        hitX: r2(p.x - HIT_SIZE / 2), hitY: r2(p.y - HIT_SIZE / 2)
      });
    }
    this.cards = cards;
    this.anchors = anchors;
    this.badges = badges;
    this.linkPath = links.join('');
    let located: number = 0;
    for (let i = 0; i < pins.length; i++) { located += pins[i].photos.length; }
    this.locatedTotal = located;
    this.shownTotal = shownTotal;
    // ── 诊断（临时）：真机上抓不到 hilog，所以把同样的数字也画在屏幕上 ──────────
    // 要的就是这一行的真值：`boxW / boxH` 是 onAreaChange 给的**地图块**（整个主体区），
    // `图框 W×H@(x,y)` 是块里那个不变形的绘制框，`pathLen` 是国界 path 的字符数
    //（=0 就说明国界根本没画出来，那是另一类缺陷），`track` 是轨迹折线的字符数。
    //
    // 本批新增三样，都是为了**真机一眼核对**：
    //   · `视野 数据[…]→铺满[…]`：**撑开前后两个框**。左边是 `fitBounds` 的产物，
    //     右边是 `fitViewToCanvas` 撑到与画布同比例之后的产物。两者若相同 = 比例本来就匹配
    //     （或铺满没生效）；右边若比左边宽 = 本批第 ② 件事生效了。
    //   · `放大 A×→B×`：撑开前 / 后的放大倍数（`viewZoomOf`，经度跨度口径）。
    //     **B < A 是正常的、也是预期的**：撑开让视野变大 → 相对全国的倍数变小。
    //     照片大小没变（pt/度恒定），变的是原来空着的那两条带现在归地图自己。
    //   · `图框` 里的 `@(x,y)`：铺满生效后**必然是 (0,0)**，宽度必然等于 `boxW`
    //     —— 这就是"默认铺满"最直接的一个数字。
    const diagBounds: string = `数据[${r2(dataBounds[0])},${r2(dataBounds[1])},${r2(dataBounds[2])},${r2(dataBounds[3])}]`
      + `→铺满[${r2(bounds[0])},${r2(bounds[1])},${r2(bounds[2])},${r2(bounds[3])}]`;
    this.diag = `box ${r2(this.boxW)}×${r2(this.boxH)} ｜ 图框 ${this.mapW}×${this.mapH}@(${this.mapX},${this.mapY})`
      + ` ｜ 视野 ${diagBounds}${vb !== undefined ? '(数据)' : '(全国)'}`
      + ` ｜ 放大 ${r2(viewZoomOf(dataBounds))}×→${r2(viewZoomOf(bounds))}×`
      + ` ｜ pins ${pins.length} ｜ cards ${cards.length} ｜ pathLen ${chinaPath.length} ｜ track ${this.trackPath.length}`
      + ` ｜ 上墙 ${this.walledTotal} 命中 ${located} 实挂 ${shownTotal}`;
    hilog.info(DOMAIN, TAG, '%{public}s',
      `${DIAG} rebuild：boxW=${this.boxW} boxH=${this.boxH}`
      + ` blockH=${frame.blockH} mapW=${frame.w} mapH=${frame.h} mapX=${frame.x} mapY=${frame.y}`
      + ` dataBounds=[${r2(dataBounds[0])},${r2(dataBounds[1])},${r2(dataBounds[2])},${r2(dataBounds[3])}]`
      + ` bounds=[${r2(bounds[0])},${r2(bounds[1])},${r2(bounds[2])},${r2(bounds[3])}]`
      + ` boundsFromData=${vb !== undefined}`
      + ` viewZoomData=${r2(viewZoomOf(dataBounds))} viewZoomFilled=${r2(viewZoomOf(bounds))}`
      + ` geoAspect=${geoAspect(bounds).toFixed(4)} canvasAspect=${(this.boxW / this.boxH).toFixed(4)}`
      + ` bottom=${bottom} pins=${pins.length} cards=${cards.length}`
      + ` chinaPath.length=${chinaPath.length} trackPath.length=${this.trackPath.length}`
      + ` linkPath.length=${this.linkPath.length} walled=${this.walledTotal} located=${located} shown=${shownTotal}`);
    // ── 这里**不许**再写 `this.selIndex = -1` ────────────────────────────────
    // 这行曾经在：`rebuild()` 只在"数据到了"或"画布尺寸变了"时跑，而 `onAreaChange` 每次
    // 画布尺寸变化都会调它（页面刚进来时布局还没稳定 → 会连着跑好几次）。
    // 于是「点钉子 → selIndex=i → 紧接着一次 rebuild() 清成 -1」= 详情面板出现又消失
    // = 用户看到的"闪一下"。清选中项是**数据换了**才该做的事，已经挪到 `load()` 开头。
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
    this.selShown = pin.shown;
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
        Text(`地图墙 ｜ 挂出 ${this.shownTotal} / 上墙 ${this.walledTotal} 张`)
          .fontSize(15).fontWeight(FontWeight.Medium).layoutWeight(1)
      }
      .width('100%').padding({ left: 12, right: 12, top: 10, bottom: 8 })

      // ── 主体：整块都是地图（地图块 = 这个 Stack 的全部）─────────────────
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

        // 旅行轨迹：按拍摄时间把钉子连成一条折线。画在国界**之上**、照片**之下** ——
        // 它是"我走过哪里"的背景叙事，压住照片就成了噪声。
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

        // 钉子的线：同样一条 path 装下全部（M…L…M…L…）
        if (this.linkPath.length > 0) {
          Shape() {
            Path().width(this.boxW).height(this.boxH).commands(this.linkPath)
          }
          .width(this.boxW).height(this.boxH)
          .viewPort({ x: 0, y: 0, width: this.boxW, height: this.boxH })
          .fill(Color.Transparent).stroke('#C3B49B').strokeWidth(0.6)
        }

        // 照片卡片：真的照片，不是占位卡片
        ForEach(this.cards, (c: WallCard) => {
          Image(c.uri)
            .width(HANG_PHOTO_W).height(HANG_PHOTO_H)
            .objectFit(ImageFit.Cover).borderRadius(2)
            .border({ width: 0.5, color: '#8FA8C0' })
            .backgroundColor('#DCE8F5')
            .position({ x: c.x, y: c.y })
        }, (c: WallCard) => `${c.uri}@${c.x},${c.y}`)

        // 钉点 + 地名标签 + 命中区（命中区是透明的，钉点太小手指点不到）
        ForEach(this.anchors, (a: WallAnchor) => {
          Column()
            .width(HIT_SIZE).height(HIT_SIZE)
            .backgroundColor(Color.Transparent)
            .position({ x: a.hitX, y: a.hitY })
            .onClick(() => { this.open(a.idx); })
          Circle()
            .width(a.dotD).height(a.dotD).fill('#C0392B')
            .position({ x: a.cx - a.dotD / 2, y: a.cy - a.dotD / 2 })
          Text(a.label)
            .fontSize(LABEL_FP).fontColor('#3F4A3C')
            .width(a.labelW).textAlign(TextAlign.Center)
            .position({ x: a.cx - a.labelW / 2, y: a.labelY })
        }, (a: WallAnchor) => `${a.idx}@${a.cx},${a.cy}`)

        // 「+N」：挂不全时出现，点它等于点钉子。
        // 位置来自 core/render.badgeRect（它参与 planPin 的避让，不能自己再算一遍）。
        ForEach(this.badges, (b: WallBadge) => {
          Text(b.text)
            .fontSize(8).fontColor('#8A8A8A')
            .width(b.w + 8).textAlign(TextAlign.Center)
            .position({ x: b.x - 4, y: b.y })
            .onClick(() => { this.open(b.idx); })
        }, (b: WallBadge) => `${b.idx}@${b.x},${b.y}`)

        // ── 空态 / 读取中 / 退化说明 ──────────────────────────────────────
        if (this.phase === 0) {
          Text('正在读取地点…').fontSize(13).fontColor('#999')
            .width('100%').textAlign(TextAlign.Center).position({ x: 0, y: this.mapY + 60 })
        } else if (this.phase === 1 && this.cards.length === 0) {
          Column() {
            Text(this.walledTotal === 0
              ? '墙上还没有照片。\n在刷卡页右滑收藏，再点「上墙」—— 上墙的照片会挂到这张地图上。'
              : `上墙的 ${this.walledTotal} 张都没有地点，墙上没有可挂的钉子。\n上墙时如果照片没有 GPS，可以手选省 / 市 / 县，那个地点就会成为墙上的一个钉子。`)
              .fontSize(13).fontColor('#999').textAlign(TextAlign.Center)
          }
          .width('100%').padding({ left: 28, right: 28 }).position({ x: 0, y: this.mapY + 48 })
        }
      }
      .width('100%').layoutWeight(1).clip(true)
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
      Text('点钉子或「+N」看它挂着的全部照片').fontSize(10).fontColor('#AAA')
        .width('100%').padding({ left: 12, right: 12, bottom: 8 })

      // ── 点开钉子的详情：全部照片（含没挂出来的那几张）──────────────────
      // 判据只看 @State（`selIndex` / `selPhotos`），**不看 `this.pins`** —— 后者不是被观察的。
      if (this.selIndex >= 0 && this.selPhotos.length > 0) {
        this.detail()
      }
    }
    .width('100%').height('100%').backgroundColor('#FAFAFA')
  }

  /**
   * 一个钉子的详情：地名、张数、**全部**照片（挂出来的 + 没挂出来的）。
   *
   * 这是"重叠兜底"的收口：墙上每个钉子最多挂 `MAX_HANG` 张（见 core/render 的几何说明），
   * 剩下的必须在某处看得到 —— 就是这里。日期也在这里给（卡片上叠不下可读的字号）。
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

      if (this.selShown > 0 && this.selShown < this.selPhotos.length) {
        Text(`墙上挂了 ${this.selShown} 张（一屏最多 ${MAX_HANG} 张、此处受画布空间限制），下面是可以看的全部`)
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
