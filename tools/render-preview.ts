/**
 * 地图墙预览：把「钉子 + 标记簇」画成一张 SVG，好让人**先看见**再装到手机上。
 *
 * 用法（一个脚本必须能重现，默认值就是产出报告里那张图的那一组）：
 *
 *   node --experimental-strip-types tools/render-preview.ts
 *   node --experimental-strip-types tools/render-preview.ts --nearby
 *   node --experimental-strip-types tools/render-preview.ts --many
 *   node --experimental-strip-types tools/render-preview.ts --zoomout
 *   node --experimental-strip-types tools/render-preview.ts --pan=west
 *   node --experimental-strip-types tools/render-preview.ts --pan=east
 *   node --experimental-strip-types tools/render-preview.ts <数据.json> [输出.svg]
 *
 *   node --experimental-strip-types tools/render-preview.ts \
 *        --data locations.json --decisions decisions.json --out tools/out/wall-preview.svg
 *
 * 参数：
 *   （位置参数）      数据文件；给了它就不用 --data
 *   --data=PATH      照片数据。两种形状都吃：
 *                      · `locations.json`（data/locationIndex 落盘的那个数组）——**设备导出的真数据**
 *                      · `{ "photos": [...] }`（手写的代表性数据，本仓库 tools/fixtures 下那三份）
 *   --decisions=PATH `decisions.json`（data/decisionStore 落盘的那个数组）；
 *                    给了它就只画 `state === "walled"` 的照片 —— 与设备上的墙一致。
 *   --out=PATH       输出 SVG（默认 tools/out/wall-preview.svg）
 *   --w=--h=         画布尺寸（pt，默认 360×720 —— 一台常见鸿蒙手机的 vp 尺寸）
 *   --zoom=          地图缩放（默认 1）。小于 placement.MIN_ZOOM_FOR_EXPAND 时全部收成光点。
 *   --pad=           视野内边距比例（默认 `render.VIEW_PAD_RATIO` = 0.15，**与设备同一个常量**）。
 *                    0 = 数据框紧贴数据；它现在只影响"经度中心"与"数据比一屏宽吗"的判断
 *                    （纬度恒取中国全域，不再由数据决定）。
 *   --scale=         SVG 的像素放大倍数（默认 2；**只改 width/height，几何一点不变**）
 *   --footer=        顶部图例条的高度（pt，默认 34）。
 *   --nearby         用"三个邻近城市"的那份数据（**贴用户真机**：上海+北京+天津）
 *   --many           用 18 个钉子的那份数据（演示"钉子多时收成点"）
 *   --zoomout        从默认视野先放大 6 步、再一路捏合缩回**下界**后出图
 *                    （下界 = 完整的中国纬度；输出名加 `-zoomedout` 后缀）
 *   --pan=west|east  **同一次视野下横滑到最西 / 最东**（输出名加 `-pan-west` / `-pan-east`）。
 *                    这就是"横向溢出"的可视化：地图比画布宽 2.23 倍，不滑就只能看到其中一段。
 *
 * ── 形态（task-18 的用户裁决："地图为主：照片改小、点开才看大图"）────────────────
 *   · 地图是**主角**：底色 + 国界 + 省界铺满整块画布，钉子撒在上面；
 *   · 照片是**钉子旁的一簇小圆点**（半径 `MARKER_R = 1.9`、最多 `MAX_MARKERS = 5` 个，
 *     其余由「＋N」报出）——**没有任何卡片、挂线、日期文字**；
 *   · 轨迹折线保留（钉子按拍摄时间连起来）；
 *   · 大图在「点开钉子」的详情面板里（那是设备侧的 `Image`，Node 侧本来就看不到）。
 *   与真机的差别只有**地名标签的字号**（预览 6.5 用户单位 vs 设备 8fp）——
 *   2 倍图下两者视觉大小同量级，改它有它的理由（真屏上 6.5 会糊），
 *   而标记的半径与位置**一点不差**（都读同一份常量与同一个 `pinMarkers`）。
 *
 * ── 视野（viewport）：**铺满高度 + 横向溢出**（task-19 的用户裁决"地图铺满高度，左右横滑"）──
 *   · `fitBounds(photos, pad)` 求数据框（一张有坐标的都没有 → 退回 `CHINA_REGION.bounds`）；
 *   · **`defaultWallView(photos, pad, w, h)`** 求默认视野：纬度恒取中国全域 18~54、
 *     经度跨度由**画布宽高比**反推、经度中心对齐数据中心（数据比一屏宽时退成"钉子最多的
 *     那一屏"）。与设备侧 `WallPage.rebuild` 调的是**同一个函数**；
 *   · 用它 `mapFrame(w, h, bounds)` 得到**恒填满高度**的绘制框 —— bounds 存在框里，
 *     **国界、省界与钉子都从框上读**（`frameBounds`），不可能各画各的；
 *   · `viewMetrics(frame)` 给出四个验收数字（地图绘制宽/高、两个比值、横向偏移、可滑余量）——
 *     图例里印的就是它，与设备诊断行是同一个函数。
 *
 * ── 三个比值（画布 360×720、默认视野）：**先看懂这三个数再看图** ─────────────────
 *   · 一屏经度跨度 = `360/720 × 0.80471895621705 / DEG` = **23.0535°**；
 *   · **地图绘制高度 / 画布高度 = 1.00**（纵向铺满 —— 用户那条硬要求）；
 *   · **地图绘制宽度 / 画布宽度 = 2.6894**（横向溢出 —— 所以要横滑；`--pan=` 那两张就是它）。
 *
 * 输出断言（脚本自己会检查，不符合就非零退出）：
 *   · 文件写出且非空；· 没有 NaN/Infinity 坐标；· 有 <svg> 根元素；
 *   · 每个标记都贴着钉子（`dy ∈ (0, MARKER_DY]`、`|dx| ≤ 9pt`）—— 新形态的硬不变量；
 *   · **地图绘制高度 ≥ 画布高度**（纵向铺满：默认视野下必须恰好等于画布高）；
 *   · **数据装得下一屏时，每一个钉子都必须在可见区里**（否则"默认让钉子可见"就是空话）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAreaData } from '../entry/src/main/ets/core/areaData.ts';
import { CHINA_REGION, projectMercator } from '../entry/src/main/ets/core/projection.ts';
import { MIN_ZOOM_FOR_EXPAND } from '../entry/src/main/ets/core/placement.ts';
import {
  BLOCK_FILL, MARKER_DY, MARKER_R, MARKER_STEP, MAX_MARKERS, PROVINCE_STROKE, PROVINCE_WIDTH,
  VIEW_PAD_RATIO, badgeRectOf, buildScene, defaultWallView, fillHeightLonSpan, fillHeightView,
  fitBounds, frameBounds, geoAspect, mapFrame, markerCountOf, outlinePath, panViewBy, parseOutline,
  pinMarkers, sceneToSvg, trajectoryOrder, viewMetrics, viewZoomOf, zoomViewAt
} from '../entry/src/main/ets/core/render.ts';
import type { MapFrame, PinMarker, ScenePin, ViewMetrics, WallPhoto } from '../entry/src/main/ets/core/render.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const AREA_RAW = path.join(REPO, 'entry/src/main/resources/rawfile/china_areas.json');
const OUTLINE_RAW = path.join(REPO, 'entry/src/main/resources/rawfile/china_outline.json');
const PROVINCE_RAW = path.join(REPO, 'entry/src/main/resources/rawfile/china_provinces.json');

// ── 参数 ────────────────────────────────────────────────────────────────────

interface Options {
  data: string;
  decisions: string;
  out: string;
  w: number;
  h: number;
  zoom: number;
  scale: number;
  footer: number;
  pad: number;
  /**
   * `--zoomout`：从默认视野先放大 6 步、再**一路捏合缩回下界**（模拟用户在真机上一直捏合），
   * 然后按那一帧出图。下界 = **完整的中国纬度**（task-19），输出名加 `-zoomedout` 后缀。
   */
  zoomout: boolean;
  /**
   * `--pan=west|east`：**同一次视野下横滑到最西 / 最东**（`panViewBy(bounds, ±50, 0)`，
   * 与设备上"手指一直往一个方向拖"走的是同一条路径）。输出名加 `-pan-west` / `-pan-east`。
   * 这两张就是"横向溢出 2.23 倍"的可视化：同一块画布、同一个缩放，只是窗口滑到了另一头。
   */
  pan: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    data: path.join(HERE, 'fixtures/wall-sample.json'),
    decisions: '',
    out: path.join(HERE, 'out/wall-preview.svg'),
    w: 360,
    h: 720,
    zoom: 1,
    scale: 2,
    footer: 34,
    // **与设备同一个常量**：两边各写一个数就会变成"电脑上看到的和真机上看到的不是同一张图"
    pad: VIEW_PAD_RATIO,
    zoomout: false,
    pan: ''
  };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--many') {
      o.data = path.join(HERE, 'fixtures/wall-sample-many.json');
      o.out = path.join(HERE, 'out/wall-preview-many.svg');
      continue;
    }
    if (a === '--nearby') {
      o.data = path.join(HERE, 'fixtures/wall-sample-nearby.json');
      o.out = path.join(HERE, 'out/wall-preview-nearby.svg');
      continue;
    }
    if (a === '--zoomout') {
      o.zoomout = true;
      // 输出名**加后缀**而不是直接覆盖默认名：`--nearby --zoomout` 因此得到
      // `wall-preview-nearby-zoomedout.svg`，**永远不会**覆盖已有的那几张预览
      //（`--out=` 显式给了就听调用方的，与其它参数一致）。
      o.out = o.out.replace(/\.svg$/, '-zoomedout.svg');
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq < 0 ? a : a.substring(0, eq);
    const val = eq < 0 ? '' : a.substring(eq + 1);
    if (key === '--data') { o.data = val; continue; }
    if (key === '--decisions') { o.decisions = val; continue; }
    if (key === '--out') { o.out = val; continue; }
    if (key === '--w') { o.w = Number(val); continue; }
    if (key === '--h') { o.h = Number(val); continue; }
    if (key === '--zoom') { o.zoom = Number(val); continue; }
    if (key === '--scale') { o.scale = Number(val); continue; }
    if (key === '--footer') { o.footer = Number(val); continue; }
    if (key === '--pad') { o.pad = Number(val); continue; }
    if (key === '--pan') {
      if (val !== 'west' && val !== 'east') { throw new Error(`--pan 只认 west / east，收到「${val}」`); }
      o.pan = val;
      o.out = o.out.replace(/\.svg$/, `-pan-${val}.svg`);
      continue;
    }
    if (a.startsWith('--')) { throw new Error(`未知参数：${a}`); }
    positional.push(a);
  }
  if (positional.length > 0) { o.data = positional[0]; }
  if (positional.length > 1) { o.out = positional[1]; }
  return o;
}

// ── 读数据 ──────────────────────────────────────────────────────────────────

/** 时间字段：数字（epoch ms，设备落盘的形状）；ISO 字符串（手写夹具更好读）；缺失/null = 未知 0。 */
function toMs(v: number | string | null | undefined): number {
  if (typeof v === 'number') { return Number.isFinite(v) ? v : 0; }
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** 宽容地把一条外部记录读成 WallPhoto；坐标非法（非有限数）时返回 undefined 并计数。 */
function toWallPhoto(raw: Record<string, unknown>): WallPhoto | undefined {
  const id = raw['photoId'];
  if (typeof id !== 'string' || id.length === 0) { return undefined; }
  const lat = typeof raw['lat'] === 'number' ? raw['lat'] : 0;
  const lon = typeof raw['lon'] === 'number' ? raw['lon'] : 0;
  const p: WallPhoto = {
    photoId: id,
    lat: Number.isFinite(lat) ? lat : 0,
    lon: Number.isFinite(lon) ? lon : 0,
    takenAt: toMs(raw['takenAt'] as number | string | null | undefined)
  };
  const place = raw['place'];
  if (typeof place === 'string' && place.length > 0) { p.place = place; }
  if (raw['manual'] === true) { p.manual = true; }
  return p;
}

interface LoadResult { photos: WallPhoto[]; dropped: number; source: string }

function loadPhotos(file: string, decisionsFile: string): LoadResult {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  let arr: Record<string, unknown>[] = [];
  if (Array.isArray(parsed)) {
    arr = parsed as Record<string, unknown>[];                      // locations.json
  } else if (parsed !== null && typeof parsed === 'object') {
    const photos = (parsed as Record<string, unknown>)['photos'];
    if (Array.isArray(photos)) { arr = photos as Record<string, unknown>[]; }
  }
  if (arr.length === 0) { throw new Error(`${file} 里没有照片数组（既不是数组，也没有 photos 字段）`); }

  // --decisions：只留 state === 'walled' 的（与设备上 decisions.json 的语义一致）
  let walledFilter: Set<string> | undefined = undefined;
  if (decisionsFile.length > 0) {
    const d = JSON.parse(fs.readFileSync(decisionsFile, 'utf8')) as unknown;
    if (!Array.isArray(d)) { throw new Error(`${decisionsFile} 不是数组（decisions.json 应是一个数组）`); }
    walledFilter = new Set<string>();
    for (const item of d as Record<string, unknown>[]) {
      if (item !== null && item['state'] === 'walled' && typeof item['photoId'] === 'string') {
        walledFilter.add(item['photoId'] as string);
      }
    }
  }

  const photos: WallPhoto[] = [];
  let dropped = 0;
  for (const raw of arr) {
    if (raw === null || typeof raw !== 'object') { dropped++; continue; }
    const p = toWallPhoto(raw);
    if (p === undefined) { dropped++; continue; }
    if (walledFilter !== undefined && !walledFilter.has(p.photoId)) { continue; }
    photos.push(p);
  }
  const src = decisionsFile.length > 0 ? `${file} × ${decisionsFile}` : file;
  return { photos, dropped, source: src };
}

// ── 画 ──────────────────────────────────────────────────────────────────────

function main(): number {
  const o = parseArgs(process.argv.slice(2));

  // 区划数据：EXIF 坐标要反查地名（render.buildScene 内部调用 nearestCounty）
  parseAreaData(fs.readFileSync(AREA_RAW, 'utf8'));

  const loaded = loadPhotos(o.data, o.decisions);

  // ── 视野：**铺满高度 + 横向溢出**（与设备侧同一个 `defaultWallView`）────────────
  // 一张有效坐标都没有 → `fitBounds` 返回 undefined → 退回全国视野（设备侧同一条退化路径）。
  const vb: number[] | undefined = fitBounds(loaded.photos, o.pad);
  const dataBounds: number[] = vb !== undefined ? vb : CHINA_REGION.bounds;
  // 默认视野：纬度恒取中国全域 18~54、经度跨度由**画布宽高比**反推（真机 27.744185828688188°）、
  // 经度中心对齐数据中心；数据比一屏宽时退成"钉子最多的那一屏"。
  // 这就是"地图铺满高度、横向溢出"的那一帧（`WallPage.rebuild` 的第 ② 步）。
  let bounds: number[] = defaultWallView(loaded.photos, o.pad, o.w, o.h);
  const defaultBounds: number[] = bounds.slice(0, bounds.length);
  // 一屏的经度跨度（把"为什么是 2.23 倍"变成可复算的数）
  const oneScreenSpan: number = fillHeightLonSpan(o.w, o.h);

  // ── `--pan=west|east`：**同一次视野下横滑到最西 / 最东**────────────────────────
  // 走的是设备上"手指一直往一个方向拖"那条路径（`panViewBy` + `containInChina` 的平移钳制）：
  // 拖到头就停住，窗口贴住 73°E / 135°E。这两张图放在一起看，就是"横向溢出 2.23 倍"的证据：
  // 同一个缩放、同一块画布，只有窗口位置不同 —— 两屏之间的那 34.256° 只能滑过去。
  let panNote = '';
  if (o.pan === 'west') { bounds = panViewBy(bounds, 50, 0); panNote = '横滑到最西（窗口贴住 73°E）'; }
  if (o.pan === 'east') { bounds = panViewBy(bounds, -50, 0); panNote = '横滑到最东（窗口贴住 135°E）'; }

  // ── `--zoomout`：先放大 6 步、再一路缩回**下界**（task-19 的验收物）──────────────
  // 下界 = **完整的中国纬度**（旧模型这里是"经度到顶 62°、纬度搭车到 −20.6°"，用户截图里那一帧）。
  // 复现路径照抄设备：视野从**默认那一帧**开始，手势只调 `zoomViewAt`。
  let zoomSteps: number = 0;
  let zoomInNote: number[] = bounds;
  if (o.zoomout) {
    for (let i = 0; i < 6; i++) { bounds = zoomViewAt(bounds, 2, 0.3, 0.7); }
    zoomInNote = bounds.slice(0, bounds.length);
    for (let i = 0; i < 40; i++) {
      const nb: number[] = zoomViewAt(bounds, 0.5, 0.5, 0.5);
      if (nb[0] === bounds[0] && nb[1] === bounds[1] && nb[2] === bounds[2] && nb[3] === bounds[3]) { break; }
      bounds = nb;
      zoomSteps++;
    }
  }
  const zoomFactor: number = viewZoomOf(bounds);
  // 数据框与默认视野的放大倍数（真机诊断行印的就是这一对数字）
  const zoomData: number = viewZoomOf(dataBounds);
  const zoomDefault: number = viewZoomOf(defaultBounds);
  // 缩到底那一帧的**逐位**性质：从默认视野做一次纯缩小，必须一动不动（它是终点）
  const pureOut: number[] = zoomViewAt(defaultBounds, 0.5, 0.5, 0.5);
  const pureOutSame: boolean = pureOut[0] === defaultBounds[0] && pureOut[1] === defaultBounds[1]
    && pureOut[2] === defaultBounds[2] && pureOut[3] === defaultBounds[3];

  // 地图块 = 整块画布；绘制框 = **恒填满高度**的那个不变形矩形（宽度放不下时 x 为负）。
  // bounds 存在框里（`MapFrame.bounds`），国界/省界/钉子都从框上读它 —— 不可能各画各的。
  const frame: MapFrame = mapFrame(o.w, o.h, bounds);
  // 投影实际用的 bounds（从框上读，与 buildScene / outlinePath 同一处）
  const fb: number[] = frameBounds(frame);
  // **四个验收数字**：地图绘制宽/高、两个比值、横向偏移、可滑余量 —— 设备诊断行印的是同一个函数。
  const vm: ViewMetrics = viewMetrics(frame);

  // 国界：数据文件在就画，不在就退化成"只有钉子和线"（脚本仍然能跑，报告里说明）
  let chinaPath = '';
  let outlineNote = '（没有 china_outline.json，本次不画国界）';
  // 图例里的**短**版本：`od.src` 有一整行那么长（"Natural Earth 1:10m Admin 0 – Countries
  // (ne_10m_admin_0_countries.geojson)"），塞进图例会把它挤到截断；完整出处仍在**控制台**里打。
  let outlineShort = outlineNote;
  if (fs.existsSync(OUTLINE_RAW)) {
    const od = parseOutline(fs.readFileSync(OUTLINE_RAW, 'utf8'));
    if (od === undefined) {
      outlineNote = '（china_outline.json 解析失败，本次不画国界）';
      outlineShort = outlineNote;
    } else {
      chinaPath = outlinePath(od.rings, frame);
      // 视野内的环数：放大之后国界可能**整条**（或大部分）在视野外，图上只剩空白底 + 钉子。
      // 这不是缺陷而是取舍（见文件头与报告），但要能在图上核对，所以数出来写进图例。
      const ringsInView = chinaPath.length === 0 ? 0 : chinaPath.split('M').length - 1;
      outlineNote = `${ringsInView}/${od.rings.length} 个环在视野内 / ${od.src}`;
      outlineShort = `国界 ${ringsInView}/${od.rings.length} 环`;
      if (ringsInView === 0) { outlineNote += '（**整条在视野外**：只有空白底 + 钉子）'; }
    }
  }

  // 省界：与国界**同一套机制**（同一个 parseOutline、同一个 outlinePath、同一个 frame），
  // 只是换颜色与线宽（`PROVINCE_STROKE` / `PROVINCE_WIDTH`，与设备侧共用常量）。
  // 读不到就退化成"只有国界"，脚本仍然能跑。
  let provincePath = '';
  let provinceNote = '（没有 china_provinces.json，本次不画省界）';
  if (fs.existsSync(PROVINCE_RAW)) {
    const pd = parseOutline(fs.readFileSync(PROVINCE_RAW, 'utf8'));
    if (pd === undefined) {
      provinceNote = '（china_provinces.json 解析失败，本次不画省界）';
    } else {
      provincePath = outlinePath(pd.rings, frame);
      const provRings = provincePath.length === 0 ? 0 : provincePath.split('M').length - 1;
      provinceNote = `省界 ${provRings}/${pd.rings.length} 环`;
    }
  }

  const pins: ScenePin[] = buildScene(loaded.photos, frame, o.zoom);
  let svg = sceneToSvg(pins, o.w, o.h, chinaPath, o.scale, provincePath);

  // 地图框 / 地图内容 / 画布的**标注**：三条虚线框，让"谁比谁大"在图上一眼可见。
  // 它们**不是地图的一部分**（`sceneToSvg` 不画、设备侧也不画）—— 这是预览的排版标注，
  // 和下面那三行图例是同一类东西。所以底色只有一种（`BLOCK_FILL`，与设备一致），
  // 分区靠这三条虚线与图例里的数字，而不是靠几层颜色。
  //   · **画布**（灰）：`0,0 → w×h` —— 真机上就是屏幕里那块主体区；
  //   · **绘制框**（绿）：`frame.x/y/w/h` —— 默认视野下与画布**完全重合**（这就是"铺满"）；
  //   · **中国绘制范围**（赭）：`[westX, northY] → mapW × mapH` —— 真机上量到的"地图"有多大。
  //     它比画布宽 2.23 倍 → **两侧一定会伸出画布**（`--pan=` 那两张就是滑过去看的结果）。
  {
    const marks: string[] = [];
    marks.push(`<rect x="0" y="0" width="${round2(o.w)}" height="${round2(o.h)}" fill="none" `
      + `stroke="#C9C2B4" stroke-width="0.6" stroke-dasharray="2 3" opacity="0.9"/>`);
    marks.push(`<rect x="${round2(frame.x)}" y="${round2(frame.y)}" width="${round2(frame.w)}" `
      + `height="${round2(frame.h)}" fill="none" stroke="#9FBE97" stroke-width="0.6" `
      + `stroke-dasharray="5 4" opacity="0.85"/>`);
    marks.push(`<rect x="${round2(vm.westX)}" y="${round2(vm.northY)}" width="${round2(vm.mapW)}" `
      + `height="${round2(vm.mapH)}" fill="none" stroke="#D08A46" stroke-width="0.6" `
      + `stroke-dasharray="1.5 2.5" opacity="0.9"/>`);
    const lines = svg.split('\n');
    const bg = lines.findIndex((l) => l.includes(`fill="${BLOCK_FILL}"`));
    lines.splice(bg + 1, 0, marks.join('\n'));
    svg = lines.join('\n');
  }

  // 图例：把"这张图是什么、用了哪份数据、几何是多少"写在图上，省得看图的人猜
  const drawn = pins.reduce((s, p) => s + markerCountOf(p), 0);
  const undated = pins.reduce((s, p) => s + p.photos.filter((x) => !(x.takenAt > 0)).length, 0);
  const onWall = pins.reduce((s, p) => s + p.photos.length, 0);
  const total = loaded.photos.length;
  // "标记画不全"的钉子数与「＋N」总数：这就是"墙上照片改小"后**必须**能读出来的两个数。
  let plusN: number = 0;
  let clippedPins: number = 0;
  for (const p of pins) {
    const extra: number = p.photos.length - markerCountOf(p);
    if (extra > 0) { plusN += extra; clippedPins++; }
  }
  // 「照片级」的**画布外**计数：按**原始坐标**算，不受聚簇影响。
  // 为什么必须单独算：400km 外的两张照片会在屏幕上被并进同一个钉子（MIN_PIN_DIST_PT=40
  // 在一屏 23° 经度下约等于 2.6° 经度），此时"某个钉子在屏幕外"就再也看不出来了 ——
  // 三沙永兴岛（16.83°N）正是这样消失的。判据是**画布**（`[0, w]×[0, h]`）而不是绘制框：
  // task-19 之后框可以比画布宽，而"用户这一眼看得见吗"问的是画布。
  const outside: string[] = [];
  const insideCount: number[] = [0, 0];
  for (const ph of loaded.photos) {
    const has = ph.manual === true || ph.lat !== 0 || ph.lon !== 0;
    if (!has) { continue; }
    // 注意：这里的 `q` 是**框坐标**，要加上 frame.x/frame.y 才是画布坐标
    const q = projectMercator(ph.lon, ph.lat, frame.w, frame.h, fb);
    const cx = q.x + frame.x;
    const cy = q.y + frame.y;
    if (cx < 0 || cx > o.w || cy < 0 || cy > o.h) {
      outside.push(`${ph.place === undefined ? `${ph.lat.toFixed(2)},${ph.lon.toFixed(2)}` : ph.place}(x=${round2(cx)})`);
      insideCount[1]++;
    } else {
      insideCount[0]++;
    }
  }
  const track = trajectoryOrder(pins);
  const boundsText = `[${round2(fb[0])},${round2(fb[1])},${round2(fb[2])},${round2(fb[3])}]`;
  const dataText = `[${round2(dataBounds[0])},${round2(dataBounds[1])},${round2(dataBounds[2])},${round2(dataBounds[3])}]`;
  // `--zoomout` / `--pan` 时图例要报的是**当前那一帧**的框（`boundsText` 本来就是从 `frame`
  // 上读的，所以它天然跟着变）；默认那一帧只在控制台里与它并列印出来做对照。
  const defaultText = `[${round2(defaultBounds[0])},${round2(defaultBounds[1])},${round2(defaultBounds[2])},${round2(defaultBounds[3])}]`;
  const legend: string[] = [];
  // 图例画在**顶部**，并带一条底衬 —— **只影响这张 SVG 好不好读，不改任何几何**。
  // 为什么不放底部：默认视野的纬度是中国全域（18~54），最南的钉子也在画布偏下的位置；
  // 顶部 34pt 的图例条压不到任何东西。
  // 设备侧没有这个问题（提示文字在 Stack **外面**、不占画布），所以这是预览**绘制**上的差异。
  const legendH: number = o.footer > 20 ? o.footer : 34;
  legend.push(`<rect x="0" y="0" width="${round2(o.w)}" height="${round2(legendH)}" `
    + `fill="${BLOCK_FILL}" opacity="0.9"/>`);
  // 字号 6.5：7 号字在 360pt 宽上会**右侧截断**（SVG 的 text 不换行，超出的部分直接看不见）
  // —— 预览是给人看的，截断的图例等于没有图例。四行，每行都写得尽量短。
  legend.push(`<g id="legend" font-size="6.5" fill="#7A8577">`);
  const pinsInView: number = pins.filter((p) => p.x >= 0 && p.x <= o.w && p.y >= 0 && p.y <= o.h).length;
  legend.push(`<text x="8" y="${round2(legendH - 28)}">地图墙预览${panNote.length > 0 ? `（${escapeText(panNote)}）` : ''} ｜ 钉子 ${pinsInView}/${pins.length} 个在屏内 ｜ 标记 ${drawn} 个 ｜ 轨迹 ${track.length} 点 ｜ 上墙 ${onWall} 张（输入 ${total}，无地点 ${total - onWall}）</text>`);
  const viewLine: string = o.zoomout
    ? `视野 默认 ${defaultText} →（放大 6 步 → ${zoomInNote.map(round2).join(',')}）→ 缩到底 ${boundsText}`
      + `（${zoomSteps} 步捏合，纬度 == 中国全域）｜ 放大 ${round2(zoomData)}×→${round2(zoomFactor)}×`
    : `视野 数据 ${dataText}${vb !== undefined ? '(数据)' : '(全国)'} → 一屏（经度 ${round2(oneScreenSpan)}°）${boundsText}`
      + ` ｜ 放大 ${round2(zoomData)}×→${round2(zoomFactor)}×`;
  legend.push(`<text x="8" y="${round2(legendH - 18)}">${viewLine}</text>`);
  // ②′ 新模型的**三个验收数字**：
  //   · **地图绘制宽/高**（中国全域投影出来的尺寸）与两个比值：
  //     `高/画布` 铺满那一档必须是 **1**，`宽/画布` 必须 **> 1**（那就是"要横滑"）；
  //   · **横向偏移**（中国西缘的屏幕 x，负 = 在屏幕左外侧）与**可滑余量**。
  // 它们与设备诊断行印的是同一个 `viewMetrics` 的值。
  legend.push(`<text x="8" y="${round2(legendH - 8)}">**地图绘制 ${round2(vm.mapW)}×${round2(vm.mapH)}pt ｜ 高/画布 ${round2(vm.heightRatio)} 宽/画布 ${round2(vm.widthRatio)}** ｜ 横偏 ${round2(vm.westX)} 可滑 ${round2(vm.panSlackX)}pt ｜ 视野经度 ${round2(vm.lonSpan)}°</text>`);
  // ⚠️ 措辞不能出现 "地图框 N×Npt@(x,y)" 之外的**第二种同形写法** ——
  // `tools/wall-audit.ts` 用 `/地图框 ([\d.]+)×([\d.]+)pt@\((-?[\d.]+),(-?[\d.]+)\)/`
  // 从图例里读分区；本行原来写成 "地图框 ... ｜ 标记 3.8pt..."，其中 `3.8pt` 后面紧跟的
  // 字符让那条正则先匹配到**别处**，量出来的分区就变成了"整块画布"（静默的错误读数）。
  // 所以这一行里**只有一处** `地图框 W×Hpt@(x,y)`，其余数字都写成"地图绘制 …"。
  legend.push(`<text x="8" y="${round2(legendH + 3)}">地图框 ${round2(frame.w)}×${round2(frame.h)}pt@(${round2(frame.x)},${round2(frame.y)}) ｜ 标记直径 ${round2(MARKER_R * 2)}pt·一钉最多 ${MAX_MARKERS} 个 ｜ ＋N ${plusN} 张/${clippedPins} 钉 ｜ 屏外 ${outside.length} ｜ 时间未知 ${undated} ｜ ${escapeText(outlineShort)} ${escapeText(provinceNote)}</text>`);
  legend.push(`</g>`);
  svg = svg.replace('</svg>', legend.join('\n') + '\n</svg>');

  // ── 自检（不符合就非零退出）──────────────────────────────────────────────
  // ① SVG 里不许出现 NaN/Infinity（那会让整条 path 静默消失）
  if (svg.includes('NaN') || svg.includes('Infinity')) {
    console.error('✗ 产出的 SVG 里有 NaN/Infinity —— 拒绝写盘');
    return 1;
  }
  // ② 新形态的硬不变量：每个画出来的标记都必须**贴着钉子**
  //    （dy ∈ (0, MARKER_DY]、|dx| ≤ (MAX_MARKERS−1)/2 × MARKER_STEP）。
  //    直接量**场景**（`pin.markers`）而不是正则抽 SVG：两者由同一个 `pinMarkers` 产出，
  //    而这里要防的是"哪天有人把偏移算错了"，量场景就够了。
  const halfWide: number = (MAX_MARKERS - 1) / 2 * MARKER_STEP;
  let badMarkers: number = 0;
  for (const p of pins) {
    for (const m of p.markers) {
      if (!(m.dy > 0) || m.dy > MARKER_DY + 1e-9 || Math.abs(m.dx) > halfWide + 1e-9) { badMarkers++; }
    }
    if (p.markers.length > MAX_MARKERS) { badMarkers++; }
  }
  if (badMarkers > 0) {
    console.error(`✗ 有 ${badMarkers} 个标记不贴着钉子（新形态的硬不变量）—— 拒绝写盘`);
    return 1;
  }
  // ③ task-19 的硬不变量：**纵向铺满**（地图绘制高度 ≥ 画布高度 —— 小于就说明画布上有空白带；
  //    默认视野下必须**恰好**等于画布高）。这条是用户那条要求的机器可读形式。
  if (!(vm.heightRatio >= 1 - 1e-9)) {
    console.error(`✗ 地图没铺满高度：绘制高度 ${round2(vm.mapH)} < 画布高 ${round2(o.h)} —— 拒绝写盘`);
    return 1;
  }
  if (!o.zoomout && o.pan.length === 0 && vm.heightRatio !== 1) {
    console.error(`✗ 默认视野的地图高度比应当是 1（纵向铺满那一档），实测 ${vm.heightRatio} —— 拒绝写盘`);
    return 1;
  }
  // ④ task-19 的第二条硬不变量：**数据装得下一屏时，每一个钉子都必须在可见区里**。
  //    （装不下时只能"尽可能多"，那就由 `defaultWallView` 的规则与 §6 的取舍负责。）
  const dataSpan: number = dataBounds[2] - dataBounds[0];
  if (!o.zoomout && o.pan.length === 0 && dataSpan <= vm.lonSpan + 1e-9) {
    let hidden: number = 0;
    for (const p of pins) {
      if (p.x < 0 || p.x > o.w || p.y < 0 || p.y > o.h) { hidden++; }
    }
    if (hidden > 0) {
      console.error(`✗ 数据只占 ${round2(dataSpan)}°（一屏 ${round2(vm.lonSpan)}°）却有 ${hidden} 个钉子在屏外`
        + ` —— "默认让钉子可见"没做到，拒绝写盘`);
      return 1;
    }
  }

  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, svg, 'utf8');

  // ── 控制台摘要（报告里的数字都来自这里） ──────────────────────────────────
  console.log(`数据：${loaded.source}`);
  console.log(`  读入 ${loaded.photos.length} 条${loaded.dropped > 0 ? `（丢弃 ${loaded.dropped} 条非法记录）` : ''}`);
  console.log(`画布：${o.w}×${o.h}pt（scale=${o.scale} → ${o.w * o.scale}×${o.h * o.scale}px）`);
  console.log(`分区：地图块 0→${round2(o.h)}pt（地图是整块主体区的底色：底 + 国界 + 省界 + 轨迹 + 钉子）`);
  console.log(`视野：数据框 ${dataText}${vb !== undefined ? '(数据：fitBounds)' : '(全国：没有有效坐标的退化路径)'}`);
  console.log(`      默认视野 ${defaultText}（defaultWallView：纬度取中国全域、经度跨度由画布比反推）`);
  console.log(`        一屏经度跨度 = ${(o.w / o.h).toFixed(10)} × 0.80471895621705 / DEG = **${oneScreenSpan}°**`
    + ` ｜ 横向可滑余量 = 62 − ${round2(oneScreenSpan)} = **${round2(62 - oneScreenSpan)}°**`
    + ` ｜ 放大 ${round2(zoomData)}× → ${round2(zoomDefault)}×`);
  console.log(`      当前视野 ${boundsText}${panNote.length > 0 ? `（${panNote}）` : ''}`
    + ` ｜ 放大 ${round2(zoomFactor)}× ｜ pad=${o.pad}`);
  console.log(`      绘制框 ${round2(frame.w)}×${round2(frame.h)}pt 左上角 (${round2(frame.x)}, ${round2(frame.y)})`
    + ` —— 框宽高比 = 墨卡托 ${geoAspect(fb).toFixed(4)}（**不变形**＝画布比 ${(o.w / o.h).toFixed(4)}）`);
  // **三个验收数字**（`viewMetrics`，与设备诊断行同一个函数）——
  // 这就是"地图铺满高度 / 需要横滑"这两句话的机器可读形式。
  console.log(`      **地图绘制 ${round2(vm.mapW)}×${round2(vm.mapH)}pt**`
    + ` ｜ **高/画布 = ${vm.heightRatio}**（铺满那一档必须 == 1，放大态 > 1，< 1 才是缺陷）`
    + ` ｜ **宽/画布 = ${vm.widthRatio}**（> 1 = 横向溢出 → 必须横滑）`);
  console.log(`        横向偏移（中国西缘的屏幕 x）westX = ${round2(vm.westX)}pt（负 = 在屏幕左外侧）`
    + ` ｜ eastX = ${round2(vm.eastX)} ｜ northY = ${round2(vm.northY)}`
    + ` ｜ 可横滑 ${round2(vm.panSlackX)}pt ｜ 视野经度跨度 ${round2(vm.lonSpan)}°`);
  console.log(`        屏内**照片** ${insideCount[0]} 张 / 屏外 ${insideCount[1]} 张`
    + ` ｜ 屏内**钉子** ${pins.filter((p) => p.x >= 0 && p.x <= o.w && p.y >= 0 && p.y <= o.h).length} 个 / 共 ${pins.length} 个`
    + `${dataSpan <= vm.lonSpan + 1e-9 ? '（数据装得下一屏 → **钉子必须全部在屏内**，脚本自检）'
      : `（数据 ${round2(dataSpan)}° 比一屏 ${round2(vm.lonSpan)}° 宽 → 只能"尽可能多"，见报告 §6）`}`);
  console.log(`      zoom=${o.zoom}${o.zoom < MIN_ZOOM_FOR_EXPAND ? '（< 展开阈值：全部收成光点）' : ''} ｜ 图例 ${o.footer}pt`);
  if (o.zoomout) {
    // task-19 的判据：缩到底**必须**是"完整的中国纬度"（[18,54] 逐位），经度跨度 == 一屏；
    // 而且**从默认视野再缩一次必须一动不动**（下界是可达的终点）。
    const cb: number[] = CHINA_REGION.bounds;
    const latExact: boolean = bounds[1] === cb[1] && bounds[3] === cb[3];
    const latOk: boolean = bounds[1] >= cb[1] - 1e-9 && bounds[3] <= cb[3] + 1e-9;
    console.log(`--zoomout：从默认视野 ${defaultText} 先放大 6 步（×2，不动点 0.3,0.7）→ ${zoomInNote.map(round2).join(',')}`);
    console.log(`        再一路捏合缩回下界（${zoomSteps} 步 × 0.5，绕中心）→ ${boundsText}`);
    console.log(`        缩到底的纬度 = [${bounds[1]}, ${bounds[3]}] ｜ **== [18,54] 逐位** = ${latExact}`
      + ` ｜ 纬度 ⊆ [18,54] = ${latOk}（真机旧行为是 −20.6°/南半球）`
      + ` ｜ 经度跨度 ${round2(vm.lonSpan)}° == 一屏 ${round2(oneScreenSpan)}° = ${Math.abs(vm.lonSpan - oneScreenSpan) < 1e-9}`);
    console.log(`        下界是**终点**：从默认视野再缩一次逐位不动 = ${pureOutSame}`
      + ` ｜ 这一帧仍然铺满高度（高/画布 = ${vm.heightRatio}）`);
  }
  if (o.pan.length > 0) {
    // 横滑前后：**跨度一点没变**（所以比例、铺满都不变），变的只有窗口位置 —— 这就是"溢出"的证据。
    const dVm: ViewMetrics = viewMetrics(mapFrame(o.w, o.h, defaultBounds));
    console.log(`--pan=${o.pan}：从默认视野 ${defaultText} 横滑`
      + `（panViewBy(±50, 0)，与设备上"手指一直往一个方向拖"同一条路径）`);
    console.log(`        默认：bounds ${defaultText} ｜ 西缘 x=${round2(dVm.westX)} 东缘 x=${round2(dVm.eastX)}`);
    console.log(`        滑后：bounds ${boundsText} ｜ 西缘 x=${round2(vm.westX)} 东缘 x=${round2(vm.eastX)}`
      + ` ｜ **跨度不变** = ${Math.abs((bounds[2] - bounds[0]) - (defaultBounds[2] - defaultBounds[0])) < 1e-9}`
      + ` ｜ 画布横向移动了 ${round2(Math.abs(vm.westX - dVm.westX))}pt`);
  }
  console.log(`国界：${outlineNote}`);
  console.log(`省界：${provinceNote}　（${PROVINCE_STROKE} ${PROVINCE_WIDTH}pt —— 与国界同色、线宽是它的 ${PROVINCE_WIDTH}/0.8）`);
  console.log(`轨迹：${track.length} 个钉子按拍摄时间连线${track.length < 2 ? '（少于 2 个钉子，不成线）' : ''}`);
  console.log(`钉子 ${pins.length} 个（轨迹序 = 时间正序，时间未知的排最后）：`);
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    const off = p.x < 0 || p.x > o.w || p.y < 0 || p.y > o.h ? '  ← 画布外' : '';
    const m: PinMarker[] = p.markers;
    const tail = p.photos.length > m.length ? `（还有 ${p.photos.length - m.length} 张画成 +N）` : '';
    console.log(`  #${String(i).padStart(2)} ${p.name.padEnd(22)} (${String(p.x).padStart(6)}, ${String(p.y).padStart(6)})`
      + ` ${m.length > 0 ? '标记' : '光点'} ${String(m.length).padStart(2)}/${String(p.photos.length).padStart(2)} 张`
      + ` 簇宽 ${(m.length > 0 ? (m[m.length - 1].dx - m[0].dx).toFixed(2) : '0.00').padStart(5)}`
      + ` 最远 dy ${(m.length > 0 ? m[0].dy : 0).toFixed(2)}`
      + ` 时间未知 ${p.photos.filter((x) => !(x.takenAt > 0)).length} 张${tail}${off}`);
  }
  const hidden = loaded.photos.length - onWall;
  console.log(`没有地点的照片 ${hidden} 张（不上墙）`);
  console.log(`**标记 ${drawn} 个 / 上墙 ${onWall} 张**：${onWall - drawn} 张画成「＋N」（${clippedPins} 个钉子有 ＋N）`
    + ` —— 照片一张都没丢，点开钉子在底部详情面板里逐张看（设备侧 72×92 + 日期）`);
  console.log(`画布外（按原始坐标算、判据是**画布**而不是绘制框，不受聚簇影响）${outside.length} 张：${outside.length === 0 ? '（无）' : outside.join('、')}`);
  console.log(`**标记坐标表（n=1..${MAX_MARKERS + 3}；相对钉子的 pt）** —— 每一个都贴着钉子：`);
  for (let n = 1; n <= MAX_MARKERS + 3; n++) {
    const ms: PinMarker[] = pinMarkers(n);
    const cells: string[] = ms.map((v) => `(${v.dx.toFixed(2)},${v.dy.toFixed(2)})`);
    console.log(`  n=${n}  → ${String(ms.length).padStart(2)} 个`
      + `${ms.length < n ? `（截断，画 ＋${n - ms.length}）` : '　　　　　　'} ${cells.join(' ')}`);
  }
  // 整簇的包围盒：横向 = 最左到最右（含两端半径）；纵向 = 最高到最低那个标记（含半径）。
  // ⚠️ 纵向**不是** `2×MARKER_DY`：弧让中间那个更低、两端更高，所以整簇高度比"上下各 5pt"小。
  const clusterW: number = (MAX_MARKERS - 1) * MARKER_STEP + MARKER_R * 2;
  let mMinY: number = Number.POSITIVE_INFINITY;
  let mMaxY: number = Number.NEGATIVE_INFINITY;
  for (const m of pinMarkers(MAX_MARKERS)) {
    if (m.dy < mMinY) { mMinY = m.dy; }
    if (m.dy > mMaxY) { mMaxY = m.dy; }
  }
  const markerTop: number = mMinY - MARKER_R;              // 整簇最高点（相对钉子）
  const markerBottom: number = mMaxY + MARKER_R;           // 整簇最低点
  console.log(`  整簇包围盒 = **${round2(clusterW)} × ${round2(markerBottom - markerTop)}pt**`
    + `（相对钉子：横向 ±${round2(clusterW / 2)}，纵向 ${round2(markerTop)} → ${round2(markerBottom)}）`
    + ` ｜ 旧形态一张卡片 = 26×34pt，9 张要 271.6×47pt`);
  console.log(`  与钉点的关系：最近圆心距 ${round2(MARKER_DY)}pt ≥ 钉半径（点不盖住钉心）；`
    + `两簇之间（钉子间距 40pt）至少余 ${round2(40 - clusterW)}pt`);
  // 「＋N」角标的位置核对：它与最右那个标记对齐、且在整簇之下（与设备侧共用 badgeRectOf）
  for (const p of pins) {
    if (p.photos.length <= p.markers.length) { continue; }
    const b = badgeRectOf(p, p.markers);
    console.log(`  ＋N 角标示例 @${p.name}：矩形 (${round2(b.x)},${round2(b.y)}) ${b.w}×${b.h}`
      + ` ｜ 右缘 ${round2(b.x + b.w)} == 钉子 x ${p.x} + 最右标记 ${round2(p.markers[p.markers.length - 1].dx)} + R ${MARKER_R} = ${round2(p.x + p.markers[p.markers.length - 1].dx + MARKER_R)}`
      + ` ｜ 在整簇之下 = ${b.y >= p.y + p.markers[0].dy + MARKER_R - 1e-9}`);
    break;
  }
  const st = fs.statSync(o.out);
  console.log(`✓ ${path.relative(REPO, o.out)}  ${st.size} 字节`);
  return 0;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

process.exitCode = main();
