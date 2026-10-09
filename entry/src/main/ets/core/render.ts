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

/** 一个钉子 + 它挂着的照片（`photos` 是**全部**照片，不受 MAX_HANG 截断）。 */
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
}

/** 一张照片相对钉子的挂点偏移（pt）。`dy` 恒 > 0 —— 照片在钉子**下方**。 */
export interface HangOffset { dx: number; dy: number }

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
 * 弧形弦宽（pt）：`count` 张照片呈扇形展开时，最左到最右的水平跨度。
 *
 * `avail` 是可用宽度（画布宽）。上限取 `avail * 0.72`：留给左右边距，也让 9 张照片
 * 在手机上不至于把弧拉到贴边。下限是一张卡片的宽度，避免单张时弦宽为 0（那就退化成竖线了）。
 * **单调不减**：张数越多弧度越宽，是"线长随张数微调"的具体实现。
 */
export function arcSpread(count: number, avail: number): number {
  const wide: number = Number.isFinite(avail) && avail > 0 ? avail * 0.72 : HANG_PHOTO_W * 3;
  const n: number = count > 0 ? count : 1;
  const raw: number = (n - 1) * HANG_STEP_W + HANG_PHOTO_W * 1.15;
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
 */
export function buildScene(photos: WallPhoto[], w: number, h: number, zoom: number): ScenePin[] {
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

  const out: ScenePin[] = [];
  for (let i = 0; i < merged.length; i++) {
    const flag: boolean | undefined = expandedOf.get(merged[i].pinId);
    out.push({
      pinId: merged[i].pinId,
      name: mergedNames[i],
      x: merged[i].x,
      y: merged[i].y,
      photos: mergedPhotos[i],
      expanded: flag === undefined ? false : flag
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
    for (let j = 0; j + 1 < ring.length; j += 2) {
      const p = projectMercator(ring[j], ring[j + 1], w, h, b);
      const x: number = r2(p.x);
      const y: number = r2(p.y);
      if (x === px && y === py) { continue; }
      px = x;
      py = y;
      d += (d.length === 0 ? 'M' : 'L') + x + ' ' + y;
    }
    if (d.length === 0) { continue; }
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
    out.push(pinSvg(pins[i], w));
  }
  out.push(`</g>`);
  out.push(`</svg>`);
  return out.join('\n');
}

/** 单个钉子的 SVG：弧线上的照片 + 线 + 钉点 + 名字。 */
function pinSvg(pin: ScenePin, canvasW: number): string {
  const out: string[] = [];
  const cx: number = pin.x;
  const cy: number = pin.y;
  const n: number = pin.photos.length;
  out.push(`<g id="pin-${escapeXml(pin.pinId)}">`);

  if (pin.expanded && n > 0) {
    // 展开：最多挂 MAX_HANG 张（设计 §6.2「每钉最多 9 张，超出显示 +N」）
    const shown: number = n > MAX_HANG ? MAX_HANG : n;
    const offs: HangOffset[] = hangOffsets(shown, arcSpread(shown, canvasW));
    // 先画线（在照片之下），再画照片 —— 否则线会压在卡片上面
    for (let k = 0; k < shown; k++) {
      const ex: number = cx + offs[k].dx;
      const ey: number = cy + HANG_GAP + offs[k].dy;
      out.push(`<line x1="${r2(cx)}" y1="${r2(cy)}" x2="${r2(ex)}" y2="${r2(ey)}" `
        + `stroke="#C3B49B" stroke-width="0.6"/>`);
    }
    for (let k = 0; k < shown; k++) {
      const ex: number = cx + offs[k].dx;
      const ey: number = cy + HANG_GAP + offs[k].dy;
      out.push(photoCardSvg(pin.photos[k], ex, ey));
    }
    if (n > shown) {
      // "+N"：挂在弧线右端外侧，不与卡片重叠
      const last: HangOffset = offs[shown - 1];
      const px: number = cx + last.dx + HANG_PHOTO_W * 0.62;
      const py: number = cy + HANG_GAP + last.dy + 4;
      out.push(`<text x="${r2(px)}" y="${r2(py)}" font-size="6" fill="#8A8A8A" `
        + `text-anchor="middle">+${n - shown}</text>`);
    }
  }

  // 钉点：展开时小一点（它只是线的起点），收起时大一点（它就是"点"，要能点得到）
  const dotR: number = pin.expanded ? 2.2 : 3.4;
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(dotR)}" fill="#C0392B"/>`);
  out.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(dotR + 1.8)}" fill="none" `
    + `stroke="#C0392B" stroke-width="0.6" opacity="0.4"/>`);

  // 名字标签：放在钉子上方（下方是照片的地盘），带张数
  const label: string = n > 1 ? `${pin.name} ·${n}` : pin.name;
  out.push(`<text x="${r2(cx)}" y="${r2(cy - dotR - 3.4)}" font-size="6.5" fill="#3F4A3C" `
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
