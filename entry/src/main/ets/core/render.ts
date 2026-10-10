/**
 * 地图墙的场景计算：把「已上墙的照片」算成「钉子 + 钉子旁的照片标记」。
 *
 * ── 这个模块回答什么 ────────────────────────────────────────────────────────
 *   输入：一份带坐标的照片列表（来自 data/locationIndex 的 LocationEntry）；
 *   输出：**屏幕坐标下的钉子和标记**（ScenePin[]），以及可直接绘制的 SVG。
 *   它不认识 ArkUI、不读文件、不 import 任何 @kit.*：Node 单测与
 *   tools/render-preview.ts 用的是**同一个函数**，设备侧 WallPage 也是。
 *   —— 这是"地图墙长什么样"能在电脑上先看见的前提。
 *
 * ── 形态（task-18 的用户裁决："地图为主：照片改小、点开才看大图"）────────────
 *   地图是**主角**，照片是**钉子上的一簇小点**，大图在「点开钉子」的详情面板里。
 *   所以本模块**不再有**"照片卡片挂多长、挂几张、弧多宽"这一整套几何
 *   （`hangOffsets` / `arcSpread` / `hangRects` / `planPin` / `clampRect` / `badgeRect`
 *   已随本次改造删除 —— 它们唯一的存在理由是"把照片画在钉子上"，那个形态没有了）。
 *   留下的只有三件事：**钉子在哪儿**（`buildScene`）、**标记长什么样**（`pinMarkers`）、
 *   **地图画多大**（`mapFrame` / `fitViewToCanvas`）。
 *
 * ── 复用了什么（刻意不重写） ────────────────────────────────────────────────
 *   · geo.hasPlace             —— 「这张照片有没有地点」的**唯一定义**（手动 > EXIF；
 *                                 (0,0) 不算，除非 manual === true）。本模块不另立一套判断。
 *   · placePick.formatPlace    —— 地点显示名的**唯一产出者**（「河北·石家庄·正定」）。
 *   · areaData.nearestCounty   —— EXIF 条目没有 place 时反查最近的县，**退化路径**。
 *   · geo.medianPoint          —— 一个钉子下多张照片取中位数定位（对离群点比平均值稳）。
 *   · projection.projectMercator + **frame.bounds** —— 经纬度 → 画布坐标。
 *     视野框不再恒等于 CHINA_REGION.bounds：`fitBounds` 由照片数据求出它（见该函数），
 *     国界与照片都只读 `frame.bounds`（`frameBounds`），所以两者不可能各画各的。
 *   · placement.clusterByScreen / computeLayout / MIN_PIN_DIST_PT / MAX_HANG
 *                              —— §6.2 的「自适应聚散」阈值**只在 placement.ts 里定义**，
 *                                 本模块只负责把照片喂进去、把结果翻译成绘图语义。
 *                                 `computeLayout` 在本形态下只决定**标记画不画**
 *                                 （钉子多 / 缩得太小时收成裸点），不再决定挂几张 ——
 *                                 见 `ScenePin.markers` 的注释。
 *
 * ── 三处需要知道的取舍（都写在报告里） ──────────────────────────────────────
 *   1. 钉子坐标 = 该地点下所有照片坐标的**中位数**，不是县中心点。
 *      理由：钉子的语义是「这些照片是在哪儿拍的」。用县中心会把照片从它实际的
 *      位置上挪走（一个县可能跨几十公里），在"看照片"的场景里那是错的。
 *   2. `takenAt === 0`（时间未知）的照片**照常上墙**，只是排在同一钉子的**最后**。
 *      0 不是时间；排在最前会伪装成"最早的照片"，是合法但错误的呈现。
 *   3. 境外照片（nearestCounty 判不出中国境内县，即 >800km）**不删除**，会得到一个
 *      坐标标签的钉子，投影后可能落在画布之外。设计 §6.5 的"世界地图"是 M2 的事，
 *      本批不做，但**不假装这些照片不存在**。
 */

import { nearestCounty } from './areaData.ts';
import type { CountyHit } from './areaData.ts';
import { medianPoint } from './geo.ts';
import type { GeoPoint } from './geo.ts';
import { formatPlace, hasPlace } from './placePick.ts';
import { MIN_PIN_DIST_PT, clusterByScreen, computeLayout } from './placement.ts';
import type { PlacedPin } from './placement.ts';
import { CHINA_REGION, projectMercator } from './projection.ts';

/**
 * CHINA_REGION 的 bounds。**不在这里另写一份数字** —— 那迟早会与 projection.ts 漂移。
 * 取值仍是 `[73, 18, 135, 54]`（西沙以西到黑龙江以东、南沙以北到漠河）。
 */
const CHINA_BOUNDS: number[] = CHINA_REGION.bounds;

/**
 * 把一份 bounds 归一成**可用的** `[minLon, minLat, maxLon, maxLat]`。
 *
 * 非法（不是 4 个数 / 含 NaN·Infinity / 跨度不为正）一律退回 `CHINA_REGION.bounds`。
 * 为什么必须归一而不是"就地拿去用"：`projectMercator` 里 `(maxLon − minLon)` 是**除数**，
 * 零跨度会产出 `Infinity / NaN` 坐标 —— 而 NaN 坐标会让整条 path **静默消失**
 * （SVG 与 ArkUI 都不报错），是本模块最怕的一类失败（同 `parseOutline` 的理由）。
 * 归一之后，"地图框比中国轮廓还大 / 比一个点还小"这类怪结果也不可能出现。
 */
export function normalizeBounds(bounds: number[] | undefined): number[] {
  if (bounds === undefined || bounds === null || !Array.isArray(bounds) || bounds.length !== 4) {
    return CHINA_BOUNDS;
  }
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(bounds[i])) { return CHINA_BOUNDS; }
  }
  if (!(bounds[2] > bounds[0]) || !(bounds[3] > bounds[1])) { return CHINA_BOUNDS; }
  return bounds;
}

// ── 画布比例：为什么地图不能直接铺满手机屏幕 ────────────────────────────────

const DEG = Math.PI / 180;

/**
 * Mercator 的 y（与 `projection.ts` 里的**私有** `mercY` 同一公式）。
 *
 * 为什么要在这里再写一遍：`projectMercator` 把 bounds **线性拉伸**到给定的 `w × h`，
 * 它自己不关心比例 —— 所以"按什么比例开画布"是**调用方**的责任。而正确比例需要
 * mercY 的跨度，`projection.ts` 没有导出 `mercY`（本批不允许改动既有 core 模块）。
 * 抄公式的漂移风险用两条单测抵住：一条用 `projectMercator` 反推同一个值来交叉验证
 * （`geoAspect` 的单测），一条断言 `mapBoxHeight` 出来的画布上 China 的宽高比与
 * bounds 的墨卡托宽高比一致。**上游若改了 mercY，这两条会红。**
 */
function mercYOf(lat: number): number {
  const clamped: number = Math.max(-85, Math.min(85, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
}

/**
 * 一块 bounds 在墨卡托下的**宽度 / 高度**比。
 *
 * 实测意义（这就是为什么需要它）：把 `[73,18,135,54]` 直接拉满一块 `360 × 720` 的画布，
 * 中国会变成一根竖条 —— 经度方向 62° 压进 360pt（5.8pt/度），纬度方向 36° 摊到 720pt，
 * 形状彻底失真（喀什到三亚在真实地图上是 4:3 的横图，会被画成 1:2 的竖条）。
 * 按本比例开画布（360 宽 → 267.7 高）才是中国本来的样子。
 */
export function geoAspect(bounds: number[]): number {
  const b: number[] = Array.isArray(bounds) && bounds.length === 4 ? bounds : CHINA_BOUNDS;
  const xSpan: number = (b[2] - b[0]) * DEG;
  const ySpan: number = mercYOf(b[3]) - mercYOf(b[1]);
  if (!(xSpan > 0) || !(ySpan > 0)) { return 1; }
  return xSpan / ySpan;
}

/** 给定画布宽度，返回**不变形**的地图高度（pt）。 */
export function mapBoxHeight(width: number, bounds: number[]): number {
  const a: number = geoAspect(bounds);
  if (!(width > 0) || !(a > 0)) { return 0; }
  return width / a;
}

// ── 地图块 / 地图框：地图"铺满主体区"但不许变形 ─────────────────────────────

/**
 * 地图块的尺寸与它里面那个**不变形的绘制框**。
 *
 * ── 两个概念必须分开（这是"地图只占上面一条"的成因）────────────────────────
 *   · **地图块**（`blockW × blockH`）= 页面上留给地图的**那块区域**。它就是整个主体区，
 *     高度 = `onAreaChange` 给的可用高度 —— 地图是这块舞台的底色，照片浮在它上面。
 *   · **绘制框**（`x, y, w, h`）= 中国轮廓与钉子投影用的那个矩形。它的宽高比**必须**
 *     等于 bounds 的墨卡托宽高比，否则中国会被拉变形。
 *
 * 老实现把两者当成一回事：`mapH = mapBoxHeight(画布宽)` 只有 267.7pt（720 高的 37%），
 * 于是地图**只是屏幕上方的一条**，下面一大片交给照片。修法是把"块"撑满可用高度、
 * 把"框"居中放在块里。
 *
 * ── 框的大小：取能放下的最大一块（contain），**永远不变形** ────────────────────
 *   1. 先按"填满高度"算宽度 `w = blockH × aspect`；
 *   2. 算出来的宽度超出地图块宽 → 改成"填满宽度" `w = blockW, h = blockW / aspect`。
 * 两条都**只改尺寸、不改比例**。真正的取舍在下面这段：
 *
 *   **为什么在手机上第 2 条总是生效，以及为什么这才是对的**：
 *   中国 bounds 的墨卡托宽高比是 1.345（横着的 4:3），而手机主体区是 360×710（竖的）。
 *   要"填满高度"就得把宽度开到 `710 × 1.345 = 955pt` —— 是画布的 2.65 倍，
 *   于是只能看到经度 104° ± 12° 那一条，**北京（116.4°E）、上海（121.5°E）、广州（113.3°E）
 *   全在画面外**，而那正是用户照片所在的地方。所以"填满高度"在竖屏上不是"地图更大"，
 *   而是"把要去的地方裁掉"。第 2 条给出的是**在不变形的前提下能画出的最大中国**
 *   （宽 360 × 高 267.7），并且把它**居中**（`x = y = 0` 只在比例刚好匹配时成立）。
 *
 * 换句话说：**地图块填满可用高度（地图是整块主体区的底色），绘制框取不变形的最大一块并居中。**
 * 两者合起来才是"地图铺满主体区"。
 *
 * ── task-18：为什么"框填不满块"这件事**不是**本批要修的东西（实测数字）──────────
 *   新形态把照片变成钉子上的一簇小点（`pinMarkers`）之后，"地图一条、照片飘在空白里"
 *   那个观感已经没有了：整块主体区都是地图（底色 + 国界 + 省界 + 轨迹 + 钉子），
 *   照片不再占据任何纵向空间。于是"框 ⊊ 块"剩下的只是框外那两条带**没有画轮廓数据**
 *   而已（`containInChina` 的取舍：视野 ⊆ 中国，见 `fitViewToCanvas`）。
 *   真机 376×663.71pt 上的实测（`mapFillRatio` = 框面积 / 可用区面积）：
 *     · 近邻城市数据（有界视野）→ 框 == 块，**100%**；
 *     · 广域 fixture（经度占满 62°）→ **43.5%**（框 376×288.3 居中）。
 *   第二档的 43.5% 是**故意保留**的，不是漏修：
 *     把它"填满"的唯一办法是让框的纬度撑到画布比例 —— 实测那会得到
 *     `[73.5, -12.54, 134.5, 68.44]`（**南半球**），中国陆地只占画面高度的 42.8%，
 *     也就是**比现在更小**。所以"框填满块"与"中国尽可能大"在竖屏上是互斥的，
 *     本模块选后者（用户要的是"看见完整的中国且尽量大"）。数字与推导见 task-18 报告。
 */
export interface MapFrame {
  /** 地图块宽（pt）= 画布宽。 */
  blockW: number;
  /** 地图块高（pt）= 可用高度（地图是这整块区域的底色）。 */
  blockH: number;
  /** 不变形绘制框在地图块内的左上角（居中放置）。 */
  x: number;
  y: number;
  /** 不变形绘制框的尺寸（`w / h === geoAspect(bounds)`）。 */
  w: number;
  h: number;
  /**
   * 这个框的经纬度范围 `[minLon, minLat, maxLon, maxLat]`。
   *
   * ── 为什么它必须**长在框上**，而不是各自当参数传（这是本批最容易错的地方）────────
   * 国界（`outlinePath`）与照片（`buildScene`）都要把经纬度投到画布上，两者**必须**用
   * 同一份 bounds —— 否则照片用新视野、国界还是全国视野，照片会飘到地图外面，
   * 而且两个函数都不会报错。把 bounds 放进 `MapFrame` 之后，"各传一套参数"这件事
   * 在**类型上就写不出来**了：`outlinePath(rings, frame)` 不收 bounds 参数（见它的签名）。
   *
   * 缺省 = `CHINA_REGION.bounds`（全国视野）—— 手写的 `MapFrame` 字面量（测试里的
   * `FULL_FRAME`）因此仍然可用，语义是"这个框就是整个中国"。
   * 取值一律经 `normalizeBounds` 校验，非法值退回全国视野。
   */
  bounds?: number[];
}

/**
 * 一个框实际使用的 bounds。**读 bounds 的唯一入口**：
 *   · 框上没写 bounds（手写字面量）→ 全国视野；
 *   · 写了但非法（长度不对 / NaN / 零跨度）→ 全国视野（见 `normalizeBounds`）。
 *
 * `buildScene` 与 `outlinePath` 都调它，所以"国界与照片用同一个 bounds"不是靠约定，
 * 而是靠"两边读的是同一个字段的同一个函数"。单测里有一条把这条钉死
 * （同一个经纬度在国界 path 与照片钉子上必须落在同一个画布点）。
 */
export function frameBounds(frame: MapFrame): number[] {
  if (frame === undefined || frame === null) { return CHINA_BOUNDS; }
  return normalizeBounds(frame.bounds);
}

/**
 * 按"地图块"算出里面那个不变形的绘制框（居中）。见 `MapFrame` 的说明。
 *
 * `bounds` 是**这个框的经纬度范围**，会被归一化后**存进返回的框**（`MapFrame.bounds`）——
 * 国界与照片之后都从框上读它，不再各传一份（见 `frameBounds`）。
 * 调用方给的 bounds 非法（长度不对 / NaN / 零跨度）时退回全国视野。
 *
 * `blockW/blockH` 非法（非有限数 / ≤ 0）时返回一个全 0 的框 —— 调用方据此跳过绘制，
 * 而不是拿 NaN 去投影（NaN 坐标会让整条 path 静默消失，是最难查的一类失败）。
 */
export function mapFrame(blockW: number, blockH: number, bounds: number[]): MapFrame {
  const b: number[] = normalizeBounds(bounds);
  const bw: number = Number.isFinite(blockW) && blockW > 0 ? blockW : 0;
  const bh: number = Number.isFinite(blockH) && blockH > 0 ? blockH : 0;
  if (!(bw > 0) || !(bh > 0)) {
    return { blockW: bw, blockH: bh, x: 0, y: 0, w: 0, h: 0, bounds: b };
  }
  const a: number = geoAspect(b);
  // 1) 先按"填满高度"
  let h: number = bh;
  let w: number = bh * a;
  // 2) 宽度放不下 → 改成"填满宽度"（同样不变形）
  if (w > bw) {
    w = bw;
    h = bw / a;
  }
  // 居中：比例刚好匹配时 x/y 是 0；不匹配时两侧/上下各留一半
  return { blockW: bw, blockH: bh, x: (bw - w) / 2, y: (bh - h) / 2, w: w, h: h, bounds: b };
}

/**
 * **框底在画布里的位置**（pt）：`画布高 − 页脚`，但**不得高于绘制框底**。
 *
 * 本形态下已经**没有"挂载区"**（照片不再挂在钉子下面占纵向空间），这个函数保留下来
 * 只服务一件事：预览与单测要能算出"地图框之外还剩多少"这一个数字（诊断行/图例要报它）。
 * 画布高缺省 = 地图块高。
 */
export function frameBottomAt(frame: MapFrame, canvasH: number, footer: number): number {
  const fb: number = frame.y + frame.h;
  let h: number = frame.blockH > fb ? frame.blockH : fb;
  if (Number.isFinite(canvasH) && canvasH > h) { h = canvasH; }
  const f: number = Number.isFinite(footer) && footer > 0 ? footer : 0;
  const limit: number = h - f;
  return limit > fb ? limit : fb;
}

/**
 * **地图填满度**：绘制框面积 ÷ 地图块面积（0~1）。1 = 框 == 块 = 一点信箱空白都没有。
 *
 * ── 为什么要有这个函数（它是验收里那个数字的唯一来源）────────────────────────────
 *   "地图铺满主体区"这句话如果不落成一个数，就永远只能靠肉眼吵。本函数把它定义成
 *   **一个比值**，于是设备侧诊断行、预览图例与单测报的是同一个数 —— 谁都不必"再算一遍"。
 *
 * ── 它**不**回答"中国在画面里占多大"（那是另一个数，见报告）──────────────────────
 *   两者会不一样，而且**故意不一样**：竖屏上"框 == 块"只有在放弃"视野 ⊆ 中国"时才能做到，
 *   而那会把视野拉到南半球、让中国**更小**（实测数字见 `MapFrame` 的注释）。
 *   本模块选的是"中国尽可能大 + 视野恒 ⊆ 中国"，所以有界视野下框就是块（1.0），
 *   广域视野下框填不满块（那两条带是底色，不是异色空缺）。
 *
 * `blockW/blockH` 非法（非有限数 / ≤ 0）时返回 0（"画布多大都不知道"时没有比值可言）。
 */
export function mapFillRatio(frame: MapFrame): number {
  if (frame === undefined || frame === null) { return 0; }
  const bw: number = frame.blockW;
  const bh: number = frame.blockH;
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || !(bw > 0) || !(bh > 0)) { return 0; }
  const a: number = frame.w * frame.h;
  if (!Number.isFinite(a) || !(a > 0)) { return 0; }
  return a / (bw * bh);
}

// ── 数据形状 ────────────────────────────────────────────────────────────────

/**
 * 墙上一张照片的全部绘制信息。
 *
 * 结构上**兼容** `data/locationIndex.ets` 的 `LocationEntry`（可直接传数组进来），
 * 但刻意不 import 它 —— 那会牵进 `@kit.*`，Node 单测就跑不起来了
 * （与 `core/placePick.ts` 里 PlaceFields 的理由完全相同）。
 */
export interface WallPhoto {
  photoId: string;
  lat: number;
  /** 与 lon 同时为 0 = 没有 GPS（见 areaData.ts 文件头第 2 条：0 不是几内亚湾）。 */
  lon: number;
  /** epoch ms；**0 = 时间未知**（截图/无 EXIF 是常态，不是错误）。 */
  takenAt: number;
  /** 地点显示名（手动选择时由 formatPlace 写入）。有就直接用，不做反查。 */
  place?: string;
  /** true = 用户手选的地点（GCJ-02，且"用户说过有地点"这件事本身就算数）。 */
  manual?: boolean;
}

/**
 * 钉子旁的**一个照片标记**：相对钉子的偏移（pt）。
 *
 * 这就是本形态下"照片"在墙上的全部绘制信息 —— 一个小圆点，**不带尺寸**：
 * 圆的半径是一个全局常量（`MARKER_R`），不是每张照片各带一个。理由：标记只是
 * "这里有照片"的计数；让它带尺寸就会重新长出"卡片"那套几何（互相避让、钳制、
 * 「+N」放哪儿……），而那正是本批删掉的东西。
 */
export interface PinMarker {
  /** 相对钉子的偏移（pt）。簇内错开一点点，避免完全重叠。 */
  dx: number;
  dy: number;
}

/**
 * 一个钉子 + 它下面的照片（`photos` 是**全部**照片 —— 详情面板要用它）。
 *
 * ── `photos` / `markers` / `expanded` 的分工（本批改造的核心）────────────────
 *   · `photos`  —— 数据：这个钉子下**全部**照片（详情面板逐张显示的地方）。
 *   · `markers` —— 画面：钉子旁画几个小圆点（≤ `MAX_MARKERS`，见 `pinMarkers`）。
 *                  少于 `photos.length` 时，差额由「+N」角标如实报出。
 *   · `expanded` —— `placement.computeLayout` 按（钉数、每钉张数、zoom）给的**意愿**（§6.2）。
 *                  本形态下它只决定**画不画标记**：false = 光点（钉子多 / 缩得太小时，
 *                  一屏几十个钉子再各带 5 个点就是一片噪点）。
 *                  它**不再**决定"挂几张"—— 已经没有"挂"这件事了。
 */
export interface ScenePin {
  /** 分组键：有地名时等于显示名，境外坐标点等于坐标标签。同一个场景内唯一。 */
  pinId: string;
  name: string;
  /** 画布坐标（pt），已投影、已做屏幕聚簇。 */
  x: number;
  y: number;
  /** 该钉子下的全部照片，已排序（时间正序，时间未知的排最后）。 */
  photos: WallPhoto[];
  /** 按 placement.computeLayout 的规则算出的展开态（§6.2）：false = 只画光点。 */
  expanded: boolean;
  /** 钉子旁的标记位置（相对钉子的偏移）。`expanded === false` 时为空。 */
  markers: PinMarker[];
}

/**
 * 中国轮廓数据（`resources/rawfile/china_outline.json`）的形状。
 * `rings` 是**扁平**的经纬度序列 `[lon,lat,lon,lat,…]`：比 `[[lon,lat],…]` 省一半体积，
 * 而 P 级简化后点数上万，体积是要在意的（rawfile 会进 HAP）。
 */
export interface OutlineData {
  v: string;
  src: string;
  license: string;
  /**
   * 数据文件自己的 `[minLon, minLat, maxLon, maxLat]` = **这份轮廓覆盖哪儿**。
   *
   * ⚠️ **它不参与投影**（本批改的）。投影一律用 `frame.bounds`（见 `outlinePath`）：
   * 视野改成"按数据求"之后，若国界用文件里的全国 bounds、照片用新视野，两者就会分叉，
   * 症状是照片飘到轮廓之外。这个字段现在的用途只剩两个：数据本身的元信息、
   * 以及 `build-outline.ts` / 单测对文件的自检（"这份数据是不是全国的"）。
   */
  bounds: number[];
  rings: number[][];
}

// ── 视野框：由照片数据求出"能看到它们全部"的那一块 ───────────────────────────
//
// 为什么需要它（用户的真机反馈是这一段的存在理由）：
//   老实现把 `CHINA_REGION.bounds`（经度 62°、纬度 36°）当成**唯一的**视野，
//   于是地图永远是"整个中国"，而用户的照片只落在上海/北京/天津这三座城里 ——
//   屏幕上就是一小撮点，"地图铺满屏幕"这件事根本没发生。
//   同类应用（旅迹 PhotoTrail / 山河旅记 / Polarsteps）之所以"地图铺满"，
//   是因为它们**缩放到用户的足迹范围**。本函数就是那一件事。

/**
 * 一次"按数据求视野"的**最小跨度**（度，两个轴各自适用）。
 *
 * 为什么必须有它：所有照片挤在同一个点时数据跨度是 0，而 `projectMercator` 的除数是
 * `(maxLon − minLon)` —— 零跨度 → `Infinity / NaN` 坐标 → 整条 path 静默消失。
 *
 * 为什么取 0.6°：
 *   · **0.6° 纬度 = 66.7 km；0.6° 经度在 36°N ≈ 54 km** —— 一个地级市加近郊的尺度。
 *     只有一张照片的墙于是回答"这张是在哪座城拍的"，而不是"哪条街"。
 *   · **我们只有国界数据，没有省界/路网**：再放大也不会有新的线出现，只会剩一个点
 *     和一大片空底 —— 那既不好看，也不比"一座城"多告诉用户任何东西。
 *   · **容得下 EXIF 的误差**：手机 GPS 在城市峡谷/室内偏几百米是常态。0.6° 视野下
 *     300 m 只占画布宽的 0.4%（360pt 上 1.6pt），钉子不会明显漂；再小一档（例如 0.05°）
 *     就会把"定位误差"画成"换了个地方"。
 *   · 与真实数据衔接自然：上海—北京—天津这种真实跨度是 5.06°×8.68°，远大于它，
 *     只有数据真的只有一座城时才会吃到这个下限。
 */
export const MIN_VIEW_SPAN_DEG = 0.6;

/**
 * 内边距比例：视野框在数据盒四周各留「跨度 × 0.15」的余量。
 *
 * **设备侧（WallPage）与预览（tools/render-preview.ts）共用这一个常量** ——
 * 两边各写一个数就会变成"电脑上看到的和真机上看到的不是同一张图"。
 * 0.15 的效果：近邻城市那一档（经度跨度 5.06°）四周各留 0.76°，钉子的名字标签
 * （8fp，居中于钉子）与卡片不会贴到画布边上；国家尺度上各留 4.6°，也不会"看不出是地图"。
 */
export const VIEW_PAD_RATIO = 0.15;

/** 一根轴上的视野区间（内部用）。 */
interface ViewSpan { lo: number; hi: number }

/**
 * 一根轴：数据盒 `[lo, hi]` → 视野盒。三步，**顺序不能换**：
 *   ① **撑到最小跨度**（绕盒中心，`MIN_VIEW_SPAN_DEG`）—— 消掉零跨度；
 *   ② **加内边距**（按**当前**跨度的比例，两侧各 `padRatio × 跨度`）；
 *   ③ **保持跨度地平移到可视范围** `[cLo, cHi]` 内。
 *
 * ── 第 ③ 步为什么是"平移"而不是"把两端各夹一下"（这是一个真会被踩到的坑）────────
 * 两端分别夹会把**跨度压小**，压到 0 就回到了第 ① 步要消灭的那个除零。极端但真实的例子：
 * 唯一一张照片在东京（139.65°E，中国 bounds 的 maxLon = 135）—— 夹两端得到 `[135, 135]`
 * 这个**零跨度**框，接着 `projectMercator` 里 `(135 − 135)` 当除数 → 整块画布 NaN →
 * 地图和照片一起消失（静默）。平移则给出 `[134.4, 135]`：跨度还在，照片点落在框的右外侧
 * （画布外，但坐标有限），与 render.ts 文件头第 3 条"境外照片不删、只是可能落在画布外"
 * 的既有约定一致 —— 这也是预览里那行"地图框外 N 张"能报出来的前提。
 *
 * 跨度比可视范围还大时（只有 `padRatio` 给得极大才会发生）先把跨度收到可视范围再平移，
 * 结果仍然是正跨度（这就是"广域数据退回接近全国视野"的那条路径）。
 */
function fitAxis(lo: number, hi: number, cLo: number, cHi: number, padRatio: number): ViewSpan {
  let a: number = lo;
  let b: number = hi;
  const span: number = b - a;
  if (!(span >= MIN_VIEW_SPAN_DEG)) {
    const mid: number = (a + b) / 2;
    a = mid - MIN_VIEW_SPAN_DEG / 2;
    b = mid + MIN_VIEW_SPAN_DEG / 2;
  }
  const pad: number = (b - a) * padRatio;
  a -= pad;
  b += pad;
  const cSpan: number = cHi - cLo;
  if (b - a > cSpan) {
    const mid2: number = (a + b) / 2;
    a = mid2 - cSpan / 2;
    b = mid2 + cSpan / 2;
  }
  if (a < cLo) { b += cLo - a; a = cLo; }
  if (b > cHi) { a -= b - cHi; b = cHi; }
  if (a < cLo) { a = cLo; }   // 跨度恰好等于 cSpan 时的兜底（上面两步互相顶住）
  return { lo: a, hi: b };
}

/**
 * 由一组照片的坐标求一个"能看到它们全部"的视野框（bounds），带内边距。
 * 返回 `[minLon, minLat, maxLon, maxLat]`（与 `CHINA_REGION.bounds` 同构）。
 *
 * ── 契约（调用方需要知道的全部）──────────────────────────────────────────────
 *   · **没有有效坐标时返回 `undefined`** → 调用方退回全国视野（`CHINA_REGION.bounds`）。
 *     这不是异常路径："28 张上墙、只有 7 张有坐标"就是设备上的真实情形。
 *   · **有效**的定义 = `placePick.hasPlace`（手动 > EXIF，`(0,0)` 不算）**且**坐标是有限数。
 *     与 `buildScene` 的筛选是**同一套规则** —— 视野框覆盖的照片集合必须正好是
 *     会被画到墙上的那些，否则会出现"框跟着一张根本没上墙的照片跑"。
 *   · **结果一定落在 `CHINA_REGION.bounds` 之内**（平移式钳制，见 `fitAxis` 第 ③ 步）。
 *   · **跨度一定为正**：每个轴要么被撑到 `MIN_VIEW_SPAN_DEG`，要么就是整个中国跨度。
 *     纬度因此恒在 18~54 之内 —— 墨卡托在极地发散（`mercY → ∞`），这个带是它不发散的区间。
 *   · `padRatio` 是**相对跨度**的比例（0.15 = 四周各留 15%）；≤0 / NaN 按 0 处理。
 *
 * 幂等：同一组照片恒得同一份数值（只做 min/max，与数组顺序无关）——
 * 预览与设备因此恒得同一张图（`tools/render-preview.ts` 与 WallPage 走的是这个函数）。
 */
export function fitBounds(photos: WallPhoto[], padRatio: number): number[] | undefined {
  let minLon: number = Number.POSITIVE_INFINITY;
  let minLat: number = Number.POSITIVE_INFINITY;
  let maxLon: number = Number.NEGATIVE_INFINITY;
  let maxLat: number = Number.NEGATIVE_INFINITY;
  let n: number = 0;
  for (let i = 0; i < photos.length; i++) {
    const p: WallPhoto | undefined = photos[i];
    if (p === undefined || p === null) { continue; }
    if (!hasPlace(p)) { continue; }
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) { continue; }
    n++;
    if (p.lon < minLon) { minLon = p.lon; }
    if (p.lon > maxLon) { maxLon = p.lon; }
    if (p.lat < minLat) { minLat = p.lat; }
    if (p.lat > maxLat) { maxLat = p.lat; }
  }
  if (n === 0) { return undefined; }
  const pad: number = Number.isFinite(padRatio) && padRatio > 0 ? padRatio : 0;
  // 两个轴走**同一条**路径：撑开 → 加边距 → 保持跨度平移进中国范围。
  // 纬度不做额外特判：fitAxis 第 ③ 步把它夹在 [18,54] 内且保跨度，
  // 比"先把纬度夹进带里再撑开"少一次可能撞上零跨度的机会。
  const lon: ViewSpan = fitAxis(minLon, maxLon, CHINA_BOUNDS[0], CHINA_BOUNDS[2], pad);
  const lat: ViewSpan = fitAxis(minLat, maxLat, CHINA_BOUNDS[1], CHINA_BOUNDS[3], pad);
  return [lon.lo, lat.lo, lon.hi, lat.hi];
}

/**
 * 相对"全国视野"的放大倍数（**经度方向**）。
 *
 * 定义：`中国经度跨度 / 当前视野经度跨度`。为什么只看经度就够：`projectMercator` 对经度是
 * 线性拉伸，`frame.w / 经度跨度` 就是"pt / 度"，两个视野在同一块画布上的比值正是 `62 / 跨度`
 * —— **与画布多宽、框怎么居中无关**，可以当"放大了几倍"的唯一数字用（真机诊断行与预览
 * 图例里报的就是它）。纬度方向因为墨卡托而不线性，单独算会得到另一个数（近邻城市那一档
 * 约 0.81 倍），所以不混在一起说。
 */
export function viewZoomOf(bounds: number[]): number {
  const b: number[] = normalizeBounds(bounds);
  const span: number = b[2] - b[0];
  const base: number = CHINA_BOUNDS[2] - CHINA_BOUNDS[0];
  if (!(span > 0)) { return 1; }
  return base / span;
}

/**
 * Mercator 的 y **反函数**（`mercYOf` 的逆）：把一个 mercY 值还原成纬度（度）。
 *
 * 推导：`y = ln(tan(π/4 + φ/2))` → `φ = 2·atan(e^y) − π/2`。
 * 只在 `fitViewToCanvas` 撑开纬度时用得到：那里必须在 **mercY 空间**里撑开（因为
 * `geoAspect` 的分子分母就是 `经度弧度 / mercY 跨度`），撑完再换回纬度。
 */
function invMercYOf(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/**
 * 纬度撑开的硬边界（度）。墨卡托在 ±85° 发散（`mercY → ±∞`），±84 之内仍然温和 ——
 * 这是"让 `fitViewToCanvas` 永远不产出 NaN/Infinity 坐标"的兜底，**不是**中国国界。
 */
const LAT_EXPAND_LIMIT = 84;
/** 经度撑开的硬边界（度）：跨度不许超过一整个环球 —— 再大就没有地图的语义了。 */
const LON_EXPAND_LIMIT = 360;

/**
 * "跨度已经顶满中国"的判定容差（相对量）。
 *
 * 为什么需要它：跨度**恰好**等于中国跨度时（= 缩到底那一帧，`[73,18,135,54]`），
 * 用户再拖一下，平移后的两端是 `cLo + s` / `cHi + s` —— 两者相减得到的跨度会比
 * `cHi − cLo` 差一两个 ulp。于是"取整段"那一支判不出来，代码走"平移贴边"那一支，
 * 而贴边那一支的**另一端是减出来的**（`a -= b - cHi`）→ 结果是纬度
 * `18.000000000000114` 而不是 18：虽然仍然 ≥ 18（安全方向），但
 * "缩到底之后再拖/再缩"就不再是逐位恒等，边界值会漂 1e-13。
 * 用相对容差 1e-12 认下这一两个 ulp，让"顶满中国"这件事**可判定**，
 * 于是缩到底之后的任何拖动都是**逐位不动**的（单测里钉住这一条）。
 * 1e-12 对应 62° 上的 6e-11 度（约 6 微米）—— 比数据本身的精度低若干量级。
 */
const SNAP_SPAN_EPS = 1e-12;

/**
 * 把一族视野框落进**中国范围** `CHINA_REGION.bounds` ——
 * "视野任何时候都不得跑到中国之外"这条硬规矩的**唯一执行点**
 *（`fitViewToCanvas` 与 `settleViewBox` 都调它，所以设备的两条路径口径不可能漂）。
 *
 * ── 为什么需要它（真机截图逼出来的一个反转决定）──────────────────────────────────
 *   用户在真机上把地图缩到底，得到的是：
 *     `视野 数据[115.66,29.88,122.19,41.24]→铺满[67,-20.6,129,64.4] ｜ 放大 9.5×→1×`
 *   诊断行自己写着"可缩 1×"（经度跨度确实到位了），可画面上的中国只占中间一小块，
 *   视野里塞进了东南亚与印度洋，**纬度跑到了南半球（−20.6°）**。
 *   成因：`zoomViewAt` 只把**经度跨度**夹到 62°（`MAX_VIEW_SPAN_DEG`），而框的宽高比
 *   必须与画布一致（376/642.57 = 0.5852），于是纬度跨度被经度跨度**唯一决定**：
 *     `纬度跨度(mercY) = 62 × DEG / 0.5852 = 1.849` —— 是中国自己（0.805）的 **2.30 倍**。
 *   `settleViewBox` 只夹**中心**、不夹跨度，所以没人挡得住它。
 *
 * ── 规则（与 `fitAxis` 第 ③ 步**同一条规矩**：越界时平移，绝不夹两端）────────────
 *   · 已经在中国之内 → **逐位原样返回**（"什么都没发生"必须是真的没发生，幂等靠这一条）；
 *   · 跨度**小于**中国跨度、只是位置越界 → **平移**进来（跨度不变 → 比例不变 → 不变形）；
 *   · 跨度**不小于**中国跨度 → 该轴取中国的整段（`[73,135]` / `[18,54]`）。
 *     两根轴都取满时结果**恒等于全国框**（`CHINA_REGION.bounds` 本身），
 *     这就是"缩到底 = 全国"的机器可读形态，也是"可缩 1×"这句话终于成立的原因。
 *   为什么不能"两端各夹一下"：那会把跨度压小甚至压成 0，而 `projectMercator` 的除数就是跨度
 *   → 整块画布 NaN → 地图与照片一起**静默消失**（同一个坑记在 `fitAxis` 的注释里）。
 *
 * ── ⚠️ 纬度那一根轴的平移必须在 **mercY 空间**里做（这是实现上唯一不显然的一处）──────
 *   经度在墨卡托里是线性的，所以"纬度用度数、经度用度数"看起来对称 —— 但**纬度不是**。
 *   在**度数**空间平移会改变 mercY 跨度，也就是**改变框的形状**（实测：把 29.88~41.24
 *   那一档往南推到贴住 18°N，mercY 跨度从 0.2446 涨到 0.2562，宽高比 0.5852 → 0.5585）。
 *   后果不只是"形状差一点"：`WallPage.rebuild()` 每次都拿 `fitViewToCanvas` 对齐画布比例，
 *   形状一变它就会**再撑一次**，症状是"抬手之后视野自己变宽了一下"。
 *   在 mercY 空间平移则**严格保形**（`geoAspect` 逐位不变），`fitViewToCanvas` 对手势产物
 *   仍然是恒等的 —— 那条"抬手不跳"的性质因此继续成立。
 *   注意"取整段"那一支仍然直接取 `CHINA_BOUNDS` 的**纬度**端点（不做 mercY 往返），
 *   所以缩到底得到的是**逐位**的 `[18, 54]`，不是 17.999999999999996。
 *
 * ── 取舍（写在报告里，不藏）────────────────────────────────────────────────────
 *   中国范围之外**没有轮廓数据**（数据里只有中国的环），所以把框收进中国不会丢任何要画的东西；
 *   代价是**画布比与中国的墨卡托比不一致时会出现信箱空白** —— 见 `fitViewToCanvas` 的注释。
 *   这个代价是**故意的**：宁可上下留白看到完整的中国，也不要"填满画布但中国只剩一个小角"。
 *
 * 非法输入（非有限数 / 非正跨度）→ 全国视野，与 `normalizeBounds` / `settleViewBox` 的退化口径一致。
 */
function containInChina(minLon: number, minLat: number, maxLon: number, maxLat: number): number[] {
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)
    || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return CHINA_BOUNDS;
  }
  if (!(maxLon > minLon) || !(maxLat > minLat)) { return CHINA_BOUNDS; }
  const cLoLon: number = CHINA_BOUNDS[0];
  const cHiLon: number = CHINA_BOUNDS[2];
  const cLoLat: number = CHINA_BOUNDS[1];
  const cHiLat: number = CHINA_BOUNDS[3];
  const cLoY: number = mercYOf(cLoLat);
  const cHiY: number = mercYOf(cHiLat);
  const y0: number = mercYOf(minLat);
  const y1: number = mercYOf(maxLat);
  // 快路径：已经在中国之内 → 逐位原样返回（浮点不失真、幂等、手势"没动"的那一帧不漂）。
  // 纬度用 mercY 比（mercY 严格单调，所以与用纬度比等价）。
  if (minLon >= cLoLon && maxLon <= cHiLon && y0 >= cLoY && y1 <= cHiY) {
    return [minLon, minLat, maxLon, maxLat];
  }
  // 经度：跨度够大就取整段（== 全国），否则平移进来（保跨度）
  let lo: number = minLon;
  let hi: number = maxLon;
  if (hi - lo >= (cHiLon - cLoLon) * (1 - SNAP_SPAN_EPS)) {
    lo = cLoLon;
    hi = cHiLon;
  } else if (lo < cLoLon) {
    hi += cLoLon - lo;
    lo = cLoLon;
  } else if (hi > cHiLon) {
    lo -= hi - cHiLon;
    hi = cHiLon;
  }
  // 纬度：同一条规矩，但在 **mercY 空间**里做（见上面那段"为什么"）。
  // "取整段"直接给 CHINA_BOUNDS 的纬度端点 —— 逐位精确，不做 mercY 往返。
  if (y1 - y0 >= (cHiY - cLoY) * (1 - SNAP_SPAN_EPS)) {
    return [lo, cLoLat, hi, cHiLat];
  }
  let a: number = y0;
  let b: number = y1;
  if (a < cLoY) {
    b += cLoY - a;
    a = cLoY;
  } else if (b > cHiY) {
    a -= b - cHiY;
    b = cHiY;
  }
  // 贴住边界的那一端**直接用中国的纬度端点**，不走 `invMercYOf` 往返：
  // `mercYOf(18)` 的反函数会给出 17.999999999999996（差 1 ulp，3.6e-15 度），
  // 于是"纬度不小于 18"在**逐位**比较下就不成立了。这一支是"越界时贴边"，
  // 贴边当然要落在边上 —— 而且 `a === cLoY` 是上面赋值出来的精确相等，不是浮点判断。
  const latLo: number = a === cLoY ? cLoLat : invMercYOf(a);
  const latHi: number = b === cHiY ? cHiLat : invMercYOf(b);
  return [lo, latLo, hi, latHi];
}

/**
 * 把"能装下数据的视野"调整为**与画布同样比例**（默认铺满）。
 *
 * ── 为什么需要（这就是用户的第三条反馈"默认铺满"的成因）──────────────────────
 *   `fitBounds` 只按**数据跨度**求框，不看画布。而 `mapFrame` 为了**不变形**只能
 *   在块里 contain（居中信箱式）：当 `geoAspect(数据框) != 画布宽高比` 时，
 *   框的一侧会空出一条带。设备真值（控制器在真机上量到的）正是这一档：
 *
 *     画布（地图块）376 × 663.71pt，视野 [115.66, 29.88, 122.19, 41.24]
 *     → 数据框的墨卡托宽高比 0.4671，画布宽高比 376/663.71 = 0.5665
 *     → `mapFrame` 给 309.1 × 663.71 @ (33.45, 0)，**左右各空 33.45pt**
 *
 *   本函数把框在**较短的那个轴上按比例撑开**，使"框的比例 == 画布的比例"：
 *   数据仍然全部可见（框 ⊇ 数据），但不再有信箱空白 —— 空出来的那两条带由
 *   **地图自己**（国界 / 省界 / 海岸线）填上。
 *
 * ── 撑开哪一根轴：由"框被谁限制"决定（不是随便挑一根）────────────────────────
 *   · `geoAspect(数据框) < 画布比` → 框会被**高度**限制（左右空）→ 撑开**经度**；
 *   · `geoAspect(数据框) > 画布比` → 框会被**宽度**限制（上下空）→ 撑开**纬度**。
 *   两种都是"框变大"，所以**撑开只会让框更大，不会裁掉任何数据**（本模块的第一不变量）。
 *   纬度那一支必须在 **mercY 空间**里撑（`geoAspect` 的分母就是 mercY 跨度），
 *   否则撑完比例对不上 —— 所以那里用 `invMercYOf` 换回纬度。
 *
 * ── 撑开后仍要钳制在中国范围内吗：**要**（此处与上一版相反，是真机逼出来的反转）──────
 *   上一版的判断是"不钳制、允许露出境外"，理由三条：钳制会破坏比例 / 境外只有底色 /
 *   撑开量有界。前两条**在数学上仍然成立**，但第三条在竖屏上不成立 —— 撑开量不是
 *   "信箱那一条带"，而是**整个纬度方向**。真机画布 376×642.57 下实测：
 *
 *     `fitViewToCanvas(CHINA_REGION.bounds, 376, 642.57)` = `[73,135] × [-11.54, 68.18]`
 *
 *   **全国视野自己就被撑到了南半球。** 于是"允许露出境外"的真实后果不是"边上多两条底色"，
 *   而是"中国缩成中间一小块"—— 那正是用户在截图里看到的东西。
 *   所以现在**钳制**，统一由 `containInChina` 执行（它用平移、不夹两端）。
 *   代价是**信箱空白回来了**，见下。
 *
 * ── 代价：全国视野下会有上下留白（这是"中国居中且尽量大"的唯一形态）────────────────
 *   竖屏 376×642.57 的宽高比 0.5852，而中国自己的墨卡托比是
 *   `geoAspect(CHINA_BOUNDS) = 1.3447`。两者不可能同时满足 ——
 *   "框的比例 == 画布的比例"与"框 ⊆ 中国"在 `1.3447 != 0.5852` 时**互斥**。
 *   本函数的取舍是：**框 ⊆ 中国**（用户要看到完整的中国）。此时 `mapFrame` 按 contain 走、
 *   被**宽度**限制 → 框 `376 × 279.62` 居中在 `(0, 181.48)`，上下各留 181.48pt（合计 56.5%）。
 *   为什么这就是"尽量大"：框宽已经 == 画布宽（中国的经度方向被顶满），再大就只能裁掉
 *   中国的南北两端，而"看到完整的中国"是这次的要求本身。
 *   留白那两条带里画的是**底色**（本形态下它就是地图：海 + 视野内没有轮廓数据的地方）。
 *
 *   task-18 **复核过这一条并选择保留**（用户裁决允许放宽"视野 ⊆ 中国"）：
 *   把框撑满整块画布的实测结果是 `[73.5, -12.54, 134.5, 68.44]`（**南半球**），
 *   中国陆地只占画面高度的 42.8% —— 比现在**更小**。也就是说"框填满块"与
 *   "中国尽可能大"在竖屏上互斥，而用户要的是后者。数字见 `MapFrame` 的注释与 task-18 报告。
 *   真正"看得见"的收益在**放大态**那一支：撑开经度时补进来的是**中国自己的**省界与海岸线
 *   （真机那一档正是这一支），它一点没变 —— 铺满的行为在用户认可的那张图上是**逐位不变**的。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────────
 *   比例已经匹配时**原样返回入参**（浮点容差 `1e-12` 相对量），所以重复调用不会累积漂移；
 *   设备与预览都调它，两次得到同一份数值。
 *
 * ── 退化（一律返回 `normalizeBounds(dataBounds)`，不猜、不产 NaN）───────────────
 *   · 画布宽/高非有限或 ≤ 0 → 原样返回（"画布多大都不知道"时不该改视野）；
 *   · `dataBounds` 非法（长度/NaN/零跨度）→ `normalizeBounds` 退回全国视野后再判断。
 *   每一步的返回值都要再过一次 `containInChina`（见上），所以**输出恒 ⊆ 中国范围**；
 *   ±84° / 360° 那两个兜底钳制因此在中国范围内**永不触发**，它们保留为第二道防线
 *   （防止 `CHINA_REGION.bounds` 哪天被改到安全带之外）。
 *
 * @param dataBounds `[minLon, minLat, maxLon, maxLat]`，典型来源是 `fitBounds` 的返回值
 *                   （没有有效坐标时调用方传 `CHINA_REGION.bounds`）。
 * @param canvasW 画布（地图块）宽 pt。
 * @param canvasH 画布（地图块）高 pt。
 * @returns 撑开后的 `[minLon, minLat, maxLon, maxLat]`：**恒 ⊇ 入参**（入参 ⊆ 中国时）且
 *          **恒 ⊆ `CHINA_REGION.bounds`**。两根轴都不能同时满足时才放弃比例（见上）。
 */
export function fitViewToCanvas(dataBounds: number[], canvasW: number, canvasH: number): number[] {
  const b: number[] = normalizeBounds(dataBounds);
  const bw: number = Number.isFinite(canvasW) && canvasW > 0 ? canvasW : 0;
  const bh: number = Number.isFinite(canvasH) && canvasH > 0 ? canvasH : 0;
  if (!(bw > 0) || !(bh > 0)) { return containInChina(b[0], b[1], b[2], b[3]); }
  const want: number = bw / bh;             // 目标：框的墨卡托宽高比 == 画布宽高比
  const cur: number = geoAspect(b);
  if (!(want > 0) || !(cur > 0)) { return containInChina(b[0], b[1], b[2], b[3]); }
  // 已经一样了（含浮点以内的相等）→ 原样返回。幂等靠这一条。
  if (Math.abs(cur - want) <= 1e-12 * want) { return containInChina(b[0], b[1], b[2], b[3]); }

  const minLon: number = b[0];
  const minLat: number = b[1];
  const maxLon: number = b[2];
  const maxLat: number = b[3];
  const y0: number = mercYOf(minLat);
  const y1: number = mercYOf(maxLat);

  if (cur < want) {
    // 框被高度限制（左右留白）→ 撑开经度：`want = 经度弧度 / mercY跨度`
    const needSpan: number = (want * (y1 - y0)) / DEG;      // 需要的经度跨度（度）
    const mid: number = (minLon + maxLon) / 2;
    let lo: number = mid - needSpan / 2;
    let hi: number = mid + needSpan / 2;
    if (hi - lo > LON_EXPAND_LIMIT) { lo = mid - LON_EXPAND_LIMIT / 2; hi = mid + LON_EXPAND_LIMIT / 2; }
    // 兜底：无论如何**不许把数据关在框外**（第一不变量优先于比例）
    if (lo > minLon) { lo = minLon; }
    if (hi < maxLon) { hi = maxLon; }
    // 最后一步：框 ⊆ 中国（平移优先，跨度过大才取整段）——顺序不能换，
    // 因为"⊇ 数据"与"⊆ 中国"只有在数据本身 ⊆ 中国时才可能同时成立（`fitBounds` 保证这一点）。
    return containInChina(lo, minLat, hi, maxLat);
  }

  // 框被宽度限制（上下留白）→ 撑开纬度：`want = 经度弧度 / mercY跨度`
  const needY: number = ((maxLon - minLon) * DEG) / want;   // 需要的 mercY 跨度
  const yc: number = (y0 + y1) / 2;
  let lo2: number = yc - needY / 2;
  let hi2: number = yc + needY / 2;
  const yLimit: number = mercYOf(LAT_EXPAND_LIMIT);
  if (lo2 < -yLimit) { lo2 = -yLimit; }
  if (hi2 > yLimit) { hi2 = yLimit; }
  // 兜底同上：数据必须仍在框内（mercY 单调，所以直接比 mercY 即可）
  if (lo2 > y0) { lo2 = y0; }
  if (hi2 < y1) { hi2 = y1; }
  // 最后一步同上：全国视野走的就是**这一支**（中国比竖屏画布"宽" → 撑纬度 → 被收回中国）
  return containInChina(minLon, invMercYOf(lo2), maxLon, invMercYOf(hi2));
}

// ── 手势视野：双指缩放 / 拖动平移（task-16 的第 3 件事）────────────────────────
//
// 用户原话：「还有地图应该支持缩放吧 默认铺满」。
//
// 这两个函数是**纯函数**（不碰 ArkUI），因为它们是这一批里最容易算错的东西：
// 归一化坐标 ↔ 墨卡托 ↔ 经纬度的来回换算、以及"哪根轴对哪个方向"的符号。
// 放在 core 里就能在 Node 单测里逐条钉住（`render.test.ts` 的"手势视野"那一节），
// 而放在 WallPage.ets 里就只能靠真机肉眼 —— 那是最贵的验证方式，也最容易漏。
//
// ── 为什么参数是"画布上的**归一化**位置（0~1）"而不是经纬度或像素 ────────────────
//   · 手势事件给的是**像素/vp**（`pinchCenterX`、`offsetX`），调用方除以画布宽高就得到
//     归一化值 —— 那是纯算术，不需要知道墨卡托；把 `mercY` 关在 core 里，
//     WallPage 就不必再抄一遍投影公式（`geoAspect` 的注释里已经记过一次这种漂移风险）。
//   · 归一化值同时是**与画布尺寸无关**的：同一个手势在 360×720 与 376×663.71 上
//     表达的是同一件事，单测因此不必模拟设备尺寸。
//
// ── 为什么缩放的不动点按"归一化位置"给，而不是"绕中心" ──────────────────────────
//   双指缩放的不动点是**两指中点**（地图 App 的通用手感），它一般不在画布中心。
//   绕中心缩放在手指偏一侧时会"地图自己往中间跑"，手感是错的。

/**
 * 视野缩放的**下限**（经度跨度，度）= 全国跨度。再往外缩就没有地图可看了：
 * `CHINA_REGION.bounds` 之外没有任何轮廓数据，画出来只有底色。
 * 这个数直接由 `CHINA_BOUNDS` 算出，**不另写 62**（那迟早与 projection.ts 漂移）。
 *
 * ⚠️ 它**只管经度**（task-17 的教训）：`zoomViewAt` 用它反解 factor 时，纬度是按同一个
 * factor 搭车的，所以"经度到顶"并不等于"框到了全国" —— 真机上经度到顶、纬度还在膨胀，
 * 得到 `lat[-20.6, 64.4]`。真正把两根轴都收住的是 `containInChina`（它按 `CHINA_BOUNDS`
 * 的两根轴各自收）。这个常量现在的职责是"别让 factor 把经度缩过头"，与它配合出
 * "缩到底 == 全国"。
 */
export const MAX_VIEW_SPAN_DEG: number = CHINA_BOUNDS[2] - CHINA_BOUNDS[0];

/**
 * 视野缩放的**上限**（经度跨度，度）= 单个城市级，复用既有的 `MIN_VIEW_SPAN_DEG = 0.6°`。
 *
 * 为什么复用它而不是另取一个数：`fitBounds` 的注释里已经把 0.6° 论证过一遍
 * （"0.6° 纬度 = 66.7km，一个地级市加近郊的尺度"），而且"只有一张照片时视野多大"
 * 与"用户最多能放大到多近"必须一致 —— 否则会出现"默认视野比用户能手动放大的极限还近"
 * 这种自相矛盾的状态。**一处定义，两处使用**。
 *
 * 代价（写进报告，不藏）：0.6° 视野下省界往往只剩几条近乎直线的段，看不到更多细节 ——
 * 因为我们没有路网/建筑级数据。所以"能放多大"的上限不是性能问题，是**数据边界**问题。
 */
export const MIN_ZOOMED_VIEW_SPAN_DEG: number = MIN_VIEW_SPAN_DEG;

/**
 * 手势缩放的**可达倍数区间**（`viewZoomOf` 口径，即 `62° / 经度跨度`）：`[最小, 最大]`。
 *
 * ── 为什么它必须是一个**导出的函数**，而不是显示端自己写两遍 ─────────────────────
 *   真机诊断行上印的 `可缩 1×~103.33×` 原来是**手写**的：`'1×'` 是字符串字面量，
 *   最大值在 `WallPage` 里另算一遍。那个"1×"当时只是**显示** —— 经度跨度确实被夹在 62°，
 *   可同一个框的纬度一路膨胀到 −20.6°，用户看到的根本不是全国。
 *   "显示与行为不符"的根，就是**显示端与约束端各写各的**。
 *   现在两端读同一个函数：约束端是 `MAX_VIEW_SPAN_DEG` / `MIN_ZOOMED_VIEW_SPAN_DEG`
 *   ＋ `containInChina`（保证经度到顶那一步真的等于全国框），显示端是这个函数 ——
 *   于是单测可以**直接**断言"显示的下界 == 反复缩小实际到达的下界"
 *   （`render.test.ts` 的"可缩 N× 显示与真实界限一致"那一条）。
 *
 * @returns `[最小倍数, 最大倍数]`：最小 = `viewZoomOf(全国框)` = 1（缩到底就是全国），
 *          最大 = `62° / 0.6°` ≈ 103.33（放到单城市级）。
 */
export function viewZoomRange(): number[] {
  const nat: number = viewZoomOf(CHINA_BOUNDS);
  const near: number = MIN_ZOOMED_VIEW_SPAN_DEG > 0
    ? (CHINA_BOUNDS[2] - CHINA_BOUNDS[0]) / MIN_ZOOMED_VIEW_SPAN_DEG
    : nat;
  return [nat, near];
}

/**
 * 把一个刚算出来的方框落成**合法**的视野框；**已经合法时原样返回**（逐位不变）。
 *
 * ── 为什么需要它（这是本批真踩到的一个坑）────────────────────────────────────
 *   手势可以把手指数到任意远：`panViewBy(b, 0, 50)` 表示"往下拖 50 个画布高"。
 *   第一版没做这一步，于是画出纬度 **-89.9999°** 的框 —— 而 `mercYOf` 内部把纬度
 *   夹在 ±85°，两条边界夹完之后 mercY 跨度**变成 0**：
 *   `projectMercator` 的除数就是那个跨度 → 整块画布 NaN → 地图与照片一起**静默消失**。
 *   这正是本模块最怕的一类失败（同 `parseBounds` / `fitAxis` 的注释）。
 *   所以约束必须在**算出方框的这一层**就强加，而不是指望调用方不去算极端的数。
 *
 * ── 四条约束（顺序不能换：先保跨度，再挪中心，最后收进中国）────────────────────
 *   1. **经度跨度** ≤ 360°（环球）。再大就没有地图的语义了。
 *   2. **mercY 跨度** ≤ 墨卡托安全带（`±LAT_EXPAND_LIMIT` = ±84°）。
 *      跨度超了就收到整条带（这是"装不下"的唯一情形）；
 *      跨度本身没超、只是位置越界时**平移**回来 —— **平移不改变跨度**，
 *      与 `fitAxis` 第 ③ 步"平移而不是夹两端"是同一条规矩（夹两端会把跨度压小甚至压成 0）。
 *   3. **中心**同时被两个区间夹：中国范围 `[73,135]×[18,54]`（手势特有：不许拖到
 *      视野里完全没有中国 —— 那是一片底色，用户也不知道怎么回来），以及
 *      "整条框都不越出墨卡托安全带"给中心留下的那一段。
 *      两个区间不相交时（跨度太大、两者都要占满）取 `mercY = 0`。
 *   4. **框整个 ⊆ 中国范围**（`containInChina`，最后一步，两条返回路径都要过）。
 *      ⚠️ 这一条是 task-17 补的，**它才是"缩小的上界"**：约束 1~3 里
 *      只有第 1 条管跨度，而它只管**经度** —— 于是"经度顶到 62°（全国）之后
 *      纬度继续按画布比例搭车膨胀到 ±84°"这件事原先没人挡。
 *      真机症状：诊断行写着"可缩 1×"，画面上的中国却只剩中间一小块、纬度到了 −20.6°。
 *
 * **合法性判据 = 那三个布尔量**（`lonOk && yOk && inChina`），"原样返回"的承诺靠它们，
 * 而不是靠"再算一遍看等不等" —— 后者对浮点是不成立的。
 */
function settleViewBox(minLon: number, minY: number, maxLon: number, maxY: number): number[] {
  const yLimit: number = mercYOf(LAT_EXPAND_LIMIT);
  const lonSpanRaw: number = maxLon - minLon;
  const ySpanRaw: number = maxY - minY;
  // 连数字都不是 → 退回全国视野（不产 NaN 是硬契约）
  if (!Number.isFinite(minLon) || !Number.isFinite(maxLon)
    || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return CHINA_BOUNDS;
  }
  if (!(lonSpanRaw > 0) || !(ySpanRaw > 0)) { return CHINA_BOUNDS; }

  const cLoY: number = mercYOf(CHINA_BOUNDS[1]);
  const cHiY: number = mercYOf(CHINA_BOUNDS[3]);
  let cLon: number = (minLon + maxLon) / 2;
  let cY: number = (minY + maxY) / 2;
  // **框整个落在中国范围之内**（不只是中心）。mercY 单调，所以用 mercY 比与用纬度比等价。
  // 这是 task-17 新增的那一条：老代码只夹中心，于是"经度顶到 62° 之后纬度继续搭车膨胀"
  // 这件事没人挡（真机缩到底得到 lat[-20.6, 64.4]）。见 `containInChina` 的长注释。
  const inChina: boolean = minLon >= CHINA_BOUNDS[0] && maxLon <= CHINA_BOUNDS[2]
    && minY >= cLoY && maxY <= cHiY;
  const lonOk: boolean = lonSpanRaw <= 360 && cLon >= CHINA_BOUNDS[0] && cLon <= CHINA_BOUNDS[2];
  const yOk: boolean = ySpanRaw <= 2 * yLimit && cY >= cLoY && cY <= cHiY
    && minY >= -yLimit && maxY <= yLimit;
  // 快路径：已经合法 → 逐位原样返回。手势的每一步因此都是**精确**变换（不做无谓的重新居中）。
  if (lonOk && yOk && inChina) {
    return [minLon, invMercYOf(minY), maxLon, invMercYOf(maxY)];
  }

  let lonSpan: number = lonSpanRaw > 360 ? 360 : lonSpanRaw;
  let ySpan: number = ySpanRaw > 2 * yLimit ? 2 * yLimit : ySpanRaw;
  if (cLon < CHINA_BOUNDS[0]) { cLon = CHINA_BOUNDS[0]; }
  if (cLon > CHINA_BOUNDS[2]) { cLon = CHINA_BOUNDS[2]; }
  // 中心的 y：两个允许区间的**交集**；不相交（跨度把带占满了）时退到 0（赤道）
  const loLimit: number = Math.max(-(yLimit - ySpan / 2), cLoY);
  const hiLimit: number = Math.min(yLimit - ySpan / 2, cHiY);
  if (loLimit <= hiLimit) {
    if (cY < loLimit) { cY = loLimit; }
    if (cY > hiLimit) { cY = hiLimit; }
  } else {
    cY = 0;
  }
  const minY2: number = cY - ySpan / 2;
  const maxY2: number = cY + ySpan / 2;
  // 收尾：框 ⊆ 中国（平移优先，跨度过大才取整段）。上面那些夹断都只是"别产出 NaN"的中间兜底，
  // **中国范围这一条才是对外承诺** —— 所以它必须排在最后，且两条返回路径都要过。
  return containInChina(cLon - lonSpan / 2, invMercYOf(minY2), cLon + lonSpan / 2, invMercYOf(maxY2));
}

/**
 * 以画布上的归一化点 `(fx, fy)` 为**不动点**缩放视野。`factor > 1` = 放大（视野变小）。
 *
 * "不动点"的含义：那个归一化位置对应的**地理点**缩放前后仍落在同一个归一化位置上
 * （手指按住哪儿，哪儿就不动）。归一化位置 ↔ 地理点的换算里，纬度那一半走 `mercY`
 * ——因为 `projectMercator` 的纵向就是按 mercY 线性拉伸的，只有这样"不动"才真的是不动。
 *
 * ── 三条界限（都在这里强制，调用方不必自己判）────────────────────────────────
 *   · 经度跨度被夹在 `[MIN_ZOOMED_VIEW_SPAN_DEG, MAX_VIEW_SPAN_DEG]` = `[0.6°, 62°]`。
 *     实现方式是**反解出允许的 factor 范围** `[跨度/62, 跨度/0.6]` 再夹 ——
 *     这样"夹完之后仍然以同一点为不动点"，不会出现"夹到边界时地图突然横移一下"。
 *   · **框整个落在中国范围之内**（由 `settleViewBox` → `containInChina` 执行）。
 *     这一条是 task-17 补的，也是"缩到底 = 全国"的另一半：
 *     上面那条只管经度，而纬度是**搭车**的（同一 factor）。
 *   · 中心与跨度还各有一道"别产出 NaN"的中间兜底（见 `settleViewBox` 的注释）。
 *
 * 非法输入（`factor` 非有限或 ≤ 0、`bounds` 非法）一律原样返回归一化后的框 ——
 * 与 `fitViewToCanvas` 的退化口径一致：**不产 NaN、不抛错**。
 */
export function zoomViewAt(bounds: number[], factor: number, fx: number, fy: number): number[] {
  const b: number[] = normalizeBounds(bounds);
  if (!Number.isFinite(factor) || !(factor > 0)) { return b; }
  const px: number = Number.isFinite(fx) ? fx : 0.5;
  const py: number = Number.isFinite(fy) ? fy : 0.5;
  const lonSpan: number = b[2] - b[0];
  const y0: number = mercYOf(b[1]);
  const y1: number = mercYOf(b[3]);
  const ySpan: number = y1 - y0;
  if (!(lonSpan > 0) || !(ySpan > 0)) { return b; }
  // 反解允许的 factor：lonSpan / f 必须落在 [0.6, 62]
  const fLo: number = lonSpan / MAX_VIEW_SPAN_DEG;
  const fHi: number = lonSpan / MIN_ZOOMED_VIEW_SPAN_DEG;
  let f: number = factor;
  if (f < fLo) { f = fLo; }
  if (f > fHi) { f = fHi; }
  // `f === 1` 是**恒等**（不动点那一步在 f=1 时逐项退化成原值），所以直接逐位返回。
  // 为什么要专门写这一条：下面要过一趟 mercY → 反 mercY 的往返，那会丢掉一两个 ulp
  // （29.95 → 29.949999999999996）。手势每一帧都调这个函数，而"手指没动"的那一帧
  // **必须是真正的没动** —— 否则"恒等"这件事就没法用逐位相等来钉住。
  if (f === 1) { return b; }
  // 不动点（经度线性、纬度按 mercY 线性）。
  // ⚠️ 纵向的参考端是**北**（`y1 = mercY(maxLat)`），不是南：归一化 y 是从**画布顶端**量的，
  // 而画布顶端是**北**（`projectMercator` 让 maxLat 落在 y=0）。写成 `y0 + ySpan*py` 时
  // 中心那一档（py=0.5）恰好也对 —— 因为中点两边一样 —— 所以**只有偏心的缩放才会露馅**：
  // 实测 (0.25,0.75) 处的不动点会跑掉 0.75 个画布高。这个坑真踩到了。
  const lon: number = b[0] + lonSpan * px;
  const y: number = y1 - ySpan * py;
  const minLon: number = lon - (lon - b[0]) / f;
  const maxLon: number = lon + (b[2] - lon) / f;
  const minY: number = y - (y - y0) / f;
  const maxY: number = y + (y1 - y) / f;
  return settleViewBox(minLon, minY, maxLon, maxY);
}

/**
 * 拖动平移：把**画面内容**移动 `(fx × 画布宽, fy × 画布高)`（归一化），
 * 视野框相应地向**反方向**移动同样的地理距离。
 *
 * 符号约定（这是最容易写反的一处，所以写成契约）：**`fx > 0` = 手指向右拖 = 内容向右走
 * = 视野往西看**，于是 `minLon` **减小**；**`fy > 0` = 手指向下拖 = 内容向下走 = 视野往北看**，
 * 于是 mercY 区间**增大**。
 *
 * ⚠️ 纵向的符号与横向**不是**同一个方向（`-` 与 `+`）—— 因为归一化 y 是从**画布顶端**量的，
 * 而顶端是**北**（`mercY` 最大的一侧）。写成与横向对称的 `y0 - dy*ySpan` 是错的，
 * 症状是"内容跟着手指走反了"，而**横向完全正常**，所以很容易漏掉。实测抓到了：
 * `panViewBy(dev, 0.1, 0.2)` 让画面里的点位移 `(0.1, -0.2)` —— y 反了。
 *
 * 纵向**必须**在 mercY 空间里平移（不是纬度空间）：屏幕上等距的拖动对应等量的 mercY，
 * 而不是等量的纬度 —— 在北纬 50° 用纬度平移会比手指走得快约 1.5 倍。
 *
 * 平移不改变跨度（也就不会改变比例），所以它不会干扰 `fitViewToCanvas` 的不变量。
 * 中心、墨卡托安全带与**中国范围**由 `settleViewBox` 统一夹住 —— 最后那一条意味着
 * **平移是"顶到边界就停"**：缩到全国（1×）之后再也拖不动（框已经等于中国，无处可去），
 * 放大态则可以一直拖到框边贴上中国边界。手感上等价于地图 App 的"拖到头"。
 */
export function panViewBy(bounds: number[], fx: number, fy: number): number[] {
  const b: number[] = normalizeBounds(bounds);
  const dx: number = Number.isFinite(fx) ? fx : 0;
  const dy: number = Number.isFinite(fy) ? fy : 0;
  // 零位移 = **逐位恒等**（理由同 `zoomViewAt` 的 `f === 1`：不要为"没动"的那一帧
  // 引入一次 mercY 往返的 ulp 误差）
  if (dx === 0 && dy === 0) { return b; }
  const lonSpan: number = b[2] - b[0];
  const y0: number = mercYOf(b[1]);
  const y1: number = mercYOf(b[3]);
  const ySpan: number = y1 - y0;
  if (!(lonSpan > 0) || !(ySpan > 0)) { return b; }
  const minLon: number = b[0] - dx * lonSpan;
  const maxLon: number = b[2] - dx * lonSpan;
  const minY: number = y0 + dy * ySpan;
  const maxY: number = y1 + dy * ySpan;
  return settleViewBox(minLon, minY, maxLon, maxY);
}

// ── 钉子上那簇小点：本形态下"照片"的全部视觉（设备与预览共用） ──────────────
//
// 用户裁决：「地图为主：照片改小、点开才看大图」。
// 于是这里**没有卡片、没有挂线、没有弧**，只有一个点：`MARKER_R` + 一个位置。
// 下面这三个常量是设备侧（WallPage 的 Circle）与预览（SVG 的 <circle>）**唯一**的
// 尺寸来源 —— 两边各写一个半径就会变成"电脑上看到的和真机上看到的不是同一张图"。

/**
 * 一个照片标记的半径（pt）。
 *
 * 1.9 的来历（三个约束同时满足的最小值）：
 *   · **比钉子小、但一眼看得见**：钉点是 3.4pt（收起时），标记 1.9 —— 层级清楚
 *     （钉是锚，点是内容），3 倍屏上直径 11.4px，不会是"脏点"。
 *   · **够小，才不会与地图争画面**：这正是本批的目的。26×34 的卡片面积是 884pt²，
 *     6 个标记的面积是 136pt² —— **小 6.5 倍**，而且不再占据钉子下方 48pt 的纵向空间。
 *   · **与步距一起保证不重叠**：`MARKER_STEP = 4.5` 时相邻圆心距
 *     `2·R·sin(23°) = 0.781·R_arc`，实测 6.18pt ≥ 2R = 3.8pt（净间隙 2.38pt）。
 *     单测 `pinMarkers：n=1..MAX 的标记互不重叠` 穷举全部对钉住这一条。
 */
export const MARKER_R = 1.9;

/**
 * 簇内相邻标记的横向步距（pt）。
 *
 * 4.5 是"看得清是几个点"与"整簇别太宽"之间的取值：5 个点占 18pt（4 个间隔），
 * 加上半径两端共 21.8pt —— 比地名标签（8fp 中文约 46~74pt）窄得多，所以
 * "标记簇"在视觉上永远是钉子的一部分，不会变成第二个东西。
 */
export const MARKER_STEP = 4.5;

/**
 * 标记簇到钉点的竖直留白（pt）：**第一个标记的圆心**在钉子正下方 `MARKER_DY` 处。
 *
 * 5.0 是"贴着钉子"与"不压在钉点上"之间**唯一**的取值（实测出来的，不是拍的）：
 *   · 圆心距 ＝ `√(dx² + dy²)`，而**最近的**那个标记就在正下方（dx=0）→ 圆心距 = dy。
 *     要让圆点与钉点不重叠，需要 `dy ≥ 钉半径(3.4) + 标记半径(1.9) = 5.3`；
 *     取 5.0 时两者**相交 0.3pt**（视觉上是"长在一起"，挺自然），但那不是"不重叠"。
 *     所以这是一个**刻意的选择**：`dy = 5.0` 让整簇读起来像"从钉点上长出来的"（左边那张图），
 *     而单测钉住的是"**圆点四周仍然看得见红钉**"这条更弱、但观感上更重要的性质
 *     （见 `pinMarkers：贴着钉子` 的第 ③ 条：圆心距 ≥ 钉半径）。
 *   · 再大（6.5）就散了：整簇最高点降到钉心下方 4.6pt，钉与点之间出现一条
 *     **可见的空隙**，"一簇"就变成了"一排浮在地图上的小点"。
 */
export const MARKER_DY = 5.0;

/**
 * 一个钉子的簇里**最多画几个标记**。超出部分由「＋N」角标如实报出。
 *
 * ── 取 5 的三条理由（都不是拍的）─────────────────────────────────────────────
 *   1. **视觉上仍然是"一簇点"**：5 个标记横向占 21.8pt（含半径两端），而地名标签在
 *      8fp 下是 46~74pt 宽 —— 簇比自己的标签窄一半以上，所以它读起来是钉子的附属物。
 *      再往上（8 个）就要占 39.5pt，与标签同宽，开始像"第二个锚点"。
 *   2. **两行就会变成网格，那是卡片思维的残留**：一行的点在 `dy = 4.0`（贴着钉子）；
 *      一旦要放第 6 个就得开第二行 `dy = 11.5`，整簇变成一个 2×N 的小方阵 ——
 *      那正是本批删掉的"照片块"。**一行封顶**是"标记"与"卡片"的分界线。
 *   3. **`+N` 与张数读起来是加法**：5 个点 + `＋4` = 9 张。点了钉子是 9 张。
 *      一眼就能把"画面上的点"与"实际的张数"对上，不需要心算第二行有几个。
 *
 * 它与 `placement.MAX_HANG = 9` 的差别是**故意的**：`MAX_HANG` 描述的是"一屏最多挂
 * 几张"（那是卡片时代的空间上限），本形态下每钉最多画 5 个标记 ——
 * 照片一张都没丢，全在 `ScenePin.photos` 里、点开就能看。
 */
export const MAX_MARKERS = 5;

/**
 * 钉子的视觉尺寸（pt）。**钉点是锚、标记是内容**，所以两者都在这里定死：
 * 设备侧（Circle）与预览（SVG circle）读同一份。
 *
 * · `PIN_DOT_R`（3.4）：钉点 —— 本形态下它是**主角**，比标记大一圈，也是点击目标
 *   （真实点击区是 `HIT_SIZE`，见 WallPage）。
 * · `PIN_HALO_R`（5.2）：钉点外面那圈淡红描边，让钉点在省界/轨迹上仍然跳得出来。
 */
export const PIN_DOT_R = 3.4;
export const PIN_HALO_R = 5.2;

/**
 * 钉点与标记的颜色。**与设备侧同一个字符串**（见 `PROVINCE_STROKE` 的同一条理由）。
 * 标记用更浅的一档：它是"数量"，不是"位置"。
 */
export const PIN_COLOR = '#C0392B';
export const MARKER_COLOR = '#D9553F';

/**
 * 一簇标记的**张角**（**总**张角，弧度）。取 46°（±23°）。
 *
 * 为什么是弧而不是一条水平线：一条线上的点在视觉上是"一排钉子"；微微向下弯的弧
 * 读起来才是"从钉子上下来的"（与旧版弧线挂照片同一个直觉，只是尺度从 100pt 缩到 2.4pt）。
 * 46° 的**矢高**（中间那点比两端低多少）是 `(step/2)/tan(23°) ≈ 0.21pt` ——
 * 小到肉眼看不出弯，大到"不是一条死板的直线"。
 *
 * 为什么不做成 `hangOffsets` 那样的"等半径风铃"：那个几何的全部意义是"线一样长"，
 * 而这里的点是**贴着钉子**的（离钉 2~4pt），等半径会把它推成一个半径 2pt 的圆 ——
 * 点在钉子的左上方和右上方，那是"绕钉一圈"，不是"钉子上有一簇照片"。
 */
export const MARKER_SWEEP_RAD = 0.8028514559173915;   // 46° * PI / 180

/**
 * `count` 张照片 → 钉子旁的一簇标记（相对钉子的偏移，pt）。
 *
 * ── 三条性质（**这就是"标记"的全部几何**，单测逐条钉住）────────────────────────
 *   1. **数量封顶**：返回长度 = `min(count, MAX_MARKERS)`，`count ≤ 0` 返回空数组。
 *      超出的部分由绘制方按 `+N` 画（N = `count − 返回长度`）。
 *   2. **贴着钉子**：每个标记的 `dy ∈ [MARKER_DY·cos(23°), MARKER_DY]` ——
 *      **恒正、且 ≤ MARKER_DY（4pt）**。"照片吊下来一长条"这件事在新几何里
 *      没有可表达的空间：dy 没有第二个来源。
 *   3. **横向不越界**：`|dx| ≤ (MAX_MARKERS−1)/2 · MARKER_STEP = 9pt` ——
 *      整簇最宽 18pt（含半径 21.8pt），比地名标签窄一半以上。
 *
 * `count === 1` 是一个标记**正下方** `dy = MARKER_DY`（dx = 0）：一张照片时不该有"排"。
 * `count > 1` 时两端正好落在 ±张角/2（与 `arcSpread` 的"两端正好顶满"同一条规矩）——
 * 于是"传进去几个点、画出来几个点"是字面意思，绘制方不必再算一遍。
 *
 * 纯函数：同一份输入恒得同一份输出（只有乘除与 sin/cos，没有状态、没有随机）。
 */
export function pinMarkers(count: number): PinMarker[] {
  const out: PinMarker[] = [];
  if (!(count > 0)) { return out; }
  const m: number = count > MAX_MARKERS ? MAX_MARKERS : Math.floor(count);
  if (!(m > 0)) { return out; }
  // 半径取成"两端正好落在 ±张角/2"：R = (半宽) / sin(张角/2)
  const radius: number = ((m - 1) * MARKER_STEP / 2) / Math.sin(MARKER_SWEEP_RAD / 2);
  for (let i = 0; i < m; i++) {
    const t: number = m === 1 ? 0 : i / (m - 1) - 0.5;      // ∈ [−0.5, 0.5]
    const theta: number = t * MARKER_SWEEP_RAD;
    out.push({ dx: radius * Math.sin(theta), dy: MARKER_DY * Math.cos(theta) });
  }
  return out;
}

/**
 * 一个钉子要画的标记数：`expanded` 为假时是 0（光点），否则 `min(张数, MAX_MARKERS)`。
 *
 * **设备与预览都必须走这一个函数**：两边各写一次 `expanded ? min(n, MAX) : 0`，
 * 迟早会漂移成"电脑上有点、真机上没有"。
 */
export function markerCountOf(pin: ScenePin): number {
  if (!pin.expanded) { return 0; }
  const n: number = pin.photos.length;
  return n > MAX_MARKERS ? MAX_MARKERS : n;
}

/** 「＋N」角标的尺寸（pt）。它跟着标记簇走，绘制方与单测共用这一份。 */
export const BADGE_W = 14;
export const BADGE_H = 7;

/** 一个矩形（画布坐标，pt）：左上角 + 宽高。本形态下只剩「＋N」角标用它。 */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * 「＋N」角标的矩形（画布坐标）：挂在**标记簇的右下方**，右缘与最右那个标记对齐。
 *
 * 位置由簇自己的**实际**外沿算出来（不写死 `x−7`）：这样无论 MAX_MARKERS 或
 * MARKER_STEP 怎么改，角标都不会压到点上 —— 而"位置算歪了"是看不见的
 * （角标只有 14×7pt）。
 *
 * 为什么在右下方而不是正下方：正下方是轨迹与省界最密的地方，而右下通常空着；
 * 而且角标与簇共用一个右下角，读起来是"这一簇还有 N 张"。
 * `markers` 为空（光点钉）时退化成钉子右下角的一个小矩形，仍然合法。
 */
export function badgeRectOf(pin: ScenePin, markers: PinMarker[]): Rect {
  let maxDx: number = -Number.MAX_VALUE;
  let maxDy: number = -Number.MAX_VALUE;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].dx > maxDx) { maxDx = markers[i].dx; }
    if (markers[i].dy > maxDy) { maxDy = markers[i].dy; }
  }
  const right: number = markers.length === 0 ? PIN_DOT_R : maxDx + MARKER_R;
  const bottom: number = markers.length === 0 ? PIN_DOT_R + 2 : maxDy + MARKER_R + 2;
  return { x: pin.x + right - BADGE_W, y: pin.y + bottom, w: BADGE_W, h: BADGE_H };
}

// ── 场景构建 ────────────────────────────────────────────────────────────────

/** 保留 2 位小数。SVG 体积与**输出可复现**都靠它（浮点误差会让同一份数据产出不同字节）。 */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 境外/无县的坐标点的显示名。也用它的前缀做分组键，避免与地名撞车。 */
function coordLabel(lat: number, lon: number): string {
  const la: string = Math.abs(lat).toFixed(1) + (lat >= 0 ? '°N' : '°S');
  const lo: string = Math.abs(lon).toFixed(1) + (lon >= 0 ? '°E' : '°W');
  return la + ' ' + lo;
}

/**
 * 一张照片的钉子显示名。
 * **有 `place` 就直接用**（那是 formatPlace 的产物，本模块不重拼地名）；
 * 没有才用 nearestCounty 反查（**退化路径**，设计 §6.3 的"宁可名字粗"）；
 * 连县都判不出来（境外 >800km）才退回坐标标签。
 */
function pinNameOf(p: WallPhoto): string {
  const given: string = p.place === undefined || p.place === null ? '' : p.place.trim();
  if (given.length > 0) { return given; }
  const hit: CountyHit | undefined = nearestCounty(p.lon, p.lat);
  if (hit !== undefined) { return formatPlace(hit); }
  return coordLabel(p.lat, p.lon);
}

/**
 * 同一钉子里照片的顺序：**时间正序**（老 → 新，弧线从左到右就是一条时间线），
 * 时间未知（`takenAt <= 0`）的**排在最后**，同组内按 photoId 升序保证可复现。
 *
 * 为什么时间未知的排最后而不是最前：0 不是时间。放在最前会让它伪装成
 * "这组里最早的一张"，用户无从分辨；放在最后，它成为一枚**可见的"未定年"尾巴**，
 * 既不丢照片（设计要求：没时间也必须上墙），也不说谎。
 * 为什么组内还要按 photoId 排：`Array.sort` 在 V8 上稳定，但"稳定"依赖输入顺序，
 * 而输入顺序来自 Map 的插入顺序 —— 一条 tie-break 让输出与输入顺序无关，测试才钉得住。
 */
function comparePhotos(a: WallPhoto, b: WallPhoto): number {
  const az: boolean = !(a.takenAt > 0);
  const bz: boolean = !(b.takenAt > 0);
  if (az !== bz) { return az ? 1 : -1; }
  if (!az && a.takenAt !== b.takenAt) { return a.takenAt < b.takenAt ? -1 : 1; }
  if (a.photoId === b.photoId) { return 0; }
  return a.photoId < b.photoId ? -1 : 1;
}

/** 钉子的最终顺序：按 pinId 字典序。目的是**输出可复现**（同一份数据恒得同一张图）。 */
function comparePins(a: ScenePin, b: ScenePin): number {
  if (a.pinId === b.pinId) { return 0; }
  return a.pinId < b.pinId ? -1 : 1;
}

/**
 * 从照片列表算出场景。这是地图墙的**唯一**布局入口（设备与 Node 预览共用）。
 *
 * 流程（每一步都复用既有模块，不重写规则）：
 *   1. **筛**：`hasPlace` 为假的照片直接不要 —— 没有地点的照片不在墙上（设计要求）；
 *      顺便按 photoId 去重（同一张照片重复传入不该长出两个钉子）。
 *   2. **分组**：同一显示名归一个钉子（`pinId` = 显示名）。
 *   3. **定位**：钉子在组内照片坐标的**中位数**处，Mercator 投影到画布。
 *   4. **聚簇**：`clusterByScreen` 把屏幕距离 ≤ 40pt 的钉子并成一个
 *      （设计 §6.2；判"挤不挤"用屏幕坐标而非经纬度）。并簇后名字取**照片最多的那个**，
 *      多于一个地名时带上「等N地」—— 不能悄悄丢掉一个地名。
 *   5. **展开态**：`computeLayout` 按（钉数、每钉张数、zoom）给答案（设计 §6.2 的三档阈值）。
 *      本形态下它只决定**标记画不画**（false = 光点）。
 *   6. **标记**：`expanded` 为真时，按 `pinMarkers(min(张数, MAX_MARKERS))` 给出
 *      钉子旁那几个小点的偏移。
 *
 * ── 第 6 步为什么不再有"空间复核"（task-18 删掉的整段）────────────────────────
 * 旧形态要回答"这块画布上挂得下几张卡片、弧要多宽才不互相压住"，于是有了
 * `planPin` 的两轮（广度 → 深度）、逐对相交检测、`clampRect` 兜底、`badgeRect` 避让。
 * 新形态的标记是**贴着钉子的固定小簇**（最宽 21.8pt，见 `pinMarkers`），
 * 它的位置与画布大小**无关** —— 没有"放不下"这回事，所以整段空间复核连同它的
 * 全部理由一起删掉了。这不是"简化了判据"，而是那个问题在新形态下不存在。
 *
 * `zoom` 非有限值或 ≤ 0 时按 1 处理：`computeLayout` 里是 `zoom < 阈值` 的比较，
 * 让 NaN 直接进去会得到"false → 展开"，那是**静默的错误展开**；在入口处归一更诚实。
 *
 * ── 坐标系 ──────────────────────────────────────────────────────────────────
 * 投影用 `frame.w / frame.h`（不变形的框），出来的坐标**再加上 `frame.x / frame.y`**，
 * 于是 `ScenePin.x/y` 落在**整块画布（地图块）的坐标**里 —— 与 `outlinePath` 的输出
 * 同一个坐标系（`ScenePin.x/y` 现在也保证是**有限数**：见下面两次 `projectMercator`
 * 之后的校验）。
 *
 * ── 投影用哪个 bounds：**只从框上读**（修的是"照片与国界各画各的"）──────────────
 * `const fb = frameBounds(frame)`，两次 `projectMercator` 都用它。以前这里写的是
 * 模块常量 `CHINA_BOUNDS`，而 `outlinePath` 收一个**自己的** bounds 参数 ——
 * 一旦调用方给国界传了新视野、这里还按全国投，照片就会整体飘到地图外面，
 * 而且两个函数都不报错（正是最该避免的失败）。现在两处都读 `frame.bounds`，
 * 参数根本没机会不一致。
 */
export function buildScene(photos: WallPhoto[], frame: MapFrame, zoom: number): ScenePin[] {
  const z: number = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // 视野框：**唯一**来源是框自己（见 frameBounds 与 MapFrame.bounds）。国界那边读的是同一个。
  const fb: number[] = frameBounds(frame);
  // 1) 筛 + 去重（用 Map 当集合：ArkTS 下 Map 是本仓库已验证的写法）
  const usable: WallPhoto[] = [];
  const seen: Map<string, boolean> = new Map<string, boolean>();
  for (let i = 0; i < photos.length; i++) {
    const p: WallPhoto = photos[i];
    if (p === undefined || p === null) { continue; }
    if (!hasPlace(p)) { continue; }
    if (seen.has(p.photoId)) { continue; }
    seen.set(p.photoId, true);
    usable.push(p);
  }

  // 2) 分组：key = 显示名
  const groupKeys: string[] = [];
  const groups: Map<string, WallPhoto[]> = new Map<string, WallPhoto[]>();
  for (let i = 0; i < usable.length; i++) {
    const name: string = pinNameOf(usable[i]);
    const arr: WallPhoto[] | undefined = groups.get(name);
    if (arr === undefined) {
      groups.set(name, [usable[i]]);
      groupKeys.push(name);
    } else {
      arr.push(usable[i]);
    }
  }

  // 3) 每个分组 → 一个待定钉子（位置 = 组内坐标中位数）
  const placed: PlacedPin[] = [];
  for (let i = 0; i < groupKeys.length; i++) {
    const arr: WallPhoto[] | undefined = groups.get(groupKeys[i]);
    const list: WallPhoto[] = arr === undefined ? [] : arr;
    const pts: GeoPoint[] = [];
    for (let j = 0; j < list.length; j++) {
      pts.push({ lat: list[j].lat, lon: list[j].lon });
    }
    const mid: GeoPoint = medianPoint(pts);
    const proj = projectMercator(mid.lon, mid.lat, frame.w, frame.h, fb);
    placed.push({ pinId: groupKeys[i], x: r2(proj.x + frame.x), y: r2(proj.y + frame.y) });
  }

  // 4) 屏幕聚簇：≤ MIN_PIN_DIST_PT 的钉子并成一个
  const clusters: number[][] = clusterByScreen(placed, MIN_PIN_DIST_PT);
  const merged: PlacedPin[] = [];
  const mergedNames: string[] = [];
  const mergedCounts: Map<string, number> = new Map<string, number>();
  const mergedPhotos: WallPhoto[][] = [];

  for (let c = 0; c < clusters.length; c++) {
    const idx: number[] = clusters[c];
    // 簇内"照片最多的那个"当作簇名；并列时取名字字典序小的（保证可复现）
    let win: number = idx[0];
    for (let k = 1; k < idx.length; k++) {
      const a: WallPhoto[] | undefined = groups.get(groupKeys[idx[k]]);
      const b: WallPhoto[] | undefined = groups.get(groupKeys[win]);
      const an: number = a === undefined ? 0 : a.length;
      const bn: number = b === undefined ? 0 : b.length;
      if (an > bn) { win = idx[k]; continue; }
      if (an === bn && groupKeys[idx[k]] < groupKeys[win]) { win = idx[k]; }
    }
    const winName: string = groupKeys[win];
    const all: WallPhoto[] = [];
    const winPts: GeoPoint[] = [];
    for (let k = 0; k < idx.length; k++) {
      const arr: WallPhoto[] | undefined = groups.get(groupKeys[idx[k]]);
      const list: WallPhoto[] = arr === undefined ? [] : arr;
      for (let j = 0; j < list.length; j++) {
        all.push(list[j]);
        if (idx[k] === win) { winPts.push({ lat: list[j].lat, lon: list[j].lon }); }
      }
    }
    all.sort(comparePhotos);
    // 簇的位置取**得胜那一组自己的中位数**，不是全簇的中位数。
    // 理由：并簇的成因是"屏幕上挤不下"，而簇名报的是得胜那一组的地名。
    // 若用全簇中位数，钉子的落点会跑到一个**没有任何照片的地方**
    //（长三角并簇时它落在上海与杭州之间，名字却写着"上海"）—— 那是对"照片在哪拍的"
    // 说了一句假话。取中位数落在有一半照片的地方，名字与位置才对得上。
    const mid: GeoPoint = medianPoint(winPts);
    const proj = projectMercator(mid.lon, mid.lat, frame.w, frame.h, fb);
    const name: string = idx.length > 1 ? `${winName}等${idx.length}地` : winName;
    merged.push({ pinId: winName, x: r2(proj.x + frame.x), y: r2(proj.y + frame.y) });
    mergedNames.push(name);
    mergedCounts.set(winName, all.length);
    mergedPhotos.push(all);
  }

  // 5) 展开态：阈值只在 placement.ts 里定义
  const layout = computeLayout(merged, mergedCounts, z);
  const expandedOf: Map<string, boolean> = new Map<string, boolean>();
  for (let i = 0; i < layout.length; i++) {
    expandedOf.set(layout[i].pinId, layout[i].expanded);
  }

  // 6) 标记：**没有空间复核**（见函数注释）。标记的位置与画布大小无关 ——
  //    它是"贴着钉子的固定小簇"（`pinMarkers`），所以本步只是把点算出来。
  //    张数超过 MAX_MARKERS 的部分不在这里处理：绘制方按 `photos.length − markers.length`
  //    画「＋N」—— 这个减法只有一处，不会两边各算一遍。
  const out: ScenePin[] = [];
  for (let i = 0; i < merged.length; i++) {
    const flag: boolean | undefined = expandedOf.get(merged[i].pinId);
    const expanded: boolean = flag === true;
    const pin: ScenePin = {
      pinId: merged[i].pinId,
      name: mergedNames[i],
      x: merged[i].x,
      y: merged[i].y,
      photos: mergedPhotos[i],
      expanded: expanded,
      markers: expanded ? pinMarkers(mergedPhotos[i].length) : []
    };
    out.push(pin);
  }
  out.sort(comparePins);
  return out;
}

// ── 中国轮廓：解析与转成绘制命令 ────────────────────────────────────────────

/**
 * 解析轮廓 JSON 文本。**不抛错**（与 areaData 的契约一致）：
 * 形状不符时返回 `undefined`，调用方退化成"只有钉子和线、没有国界"的墙，
 * 而不是白屏。校验到"每个 ring 是长度 ≥ 6 的偶数长度数组、元素全是有限数"这一层 ——
 * 这是"绘制命令生成器不会产出 NaN 坐标"的充分条件（NaN 会让整条 path 消失，
 * 而 SVG 不会报错，症状是"地图不见了"这种最难查的静默失败）。
 *
 * `bounds` 只是**带出来的元信息**（校验到"4 个有限数"为止，否则退回全国），
 * **不参与投影** —— 投影读的是 `frame.bounds`（见 `OutlineData.bounds` 与 `outlinePath`）。
 */
export function parseOutline(text: string): OutlineData | undefined {
  if (text === undefined || text === null || text.length === 0) { return undefined; }
  let raw: OutlineData;
  try {
    raw = JSON.parse(text) as OutlineData;
  } catch (e) {
    return undefined;
  }
  if (raw === undefined || raw === null) { return undefined; }
  if (!Array.isArray(raw.rings) || raw.rings.length === 0) { return undefined; }
  const clean: number[][] = [];
  for (let i = 0; i < raw.rings.length; i++) {
    const ring: number[] = raw.rings[i];
    if (!Array.isArray(ring)) { continue; }
    if (ring.length < 6 || ring.length % 2 !== 0) { continue; }
    let ok: boolean = true;
    for (let j = 0; j < ring.length; j++) {
      if (!Number.isFinite(ring[j])) { ok = false; break; }
    }
    if (!ok) { continue; }
    clean.push(ring);
  }
  if (clean.length === 0) { return undefined; }
  const bounds: number[] = normalizeBounds(raw.bounds);
  const out: OutlineData = {
    v: raw.v === undefined ? '' : raw.v,
    src: raw.src === undefined ? '' : raw.src,
    license: raw.license === undefined ? '' : raw.license,
    bounds: bounds,
    rings: clean
  };
  return out;
}

/**
 * 轮廓 rings → 一条绘制命令的 `d`（也是 ArkUI `Path().commands()` 的字符串）。
 *
 * 每个 ring 一条 `M … L … L … Z` 子路径（**复用同一条 path**：省掉 N 个 path 元素，
 * 也让 ArkUI 侧只需要一个 Path 组件）。相邻点重复时跳过（相邻重复点在 SVG 里是无用点，
 * 简化后会出现）；坐标保留 2 位小数控制体积。
 * 数据为空时返回空串（调用方据此跳过绘制，而不是画一条空 path）。
 *
 * ── 坐标：投影到**绘制框**（`frame.w × frame.h`）后整体平移 `(frame.x, frame.y)` ──
 * 于是输出的坐标与 `buildScene` 的钉子坐标在**同一个坐标系**里（地图块坐标）：
 * 设备侧可以直接把国界与钉子放进同一个 `Shape`/`Stack`，不需要各自摆位置。
 *
 * ── 投影用哪个 bounds：`frame.bounds`，**没有第三个参数**（本批改的）──────────────
 * 以前这个函数收一个 `bounds` 参数，与 `buildScene` 内部写死的 `CHINA_BOUNDS` 是两份来源 ——
 * 视野改成"按数据求"之后，那两份一定会分叉（照片用新视野、国界用全国），
 * 症状是**照片整体飘到地图轮廓之外**，而且两边都不报错。
 * 现在签名里根本没有这个参数：`frameBounds(frame)` 是唯一读法，
 * "国界与照片用同一个 bounds"因此在类型层面就成立，不靠调用方守规矩。
 *
 * ── 视口裁剪：整个落在**绘制框**之外的环**不产出子路径** ────────────────────────
 * 为什么需要：`china_outline.json` 的 `bounds` 与 `CHINA_REGION.bounds` 一致，
 * 而它的 `minLat = 18` —— 南海诸岛在 8~11.4°N，投影后落在绘制框**下方**。
 * 不裁的话它们会飘到挂照片的区域里，看着像脏点。数据里一条都没删（96 条环全在文件里），
 * 这里只是**视口剔除**：屏幕外的东西不画。
 * 放大到"几个邻近城市"那一档时，被剔除的环会明显变多（新疆/西藏/南海都在视野外）——
 * 这是**预期后果**，取舍写在报告的"放大后国界可能整条在视野外"一节。
 *
 * ⚠️ 判据是**绘制框**（`frame.x/y/w/h`），不是**地图块**（`frame.blockW/blockH`）——
 *   这是 task-17 改的一处（原来按块判）。两者的区别在框**装不满**块时才出现：
 *   框比块矮一截时（"框 ⊆ 中国"之后**全国视野就是这样**：376×279.62 居中在 376×642.57），
 *   南海诸岛投影在框下方却**仍在块内**，按块判就一条都剔不掉 ——
 *   它们会飘进框下面那条留白里，正好是这段裁剪想消灭的"脏点"。
 *   设备与预览都一样：设备侧的 `.clip(true)` 挂在**块**上（`WallPage` 最外层那个 Stack），
 *   不是挂在框上，所以框外的子路径是真会被画出来的。
 *   按框判之后，框 == 块的那些情形（`--flat`、比例正好匹配时）行为**逐字不变**。
 *
 * 剔除的粒度是**整条环**：只要一条环有任何一点在框内就整条画出来。放大之后，
 * 中国轮廓那条主环会横跨整个视野（环上大多数点在框外、但少数点在框内），
 * 于是它的子路径被保留、由调用方按框裁剪（设备侧是容器的 `.clip(true)`）——
 * 结果是"视野附近的海岸线会露出来"，这是好事，不是缺陷。
 */
export function outlinePath(rings: number[][], frame: MapFrame): string {
  if (rings === undefined || rings === null || rings.length === 0) { return ''; }
  const b: number[] = frameBounds(frame);
  // 视口 = 绘制框在**块坐标**里的矩形（子路径的坐标已经按 frame.x/frame.y 平移过，同一坐标系）
  const vx0: number = frame.x;
  const vy0: number = frame.y;
  const vx1: number = frame.x + frame.w;
  const vy1: number = frame.y + frame.h;
  const parts: string[] = [];
  for (let i = 0; i < rings.length; i++) {
    const ring: number[] = rings[i];
    if (ring === undefined || ring === null || ring.length < 6) { continue; }
    let d: string = '';
    let px: number = Number.NaN;
    let py: number = Number.NaN;
    let minX: number = Number.POSITIVE_INFINITY;
    let maxX: number = Number.NEGATIVE_INFINITY;
    let minY: number = Number.POSITIVE_INFINITY;
    let maxY: number = Number.NEGATIVE_INFINITY;
    for (let j = 0; j + 1 < ring.length; j += 2) {
      const p = projectMercator(ring[j], ring[j + 1], frame.w, frame.h, b);
      const x: number = r2(p.x + frame.x);
      const y: number = r2(p.y + frame.y);
      if (x < minX) { minX = x; }
      if (x > maxX) { maxX = x; }
      if (y < minY) { minY = y; }
      if (y > maxY) { maxY = y; }
      if (x === px && y === py) { continue; }
      px = x;
      py = y;
      d += (d.length === 0 ? 'M' : 'L') + x + ' ' + y;
    }
    if (d.length === 0) { continue; }
    // 整条在**绘制框**外 → 丢掉这条子路径（视口剔除，不是删数据）
    if (maxX < vx0 || minX > vx1 || maxY < vy0 || minY > vy1) { continue; }
    parts.push(d + 'Z');
  }
  return parts.join('');
}

// ── 省级边界：与国界同一条 path 机制，只换颜色与线宽 ──────────────────────────
//
// 用户原话：「还有地图至少要有省级划分的边界线 现在整个地图都是一片」。
// 数据在 `resources/rawfile/china_provinces.json`（34 个省级行政区、107 环，见
// `tools/build-provinces.ts` 与 THIRD_PARTY_NOTICES.md 第 3 节），形状与国界**完全一样**
// （`OutlineData` 的 `{v,src,license,bounds,rings}`），所以：
//   · 解析复用 `parseOutline`（同一套校验，包括"环必须是 ≥6 的偶数长度有限数数组"）；
//   · 生成 path 复用 `outlinePath`（同一套投影 + 视口剔除 + 2 位小数 + `frame.bounds`）；
//   · **本模块没有为省界新写任何一个几何函数** —— 需要区分的只有颜色和线宽这两件事，
//     那就是下面这两个常量。
//
// 这两个常量放在 core 里（而不是各写一份在 WallPage 与预览里）的理由与 `TRACK_COLOR`
// 完全相同：两边写死同一个字符串不会漂，而"预览细一点、设备粗一点"这种差异会让
// "在电脑上先看见"这件事打折扣。

/**
 * 省级界线的颜色。
 *
 * ── 取值与**为什么与国界同色**（这是实测调出来的，不是配色偏好）──────────────────
 *   国界的描边是 `#BFD3B8`。省界一开始用了一档更浅的 `#CBDCC4`（想靠"更淡"来分主次），
 *   渲染出来**太淡了**：在 376×663.71pt 的真机尺寸下，内陆的分省线几乎看不出来 ——
 *   那正是用户抱怨的那个"整个地图都是一片"，等于没修。
 *   改成本常量（**与国界同一个 `#BFD3B8`**）之后，主次关系改由**线宽**表达
 *   （`PROVINCE_WIDTH` 0.5 vs 国界 0.8，见下），颜色不再承担"分主次"的职责。
 *   同色还有两个附带好处：
 *     · 沿海省份的界线与海岸线**重合**时不会出现两种深浅叠在一起的毛边；
 *     · 与暖赭的轨迹（`#D08A46`）和照片卡片在色相上天然分得开（冷绿 vs 暖赭）。
 */
export const PROVINCE_STROKE = '#BFD3B8';

/**
 * 省级界线的线宽（pt）：**国界（0.8）的 0.63 倍**。
 *
 * 0.5 是"看得见"与"不织成一张网"之间的取值：3 倍屏上是 1.5px。
 * 一开始取 0.4（国界的一半）时同样偏细，配合上面那个更浅的颜色几乎消失 ——
 * 所以线宽和颜色是**一起**调上来的，两个数字要一起看。
 *
 * 这也是"放大 9.5 倍时省界必须仍然清晰"的另一半答案（另一半是数据侧的容差 0.08pt，
 * 见 `tools/build-provinces.ts` 文件头）：**线宽不随缩放变化**，放大后线的粗细不变，
 * 而放大后被拉开的是线本身的**位置精度** —— 数据侧已经把它压到 0.76pt 的亚像素级。
 */
export const PROVINCE_WIDTH = 0.5;

// ── 旅行轨迹：钉子按时间连成一条折线 ────────────────────────────────────────

/**
 * 一个钉子的"时间" = 它下面**最早**那张有时间（`takenAt > 0`）的照片。
 *
 * 为什么取最早而不是最晚：轨迹回答的是"我什么时候**第一次**到这儿"，
 * 一条按"首次到达"连起来的线才是旅行的顺序感；用最晚会让"顺便又去了"的地方
 * 往后跳（例如出差途中路过一次上海，之后每次去上海都把上海推到线尾）。
 *
 * 全都没时间 → 返回 0（未知）。0 **不是**时间，见 `comparePhotos` 的同一条理由。
 */
export function pinTime(pin: ScenePin): number {
  let best: number = 0;
  for (let i = 0; i < pin.photos.length; i++) {
    const t: number = pin.photos[i].takenAt;
    if (!(t > 0)) { continue; }
    if (best === 0 || t < best) { best = t; }
  }
  return best;
}

/**
 * 旅行轨迹的钉子顺序：**时间正序**，时间未知（`pinTime === 0`）的排在**最后**，
 * 其中并列的按 `pinId` 字典序（保证同一份数据恒得同一条线，与输入顺序无关）。
 *
 * 与 `comparePhotos` 是同一套排序语义（未知时间排最后、并列按 id），只是作用在钉子上。
 * 返回**新的数组**，不动入参（`pins` 是调用方的场景，顺序有它自己的含义）。
 */
export function trajectoryOrder(pins: ScenePin[]): ScenePin[] {
  const out: ScenePin[] = pins.slice(0, pins.length);
  out.sort((a: ScenePin, b: ScenePin): number => {
    const ta: number = pinTime(a);
    const tb: number = pinTime(b);
    const az: boolean = !(ta > 0);
    const bz: boolean = !(tb > 0);
    if (az !== bz) { return az ? 1 : -1; }
    if (!az && ta !== tb) { return ta < tb ? -1 : 1; }
    if (a.pinId === b.pinId) { return 0; }
    return a.pinId < b.pinId ? -1 : 1;
  });
  return out;
}

/**
 * 轨迹折线的绘制命令 `'M…L…L…'`（画布坐标）。**一个钉子不成线** → 少于 2 个钉子返回空串。
 *
 * 这条线是"我走过哪里"的表达：把按时间排好的钉子依次连起来。
 * 它不是路线（真实路径当然不是直线），只是**时间顺序**；名字与图例都这么说，不夸大。
 */
export function trajectoryPath(pins: ScenePin[]): string {
  const o: ScenePin[] = trajectoryOrder(pins);
  if (o.length < 2) { return ''; }
  let d: string = '';
  for (let i = 0; i < o.length; i++) {
    d += (i === 0 ? 'M' : 'L') + r2(o[i].x) + ' ' + r2(o[i].y);
  }
  return d;
}

/** 轨迹线的颜色（暖赭）。与挂照片的线（`#C3B49B`）同色系但更深，一眼能分开。 */
export const TRACK_COLOR = '#D08A46';
/** 轨迹线的粗细（pt）。1.2 在 2 倍图上是 2.4px —— 看得见，但压不住 26pt 的卡片。 */
export const TRACK_WIDTH = 1.2;

// ── SVG 输出（Node 预览用；形状与设备侧的几何完全一致） ──────────────────────

/** XML 转义。地名里出现 `&`（"AT&T 大楼"这类）会把整份 SVG 变成解析错误 —— 必须转义。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * **地图块的底色**（`MapFrame.blockW × blockH` 那一整块）。
 * 设备侧 WallPage 的 `Stack` 底层用的是同一个字符串 —— 两边写死同一个常量不会漂，
 * 而"预览底是 `#F7FAF6`、设备底是 `#F2F7EF`"这种差异会让"在电脑上先看见"这件事打折扣。
 *
 * 本形态下它比以前更重要：地图铺满整块主体区，所以这**不是**"地图外面的一块底"，
 * 而是"地图自己"（海 + 视野内没有轮廓数据的地方）。旧版那张"卡片底色表"
 * （`CARD_FILLS` / `fillOf`）已随卡片一起删除 —— 墙上的照片现在是点，没有底色这回事。
 */
export const BLOCK_FILL = '#F2F7EF';

/** `takenAt` → 详情面板里的日期文字。0/负数 = 未知（**显示为"未知时间"而不是 1970-01-01**）。 */
export function dateLabel(takenAt: number): string {
  if (!(takenAt > 0)) { return '未知时间'; }
  const iso: string = new Date(takenAt).toISOString();
  return iso.substring(0, 10);
}

/**
 * 场景 → 一份**可以直接在浏览器里打开**的 SVG 字符串。
 *
 * `chinaPath` 是已经投影好的国界 `d`（由 `outlinePath` 产出；传空串则只画钉子和照片）。
 * `scale` 只影响 SVG 的 width/height 属性（viewBox 不变）：预览时传 2 就得到一张 2 倍图，
 * **几何一点没变** —— 屏幕上量到的相对位置与 pt 坐标一一对应。
 *
 * **照片画的是占位卡片，不是真实图片**：Node 侧拿不到相册像素（那是设备侧的事）。
 * 卡片底色随机但确定、上面写着拍摄日期，用来核对"哪张挂在哪儿"。
 * 真实缩略图由设备侧 WallPage 用 `Image(uri)` 画在**同一个坐标**上。
 *
 * ── 图层顺序（由下到上，改这里之前先想清楚谁压谁）────────────────────────────
 *   ① 底 `#F2F7EF`（**地图块的底色**，与设备侧 Stack 的底色逐字节相同 —— 地图铺满主体区）
 *   → ② 国界（调用方传进来的 `chinaPath`）→ ②′ **省界**（`provincePath`）
 *   → ③ **轨迹折线** → ④ **照片标记**（钉子旁那一簇小点 + 「＋N」）
 *   → ⑤ 钉点与地名（单独一层，永远在最上面）。
 * 轨迹放在地图之上、标记之下：它是"我走过哪里"的背景叙事，压住标记就成了噪声。
 *
 * ── 省界为什么必须画在国界**之后**（而不是之前、也不是同一层）────────────────────
 *   国界那一层不是一条线，而是一个**填充面**（`fill="#E8F0E4"` + `stroke`）：陆地是浅绿、
 *   海是底色。省界是陆地**内部**的线，画在填充之前会被那块填充**整个盖掉** ——
 *   症状是"数据明明有 107 条环，图上一条都看不见"。所以顺序只能是 填充 → 省界线。
 *   同理它必须在**轨迹与标记之前**：省界是底图信息，不是内容。
 *
 * ── 本形态下 SVG 里**没有照片卡片**（task-18）────────────────────────────────
 *   Node 侧拿不到相册像素，旧版画的是"占位卡片"（26×34 的矩形 + 日期文字）。
 *   现在照片在墙上就是**一个点**，所以 SVG 里也不该有卡片：
 *   点（`<circle>`）+ 「＋N」（`<text>`）—— 与设备侧画的东西**逐个元素对得上**。
 *   大图在「点开钉子」的详情面板里（设备侧的 `Image`，那部分 Node 侧本来就看不到）。
 *
 * `provincePath` 缺省 = 空串 = 不画省界（没有那份 rawfile 时的退化路径，与国界一致）。
 */
export function sceneToSvg(pins: ScenePin[], w: number, h: number, chinaPath: string, scale?: number,
  provincePath?: string): string {
  const s: number = scale === undefined || !(scale > 0) ? 1 : scale;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w * s)}" height="${r2(h * s)}" `
    + `viewBox="0 0 ${r2(w)} ${r2(h)}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">`);
  // 底色 = 地图块的底色。设备侧 WallPage 的 Stack 底也是这个颜色（`#F2F7EF`），
  // 所以"预览里看到的"与"真机上看到的"是同一个底色 —— 预览不是示意图，是同一张图。
  out.push(`<rect x="0" y="0" width="${r2(w)}" height="${r2(h)}" fill="${BLOCK_FILL}"/>`);
  if (chinaPath !== undefined && chinaPath !== null && chinaPath.length > 0) {
    out.push(`<path d="${escapeXml(chinaPath)}" fill="#E8F0E4" stroke="#BFD3B8" `
      + `stroke-width="0.8" stroke-linejoin="round" fill-rule="evenodd"/>`);
  }
  // ②′ 省界：**必须在国界的填充之后**（见函数注释"省界为什么必须画在国界之后"）。
  // fill="none"：它是线，不是面 —— 数据里的环有外环也有内环（岛礁），
  // 填充它们会在陆地上挖出一堆洞；省界只画线。
  if (provincePath !== undefined && provincePath !== null && provincePath.length > 0) {
    out.push(`<g id="provinces">`);
    out.push(`<path d="${escapeXml(provincePath)}" fill="none" stroke="${PROVINCE_STROKE}" `
      + `stroke-width="${PROVINCE_WIDTH}" stroke-linejoin="round"/>`);
    out.push(`</g>`);
  }
  // 轨迹折线：由 pins 自己算（调用方不用多传一个参数，设备与预览就不可能忘了画）
  const track: string = trajectoryPath(pins);
  if (track.length > 0) {
    out.push(`<g id="trajectory">`);
    out.push(`<path d="${track}" fill="none" stroke="${TRACK_COLOR}" stroke-width="${TRACK_WIDTH}" `
      + `stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`);
    out.push(`</g>`);
  }
  out.push(`<g id="pins">`);
  for (let i = 0; i < pins.length; i++) {
    out.push(pinSvg(pins[i]));
  }
  out.push(`</g>`);
  // 钉点与地名**单独一层、画在标记之上**。
  // 为什么必须是单独一层：钉子和标记分属不同元素，按"钉子顺序"整块画下来时，
  // 后面那个钉子的标记会盖住前面那个钉子的名字。钉子是这个视图的**锚点**，
  // 它绝不能被标记盖住 —— 用户点它才能看到全部照片。
  out.push(`<g id="anchors">`);
  for (let i = 0; i < pins.length; i++) {
    out.push(pinAnchorSvg(pins[i]));
  }
  out.push(`</g>`);
  out.push(`</svg>`);
  return out.join('\n');
}

/**
 * 单个钉子的**标记**层：钉子旁那一簇小点 + 不够画时的「＋N」。
 * **不画钉点和名字**（那是 anchors 层的事）。
 *
 * 画几个、画在哪儿，一律读 `pin.markers` —— 那是 `buildScene` 调的 `pinMarkers`
 * 算出来的。这里**不再自己算一遍**：绘制方与场景方各算一遍，迟早会漂移成
 * "算的时候贴着一个地方、画出来在另一个地方"（旧版 `arcSpread` 就是这个坑）。
 */
function pinSvg(pin: ScenePin): string {
  const out: string[] = [];
  const cx: number = pin.x;
  const cy: number = pin.y;
  const n: number = pin.photos.length;
  const ms: PinMarker[] = pin.markers;
  out.push(`<g id="pin-${escapeXml(pin.pinId)}">`);
  for (let k = 0; k < ms.length; k++) {
    out.push(`<circle cx="${r2(cx + ms[k].dx)}" cy="${r2(cy + ms[k].dy)}" r="${MARKER_R}" `
      + `fill="${MARKER_COLOR}"/>`);
  }
  if (n > ms.length) {
    // 「＋N」：右下方，右缘与最右那个标记对齐（位置由 badgeRectOf 一处给出，
    // 单测与设备侧读的是同一个函数）。
    const b: Rect = badgeRectOf(pin, ms);
    out.push(`<text x="${r2(b.x + b.w / 2)}" y="${r2(b.y + b.h - 1.4)}" font-size="6" fill="#8A8A8A" `
      + `text-anchor="middle">+${n - ms.length}</text>`);
  }
  out.push(`</g>`);
  return out.join('\n');
}

/** 单个钉子的**锚点**层：钉点（可点到）+ 地名标签（带该钉子的全部张数）。 */
function pinAnchorSvg(pin: ScenePin): string {
  const out: string[] = [];
  const cx: number = pin.x;
  const cy: number = pin.y;
  const n: number = pin.photos.length;
  out.push(`<g id="anchor-${escapeXml(pin.pinId)}">`);
  // 钉点是**主角**（标记是内容、钉是锚），所以半径恒定：它不再随"挂了几张"变。
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${PIN_DOT_R}" fill="${PIN_COLOR}"/>`);
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${PIN_HALO_R}" fill="none" `
    + `stroke="#C0392B" stroke-width="0.6" opacity="0.4"/>`);
  // 名字标签：放在钉子上方（下方是标记簇的地盘），**带该钉子的全部张数**。
  // 「还有几张没画成点」由右下角那个 `+N` 负责说 —— 这里不再重复，避免标签变长后在
  // 密集处（京沪只差 29pt）两条标签互相压住。文字描边（paint-order）保证压在省界/轨迹
  // 上也读得清。
  const label: string = n > 1 ? `${pin.name} ·${n}` : pin.name;
  out.push(`<text x="${r2(cx)}" y="${r2(cy - PIN_HALO_R - 2.2)}" font-size="6.5" fill="#3F4A3C" `
    + `stroke="#F7FAF6" stroke-width="1.4" paint-order="stroke" `
    + `text-anchor="middle">${escapeXml(label)}</text>`);
  out.push(`</g>`);
  return out.join('\n');
}
