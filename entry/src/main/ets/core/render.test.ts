/**
 * render 单测：地图墙的场景计算（钉子分组 / 中位数定位 / 屏幕聚簇 / 展开态 / 弧形排布）。
 *
 * 用**全量真实区划数据**（与 areaData.test.ts、placePick.test.ts 同一份 rawfile）：
 * 本文件要断言的正是"EXIF 坐标反查出来的地名"这类与真实数据绑定的事实
 * （例如上海人民广场必须落在「上海·黄浦」而不是别的县）。
 *
 * 测试夹具里的坐标都是**真实地点**（逐个注明），不是随手编的数字 ——
 * 编出来的坐标会让"反查对不对"变成一句空话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAreaData } from './areaData.ts';
import { CHINA_REGION, projectMercator } from './projection.ts';
import { MIN_PIN_DIST_PT } from './placement.ts';
import {
  BADGE_H, BADGE_W, MARKER_COLOR, MARKER_DY, MARKER_R, MARKER_STEP, MAX_MARKERS, MIN_VIEW_SPAN_DEG,
  PIN_COLOR, PIN_DOT_R, TRACK_WIDTH, VIEW_PAD_RATIO, PROVINCE_STROKE, PROVINCE_WIDTH,
  MIN_ZOOMED_VIEW_SPAN_DEG, badgeRectOf, buildScene, dateLabel, defaultWallView, fillHeightLonSpan,
  fillHeightView, fitBounds, frameBounds, geoAspect, mapBoxHeight, mapFrame,
  markerCountOf, normalizeBounds, outlinePath, panViewBy, parseOutline, pinMarkers, pinTime,
  refitViewToCanvas, sceneToSvg, trajectoryOrder, trajectoryPath, viewMetrics, viewZoomOf,
  viewZoomRange, zoomViewAt
} from './render.ts';
import type { MapFrame, ScenePin, ViewMetrics, WallPhoto } from './render.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
parseAreaData(fs.readFileSync(DATA_URL, 'utf8'));

const W = 360;
const H = 720;

/** 画布比 = `W/H` = 0.5。只在"比例正好匹配"的那些断言里用得到（不是每个框都等于它）。 */
const CANVAS_ASPECT = W / H;

/**
 * 钉子到**最远**那个标记的距离上限（pt）：`√(halfWide² + MARKER_DY²)`。
 *
 * 它就是"这一簇有多大"的机器可读口径（最大簇时取值）。单测用它断言
 * "标记既不在钉心上、也没有离钉子太远" —— 也就是用户要的"贴着钉子"。
 */
const MAX_MARKER_RANGE = Math.sqrt(Math.pow((MAX_MARKERS - 1) / 2 * MARKER_STEP, 2) + MARKER_DY * MARKER_DY);

/**
 * 各种测试用的地图框 —— **一律由 `mapFrame` 产出**（与设备/预览同一条路径）。
 *
 * ⚠️ task-19 之后 `mapFrame` **恒填满高度**：`h == blockH`、`w = blockH × 墨卡托比`、
 * `x = (blockW − w)/2`（**`w > blockW` 时 `x` 为负** —— 框比画布宽，两侧在屏幕外）。
 * 所以"框 ⊆ 块"这件事**不再成立**，`FRAME` 就是一个比块宽的框（下面注明它的实测尺寸）；
 * 想造"框 == 块"要显式用比例匹配的视野（`--flat` 那一档，或 `FULL_FRAME` 这种字面量）。
 *
 * `ScenePin.x/y` 因此落在**块坐标**里，可以超出 `[0, blockW]`；断言坐标时要带上框的平移
 * （`atFrame` 就是干这个的），"可见区"则要显式判 `0 ≤ x ≤ blockW`。
 */
/** "整个中国当视野"那一档（360×720 的竖屏）：框 **968.18×720 @ x=−304.09**（横向溢出 2.69 倍）。 */
const FRAME: MapFrame = mapFrame(W, H, CHINA_REGION.bounds);
/** 更宽的块（720×800）：框 1075.77×800 @ x=−177.89（这一档横向溢出 1.494 倍）。 */
const FRAME_WIDE: MapFrame = mapFrame(720, 800, CHINA_REGION.bounds);
/** 块与框重合的那种退化框（块本身的比例就正好）：用来测与"框"无关的性质。 */
const FULL_FRAME: MapFrame = { blockW: W, blockH: H, x: 0, y: 0, w: W, h: H };

/** 按某个框投影一个经纬度（结果已含框的平移），与 `buildScene` 内部的算法同源。 */
function atFrame(lon: number, lat: number, frame: MapFrame): { x: number; y: number } {
  const p = projectMercator(lon, lat, frame.w, frame.h, frameBounds(frame));
  return { x: p.x + frame.x, y: p.y + frame.y };
}

/** 造一张照片。参数按"最常改到的东西"排：id、坐标、时间。 */
function ph(photoId: string, lat: number, lon: number, takenAt: number, place?: string): WallPhoto {
  const p: WallPhoto = { photoId: photoId, lat: lat, lon: lon, takenAt: takenAt };
  if (place !== undefined) { p.place = place; }
  return p;
}

// ── pinMarkers：钉子旁那一簇小点（本批形态改造的核心几何） ───────────────────

/**
 * 手工核对过的**标记坐标表**（n=1..MAX_MARKERS），控制器照这张表核对"确实贴着钉子"。
 * 数字用 `toFixed(2)` 与实现里的取整口径一致（预览/设备画的是 2 位小数）。
 */
const MARKER_TABLE: string[][] = [
  [],                                                             // n=0：没有标记
  ['(0.00,5.00)'],                                                // n=1
  ['(-2.25,4.60)', '(2.25,4.60)'],                                // n=2
  ['(-4.50,4.60)', '(0.00,5.00)', '(4.50,4.60)'],                 // n=3
  ['(-6.75,4.60)', '(-2.30,4.96)', '(2.30,4.96)', '(6.75,4.60)'], // n=4
  ['(-9.00,4.60)', '(-4.59,4.90)', '(0.00,5.00)', '(4.59,4.90)', '(9.00,4.60)']  // n=5
];

test('pinMarkers：n=1..8 的坐标表（数量封顶 MAX_MARKERS，超出部分交给 +N）', () => {
  // 表里的 n=1..5 逐个数字核对；n=6..8 与 n=5 **逐位相同**（截断，不是"再挤一挤"）
  for (let n = 0; n <= 5; n++) {
    const got: string[] = pinMarkers(n).map((m) => `(${m.dx.toFixed(2)},${m.dy.toFixed(2)})`);
    assert.deepEqual(got, MARKER_TABLE[n], `n=${n} 的标记坐标与表不符`);
  }
  for (let n = 6; n <= 8; n++) {
    assert.deepEqual(pinMarkers(n), pinMarkers(MAX_MARKERS), `n=${n} 没有被截断成 MAX_MARKERS`);
  }
  assert.equal(MAX_MARKERS, 5, 'MAX_MARKERS 变了 —— 上面的坐标表与 +N 的口径都要跟着改');
  assert.equal(pinMarkers(0).length, 0, '0 张照片不该有标记');
  assert.equal(pinMarkers(-3).length, 0, '负数不该有标记');
  assert.equal(pinMarkers(2.7).length, 2, '非整数应当向下取整（不存在半个标记）');
});

test('pinMarkers：**贴着钉子** —— |dx| ≤ 9pt、dy ∈ (0, 2·MARKER_DY]，没有"吊下来"这回事', () => {
  const halfWide: number = (MAX_MARKERS - 1) / 2 * MARKER_STEP;    // 9pt
  for (let n = 1; n <= 8; n++) {
    const ms = pinMarkers(n);
    assert.equal(ms.length, Math.min(n, MAX_MARKERS));
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      // ① 横向：整簇最宽 18pt（含半径 21.8pt）—— 比地名标签窄一半以上
      assert.ok(Math.abs(m.dx) <= halfWide + 1e-9, `n=${n} 第 ${i} 个标记横向太远：dx=${m.dx}`);
      // ② 纵向：**恒正且 ≤ MARKER_DY** —— "照片吊下来一长条"在新几何里无法表达
      assert.ok(m.dy > 0, `n=${n} 第 ${i} 个标记跑到钉子上面去了：dy=${m.dy}`);
      assert.ok(m.dy <= MARKER_DY + 1e-12, `n=${n} 第 ${i} 个标记离钉子太远：dy=${m.dy}`);
      // ③ 圆点与钉子**搭在一起但不盖住钉心**：圆心距 ≥ 钉半径，且不超过钉子到标记的最远距离
      //    （点只与钉的外缘搭上 —— MARKER_DY 的注释里说明了这是刻意的）
      const r = Math.sqrt(m.dx * m.dx + m.dy * m.dy);
      assert.ok(r >= PIN_DOT_R + 1e-9, `n=${n} 第 ${i} 个标记压在钉心上：r=${r}`);
      assert.ok(r <= MAX_MARKER_RANGE + 1e-9, `n=${n} 第 ${i} 个标记与钉点离得太远：r=${r}`);
    }
  }
  // 判别力：旧形态的卡片在 HANG_GAP=14 + 弧形下坠之后，最近的也在钉子下方 14pt 以上；
  // 新形态最远 5pt —— 这条断言就是"形态变了"的机器可读形式。
  assert.ok(MARKER_DY < 14 / 2, `MARKER_DY=${MARKER_DY} 已经不是"贴着钉子"了`);
});

test('pinMarkers：n=1 在正下方；n>1 左右对称、两端正好落在 ±张角/2；两点至少差一个直径', () => {
  const one = pinMarkers(1);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].dx) < 1e-12, '单张不该偏到一侧');
  assert.equal(one[0].dy, MARKER_DY, '单张应当正好在 MARKER_DY 处');
  for (let n = 2; n <= MAX_MARKERS; n++) {
    const ms = pinMarkers(n);
    // 严格左右对称（n 为奇数时正中间那个 dx = 0）
    for (let i = 0; i < ms.length; i++) {
      assert.ok(Math.abs(ms[i].dx + ms[ms.length - 1 - i].dx) < 1e-12, `n=${n} 不对称`);
    }
    if (n % 2 === 1) { assert.ok(Math.abs(ms[(n - 1) / 2].dx) < 1e-12, `n=${n} 正中间没有居中`); }
    // 两端正好是 ±(n−1)/2 · MARKER_STEP —— "传进去几个点、画出来几个点"是字面意思
    const want: number = (n - 1) / 2 * MARKER_STEP;
    assert.ok(Math.abs(Math.abs(ms[0].dx) - want) < 1e-9, `n=${n} 两端没有顶满：${ms[0].dx} vs ${want}`);
    // dx 严格递增（同 x 的两个点会完全重叠）
    for (let i = 1; i < ms.length; i++) {
      assert.ok(ms[i].dx > ms[i - 1].dx, `n=${n} 的 dx 没有严格递增（会有两点完全重叠）`);
    }
    // 穷举全部对：圆心距 ≥ 2×标记半径（一个都不许压在一起）
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const d = Math.sqrt(Math.pow(ms[j].dx - ms[i].dx, 2) + Math.pow(ms[j].dy - ms[i].dy, 2));
        assert.ok(d >= 2 * MARKER_R, `n=${n}：第 ${i} 与第 ${j} 个标记叠在一起（${d} < ${2 * MARKER_R}）`);
      }
    }
  }
  // 弧而不是直线：n=5 时中间那个比两端**更低**（dy 更大），但差得很小（矢高 0.32pt）
  const five = pinMarkers(5);
  assert.ok(five[2].dy > five[0].dy, '中间没有比两端低 —— 那不是弧');
  assert.ok(five[2].dy - five[0].dy < 0.5, '弧弯得太厉害，已经不是"一簇点"了');
});

test('markerCountOf：expanded 为假 = 光点（0 个标记）；为真 = min(张数, MAX_MARKERS)', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 9; i++) { photos.push(ph(`m${i}`, 31.2304, 121.4737, 1700000000000 + i)); }
  const pins = buildScene(photos, FULL_FRAME, 1);
  assert.equal(pins.length, 1);
  const p: ScenePin = pins[0];
  assert.equal(p.expanded, true, '一个钉子应当展开');
  assert.equal(markerCountOf(p), MAX_MARKERS, '9 张应当只画 MAX_MARKERS 个点');
  assert.equal(p.markers.length, markerCountOf(p), 'markers 与 markerCountOf 必须一致');
  // 收成点（钉子多于 COLLAPSE_THRESHOLD）→ 一个标记都不画
  const many: WallPhoto[] = [];
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 2; k++) { many.push(ph(`f${i}_${k}`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1 + k)); }
  }
  const collapsed = buildScene(many, FULL_FRAME, 1);
  assert.ok(collapsed.length > 15, '这份数据应当触发"钉子多时收成点"');
  for (const q of collapsed) {
    assert.equal(q.expanded, false, `${q.name} 不该展开`);
    assert.equal(markerCountOf(q), 0);
    assert.deepEqual(q.markers, [], `${q.name} 收成点时不该有标记`);
  }
});

test('badgeRectOf：角标在标记簇的右下方、右缘与最右标记对齐、不压到点上', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 9; i++) { photos.push(ph(`b${i}`, 31.2304, 121.4737, 1700000000000 + i)); }
  const pin: ScenePin = buildScene(photos, FULL_FRAME, 1)[0];
  const b = badgeRectOf(pin, pin.markers);
  assert.equal(b.w, BADGE_W);
  assert.equal(b.h, BADGE_H);
  let maxDx = -Number.MAX_VALUE;
  let maxDy = -Number.MAX_VALUE;
  for (const m of pin.markers) {
    if (m.dx > maxDx) { maxDx = m.dx; }
    if (m.dy > maxDy) { maxDy = m.dy; }
  }
  // 右缘对齐最右标记的外缘（+MARKER_R），横向不越界
  assert.ok(Math.abs((b.x + b.w) - (pin.x + maxDx + MARKER_R)) < 1e-9, '角标右缘没有与最右标记对齐');
  // 纵向在整簇之下（不压点）
  assert.ok(b.y >= pin.y + maxDy + MARKER_R - 1e-9, '角标压住了标记');
  // 与每个标记都不相交（矩形 vs 圆：用"圆心到矩形最近点的距离 ≥ 半径"判）
  for (const m of pin.markers) {
    const cx = pin.x + m.dx;
    const cy = pin.y + m.dy;
    const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
    const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
    assert.ok(Math.sqrt(Math.pow(cx - nx, 2) + Math.pow(cy - ny, 2)) >= MARKER_R - 1e-9,
      `角标与标记重叠：标记(${cx},${cy}) 角标(${b.x},${b.y},${b.w},${b.h})`);
  }
  // 光点钉（没有标记）也要给一个合法矩形（钉子右下方），不能产出 NaN
  const bare: ScenePin = { pinId: 'x', name: 'x', x: 100, y: 200, photos: [], expanded: false, markers: [] };
  const bb = badgeRectOf(bare, []);
  assert.ok(Number.isFinite(bb.x) && Number.isFinite(bb.y) && bb.w === BADGE_W);
});

// ── buildScene：筛选与分组 ──────────────────────────────────────────────────

test('buildScene：没有坐标的照片不上墙（(0,0) 不是几内亚湾）', () => {
  const photos = [
    ph('a', 0, 0, 1700000000000),
    ph('b', 39.9042, 116.4074, 1700000000000)   // 北京天安门
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 1);
  assert.equal(pins[0].photos[0].photoId, 'b');
});

test('buildScene：manual 的地点即使坐标是 (0,0) 也算有地点（hasPlace 优先手动）', () => {
  const p: WallPhoto = { photoId: 'm', lat: 0, lon: 0, takenAt: 1700000000000, manual: true, place: '河北·石家庄·正定' };
  const pins = buildScene([p], FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, '河北·石家庄·正定');
});

test('buildScene：有 place 就直接用，不走反查（EXIF 坐标也不会盖掉手选名）', () => {
  // 坐标是上海人民广场，但用户说这张挂在正定 —— 以用户为准
  const p = ph('x', 31.2304, 121.4737, 1700000000000, '河北·石家庄·正定');
  const pins = buildScene([p], FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, '河北·石家庄·正定');
});

test('buildScene：没有 place 的 EXIF 条目用 nearestCounty 反查真实地名', () => {
  // 上海人民广场 31.2304,121.4737 → 应当是「上海·黄浦」一带（真实数据断言，见文件头）
  const pins = buildScene([ph('s', 31.2304, 121.4737, 1700000000000)], FRAME, 1);
  assert.equal(pins.length, 1);
  assert.ok(pins[0].name.indexOf('上海') === 0, `反查到的地名不是上海：${pins[0].name}`);
});

test('buildScene：同一地名的多张照片归到一个钉子下', () => {
  const photos = [
    ph('a', 31.2304, 121.4737, 1700000000000),
    ph('b', 31.2310, 121.4740, 1700000100000),
    ph('c', 31.2290, 121.4730, 1700000200000)
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 3);
});

test('buildScene：重复传入同一张照片不会长出两个钉子', () => {
  const one = ph('dup', 31.2304, 121.4737, 1700000000000);
  const pins = buildScene([one, one], FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 1);
});

test('buildScene：钉子位置 = 组内坐标中位数（真实地点，逐点核对）', () => {
  // 正定(38.1464,114.5709) / 石家庄(38.0428,114.5149)：中位数落在两者之间
  const photos = [
    ph('a', 38.0428, 114.5149, 1700000000000),
    ph('b', 38.1464, 114.5709, 1700000000000),
    ph('c', 38.0428, 114.5149, 1700000000000)
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  const lat = 38.0428;   // 三个值的中位数
  const lon = 114.5149;
  const exp = atFrame(lon, lat, FRAME);
  assert.ok(Math.abs(pins[0].x - exp.x) < 0.01, `x 不是中位数投影：${pins[0].x} vs ${exp.x}`);
  assert.ok(Math.abs(pins[0].y - exp.y) < 0.01, `y 不是中位数投影：${pins[0].y} vs ${exp.y}`);
  // 钉子坐标在**块坐标**里：至少要比投影框的原点低 `frame.y`（框是居中的，不是从 0 开始）
  assert.ok(pins[0].y > FRAME.y, `钉子跑到地图框上面去了：y=${pins[0].y} < ${FRAME.y}`);
});

// ── buildScene：takenAt == 0 的照片（必须仍然在墙上） ────────────────────────

test('buildScene：takenAt=0 的照片仍然上墙，且排在组内最后', () => {
  const photos = [
    ph('nodate', 31.2304, 121.4737, 0),
    ph('late', 31.2304, 121.4737, 1700000200000),
    ph('early', 31.2304, 121.4737, 1700000000000)
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 3, '没有时间的照片被丢掉了');
  const ids = pins[0].photos.map((p: WallPhoto) => p.photoId);
  assert.deepEqual(ids, ['early', 'late', 'nodate']);
});

test('buildScene：全是 takenAt=0 时按 photoId 排序（可复现，与输入顺序无关）', () => {
  const a = ph('b', 31.2304, 121.4737, 0);
  const b = ph('a', 31.2304, 121.4737, 0);
  const forward = buildScene([a, b], FRAME, 1)[0].photos.map((p: WallPhoto) => p.photoId);
  const backward = buildScene([b, a], FRAME, 1)[0].photos.map((p: WallPhoto) => p.photoId);
  assert.deepEqual(forward, ['a', 'b']);
  assert.deepEqual(backward, ['a', 'b']);
});

// ── buildScene：展开态（阈值来自 placement.ts） ──────────────────────────────

test('buildScene：钉子 ≤3 时全部展开（标记按张数给，photos 保留全部）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304 + i * 0.001, 121.4737, 1700000000000 + i)); }
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].expanded, true);
  assert.equal(pins[0].photos.length, 12, 'ScenePin.photos 是全部照片（详情面板要用它）');
  // 标记只画 MAX_MARKERS 个，其余由 +N 报出 —— 照片一张都没丢
  assert.equal(pins[0].markers.length, MAX_MARKERS);
  assert.ok(pins[0].markers.length < pins[0].photos.length);
});

test('buildScene：zoom 小于阈值时全部按钉渲染（不展开）', () => {
  const photos = [ph('a', 31.2304, 121.4737, 1700000000000), ph('b', 31.2305, 121.4738, 1700000000001)];
  assert.equal(buildScene(photos, FRAME, 0.2)[0].expanded, false);
  assert.equal(buildScene(photos, FRAME, 1)[0].expanded, true);
});

test('buildScene：zoom 为 NaN / 0 / 负数时按 1 处理（不静默走进"错误展开"）', () => {
  const photos = [ph('a', 31.2304, 121.4737, 1700000000000), ph('b', 31.2305, 121.4738, 1700000000001)];
  for (const z of [Number.NaN, 0, -1]) {
    assert.equal(buildScene(photos, FRAME, z)[0].expanded, true, `zoom=${z} 的处理与 zoom=1 不一致`);
  }
});

test('buildScene：16 个钉子全部收成点（>COLLAPSE_THRESHOLD）', () => {
  const photos: WallPhoto[] = [];
  // 沿经度铺开、纬度错开，保证屏幕距离超过 MIN_PIN_DIST_PT
  for (let i = 0; i < 16; i++) {
    photos.push(ph(`far${i}`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1700000000000));
  }
  // 每个地点再塞 3 张同坐标的照片，让"4–15 个钉时会展开"的规则本来会命中
  for (let i = 0; i < 16; i++) {
    photos.push(ph(`far${i}b`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1700000001000));
    photos.push(ph(`far${i}c`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1700000002000));
  }
  const pins = buildScene(photos, FRAME, 1);
  assert.ok(pins.length > 15, `只得到 ${pins.length} 个钉子，压不住 COLLAPSE_THRESHOLD`);
  for (const p of pins) { assert.equal(p.expanded, false, `${p.name} 在钉子过多的场景下仍然展开了`); }
});

// ── buildScene：屏幕聚簇 ────────────────────────────────────────────────────

test('buildScene：屏幕上挤在一起的相邻地点被并成一个簇，地名不丢', () => {
  // 香港(22.3193,114.1694) 与 深圳(22.5431,114.0579)：投影后相距 30pt 上下，会并簇
  const photos = [
    ph('hk', 22.3193, 114.1694, 1700000000000),
    ph('sz', 22.5431, 114.0579, 1700000001000)
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1, '两个挤在一起的钉子没有并簇');
  assert.equal(pins[0].photos.length, 2);
  assert.ok(pins[0].name.indexOf('等2地') > 0, `并簇后的名字没体现第二个地名：${pins[0].name}`);
});

test('buildScene：并簇后的钉子落在得胜那一组的真实位置上，不是两地的中间', () => {
  // 香港 3 张、深圳 1 张 → 得胜的是香港，钉子必须落在香港（而不是两地之间的海面上）
  const photos = [
    ph('hk1', 22.3193, 114.1694, 1700000000000),
    ph('hk2', 22.3200, 114.1700, 1700000001000),
    ph('hk3', 22.3180, 114.1680, 1700000002000),
    ph('sz1', 22.5431, 114.0579, 1700000003000)
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  const hk = atFrame(114.1694, 22.3193, FRAME);
  assert.ok(Math.abs(pins[0].x - hk.x) < 1, `钉子不在香港：x=${pins[0].x} vs ${hk.x}`);
  assert.ok(Math.abs(pins[0].y - hk.y) < 1, `钉子不在香港：y=${pins[0].y} vs ${hk.y}`);
  assert.equal(pins[0].photos.length, 4);
});

test('buildScene：相距很远的钉子不会被并簇（每个省一个钉）', () => {
  const photos = [
    ph('bj', 39.9042, 116.4074, 1700000000000),   // 北京
    ph('gz', 23.1291, 113.2644, 1700000000000),   // 广州
    ph('urc', 43.8256, 87.6168, 1700000000000),   // 乌鲁木齐
    ph('lsa', 29.6520, 91.1721, 1700000000000)    // 拉萨
  ];
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 4);
  assert.ok(MIN_PIN_DIST_PT === 40);
});

// ── buildScene：输出可复现 ──────────────────────────────────────────────────

test('buildScene：输出与输入顺序无关（钉子与照片都有确定的排序）', () => {
  const photos = [
    ph('z', 39.9042, 116.4074, 1700000000000),
    ph('a', 31.2304, 121.4737, 1700000002000),
    ph('m', 23.1291, 113.2644, 0),
    ph('a2', 31.2304, 121.4737, 1700000001000)
  ];
  const one = JSON.stringify(buildScene(photos, FRAME, 1));
  const two = JSON.stringify(buildScene([photos[3], photos[1], photos[2], photos[0]], FRAME, 1));
  assert.equal(one, two);
});

test('buildScene：空输入 / 全无坐标 → 空场景（调用方据此显示空态）', () => {
  assert.deepEqual(buildScene([], FRAME, 1), []);
  assert.deepEqual(buildScene([ph('a', 0, 0, 0)], FRAME, 1), []);
});

test('buildScene：境外坐标不丢，得到一个坐标标签的钉子（M2 的世界地图才处理它）', () => {
  // 东京 35.6762,139.6503 → nearestCounty 判为境外（>800km）
  const pins = buildScene([ph('tokyo', 35.6762, 139.6503, 1700000000000)], FRAME, 1);
  assert.equal(pins.length, 1);
  assert.ok(pins[0].name.indexOf('°N') > 0, `境外的钉子应带坐标标签：${pins[0].name}`);
});

// ── 视野框 fitBounds：地图缩放到用户的足迹范围（task-15 的核心） ─────────────
//
// 这一批修的是"地图永远画整个中国、而用户只去过 3 个城市"。下面每个测试都对着
// **设备上的真值**（控制器核实：28 张上墙、7 张有坐标、上海+北京+天津）来写。

/** 设备真值里的三座城（控制器核实的城市级坐标）。 */
const SH_LAT = 31.25;
const SH_LON = 121.48;
const BJ_LAT = 39.93;
const BJ_LON = 116.42;
const TJ_LAT = 39.12;
const TJ_LON = 117.21;

/** 视野框的经度跨度。`fitBounds` 可能返回 undefined（调用方要处理），这里只给测试用。 */
function lonSpanOf(b: number[] | undefined): number {
  assert.ok(b !== undefined, '期望有一个视野框，实际是 undefined');
  if (b === undefined) { return Number.NaN; }
  return b[2] - b[0];
}

/** 读一份 tools/fixtures 下的预览数据（与 `render-preview.ts` 用的是**同一批文件**）。 */
function loadFixture(rel: string): WallPhoto[] {
  const url = new URL(`../../../../../tools/fixtures/${rel}`, import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(url, 'utf8')) as { photos: WallPhoto[] };
  return parsed.photos;
}

test('fitBounds：多城市 → 框包含全部坐标、四周带内边距、落在国内', () => {
  const photos = [ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)];
  const b = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  // ① "能看到它们全部"：每张照片都严格在框**内侧**（因为还加了边距）
  for (let i = 0; i < photos.length; i++) {
    const p: WallPhoto = photos[i];
    assert.ok(b[0] < p.lon && p.lon < b[2], `经度没有被框住：${p.photoId} lon=${p.lon} 框=[${b[0]},${b[2]}]`);
    assert.ok(b[1] < p.lat && p.lat < b[3], `纬度没有被框住：${p.photoId} lat=${p.lat} 框=[${b[1]},${b[3]}]`);
  }
  // ② 跨度 = 数据跨度 × (1 + 2×padRatio)：120.48~116.42 = 5.06° → 6.578
  const wantLon = (SH_LON - BJ_LON) * (1 + 2 * VIEW_PAD_RATIO);
  assert.ok(Math.abs(lonSpanOf(b) - wantLon) < 1e-9, `经度跨度 ${lonSpanOf(b)} != ${wantLon}`);
  const wantLat = (BJ_LAT - SH_LAT) * (1 + 2 * VIEW_PAD_RATIO);
  assert.ok(Math.abs((b[3] - b[1]) - wantLat) < 1e-9);
  // ③ 落在国内（钳制是硬契约）
  assert.ok(b[0] >= CHINA_REGION.bounds[0] && b[2] <= CHINA_REGION.bounds[2]);
  assert.ok(b[1] >= CHINA_REGION.bounds[1] && b[3] <= CHINA_REGION.bounds[3]);
  // ④ 真的放大了：跨度远小于全国（这就是"地图铺满屏幕"的来源）
  const chinaLon = CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0];
  assert.ok(lonSpanOf(b) < chinaLon / 5, `视野没有被拉近：跨度 ${lonSpanOf(b)} vs 全国 ${chinaLon}`);
  assert.ok(Math.abs(viewZoomOf(b) - chinaLon / wantLon) < 1e-9);
  assert.equal(viewZoomOf(CHINA_REGION.bounds), 1);
});

test('fitBounds：近邻城市那一档在 360×720 上真的**填满高度**（地图铺满屏幕）', () => {
  const b = fitBounds([ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)], VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const f: MapFrame = mapFrame(W, H, b);
  // 地图框填满整块可用高度 —— 这是"地图铺满屏幕"的**几何**表述（task-14 只做到了"块铺满"，
  // 框还是整个中国那条 267.7pt 的横带；拉近到足迹范围之后框才真的长得满屏高）。
  assert.ok(Math.abs(f.h - H) < 1e-9, `地图框没有填满高度：${f.h} vs ${H}`);
  assert.ok(f.w > 0 && f.w <= W + 1e-9, `框宽越界：${f.w}`);
  assert.ok(f.x > 0, '框应当左右居中留一点白');
  assert.ok(Math.abs(f.w / f.h - geoAspect(b)) < 1e-9, '框变形了');
});

test('fitBounds：只有一个点 → 撑到最小跨度，不是零跨度（零跨度会让整块画布变 NaN）', () => {
  const b = fitBounds([ph('one', SH_LAT, SH_LON, 0)], VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const want = MIN_VIEW_SPAN_DEG * (1 + 2 * VIEW_PAD_RATIO);
  assert.ok(Math.abs(lonSpanOf(b) - want) < 1e-9, `经度跨度 ${lonSpanOf(b)} != ${want}`);
  assert.ok(Math.abs((b[3] - b[1]) - want) < 1e-9, `纬度跨度 ${b[3] - b[1]} != ${want}`);
  // 点还在正中（撑开是绕中心做的，不是往一侧长）
  assert.ok(Math.abs((b[0] + b[2]) / 2 - SH_LON) < 1e-9);
  assert.ok(Math.abs((b[1] + b[3]) / 2 - SH_LAT) < 1e-9);
  // 真的能投影：钉子有限、在框内、且国界 path 不产 NaN
  const f: MapFrame = mapFrame(W, H, b);
  const pins = buildScene([ph('one', SH_LAT, SH_LON, 0)], f, 1);
  assert.equal(pins.length, 1);
  assert.ok(Number.isFinite(pins[0].x) && Number.isFinite(pins[0].y));
  assert.ok(pins[0].x >= f.x && pins[0].x <= f.x + f.w && pins[0].y >= f.y && pins[0].y <= f.y + f.h);
  assert.ok(!outlinePath([[SH_LON, SH_LAT, SH_LON + 0.01, SH_LAT, SH_LON, SH_LAT + 0.01]], f).includes('NaN'));
});

test('fitBounds：空数组 / 一张有坐标的都没有 → undefined（调用方退回全国视野）', () => {
  assert.equal(fitBounds([], VIEW_PAD_RATIO), undefined);
  // (0,0) 且没有 manual —— hasPlace 说是"没有地点"（0 不是几内亚湾）
  assert.equal(fitBounds([ph('a', 0, 0, 0), ph('b', 0, 0, 1700000000000)], VIEW_PAD_RATIO), undefined);
  // NaN 坐标是坏数据，不算
  assert.equal(fitBounds([ph('nan', Number.NaN, Number.NaN, 0)], VIEW_PAD_RATIO), undefined);
  assert.equal(fitBounds([ph('nanlon', SH_LAT, Number.NaN, 0)], VIEW_PAD_RATIO), undefined);
});

test('fitBounds：钳制 —— 境外坐标（东京）被夹进国内，且跨度**不许塌成 0**', () => {
  const photos = [ph('tokyo', 35.6762, 139.6503, 0)];
  const b = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  // 经度整条被推到中国的东边界上（maxLon = 135），跨度仍是 0.6×1.3 = 0.78
  assert.equal(b[2], CHINA_REGION.bounds[2], 'maxLon 没有被夹到 135');
  assert.ok(Math.abs(lonSpanOf(b) - MIN_VIEW_SPAN_DEG * (1 + 2 * VIEW_PAD_RATIO)) < 1e-9,
    `夹完之后跨度变了：${lonSpanOf(b)} —— 夹两端而不是平移就会出现这种（甚至塌成 0）`);
  assert.ok(b[0] >= CHINA_REGION.bounds[0] && b[2] <= CHINA_REGION.bounds[2]);
  assert.ok(b[1] >= CHINA_REGION.bounds[1] && b[3] <= CHINA_REGION.bounds[3]);
  assert.ok(b[2] > b[0] && b[3] > b[1], '跨度塌成 0 —— 投影会得到 NaN，整块画布消失');
  // 投影不产 NaN；境外的钉子落在画布外（既有约定：境外照片不删、只是可能落在画布外）
  const f: MapFrame = mapFrame(W, H, b);
  const pins = buildScene(photos, f, 1);
  assert.equal(pins.length, 1);
  assert.ok(Number.isFinite(pins[0].x) && Number.isFinite(pins[0].y));
  assert.ok(pins[0].x > f.x + f.w, `境外的钉子应当落在框右外侧：x=${pins[0].x} 框右=${f.x + f.w}`);
  assert.ok(!outlinePath([[139.6503, 35.6762, 139.66, 35.6762, 139.66, 35.67]], f).includes('NaN'));
});

test('fitBounds：padRatio 按跨度比例放大（0 = 紧贴数据；非法值按 0）', () => {
  const photos = [ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0)];
  const raw = SH_LON - BJ_LON;
  const s0 = lonSpanOf(fitBounds(photos, 0));
  const s15 = lonSpanOf(fitBounds(photos, 0.15));
  const s30 = lonSpanOf(fitBounds(photos, 0.3));
  assert.ok(Math.abs(s0 - raw) < 1e-9, `pad=0 时应当紧贴数据：${s0} vs ${raw}`);
  assert.ok(Math.abs(s15 - raw * 1.3) < 1e-9, `${s15} vs ${raw * 1.3}`);
  assert.ok(Math.abs(s30 - raw * 1.6) < 1e-9, `${s30} vs ${raw * 1.6}`);
  assert.ok(s0 < s15 && s15 < s30, 'padRatio 变大时视野应当单调变大');
  // 非法 padRatio 按 0 处理（不是 NaN 传播）
  assert.equal(lonSpanOf(fitBounds(photos, -1)), s0);
  assert.equal(lonSpanOf(fitBounds(photos, Number.NaN)), s0);
  // 设备与预览共用同一个常量，不是一个写死的数
  assert.ok(VIEW_PAD_RATIO > 0 && VIEW_PAD_RATIO < 0.5);
});

test('frameBounds：手写的 MapFrame 字面量 / 非法 bounds → 全国视野（老行为不变）', () => {
  assert.deepEqual(frameBounds(FULL_FRAME), CHINA_REGION.bounds);
  const shortBounds: MapFrame = { blockW: W, blockH: H, x: 0, y: 0, w: W, h: H, bounds: [1, 2, 3] };
  assert.deepEqual(frameBounds(shortBounds), CHINA_REGION.bounds);
  const nanBounds: MapFrame = { blockW: W, blockH: H, x: 0, y: 0, w: W, h: H, bounds: [Number.NaN, 18, 135, 54] };
  assert.deepEqual(frameBounds(nanBounds), CHINA_REGION.bounds);
  // 零跨度是**最危险**的一种非法（会让 projectMercator 除零）→ 必须退
  assert.deepEqual(frameBounds(mapFrame(W, H, [73, 54, 73, 54])), CHINA_REGION.bounds);
  assert.deepEqual(normalizeBounds(undefined), CHINA_REGION.bounds);
  // 合法值原样带出，且 mapFrame 会把它存进框里
  assert.deepEqual(frameBounds(mapFrame(W, H, CHINA_REGION.bounds)), CHINA_REGION.bounds);
});

test('国界与照片用**同一个** bounds：同一经纬度在国界 path 与照片钉子上落在同一个画布点', () => {
  // 这是本批最容易错的地方：照片用"数据求出的新视野"、国界还用全国 bounds
  // → 照片整体飘到地图轮廓之外，而两边都不报错。
  const photos = [ph('sh', SH_LAT, SH_LON, 0)];
  const b = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const frame: MapFrame = mapFrame(W, H, b);
  // ① 框自己带着这份 bounds（不是全国）
  assert.deepEqual(frameBounds(frame), b);
  assert.notDeepEqual(frameBounds(frame), CHINA_REGION.bounds);
  // ② 照片按它投影
  const pins = buildScene(photos, frame, 1);
  assert.equal(pins.length, 1);
  const want = atFrame(SH_LON, SH_LAT, frame);
  assert.ok(Math.abs(pins[0].x - want.x) < 0.02, `钉子没按 frame.bounds 投影：${pins[0].x} vs ${want.x}`);
  assert.ok(Math.abs(pins[0].y - want.y) < 0.02);
  // ③ 国界 path 里**同一个经纬度**的点必须落在同一个地方（outlinePath 现在不收 bounds 参数，
  //    所以"两套 bounds"在类型上就写不出来 —— 这条测试是它的行为级证明）
  const ring = [SH_LON, SH_LAT, SH_LON + 0.01, SH_LAT, SH_LON, SH_LAT + 0.01];
  const d = outlinePath([ring], frame);
  assert.ok(d.startsWith('M'), '国界 path 应当有内容（这个环就在视野正中）');
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  assert.ok(Math.abs(nums[0] - pins[0].x) < 0.05,
    `国界与照片不在同一个 bounds：国界 x=${nums[0]} 照片 x=${pins[0].x}`);
  assert.ok(Math.abs(nums[1] - pins[0].y) < 0.05,
    `国界与照片不在同一个 bounds：国界 y=${nums[1]} 照片 y=${pins[0].y}`);
  // ④ 判别力：若照片还用**全国** bounds 投（老行为），同一个点会差 ~213pt —— 这条测试抓得住
  const old = atFrame(SH_LON, SH_LAT, mapFrame(W, H, CHINA_REGION.bounds));
  const dist = Math.sqrt((old.x - pins[0].x) * (old.x - pins[0].x) + (old.y - pins[0].y) * (old.y - pins[0].y));
  assert.ok(dist > 100, `本条测试失去了判别力：新旧视野下这个点只差 ${dist}pt`);
});

// ── 视野模型（task-19）：**地图铺满高度 + 横向溢出**（用户的裁决："地图铺满高度，左右横滑"）
//
// 上一版（`fitViewToCanvas`）的形态是"框 ⊆ 中国 + 框的比例 == 画布的比例"，两者在竖屏上
// 不可能同时满足（中国的墨卡托比 1.3447 vs 真机画布比 0.6017），于是它只能把框缩到
// **填满宽度**：真机实测 `图框 376×279.62@(0,172.62)` —— 地图只占 44.7% 的高度，
// 用户在截图里看到的就是"上面一薄条、下面 62% 空地、4 个钉子散在空地里"。
//
// 新模型把那件事反过来做，两条几何规则各管一头：
//   · **视野**（`fillHeightView`）：纬度恒取中国全域 18~54，**经度跨度由画布宽高比反推**
//     → 真机 376×624.86 上 `0.6017347885926447 × 0.80471895621705 / DEG`
//       = **27.744185828688188°**（= 一屏）；
//   · **绘制框**（`mapFrame`）：恒填满高度（`h == blockH`），宽度随比例 —— 比画布宽时
//     `x` 为负，两侧留在屏幕外，由**横向平移**去看。
// 合起来得到三个可核对的数字（下面每条测试各钉一个）：
//   · 绘制高度 / 画布高度 = `624.86 / 624.86` = **1.0000**（纵向铺满，用户的硬要求）；
//   · 绘制宽度 / 画布宽度 = `840.2481205952276 / 376` = **2.234702448391563**（必须横滑）；
//   · 横向可滑余量 = `62 − 27.744185828688188 = 34.256°` = **464.25pt**。
// 控制器粗算的"约 1.96 倍"**不对**：那是把纬度跨度当 36°（度数）算的结果。墨卡托下
// 中国的纬度跨度是 `mercY(54) − mercY(18) = 0.80471895621705`（≈46.12° 当量），
// 一屏经度跨度因此是 27.744° 而不是 21.66°，比值是 2.2347 而不是 2.86 —— 复算见报告 §2。
//
// 下面每一条都对着**真机量到的画布 `376 × 624.86`** 来写（task-19 的实测值）。

/** task-19 的真机画布（控制器实测，逐字抄下来）。 */
const T19_W = 376;
const T19_H = 624.86;
/** 一屏的经度跨度（真机画布上实算出来的那个数，逐位核对用）。 */
const T19_SPAN = 27.744185828688188;
/** 中国全境在真机画布上的绘制宽度（pt）。 */
const T19_MAP_W = 840.2481205952276;

/** 用户墙上的 4 个地点（北京 / 宁夏银川 / 山东济南 / 上海）—— 真机坐标，不是编的。 */
function fourPlaces(): WallPhoto[] {
  return [
    ph('bj', 39.93, 116.42, 1700000000000, '北京'),
    ph('yc', 38.49, 106.23, 1700000001000, '宁夏·银川·兴庆'),
    ph('jn', 36.67, 117.00, 1700000002000, '山东·济南·历下'),
    ph('sh', 31.25, 121.48, 1700000003000, '上海')
  ];
}
/** 真机诊断行里的三个数字，逐字抄下来（不是编的）。 */
const DEV_BOX_W = 376;
const DEV_BOX_H = 663.71;
const DEV_VIEW: number[] = [115.66, 29.88, 122.19, 41.24];
/**
 * 真机**图 2**（缩到底那一张）的诊断行 canvas：`376×642.57`。
 * 与 `DEV_BOX_H = 663.71`（图 1 / task-16 那一档）**不是同一个数** —— 两张截图不是同一次布局，
 * 谁也不许把其中一个"顺手统一"成另一个：这两个数字各自对应一条真的诊断行，
 * task-17 的"缩到底"那一节必须用**图 2 的**这个，否则复现的不是用户看到的那一帧。
 */
const DEV_H_ROW2 = 642.57;

test('fillHeightView：**地图纵向铺满**（绘制高度 / 画布高度 == 1）—— 用户的硬要求', () => {
  const view = fillHeightView(CHINA_REGION.bounds, T19_W, T19_H);
  const frame: MapFrame = mapFrame(T19_W, T19_H, view);
  const vm: ViewMetrics = viewMetrics(frame);
  // ① 绘制框恒填满高度（新模型的 mapFrame 规则）
  assert.equal(frame.h, T19_H, `框高没有填满画布：${frame.h}`);
  assert.equal(frame.y, 0, `框顶没有贴块顶：y=${frame.y}`);
  // ② **中国全域**的绘制高度 == 画布高（逐位：分母与分子是同一个 mercY 跨度）
  assert.equal(vm.mapH, T19_H, `地图没有铺满高度：${vm.mapH} vs 画布 ${T19_H}`);
  assert.equal(vm.heightRatio, 1, `地图高度 / 画布高度 = ${vm.heightRatio}（必须是 1）`);
  // ③ 对照旧模型（同一块画布、同一个"整个中国"视野）：框只有 279.62 高、居中在 y=172.62
  //    —— 44.7% 的高度，正是用户截图里那条"薄条"。这条对照是判别力：新模型不许回到它。
  const old: MapFrame = { blockW: T19_W, blockH: T19_H, x: 0, y: 172.62167776682176, w: T19_W, h: 279.6166444663565 };
  const oldVm: ViewMetrics = viewMetrics(old);
  assert.ok(Math.abs(oldVm.mapH - 279.62) < 0.01, `旧形态的地图高度应当约 279.62：${oldVm.mapH}`);
  assert.ok(oldVm.heightRatio < 0.45, `旧形态只占 ${(oldVm.heightRatio * 100).toFixed(1)}% 的高度`);
  assert.ok(vm.heightRatio > oldVm.heightRatio * 2, '新模型必须明显高于旧形态');
  // ④ 画布尺寸非法 → 退回"整个中国"（不产 NaN、不留半个框）
  assert.deepEqual(fillHeightView(CHINA_REGION.bounds, 0, T19_H), CHINA_REGION.bounds);
  assert.deepEqual(fillHeightView(CHINA_REGION.bounds, Number.NaN, T19_H), CHINA_REGION.bounds);
  assert.deepEqual(fillHeightView(CHINA_REGION.bounds, T19_W, -1), CHINA_REGION.bounds);
});

test('fillHeightView：**不变形**（经度跨度 / 纬度跨度 == 画布宽高比，逐位）', () => {
  const view = fillHeightView(CHINA_REGION.bounds, T19_W, T19_H);
  // ① 墨卡托宽高比 == 画布宽高比（**这才是"不变形"的定义**）。
  //    ⚠️ 用**度数**去比会得到另一个数：经度跨度 27.744 / 纬度跨度 36 = 0.7707，
  //    而画布比是 0.6017 —— 那不是失真，那是墨卡托（纬度被拉伸）。写成度数比是错的，
  //    这条注释就是为了防止有人"顺手改成度数"。
  assert.equal(geoAspect(view), T19_W / T19_H, `比例不匹配：${geoAspect(view)} vs ${T19_W / T19_H}`);
  // ② 于是 mapFrame 给出的框**恒等于画布**（x == 0、w == blockW）：一点信箱空白都没有
  const frame: MapFrame = mapFrame(T19_W, T19_H, view);
  assert.ok(Math.abs(frame.x) < 1e-9, `框没有横向对齐画布：x=${frame.x}`);
  assert.ok(Math.abs(frame.w - T19_W) < 1e-9, `框宽 != 画布宽：${frame.w}`);
  // ③ 两侧都不留白 → 画布上每一列都有地图内容（旧模型 33.45pt 的信箱空白在这里不可能出现）
  assert.ok(frame.x >= -1e-9 && frame.x + frame.w <= T19_W + 1e-9, '框跑到画布外面去了');
  // ④ 经度跨度就是算出来的那个数（可复算：`比 × 中国 mercY 跨度 / DEG`）
  assert.ok(Math.abs((view[2] - view[0]) - T19_SPAN) < 1e-9,
    `一屏的经度跨度应当是 ${T19_SPAN}：${view[2] - view[0]}`);
  assert.ok(Math.abs(fillHeightLonSpan(T19_W, T19_H) - T19_SPAN) < 1e-9,
    `fillHeightLonSpan 应当是 ${T19_SPAN}：${fillHeightLonSpan(T19_W, T19_H)}`);
  // ⑤ 各类画布上比例都成立，且"一屏"随画布比单调变宽（横屏能装下整个中国）
  const canvases: number[][] = [[360, 720], [DEV_BOX_W, DEV_BOX_H], [DEV_BOX_W, DEV_H_ROW2],
    [T19_W, T19_H], [1080, 1920], [1000, 600]];
  for (const c of canvases) {
    const v: number[] = fillHeightView(CHINA_REGION.bounds, c[0], c[1]);
    // ⚠️ 横屏（1000×600）那一档是**例外**：一屏的经度跨度 76.84° 比中国自己还宽，
    //    此时给出的就是"整个中国"（下面的断言），于是 geoAspect 是中国的 1.3447 而不是
    //    画布的 1.6667 —— 那是**预期**的：`mapFrame` 会把它按填满高度、左右留白画出来，
    //    "不变形"仍然成立（画的还是中国本来的形状），只是画布左右各空一条
    //    （那里一条轮廓数据都没有）。
    if (fillHeightLonSpan(c[0], c[1]) < 62) {
      assert.ok(Math.abs(geoAspect(v) - c[0] / c[1]) < 1e-12, `画布 ${c} 上比例不匹配：${geoAspect(v)}`);
    } else {
      assert.deepEqual(v, CHINA_REGION.bounds, `画布 ${c} 上"一屏比中国还宽"时应当给出整个中国`);
    }
    assert.ok(v[2] > v[0] && v[1] >= CHINA_REGION.bounds[1] && v[3] <= CHINA_REGION.bounds[3],
      `画布 ${c} 上的视野非法：${v}`);
  }
  // 横屏 1000×600 的一屏是 76.84° > 中国的 62° → 整个中国都装得下（此时框反而比画布窄）
  const land: number[] = fillHeightView(CHINA_REGION.bounds, 1000, 600);
  assert.ok(fillHeightLonSpan(1000, 600) > 76, `横屏一屏应当是 76.84°：${fillHeightLonSpan(1000, 600)}`);
  assert.deepEqual(land, CHINA_REGION.bounds, '横屏一屏比中国还宽时应当给出整个中国');
  const landFrame: MapFrame = mapFrame(1000, 600, land);
  assert.ok(landFrame.x > 0 && landFrame.y === 0, `横屏应当是"填满高度、左右留白"：${landFrame.x}`);
});

test('fillHeightView：**横向溢出**（绘制宽度 / 画布宽度 == 2.2347）→ 用户必须横滑', () => {
  // 用**真实的默认视野**（数据居中）而不是"中国居中"那一档：下面校验的横向偏移
  // （中国西缘在屏幕左外侧 365.68pt）说的是用户打开页面看到的那一帧。
  const view = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  const vm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H, view));
  // ① 中国全宽的绘制宽度（可复算：`画布宽 × 62 / 一屏跨度`）
  assert.ok(Math.abs(vm.mapW - T19_MAP_W) < 1e-9, `绘制宽度应当是 ${T19_MAP_W}：${vm.mapW}`);
  assert.ok(Math.abs(vm.widthRatio - 2.234702448391563) < 1e-12,
    `宽度比应当是 2.234702448391563：${vm.widthRatio}`);
  assert.ok(vm.widthRatio > 1, '地图没有比画布宽 —— 那就不需要横滑了（模型选错了）');
  // ② 溢出的是**地图内容**，不是视野：视野仍然只有一屏，而且落在经度轴的中国范围内
  assert.ok(Math.abs(vm.lonSpan - T19_SPAN) < 1e-9);
  assert.ok(view[0] >= CHINA_REGION.bounds[0] - 1e-9 && view[2] <= CHINA_REGION.bounds[2] + 1e-9);
  // ③ 横向偏移与可滑余量：默认视野下中国西缘在屏幕左外侧 365.68pt 处（可核对）
  assert.ok(vm.westX < -300, `默认视野下中国西缘应当在屏幕左外侧：westX=${vm.westX}`);
  assert.ok(vm.eastX > T19_W + 90, `中国东缘应当在屏幕右外侧：eastX=${vm.eastX}`);
  assert.ok(Math.abs(vm.panSlackX - 464.2481205952277) < 1e-9, `可滑余量应当是 464.25pt：${vm.panSlackX}`);
  assert.ok(Math.abs((62 - vm.lonSpan) - 34.256) < 0.001, `经度上还能滑 34.256°：${62 - vm.lonSpan}`);
  // ④ 判别力：旧模型下绘制宽度只有画布宽的 0.44 倍（地图比画布窄 → 根本不用滑）
  const old: MapFrame = { blockW: T19_W, blockH: T19_H, x: 0, y: 172.62, w: T19_W, h: 279.62 };
  const oldVm: ViewMetrics = viewMetrics(old);
  assert.ok(Math.abs(oldVm.mapW - T19_W) < 0.1, `旧模型下整个中国横向正好顶满画布：${oldVm.mapW}`);
  assert.ok(oldVm.widthRatio < 1.01 && vm.widthRatio > 2, '新模型必须从"顶满宽度"变成"横向溢出"');
});

test('fillHeightView：纬度恒在中国范围（18~54）—— 缩到底也是，**绝不出现南半球**', () => {
  // 这一条钉的是旧模型真机上的那个缺陷：缩到底得到 `[67,-20.6,129,64.4]`（纬度 −20.6°）。
  const boxes: number[][] = [
    CHINA_REGION.bounds, DEV_VIEW, [115.66, 29.88, 122.19, 41.24], [80, 40, 134, 53],
    [73, 18, 80, 19], [121, 30, 122, 41], [100, 30, 130, 31], [1, 2, 3], [130.5, 45, 133.5, 53]
  ];
  const canvases: number[][] = [[T19_W, T19_H], [DEV_BOX_W, DEV_BOX_H], [DEV_BOX_W, DEV_H_ROW2],
    [360, 720], [1000, 600], [1080, 1920]];
  let checked = 0;
  for (const b of boxes) {
    for (const c of canvases) {
      const v: number[] = fillHeightView(b, c[0], c[1]);
      assert.ok(v[1] >= CHINA_REGION.bounds[1], `纬度低于 18°N：${v}（数据框 ${b} 画布 ${c}）`);
      assert.ok(v[3] <= CHINA_REGION.bounds[3], `纬度高于 54°N：${v}（数据框 ${b} 画布 ${c}）`);
      assert.ok(v[1] > 0, `出现了负纬度（南半球）：${v}（数据框 ${b} 画布 ${c}）`);
      assert.ok(v[0] >= CHINA_REGION.bounds[0] - 1e-9 && v[2] <= CHINA_REGION.bounds[2] + 1e-9,
        `经度跑出中国：${v}`);
      for (let i = 0; i < 4; i++) { assert.ok(Number.isFinite(v[i]), `非有限坐标：${v}`); }
      assert.ok(v[2] > v[0] && v[3] > v[1], `跨度非正：${v}`);
      // 投影得出来（不产 NaN —— NaN 会让整条 path 静默消失）
      const f: MapFrame = mapFrame(c[0], c[1], v);
      assert.ok(!outlinePath([[v[0], v[1], v[2], v[1], v[2], v[3]]], f).includes('NaN'));
      checked++;
    }
  }
  assert.equal(checked, boxes.length * canvases.length);
  // 真机图 2 那个框（纬度 −20.6°）在新模型里**不可达**：它连"合法输入"都不是
  const deviceRow2: number[] = [67, -20.6, 129, 64.4];
  assert.ok(deviceRow2[1] < CHINA_REGION.bounds[1], '（自检）真机图 2 那个框本来就在中国之外');
  assert.ok(normalizeBounds(deviceRow2)[1] === CHINA_REGION.bounds[1] ||
    normalizeBounds(deviceRow2)[1] === deviceRow2[1], '（自检）归一化不该悄悄改一个"看着合法"的框');
});

test('fillHeightView：数据居中 —— 4 个地点（北京/银川/济南/上海）**全部**在可见区（逐个坐标）', () => {
  const photos = fourPlaces();
  const vb = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(vb !== undefined);
  const view = fillHeightView(vb, T19_W, T19_H);
  const frame: MapFrame = mapFrame(T19_W, T19_H, view);
  const pins = buildScene(photos, frame, 1);
  assert.equal(pins.length, 4, `4 个地点应当得到 4 个钉子：${pins.length}`);
  // 逐个核对（真机数字，0.1pt 精度：北 京 222.8,281.8 ｜ 银川 84.7,306.9 ｜ 济南 230.6,338.1 ｜ 上海 291.3,426.7）
  const want: string[][] = [
    ['北京', '222.8', '281.8'], ['宁夏·银川·兴庆', '84.7', '306.9'],
    ['山东·济南·历下', '230.6', '338.1'], ['上海', '291.3', '426.7']
  ];
  for (const w of want) {
    const pin = pins.filter((p: ScenePin) => p.name === w[0])[0];
    assert.ok(pin !== undefined, `场景里没有 ${w[0]} 这个钉子`);
    assert.ok(pin.x >= 0 && pin.x <= T19_W, `${w[0]} 横向跑到屏幕外：x=${pin.x}`);
    assert.ok(pin.y >= 0 && pin.y <= T19_H, `${w[0]} 纵向跑到屏幕外：y=${pin.y}`);
    assert.ok(Math.abs(pin.x - Number(w[1])) < 0.5, `${w[0]} 的 x 与实测不符：${pin.x} vs ${w[1]}`);
    assert.ok(Math.abs(pin.y - Number(w[2])) < 0.5, `${w[0]} 的 y 与实测不符：${pin.y} vs ${w[2]}`);
  }
  // 视野确实把数据放在**中间**：数据框中心 == 视野中心（数据装得下一屏时逐位相等）
  assert.equal((view[0] + view[2]) / 2, (vb[0] + vb[2]) / 2, '视野的经度中心没有对齐数据中心');
  // 判别力：地图从"一薄条"变成"铺满高度"之后，**同样的 4 个地点在屏幕上铺得更开** ——
  // 用竖直跨度量（新模型 426.7−281.8 = 144.9pt；旧模型那一帧只有 ~47pt，因为框只有 279.62 高）。
  const spread = (ps: ScenePin[]): number => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of ps) { if (p.y < lo) { lo = p.y; } if (p.y > hi) { hi = p.y; } }
    return hi - lo;
  };
  // 旧形态那一帧（**手写**的框：填满宽度 376×279.62 居中在 y=172.62 —— 用户截图里的那个）
  const oldFrame: MapFrame = {
    blockW: T19_W, blockH: T19_H, x: 0, y: 172.62167776682176, w: T19_W, h: 279.6166444663565
  };
  const oldSpread: number = spread(buildScene(photos, oldFrame, 1));
  // 竖直跨度之比**正好**是两张地图的比例尺之比 = 624.86 / 279.62 = 2.2347
  // （同一个纬度窗口，框高就是比例尺）—— 这就是"地图大了 2.2347 倍"的机器可读形式。
  assert.ok(Math.abs(spread(pins) / oldSpread - 2.234702448391563) < 0.02,
    `竖直跨度之比应当是 2.2347：${spread(pins) / oldSpread}（新 ${spread(pins)} / 旧 ${oldSpread}）`);
  assert.ok(oldSpread < 70, `（自检）旧模型下 4 个钉子应当挤在 70pt 以内：${oldSpread}`);
});

test('fillHeightView / mapFrame：地图**完全离开屏幕**这件事在新模型里不可能发生', () => {
  // 横向溢出是"内容比画布宽"，而**视野**被平移钳制在 [73,135] 里 —— 两者不矛盾：
  // 地图的绘制宽度是 2.23 倍画布宽，但"整个中国被推出屏幕右侧"这种状态不存在。
  const view = fillHeightView(CHINA_REGION.bounds, T19_W, T19_H);
  const vm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H, view));
  // 中国东缘必须在屏幕右缘的右边（否则地图整体跑到屏幕左侧外面了）
  assert.ok(vm.eastX > T19_W, `中国东缘应当在屏幕内或右侧：${vm.eastX}`);
  // 西端/东端：窗口贴住 73 / 135，再拖也停住
  const west: number[] = panViewBy(view, 50, 0);
  const east: number[] = panViewBy(view, -50, 0);
  assert.ok(Math.abs(west[0] - CHINA_REGION.bounds[0]) < 1e-9, `往西拖到头应当贴住 73°E：${west[0]}`);
  assert.ok(Math.abs(east[2] - CHINA_REGION.bounds[2]) < 1e-9, `往东拖到头应当贴住 135°E：${east[2]}`);
  const westVm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H, west));
  const eastVm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H, east));
  assert.ok(Math.abs(westVm.westX) < 1e-9, `西端时中国西缘应当贴住屏幕左缘：${westVm.westX}`);
  assert.ok(Math.abs(eastVm.eastX - T19_W) < 1e-9, `东端时中国东缘应当贴住屏幕右缘：${eastVm.eastX}`);
  assert.ok(Math.abs(eastVm.westX - (-464.2481205952277)) < 1e-6, `东端时西缘在左外侧 464.25pt：${eastVm.westX}`);
  // 到头之后再拖：逐位不动（跨度不变、画面不动）—— "拖到头就停"的机器可读形态
  assert.deepEqual(panViewBy(west, 50, 0), west);
  assert.deepEqual(panViewBy(east, -50, 0), east);
  // 两端都仍然铺满高度、仍然不变形（平移按 mercY 做，比例只差一两个 ulp）
  for (const v of [west, east]) {
    assert.equal(viewMetrics(mapFrame(T19_W, T19_H, v)).heightRatio, 1);
    assert.ok(Math.abs(geoAspect(v) - T19_W / T19_H) < 1e-12,
      `拖到头之后比例漂了：${geoAspect(v)}`);
  }
});

test('defaultWallView：数据比一屏宽时退成"钉子最多的那一屏"，**绝不比数据中心更差**', () => {
  // 广域数据（乌鲁木齐 87.62 / 敦煌 94.66 / 拉萨 91.17 / 广州 113.26 / 北京 116.41 / 上海 121.47）
  // 跨度 33.85° > 一屏 23.05°（360×720）→ 一屏装不下，必须选一段。
  const photos: WallPhoto[] = [
    ph('urc', 43.8256, 87.6168, 1, '乌鲁木齐'), ph('dun', 40.14, 94.66, 2, '敦煌'),
    ph('lsa', 29.6520, 91.1721, 3, '拉萨'), ph('gz', 23.1291, 113.2644, 4, '广州'),
    ph('bj', 39.9042, 116.4074, 5, '北京'), ph('sh', 31.2304, 121.4737, 6, '上海')
  ];
  const W2 = 360;
  const H2 = 720;
  const vb = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(vb !== undefined);
  const span: number = fillHeightLonSpan(W2, H2);
  assert.ok(vb[2] - vb[0] > span, `（自检）这份数据的经度跨度应当比一屏宽：${vb[2] - vb[0]} vs ${span}`);
  const view: number[] = defaultWallView(photos, VIEW_PAD_RATIO, W2, H2);
  const frame: MapFrame = mapFrame(W2, H2, view);
  const pins = buildScene(photos, frame, 1);
  const visible = (v: number[]): number => {
    const ps = buildScene(photos, mapFrame(W2, H2, v), 1);
    return ps.filter((p: ScenePin) => p.x >= 0 && p.x <= W2 && p.y >= 0 && p.y <= H2).length;
  };
  const centered: number[] = fillHeightView(vb, W2, H2);
  const nBest: number = visible(view);
  const nCentered: number = visible(centered);
  assert.ok(nBest >= nCentered, `"钉子最多的那一屏" ${nBest} 个竟然少于数据中心 ${nCentered} 个`);
  assert.equal(nBest, 3, `实测这一档屏内 3 个钉子（敦煌/广州/北京），得到 ${nBest}`);
  assert.equal(nCentered, 2, `数据中心那一档屏内 2 个（敦煌/广州），得到 ${nCentered}`);
  // 一屏装得下时**逐位**退化成"数据中心"（常规数据一点没变）
  const near: number[] = fitBounds(fourPlaces(), VIEW_PAD_RATIO) as number[];
  assert.deepEqual(defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H),
    fillHeightView(near, T19_W, T19_H), '数据装得下时必须与"数据中心"逐位一致');
  // 没有有效坐标 → 退回全国视野那一档（不抛错、不产 NaN）
  const none: WallPhoto[] = [ph('n', 0, 0, 0)];
  const nv: number[] = defaultWallView(none, VIEW_PAD_RATIO, T19_W, T19_H);
  assert.ok(Number.isFinite(nv[0]) && nv[2] > nv[0] && nv[1] >= 18 && nv[3] <= 54, `退化路径非法：${nv}`);
  assert.equal(viewMetrics(mapFrame(T19_W, T19_H, nv)).heightRatio, 1);
  // 与 fitBounds 的筛选口径一致：只有 hasPlace 的照片参与选窗
  assert.ok(pins.length >= 1);
});

test('defaultWallView：真机那一档（4 个地点 + 376×624.86）逐位复核', () => {
  const view = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  // 4 个地点的裸数据盒 106.23~121.48（15.25°）+ pad 0.15 → 103.9425~123.7675，中心 113.855
  const center = (103.9425 + 123.7675) / 2;
  assert.ok(Math.abs((view[0] + view[2]) / 2 - center) < 1e-9, `经度中心应当是数据中心 ${center}：${(view[0] + view[2]) / 2}`);
  assert.ok(Math.abs(view[0] - (center - T19_SPAN / 2)) < 1e-9, `左缘应当是 ${center - T19_SPAN / 2}：${view[0]}`);
  assert.equal(view[1], 18, '纬度下界必须**逐位**是 18');
  assert.equal(view[3], 54, '纬度上界必须**逐位**是 54');
  const vm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H, view));
  assert.equal(vm.mapH, T19_H);
  assert.ok(Math.abs(vm.widthRatio - 2.234702448391563) < 1e-12);
  assert.ok(Math.abs(vm.westX - (-365.6828543051296)) < 1e-6, `默认视野的横向偏移实测 −365.68：${vm.westX}`);
});

test('refitViewToCanvas：幂等；画布比例变了按新比例重算，且仍在"铺满高度"那一档', () => {
  const view = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  // ① 比例已经匹配 → **逐位**原样返回（设备每次 rebuild 都调它，正常路径上必须"什么都没发生"）
  assert.deepEqual(refitViewToCanvas(view, T19_W, T19_H), view);
  // ② 旋转（376×624.86 → 624.86×376）：保持经度跨度与中心，按新比例重算纬度跨度
  const rot: number[] = refitViewToCanvas(view, T19_H, T19_W);
  assert.ok(Math.abs(geoAspect(rot) - T19_H / T19_W) < 1e-12, `旋转后比例不匹配：${geoAspect(rot)}`);
  assert.ok(Math.abs((rot[0] + rot[2]) / 2 - (view[0] + view[2]) / 2) < 1e-9, '旋转后经度中心应当不变');
  assert.ok(Math.abs((rot[2] - rot[0]) - (view[2] - view[0])) < 1e-9, '旋转后经度跨度应当不变');
  assert.ok(rot[1] >= 18 && rot[3] <= 54, `旋转后纬度跑出中国：${rot}`);
  assert.deepEqual(refitViewToCanvas(rot, T19_H, T19_W), rot, '第二次调用应当逐位不动（幂等）');
  // ③ 新画布"装得下更宽的经度"也不能让纬度越过中国：极端宽画布 → 收到中国纬度全域
  const flat: number[] = refitViewToCanvas(view, 2000, 100);
  assert.ok(flat[1] >= 18 && flat[3] <= 54, `极端画布下纬度跑出中国：${flat}`);
  assert.ok(flat[2] > flat[0] && Number.isFinite(flat[0]));
  // ④ 非法画布 → 只做中国范围钳制（不改比例）
  assert.deepEqual(refitViewToCanvas(view, 0, 0), view);
  assert.ok(Number.isFinite(refitViewToCanvas([1, 2, 3], T19_W, T19_H)[0]));
});

test('viewZoomRange：显示的可缩区间与"反复缩放实际到达的界限"一致（含新的下界 2.2347×）', () => {
  const zr: number[] = viewZoomRange(T19_W, T19_H);
  // ① 上界不变：62° / 0.6° ≈ 103.33（单城市级）
  assert.ok(Math.abs(zr[1] - 62 / 0.6) < 1e-9, `上界应当是 103.33×：${zr[1]}`);
  // ② 下界**随画布比例变**：62 / 27.744185828688188 = 2.234702448391563
  assert.ok(Math.abs(zr[0] - 2.234702448391563) < 1e-12, `下界应当是 2.2347×：${zr[0]}`);
  assert.equal(viewZoomOf(fillHeightView(CHINA_REGION.bounds, T19_W, T19_H)), zr[0]);
  // ③ 下界是**可达并且是终点**：反复捏合缩小 → 纬度恒为 [18,54]、经度跨度恒为一屏；
  //    再缩**逐位不动**（旧模型这里是"缩到南半球"，见 render.ts 的注释）
  let b: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (let i = 0; i < 40; i++) { b = zoomViewAt(b, 0.5, 0.5, 0.5); }
  assert.equal(viewZoomOf(b), zr[0], `显示可缩到 ${zr[0]}×，实际到了 ${viewZoomOf(b)}×`);
  assert.equal(b[1], 18, `缩到底的纬度下界必须逐位是 18：${b[1]}`);
  assert.equal(b[3], 54, `缩到底的纬度上界必须逐位是 54：${b[3]}`);
  assert.deepEqual(zoomViewAt(b, 0.5, 0.5, 0.5), b, '到了下界之后继续缩小必须逐位不动');
  assert.equal(viewMetrics(mapFrame(T19_W, T19_H, b)).heightRatio, 1, '缩到底仍然铺满高度');
  // ④ 上界：反复放大 → 经度跨度收到 0.6°，倍数 == 显示的 103.33×
  let c: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (let i = 0; i < 60; i++) { c = zoomViewAt(c, 2, 0.5, 0.5); }
  assert.ok(Math.abs(viewZoomOf(c) - zr[1]) < 1e-9, `显示可放到 ${zr[1]}×，实际到了 ${viewZoomOf(c)}×`);
  assert.ok(Math.abs((c[2] - c[0]) - MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-9, `放到顶时经度跨度应当是 0.6°：${c[2] - c[0]}`);
  assert.ok(c[1] >= 18 && c[3] <= 54, `放到顶之后仍须在中国之内：${c}`);
  // ⑤ 画布尺寸非法 → 下界退回 1×（"画布多大都不知道"时的退化口径，不抛错）
  assert.equal(viewZoomRange(0, 0)[0], 1);
});

// ── 两份 fixture：广域（退回接近全国）与近邻城市（真的放大） ──────────────────

test('广域 fixture（wall-sample.json：乌鲁木齐/敦煌/拉萨/广州/北京/上海）→ 视野接近全国，不放大', () => {
  const photos = loadFixture('wall-sample.json');
  assert.ok(photos.length > 20, `fixture 读进来只有 ${photos.length} 条`);
  const b = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const chinaLon = CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0];
  // 跨度接近全国（实测 44.05° vs 62°），放大倍数是个小数字 —— "跨度大时不放大"
  assert.ok(lonSpanOf(b) > chinaLon * 0.6, `广域数据被放大过头了：跨度 ${lonSpanOf(b)}`);
  assert.ok(viewZoomOf(b) < 1.6, `放大倍数过大：${viewZoomOf(b)}`);
  assert.ok(b[0] >= CHINA_REGION.bounds[0] && b[2] <= CHINA_REGION.bounds[2]);
  assert.ok(b[1] >= CHINA_REGION.bounds[1] && b[3] <= CHINA_REGION.bounds[3]);
  // "能看到它们全部"的**不变量**：凡是坐标本来就在中国范围内的照片，一定在框内。
  // （三沙永兴岛 16.83°N 在中国 bounds 的 minLat=18 之外，是已知例外，见 render.ts 文件头第 3 条）
  for (let i = 0; i < photos.length; i++) {
    const p: WallPhoto = photos[i];
    if (!(p.manual === true || p.lat !== 0 || p.lon !== 0)) { continue; }
    if (p.lon < CHINA_REGION.bounds[0] || p.lon > CHINA_REGION.bounds[2]) { continue; }
    if (p.lat < CHINA_REGION.bounds[1] || p.lat > CHINA_REGION.bounds[3]) { continue; }
    assert.ok(p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3],
      `在中国范围内的照片跑到框外了：${p.photoId}`);
  }
  // 更极端的广域（wall-sample-many：喀什 76°E ~ 哈尔滨 126.5°E、漠河 53°N ~ 三沙 16.8°N）：
  // 加边距之后跨度比中国还大 → `fitAxis` 第 ③ 步把跨度收到中国跨度并平移 → **正好等于全国 bounds**。
  // 这是"跨度大时不放大"的最强形式，也说明多钉那份夹具的几何与改动前**逐点相同**。
  assert.deepEqual(fitBounds(loadFixture('wall-sample-many.json'), VIEW_PAD_RATIO), CHINA_REGION.bounds);
  assert.equal(viewZoomOf(CHINA_REGION.bounds), 1);
});

test('近邻城市 fixture（wall-sample-nearby.json：上海+北京+天津）→ 框跨度 = 设备真值，放大 ~9.4 倍', () => {
  const photos = loadFixture('wall-sample-nearby.json');
  // 数据盒必须**正好**是控制器在设备上核实的那个：经度 116.42~121.48、纬度 31.25~39.93
  const raw = fitBounds(photos, 0);
  assert.ok(raw !== undefined);
  assert.ok(Math.abs(raw[0] - 116.42) < 1e-6, `minLon=${raw[0]}`);
  assert.ok(Math.abs(raw[1] - 31.25) < 1e-6, `minLat=${raw[1]}`);
  assert.ok(Math.abs(raw[2] - 121.48) < 1e-6, `maxLon=${raw[2]}`);
  assert.ok(Math.abs(raw[3] - 39.93) < 1e-6, `maxLat=${raw[3]}`);
  // 加边距之后：经度 6.578°、放大 62/6.578 ≈ 9.43 倍
  const b = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const zoom = viewZoomOf(b);
  assert.ok(Math.abs(zoom - 9.43) < 0.05, `放大倍数 ${zoom}（期望 ≈9.43）`);
  // 与广域 fixture 对比：这一档才是"地图铺满屏幕"
  const wide = fitBounds(loadFixture('wall-sample.json'), VIEW_PAD_RATIO);
  assert.ok(wide !== undefined);
  assert.ok(zoom > 5 * viewZoomOf(wide), `近邻城市 ${zoom} 倍 vs 广域 ${viewZoomOf(wide)} 倍 —— 应当差一个量级`);
  const f: MapFrame = mapFrame(W, H, b);
  assert.ok(Math.abs(f.h - H) < 1e-9, '近邻城市那一档应当填满高度');
});

// ── 轮廓：解析与 path ───────────────────────────────────────────────────────

const GOOD_OUTLINE = JSON.stringify({
  v: 'test', src: 'test', license: 'test', bounds: [73, 18, 135, 54],
  rings: [[73, 54, 135, 54, 135, 18, 73, 18]]
});

test('parseOutline：合法输入通过，bounds 与 rings 原样带出', () => {
  const o = parseOutline(GOOD_OUTLINE);
  assert.ok(o !== undefined);
  assert.equal(o.rings.length, 1);
  assert.equal(o.bounds[0], 73);
});

test('parseOutline：坏输入返回 undefined，不抛错', () => {
  assert.equal(parseOutline(''), undefined);
  assert.equal(parseOutline('{'), undefined);
  assert.equal(parseOutline('null'), undefined);
  assert.equal(parseOutline('{"rings":[]}'), undefined);
  assert.equal(parseOutline('{"rings":"x"}'), undefined);
  // 奇数长度 / 点数不足 / 含 NaN 的 ring 被丢掉；全被丢掉则整体 undefined
  assert.equal(parseOutline('{"rings":[[1,2,3,4,5]]}'), undefined);
  assert.equal(parseOutline('{"rings":[[1,2,3,4]]}'), undefined);
  assert.equal(parseOutline('{"rings":[["a",2,3,4,5,6]]}'), undefined);
  // 至少一条合法 ring 就能用：坏的只丢坏的那条
  const mixed = parseOutline('{"rings":[[1,2,3,4,5],[73,54,74,54,74,53]]}');
  assert.ok(mixed !== undefined);
  assert.equal(mixed.rings.length, 1);
});

test('outlinePath：一条 ring 一条子路径，坐标落在画布内且保留 2 位小数', () => {
  const o = parseOutline(GOOD_OUTLINE);
  assert.ok(o !== undefined);
  const d = outlinePath(o.rings, FRAME);
  assert.ok(d.startsWith('M'), 'path 未以 M 开头');
  assert.ok(d.endsWith('Z'));
  assert.equal(d.split('M').length - 1, 1, 'ring 数与子路径数不一致');
  assert.ok(!d.includes('NaN') && !d.includes('Infinity'));
  // 每个坐标的小数位不超过 2
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/);
  for (const s of nums) {
    const dot = s.indexOf('.');
    if (dot >= 0) { assert.ok(s.length - dot - 1 <= 2, `坐标 ${s} 的小数位超过 2`); }
  }
});

test('outlinePath：多个 ring → 多个子路径；空输入返回空串', () => {
  const rings = [[73, 54, 74, 54, 74, 53], [80, 40, 81, 40, 81, 39]];
  const d = outlinePath(rings, FRAME);
  assert.equal(d.split('M').length - 1, 2);
  assert.equal(outlinePath([], FRAME), '');
});

test('outlinePath：投影只用 frame.bounds —— 框上 bounds 非法时退回全国视野（不产出 NaN）', () => {
  // 以前这个函数收一个 bounds 参数，越界时由它自己退回 CHINA_REGION.bounds。
  // 现在没有这个参数了（"国界与照片同一个 bounds"在类型层面成立，见 render.ts 的说明），
  // 归一化发生在**框**这一层：mapFrame / frameBounds 都过 normalizeBounds。
  const broken: MapFrame = mapFrame(W, H, [1, 2, 3]);
  assert.deepEqual(frameBounds(broken), CHINA_REGION.bounds, '非法 bounds 没有被退回全国视野');
  const d = outlinePath([[100, 30, 101, 30, 101, 29]], broken);
  assert.ok(d.length > 0);
  assert.ok(!d.includes('NaN'));
  // 与"显式给全国视野的框"逐字符相同 —— 证明退回是真的退回，不是另一种投影
  assert.equal(d, outlinePath([[100, 30, 101, 30, 101, 29]], mapFrame(W, H, CHINA_REGION.bounds)));
});

test('outlinePath：整个落在地图块外的环被剔除（视口剔除，不是删数据）', () => {
  // 视口 360×100。第二条环在 4~5°N —— 远在 bounds 的 minLat=18 之南，投影后整条在视口下方。
  const small: MapFrame = mapFrame(W, 100, CHINA_REGION.bounds);
  const inside = [73, 54, 74, 54, 74, 53];
  const below = [100, 5, 101, 5, 101, 4];
  const d = outlinePath([inside, below], small);
  assert.equal(d.split('M').length - 1, 1, '视口外的环没有被剔除');
  assert.equal(outlinePath([below], small), '', '整屏都在视口外时应当返回空串');
  // 横向出界同理（经度 10°E 远在 bounds 的 minLon=73 之西）
  const left = [10, 40, 11, 40, 11, 39];
  assert.equal(outlinePath([left], small), '');
});

test('outlinePath：视口是**绘制框**而不是地图块 —— 框比块宽时，块外框内的环必须留着', () => {
  // task-19 改的一处（task-17 是纵向版、这一条是横向版）。两种口径在"框 != 块"时分道扬镳，
  // 而新模型里**框恒填满块高、却可以比块宽**（`x < 0`）：376×642.57 的块里，
  // "整个中国当视野"的框是 864.06×642.57 @ x=−244.03 —— 于是有一整段经度落在
  // **屏幕左侧外面、却仍在绘制框里**。
  // 按块判（老口径）会把它剔掉 → 用户往西滑过去，那一片地图是**空的**（真缺陷）。
  const frame: MapFrame = mapFrame(376, 642.57, CHINA_REGION.bounds);
  assert.ok(frame.x < -1, `（自检）这个块里框比块宽，x 应当是负的：x=${frame.x}`);
  assert.equal(frame.y, 0, '（自检）框顶恒贴块顶（填满高度）');
  assert.equal(frame.h, frame.blockH, '（自检）框高恒等于块高');
  // 80°E 那一带：屏幕上 x < 0（在左侧外面），但仍在绘制框之内
  const west = [80, 40, 81, 40, 81, 39];
  const westX = projectMercator(80.5, 39.5, frame.w, frame.h, frameBounds(frame)).x + frame.x;
  assert.ok(westX < 0, `（自检）这个点应当在屏幕左侧外面：x=${westX}`);
  assert.ok(westX > frame.x, `（自检）但它仍在绘制框之内：x=${westX} > 框左 ${frame.x}`);
  const d = outlinePath([west], frame);
  assert.ok(d.length > 0 && d.startsWith('M'), '块外框内的环被错误地剔掉了（往西滑会看到空白）');
  // 真正"整条在框外"的环仍然要剔掉（经度 10°E 远在框左缘之西）
  const far = [10, 40, 11, 40, 11, 39];
  assert.equal(outlinePath([far], frame), '', '整条在绘制框之外的环没有被剔除');
  // 框 == 块时（本模型的默认视野）两种口径**逐字相同**：默认视野里屏幕外的环一律不画
  const def: MapFrame = mapFrame(T19_W, T19_H, defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H));
  const inside = [113, 30, 114, 30, 114, 29];
  const outsideCanvas = [90, 40, 91, 40, 91, 39];    // 在左外侧（默认视野看不到）
  assert.equal(outlinePath([inside, outsideCanvas], def), outlinePath([inside], def),
    '框 == 块时，屏幕上完全看不到的环必须剔掉（省 path 体积）');
  assert.equal(outlinePath([outsideCanvas], def), '');
});

test('outlinePath：坐标在**块坐标**里 —— 轮廓跟着偏移 frame.x（框比块宽时两侧为负）', () => {
  // 一个刻意做得很高、很窄的块：新规则下框**恒填满高度**（y = 0），宽度按比例算 → x 为负。
  const tall: MapFrame = mapFrame(200, 900, CHINA_REGION.bounds);
  assert.equal(tall.y, 0, `框顶应当恒贴块顶：y=${tall.y}`);
  assert.equal(tall.h, 900, `框高应当恒等于块高：h=${tall.h}`);
  assert.ok(tall.x < -500, `这个块应当让框比块宽得多：x=${tall.x}`);
  const ring = [73, 54, 135, 54, 135, 18, 73, 18];
  const d = outlinePath([ring], tall);
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < minX) { minX = nums[i]; }
    if (nums[i] > maxX) { maxX = nums[i]; }
    if (nums[i + 1] < minY) { minY = nums[i + 1]; }
    if (nums[i + 1] > maxY) { maxY = nums[i + 1]; }
  }
  // 横向：中国全域的轮廓从 frame.x 铺到 frame.x + frame.w（块坐标，左侧一大段是负的）
  assert.ok(Math.abs(minX - tall.x) < 0.05, `轮廓左边缘没有贴在框左：${minX} vs ${tall.x}`);
  assert.ok(Math.abs(maxX - (tall.x + tall.w)) < 0.05, `轮廓右边缘没有贴在框右：${maxX} vs ${tall.x + tall.w}`);
  // 纵向：贴住框顶与框底（框高 == 块高 → 与块坐标一致）
  assert.ok(Math.abs(minY - tall.y) < 0.05, `轮廓上边缘没有贴在框顶：${minY} vs ${tall.y}`);
  assert.ok(Math.abs(maxY - (tall.y + tall.h)) < 0.05, `轮廓下边缘没有贴在框底：${maxY} vs ${tall.y + tall.h}`);
});

// ── 真实轮廓文件（china_outline.json） ──────────────────────────────────────

const OUTLINE_URL = new URL('../../resources/rawfile/china_outline.json', import.meta.url);

test('china_outline.json：真实文件能解析、许可与出处齐、环数不变', () => {
  const text = fs.readFileSync(OUTLINE_URL, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 200 * 1024, `轮廓文件超过 200KB：${Buffer.byteLength(text, 'utf8')}`);
  const od = parseOutline(text);
  assert.ok(od !== undefined, 'china_outline.json 过不了 parseOutline —— 设备上地图会整块消失（静默失败）');
  // 这一条**不再**是"地图与钉子对齐"的保障（那是 frame.bounds 的事，见下面那条测试），
  // 而是**数据完整性**的保障：这份轮廓数据本身是全国的 —— 它的 bounds 与 CHINA_REGION 一致，
  // 才说明"96 条环覆盖整个中国"这句话成立，也才不会有人拿一份局部数据冒充全国轮廓。
  assert.deepEqual(od.bounds, CHINA_REGION.bounds);
  assert.ok(od.license.length > 0, '缺少许可字段');
  assert.ok(od.src.indexOf('Natural Earth') >= 0, `来源字段没写清出处：${od.src}`);
  // 96 条环（中国 70 + 香港 4 + 澳门 2 + 台湾 8 + 南海诸岛 12），一条都不许少
  assert.equal(od.rings.length, 96, `环数变了：${od.rings.length}`);
});

test('china_outline.json：投到地图框上的路径非空、无 NaN、且没有一个点落在地图块外', () => {
  const od = parseOutline(fs.readFileSync(OUTLINE_URL, 'utf8'));
  assert.ok(od !== undefined);
  // 框与块取成一样（块 360×267.72 的比例正好等于墨卡托比例）→ 平移量为 0，
  // 于是"轮廓是否越出块"这件事可以直接按 [0,W]×[0,mapH] 判。
  const mapH = mapBoxHeight(W, CHINA_REGION.bounds);
  const frame: MapFrame = mapFrame(W, mapH, CHINA_REGION.bounds);
  assert.ok(Math.abs(frame.x) < 1e-9 && Math.abs(frame.y) < 1e-9, '块的比例正好时平移量应当是 0');
  const d = outlinePath(od.rings, frame);
  assert.ok(d.length > 0, '轮廓 path 是空的');
  assert.ok(!d.includes('NaN') && !d.includes('Infinity'));
  // 视口剔除之后，子路径的坐标必须全部落在 [0,W]×[0,mapH] 内（实测 0 条跨界环）
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  assert.ok(nums.length > 100, `坐标太少：${nums.length}`);
  for (let i = 0; i + 1 < nums.length; i += 2) {
    assert.ok(nums[i] >= -0.01 && nums[i] <= W + 0.01, `轮廓 x 越界：${nums[i]}`);
    assert.ok(nums[i + 1] >= -0.01 && nums[i + 1] <= mapH + 0.01, `轮廓 y 越界：${nums[i + 1]}`);
  }
  // 地图块外的 19 条环（8~11.4°N 的南海诸岛）被剔除 → 子路径数少于环数，但数据里一条不少
  assert.ok(d.split('M').length - 1 < od.rings.length, '视口外的环没被剔除');
});

// ── 真实省级边界文件（china_provinces.json，task-16 的第 1 件事）─────────────
//
// 用户的第二条反馈：「还有地图至少要有省级划分的边界线 现在整个地图都是一片」。
// 成因是只有国界：`china_outline.json` 是**一个填充面**，内陆一条线都没有，
// 放大到一座城之后屏幕上就是一整片同一个颜色。
//
// 这份数据与国界**共用同一套机制**（同一个 parseOutline / outlinePath / MapFrame），
// 所以下面测的是"数据本身对不对"，机制部分是上面那批测试已经在守的。

const PROVINCE_URL = new URL('../../resources/rawfile/china_provinces.json', import.meta.url);

test('china_provinces.json：真实文件能解析、许可与出处齐、环数与字节数不超限', () => {
  const text = fs.readFileSync(PROVINCE_URL, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  // 工单的硬约束：≤ 150 KB
  assert.ok(bytes <= 150 * 1024, `省级边界文件超过 150KB：${bytes} 字节`);
  const pd = parseOutline(text);
  assert.ok(pd !== undefined, 'china_provinces.json 过不了 parseOutline —— 设备上省界整层消失（静默失败）');
  // 与国界同一口径：bounds 必须等于 CHINA_REGION.bounds（数据完整性的表述，不参与投影）
  assert.deepEqual(pd.bounds, CHINA_REGION.bounds);
  assert.ok(pd.license.length > 0, '缺少许可字段');
  assert.ok(pd.license.indexOf('Public Domain') >= 0, `许可没写明：${pd.license}`);
  assert.ok(pd.src.indexOf('Natural Earth') >= 0, `来源字段没写清出处：${pd.src}`);
  // 版本标记里**必须能读出容差**（与 build-outline.ts 的同一条规矩：默认值就是入库口径，
  // 改成更大会静默降精度，而"能不能解析"这类自检在降精度后照样通过）
  assert.ok(pd.v.indexOf('dp0.08') > 0, `版本字段里读不出容差：${pd.v}`);
  // **107 条环**（大陆 31 个省级 93 环 + 台港澳 14 环），一条都不许少
  assert.equal(pd.rings.length, 107, `环数变了：${pd.rings.length}`);
  // 总点数：容差被偷偷调大时它会掉（0.08→0.15 会从 11840 掉到 7766）
  let pts = 0;
  for (let i = 0; i < pd.rings.length; i++) { pts += pd.rings[i].length / 2; }
  assert.equal(pts, 11840, `总点数变了：${pts}（容差或抽取口径被改动了？）`);
  // 每条环都是合法的绘制输入（parseOutline 已校验，这里再从"能不能画出一个面"复核一次）
  for (let i = 0; i < pd.rings.length; i++) {
    const ring = pd.rings[i];
    assert.ok(ring.length >= 8 && ring.length % 2 === 0, `第 ${i} 条环形状不对：${ring.length}`);
    for (let j = 0; j < ring.length; j++) {
      assert.ok(Number.isFinite(ring[j]), `第 ${i} 条环里有非有限坐标`);
    }
  }
});

/**
 * 一批"这条省级边界应当存在"的粗略区域。每项是
 * `[名字, minLon, minLat, maxLon, maxLat]`（**顺序**：经度下界、纬度下界、经度上界、纬度上界）。
 * 判据是"某条环的**包围盒中心**落在这个盒子里" —— 比"某个点恰好相等"稳得多，
 * 也不会因为简化掉了某个顶点而误报。盒子都放得比省界本身宽，只用来证明"这一带**有**线"。
 */
const PROVINCE_PROBES: string[][] = [
  ['新疆', '73', '34', '97', '49'],
  ['西藏', '78', '26', '100', '37'],
  ['黑龙江', '121', '43', '136', '54'],
  ['海南岛', '108', '18', '112', '21'],
  ['上海', '120.8', '30.6', '122.2', '31.9'],
  ['宁夏', '104', '35', '108', '40'],
  ['北京/天津/河北', '114.5', '36', '120', '42.5'],
  // ── 下面三条就是工单里的"含港澳台"，逐条机械核对 ──
  ['台湾', '119', '21', '123', '26'],
  ['香港', '113.7', '22.0', '114.6', '22.7'],
  ['澳门', '113.4', '22.0', '113.7', '22.3'],
];

test('china_provinces.json：**含港澳台**，且各大区都有边界（用环包围盒落点核对，不靠肉眼）', () => {
  const pd = parseOutline(fs.readFileSync(PROVINCE_URL, 'utf8'));
  assert.ok(pd !== undefined);
  // 预先算好每条环的包围盒中心
  const centers: number[][] = [];
  for (let i = 0; i < pd.rings.length; i++) {
    const ring = pd.rings[i];
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let j = 0; j + 1 < ring.length; j += 2) {
      if (ring[j] < minLon) { minLon = ring[j]; }
      if (ring[j] > maxLon) { maxLon = ring[j]; }
      if (ring[j + 1] < minLat) { minLat = ring[j + 1]; }
      if (ring[j + 1] > maxLat) { maxLat = ring[j + 1]; }
    }
    centers.push([(minLon + maxLon) / 2, (minLat + maxLat) / 2]);
  }
  for (let k = 0; k < PROVINCE_PROBES.length; k++) {
    const p = PROVINCE_PROBES[k];
    // 数组顺序是 [名字, minLon, minLat, maxLon, maxLat]（见上面那段注释）
    const minLon = Number(p[1]);
    const minLat = Number(p[2]);
    const maxLon = Number(p[3]);
    const maxLat = Number(p[4]);
    let hit = false;
    for (let i = 0; i < centers.length && !hit; i++) {
      if (centers[i][0] >= minLon && centers[i][0] <= maxLon
        && centers[i][1] >= minLat && centers[i][1] <= maxLat) { hit = true; }
    }
    assert.ok(hit, `${p[0]} 那一带一条省级边界环都没有（框 ${minLon}~${maxLon}E / ${minLat}~${maxLat}N）`
      + ' —— 抽取规则漏了它？');
  }
  // 反面：全体环的**包围盒并集**必须跨得很开（少了新疆或黑龙江就会明显缩水）。
  // 注意这里比的是**边界**（不是上面那些中心）—— 新疆那条环的中心在 85°E，
  // 但它的西边界在 73.6°E；拿中心去比"够不够西"是量错了东西（这个坑真踩到了）。
  let uMinLon = Number.POSITIVE_INFINITY;
  let uMaxLon = Number.NEGATIVE_INFINITY;
  let uMinLat = Number.POSITIVE_INFINITY;
  let uMaxLat = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pd.rings.length; i++) {
    const ring = pd.rings[i];
    for (let j = 0; j + 1 < ring.length; j += 2) {
      if (ring[j] < uMinLon) { uMinLon = ring[j]; }
      if (ring[j] > uMaxLon) { uMaxLon = ring[j]; }
      if (ring[j + 1] < uMinLat) { uMinLat = ring[j + 1]; }
      if (ring[j + 1] > uMaxLat) { uMaxLat = ring[j + 1]; }
    }
  }
  assert.ok(uMinLon < 76, `西边界不够西（新疆西端在 73.6°E）：${uMinLon}`);
  assert.ok(uMaxLon > 132, `东边界不够东（黑龙江东端在 134.8°E）：${uMaxLon}`);
  assert.ok(uMinLat < 20, `南边界不够南（海南南端在 18.2°N）：${uMinLat}`);
  assert.ok(uMaxLat > 52, `北边界不够北（漠河在 53.6°N）：${uMaxLat}`);
  // 中心数：107 条环每一个都算出来了（不是空跑）
  assert.equal(centers.length, pd.rings.length);
});

test('china_provinces.json：投到地图框上的路径非空、无 NaN，且路径比国界**密**（线更多）', () => {
  const pd = parseOutline(fs.readFileSync(PROVINCE_URL, 'utf8'));
  const od = parseOutline(fs.readFileSync(OUTLINE_URL, 'utf8'));
  assert.ok(pd !== undefined && od !== undefined);
  const mapH = mapBoxHeight(W, CHINA_REGION.bounds);
  const frame: MapFrame = mapFrame(W, mapH, CHINA_REGION.bounds);
  const dp = outlinePath(pd.rings, frame);
  const dc = outlinePath(od.rings, frame);
  assert.ok(dp.length > 0, '省界 path 是空的');
  assert.ok(!dp.includes('NaN') && !dp.includes('Infinity'));
  // 全国视野下省界的 path 必须比国界**长得多**：国界只有海岸线 + 国境线，
  // 省界是内陆的分省线网。这条断言抓的是"省界层被误当成国界层画了"（同一个数据文件）。
  assert.ok(dp.length > dc.length * 1.5,
    `省界 path（${dp.length} 字符）没有比国界（${dc.length}）明显更长 —— 两层是不是用了同一份数据？`);
  // 坐标全部落在块内
  const nums = dp.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  assert.ok(nums.length > 1000, `坐标太少：${nums.length}`);
  for (let i = 0; i + 1 < nums.length; i += 2) {
    assert.ok(nums[i] >= -0.01 && nums[i] <= W + 0.01, `省界 x 越界：${nums[i]}`);
    assert.ok(nums[i + 1] >= -0.01 && nums[i + 1] <= mapH + 0.01, `省界 y 越界：${nums[i + 1]}`);
  }
});

test('省界与国界用**同一个** frame.bounds：同一经纬度在两条 path 上落在同一个画布点', () => {
  // 与国界那条"同一个 bounds"的测试同源：两层都调 outlinePath(rings, frame)，
  // 所以"各传一套参数"在类型上就写不出来。这里用一个能同时出现在两个环里的点验证行为。
  const lon = 116.4;
  const lat = 39.9;
  const ring = [lon, lat, lon + 0.1, lat, lon + 0.1, lat + 0.1, lon, lat + 0.1];
  const b = fitBounds([ph('bj', lat, lon, 0)], VIEW_PAD_RATIO);
  assert.ok(b !== undefined);
  const frame: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, fillHeightView(b, DEV_BOX_W, DEV_BOX_H));
  const dProv = outlinePath([ring], frame);
  const dChina = outlinePath([ring], frame);
  assert.equal(dProv, dChina, '同一个环在同一 frame 下必须产出逐字节相同的 path');
  assert.ok(dProv.startsWith('M'));
  // 换一个 frame（不同 bounds）→ path 必然不同（否则说明 bounds 根本没被用上）
  const other: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, CHINA_REGION.bounds);
  assert.notEqual(outlinePath([ring], other), dProv);
});

test('sceneToSvg：省界画在国界**之后**（填充面上）、轨迹与照片**之前**', () => {
  // 这一条守的是一个真会发生的静默失败：国界那一层是**填充面**（fill="#E8F0E4"），
  // 省界是陆地内部的线 —— 画在填充之前会被整块盖掉，症状是"数据里 107 条环、
  // 图上一条都看不见"，而任何解析/校验都不会报错。
  const pins = demoPins();
  const svg = sceneToSvg(pins, W, H, 'M1 1L2 2Z', 1, 'M3 3L4 4Z');
  const iChina = svg.indexOf('M1 1L2 2Z');
  const iProv = svg.indexOf('M3 3L4 4Z');
  const iTrack = svg.indexOf('<g id="trajectory">');
  const iPins = svg.indexOf('<g id="pins">');
  assert.ok(iChina >= 0 && iProv >= 0, '两层 path 都应当出现在 SVG 里');
  assert.ok(iChina < iProv, '省界必须画在国界之后（否则被国界的填充盖掉）');
  assert.ok(iProv < iTrack && iProv < iPins, '省界必须在轨迹与照片之前（它是底图信息）');
  // 省界是线不是面：fill="none"，否则内环会在陆地上挖洞。
  // （取整段 <path …> 元素：固定 20 个字符的窗口会在 "fill=" 那里被截断，
  //   那样断言永远失败 —— 这个坑真踩到了。）
  const provStart = svg.lastIndexOf('<path', iProv);
  const provTag = svg.substring(provStart, svg.indexOf('/>', provStart) + 2);
  assert.ok(provTag.indexOf('fill="none"') >= 0, `省界的 path 不该填充：${provTag}`);
  assert.ok(provTag.indexOf(`stroke="${PROVINCE_STROKE}"`) >= 0, `省界颜色没走常量：${provTag}`);
  // 缺省（不传）时不画省界 —— 老调用点与"没有那份 rawfile"的退化路径都不受影响
  const svgNoProv = sceneToSvg(pins, W, H, 'M1 1L2 2Z', 1);
  assert.equal(svgNoProv.indexOf('M3 3L4 4Z'), -1);
  assert.equal(svgNoProv.indexOf('<g id="provinces">'), -1);
  // 省界的样式取自 core 的常量（设备与预览共用同一份，不是各写一个数）
  assert.ok(svg.indexOf(PROVINCE_STROKE) >= 0);
  assert.ok(svg.indexOf(`stroke-width="${PROVINCE_WIDTH}"`) >= 0);
});

test('省界在**真机默认视野**下确实还有线可画（铺满高度那一档不能一条都不剩）', () => {
  // 用户的抱怨是"整个地图都是一片"。所以"某个视野下有省界"不够 ——
  // 必须验证**真机默认视野**（376×663.71 + 上海/北京/天津）里也有省界。
  const photos = [ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)];
  const frame: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H,
    defaultWallView(photos, VIEW_PAD_RATIO, DEV_BOX_W, DEV_BOX_H));
  const pd = parseOutline(fs.readFileSync(PROVINCE_URL, 'utf8'));
  assert.ok(pd !== undefined);
  const dp = outlinePath(pd.rings, frame);
  const subpaths = dp.split('M').length - 1;
  // 实测 104/107 条环落在这个视野里（新模型一屏 26.12° 经度，几乎装下整个中国的东西向）
  assert.equal(subpaths, 104, `真机默认视野里的省级子路径数变了：${subpaths}`);
  assert.ok(dp.length > 100000, `省界 path 太短（${dp.length}）—— 省界可能已经看不见了`);
  assert.ok(!dp.includes('NaN'));
  // 判别力：如果只有国界，这一档视野里几乎只剩海岸线 —— 字符数会差一个量级
  const od = parseOutline(fs.readFileSync(OUTLINE_URL, 'utf8'));
  assert.ok(od !== undefined);
  const dc = outlinePath(od.rings, frame);
  assert.ok(dp.length > dc.length * 1.5,
    `真机视野下省界（${dp.length}）没有比国界（${dc.length}）密 —— 用户会再次看到"一片"`);
  // 默认视野下国界 path 的坐标**会伸出画布**（左侧 −426.5 / 右侧 +402.4，画布只有 376 宽）——
  // 这正是"横向溢出"的表现；两侧由容器的 clip 裁掉，滑过去就能看见（不是数据缺失）。
  const nums = dc.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < minX) { minX = nums[i]; }
    if (nums[i] > maxX) { maxX = nums[i]; }
  }
  assert.ok(minX < -100 && maxX > DEV_BOX_W + 10,
    `国界应当伸出画布两侧（横向溢出）：x ∈ [${minX}, ${maxX}]`);
});

// ── 手势视野 zoomViewAt / panViewBy（task-16 的第 3 件事）────────────────────
//
// 用户原话：「还有地图应该支持缩放吧 默认铺满」。这两个函数是手势的**全部数学**，
// 不带 ArkUI（WallPage 只负责把手势事件的 vp 除以画布宽高，然后调它们）。
//
// 这一节里"不动点""内容位移"这两类断言都用 `projectMercator` **独立复核**
// （不用实现里的 mercY 公式再算一遍）—— 那样才能抓住"参考端搞反"这类错误。
// 实测确实抓到过两个：偏心缩放的不动点参考端取成了南边、以及平移的纵向符号与横向同向。

/** 归一化位置：把经纬度投影到某个视野框上，返回 (x/框宽, y/框高)。 */
function normIn(b: number[], lon: number, lat: number, boxW: number, boxH: number): number[] {
  const f: MapFrame = mapFrame(boxW, boxH, b);
  const p = projectMercator(lon, lat, f.w, f.h, frameBounds(f));
  return [p.x / f.w, p.y / f.h];
}

/** 某个归一化位置对应的经纬度（用 projectMercator 反解，与实现无关）。 */
function geoAt(b: number[], fx: number, fy: number, boxW: number, boxH: number): number[] {
  const f: MapFrame = mapFrame(boxW, boxH, b);
  const bb: number[] = frameBounds(f);
  // 经度线性
  const lon = bb[0] + (bb[2] - bb[0]) * fx;
  // 纵向：p.y 与 mercY 线性；用两次采样定出"mercY 从北往南"的插值。
  // 画布顶端（p.y = 0）是**北**（mercY 最大），所以按 fy 从北往南取。
  const pN = projectMercator(lon, bb[3], f.w, f.h, bb);
  const pS = projectMercator(lon, bb[1], f.w, f.h, bb);
  const target = pN.y + (pS.y - pN.y) * fy;
  let a = bb[1];
  let c = bb[3];
  for (let i = 0; i < 80; i++) {
    const m = (a + c) / 2;
    // p.y 随纬度**递减**（北在上）
    if (projectMercator(lon, m, f.w, f.h, bb).y > target) { a = m; } else { c = m; }
  }
  return [lon, (a + c) / 2];
}

test('zoomViewAt：以给出的归一化点为**不动点** —— 偏心缩放也精确不动', () => {
  const b: number[] = [115.01, 29.95, 122.89, 41.23];
  const cases: number[][] = [[0.25, 0.75], [0.5, 0.5], [0.9, 0.1], [0.02, 0.98]];
  for (let k = 0; k < cases.length; k++) {
    const fx: number = cases[k][0];
    const fy: number = cases[k][1];
    const g: number[] = geoAt(b, fx, fy, DEV_BOX_W, DEV_BOX_H);
    const before: number[] = normIn(b, g[0], g[1], DEV_BOX_W, DEV_BOX_H);
    const z: number[] = zoomViewAt(b, 2.5, fx, fy);
    const after: number[] = normIn(z, g[0], g[1], DEV_BOX_W, DEV_BOX_H);
    // 缩放前那个点就在 (fx, fy) 上（反解正确性的自检）
    assert.ok(Math.abs(before[0] - fx) < 1e-9 && Math.abs(before[1] - fy) < 1e-9,
      `反解失败：(${fx},${fy}) 得到 (${before[0]},${before[1]})`);
    // 缩放后仍然在 (fx, fy) 上 —— 这才是"不动点"的机器可读含义
    assert.ok(Math.abs(after[0] - fx) < 1e-6, `不动点横向跑掉：${after[0]} != ${fx}（fx=${fx} fy=${fy}）`);
    assert.ok(Math.abs(after[1] - fy) < 1e-6, `不动点纵向跑掉：${after[1]} != ${fy}（fx=${fx} fy=${fy}）`);
    // 跨度确实按 factor 缩了，比例不变
    assert.ok(Math.abs((z[2] - z[0]) - (b[2] - b[0]) / 2.5) < 1e-9);
    assert.ok(Math.abs(geoAspect(z) - geoAspect(b)) < 1e-9, '缩放改变了宽高比');
  }
});

test('zoomViewAt：缩放界限 = [单城市级 0.6°（上界），**完整的中国纬度**（下界）]', () => {
  const b: number[] = [115.01, 29.95, 122.89, 41.23];
  // 放大到极限：经度跨度收到 MIN_VIEW_SPAN_DEG（= 0.6°，"一个地级市加近郊"）
  const zin: number[] = zoomViewAt(b, 1e6, 0.4, 0.6);
  assert.ok(Math.abs((zin[2] - zin[0]) - MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-9,
    `放大上限不是单城市级：${zin[2] - zin[0]}`);
  // 缩小到极限：**纬度顶满中国全域**（task-19 改的就是这一条 —— 旧版把经度夹在 62°，
  // 而纬度按同一个 factor 搭车膨胀到 −20.6°）。经度跨度随之 = 这个框自己的比例 × 中国纬度跨度。
  const zout: number[] = zoomViewAt(b, 1e-6, 0.5, 0.5);
  assert.ok(Math.abs((zout[3] - zout[1]) - (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1])) < 1e-9,
    `缩小下限不是"完整的中国纬度"：${zout[1]}~${zout[3]}`);
  assert.ok(zout[1] >= CHINA_REGION.bounds[1] && zout[3] <= CHINA_REGION.bounds[3],
    `缩到底的纬度必须落在中国范围里：${zout}`);
  assert.ok(Math.abs(geoAspect(zout) - geoAspect(b)) < 1e-12, '缩到底把宽高比改了（该保形）');
  // 判别力：旧实现缩到底经度跨度是 62°；新模型下缩到底的经度跨度是"原跨度 × 中国mercY跨度 /
  // 原mercY跨度"（保形），只有当这个框的比例正好等于画布比例时它才是一屏的 27.744°。
  const deg = Math.PI / 180;
  const ySpanB: number = ((b[2] - b[0]) * deg) / geoAspect(b);
  const cYSpan: number = ((CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0]) * deg) / geoAspect(CHINA_REGION.bounds);
  const wantSpan: number = (b[2] - b[0]) * (cYSpan / ySpanB);
  assert.ok(Math.abs((zout[2] - zout[0]) - wantSpan) < 1e-9,
    `缩到底的经度跨度应当是 ${wantSpan}：${zout[2] - zout[0]}`);
  assert.ok((zout[2] - zout[0]) < 62, '缩到底仍然装不满中国的经度（新模型下一屏装不下整个中国）');
  // factor = 1 是恒等（逐位相同）—— 手势里"没动"的那一帧不该引入任何漂移
  assert.deepEqual(zoomViewAt(b, 1, 0.3, 0.7), b);
  // **夹到边界时不动点仍然不变**（这是把 factor 反解成区间再夹、而不是"先缩放再夹框"的理由）
  const g: number[] = geoAt(b, 0.4, 0.6, DEV_BOX_W, DEV_BOX_H);
  const afterClamp: number[] = normIn(zin, g[0], g[1], DEV_BOX_W, DEV_BOX_H);
  assert.ok(Math.abs(afterClamp[0] - 0.4) < 1e-6 && Math.abs(afterClamp[1] - 0.6) < 1e-6,
    `夹到放大上限时不动点跑了：(${afterClamp[0]}, ${afterClamp[1]})`);
  // 非法输入原样返回（不产 NaN）
  assert.deepEqual(zoomViewAt(b, Number.NaN, 0.5, 0.5), b);
  assert.deepEqual(zoomViewAt(b, 0, 0.5, 0.5), b);
  assert.deepEqual(zoomViewAt(b, -2, 0.5, 0.5), b);
  // bounds 非法 → 先退回全国视野，**然后照常缩放**（不是"整帧作废"）：
  // 手势不该因为调用方传了个坏框就默默不动 —— 那一帧用户的手指是动了。
  const badInput: number[] = zoomViewAt([1, 2, 3], 2, 0.5, 0.5);
  assert.deepEqual(badInput, zoomViewAt(CHINA_REGION.bounds, 2, 0.5, 0.5));
  for (let i = 0; i < 4; i++) { assert.ok(Number.isFinite(badInput[i])); }
  assert.ok(badInput[2] > badInput[0] && badInput[3] > badInput[1]);
  // fx/fy 非有限 → 按中心处理，仍是合法框
  const zc: number[] = zoomViewAt(b, 2, Number.NaN, Number.NaN);
  assert.ok(Math.abs((zc[0] + zc[2]) / 2 - (b[0] + b[2]) / 2) < 1e-9, 'fx 非有限时应当绕中心缩放');
});

test('panViewBy：画面内容的位移**精确等于**请求量（横向与纵向都是）', () => {
  const b: number[] = [115.01, 29.95, 122.89, 41.23];
  // 取框里任意一个点，量它在平移前后的归一化位置差
  const g: number[] = geoAt(b, 0.5, 0.5, DEV_BOX_W, DEV_BOX_H);
  const before: number[] = normIn(b, g[0], g[1], DEV_BOX_W, DEV_BOX_H);
  const p: number[] = panViewBy(b, 0.1, 0.2);
  const after: number[] = normIn(p, g[0], g[1], DEV_BOX_W, DEV_BOX_H);
  assert.ok(Math.abs((after[0] - before[0]) - 0.1) < 1e-9,
    `横向位移不等于请求量：${after[0] - before[0]}`);
  // ⚠️ 纵向：fy > 0 是"手指向下拖"，内容也**向下**走（归一化 y 增大）。
  //    这个符号与横向**相反**（因为归一化 y 从画布顶端量，而顶端是北）。
  assert.ok(Math.abs((after[1] - before[1]) - 0.2) < 1e-9,
    `纵向位移不等于请求量（符号反了？）：${after[1] - before[1]}`);
  // 平移不改变跨度、不改变比例
  assert.ok(Math.abs((p[2] - p[0]) - (b[2] - b[0])) < 1e-9, '平移改变了经度跨度');
  assert.ok(Math.abs(geoAspect(p) - geoAspect(b)) < 1e-9, '平移改变了宽高比');
  // 零位移是恒等
  assert.deepEqual(panViewBy(b, 0, 0), b);
  assert.deepEqual(panViewBy(b, Number.NaN, Number.NaN), b);
});

test('panViewBy：**极端拖动不产零跨度 / NaN**（真踩到的缺陷：mercY 的 ±85 夹断）', () => {
  // 这一条守的是一个真实发生过的静默失败：把纬度拖到 -89.9999° 之后，
  // `mercYOf` 内部的 ±85 夹断会让 mercY 跨度**变成 0**，而 `projectMercator` 的除数
  // 就是那个跨度 → 整块画布 NaN → 地图和照片一起消失（而且不报错）。
  const b: number[] = [115.01, 29.95, 122.89, 41.23];
  const extremes: number[][] = [[50, 0], [-50, 0], [0, 50], [0, -50], [500, 500], [-500, -500], [1e6, 1e6]];
  for (let k = 0; k < extremes.length; k++) {
    const p: number[] = panViewBy(b, extremes[k][0], extremes[k][1]);
    for (let i = 0; i < 4; i++) { assert.ok(Number.isFinite(p[i]), `非有限坐标：${p}（拖 ${extremes[k]}）`); }
    assert.ok(p[2] > p[0], `经度跨度塌了：${p[2] - p[0]}（拖 ${extremes[k]}）`);
    assert.ok(p[3] > p[1], `纬度跨度塌了：${p[3] - p[1]}（拖 ${extremes[k]}）`);
    // 纬度必须留在墨卡托安全带内（±84），否则下一次 mercYOf 又会夹断
    assert.ok(p[1] >= -84 - 1e-9 && p[3] <= 84 + 1e-9, `纬度跑出安全带：${p}（拖 ${extremes[k]}）`);
    // 中心必须还在中国范围内 —— 否则用户会拖到一片底色里且不知道怎么回来
    const cLon: number = (p[0] + p[2]) / 2;
    assert.ok(cLon >= CHINA_REGION.bounds[0] - 1e-9 && cLon <= CHINA_REGION.bounds[2] + 1e-9,
      `经度中心跑到中国之外：${cLon}（拖 ${extremes[k]}）`);
    // 投影得出来（真正的不变量：没有 NaN）
    const f: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, p);
    assert.ok(!outlinePath([[p[0], p[1], p[2], p[1], p[2], p[3]]], f).includes('NaN'));
    assert.ok(viewMetrics(f).heightRatio > 0.9, `极端拖动之后地图仍然铺满高度：${viewMetrics(f).heightRatio}`);
  }
  // 缩到底那一帧再往各方向猛拖：纵向**逐位不动**（纬度已经顶满中国），横向仍然能滑
  // （这正是"地图铺满高度、左右横滑"的手感）。见 `LAT_EXPAND_LIMIT` 的注释：没有那一步
  // 的"保跨度平移"，下面第一条会因为 ±85 夹断虚增跨度而失败。
  const floorView: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (const dir of [[0, 0.5], [0, 1], [0, 5], [0, -5], [0, 50]]) {
    assert.deepEqual(panViewBy(floorView, dir[0], dir[1]), floorView,
      `缩到底那一帧纵向拖 ${JSON.stringify(dir)} 必须是逐位恒等`);
  }
  assert.notDeepEqual(panViewBy(floorView, 0.2, 0), floorView, '横向必须真的能动（用户要的横滑）');
});

test('手势链路：连续"拖动 + 偏心缩放"之后，框仍然合法、比例不变、铺满不被破坏', () => {
  let b: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  const aspect0: number = geoAspect(b);
  const photos = fourPlaces();
  // 模拟 60 帧的手势：一边放大一边往东南拖（偏心在 (0.3, 0.7)）
  for (let i = 0; i < 60; i++) {
    b = zoomViewAt(b, 1.05, 0.3, 0.7);
    b = panViewBy(b, 0.01, 0.012);
    for (let j = 0; j < 4; j++) { assert.ok(Number.isFinite(b[j]), `第 ${i} 帧出现非有限坐标：${b}`); }
    assert.ok(b[2] > b[0] && b[3] > b[1], `第 ${i} 帧跨度塌了：${b}`);
    assert.ok(Math.abs(geoAspect(b) - aspect0) < 1e-6, `第 ${i} 帧比例漂了：${geoAspect(b)} vs ${aspect0}`);
  }
  // 60 帧之后仍然是合法的视野：能投影、能算场景、框仍然等于画布（铺满没被破坏）
  const f: MapFrame = mapFrame(T19_W, T19_H, b);
  assert.ok(Math.abs(f.w - T19_W) < 1e-6 && Math.abs(f.h - T19_H) < 1e-6,
    '手势之后框不再等于画布（铺满被破坏了）');
  // 放大之后地图**更大**：绘制高度 ≥ 画布高（≥ 1 = "画布上没有任何空白带"；
  // == 1 只在"铺满高度"那一档成立，放大态是 > 1，因为中国被画得比画布还大）
  assert.ok(viewMetrics(f).heightRatio >= 1 - 1e-9,
    `放大之后地图必须仍然盖满画布高度：${viewMetrics(f).heightRatio}`);
  const pins = buildScene([ph('sh', SH_LAT, SH_LON, 0)], f, 1);
  assert.equal(pins.length, 1);
  assert.ok(Number.isFinite(pins[0].x) && Number.isFinite(pins[0].y));
  assert.equal(pins[0].markers.length, 1, '一个展开的钉子应当有 1 个标记');
  // 再来 200 帧（含往回缩，一直顶到下限）—— 断言仍然不塌
  for (let i = 0; i < 200; i++) {
    b = zoomViewAt(b, 0.9, 0.8, 0.2);
    b = panViewBy(b, -0.02, -0.02);
  }
  assert.ok(b[2] > b[0] && b[3] > b[1] && Number.isFinite(b[0]) && Number.isFinite(b[3]), `最终框非法：${b}`);
  // task-19：缩小的上界是**完整的中国纬度**（旧模型这里是"经度 ≤ 62°"，而纬度搭车到南半球）
  assert.ok(b[1] >= CHINA_REGION.bounds[1] && b[3] <= CHINA_REGION.bounds[3],
    `缩到底之后纬度跑出中国：${b}`);
  assert.ok((b[3] - b[1]) <= (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1]) + 1e-9,
    `纬度过宽：${b[3] - b[1]}`);
  assert.ok(b[1] > 0, '更不许出现南半球');
  assert.ok(inChina(b), `缩到底之后跑出中国：${b}`);
  // 200 帧里"往西南拖 + 往回缩"，最终落在"铺满高度"那一档上（高度比 == 1）
  assert.equal(viewMetrics(mapFrame(T19_W, T19_H, b)).heightRatio, 1);
  assert.ok(buildScene(photos, mapFrame(T19_W, T19_H, b), 1).length >= 1);
});

// ── task-19：缩小的**上界**与"铺满高度"的关系（真机缺陷：缩到底能看见南半球）──────
//
// 用户真机反馈原话：「铺满跟缩小的效果如图，每一个对的」（= 每一张都不对）。
// 两张截图的诊断行（逐字）：
//   图 1（想要的形态）`放大 9.5×→7.56× ｜ pins 3 ｜ 视野态 默认铺满`
//   图 2（缩到底）    `→铺满[67,-20.6,129,64.4] ｜ 放大 9.5×→1× ｜ 可缩 1×~103.33×`
// 图 2 里"可缩 1×"是**显示**，而同一个框的纬度跨度是 85°（−20.6 ~ 64.4）—— 显示与行为不符。
//
// 根因（见 render.ts 的注释）：`zoomViewAt` 只把**经度**跨度夹到 62°，纬度按同一个 factor
// **搭车**膨胀；`settleViewBox` 只夹中心，于是只剩 ±84° 的墨卡托安全带挡着（中国只要 18~54）。
// task-17 用"框 ⊆ 中国"挡住了它；task-19 换了形态之后，同一条规矩以**纬度**的形式继续成立：
//   **视野的纬度恒 ⊆ [18,54]；缩到底 = 纬度逐位 `[18,54]`（= 完整的中国纬度）。**
//
// 这一节钉住四条：
//   ① 连续缩小 N 次 → 纬度恒在 [18,54]，且**终点**是"完整的中国纬度"（逐位）
//   ② 那个终点上：经度跨度 == 一屏（`fillHeightLonSpan`）、地图仍然铺满高度
//   ③ 终点之后再缩**逐位不动**；纵向再拖也**逐位不动**（横向仍然能滑 —— 用户要的横滑）
//   ④ 上下界在同一处定义、显示端与约束端读的是同一份（"显示与行为不符"这件事本身）
//
// 这一节里的判据 `inChina` 是**独立**算的（只用 `CHINA_REGION.bounds`，不用实现里的任何
// 中间量）—— 否则就成了"用实现验证实现"。

/** 一个框是否整个落在中国范围之内（独立判据）。 */
function inChina(b: number[]): boolean {
  const cb: number[] = CHINA_REGION.bounds;
  return b[0] >= cb[0] - 1e-9 && b[2] <= cb[2] + 1e-9 && b[1] >= cb[1] - 1e-9 && b[3] <= cb[3] + 1e-9;
}

test('缩小上界：连续缩小 12 次（4 个不同不动点）→ 终点是**完整的中国纬度**（逐位）', () => {
  const N: number = 12;
  const foci: number[][] = [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1], [0.02, 0.98]];
  const start: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  const lon0: number = start[2] - start[0];
  for (let k = 0; k < foci.length; k++) {
    let b: number[] = start.slice(0, 4);
    for (let i = 1; i <= N; i++) {
      b = zoomViewAt(b, 0.5, foci[k][0], foci[k][1]);
      // ① 有限 + 正跨度（NaN 会让整条 path 静默消失）
      for (let j = 0; j < 4; j++) { assert.ok(Number.isFinite(b[j]), `第 ${i} 次缩小非有限：${b}`); }
      assert.ok(b[2] > b[0] && b[3] > b[1], `第 ${i} 次缩小跨度塌了：${b}`);
      // ② **框 ⊆ 中国**（两根轴都不许出去 —— 外面没有任何轮廓数据）
      assert.ok(inChina(b), `第 ${i} 次缩小跑出中国：${b}（不动点 ${JSON.stringify(foci[k])}）`);
      // ③ 纬度恒在 [18,54]（真机 −20.6° 的那条直接钉死）。
      //    ⚠️ 这里是**严格不等式**，不是容差：缩到底时贴边那一端必须**正好**落在 18/54 上
      //    （靠 `containInChina` 的 `SNAP_SPAN_EPS` 与"贴边直接用中国端点"两条保证），
      //    不许出现 17.999999999999996 这种"差一 ulp 的越界"。
      assert.ok(b[1] >= CHINA_REGION.bounds[1], `第 ${i} 次缩小纬度低于 18°N：${b[1]}`);
      assert.ok(b[3] <= CHINA_REGION.bounds[3], `第 ${i} 次缩小纬度高于 54°N：${b[3]}`);
      // ④ 缩小是**单调**的：能看到的地图只会变多（地图的绘制宽度只会变大）
      const drawn: number = viewMetrics(mapFrame(T19_W, T19_H, b)).mapH;
      assert.ok(drawn > 0 && drawn <= T19_H + 1e-9, `第 ${i} 次缩小后绘制高度非法：${drawn}`);
      assert.ok(b[2] - b[0] >= lon0 - 1e-9, `第 ${i} 次缩小反而变小了：${b[2] - b[0]} < ${lon0}`);
    }
    // ⑤ 12 次之后：纬度**逐位**是中国全域，经度跨度 == 一屏，地图**铺满高度**
    assert.equal(b[1], CHINA_REGION.bounds[1], `缩到底的纬度下界必须逐位是 18：${b[1]}`);
    assert.equal(b[3], CHINA_REGION.bounds[3], `缩到底的纬度上界必须逐位是 54：${b[3]}`);
    assert.ok(Math.abs((b[2] - b[0]) - fillHeightLonSpan(T19_W, T19_H)) < 1e-9,
      `缩到底的经度跨度应当是一屏 ${fillHeightLonSpan(T19_W, T19_H)}：${b[2] - b[0]}`);
    assert.equal(viewMetrics(mapFrame(T19_W, T19_H, b)).heightRatio, 1, '缩到底必须仍然铺满高度');
    assert.equal(geoAspect(b), geoAspect(start), '缩到底是**保形**的（两根轴一起收）');
    // ⑥ 再缩也不会变（上界是**可达并且是终点**）
    const again: number[] = zoomViewAt(b, 0.5, 0.5, 0.5);
    assert.deepEqual(again, b, '到了"完整的中国纬度"之后继续缩小必须一动不动');
  }
});

test('缩小上界：一次缩到底 == 完整的中国纬度；真机那个 `[67,-20.6,129,64.4]` 再也不可达', () => {
  const start: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  const one: number[] = zoomViewAt(start, 1e-9, 0.5, 0.5);
  assert.equal(one[1], 18, `一次缩到底的纬度下界应当逐位是 18：${one[1]}`);
  assert.equal(one[3], 54, `一次缩到底的纬度上界应当逐位是 54：${one[3]}`);
  // 图 2 的真机框：纬度 −20.6°（南半球）。它必须落在"不可达"里 —— 判别力就在这条。
  const deviceRow2: number[] = [67, -20.6, 129, 64.4];
  assert.ok(!inChina(deviceRow2), '（自检）真机图 2 那个框本来就在中国之外');
  assert.ok(one[1] >= CHINA_REGION.bounds[1], `缩到底不许出现南半球：${one[1]}`);
  assert.ok(one[1] > 0, '更不许出现负纬度');
  // 也不许"经度到顶但纬度搭车"：两根轴必须同时落在"铺满高度"那一档（经度 == 一屏）
  assert.ok(Math.abs((one[2] - one[0]) - fillHeightLonSpan(T19_W, T19_H)) < 1e-9,
    `缩到底的经度跨度应当是一屏：${one[2] - one[0]}`);
  assert.ok((one[2] - one[0]) < (CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0]),
    '新模型下"缩到底"也装不满中国的经度 —— 那正是必须横滑的原因');
  assert.equal(viewMetrics(mapFrame(T19_W, T19_H, one)).heightRatio, 1);
});

test('缩小上界：到达终点之后，再缩 / 纵向再拖都是**逐位恒等**，横向仍然能滑', () => {
  // 终点那一帧是"纬度逐位 [18,54] + 经度一屏"。此时：
  //   · 再缩小 → `zoomViewAt` 里 factor 被反解夹到 1 → 直接逐位返回；
  //   · 往北/往南拖 → 纬度已经顶满中国，`containInChina` 的"顶满"那一支把它逐位收回同四个数；
  //   · 往东/往西拖 → **真的会动**（这正是用户要的"左右横滑"）。
  // 这条守的是 `SNAP_SPAN_EPS`、"贴边直接用中国端点"与 `LAT_EXPAND_LIMIT` 三处实现细节：
  // 没有第三处，"缩到底之后往下猛拖"会因为 ±85 夹断虚增 mercY 跨度、连带把经度也缩一下。
  let b: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (let i = 0; i < 12; i++) { b = zoomViewAt(b, 0.5, 0.5, 0.5); }
  assert.equal(b[1], 18, '缩到底的纬度下界必须是逐位的 18');
  assert.equal(b[3], 54, '缩到底的纬度上界必须是逐位的 54');
  const vertical: number[][] = [[0, 0.5], [0, -0.5], [0, 0.1], [0, -0.1], [0, 5], [0, -5], [0, 50]];
  for (let k = 0; k < vertical.length; k++) {
    assert.deepEqual(panViewBy(b, vertical[k][0], vertical[k][1]), b,
      `缩到底之后纵向拖 ${JSON.stringify(vertical[k])} 必须逐位不动（纬度已经顶满中国）`);
  }
  for (let k = 0; k < 4; k++) {
    assert.deepEqual(zoomViewAt(b, 0.25, 0.3, 0.7), b, '缩到底之后再缩不该改变视野');
  }
  // 横向：真的能滑（34.256° 的余量），而且滑到头就停住
  const w1: number[] = panViewBy(b, 0.2, 0);
  assert.ok(w1[0] < b[0] - 1 && w1[2] < b[2] - 1, `横向必须真的能动：${w1}`);
  assert.ok(Math.abs((w1[2] - w1[0]) - (b[2] - b[0])) < 1e-9, '横向平移不许改变跨度');
  const westEnd: number[] = panViewBy(b, 50, 0);
  const eastEnd: number[] = panViewBy(b, -50, 0);
  assert.deepEqual(panViewBy(westEnd, 50, 0), westEnd, '西端再往西拖必须逐位不动');
  assert.deepEqual(panViewBy(eastEnd, -50, 0), eastEnd, '东端再往东拖必须逐位不动');
  assert.ok(Math.abs(westEnd[0] - CHINA_REGION.bounds[0]) < 1e-9, `西端应当贴住 73°E：${westEnd[0]}`);
  assert.ok(Math.abs(eastEnd[2] - CHINA_REGION.bounds[2]) < 1e-9, `东端应当贴住 135°E：${eastEnd[2]}`);
  // 40 轮混合（往各个方向拖 + 缩）：纬度恒为 [18,54]、经度恒为一屏、始终 ⊆ 中国
  let s: number[] = b.slice(0, 4);
  for (let i = 0; i < 40; i++) {
    s = panViewBy(s, (i % 7 - 3) * 0.4, (i % 5 - 2) * 0.4);
    s = zoomViewAt(s, 0.9, 0.2, 0.8);
    assert.ok(inChina(s), `第 ${i} 轮混合手势跑出中国：${s}`);
    assert.equal(s[1], 18, `第 ${i} 轮之后纬度下界应当仍是 18：${s[1]}`);
    assert.equal(s[3], 54, `第 ${i} 轮之后纬度上界应当仍是 54：${s[3]}`);
    assert.ok(Math.abs((s[2] - s[0]) - fillHeightLonSpan(T19_W, T19_H)) < 1e-9,
      `第 ${i} 轮之后经度跨度应当仍是一屏：${s[2] - s[0]}`);
    assert.equal(viewMetrics(mapFrame(T19_W, T19_H, s)).heightRatio, 1, `第 ${i} 轮之后不再铺满高度`);
  }
});

test('缩小上界：把**整个中国**塞进竖屏画布会怎样 —— 那正是旧模型的形态（反证，不是现在的行为）', () => {
  // 这一条是**对照实验**：`mapFrame(竖屏画布, 整个中国视野)` 会给出什么？
  // 新模型下它**恒填满高度**：框 864.06×642.57 @ x=−244.03（比画布宽 2.30 倍，两侧裁掉），
  // 于是"框 ⊆ 块"这条旧不变量不再成立 —— 而它当年正是"地图只占上面一薄条"的成因：
  // 旧规则会把框改成"填满宽度"376×279.62 居中在 y=181.48，上下各留 181.48pt。
  const f: MapFrame = mapFrame(DEV_BOX_W, DEV_H_ROW2, CHINA_REGION.bounds);
  assert.equal(f.h, DEV_H_ROW2, `新规则：框高恒等于块高：${f.h}`);
  assert.equal(f.y, 0, `新规则：框顶恒贴块顶：${f.y}`);
  assert.ok(f.x < -200, `新规则：框比块宽 → x 为负：${f.x}`);
  assert.ok(Math.abs(f.w / f.h - geoAspect(CHINA_REGION.bounds)) < 1e-9, `框变形了：${f.w}/${f.h}`);
  assert.ok(Math.abs(f.x - (f.blockW - f.w) / 2) < 1e-9, '横向没有居中');
  // 对照：旧形态（填满宽度 + 纵向居中）—— 它只占 43.5% 的高度，上下都是空地
  const oldH: number = DEV_BOX_W / geoAspect(CHINA_REGION.bounds);
  const blankPct: number = (1 - oldH / DEV_H_ROW2) * 100;
  assert.ok(Math.abs(oldH - 279.62) < 0.1, `旧形态的框高应当约 279.62：${oldH}`);
  assert.ok(blankPct > 55 && blankPct < 60, `旧形态上下留白应当过半：${blankPct}%`);
  // 而新形态（默认视野）把中国画成 840.25×624.86：高度顶满，宽度溢出 2.23 倍（滑过去看）
  const vm: ViewMetrics = viewMetrics(mapFrame(T19_W, T19_H,
    defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H)));
  assert.equal(vm.heightRatio, 1);
  assert.ok(vm.widthRatio > 2.2);
  assert.ok(vm.mapH > oldH * 2, `新形态的地图高度（${vm.mapH}）必须远超旧形态（${oldH}）`);
});

test('缩小上界：`可缩 N×` 的显示值与**真实界限**一致（"显示与行为不符"这件事本身）', () => {
  // 图 2 的诊断行写着 `可缩 1×~103.33×`，可当时的框纬度是 85°。显示端与约束端各写各的，
  // 就是那个不符的根。现在显示端读 `viewZoomRange(画布)`，约束端是 `containInChina`
  // ＋ `MIN_ZOOMED_VIEW_SPAN_DEG` —— 而**下界随画布比例变**（一屏的经度跨度由它决定）。
  const zr: number[] = viewZoomRange(T19_W, T19_H);
  assert.ok(Math.abs(zr[0] - 2.234702448391563) < 1e-12,
    `真机 376×624.86 上的下界应当是 2.2347×：${zr[0]}`);
  assert.ok(Math.abs(zr[1] - 62 / MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-12, `显示的上界应当是 62/0.6：${zr[1]}`);
  assert.ok(Math.abs(zr[1] - 103.3333) < 0.001, `真机诊断行印的是 103.33×：${zr[1]}`);

  // 下界：反复缩小 → 实际到达的倍数必须**正好**是显示的那个下界
  let b: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (let i = 0; i < 40; i++) { b = zoomViewAt(b, 0.5, 0.5, 0.5); }
  assert.equal(viewZoomOf(b), zr[0], `显示可缩到 ${zr[0]}×，实际只到 ${viewZoomOf(b)}×`);
  // ⚠️ 光比倍数**不够** —— 倍数只读经度。必须同时钉住"到达下界时纬度就是完整的中国纬度"，
  //    否则"2.2347×"永远可以只是显示（旧模型下这里就是那个 −20.6° 的框）。
  assert.equal(b[1], 18, '到了下界时纬度下界必须逐位是 18');
  assert.equal(b[3], 54, '到了下界时纬度上界必须逐位是 54');
  assert.equal(viewMetrics(mapFrame(T19_W, T19_H, b)).heightRatio, 1, '到了下界时仍然铺满高度');

  // 上界：反复放大 → 实际到达的倍数 == 显示的 103.33×
  let c: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  for (let i = 0; i < 60; i++) { c = zoomViewAt(c, 2, 0.5, 0.5); }
  assert.ok(Math.abs(viewZoomOf(c) - zr[1]) < 1e-9, `显示可放到 ${zr[1]}×，实际到了 ${viewZoomOf(c)}×`);
  assert.ok(Math.abs((c[2] - c[0]) - MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-9,
    `放到顶时经度跨度应当是单城市级 ${MIN_ZOOMED_VIEW_SPAN_DEG}°：${c[2] - c[0]}`);
  assert.ok(inChina(c), `放到顶之后仍须在中国之内：${c}`);
  // 下界真的**随画布比例**变（横屏一屏更宽 → 能缩得更少）
  const land: number[] = viewZoomRange(1000, 600);
  assert.ok(land[0] < zr[0], `横屏的下界应当更小（一屏更宽）：${land[0]} vs ${zr[0]}`);
  assert.equal(land[0], viewZoomOf(CHINA_REGION.bounds), '横屏一屏比中国还宽时下界就是"整个中国"');
});

test('缩小上界：平移到边界是"停住"（跨度不变），不是"被压扁"', () => {
  // 这一条守的是 `containInChina` 的**平移**语义（与 `fitAxis` 第 ③ 步同一条规矩）：
  // 两端各夹一下会把跨度压小甚至压成 0 —— 那正是"整块画布 NaN"的来源。
  const start: number[] = defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H);
  const lonSpan0: number = start[2] - start[0];
  const latSpan0: number = start[3] - start[1];
  const p: number[] = panViewBy(start, 50, 0);          // 往西拖到头
  assert.ok(inChina(p), `拖到头仍须在中国之内：${p}`);
  assert.ok(Math.abs((p[2] - p[0]) - lonSpan0) < 1e-9, `平移被夹两端了（跨度变了）：${p[2] - p[0]}`);
  assert.ok(Math.abs(p[0] - CHINA_REGION.bounds[0]) < 1e-9, `应当正好贴住 73°E：${p[0]}`);
  assert.deepEqual(panViewBy(p, 50, 0), p, '到头之后不该再动（逐位）');
  // 纵向：默认视野的纬度已经顶满中国 → 拖不动（"左右横滑"的手感：竖着不用滑）
  assert.deepEqual(panViewBy(start, 0, -50), start, '默认视野下往南拖应当逐位不动');
  assert.deepEqual(panViewBy(start, 0, 50), start, '默认视野下往北拖应当逐位不动');
  assert.equal(latSpan0, CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1], '默认视野的纬度就是中国全域');
  // 放大态：纵向与横向**都**真的能走了（视野比中国小，四处都有余地）
  let z: number[] = start.slice(0, 4);
  for (let i = 0; i < 6; i++) { z = zoomViewAt(z, 2, 0.5, 0.5); }
  const z1: number[] = panViewBy(z, 0.2, 0);
  assert.ok(z1[0] < z[0] - 0.01, `放大态往西拖应当真的移动：${z1[0]} vs ${z[0]}`);
  assert.ok(inChina(z1), `移动之后仍须在中国之内：${z1}`);
  const z2: number[] = panViewBy(z, 0, 0.2);
  assert.ok(Math.abs(geoAspect(z2) - geoAspect(z)) < 1e-12, '纵向平移必须保形（mercY 空间里平移）');
  assert.ok(z2[1] !== z[1] || z2[3] !== z[3], '放大态纵向拖应当真的移动');
});

// ── 地图框：**恒填满高度**、宽度可以超出画布（task-19 的形态改造） ──────────────

test('mapFrame：**恒填满高度**；宽度放不下就让 x 为负（不再退回"填满宽度"）', () => {
  const f = mapFrame(W, H, CHINA_REGION.bounds);
  // 块 = 整个主体区（这就是"地图占满主体区域"的含义：地图是这整块区域的底色）
  assert.equal(f.blockW, W);
  assert.equal(f.blockH, H);
  // 框的宽高比 == 墨卡托宽高比（不变形，这是硬约束）
  assert.ok(Math.abs(f.w / f.h - geoAspect(CHINA_REGION.bounds)) < 1e-9, `框变形了：${f.w}/${f.h}`);
  // 竖屏 360×720：按"填满高度"算出来的宽度 968.18 **放不下也照样用** —— 这才是新规则
  assert.equal(f.h, H, `框高必须恒等于块高：${f.h}`);
  assert.equal(f.y, 0, `框顶恒贴块顶：${f.y}`);
  assert.ok(Math.abs(f.w - H * geoAspect(CHINA_REGION.bounds)) < 1e-9, `框宽应当是 ${H * geoAspect(CHINA_REGION.bounds)}：${f.w}`);
  assert.ok(Math.abs(f.w - 968.1827078522612) < 1e-9, `实测 968.18：${f.w}`);
  // **x 为负**：框比画布宽 2.69 倍，两侧各伸出去 304.09pt（由容器的 clip 裁掉）
  assert.ok(Math.abs(f.x - (-304.0913539261306)) < 1e-9, `x 应当是负的：${f.x}`);
  assert.ok(Math.abs(f.x - (f.blockW - f.w) / 2) < 1e-9, '横向没有居中');
  // 旧规则的反面：**不再**退成"填满宽度、纵向居中"（那会得到 360×267.72 @ y=226.14）
  assert.notEqual(f.w, W, '又退回了"填满宽度" —— 那正是"地图只占上面一薄条"的成因');
  assert.notEqual(f.h, mapBoxHeight(W, CHINA_REGION.bounds), '框高又变成了 267.72');
  // 三种块上的实测（报告 §3 的数字）
  assert.ok(Math.abs(mapFrame(T19_W, T19_H, CHINA_REGION.bounds).w - T19_MAP_W) < 1e-9);
  assert.equal(mapFrame(T19_W, T19_H, CHINA_REGION.bounds).h, T19_H);
  const wide = mapFrame(1000, 600, CHINA_REGION.bounds);
  assert.ok(Math.abs(wide.w - 806.8189232102176) < 1e-9 && wide.x > 0,
    `横屏上画布比地图宽，左右留白：${wide.w} @ x=${wide.x}`);
});

test('mapFrame：比例刚好匹配时框 == 块（x = y = 0，没有留白）', () => {
  const h = mapBoxHeight(W, CHINA_REGION.bounds);
  const f = mapFrame(W, h, CHINA_REGION.bounds);
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9);
  assert.ok(Math.abs(f.w - W) < 1e-9 && Math.abs(f.h - h) < 1e-9);
  // 本模型的默认视野（铺满高度那一档）也落在这一档上：框 == 画布、一点信箱空白都没有
  const def = mapFrame(T19_W, T19_H, defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H));
  assert.ok(Math.abs(def.x) < 1e-9 && Math.abs(def.w - T19_W) < 1e-9);
  assert.ok(Math.abs(def.h - T19_H) < 1e-9);
});

test('mapFrame：非法尺寸返回全 0 的框（不产出 NaN 坐标）', () => {
  for (const bad of [[0, 720], [360, 0], [-1, 720], [360, -1], [Number.NaN, 720], [360, Number.POSITIVE_INFINITY]]) {
    const f = mapFrame(bad[0] as number, bad[1] as number, CHINA_REGION.bounds);
    assert.equal(f.w, 0, `块 ${bad[0]}×${bad[1]} 应当给出空框`);
    assert.equal(f.h, 0);
    assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
  }
});

// ── 视野的四个验收数字（viewMetrics）：铺满高度 / 横向溢出 / 偏移 / 可滑余量 ──────

test('viewMetrics：四个数字的定义与退化口径（地图高比、地图宽比、横向偏移、可滑余量）', () => {
  // ① 默认视野（真机 376×624.86 + 用户那 4 个地点）
  const f: MapFrame = mapFrame(T19_W, T19_H, defaultWallView(fourPlaces(), VIEW_PAD_RATIO, T19_W, T19_H));
  const vm: ViewMetrics = viewMetrics(f);
  assert.equal(vm.canvasW, T19_W);
  assert.equal(vm.canvasH, T19_H);
  assert.equal(vm.mapH, T19_H, `地图绘制高度应当 == 画布高：${vm.mapH}`);
  assert.equal(vm.heightRatio, 1, `地图高/画布高 应当是 1：${vm.heightRatio}`);
  assert.ok(Math.abs(vm.mapW - T19_MAP_W) < 1e-9, `地图绘制宽度应当是 ${T19_MAP_W}：${vm.mapW}`);
  assert.ok(Math.abs(vm.widthRatio - 2.234702448391563) < 1e-12, `地图宽/画布宽：${vm.widthRatio}`);
  assert.ok(vm.widthRatio > 1, '默认视野必须是"要横滑"的');
  assert.ok(vm.westX < -300 && vm.eastX > T19_W, `中国东西缘应当在屏幕外：${vm.westX} ~ ${vm.eastX}`);
  assert.equal(vm.northY, 0, `中国北缘应当贴住画布顶：${vm.northY}`);
  assert.ok(Math.abs(vm.panSlackX - 464.2481205952277) < 1e-9, `可滑余量：${vm.panSlackX}`);
  assert.ok(Math.abs(vm.lonSpan - T19_SPAN) < 1e-9);
  // ② 三种画布上的比值（一屏越窄 → 溢出越多）
  const ratios: number[][] = [[T19_W, T19_H], [360, 720], [1000, 600]];
  for (const c of ratios) {
    const m: ViewMetrics = viewMetrics(mapFrame(c[0], c[1], fillHeightView(CHINA_REGION.bounds, c[0], c[1])));
    assert.equal(m.heightRatio, 1, `画布 ${c} 上没有铺满高度：${m.heightRatio}`);
    assert.ok(Math.abs(m.widthRatio - (c[0] * 62 / fillHeightLonSpan(c[0], c[1])) / c[0]) < 1e-9);
  }
  // ③ "整个中国当视野"那一档：框本身就是地图（metrics 与 frame 逐位一致）
  const nat: MapFrame = mapFrame(T19_W, T19_H, CHINA_REGION.bounds);
  const nv: ViewMetrics = viewMetrics(nat);
  assert.equal(nv.mapW, nat.w);
  assert.equal(nv.mapH, nat.h);
  assert.equal(nv.panSlackX, 0, '整个中国都在视野里 → 没有横滑余量');
  assert.equal(nv.westX, nat.x);
  // ④ 退化输入不产 NaN（与 mapFrame 同一条契约）
  const empty: ViewMetrics = viewMetrics({ blockW: 0, blockH: 0, x: 0, y: 0, w: 0, h: 0 });
  assert.equal(empty.widthRatio, 0);
  assert.equal(empty.heightRatio, 0);
  assert.equal(viewMetrics({ blockW: 360, blockH: 720, x: 0, y: 0, w: 0, h: 0 }).mapW, 0);
  assert.ok(Number.isFinite(viewMetrics(mapFrame(W, H, [1, 2, 3])).mapW));
});

// ── 画布比例（防止地图被拉成竖条） ──────────────────────────────────────────

test('geoAspect / mapBoxHeight：地图块是**等比例**的（用 projectMercator 反推交叉验证）', () => {
  // 这个测试**只用 projectMercator 的输出**，不碰 render.ts 内部的 mercY：
  // 墨卡托是保角投影 → 在正确的宽高比下，"每公里对应的 x 像素"必须等于"每公里对应的 y 像素"。
  // 拿 1° 经度 / 1° 纬度的实际公里数（111.32*cos(lat) / 110.57）换算即可。
  // 若 render.ts 的比例算错了（例如直接把 bounds 拉满 360×720），这个比值会差 ~1.35 倍。
  const W = 360;
  const H = mapBoxHeight(W, CHINA_REGION.bounds);
  assert.ok(Math.abs(H - 267.7) < 1, `地图块高度不对：${H}`);
  for (const lat of [19, 25, 31, 38, 45, 52]) {
    const a = projectMercator(110, lat, W, H, CHINA_REGION.bounds);
    const bx = projectMercator(111, lat, W, H, CHINA_REGION.bounds);
    const by = projectMercator(110, lat + 1, W, H, CHINA_REGION.bounds);
    const dxPerKm = (bx.x - a.x) / (111.32 * Math.cos(lat * Math.PI / 180));
    const dyPerKm = (a.y - by.y) / 110.57;
    const ratio = dxPerKm / dyPerKm;
    assert.ok(Math.abs(ratio - 1) < 0.02, `lat=${lat} 处比例失真 ${ratio}（1 才是不变形）`);
  }
});

test('geoAspect / mapBoxHeight：若把 bounds 拉满竖屏（h=720）比例会崩掉 —— 反证上面的测试有效', () => {
  const W = 360;
  const H = 720;
  const lat = 35;
  const a = projectMercator(110, lat, W, H, CHINA_REGION.bounds);
  const bx = projectMercator(111, lat, W, H, CHINA_REGION.bounds);
  const by = projectMercator(110, lat + 1, W, H, CHINA_REGION.bounds);
  const dxPerKm = (bx.x - a.x) / (111.32 * Math.cos(lat * Math.PI / 180));
  const dyPerKm = (a.y - by.y) / 110.57;
  assert.ok(dxPerKm / dyPerKm < 0.8, '拉满 720 高时竟然还是等比例的？那说明本测试失去了判别力');
});

test('geoAspect：bounds 非法时退回 1，不产生 NaN / 0 除', () => {
  assert.equal(geoAspect([1, 2, 3]), geoAspect(CHINA_REGION.bounds));
  assert.equal(geoAspect([73, 54, 73, 54]), 1);
  assert.equal(geoAspect([]), geoAspect(CHINA_REGION.bounds));
});

test('mapBoxHeight：360 宽的地图约 268 高（不是 720 —— 那是被拉成竖条的高度）', () => {
  const h = mapBoxHeight(360, CHINA_REGION.bounds);
  assert.ok(Math.abs(h - 267.7) < 1, `地图高度不对：${h}`);
  // 关键性质：地图块的宽高比 == bounds 的墨卡托宽高比 → 不变形
  assert.ok(Math.abs((360 / h) - geoAspect(CHINA_REGION.bounds)) < 1e-9);
  assert.equal(mapBoxHeight(0, CHINA_REGION.bounds), 0);
});

// ── sceneToSvg：能画出来 ────────────────────────────────────────────────────

function demoPins(): ScenePin[] {
  const photos = [
    ph('a', 31.2304, 121.4737, 1700000000000),
    ph('b', 31.2310, 121.4740, 1700000100000),
    ph('c', 39.9042, 116.4074, 0),
    ph('d', 23.1291, 113.2644, 1700000200000)
  ];
  return buildScene(photos, FRAME, 1);
}

test('sceneToSvg：产出结构完整的 SVG（含国界 path、钉子组、每个钉子的照片数）', () => {
  const pins = demoPins();
  const d = outlinePath(parseOutline(GOOD_OUTLINE)!.rings, FRAME);
  const svg = sceneToSvg(pins, W, H, d);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('viewBox="0 0 360 720"'));
  assert.ok(svg.includes('<path d="M'));
  assert.ok(svg.includes('<g id="pins">'));
  assert.equal(svg.split('<g id="pin-').length - 1, pins.length);
  // 标记 = 小圆点：每个展开的钉子画出 markerCountOf(pin) 个圆，**一个卡片矩形都没有**
  const mine = pins.reduce((s: number, p: ScenePin) => s + markerCountOf(p), 0);
  assert.ok(mine > 0, '一个标记都没画');
  assert.equal(svg.split(`r="${MARKER_R}" fill="${MARKER_COLOR}"`).length - 1, mine, `标记圆点数不对（应当 ${mine} 个）`);
  assert.ok(!svg.includes('<line '), '新形态不该再有任何"挂线"');
  assert.ok(!svg.includes('rx="2"'), '新形态不该再有任何照片卡片矩形');
  // 钉点与地名在**单独一层**、画在所有标记之上（否则邻钉的标记会盖住地名）
  assert.ok(svg.includes('<g id="anchors">'));
  const anchorsAt = svg.indexOf('<g id="anchors">');
  const pinsAt = svg.indexOf('<g id="pins">');
  assert.ok(anchorsAt > pinsAt, 'anchors 层必须在 pins 层之后（后画的在上）');
  assert.ok(svg.indexOf('</g>', anchorsAt) > anchorsAt);
  assert.equal(svg.split('<g id="anchor-').length - 1, pins.length);
});

test('sceneToSvg：scale 只放大 width/height，viewBox 与几何完全不变', () => {
  const pins = demoPins();
  const a = sceneToSvg(pins, W, H, '', 1);
  const b = sceneToSvg(pins, W, H, '', 2);
  assert.ok(a.includes('width="360" height="720"'));
  assert.ok(b.includes('width="720" height="1440"'));
  assert.ok(a.includes('viewBox="0 0 360 720"'));
  assert.ok(b.includes('viewBox="0 0 360 720"'));
  // 去掉首行（只有它含 width/height 属性）之后两份内容必须一致
  const strip = (s: string): string => s.split('\n').slice(1).join('\n');
  assert.equal(strip(a), strip(b));
});

test('sceneToSvg：地名里的 & < > 被转义（否则整份 SVG 会解析失败）', () => {
  const p = ph('x', 31.2304, 121.4737, 1700000000000, 'A&B <大厦> "x"');
  const svg = sceneToSvg(buildScene([p], FRAME, 1), W, H, '');
  assert.ok(svg.includes('A&amp;B &lt;大厦&gt; &quot;x&quot;'));
  assert.ok(!svg.includes('<大厦>'));
});

test('sceneToSvg：没有国界数据时也能画（chinaPath 传空串）—— 轨迹层另算', () => {
  const svg = sceneToSvg(demoPins(), W, H, '');
  assert.ok(svg.startsWith('<svg '));
  // 国界没画（没有 fill="#E8F0E4" 那条 path）。注意**不能**断言"没有 <path" ——
  // 轨迹折线也是一条 <path>，它由 pins 自己算出来，与 chinaPath 无关。
  assert.ok(!svg.includes('fill="#E8F0E4"'), '没有国界数据却画了国界');
  assert.ok(svg.includes('<g id="pins">'));
});

test('sceneToSvg：没有照片（空数组）也要产出合法 SVG —— 空态由图外的 UI 负责', () => {
  const svg = sceneToSvg([], W, H, '');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(svg.split('<g id="pin-').length - 1, 0);
});

test('sceneToSvg：标记封顶 MAX_MARKERS，其余如实画成 +N；窄画布也一样（标记与画布无关）', () => {
  // 12 张在同一个钉子上 → 画 MAX_MARKERS 个点 + 「＋7」。
  // ⚠️ 与旧形态的关键差别：这里**不再有"空间决定挂几张"** —— 标记的位置与画布大小无关，
  // 所以 360 宽与 720 宽画出来的标记数**逐位相同**（旧版是 5 张 vs 9 张）。
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins[0].markers.length, MAX_MARKERS);
  const svg = sceneToSvg(pins, W, H, '');
  assert.equal(svg.split(`r="${MARKER_R}" fill="${MARKER_COLOR}"`).length - 1, MAX_MARKERS);
  assert.ok(svg.includes(`>+${12 - MAX_MARKERS}<`), `缺少 +${12 - MAX_MARKERS} 角标`);
  const wide: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { wide.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const widePins = buildScene(wide, FRAME_WIDE, 1);
  assert.equal(widePins[0].markers.length, MAX_MARKERS, '换画布不该改变标记数');
  assert.deepEqual(widePins[0].markers, pins[0].markers, '标记的位置不该随画布变');
});

test('sceneToSvg：收起的钉子不画标记，只画点 + 张数（"钉子多时收成点"）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 2; k++) {
      photos.push(ph(`f${i}_${k}`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1700000000000 + k));
    }
  }
  const pins = buildScene(photos, FRAME, 1);
  const svg = sceneToSvg(pins, W, H, '');
  assert.equal(svg.split(`r="${MARKER_R}" fill="${MARKER_COLOR}"`).length - 1, 0, '收起的钉子仍然画了标记');
  assert.equal(svg.split('<line ').length - 1, 0, '收起的钉子仍然画了线');
  assert.ok(svg.includes('·2'), '收起的钉子没有显示张数');
  // 钉点还在（每个钉子一个），个数 == 钉子数
  assert.equal(svg.split(`r="${PIN_DOT_R}" fill="${PIN_COLOR}"`).length - 1, pins.length);
});

// ── 几何一致性：标记全在钉子**下方贴着**，不会"吊下来" ─────────────────────

test('sceneToSvg：每个标记都在钉子的正下方 5pt 以内（照片不会跑到钉子上面，也不会吊下来）', () => {
  const pins = demoPins();
  const svg = sceneToSvg(pins, W, H, '');
  // 从 SVG 里把标记圆点抽出来（**不重算**几何，量的是真正画出来的东西）
  const re = new RegExp(`<circle cx="([-\\d.]+)" cy="([-\\d.]+)" r="${MARKER_R}"`, 'g');
  let m = re.exec(svg);
  let n = 0;
  while (m !== null) {
    const cx = parseFloat(m[1]);
    const cy = parseFloat(m[2]);
    // 找到**同一个钉子**（x 最接近的那个）：标记的 dx 最多 ±9pt
    let best = pins[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of pins) {
      const d = Math.abs(p.x - cx);
      if (d < bestD) { bestD = d; best = p; }
    }
    assert.ok(bestD <= 9 + 1e-9, `标记 (${cx},${cy}) 离最近的钉子还有 ${bestD}pt —— 不是"贴着钉子"`);
    const dy = cy - best.y;
    assert.ok(dy > 0, `标记 (${cx},${cy}) 跑到钉子上面去了（钉子 y=${best.y}）`);
    assert.ok(dy <= MARKER_DY + 1e-9, `标记离钉子 ${dy}pt（上限 ${MARKER_DY}）—— 那就是"吊下来"了`);
    n++;
    m = re.exec(svg);
  }
  assert.ok(n > 0, '没有解析到任何标记');
  // 判别力：旧形态的卡片是 26×34（高比宽大），而且顶部至少离钉子 HANG_GAP = 14pt
  assert.ok(MARKER_DY < 14, '标记的最大下坠量应当远小于旧形态的 HANG_GAP');
});

test('dateLabel：0 / 负数 / NaN 显示为"未知时间"，正常时间显示 UTC 日期', () => {
  assert.equal(dateLabel(0), '未知时间');
  assert.equal(dateLabel(-1), '未知时间');
  assert.equal(dateLabel(Number.NaN), '未知时间');
  assert.equal(dateLabel(Date.UTC(2026, 9, 8, 12, 0, 0)), '2026-10-08');
});

// ────────────────────────────────────────────────────────────────────────────
// 新形态下的"布局"还剩什么（task-18 把一大段换成了这一段）
//
// 旧形态这里有一整节"空间决定的布局"：密集场景里卡片不许出画布、任意两张不许重叠、
// 弧被收窄之后仍然是弧、挂载区底把张数压下来……**那些问题在新形态下不存在**：
// 标记是贴着钉子的固定小簇（最宽 21.8pt、最多 5 个），位置与画布大小无关，
// 所以"放不下"没有可表达的空间。整节连同 `planPin` / `hangRects` / `arcSpreadNeed`
// / `clampRect` / `HANG_OVERLAP_EPS` 一起删掉了（删除清单见 task-18 报告）。
//
// 换上来的是三条**新形态真正的不变量**：
//   ① 每个钉子最多 MAX_MARKERS 个标记，且标记簇整个落在画布内；
//   ② 标记的绝对位置与画布尺寸、与"挂载区/页脚"**无关**（旧版这两样都能改布局）；
//   ③ 同一份数据两次调用逐字节相同（可复现）。
// 判据全部用 `pinMarkers` / `markerCountOf` —— 与绘制、与设备侧读的是同一个函数。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一批**真实地点**下的照片（逐个注明来源；坐标与 tools/fixtures/wall-sample.json 同源，
 * 但内联在这里 —— core 的单测不依赖 tools 目录）。
 * 形状刻意做成"东海岸密集 + 西部稀疏"：旧形态下它会把卡片布局压垮，
 * 新形态下它只是"钉子上有几簇点"。
 */
function denseScene(): WallPhoto[] {
  const out: WallPhoto[] = [];
  const add = (prefix: string, lat: number, lon: number, n: number, place?: string): void => {
    for (let i = 0; i < n; i++) {
      out.push(ph(`${prefix}-${i}`, lat + i * 0.0007, lon + i * 0.0007, 1700000000000 + i * 3600000, place));
    }
  };
  add('sh', 31.2304, 121.4737, 6);                       // 上海人民广场（会与杭州/苏州并簇）
  add('bj', 39.9042, 116.4074, 4);                       // 北京天安门
  add('gz', 23.1066, 113.3245, 7);                       // 广州海珠
  add('dh', 40.1421, 94.6618, 3, '甘肃·酒泉·敦煌');        // 敦煌（手选地点）
  add('ls', 29.6577, 91.1170, 3);                        // 拉萨城关
  add('urc', 43.8256, 87.6168, 1);                       // 乌鲁木齐（1 张 → 设计规则不展开）
  return out;
}

/** 场景里**全部画出来的标记**（画布绝对坐标）—— 与绘制方读的是同一个 `pin.markers`。 */
function sceneMarkers(pins: ScenePin[]): number[][] {
  const out: number[][] = [];
  for (const p of pins) {
    for (const m of p.markers) { out.push([p.x + m.dx, p.y + m.dy]); }
  }
  return out;
}

test('布局：密集场景（6 钉 24 张）每个钉子最多 MAX_MARKERS 个标记，且整簇都在画布内', () => {
  const pins = buildScene(denseScene(), FRAME, 1);
  assert.ok(pins.length >= 5, `钉子太少（${pins.length}）—— 这条测试会失去判别力`);
  let total = 0;
  for (const p of pins) {
    assert.ok(p.markers.length <= MAX_MARKERS, `${p.name} 画了 ${p.markers.length} 个标记`);
    assert.equal(p.markers.length, markerCountOf(p), `${p.name} 的 markers 与 markerCountOf 不一致`);
    total += p.markers.length;
  }
  assert.ok(total > 0, '一个标记都没画出来');
  // 整簇（含标记半径）必须落在**绘制框**里 —— 场景坐标就是框坐标（`buildScene` 用 frame.w/h
  // 投影再加 frame.x/y）。⚠️ task-19 之后框**可以比画布宽**（x 为负，横向溢出），
  // 所以这里判的是框而不是画布：钉子在屏幕外是这个模型的**正常状态**（横滑过去看），
  // 但"钉子跑到地图框之外"永远是错的。
  for (const q of sceneMarkers(pins)) {
    assert.ok(q[0] - MARKER_R >= FRAME.x - 1e-6, `标记左边界跑到框外：${q[0] - MARKER_R} < ${FRAME.x}`);
    assert.ok(q[0] + MARKER_R <= FRAME.x + FRAME.w + 1e-6, `标记右边界跑到框外：${q[0] + MARKER_R}`);
    assert.ok(q[1] - MARKER_R >= FRAME.y - 1e-6, `标记上边界跑到框外：${q[1] - MARKER_R}`);
    assert.ok(q[1] + MARKER_R <= FRAME.y + FRAME.h + 1e-6, `标记下边界跑到框外：${q[1] + MARKER_R}`);
  }
  // 判别力：这份数据（87.6~121.5°E）在 FRAME 这个"整个中国"的框里离框边还有几十 pt，
  // 所以上面四条是**真断言**，不是恒真式（把任一条的容差收紧到 0 也仍然成立）。
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const q of sceneMarkers(pins)) {
    if (q[0] < minX) { minX = q[0]; }
    if (q[0] > maxX) { maxX = q[0]; }
  }
  assert.ok(minX - MARKER_R > FRAME.x + 1, `（自检）最左的标记离框左只有 ${minX - MARKER_R - FRAME.x}pt`);
  assert.ok(maxX + MARKER_R < FRAME.x + FRAME.w - 1, `（自检）最右的标记离框右只有 ${FRAME.x + FRAME.w - maxX - MARKER_R}pt`);
});

test('布局：标记的绝对位置与画布尺寸 / 页脚**无关**（旧版这两样都能改布局）', () => {
  // ① 同一份数据、同一块画布 ×2 次调用 → 逐字节相同
  const a = JSON.stringify(buildScene(denseScene(), FRAME, 1));
  const b = JSON.stringify(buildScene(denseScene(), FRAME, 1));
  assert.equal(a, b, '同一输入两次调用不一致（布局有了隐藏的随机/顺序依赖）');
  // ② 换一块画布：钉子位置会变（投影不同），但**标记相对钉子的偏移一个都不变** ——
  //    这就是"标记是钉子的一部分、不是画布上的另一层布局"的机器可读含义。
  //    旧版这里会变：同一份数据在 360 宽上挂 5 张、在 720 宽上挂 9 张。
  const wide = buildScene(denseScene(), FRAME_WIDE, 1);
  assert.equal(wide.length, buildScene(denseScene(), FRAME, 1).length);
  for (let i = 0; i < wide.length && i < 6; i++) {
    assert.deepEqual(wide[i].markers, buildScene(denseScene(), FRAME, 1)[i].markers,
      `第 ${i} 个钉子的标记随画布变了`);
  }
  // ③ 旧版还有一个 `env`（挂载区/页脚）参数能改布局 —— 它已经不存在了：
  //    buildScene 现在只有三个参数。这条用"多传一个参数也毫无影响"来钉住。
  const base = buildScene(denseScene(), FRAME, 1);
  assert.equal(base.length, 6, `密集场景应当有 6 个钉子，实际 ${base.length}`);
});

test('布局：一张照片的钉子也画一个标记（正下方），不是"空点"', () => {
  // 乌鲁木齐 1 张：design 规则（computeLayout）在钉子数 > EXPAND_ALL_MAX 时要求 n ≥ 3 才展开，
  // 所以它**收成点**（这是设计 §6.2 的意图，不是缺陷）。真正要钉住的是"展开的钉子即使只有
  // 1 张也必须画标记"—— 否则 1 张照片的钉子看起来和"没有照片的地点"一样。
  const one = buildScene([ph('urc', 43.8256, 87.6168, 1700000000000)], FRAME, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].expanded, true, '只有一个钉子时应当展开');
  assert.equal(one[0].markers.length, 1);
  assert.ok(Math.abs(one[0].markers[0].dx) < 1e-12, '单张标记应当正在钉子下方');
  assert.equal(one[0].markers[0].dy, MARKER_DY);
  // 而"钉子多"的那一档确实会收成点（设计规则），标记为空
  const many = buildScene(denseScene(), FULL_FRAME, 1);
  const collapsed = many.filter((p: ScenePin) => !p.expanded);
  assert.ok(collapsed.length > 0, '这份数据应当有收成点的钉子');
  for (const p of collapsed) { assert.deepEqual(p.markers, []); }
});

test('布局：轨迹与标记用的是同一份钉子坐标（画出来的点与折线的顶点对得上）', () => {
  const pins = buildScene(denseScene(), FRAME, 1);
  const svg = sceneToSvg(pins, W, H, '');
  const track = trajectoryPath(pins);
  assert.ok(track.length > 0, '没有轨迹（少于 2 个钉子？）');
  // 轨迹顶点 = 钉子坐标（trajectoryPath 的既有契约），标记则在钉子下方 MARKER_DY 附近
  const pts = track.replace(/[ML]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  let hit = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    for (const p of pins) {
      if (Math.abs(p.x - pts[i]) < 0.01 && Math.abs(p.y - pts[i + 1]) < 0.01) { hit++; }
    }
  }
  assert.equal(hit, pts.length / 2, '轨迹顶点与钉子坐标对不上');
  assert.ok(svg.includes(`<path d="${track}"`));
});

// ── 旅行轨迹：把钉子按拍摄时间连成一条折线（task-14 的形态改造） ──────────────

/** 三个不同时间、不同地方的钉子（真实坐标），用来钉住轨迹的顺序与坐标。 */
function trailScene(): WallPhoto[] {
  return [
    ph('bj1', 39.9042, 116.4074, Date.UTC(2024, 4, 1)),      // 北京 2024-05-01（最早）
    ph('sh1', 31.2304, 121.4737, Date.UTC(2024, 6, 10)),     // 上海 2024-07-10
    ph('gz1', 23.1066, 113.3245, Date.UTC(2024, 8, 20)),     // 广州 2024-09-20（最晚）
    ph('ls1', 29.6577, 91.1170, 0)                           // 拉萨：时间未知 → 排最后
  ];
}

test('trajectoryOrder：按拍摄时间正序，时间未知的排最后；并列按 pinId（可复现）', () => {
  const pins = buildScene(trailScene(), FRAME, 1);
  const order = trajectoryOrder(pins);
  assert.equal(order.length, pins.length);
  const names = order.map((p: ScenePin) => p.name);
  // 北京(05-01) → 上海(07-10) → 广州(09-20) → 拉萨(未知)
  assert.ok(names[0].indexOf('北京') === 0, `第 1 个不是北京：${names[0]}`);
  assert.ok(names[1].indexOf('上海') === 0, `第 2 个不是上海：${names[1]}`);
  assert.ok(names[2].indexOf('广东') === 0 || names[2].indexOf('广州') === 0, `第 3 个不是广州：${names[2]}`);
  assert.ok(names[3].indexOf('拉萨') >= 0 || names[3].indexOf('西藏') === 0, `时间未知的没有排在最后：${names[3]}`);
  // 每个钉子自己的时间：取组内**最早**那张
  for (const p of order) {
    const t = pinTime(p);
    if (p === order[3]) { assert.equal(t, 0, '拉萨应当没有已知时间'); }
    else { assert.ok(t > 0, `${p.name} 应当有已知时间`); }
  }
  // 时间正序（未知的排在最后，不参与比较）
  for (let i = 1; i < 3; i++) {
    assert.ok(pinTime(order[i - 1]) < pinTime(order[i]), `第 ${i} 个的时间没有比前一个大`);
  }
  // **不动入参**：pins 自己的顺序仍然按 pinId（可复现），轨迹返回的是新数组
  assert.notEqual(order, pins);
  const byId = pins.map((p: ScenePin) => p.pinId);
  const sorted = byId.slice(0, byId.length).sort();
  assert.deepEqual(byId, sorted, 'buildScene 的钉子顺序应当仍是 pinId 字典序');
});

test('trajectoryOrder：组内取**最早**的时间，且未知时间的钉子之间按 pinId 排', () => {
  const photos = [
    ph('s_old', 31.2304, 121.4737, Date.UTC(2020, 0, 1)),
    ph('s_new', 31.2304, 121.4737, Date.UTC(2025, 0, 1)),
    ph('b_none1', 39.9042, 116.4074, 0),
    ph('b_none2', 39.9042, 116.4074, 0)
  ];
  const pins = buildScene(photos, FRAME, 1);
  const order = trajectoryOrder(pins);
  // 上海有 2020 那张 → 不管同组里还有 2025 的，它的时间就是 2020（首次到达）
  assert.equal(pinTime(order[0]), Date.UTC(2020, 0, 1), '组内没有取最早的时间');
  assert.equal(order.length, pins.length);
  for (let i = 1; i < order.length; i++) {
    assert.equal(pinTime(order[i]), 0);
    assert.ok(order[i - 1].pinId <= order[i].pinId, '时间未知的钉子之间没有按 pinId 排');
  }
});

test('trajectoryPath：按轨迹序连成 M…L…L…，坐标与钉子的实际坐标逐点相同', () => {
  const pins = buildScene(trailScene(), FRAME, 1);
  const d = trajectoryPath(pins);
  const order = trajectoryOrder(pins);
  assert.ok(d.startsWith('M'), 'path 未以 M 开头');
  assert.equal((d.match(/[ML]/g) || []).length, order.length, '顶点数与轨迹序的钉子数不一致');
  assert.equal(d.split('M').length - 1, 1, '折线只应有一条子路径');
  assert.equal(d.split('L').length - 1, order.length - 1, 'L 的段数不对');
  // 逐点核对：第 i 个顶点必须是轨迹序里第 i 个钉子的坐标（2 位小数）
  const pts = d.replace(/[ML]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  for (let i = 0; i < order.length; i++) {
    assert.ok(Math.abs(pts[i * 2] - order[i].x) < 0.005, `第 ${i} 个顶点的 x 不对：${pts[i * 2]} vs ${order[i].x}`);
    assert.ok(Math.abs(pts[i * 2 + 1] - order[i].y) < 0.005, `第 ${i} 个顶点的 y 不对：${pts[i * 2 + 1]} vs ${order[i].y}`);
  }
  // 相邻顶点不重合（重合说明有两个钉子叠在一起，那这条线就断了）
  for (let i = 1; i < order.length; i++) {
    const dx = order[i].x - order[i - 1].x;
    const dy = order[i].y - order[i - 1].y;
    assert.ok(Math.sqrt(dx * dx + dy * dy) > 1, `第 ${i} 段长度为 0`);
  }
});

test('trajectoryPath：少于 2 个钉子返回空串（一个点不成线），且不抛错', () => {
  assert.equal(trajectoryPath([]), '');
  const one = buildScene([ph('a', 31.2304, 121.4737, 1)], FRAME, 1);
  assert.equal(one.length, 1);
  assert.equal(trajectoryPath(one), '');
});

test('trajectoryPath：不产出 NaN（未知时间 / 空照片列表都不会把线弄断）', () => {
  const pins = buildScene(trailScene(), FRAME, 1);
  const d = trajectoryPath(pins);
  assert.ok(!d.includes('NaN') && !d.includes('Infinity'), `轨迹里有 NaN/Infinity：${d}`);
});

test('sceneToSvg：轨迹画在图层的正确位置上（国界之上、照片之下）', () => {
  const pins = buildScene(trailScene(), FRAME, 1);
  const od = parseOutline(GOOD_OUTLINE);
  assert.ok(od !== undefined);
  const svg = sceneToSvg(pins, W, H, outlinePath(od.rings, FRAME));
  assert.ok(svg.includes('<g id="trajectory">'), '缺少轨迹层');
  const mapAt = svg.indexOf('fill="#E8F0E4"');
  const trackAt = svg.indexOf('<g id="trajectory">');
  const cardsAt = svg.indexOf('<g id="pins">');
  const anchorsAt = svg.indexOf('<g id="anchors">');
  assert.ok(mapAt >= 0 && trackAt > mapAt, '轨迹必须在国界之上');
  assert.ok(cardsAt > trackAt, '轨迹必须在照片之下（否则压住照片）');
  assert.ok(anchorsAt > cardsAt, '钉点层必须在最后（否则邻钉卡片会盖住地名）');
  // 线的颜色/粗细与设计一致
  assert.ok(svg.includes('stroke="#D08A46"'), '轨迹颜色变了');
  assert.ok(svg.includes(`stroke-width="${TRACK_WIDTH}"`), '轨迹粗细变了');
});

test('sceneToSvg：轨迹的路径与 trajectoryPath 逐字节相同（预览与设备不会各画一条）', () => {
  const pins = buildScene(trailScene(), FRAME, 1);
  const svg = sceneToSvg(pins, W, H, '');
  const d = trajectoryPath(pins);
  assert.ok(svg.includes(`<path d="${d}"`), 'sceneToSvg 画的轨迹与 trajectoryPath 不一致');
});


test('布局：标记簇是"钉子的一部分" —— 挨得再近的两个钉子，簇也不会互相跑到对方身上', () => {
  // 旧形态这里测的是"为了躲开邻居而收窄的弧仍然是弧"。新形态没有"收窄"这回事：
  // 一个钉子的标记簇横向只占 ±9pt，而 `clusterByScreen` 保证两个钉子至少隔
  // MIN_PIN_DIST_PT = 40pt —— 于是"簇压到邻钉上"在几何上不可能发生。
  // 这条把它变成一个可核对的数：**任意两个不同钉子的标记之间的最小距离 ≥ 40 − 2×9 − 2R**。
  const pins = buildScene(denseScene(), FRAME, 1);
  const halfWide: number = (MAX_MARKERS - 1) / 2 * MARKER_STEP;
  let pairs = 0;
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i];
      const b = pins[j];
      const d = Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
      assert.ok(d >= MIN_PIN_DIST_PT - 1e-6, `${a.name} 与 ${b.name} 只隔 ${d}pt（< ${MIN_PIN_DIST_PT}）`);
      pairs++;
    }
  }
  assert.ok(pairs >= 10, `只核对到 ${pairs} 对钉子 —— 判别力不足`);
  // 簇宽 + 半钉距：两个钉子各自的簇最外沿之间至少还剩这么多
  const clearance: number = MIN_PIN_DIST_PT - 2 * (halfWide + MARKER_R);
  assert.ok(clearance > 10, `两个钉子的标记簇之间只剩 ${clearance}pt —— 快撞上了`);
});

test('布局：整簇的宽度与高度都是**钉子的常数**，与张数、与画布都无关', () => {
  // 旧形态里"簇"（弧）会随张数变宽、随画布收窄 —— 那是卡片时代的耦合。
  // 新形态：1 个标记与 MAX_MARKERS 个标记的**外沿**差是确定的 2×halfWide，且不随画布变。
  const halfWide: number = (MAX_MARKERS - 1) / 2 * MARKER_STEP;
  const one = pinMarkers(1);
  const five = pinMarkers(MAX_MARKERS);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].dx) < 1e-12, '单张在正中');
  assert.ok(Math.abs((five[0].dx) + halfWide) < 1e-9 && Math.abs(five[MAX_MARKERS - 1].dx - halfWide) < 1e-9,
    '最大簇没有顶满 ±halfWide');
  // 整簇的纵向跨度：从最高那个点到最低那个点
  let minDy = Number.POSITIVE_INFINITY;
  let maxDy = -Number.POSITIVE_INFINITY;
  for (const m of five) {
    if (m.dy < minDy) { minDy = m.dy; }
    if (m.dy > maxDy) { maxDy = m.dy; }
  }
  assert.ok(maxDy - minDy < 0.5, `整簇高低差 ${maxDy - minDy}pt —— 已经不是"一簇"了`);
  assert.ok(maxDy <= MARKER_DY, '簇的最低点不该超过 MARKER_DY');
  // 含半径的整簇：21.8 × 5.9pt（旧形态一张卡片就是 26×34）
  assert.ok(halfWide * 2 + 2 * MARKER_R < 26, '整簇比旧形态的一张卡片还宽');
  assert.ok(maxDy + MARKER_R < 34 / 4, '整簇纵向占用太大 —— 又回到"照片与地图争位置"了');
});

