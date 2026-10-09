/**
 * 地图墙的场景计算：把「已上墙的照片」算成「钉子 + 挂在钉子上的照片」。
 *
 * ── 这个模块回答什么 ────────────────────────────────────────────────────────
 *   输入：一份带坐标的照片列表（来自 data/locationIndex 的 LocationEntry）；
 *   输出：**屏幕坐标下的钉子和挂着的照片**（ScenePin[]），以及可直接绘制的 SVG。
 *   它不认识 ArkUI、不读文件、不 import 任何 @kit.*：Node 单测与
 *   tools/render-preview.ts 用的是**同一个函数**，设备侧 WallPage 也是。
 *   —— 这是"照片挂在地图上长什么样"能在电脑上先看见的前提。
 *
 * ── 复用了什么（刻意不重写） ────────────────────────────────────────────────
 *   · geo.hasPlace             —— 「这张照片有没有地点」的**唯一定义**（手动 > EXIF；
 *                                 (0,0) 不算，除非 manual === true）。本模块不另立一套判断。
 *   · placePick.formatPlace    —— 地点显示名的**唯一产出者**（「河北·石家庄·正定」）。
 *   · areaData.nearestCounty   —— EXIF 条目没有 place 时反查最近的县，**退化路径**。
 *   · geo.medianPoint          —— 一个钉子下多张照片取中位数定位（对离群点比平均值稳）。
 *   · projection.projectMercator + CHINA_REGION.bounds —— 经纬度 → 画布坐标。
 *   · placement.clusterByScreen / computeLayout / MAX_HANG / MIN_PIN_DIST_PT
 *                              —— §6.2 的「自适应聚散」阈值**只在 placement.ts 里定义**，
 *                                 本模块只负责把照片喂进去、把结果翻译成绘图语义。
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
import { MAX_HANG, MIN_PIN_DIST_PT, clusterByScreen, computeLayout } from './placement.ts';
import type { PlacedPin } from './placement.ts';
import { CHINA_REGION, projectMercator } from './projection.ts';

/**
 * CHINA_REGION 的 bounds。**不在这里另写一份数字** —— 那迟早会与 projection.ts 漂移。
 * 取值仍是 `[73, 18, 135, 54]`（西沙以西到黑龙江以东、南沙以北到漠河）。
 */
const CHINA_BOUNDS: number[] = CHINA_REGION.bounds;

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

/** 给定画布宽度，返回**不变形**的地图高度（pt）。地图占屏幕上方这一块，下方留给挂照片。 */
export function mapBoxHeight(width: number, bounds: number[]): number {
  const a: number = geoAspect(bounds);
  if (!(width > 0) || !(a > 0)) { return 0; }
  return width / a;
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
 * 一个钉子 + 它挂着的照片（`photos` 是**全部**照片，不受 MAX_HANG 截断）。
 *
 * `expanded` / `shown` / `spread` 三者的分工（**这是本模块最容易改错的地方**）：
 *   · `expanded`  —— placement.computeLayout 按（钉数、每钉张数、zoom）给的**意愿**（§6.2）；
 *   · `shown`     —— 空间**允许**真正挂出来的张数（≤ min(photos.length, MAX_HANG)）；
 *   · `spread`    —— 真正用的弦宽。绘制方**直接用它**，不要自己再算一遍
 *                   （自己算就会与布局判据漂移，症状是"算的时候不重叠、画出来重叠"）。
 * 空间只能**否决**意愿，不能凭空让一个钉子展开：`shown > 0` 必然蕴含 `expanded === true`。
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
  /** 按 placement.computeLayout 的规则算出的展开态（§6.2）。 */
  expanded: boolean;
  /** **实际挂出的张数**（0 = 收成点）。`photos.length - shown` 就是画成「+N」的那个 N。 */
  shown: number;
  /** **实际弦宽**（pt）。`shown === 0` 时为 0。 */
  spread: number;
}

/** 一张照片相对钉子的挂点偏移（pt）。`dy` 恒 > 0 —— 照片在钉子**下方**。 */
export interface HangOffset { dx: number; dy: number }

/** 卡片矩形（画布坐标，pt）：左上角 + 宽高。 */
export interface CardRect { x: number; y: number; w: number; h: number }

/** 钳制结果：`rect` 是钳好的矩形，`moved` 表示它**真的被挪动过**（弧被钳变形了）。 */
export interface ClampedRect { rect: CardRect; moved: boolean }

/**
 * 画布分区里的**挂载区**。
 *
 * `buildScene` 的 `w/h` 描述的是**地图块**（钉子投影的范围，高 = `mapBoxHeight` 那个
 * 不变形的值）。照片可以挂到地图块**下面**去 —— 这个参数告诉布局"画布到底有多高"。
 *
 * 不给 = 画布就是地图块本身（画布高 = h）。**这不是"没有约束"**，而是"地图下面没有余量"：
 * 于是只有塞得进地图块内部的钉子会展开，其余收成点。宁可收成点，也不要画到画布外面。
 */
export interface HangEnvelope {
  /** 画布高（pt）。小于地图块高时按地图块高处理（不能比地图还矮）。 */
  canvasH: number;
  /** 页脚高度（pt）：卡片底边不得越过 `canvasH - footer`（图例/按钮的地盘）。缺省 0。 */
  footer?: number;
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
  /** [minLon, minLat, maxLon, maxLat]，与 CHINA_REGION.bounds 同义（允许不同）。 */
  bounds: number[];
  rings: number[][];
}

// ── 排布常数（钉子的视觉尺寸只有这里一份，设备与预览共用） ──────────────────

/** 一张挂着的照片卡片的宽（pt）。 */
export const HANG_PHOTO_W = 34;
/** 一张挂着的照片卡片的高（pt）。 */
export const HANG_PHOTO_H = 44;
/** 钉子到卡片顶端弧线的竖直留白（pt）——「线」的可见长度就是这个量级 + 弧形下坠。 */
export const HANG_GAP = 18;
/**
 * 弧形张角（**总**张角，弧度）。取 110°（±55°）。
 *
 * 为什么是"总张角"而不是"半径"：设计 §6.1 要的是**扇形/弧形**展开（"垂直线会像鱼线，
 * 弧线才像风铃"）。一个扇形由「弦宽 + 张角」唯一确定 —— 弦宽由张数决定（见 arcSpread），
 * 张角是视觉参数：张角越大，弧越"摊平"（下坠越浅）；越小越像一根竖线。
 * 110° 是让两侧照片明显外斜、又都还朝下的一个取值（55° 时卡片仍在钉子下方）。
 */
export const HANG_SWEEP_RAD = 1.9198621771937625;   // 110° * PI / 180

/** 同一个钉子上相邻卡片的水平步距（pt）——决定弧形要多宽才不互相压住。 */
const HANG_STEP_W = HANG_PHOTO_W * 0.86;

/**
 * 弧上相邻两张卡片之间的最小**净间隙**（pt）。
 *
 * 为什么必须有这一点点余量：按几何等式算出来的弦宽会让最外那两张**刚好贴住**
 *（`|Δx|` 恰好等于卡宽）。贴住不是重叠，但它是一条刀刃上的平衡 ——
 * 绘制时坐标会四舍五入到 2 位小数（`r2`），1e-14 的浮点差足以让"贴住"翻成"重叠 1e-13pt²"。
 * 留 0.5pt 之后，四舍五入再也不影响判定，而且两张卡片之间有一条肉眼可见的发丝缝，更好看。
 */
const HANG_CARD_CLEARANCE = 0.5;

/**
 * `count` 张照片不**自相重叠**所需的**最小**弦宽（pt）。`count <= 1` 时返回 0（没有相邻对）。
 *
 * ── 为什么需要这个下限（这是修掉的一处真缺陷） ──────────────────────────────
 * 原来只用 `(count−1) * HANG_STEP_W` 这个"**水平**步距"估弦宽。但卡片是挂在**弧**上的：
 * 相邻两张的位移是 `(弦长·cos t, 弦长·sin t)`，`t` 是这一对中点在弧上的法线倾角。
 * 弧两端的 `t` 接近 ±55°，`cos 55° = 0.574` —— **水平间距会缩到 57%**。
 * 于是 `count ≥ 6` 时"公式算出来的弦宽"必然让两侧的卡片压在一起（实测：k=6 时
 * 相邻两张只差 31.05pt，卡片宽 34pt）。这不是调常数能解决的，是**公式少了一项几何**。
 *
 * 推导（两张 34×44 的轴对齐矩形不相交 ⟺ 水平间距 ≥ 34 **或** 竖直间距 ≥ 44）：
 *   弦长 = `2R·sin(φ/2)`，`R = (弦宽/2)/sin(张角/2)`，`φ = 张角/(count−1)`；
 *   最外侧那一对的倾角 `t = 张角/2 − φ/2`（|t| 最大 → 最紧）；
 *   要 `弦长·cos t ≥ 宽` 或 `弦长·sin t ≥ 高`，取**较容易满足**的那一条：
 *   `弦长 ≥ min(宽/cos t, 高/sin t)`（`t = 0` 时后者为无穷 → 只剩水平那一条，正确）。
 * 单测用**穷举相邻对**的方式钉住它（不重抄公式）。`planPin` 里还有一道逐对精确检测兜底。
 */
export function arcSpreadNeed(count: number): number {
  if (!(count > 1)) { return 0; }
  const half: number = HANG_SWEEP_RAD / 2;
  const step: number = HANG_SWEEP_RAD / (count - 1);
  const tilt: number = half - step / 2;
  const needX: number = (HANG_PHOTO_W + HANG_CARD_CLEARANCE) / Math.cos(tilt);
  const sinT: number = Math.sin(tilt);
  const needY: number = sinT > 1e-9 ? (HANG_PHOTO_H + HANG_CARD_CLEARANCE) / sinT : Number.POSITIVE_INFINITY;
  const chord: number = Math.min(needX, needY);
  const s: number = chord * Math.sin(half) / Math.sin(step / 2);
  return Number.isFinite(s) ? s : 0;
}

/**
 * 弧形弦宽（pt）：`count` 张照片呈扇形展开时，最左到最右的水平跨度。
 *
 * 取**两者之大**：`(count−1)·水平步距`（视觉上"张数越多线越长"）与
 * `arcSpreadNeed`（几何上"相邻卡片不许压住"的硬下限，见它的注释）。
 *
 * `avail` 是可用宽度（画布宽）。上限取 `avail * 0.72`：留给左右边距，也让 9 张照片
 * 在手机上不至于把弧拉到贴边。下限是一张卡片的宽度，避免单张时弦宽为 0（那就退化成竖线了）。
 * **单调不减**：张数越多弧度越宽，是"线长随张数微调"的具体实现。
 *
 * 注意上限的后果（这是几何事实，不是缺陷）：360pt 宽的画布上 `0.72·360 = 259.2`，
 * 而 8 张需要 299.3、9 张需要 348.2 —— 所以**一屏最多挂 7 张**。
 * `MAX_HANG = 9` 仍是设计的硬上限，只是空间先一步把它压下来（少挂的用「+N」如实报出）。
 */
export function arcSpread(count: number, avail: number): number {
  const wide: number = Number.isFinite(avail) && avail > 0 ? avail * 0.72 : HANG_PHOTO_W * 3;
  const n: number = count > 0 ? count : 1;
  let raw: number = (n - 1) * HANG_STEP_W + HANG_PHOTO_W * 1.15;
  const need: number = arcSpreadNeed(n);
  if (need > raw) { raw = need; }
  const lo: number = HANG_PHOTO_W * 1.15;
  if (raw < lo) { return lo; }
  if (raw > wide) { return wide; }
  return raw;
}

/**
 * `n` 张照片挂在同一个钉子上的偏移序列：**等半径圆弧扇开**。
 *
 * 几何（这就是"弧形"的全部内容）：
 *   · 弦宽 `spread`、总张角 `HANG_SWEEP_RAD` → 半径 `R = (spread/2) / sin(张角/2)`；
 *   · 第 i 张的方位角 `θᵢ = (i/(n−1) − 0.5) * 张角`（**对称**，两端正好落在 ±张角/2）；
 *   · `dx = R·sin θᵢ`，`dy = R·cos θᵢ`。
 *
 * 为什么第 i 张取 `i/(n−1)` 而不是"每个格子的中心" `(i+0.5)/n`：后者的最外侧两张
 * 会各让出半格，实际跨度只有 `spread * sin(0.4·张角)/sin(0.5·张角) ≈ 0.85 * spread`
 * —— "传进去 200pt，画出来 170pt"，布局方（arcSpread 的钳制、画布边距）就没法按
 * 传入值算账。让两端**正好**落在 ±spread/2，`spread` 才是"最左到最右的水平跨度"
 * 这个字面意思（单测按这条钉住）。`n === 1` 时退化为正下方（θ=0），不是 0/0。
 *
 * 由此得到四个可核对的性质（单测逐条钉住）：
 *   1. **等半径**：所有点都在以钉子为圆心的圆上 → 线一样长，像风铃；
 *   2. **中间低、两侧高**：`dy` 在中间最大、两端最小（θ 越大 cos 越小），
 *      即照片沿一条**向下凸的弧**排列；若排成竖线则所有 dx 相同 —— 那不是本函数；
 *   3. **弦宽 = spread**：最外侧两张的 dx 差恰好是 spread；
 *   4. `dy` 恒为正：任何一张照片都在钉子下方，不会跑到钉子上面去。
 *
 * `spread <= 0` 或 `n <= 0` 时返回空数组（调用方按"不挂"处理），不抛错。
 */
export function hangOffsets(n: number, spread: number): HangOffset[] {
  const out: HangOffset[] = [];
  if (!(n > 0) || !Number.isFinite(spread) || spread <= 0) { return out; }
  const half: number = HANG_SWEEP_RAD / 2;
  const radius: number = (spread / 2) / Math.sin(half);
  for (let i = 0; i < n; i++) {
    // n === 1 时单列 → θ = 0（正下方）。n > 1 时两端正好是 ±张角/2。
    const t: number = n === 1 ? 0 : i / (n - 1) - 0.5;
    const theta: number = t * HANG_SWEEP_RAD;
    out.push({ dx: radius * Math.sin(theta), dy: radius * Math.cos(theta) });
  }
  return out;
}

// ── 卡片的矩形几何：布局判据、绘制、验收度量**共用这一份** ──────────────────

/**
 * 卡片与画布边之间要求的最小留白（pt）。
 * 为什么要留：卡片紧贴画布边时，边框描边（stroke-width 0.5）会被切掉一半，
 * 看起来像"被裁掉的照片"；同时给"钳制"留一点余量，避免浮点误差造成 0.01pt 的越界。
 */
export const HANG_EDGE_MARGIN = 4;

/**
 * 两张卡片算「重叠」的最小交集面积（pt²）。
 *
 * **这个数同时是布局的判据与验收的度量**（`tools/wall-audit.ts` 直接 import 它）。
 * 用同一个定义的两条理由：
 *   1. 布局说"不重叠"、度量说"重叠 7 对"这种自相矛盾，比缺陷本身更难查；
 *   2. 1pt² ≈ 一张卡片面积的 0.07%，在 2 倍图上不到 1px —— 肉眼不可见。
 *      用严格的 0 容忍会把浮点取整噪声当成缺陷，逼布局白白丢掉一张能挂的照片。
 */
export const HANG_OVERLAP_EPS = 1;

/** 「+N」角标的尺寸（pt）。它参与避让，所以是一个正式尺寸，不是画的时候随手定的。 */
const BADGE_W = 12;
const BADGE_H = 8;
/** 角标与弧线最低点的竖直间距（pt）。 */
const BADGE_GAP = 2;

/** 两张卡片矩形的交集面积（pt²）。不相交返回 0。 */
export function rectOverlapArea(a: CardRect, b: CardRect): number {
  const ox: number = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy: number = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (!(ox > 0) || !(oy > 0)) { return 0; }
  return ox * oy;
}

/**
 * 把一张矩形**钳进**画布 `[0, boxW] × [0, boxH]`。
 *
 * 画布比矩形还小（`boxW < r.w`）时钳到左上角并仍然报 `moved` —— 那种情况本身就不该被画出来，
 * 报 `moved` 能让调用方正确地"宁可收成点"。
 */
export function clampRect(r: CardRect, boxW: number, boxH: number): ClampedRect {
  const maxX: number = boxW - r.w;
  const maxY: number = boxH - r.h;
  const x: number = Math.max(0, Math.min(maxX, r.x));
  const y: number = Math.max(0, Math.min(maxY, r.y));
  const moved: boolean = Math.abs(x - r.x) > 1e-9 || Math.abs(y - r.y) > 1e-9;
  return { rect: { x: x, y: y, w: r.w, h: r.h }, moved: moved };
}

/** 未钳制的卡片矩形。`(px,py)` 是钉子；`(x,y)` 是卡片**顶端中点**。 */
function rawRects(px: number, py: number, shown: number, spread: number): CardRect[] {
  const out: CardRect[] = [];
  const offs: HangOffset[] = hangOffsets(shown, spread);
  for (let k = 0; k < offs.length; k++) {
    const cx: number = px + offs[k].dx;
    const cy: number = py + HANG_GAP + offs[k].dy;
    out.push({ x: cx - HANG_PHOTO_W / 2, y: cy, w: HANG_PHOTO_W, h: HANG_PHOTO_H });
  }
  return out;
}

/**
 * 一个钉子挂 `shown` 张照片时的**卡片矩形序列**（画布坐标，已钳进画布）。
 *
 * **绘制与布局判据共用这一个函数**。`pinSvg` 用它画、`planPin` 用它判重叠 ——
 * 只要两边共用，就不可能出现"算的时候不重叠、画出来重叠"。
 */
export function hangRects(px: number, py: number, shown: number, spread: number, boxW: number, boxH: number): CardRect[] {
  const raw: CardRect[] = rawRects(px, py, shown, spread);
  const out: CardRect[] = [];
  for (let k = 0; k < raw.length; k++) { out.push(clampRect(raw[k], boxW, boxH).rect); }
  return out;
}

/**
 * 「+N」角标的矩形：挂在**弧线最低那张卡片的下方**，水平居中于钉子。
 *
 * 为什么在下方而不是像原来那样挂在弧线右端外侧：右端外侧在钉子靠右时正好是画布边缘，
 * 角标会被推出去；而弧线下方通常是空的（照片挂在钉子上、越往下越空）。
 * 它不是卡片（audit 不度量文字），但它**参与避让** —— 否则邻钉的照片会压住它。
 */
function badgeRect(px: number, py: number, shown: number, spread: number): CardRect {
  const offs: HangOffset[] = hangOffsets(shown, spread);
  let bottom: number = py + HANG_GAP;
  let low: number = 0;
  for (let k = 0; k < offs.length; k++) { if (offs[k].dy > low) { low = offs[k].dy; } }
  bottom = py + HANG_GAP + low + HANG_PHOTO_H;
  return { x: px - BADGE_W / 2, y: bottom + BADGE_GAP, w: BADGE_W, h: BADGE_H };
}

/** 一张矩形是否整整齐齐地待在画布里（允许 1e-6 的浮点误差）。 */
function insideBox(r: CardRect, boxW: number, boxH: number): boolean {
  return r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= boxW + 1e-6 && r.y + r.h <= boxH + 1e-6;
}

/** 一组矩形里是否有任何一对"重叠"（判据：交集面积 > HANG_OVERLAP_EPS）。 */
function anyOverlap(rects: CardRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectOverlapArea(rects[i], rects[j]) > HANG_OVERLAP_EPS) { return true; }
    }
  }
  return false;
}

// ── 展开方案：由**空间**决定挂几张（不是常数） ──────────────────────────────

/** 一个钉子的挂载方案。`shown === 0` 表示"收成点"，一张也不挂。 */
interface HangPlan {
  shown: number;
  spread: number;
  rects: CardRect[];
  badge: CardRect;
  hasBadge: boolean;
}

/**
 * 每个张数档试多少个弦宽（从最宽往最窄等距取）。
 *
 * 7 的来历：弧宽对布局的影响是"探多深"（最低点 = 半径 = 弦宽/2/sin55°，是弦宽的单调函数），
 * 所以要躲开下方的邻居只需把弧收窄到某个阈值以下 —— 7 档足以跨过"一个卡片高"的尺度
 * （最窄档与最宽档的半径差 = (hi−lo)×0.6104，7 档的相邻间隔是它的 1/6）。
 * 再多的档位只会让"布局慢一点、好一丁点"，收益不值。每档都是精确的逐对检测，没有近似。
 *
 * 类型标成 `number` 而不是让它推成字面量 `7`：ArkTS 会把没标注的 `const x = 7` 推成字面量类型，
 * 于是下面的 `SPREAD_TRIES === 1` 被判成"两个没有交集的类型在做比较"——一个编译错误
 * （这条是本批构建时真实撞到的）。
 */
const SPREAD_TRIES: number = 7;

/** 空方案（收成点）：不占任何地方。 */
function emptyPlan(): HangPlan {
  return {
    shown: 0, spread: 0, rects: [],
    badge: { x: 0, y: 0, w: 0, h: 0 }, hasBadge: false
  };
}

/**
 * 给一个钉子挑一个**够得着**的挂载方案。这是"内容决定布局"的全部实现。
 *
 * ── 规则（四条，从大到小） ──────────────────────────────────────────────────
 *   1. **张数不超上限**：`k ≤ min(capK, MAX_HANG)`。MAX_HANG 是设计 §6.2 的硬上限
 *      （一屏挂 9 张已经很多了）；`total`（这个钉子下的全部张数）是物理上限。
 *      空间只能往下压，不能往上抬。`+N` 里的 N 恒等于 `total − k`。
 *   2. **弧要放得下**：弦宽 ≤ `min(水平余量, 竖直余量)`。
 *      · 水平余量 = `2 * (min(px, 画布宽 − px) − 半张卡 − 留白)` —— 钉子离右边近，弧就得窄；
 *      · 竖直余量 = `2 * sin(张角/2) * (挂载区底 − py − HANG_GAP − 卡高)` —— 下面没地方，
 *        半径就得小（半径 = 弦宽/2 / sin(张角/2)，而弧的最低点就是半径那么深）。
 *   3. **弦宽在 [自重叠下限, 上限] 之间从宽往窄试**。为什么不是"能多宽就多宽"就完事：
 *      弧越宽**探得越深**（最低点 = 半径），钉子下方如果有别的钉子的照片，把弧**收窄**
 *      反而能整个抬上去躲开它 —— 而收窄只要不破 `arcSpreadNeed` 的自重叠下限就依然好看。
 *      这是"用形状换位置"，比直接少挂一张更划算（实测：北京 2/4 → 3/4）。
 *   4. **自己不许重叠、也不许压住别人**：卡片矩形与**已被接受的**卡片矩形逐对做相交检测
 *      （判据 HANG_OVERLAP_EPS）。每一档都不行就**换小 k 再来**；k 试到 1 都不行 →
 *      **收成点**（点上有张数，用户点开还能看）。
 *
 * ── 为什么是"换小 k"而不是"把框缩小"或"把弧钳一下" ─────────────────────────────
 *   · **不缩框**：卡片 34×44 是跟日期字号（4.6pt）绑定的视觉单位。缩到 0.7 倍，
 *     日期字号变成 3.2pt —— 在 1 倍图上就是糊的。"挂 4 张看得清"胜过"挂 6 张全糊"。
 *   · **不钳弧**：钳制会把弧压成一条直线或让几张卡片叠在一起，那是**画了一条假的弧**。
 *     钳制在本模块里只作为最后一道兜底（`clampRect`），并被判据显式拒绝（下面 `moved` 检查）。
 *   · **换小 k 是最诚实的降级**：弧的形状（等半径、两端高中间低）始终成立，
 *     少挂的那几张由「+N」如实报出，用户点开钉子仍然看得到全部。
 *
 * `px,py` 钉子坐标；`total` 该钉子下的全部张数（只用于算 +N）；`capK` 本轮允许挂的上限；
 * `boxW` 画布宽；`bottom` 挂载区底；`accepted` 已被接受的卡片矩形。
 */
function planPin(
  px: number, py: number, total: number, capK: number, boxW: number, bottom: number, accepted: CardRect[]
): HangPlan {
  let cap: number = capK < MAX_HANG ? capK : MAX_HANG;
  if (cap > total) { cap = total; }
  // 水平余量：弧最外那张卡片的边缘距画布边至少 HANG_EDGE_MARGIN
  const halfRoom: number = Math.min(px, boxW - px) - HANG_PHOTO_W / 2 - HANG_EDGE_MARGIN;
  const hLimit: number = halfRoom > 0 ? halfRoom * 2 : 0;
  // 竖直余量：弧的最低点（中间那张）到底部还要放得下一张卡片
  const vRoom: number = bottom - py - HANG_GAP - HANG_PHOTO_H;
  const vLimit: number = vRoom > 0 ? 2 * Math.sin(HANG_SWEEP_RAD / 2) * vRoom : 0;
  const limit: number = Math.min(hLimit, vLimit);

  for (let k = cap; k >= 1; k--) {
    const hi: number = Math.min(arcSpread(k, boxW), limit);
    if (!(hi > 0)) { continue; }
    // 自重叠下限；k=1 没有相邻对，下限是 0（正下方一张，半径随便 —— 半径就是它"探多深"）。
    const need: number = k > 1 ? arcSpreadNeed(k) : 0;
    const lo: number = need < hi ? need : hi;
    for (let step = 0; step < SPREAD_TRIES; step++) {
      const t: number = SPREAD_TRIES === 1 ? 0 : step / (SPREAD_TRIES - 1);
      const spread: number = hi - (hi - lo) * t;   // 从最宽往最窄试
      if (!(spread > 0)) { continue; }
      const raw: CardRect[] = rawRects(px, py, k, spread);
      if (raw.length !== k) { continue; }
      // ③ 边界钳制 + 形状复核：只要有一张卡片要**被挪动**才放得下，这一档就不算数。
      //    （"被钳得不成形"宁可收成点，也不画一条假的弧。）
      let deformed: boolean = false;
      const rects: CardRect[] = [];
      for (let i = 0; i < raw.length; i++) {
        const c: ClampedRect = clampRect(raw[i], boxW, bottom);
        if (c.moved) { deformed = true; break; }
        rects.push(c.rect);
      }
      if (deformed) { continue; }
      // 自己内部不许重叠（arcSpreadNeed 已经保证下限，这里是精确复核）
      if (anyOverlap(rects)) { continue; }
      // ④「+N」角标只在"挂不全"时出现，它也要放得下、且不压住别人
      let badge: CardRect = { x: 0, y: 0, w: 0, h: 0 };
      let hasBadge: boolean = false;
      if (k < total) {
        const b: ClampedRect = clampRect(badgeRect(px, py, k, spread), boxW, bottom);
        if (b.moved) { continue; }
        badge = b.rect;
        hasBadge = true;
      }
      // 不许压住已经接受的任何卡片（自己的卡片之间上面已经查过）
      let clash: boolean = false;
      for (let i = 0; i < rects.length && !clash; i++) {
        for (let j = 0; j < accepted.length; j++) {
          if (rectOverlapArea(rects[i], accepted[j]) > HANG_OVERLAP_EPS) { clash = true; break; }
        }
      }
      if (!clash && hasBadge) {
        for (let j = 0; j < accepted.length; j++) {
          if (rectOverlapArea(badge, accepted[j]) > HANG_OVERLAP_EPS) { clash = true; break; }
        }
      }
      if (clash) { continue; }
      return { shown: k, spread: spread, rects: rects, badge: badge, hasBadge: hasBadge };
    }
  }
  return emptyPlan();
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
 *
 * `zoom` 非有限值或 ≤ 0 时按 1 处理：`computeLayout` 里是 `zoom < 阈值` 的比较，
 * 让 NaN 直接进去会得到"false → 展开"，那是**静默的错误展开**；在入口处归一更诚实。
 *
 * ── 第 6 步：空间复核（本批新增，修的是"照片挂出画布"与"严重重叠"） ──────────
 * `computeLayout` 只看（钉数、每钉张数、zoom），**不知道画布多大**。于是 6 个钉子下的
 * 24 张卡片会在 360 宽的画布上互相压住、还会伸出右边界（实测：2 张出画布、7 对重叠）。
 * 这不是画法问题而是规则问题 —— "全部展开"在这块画布上必然失败。所以：
 *   · 每个钉子按**优先级**（照片多的先）用 `planPin` 找一个放得下的方案；
 *   · 放不下就少挂几张（挂出来的部分照常画弧，没挂的画成「+N」）；
 *   · 一张都放不下就**收成点**（点上有张数，点开还能看全部）。
 * 空间**只能否决意愿**：`shown > 0` 蕴含 `expanded === true`，不会凭空多出一个展开的钉子。
 *
 * `env` 不给时画布 = 地图块本身（`h`）—— 见 `HangEnvelope` 的说明。
 */
export function buildScene(photos: WallPhoto[], w: number, h: number, zoom: number, env?: HangEnvelope): ScenePin[] {
  const z: number = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
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
    const proj = projectMercator(mid.lon, mid.lat, w, h, CHINA_BOUNDS);
    placed.push({ pinId: groupKeys[i], x: r2(proj.x), y: r2(proj.y) });
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
    const proj = projectMercator(mid.lon, mid.lat, w, h, CHINA_BOUNDS);
    const name: string = idx.length > 1 ? `${winName}等${idx.length}地` : winName;
    merged.push({ pinId: winName, x: r2(proj.x), y: r2(proj.y) });
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

  // 6) 空间复核：画布分区（地图块高 = h；挂载区底 = canvasH - footer）
  const boxW: number = w > 0 ? w : 0;
  // 不给 env，或给了个不比地图块高的画布高 → 画布就是地图块本身（ArkTS 禁 ??，逐项判）
  let canvasH: number = h;
  let footer: number = 0;
  if (env !== undefined) {
    if (env.canvasH > h) { canvasH = env.canvasH; }
    if (env.footer !== undefined && env.footer > 0) { footer = env.footer; }
  }
  // 页脚不能把挂载区吃到比地图块还矮（否则"下方没余量"这个退化情形反而画不出来）
  const bottom: number = canvasH - footer > h ? canvasH - footer : h;

  // 优先级：**照片多的先挑**（冲突时保住信息量大的那个钉子）；并列按 pinId 字典序（可复现）。
  const order: number[] = [];
  for (let i = 0; i < merged.length; i++) {
    const flag: boolean | undefined = expandedOf.get(merged[i].pinId);
    if (flag === true && mergedPhotos[i].length > 0) { order.push(i); }
  }
  order.sort((a: number, b: number): number => {
    const an: number = mergedPhotos[a].length;
    const bn: number = mergedPhotos[b].length;
    if (an !== bn) { return bn - an; }
    if (merged[a].pinId === merged[b].pinId) { return 0; }
    return merged[a].pinId < merged[b].pinId ? -1 : 1;
  });

  // ── 两轮：先「广度」，再「深度」 ─────────────────────────────────────────────
  // 为什么不是"按优先级一次挑满"：实测（tools/fixtures/wall-sample-many.json，11 个钉子）
  // 一次挑满时**西安（11 张）的弧横扫画布中部**，把广州/武汉/拉萨等 7 个钉子挤成点，
  // 全图只挂出 16 张；而两轮（每个钉子先保底 1 张、再加挂）既能保住"每个去过的地方都露一张"
  // —— 这正是地图墙作为"我去过哪儿"的那张地图的第一要义，也与设计 §6.2"钉子多时收成点、
  // 钉子少时才展开"的**广度优先**精神一致（空间不够就是"钉子多"的另一种表现）。
  // 第二轮加挂时会把该钉子第一轮的矩形从占用表里撤掉 —— 它是**原地长高**，不是另找一个地方。
  const plans: Map<number, HangPlan> = new Map<number, HangPlan>();
  for (let pass = 0; pass < 2; pass++) {
    for (let oi = 0; oi < order.length; oi++) {
      const i: number = order[oi];
      const total: number = mergedPhotos[i].length;
      const mine: HangPlan | undefined = plans.get(i);
      if (pass === 0 && total <= 0) { continue; }
      if (pass === 1 && mine === undefined) { continue; }
      // 本轮允许挂的上限：第一轮一律 1 张（保底），第二轮放到意愿上限。
      const capK: number = pass === 0 ? 1 : total;
      // 占用表：把**自己上一轮**的矩形撤掉（原地加挂，不与自己打架）
      const others: CardRect[] = [];
      for (let oi2 = 0; oi2 < order.length; oi2++) {
        const j: number = order[oi2];
        if (j === i) { continue; }
        const pj: HangPlan | undefined = plans.get(j);
        if (pj === undefined || pj.shown <= 0) { continue; }
        for (let k = 0; k < pj.rects.length; k++) { others.push(pj.rects[k]); }
        if (pj.hasBadge) { others.push(pj.badge); }
      }
      const plan: HangPlan = planPin(merged[i].x, merged[i].y, total, capK, boxW, bottom, others);
      if (pass === 0) {
        // 保底阶段：放不下就留空（不写进 plans，第二轮也不会再动它 —— 它已经收成点）
        if (plan.shown > 0) { plans.set(i, plan); }
      } else if (plan.shown > mine.shown) {
        plans.set(i, plan);
      }
    }
  }

  const out: ScenePin[] = [];
  for (let i = 0; i < merged.length; i++) {
    const flag: boolean | undefined = expandedOf.get(merged[i].pinId);
    const plan: HangPlan | undefined = plans.get(i);
    const shown: number = plan === undefined ? 0 : plan.shown;
    out.push({
      pinId: merged[i].pinId,
      name: mergedNames[i],
      x: merged[i].x,
      y: merged[i].y,
      photos: mergedPhotos[i],
      expanded: flag === undefined ? false : flag,
      shown: shown,
      spread: plan === undefined ? 0 : plan.spread
    });
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
  const bounds: number[] = Array.isArray(raw.bounds) && raw.bounds.length === 4
    ? raw.bounds : CHINA_BOUNDS;
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
 * 轮廓 rings → 一条 SVG path 的 `d`（也是 ArkUI `Path().commands()` 的字符串）。
 *
 * 每个 ring 一条 `M … L … L … Z` 子路径（**复用同一条 path**：省掉 N 个 path 元素，
 * 也让 ArkUI 侧只需要一个 Path 组件）。相邻点重复时跳过（相邻重复点在 SVG 里是无用点，
 * 简化后会出现）；坐标保留 2 位小数控制体积。
 * 数据为空时返回空串（调用方据此跳过绘制，而不是画一条空 path）。
 *
 * ── 视口裁剪：整个落在 `[0,w]×[0,h]` 之外的环**不产出子路径** ──────────────────
 * 为什么需要：`china_outline.json` 的 `bounds` 与 `CHINA_REGION.bounds` 一致（必须一致，
 * 否则国界与照片会各画各的），而它的 `minLat = 18` —— 南海诸岛在 8~11.4°N，
 * 投影后落在地图块**下方**（y > h）。不裁的话它们会飘到挂照片的区域里，看着像脏点。
 * 数据里一条都没删（96 条环全在文件里，`build-outline.ts` 会数出来 77 条在块内 / 19 条在块外），
 * 这里只是**视口剔除**：屏幕外的东西不画。
 * 实测 96 条环里 **0 条跨界**（要么整条在块内、要么整条在块外），所以这个剔除是精确的、
 * 不是近似。真出现跨界的环时会整条画出来（多出的部分由调用方的 frame 裁掉，
 * 设备侧是容器的 `.clip(true)`）—— 那种情况下误差上界是一条描边宽度。
 */
export function outlinePath(rings: number[][], w: number, h: number, bounds: number[]): string {
  if (rings === undefined || rings === null || rings.length === 0) { return ''; }
  const b: number[] = Array.isArray(bounds) && bounds.length === 4 ? bounds : CHINA_BOUNDS;
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
      const p = projectMercator(ring[j], ring[j + 1], w, h, b);
      const x: number = r2(p.x);
      const y: number = r2(p.y);
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
    // 整条在视口外 → 丢掉这条子路径（视口剔除，不是删数据）
    if (maxX < 0 || minX > w || maxY < 0 || minY > h) { continue; }
    parts.push(d + 'Z');
  }
  return parts.join('');
}

// ── SVG 输出（Node 预览用；形状与设备侧的几何完全一致） ──────────────────────

/** XML 转义。地名里出现 `&`（"AT&T 大楼"这类）会把整份 SVG 变成解析错误 —— 必须转义。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 卡片底色：由 photoId 决定，同一张照片每次同色（预览里才分得清谁是谁）。 */
const CARD_FILLS: string[] = ['#DCE8F5', '#E6E1F2', '#F3E3DA', '#DCEFE4', '#F2EBD8', '#E8E8EA'];

function fillOf(photoId: string): string {
  let h: number = 7;
  for (let i = 0; i < photoId.length; i++) {
    h = (h * 31 + photoId.charCodeAt(i)) % 1000003;
  }
  return CARD_FILLS[h % CARD_FILLS.length];
}

/** `takenAt` → 卡片上的日期文字。0/负数 = 未知（**显示为"未知时间"而不是 1970-01-01**）。 */
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
 */
export function sceneToSvg(pins: ScenePin[], w: number, h: number, chinaPath: string, scale?: number): string {
  const s: number = scale === undefined || !(scale > 0) ? 1 : scale;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w * s)}" height="${r2(h * s)}" `
    + `viewBox="0 0 ${r2(w)} ${r2(h)}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">`);
  out.push(`<rect x="0" y="0" width="${r2(w)}" height="${r2(h)}" fill="#F7FAF6"/>`);
  if (chinaPath !== undefined && chinaPath !== null && chinaPath.length > 0) {
    out.push(`<path d="${escapeXml(chinaPath)}" fill="#E8F0E4" stroke="#BFD3B8" `
      + `stroke-width="0.8" stroke-linejoin="round" fill-rule="evenodd"/>`);
  }
  out.push(`<g id="pins">`);
  for (let i = 0; i < pins.length; i++) {
    out.push(pinSvg(pins[i], w, h));
  }
  out.push(`</g>`);
  // 钉点与地名**单独一层、画在所有卡片之上**。
  // 为什么必须是单独一层：钉子和卡片分属不同元素，按"钉子顺序"整块画下来时，
  // 后面那个钉子的卡片会盖住前面那个钉子的名字（实测：敦煌的卡片压掉了"西藏·拉萨·城关 ·3"
  // 的左半边，只剩一个"2"露在外面）。钉子是这个视图的**锚点**，它绝不能被照片盖住 ——
  // 用户点它才能看到没挂出来的那几张。文字压在卡片上是可读的（深字浅底），被盖住就没了。
  out.push(`<g id="anchors">`);
  for (let i = 0; i < pins.length; i++) {
    out.push(pinAnchorSvg(pins[i]));
  }
  out.push(`</g>`);
  out.push(`</svg>`);
  return out.join('\n');
}

/**
 * 单个钉子的**内容**层：弧线上的照片 + 线。**不画钉点和名字**（那是 anchors 层的事）。
 *
 * **挂几张、弦宽多少，一律读 `pin.shown` / `pin.spread`** —— 那是布局算出来的、已经
 * 通过"不出画布 + 不重叠"判据的方案。这里**不再自己算** `arcSpread`：
 * 绘制方与判据各算一遍，迟早会漂移成"算的时候不重叠、画出来重叠"（这正是本批要修的缺陷）。
 * 卡片位置由 `hangRects` 给（与判据同一个函数），所以画出来的矩形与判定过的矩形逐点相同。
 */
function pinSvg(pin: ScenePin, canvasW: number, canvasH: number): string {
  const out: string[] = [];
  const cx: number = pin.x;
  const cy: number = pin.y;
  const n: number = pin.photos.length;
  const shown: number = pin.expanded && pin.shown > 0 && pin.shown <= n ? pin.shown : 0;
  out.push(`<g id="pin-${escapeXml(pin.pinId)}">`);

  if (shown > 0) {
    const offs: HangOffset[] = hangOffsets(shown, pin.spread);
    // 先画线（在照片之下），再画照片 —— 否则线会压在卡片上面
    for (let k = 0; k < shown; k++) {
      const ex: number = cx + offs[k].dx;
      const ey: number = cy + HANG_GAP + offs[k].dy;
      out.push(`<line x1="${r2(cx)}" y1="${r2(cy)}" x2="${r2(ex)}" y2="${r2(ey)}" `
        + `stroke="#C3B49B" stroke-width="0.6"/>`);
    }
    const rects: CardRect[] = hangRects(cx, cy, shown, pin.spread, canvasW, canvasH);
    for (let k = 0; k < shown && k < rects.length; k++) {
      const r: CardRect = rects[k];
      out.push(photoCardSvg(pin.photos[k], r.x + r.w / 2, r.y));
    }
    if (n > shown) {
      // 「+N」：挂在弧线最低那张卡片**下方**（那里通常是空的），水平居中于钉子。
      // 位置与判据用的 badgeRect 是同一处几何 —— 它参与避让，不会被邻钉的照片压住。
      const b: CardRect = clampRect(badgeRect(cx, cy, shown, pin.spread), canvasW, canvasH).rect;
      out.push(`<text x="${r2(b.x + b.w / 2)}" y="${r2(b.y + b.h - 1.6)}" font-size="6" fill="#8A8A8A" `
        + `text-anchor="middle">+${n - shown}</text>`);
    }
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
  const shown: number = pin.expanded && pin.shown > 0 && pin.shown <= n ? pin.shown : 0;
  out.push(`<g id="anchor-${escapeXml(pin.pinId)}">`);
  // 钉点：展开时小一点（它只是线的起点），收起时大一点（它就是"点"，要能点得到）
  const dotR: number = shown > 0 ? 2.2 : 3.4;
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(dotR)}" fill="#C0392B"/>`);
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(dotR + 1.8)}" fill="none" `
    + `stroke="#C0392B" stroke-width="0.6" opacity="0.4"/>`);
  // 名字标签：放在钉子上方（下方是照片的地盘），**带该钉子的全部张数**。
  // 「少挂了几张」由弧线下方那个 `+N` 角标负责说 —— 这里不再重复，避免标签变长后在
  // 密集处（京沪只差 29pt）两条标签互相压住。文字描边（paint-order）保证压在卡片上也读得清。
  const label: string = n > 1 ? `${pin.name} ·${n}` : pin.name;
  out.push(`<text x="${r2(cx)}" y="${r2(cy - dotR - 3.4)}" font-size="6.5" fill="#3F4A3C" `
    + `stroke="#F7FAF6" stroke-width="1.4" paint-order="stroke" `
    + `text-anchor="middle">${escapeXml(label)}</text>`);
  out.push(`</g>`);
  return out.join('\n');
}

/** 一张占位照片卡片：(x,y) 是卡片顶端中点。 */
function photoCardSvg(p: WallPhoto, x: number, y: number): string {
  const left: number = x - HANG_PHOTO_W / 2;
  const fill: string = fillOf(p.photoId);
  const label: string = dateLabel(p.takenAt);
  const body: string = `<rect x="${r2(left)}" y="${r2(y)}" width="${HANG_PHOTO_W}" height="${HANG_PHOTO_H}" `
    + `rx="2" fill="${fill}" stroke="#8FA8C0" stroke-width="0.5"/>`
    + `<rect x="${r2(left + 2)}" y="${r2(y + 2)}" width="${HANG_PHOTO_W - 4}" height="${HANG_PHOTO_H - 4}" `
    + `rx="1.4" fill="none" stroke="#FFFFFF" stroke-width="0.5" opacity="0.75"/>`
    + `<text x="${r2(x)}" y="${r2(y + HANG_PHOTO_H / 2 + 1.6)}" font-size="4.6" fill="#5A6672" `
    + `text-anchor="middle">${escapeXml(label)}</text>`;
  return body;
}
