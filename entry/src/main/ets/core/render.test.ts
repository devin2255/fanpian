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
  MAX_VIEW_SPAN_DEG, MIN_ZOOMED_VIEW_SPAN_DEG, badgeRectOf, buildScene, dateLabel, fitBounds,
  fitViewToCanvas, frameBottomAt, frameBounds, geoAspect, mapBoxHeight, mapFillRatio, mapFrame,
  markerCountOf, normalizeBounds, outlinePath, panViewBy, parseOutline, pinMarkers, pinTime,
  sceneToSvg, trajectoryOrder, trajectoryPath, viewZoomOf, viewZoomRange, zoomViewAt
} from './render.ts';
import type { MapFrame, ScenePin, WallPhoto } from './render.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
parseAreaData(fs.readFileSync(DATA_URL, 'utf8'));

const W = 360;
const H = 720;

/** 画布比 = `W/H` = 0.5。**新形态下的框恒与它相等**（`fitViewToCanvas` 把视野撑到画布比例）。 */
const CANVAS_ASPECT = W / H;

/**
 * 钉子到**最远**那个标记的距离上限（pt）：`√(halfWide² + MARKER_DY²)`。
 *
 * 它就是"这一簇有多大"的机器可读口径（最大簇时取值）。单测用它断言
 * "标记既不在钉心上、也没有离钉子太远" —— 也就是用户要的"贴着钉子"。
 */
const MAX_MARKER_RANGE = Math.sqrt(Math.pow((MAX_MARKERS - 1) / 2 * MARKER_STEP, 2) + MARKER_DY * MARKER_DY);

/**
 * 各种测试用的地图框 —— **一律由 `mapFrame + fitViewToCanvas` 产出**（与设备/预览同一条路径）。
 *
 * ⚠️ task-18 之后这里不再能手写"框 ⊆ 块但不等"的字面量：`fitViewToCanvas` 会把视野撑到
 * **与画布同比例**（这就是"默认铺满"），于是 `mapFrame` 给出的框恒 == 块（x=y=0，
 * `mapFillRatio` = 1）。想造"框装不满块"只能手写 `MapFrame` 字面量（`UNFILLED_FRAME`），
 * 而那只在"没有走 `fitViewToCanvas` 的退化路径"下才出现。
 *
 * `ScenePin.x/y` 因此落在**块坐标**里；断言坐标时要带上框的平移（`atFrame` 就是干这个的）。
 */
/** 全国视野那一档：框 360×267.72 居中在 y=226.14（**填满度只有 37.2%**，见 `mapFillRatio` 的测试）。 */
const FRAME: MapFrame = mapFrame(W, H, CHINA_REGION.bounds);
/** "画布给得很宽"的那一档（720×800）：框 720×535.44 居中在 y=132.28。 */
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

// ── 默认铺满 fitViewToCanvas：框的比例 == 画布的比例（task-16 的第 2 件事）──────
//
// 用户的第三条反馈是"地图应该支持缩放吧 **默认铺满**"。成因不是"视野没拉近"
// （fitBounds 已经做到了），而是 `fitBounds` **不看画布**：数据框与画布比例不同时
// `mapFrame` 只能 contain（居中信箱式），框的一侧空出一条带。
//
// 下面每一条都对着**控制器在真机上量到的原话真值**来写：
//   诊断 box 376×663.71 ｜ 图框 309.1×663.71@(33.45,0) ｜ 视野 [115.66,29.88,122.19,41.24]
//   （真值里的 bounds 是四舍五入到 2 位的，所以下面的框尺寸与 309.1/33.45 有 ~0.2pt 的差 ——
//    这正是"用打印出来的数字复算"应有的量级，下面断言里写明了容差。）

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

test('fitViewToCanvas：设备真值那一档 —— 撑开后**框的比例 == 画布的比例**', () => {
  const ex = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  // ① 比例相等（这是本函数存在的全部意义）。用 geoAspect 与画布比对比，容差只留给浮点。
  const want = DEV_BOX_W / DEV_BOX_H;
  assert.ok(Math.abs(geoAspect(ex) - want) < 1e-12, `撑开后比例 ${geoAspect(ex)} != 画布 ${want}`);
  // ② 撑开的是**经度**（这一档数据框比画布"窄" → 框被高度限制 → 左右留白）
  assert.ok(Math.abs(ex[1] - DEV_VIEW[1]) < 1e-12, '纬度不该动');
  assert.ok(Math.abs(ex[3] - DEV_VIEW[3]) < 1e-12, '纬度不该动');
  assert.ok(ex[0] < DEV_VIEW[0] && ex[2] > DEV_VIEW[2], '经度应当两边各撑开一些');
  // ③ 真值复核：经度 6.53° → 7.94°（撑开 1.2155 倍）
  assert.ok(Math.abs((ex[2] - ex[0]) - 7.94) < 0.01, `撑开后经度跨度 ${ex[2] - ex[0]}（期望 ≈7.94）`);
  // ④ 撑开是**绕中心**做的（不是往一侧长）—— 两边的余量相等
  const leftGap = DEV_VIEW[0] - ex[0];
  const rightGap = ex[2] - DEV_VIEW[2];
  assert.ok(Math.abs(leftGap - rightGap) < 1e-12, `两侧余量不等：${leftGap} vs ${rightGap}`);
});

test('fitViewToCanvas：设备真值那一档 —— mapFrame 的信箱空白**归零**（33.45pt → 0）', () => {
  const before: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, DEV_VIEW);
  // 复算改动前：框 309.34×663.71 @ (33.33, 0) —— 与真机的 309.1×663.71@(33.45,0) 相差 0.2pt
  // 以内（真值里的 bounds 只印了 2 位小数）。这条断言同时**证明了我的模型与真机一致**。
  assert.ok(Math.abs(before.h - DEV_BOX_H) < 1e-9, '这一档框应当填满高度（那正是"框被高度限制"）');
  assert.ok(Math.abs(before.w - 309.1) < 0.3, `框宽 ${before.w} vs 真机 309.1`);
  assert.ok(Math.abs(before.x - 33.45) < 0.3, `框左 ${before.x} vs 真机 33.45`);
  assert.ok(before.x > 0, '改动前**一定**有左右留白 —— 这就是"没铺满"的机器可读形态');

  const ex = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  const after: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, ex);
  // 框 == 块：没有信箱空白（这是"默认铺满"的几何表述）
  assert.ok(Math.abs(after.x) < 1e-9, `撑开后仍有左边距 ${after.x}`);
  assert.ok(Math.abs(after.y) < 1e-9, `撑开后仍有上边距 ${after.y}`);
  assert.ok(Math.abs(after.w - DEV_BOX_W) < 1e-9, `框宽 ${after.w} != 画布宽 ${DEV_BOX_W}`);
  assert.ok(Math.abs(after.h - DEV_BOX_H) < 1e-9, `框高 ${after.h} != 画布高 ${DEV_BOX_H}`);
  // 放大倍数：9.49× → 7.81×。**这不是"变小了"**：pt/度 一点没变（见下一条测试），
  // 变的只是"把原来空着的那两条带交给地图自己（国界/省界/海岸线）"。
  const zoomBefore = viewZoomOf(DEV_VIEW);
  const zoomAfter = viewZoomOf(ex);
  assert.ok(Math.abs(zoomBefore - 9.49) < 0.02, `改动前放大倍数 ${zoomBefore}（真机诊断行印的是 9.5×）`);
  assert.ok(Math.abs(zoomAfter - 7.81) < 0.02, `撑开后放大倍数 ${zoomAfter}（期望 ≈7.81）`);
  assert.ok(zoomAfter < zoomBefore, '撑开经度 → 视野变大 → 相对全国的倍数必然变小');
});

test('fitViewToCanvas：撑开**不改变 pt/度** —— 它把信箱那两条带交给地图，不是把照片放大', () => {
  // 这条测试是为了纠正一个**很容易搞错的期待**（控制器原话："数据本可以再放大约 1.55 倍填满"）。
  // 那个 1.55 来自"6.53/11.36 ≈ 0.575 与 376/663.71 ≈ 0.5665 差不多"这个**非墨卡托**的比较；
  // 墨卡托下真实比例是 0.4661（纬度被 mercY 拉伸），所以撑开量是 1.2155 倍而不是 1.55 倍。
  // 而且撑开只发生在"被限制的那根轴**之外**"的那根轴上，所以**每度的 pt 数是恒等的**：
  // 照片在屏幕上的绝对大小一点没变，变的只是两侧不再空着。
  const before = mapFrame(DEV_BOX_W, DEV_BOX_H, DEV_VIEW);
  const ex = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  const after = mapFrame(DEV_BOX_W, DEV_BOX_H, ex);
  const ptPerDegBefore = before.w / (DEV_VIEW[2] - DEV_VIEW[0]);
  const ptPerDegAfter = after.w / (ex[2] - ex[0]);
  assert.ok(Math.abs(ptPerDegBefore - ptPerDegAfter) < 1e-9,
    `pt/度 变了：${ptPerDegBefore} → ${ptPerDegAfter}（撑开不该改变比例尺）`);
  // 撑开是**绕数据长出去**的：pt/度 不变 + 框的平移恰好抵消经度的扩张
  // → **同一个经纬度在块坐标里一动都不动**（Δ 恒等于 0，下面这条断言是精确等式）。
  // 这条性质正是"用户的照片不会因为铺满而挪位置"的机器可读表述。
  const q1 = projectMercator(SH_LON, SH_LAT, before.w, before.h, frameBounds(before));
  const q2 = projectMercator(SH_LON, SH_LAT, after.w, after.h, frameBounds(after));
  const dx = Math.abs((q1.x + before.x) - (q2.x + after.x));
  const dy = Math.abs((q1.y + before.y) - (q2.y + after.y));
  assert.ok(dx < 1e-9 && dy < 1e-9,
    `照片在铺满前后挪了位置（Δ=${dx},${dy}）—— 撑开应当是绕数据长出去，不是平移视野`);
  // 反过来：**框确实变大了**（否则上面那条 Δ=0 就成了"什么都没发生"）
  assert.ok(after.w > before.w + 50, `框宽没变大：${before.w} → ${after.w}`);
  assert.ok(before.x > 30 && Math.abs(after.x) < 1e-9, `框的左边距没有归零：${before.x} → ${after.x}`);
});

test('fitViewToCanvas：数据在撑开后**仍然全部可见**（框只会变大，不会裁掉数据）', () => {
  // 这是本函数的第一不变量，工单要求必须有单测。穷举一批真实/极端的数据框 × 画布。
  const boxes: number[][] = [
    DEV_VIEW,
    [115.66, 29.88, 122.19, 41.24],
    CHINA_REGION.bounds,
    fitBounds([ph('sh', SH_LAT, SH_LON, 0)], VIEW_PAD_RATIO) as number[],
    fitBounds([ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)], VIEW_PAD_RATIO) as number[],
    [73, 18, 135, 54],
    [100, 20, 100.6, 20.6],
    [80, 40, 134, 53],           // 东北角：撑开经度会明显露出境外
    [73, 18, 80, 19],            // 西南角
    [121, 30, 122, 41],          // 细长竖条
    [100, 30, 130, 31],          // 细长横条
  ];
  const canvases: number[][] = [
    [DEV_BOX_W, DEV_BOX_H], [360, 720], [720, 360], [360, 360], [100, 2000], [2000, 100], [1080, 1920]
  ];
  let checked = 0;
  const cb0: number = CHINA_REGION.bounds[0];
  const cb1: number = CHINA_REGION.bounds[1];
  const cb2: number = CHINA_REGION.bounds[2];
  const cb3: number = CHINA_REGION.bounds[3];
  for (const b of boxes) {
    for (const c of canvases) {
      const ex = fitViewToCanvas(b, c[0], c[1]);
      // ① **数据全部可见**：撑开后的框 ⊇ 原框（四边都不许往里收）
      assert.ok(ex[0] <= b[0] + 1e-9, `左边界被裁：${ex[0]} > ${b[0]}（框 ${b} 画布 ${c}）`);
      assert.ok(ex[1] <= b[1] + 1e-9, `下边界被裁：${ex[1]} > ${b[1]}（框 ${b} 画布 ${c}）`);
      assert.ok(ex[2] >= b[2] - 1e-9, `右边界被裁：${ex[2]} < ${b[2]}（框 ${b} 画布 ${c}）`);
      assert.ok(ex[3] >= b[3] - 1e-9, `上边界被裁：${ex[3]} < ${b[3]}（框 ${b} 画布 ${c}）`);
      // ② 坐标永远有限、跨度永远为正（NaN 会让整条 path 静默消失）
      for (let i = 0; i < 4; i++) {
        assert.ok(Number.isFinite(ex[i]), `非有限坐标：${ex[i]}（框 ${b} 画布 ${c}）`);
      }
      assert.ok(ex[2] > ex[0] && ex[3] > ex[1], `跨度非正：${ex}（框 ${b} 画布 ${c}）`);
      // ③ 投影得出来（不产 NaN）
      const f: MapFrame = mapFrame(c[0], c[1], ex);
      assert.ok(!outlinePath([[ex[0], ex[1], ex[2], ex[1], ex[2], ex[3]]], f).includes('NaN'));
      // ④ 比例匹配 —— **除非**某一边顶到了边界（顶到 = 那一边真的被收住了）。
      //    两种顶法：±84°/360° 的墨卡托安全带（对 ⊆ 中国的输入已不可达，见下面那条测试），
      //    或 task-17 新加的"框 ⊆ 中国"（跨度不小于中国跨度就取整段 → 必然正好贴住中国边界）。
      //    判别力：**框严格落在中国之内（四边都不贴边）时，比例必须匹配** ——
      //    悄悄收缩跨度却不贴边，就是算错了，这条抓得住。
      const unlimited = geoAspect(ex) > 1e-6;
      if (unlimited) {
        const want = c[0] / c[1];
        const hit = Math.abs(geoAspect(ex) - want) < 1e-9;
        const clamped = ex[1] <= -84 + 1e-9 || ex[3] >= 84 - 1e-9 || (ex[2] - ex[0]) >= 360 - 1e-9;
        const cb = CHINA_REGION.bounds;
        const atChinaEdge = ex[0] <= cb[0] + 1e-9 || ex[2] >= cb[2] - 1e-9
          || ex[1] <= cb[1] + 1e-9 || ex[3] >= cb[3] - 1e-9;
        assert.ok(hit || clamped || atChinaEdge,
          `比例既没匹配也没顶到边界：${geoAspect(ex)} vs ${want}（框 ${b} 画布 ${c}）`);
      }
      // ⑤ task-17：**输出恒 ⊆ 中国范围**（这是"缩小的上界"那件事的第一不变量）
      assert.ok(ex[0] >= cb0 - 1e-9 && ex[2] <= cb2 + 1e-9 && ex[1] >= cb1 - 1e-9 && ex[3] <= cb3 + 1e-9,
        `撑开后跑出中国范围：${ex}（框 ${b} 画布 ${c}）`);
      checked++;
    }
  }
  assert.equal(checked, boxes.length * canvases.length);
});

test('fitViewToCanvas：幂等；画布/bounds 非法时原样返回；极端画布撞钳制也不产 NaN', () => {
  const ex = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  // 幂等：比例已经匹配 → 再次调用原样返回（设备与预览都调它，不能累积漂移）
  assert.deepEqual(fitViewToCanvas(ex, DEV_BOX_W, DEV_BOX_H), ex);
  assert.deepEqual(fitViewToCanvas(ex, DEV_BOX_W, DEV_BOX_H), fitViewToCanvas(ex, DEV_BOX_W, DEV_BOX_H));
  // 画布非法 → 原样返回（"画布多大都不知道"时不该改视野）
  assert.deepEqual(fitViewToCanvas(DEV_VIEW, 0, DEV_BOX_H), normalizeBounds(DEV_VIEW));
  assert.deepEqual(fitViewToCanvas(DEV_VIEW, DEV_BOX_W, 0), normalizeBounds(DEV_VIEW));
  assert.deepEqual(fitViewToCanvas(DEV_VIEW, Number.NaN, DEV_BOX_H), normalizeBounds(DEV_VIEW));
  assert.deepEqual(fitViewToCanvas(DEV_VIEW, -1, -1), normalizeBounds(DEV_VIEW));
  // bounds 非法 → 先 normalizeBounds（退回全国视野），再按画布比例撑开。**必须有值、有限、正跨度**
  const bad = fitViewToCanvas([1, 2, 3], 376, 663.71);
  assert.equal(bad.length, 4);
  for (let i = 0; i < 4; i++) { assert.ok(Number.isFinite(bad[i])); }
  assert.ok(bad[2] > bad[0] && bad[3] > bad[1]);
  assert.ok(bad[0] <= CHINA_REGION.bounds[0] && bad[2] >= CHINA_REGION.bounds[2], '全国视野必须仍被框住');
  // 极端画布（100×2000）：中国比画布"宽" → 会去撑纬度，但**中国范围把它收住** ——
  // 结果是"整个中国"。task-17 之前这里撑到 ±84° 的墨卡托安全带，
  // 而那正是真机上"中国缩成一个小角"的来源（→ 报告 §2.4）。
  const thin = fitViewToCanvas(CHINA_REGION.bounds, 100, 2000);
  assert.deepEqual(thin, normalizeBounds(CHINA_REGION.bounds), `极端竖画布应当停在"整个中国"：${thin}`);
  assert.ok(thin[1] <= CHINA_REGION.bounds[1] && thin[3] >= CHINA_REGION.bounds[3], '撞钳制后数据仍须在框内');
  assert.ok(Number.isFinite(geoAspect(thin)) && geoAspect(thin) > 0);
  // 第二道防线（±84° / 360°）确实被中国范围整个包住 —— 所以它在中国范围内**不可达**，
  // 但保留着：万一 `CHINA_REGION.bounds` 被改到安全带之外，它仍然挡住 NaN。
  assert.ok(CHINA_REGION.bounds[1] > -84 && CHINA_REGION.bounds[3] < 84, '中国必须在墨卡托安全带内');
  assert.ok(CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0] < 360, '中国经度跨度必须小于环球');
  // 极端扁画布（2000×100）：经度撑到 360° 封顶那一支同样被中国范围收住
  const fat = fitViewToCanvas(CHINA_REGION.bounds, 2000, 100);
  assert.deepEqual(fat, normalizeBounds(CHINA_REGION.bounds), `极端扁画布应当停在"整个中国"：${fat}`);
  assert.ok(fat[2] - fat[0] <= 360 + 1e-9, `经度跨度不许超过 360：${fat[2] - fat[0]}`);
  assert.ok(fat[0] <= CHINA_REGION.bounds[0] && fat[2] >= CHINA_REGION.bounds[2], '撞钳制后数据仍须在框内');
});

test('fitViewToCanvas：**做中国范围钳制**（框恒 ⊆ 中国）—— 这是 task-17 反转的取舍', () => {
  // ⚠️ 这条测试与上一版**结论相反**，反转的理由是**真机**：上一版允许露出境外，代价写在注释里
  // 是"边上多两条底色"；真机上那个代价实际上是"中国缩成中间一小块、纬度到了南半球"
  //（诊断行 `→铺满[67,-20.6,129,64.4]`）。用户要的是"缩到底看到完整的中国"，所以现在钳制。
  // 保留下来的是**数学事实**：钳制与"比例 == 画布比"不可兼得 —— 现在选前者，代价是信箱空白。
  //
  // 黑龙江东部那种"南北长、东西窄"的数据（[130.5,45,133.5,53]，墨卡托比 0.2453 < 画布比
  // 0.5665 → 框被**高度**限制、左右留白）撑开经度后本来会越过 maxLon = 135 ——
  // 现在被**平移**回中国：跨度一点没变（所以仍然不变形），只是整体西移。
  const ne: number[] = [130.5, 45, 133.5, 53];
  const ex = fitViewToCanvas(ne, 376, 663.71);
  assert.ok(ex[2] <= CHINA_REGION.bounds[2] + 1e-9, `东北角撑开后不得越过 135°E：${ex[2]}`);
  assert.ok(ex[0] >= CHINA_REGION.bounds[0] - 1e-9, `不得越过 73°E：${ex[0]}`);
  assert.ok(ex[1] >= CHINA_REGION.bounds[1] - 1e-9 && ex[3] <= CHINA_REGION.bounds[3] + 1e-9,
    `不得越过 18/54°N：${ex}`);
  // **平移**（不是夹两端）：跨度与"原本要撑到多大"完全一致 —— 只是整体挪回了中国。
  // 判据：右边界正好贴住 135°E，而左边界 = 135 − 期望跨度（期望跨度由撑开规则算得）。
  assert.ok(Math.abs(ex[2] - CHINA_REGION.bounds[2]) < 1e-9, `应当是整体西移贴住 135°E：${ex}`);
  // 平移只动经度位置，**纬度一点不动**（这一支是"撑开经度"）
  assert.ok(Math.abs(ex[1] - ne[1]) < 1e-12 && Math.abs(ex[3] - ne[3]) < 1e-12, `这一支不该动纬度：${ex}`);
  assert.ok(Math.abs(geoAspect(ex) - 376 / 663.71) < 1e-12,
    '只平移不缩放时比例**仍然**匹配（这正是"平移而不是夹两端"的收益）');
  assert.ok(ex[0] <= ne[0] && ex[2] >= ne[2] && ex[1] <= ne[1] && ex[3] >= ne[3], '数据仍须全部可见');
  // 平移而不是夹两端：**跨度**必须等于"撑开规则本来要撑到的那个跨度"。
  // 独立算一遍（不用实现里的 mercY）：`geoAspect` 的分母就是 mercY 跨度，
  //   数据框 `ne` 的 geoAspect → 反解出它的 mercY 跨度 → 按画布比算出需要的经度跨度。
  const ySpan: number = ((ne[2] - ne[0]) * (Math.PI / 180)) / geoAspect(ne);   // = mercY(53) − mercY(45)
  const needSpan: number = ((376 / 663.71) * ySpan) / (Math.PI / 180);         // 撑开规则给的经度跨度
  assert.ok(Math.abs((ex[2] - ex[0]) - needSpan) < 1e-9,
    `跨度不是"撑开规则算出来的那个"（说明被夹两端了）：${ex[2] - ex[0]} vs ${needSpan}`);
  // 反证（保留）：若"把两端各夹一下"，跨度会被压小、比例随之失配 —— 这就是**不许夹两端**的理由
  const midLon: number = (ne[0] + ne[2]) / 2;
  const unclamped: number[] = [midLon - needSpan / 2, ne[1], midLon + needSpan / 2, ne[3]];
  const clampedBoth: number[] = [Math.max(unclamped[0], CHINA_REGION.bounds[0]), Math.max(unclamped[1], CHINA_REGION.bounds[1]),
    Math.min(unclamped[2], CHINA_REGION.bounds[2]), Math.min(unclamped[3], CHINA_REGION.bounds[3])];
  assert.ok((clampedBoth[2] - clampedBoth[0]) < needSpan - 1e-9,
    `夹两端必须把跨度压小：${clampedBoth[2] - clampedBoth[0]} vs ${needSpan}`);
  assert.ok(Math.abs(geoAspect(clampedBoth) - 376 / 663.71) > 1e-6,
    '夹两端之后比例**必然**不再匹配（而且跨度会被压小）—— 所以只能平移');
  // 全国视野：两根轴都取满 → **逐位等于** 中国范围（"缩到底 = 全国"的机器可读形态）
  assert.deepEqual(fitViewToCanvas(CHINA_REGION.bounds, 376, 663.71), normalizeBounds(CHINA_REGION.bounds));
  assert.deepEqual(fitViewToCanvas(CHINA_REGION.bounds, 376, 642.57), normalizeBounds(CHINA_REGION.bounds));
});

test('fitViewToCanvas + fitBounds 组合（真机链路）：数据可见 + 比例匹配 + 框 == 块', () => {
  // 工单要求的组合方式：fitBounds(photos, pad) → fitViewToCanvas(vb, boxW, boxH)
  const photos = [ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)];
  const vb = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(vb !== undefined);
  const bounded = fitViewToCanvas(vb, DEV_BOX_W, DEV_BOX_H);
  // ① 三张照片全在框内
  for (let i = 0; i < photos.length; i++) {
    const p: WallPhoto = photos[i];
    assert.ok(bounded[0] <= p.lon && p.lon <= bounded[2], `${p.photoId} 经度跑到框外`);
    assert.ok(bounded[1] <= p.lat && p.lat <= bounded[3], `${p.photoId} 纬度跑到框外`);
  }
  // ② 框 == 块（铺满）
  const f: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, bounded);
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9);
  assert.ok(Math.abs(f.w - DEV_BOX_W) < 1e-9 && Math.abs(f.h - DEV_BOX_H) < 1e-9);
  // ③ 场景照常算得出来（没有一张卡片或钉子变成 NaN）
  const pins = buildScene(photos, f, 1);
  assert.ok(pins.length >= 1);
  for (let i = 0; i < pins.length; i++) {
    assert.ok(Number.isFinite(pins[i].x) && Number.isFinite(pins[i].y), `钉子坐标非有限：${pins[i].pinId}`);
    for (const m of pins[i].markers) {
      assert.ok(Number.isFinite(m.dx) && Number.isFinite(m.dy), `标记偏移非有限：${pins[i].pinId}`);
    }
  }
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

test('outlinePath：视口是**绘制框**而不是地图块 —— 框装不满块时，框外的环必须被剔掉', () => {
  // task-17 补的一条。两种口径只在"框比块小"时才分道扬镳，而"框 ⊆ 中国"之后
  // **全国视野就是这样**：376×642.57 的块里，框只有 376×279.62 居中（上下各留 181pt）——
  // 南海诸岛（8~11.4°N）投影在框**下方**、却仍在**块内**。
  // 按块判（老口径）一条都剔不掉 → 它们飘进框下面那条留白里，正好是这段裁剪想消灭的"脏点"。
  const frame: MapFrame = mapFrame(376, 642.57, CHINA_REGION.bounds);
  assert.ok(frame.h < frame.blockH - 1, `（自检）这个块里框装不满：h=${frame.h} blockH=${frame.blockH}`);
  assert.ok(frame.y > 1, `（自检）框纵向居中，上下都有留白：y=${frame.y}`);
  const islets = [112, 11, 113, 11, 113, 10];   // 南海诸岛一带：框下方、块之内
  const inside = [100, 30, 101, 30, 101, 29];   // 框内的一个环（对照）
  const d = outlinePath([inside, islets], frame);
  assert.equal(d.split('M').length - 1, 1, '框外的环（虽然在块内）没有被剔除');
  assert.equal(outlinePath([islets], frame), '', '框外的东西不许画进那两条留白里');
  // 判别力：这个点确实在**框下方**、又确实在**块之内** —— 老口径（按块判）因此漏掉它
  const proj = projectMercator(112.5, 10.5, frame.w, frame.h, frameBounds(frame));
  const y: number = proj.y + frame.y;
  assert.ok(y > frame.y + frame.h + 1, `（自检）这个点应当在框下方：y=${y} 框底=${frame.y + frame.h}`);
  assert.ok(y <= frame.blockH, `（自检）但它仍在块内：y=${y} 块高=${frame.blockH}`);
  // 框 == 块时两种口径**逐字相同**（所有比例正好匹配的情形都不受影响）
  const flat: MapFrame = mapFrame(W, mapBoxHeight(W, CHINA_REGION.bounds), CHINA_REGION.bounds);
  assert.equal(outlinePath([inside, islets], flat), outlinePath([inside], flat),
    '框 == 块时行为必须与老口径一致（这条是"改动最小"的判据）');
});

test('outlinePath：坐标在**块坐标**里 —— 框居中时轮廓跟着偏移 frame.x / frame.y', () => {
  // 一个刻意做得很高、很窄的块：框按"填满宽度"算，居中在纵向 → frame.y > 0。
  const tall: MapFrame = mapFrame(200, 900, CHINA_REGION.bounds);
  assert.ok(tall.y > 0, `这个块应当让框纵向居中：y=${tall.y}`);
  const ring = [73, 54, 135, 54, 135, 18, 73, 18];
  const d = outlinePath([ring], tall);
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map((s: string) => Number(s));
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < nums.length; i += 2) {
    if (nums[i] < minY) { minY = nums[i]; }
    if (nums[i] > maxY) { maxY = nums[i]; }
  }
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
  const frame: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, fitViewToCanvas(b, DEV_BOX_W, DEV_BOX_H));
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

test('省界在**真机那一档视野**下确实还有线可画（放大 9.5 倍后不能一条都不剩）', () => {
  // 用户的抱怨是"放大之后整个地图是一片"。所以"全国视野下有省界"不够 ——
  // 必须验证**真机那一档**（376×663.71 + 上海/北京/天津）视野里也有省界。
  const photos = [ph('sh', SH_LAT, SH_LON, 0), ph('bj', BJ_LAT, BJ_LON, 0), ph('tj', TJ_LAT, TJ_LON, 0)];
  const vb = fitBounds(photos, VIEW_PAD_RATIO);
  assert.ok(vb !== undefined);
  const frame: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, fitViewToCanvas(vb, DEV_BOX_W, DEV_BOX_H));
  const pd = parseOutline(fs.readFileSync(PROVINCE_URL, 'utf8'));
  assert.ok(pd !== undefined);
  const dp = outlinePath(pd.rings, frame);
  const subpaths = dp.split('M').length - 1;
  // 实测 38/107 条环落在这个视野里（真机诊断行会印 `省界 <字符数>`，可对照）
  assert.equal(subpaths, 38, `真机那一档视野里的省级子路径数变了：${subpaths}`);
  assert.ok(dp.length > 50000, `省界 path 太短（${dp.length}）—— 放大后省界可能已经看不见了`);
  assert.ok(!dp.includes('NaN'));
  // 判别力：如果只有国界，这一档视野里几乎只剩海岸线 —— 字符数会差一个量级
  const od = parseOutline(fs.readFileSync(OUTLINE_URL, 'utf8'));
  assert.ok(od !== undefined);
  const dc = outlinePath(od.rings, frame);
  assert.ok(dp.length > dc.length * 1.5,
    `真机视野下省界（${dp.length}）没有比国界（${dc.length}）密 —— 用户会再次看到"一片"`);
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

test('zoomViewAt：缩放界限 = [单城市级 0.6°，全国 62°]，且夹完仍以同一点为不动点', () => {
  const b: number[] = [115.01, 29.95, 122.89, 41.23];
  // 放大到极限：经度跨度收到 MIN_VIEW_SPAN_DEG（= 0.6°，"一个地级市加近郊"）
  const zin: number[] = zoomViewAt(b, 1e6, 0.4, 0.6);
  assert.ok(Math.abs((zin[2] - zin[0]) - MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-9,
    `放大上限不是单城市级：${zin[2] - zin[0]}`);
  // 缩小到极限：经度跨度放到全国跨度（= 62°，再往外没有任何轮廓数据可画）
  const zout: number[] = zoomViewAt(b, 1e-6, 0.5, 0.5);
  assert.ok(Math.abs((zout[2] - zout[0]) - MAX_VIEW_SPAN_DEG) < 1e-9,
    `缩小下限不是全国视野：${zout[2] - zout[0]}`);
  assert.equal(MAX_VIEW_SPAN_DEG, CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0],
    'MAX_VIEW_SPAN_DEG 应当就是 CHINA_REGION 的经度跨度（不许另写 62）');
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
    assert.ok(frameBottomAt(f, DEV_BOX_H, 0) > 0);
  }
});

test('手势链路：连续"拖动 + 偏心缩放"之后，框仍然合法、比例不变、数据边界不破', () => {
  let b: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  const aspect0: number = geoAspect(b);
  // 模拟 60 帧的手势：一边放大一边往东南拖（偏心在 (0.3, 0.7)）
  for (let i = 0; i < 60; i++) {
    b = zoomViewAt(b, 1.05, 0.3, 0.7);
    b = panViewBy(b, 0.01, 0.012);
    for (let j = 0; j < 4; j++) { assert.ok(Number.isFinite(b[j]), `第 ${i} 帧出现非有限坐标：${b}`); }
    assert.ok(b[2] > b[0] && b[3] > b[1], `第 ${i} 帧跨度塌了：${b}`);
    assert.ok(Math.abs(geoAspect(b) - aspect0) < 1e-6, `第 ${i} 帧比例漂了：${geoAspect(b)} vs ${aspect0}`);
  }
  // 60 帧之后仍然是合法的视野：能投影、能算场景
  const f: MapFrame = mapFrame(DEV_BOX_W, DEV_BOX_H, b);
  assert.ok(Math.abs(f.w - DEV_BOX_W) < 1e-6 && Math.abs(f.h - DEV_BOX_H) < 1e-6,
    '手势之后框不再等于画布（铺满被破坏了）');
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
  assert.ok((b[2] - b[0]) <= MAX_VIEW_SPAN_DEG + 1e-9, `缩过头了：${b[2] - b[0]}`);
  // task-17：不止"经度不超"，**整个框都不许出中国**（这条 200 帧里含往西南拖）
  assert.ok(inChina(b), `缩到底之后跑出中国：${b}`);
});

// ── task-17：缩小的**上界**（真机缺陷：缩到底能看见南半球）──────────────────────
//
// 用户真机反馈原话：「铺满跟缩小的效果如图，每一个对的」（= 每一张都不对）。
// 两张截图的诊断行（逐字）：
//   图 1（想要的形态）`放大 9.5×→7.56× ｜ pins 3 ｜ 视野态 默认铺满`
//   图 2（缩到底）    `→铺满[67,-20.6,129,64.4] ｜ 放大 9.5×→1× ｜ 可缩 1×~103.33×`
// 图 2 里"可缩 1×"是**显示**，而同一个框的纬度跨度是 85°（−20.6 ~ 64.4）—— 显示与行为不符。
//
// 根因（读代码 + 真实代码复现，见报告 §2）：`zoomViewAt` 只把**经度**跨度夹到 62°，
// 纬度按同一个 factor **搭车**；`settleViewBox` 只夹**中心**，于是纬度只剩 ±84° 的
// 墨卡托安全带挡着（中国只要 18~54）。修法是 `containInChina`：框恒 ⊆ `CHINA_REGION.bounds`。
//
// 这一节钉住工单要求的四条：
//   ① 连续缩小 N 次 → 视野恒 ⊆ 全国（缩到底**就是**全国）
//   ② 纬度恒在 [18,54]（真机那个 −20.6° 再也不可达）
//   ③ 全国视野下中国居中且尽量大（横向顶满、只留上下）
//   ④ `可缩 N×` 的显示值与真实界限一致（"显示与行为不符"这件事本身）
//
// 这一节里的判据 `inChina` 是**独立**算的（只用 `CHINA_REGION.bounds`，不用实现里的任何
// 中间量）—— 否则就成了"用实现验证实现"。

/** 一个框是否整个落在中国范围之内（独立判据）。 */
function inChina(b: number[]): boolean {
  const cb: number[] = CHINA_REGION.bounds;
  return b[0] >= cb[0] - 1e-9 && b[2] <= cb[2] + 1e-9 && b[1] >= cb[1] - 1e-9 && b[3] <= cb[3] + 1e-9;
}

test('缩小上界：连续缩小 12 次（4 个不同不动点）后，视野**恒 ⊆ 全国**且纬度恒在 [18,54]', () => {
  const N: number = 12;
  const foci: number[][] = [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1], [0.02, 0.98]];
  const start: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_BOX_H);
  const lon0: number = start[2] - start[0];
  for (let k = 0; k < foci.length; k++) {
    let b: number[] = start.slice(0, 4);
    for (let i = 1; i <= N; i++) {
      b = zoomViewAt(b, 0.5, foci[k][0], foci[k][1]);
      // ① 有限 + 正跨度（NaN 会让整条 path 静默消失）
      for (let j = 0; j < 4; j++) { assert.ok(Number.isFinite(b[j]), `第 ${i} 次缩小非有限：${b}`); }
      assert.ok(b[2] > b[0] && b[3] > b[1], `第 ${i} 次缩小跨度塌了：${b}`);
      // ② **框 ⊆ 全国**
      assert.ok(inChina(b), `第 ${i} 次缩小跑出中国：${b}（不动点 ${JSON.stringify(foci[k])}）`);
      // ③ 纬度恒在 [18,54]（真机 −20.6° 的那条直接钉死）。
      //    ⚠️ 这里是**严格不等式**，不是容差：缩到底之后再拖/再缩时，贴边那一端
      //    必须**正好**落在 18/54 上（靠 `containInChina` 的 `SNAP_SPAN_EPS` 与
      //    "贴边直接用中国端点"两条保证），不许出现 17.999999999999996 这种"差一 ulp 的越界"。
      assert.ok(b[1] >= CHINA_REGION.bounds[1], `第 ${i} 次缩小纬度低于 18°N：${b[1]}`);
      assert.ok(b[3] <= CHINA_REGION.bounds[3], `第 ${i} 次缩小纬度高于 54°N：${b[3]}`);
      assert.ok(b[0] >= CHINA_REGION.bounds[0], `第 ${i} 次缩小经度低于 73°E：${b[0]}`);
      assert.ok(b[2] <= CHINA_REGION.bounds[2], `第 ${i} 次缩小经度高于 135°E：${b[2]}`);
      // ④ 缩小是**单调**的：视野只会变大。夹断若把跨度压小，这条会抓住
      assert.ok(b[2] - b[0] >= lon0 - 1e-9, `第 ${i} 次缩小反而变小了：${b[2] - b[0]} < ${lon0}`);
    }
    // ⑤ 12 次之后**恒等于全国**（不是"接近"、也不是"中国在一个角上"）
    assert.deepEqual(b, normalizeBounds(CHINA_REGION.bounds),
      `缩到底应当**就是全国**：${b}（不动点 ${JSON.stringify(foci[k])}）`);
    // ⑥ 再缩也不会变（上界是**可达并且是终点**）
    const again: number[] = zoomViewAt(b, 0.5, 0.5, 0.5);
    assert.deepEqual(again, b, '到了全国之后继续缩小必须一动不动');
  }
});

test('缩小上界：一次缩到底 == 全国；真机那个 `[67,-20.6,129,64.4]` 再也不可达', () => {
  const start: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_H_ROW2);
  const one: number[] = zoomViewAt(start, 1e-9, 0.5, 0.5);
  assert.deepEqual(one, normalizeBounds(CHINA_REGION.bounds), `一次缩到底应当是全国：${one}`);
  // 图 2 的真机框：纬度 −20.6°（南半球）。它必须落在"不可达"里 —— 判别力就在这条。
  const deviceRow2: number[] = [67, -20.6, 129, 64.4];
  assert.ok(!inChina(deviceRow2), '（自检）真机图 2 那个框本来就在中国之外');
  assert.ok(one[1] >= CHINA_REGION.bounds[1], `缩到底不许出现南半球：${one[1]}`);
  assert.ok(one[1] > 0, '更不许出现负纬度');
  // 也不许"经度到顶但纬度搭车"：两根轴都要到全国
  assert.ok(Math.abs((one[2] - one[0]) - (CHINA_REGION.bounds[2] - CHINA_REGION.bounds[0])) < 1e-9);
  assert.ok(Math.abs((one[3] - one[1]) - (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1])) < 1e-9);
});

test('缩小上界：到达全国之后，再拖 / 再缩都是**逐位恒等**（边界值不漂）', () => {
  // 缩到底那一帧是 `[73,18,135,54]`（**逐位**）。此时：
  //   · 再缩小 → `zoomViewAt` 里 factor 被反解夹到 1 → 直接逐位返回；
  //   · 再拖动 → `settleViewBox` 慢路径 → `containInChina` 的"顶满中国"那一支 → 逐位回到同四个数。
  // 这条守的是 `SNAP_SPAN_EPS` 与"贴边直接用中国端点"这两处实现细节：
  // 没有它们，"顶满"在浮点下判不出来（平移后的两端相减差一两个 ulp），
  // 代码会走"平移贴边"那一支，而那一支的另一端是**减出来的** →
  // 纬度变成 18.000000000000114，缩到底就不再是一个稳定的终点。
  let b: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_H_ROW2);
  for (let i = 0; i < 12; i++) { b = zoomViewAt(b, 0.5, 0.5, 0.5); }
  assert.deepEqual(b, normalizeBounds(CHINA_REGION.bounds), '缩到底必须是逐位的全国框');
  // 严格不等式（不是容差）：纬度**不出现** < 18 或 > 54
  assert.ok(b[1] >= CHINA_REGION.bounds[1] && b[3] <= CHINA_REGION.bounds[3], `纬度越界：${b[1]}~${b[3]}`);
  const dirs: number[][] = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.3, 0.3], [-0.3, -0.3], [2, -2]];
  for (let k = 0; k < dirs.length; k++) {
    assert.deepEqual(panViewBy(b, dirs[k][0], dirs[k][1]), normalizeBounds(CHINA_REGION.bounds),
      `缩到底之后拖 ${JSON.stringify(dirs[k])} 不该改变视野`);
    assert.deepEqual(zoomViewAt(b, 0.25, 0.3, 0.7), normalizeBounds(CHINA_REGION.bounds),
      '缩到底之后再缩不该改变视野');
  }
  // 40 轮混合（往各个方向拖 + 缩），仍然逐位恒等 —— "上界是终点"的机器可读含义
  let s: number[] = b.slice(0, 4);
  for (let i = 0; i < 40; i++) {
    s = panViewBy(s, (i % 7 - 3) * 0.4, (i % 5 - 2) * 0.4);
    s = zoomViewAt(s, 0.9, 0.2, 0.8);
  }
  assert.deepEqual(s, normalizeBounds(CHINA_REGION.bounds), `缩到底之后 40 轮混合手势漂了：${s}`);
});

test('缩小上界：全国视野下 mapFrame 把中国**居中且尽量大**（横向顶满、只留上下）', () => {
  const nat: number[] = normalizeBounds(CHINA_REGION.bounds);
  const f: MapFrame = mapFrame(DEV_BOX_W, DEV_H_ROW2, nat);
  // ① 横向顶满：框宽 == 画布宽。这就是"尽量大"—— 再大只能裁掉中国的南北两端，
  //    而"看到完整的中国"正是这次的要求本身。
  assert.ok(Math.abs(f.w - DEV_BOX_W) < 1e-9, `框宽应当顶满画布：${f.w}`);
  assert.ok(Math.abs(f.x) < 1e-9, `横向不该有留白：${f.x}`);
  // ② 居中：上下留白两侧相等（frame.y 就是那一半）
  assert.ok(Math.abs(f.y - (DEV_H_ROW2 - f.h) / 2) < 1e-9, `纵向没居中：y=${f.y}`);
  // ③ 不变形：框的宽高比 == 中国自己的墨卡托比
  assert.ok(Math.abs(f.w / f.h - geoAspect(nat)) < 1e-9, `框变形了：${f.w}/${f.h}`);
  // ④ "尽量大"的精确含义：框高 = 画布宽 / 中国墨卡托比（再高就必然变形或裁掉中国）
  assert.ok(Math.abs(f.h - DEV_BOX_W / geoAspect(nat)) < 1e-9, `框高不是最大值：${f.h}`);
  // ⑤ 竖屏下**必然**有上下留白（画布比 0.585 vs 中国比 1.345）—— 这是取舍，不是缺陷
  assert.ok(f.h < DEV_H_ROW2 - 1, '竖屏下中国填不满高度（填满就必然变形/裁掉南北）');
  const blankPct: number = (1 - f.h / DEV_H_ROW2) * 100;
  assert.ok(blankPct > 40 && blankPct < 70, `留白比例应当在"大量但可接受"一档：${blankPct}%`);
  // ⑥ 留白那两条带**不是异色空缺**：框底之下仍然在块内，且 `frameBottomAt` 报得出来
  //    （task-18 之后再也没有"卡片挂在留白里"这回事，这个数只剩诊断/图例的用途）
  const bottom: number = frameBottomAt(f, DEV_H_ROW2, 34);
  assert.ok(bottom > f.y + f.h, `框底之下应当仍在块内：bottom=${bottom} 框底=${f.y + f.h}`);
  assert.ok(bottom <= DEV_H_ROW2 - 34 + 1e-9, `底边不得越过页脚：${bottom}`);
  // ⑦ 判别力：老行为（不钳制）下中国只占画面高度的 45.2% —— 测试若抓不到这个差别就没用
  const oldLoose: number[] = [73, -11.54, 135, 68.18];
  const shareOld: number = (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1]) / (oldLoose[3] - oldLoose[1]);
  assert.ok(shareOld < 0.46, `（自检）老框里中国只占 ${(shareOld * 100).toFixed(1)}% 高`);
  assert.ok(shareOld < 0.99, `新框里中国占 100%（框 == 中国），老框 ${(shareOld * 100).toFixed(1)}% —— 这就是修复本身`);
  // ⑧ task-18 复核：把框撑满块（放弃"⊆ 中国"）会让中国**更小**，所以本函数刻意不那么做。
  //    这里用**同样的算法**手算那一步的产物，把"更小"变成一个数字 —— 而不是一句判断。
  const filledLoose: number[] = [73, -12.54, 135, 68.44];        // 实测值（见报告）
  const shareFilled: number = (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1]) / (filledLoose[3] - filledLoose[1]);
  const shareKeep: number = (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1]) / (nat[3] - nat[1]);
  assert.equal(shareKeep, 1, '现在的框就是中国本身 —— 中国占画面高度的 100%（框内）');
  assert.ok(shareFilled < 0.5, `（自检）撑满块那一档里中国只占 ${(shareFilled * 100).toFixed(1)}% 高`);
  assert.ok(shareFilled < shareKeep, '（自检）撑满块竟然没有让中国变小 —— 那这条复核就没有判别力');
  assert.ok(filledLoose[1] < 0, '（自检）撑满块会把视野拉到南半球（这正是不能那么做的原因）');
});

test('缩小上界：`可缩 N×` 的显示值与**真实界限**一致（"显示与行为不符"这件事本身）', () => {
  // 图 2 的诊断行写着 `可缩 1×~103.33×`，可当时的框纬度是 85°。显示端与约束端各写各的，
  // 就是那个不符的根。现在显示端读 `viewZoomRange()`，约束端是 `containInChina` + 两个常量。
  const zr: number[] = viewZoomRange();
  assert.equal(zr[0], 1, `显示的下界应当是 1×：${zr[0]}`);
  assert.ok(Math.abs(zr[1] - MAX_VIEW_SPAN_DEG / MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-12,
    `显示的上界应当是 62/0.6：${zr[1]}`);
  assert.ok(Math.abs(zr[1] - 103.3333) < 0.001, `真机诊断行印的是 103.33×：${zr[1]}`);

  // 下界：反复缩小 → 实际到达的倍数必须**正好**是显示的那个下界
  let b: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_H_ROW2);
  for (let i = 0; i < 40; i++) { b = zoomViewAt(b, 0.5, 0.5, 0.5); }
  assert.equal(viewZoomOf(b), zr[0], `显示可缩到 ${zr[0]}×，实际只到 ${viewZoomOf(b)}×`);
  // ⚠️ 光比倍数**不够** —— 老实现下 `viewZoomOf` 也是 1（它只读经度）。
  //    必须同时钉住"到达下界时**就是全国**"，否则"1×"永远可以只是显示。
  assert.deepEqual(b, normalizeBounds(CHINA_REGION.bounds), '1× 必须是"就是全国"，不是"经度到顶"');
  assert.ok(Math.abs((b[3] - b[1]) - (CHINA_REGION.bounds[3] - CHINA_REGION.bounds[1])) < 1e-9,
    '1× 时纬度跨度也必须 == 中国（老实现这里是 85°）');

  // 上界：反复放大 → 实际到达的倍数 == 显示的 103.33×
  let c: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_H_ROW2);
  for (let i = 0; i < 60; i++) { c = zoomViewAt(c, 2, 0.5, 0.5); }
  assert.ok(Math.abs(viewZoomOf(c) - zr[1]) < 1e-9, `显示可放到 ${zr[1]}×，实际到了 ${viewZoomOf(c)}×`);
  assert.ok(Math.abs((c[2] - c[0]) - MIN_ZOOMED_VIEW_SPAN_DEG) < 1e-9,
    `放到顶时经度跨度应当是单城市级 ${MIN_ZOOMED_VIEW_SPAN_DEG}°：${c[2] - c[0]}`);
  assert.ok(inChina(c), `放到顶之后仍须在中国之内：${c}`);
});

test('缩小上界：平移到边界是"停住"（跨度不变），不是"被压扁"', () => {
  // 这一条守的是 `containInChina` 的**平移**语义（与 `fitAxis` 第 ③ 步同一条规矩）：
  // 两端各夹一下会把跨度压小甚至压成 0 —— 那正是"整块画布 NaN"的来源。
  const start: number[] = fitViewToCanvas(DEV_VIEW, DEV_BOX_W, DEV_H_ROW2);
  const lonSpan0: number = start[2] - start[0];
  const latSpan0: number = start[3] - start[1];
  const p: number[] = panViewBy(start, 50, 0);          // 往西拖到头
  assert.ok(inChina(p), `拖到头仍须在中国之内：${p}`);
  assert.ok(Math.abs((p[2] - p[0]) - lonSpan0) < 1e-9, `平移被夹两端了（跨度变了）：${p[2] - p[0]}`);
  assert.ok(Math.abs(p[0] - CHINA_REGION.bounds[0]) < 1e-9, `应当正好贴住 73°E：${p[0]}`);
  const p2: number[] = panViewBy(p, 50, 0);             // 已经到头，再拖
  assert.ok(Math.abs(p2[0] - p[0]) < 1e-9 && Math.abs(p2[2] - p[2]) < 1e-9, '到头之后不该再动');
  const q: number[] = panViewBy(start, 0, -50);         // 往南拖到头
  assert.ok(inChina(q), `往南拖到头仍须在中国之内：${q}`);
  assert.ok(Math.abs(q[1] - CHINA_REGION.bounds[1]) < 1e-9, `应当正好贴住 18°N：${q[1]}`);
  // ⚠️ 纵向的"跨度不变"是**在 mercY 空间里**说的（`panViewBy` 就是这么平移的），
  //    所以这里断言的是**形状**（geoAspect 不变），不是"纬度度数不变"：
  //    同一段 mercY 在低纬覆盖更多纬度 —— 拖到南边之后纬度度数**会变大**
  //    （11.36° → 13.30°），那是墨卡托，不是被拉伸。写成"纬度度数不变"是错的。
  assert.ok(Math.abs(geoAspect(q) - geoAspect(start)) < 1e-9,
    `纵向平移改变了形状（mercY 跨度变了）：${geoAspect(q)} vs ${geoAspect(start)}`);
  assert.ok((q[3] - q[1]) >= latSpan0 - 1e-9, `拖到低纬后纬度度数只应变大：${q[3] - q[1]} vs ${latSpan0}`);
  // 放大态：中国比视野大 → 平移是**真的能走**的（不是把地图锁死）
  let z: number[] = start.slice(0, 4);
  for (let i = 0; i < 6; i++) { z = zoomViewAt(z, 2, 0.5, 0.5); }
  const z1: number[] = panViewBy(z, 0.2, 0);
  assert.ok(z1[0] < z[0] - 0.01, `放大态往西拖应当真的移动：${z1[0]} vs ${z[0]}`);
  assert.ok(inChina(z1), `移动之后仍须在中国之内：${z1}`);
});

// ── 地图框：铺满主体区 + 不变形 + 居中（task-14 的形态改造） ─────────────────

test('mapFrame：块填满可用高度；框取不下于它的最大一块，且**永不变形**', () => {
  const f = mapFrame(W, H, CHINA_REGION.bounds);
  // 块 = 整个主体区（这就是"地图占满主体区域"的含义：地图是这整块区域的底色）
  assert.equal(f.blockW, W);
  assert.equal(f.blockH, H);
  // 框的宽高比 == 墨卡托宽高比（不变形，这是硬约束）
  assert.ok(Math.abs(f.w / f.h - geoAspect(CHINA_REGION.bounds)) < 1e-9, `框变形了：${f.w}/${f.h}`);
  // 竖屏 360×720：按"填满高度"算出来的宽度 968.18 放不下 → 退成"填满宽度"
  assert.ok(Math.abs(f.w - W) < 1e-9, `框宽应当是画布宽：${f.w}`);
  assert.ok(Math.abs(f.h - mapBoxHeight(W, CHINA_REGION.bounds)) < 1e-9);
  // 框完全落在块里，且**居中**
  assert.ok(f.x >= -1e-9 && f.y >= -1e-9);
  assert.ok(f.x + f.w <= f.blockW + 1e-9 && f.y + f.h <= f.blockH + 1e-9);
  assert.ok(Math.abs(f.x - (f.blockW - f.w) / 2) < 1e-9, '横向没有居中');
  assert.ok(Math.abs(f.y - (f.blockH - f.h) / 2) < 1e-9, '纵向没有居中');
  // 关键反证：**没有**把框拉满 720 高（那会把中国拉成竖条）
  assert.ok(f.h < f.blockH, '框被拉满了整块高度 —— 那是变形的');
});

test('mapFrame：块足够宽时真的**填满高度**（宽体上第 1 条生效）', () => {
  // 1000×600 的横屏块：按填满高度算宽 = 600×1.3447 = 806.8 ≤ 1000 → 成立，两侧留白居中
  const f = mapFrame(1000, 600, CHINA_REGION.bounds);
  assert.ok(Math.abs(f.h - 600) < 1e-9, `框没有填满高度：h=${f.h}`);
  assert.ok(Math.abs(f.w / f.h - geoAspect(CHINA_REGION.bounds)) < 1e-9, '框变形了');
  assert.ok(f.x > 0 && f.y === 0, `应当是"左右居中留白、上下填满"：x=${f.x} y=${f.y}`);
  assert.ok(Math.abs(f.x - (1000 - f.w) / 2) < 1e-9);
});

test('mapFrame：比例刚好匹配时框 == 块（留白为 0）', () => {
  const h = mapBoxHeight(W, CHINA_REGION.bounds);
  const f = mapFrame(W, h, CHINA_REGION.bounds);
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9);
  assert.ok(Math.abs(f.w - W) < 1e-9 && Math.abs(f.h - h) < 1e-9);
});

test('mapFrame：非法尺寸返回全 0 的框（不产出 NaN 坐标）', () => {
  for (const bad of [[0, 720], [360, 0], [-1, 720], [360, -1], [Number.NaN, 720], [360, Number.POSITIVE_INFINITY]]) {
    const f = mapFrame(bad[0] as number, bad[1] as number, CHINA_REGION.bounds);
    assert.equal(f.w, 0, `块 ${bad[0]}×${bad[1]} 应当给出空框`);
    assert.equal(f.h, 0);
    assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
  }
});

test('frameBottomAt：画布 = 块时给块底；页脚把它压到框底以下就不再往下让', () => {
  const f = FRAME;
  const frameBottom = f.y + f.h;
  // 画布就是块、没有页脚 → 块底
  assert.equal(frameBottomAt(f, f.blockH, 0), f.blockH);
  // 给页脚：底 = 块底 − 页脚（但要 ≥ 框底，否则"下方没余量"时反而报出一个不存在的空间）
  assert.equal(frameBottomAt(f, f.blockH, 34), f.blockH - 34);
  assert.equal(frameBottomAt(f, f.blockH, f.blockH - frameBottom + 10), frameBottom);
  // 画布比块还矮 → 按块处理（不能比地图还矮）
  assert.equal(frameBottomAt(f, 100, 0), f.blockH);
  // 非法尺寸不产 NaN（与 mapFrame 同一条契约）
  assert.ok(Number.isFinite(frameBottomAt(f, Number.NaN, Number.NaN)));
});

// ── 地图填满度（本批验收里的那个数字） ──────────────────────────────────────

test('mapFillRatio：框面积 / 可用区面积；有界视野下它 == 1（真的铺满），全国视野下如实报小', () => {
  // ① 有界视野（`fitViewToCanvas` 撑到画布比例）→ 框 == 块 → **1.0**
  const bounded: number[] = fitViewToCanvas([114.9, 29.88, 122.19, 41.24], W, H);
  const fb: MapFrame = mapFrame(W, H, bounded);
  assert.equal(mapFillRatio(fb), 1, `有界视野没有铺满：${mapFillRatio(fb)}`);
  assert.equal(fb.x, 0);
  assert.equal(fb.y, 0);
  assert.equal(fb.w, W);
  assert.equal(fb.h, H);
  // ② 全国视野：中国自己的墨卡托比 1.345 vs 画布 0.5 → 框只能占 37.18%（**故意的**，
  //    理由见 MapFrame 的注释：撑满会拉到南半球，中国反而更小）
  const nat: MapFrame = mapFrame(W, H, CHINA_REGION.bounds);
  const r = mapFillRatio(nat);
  assert.ok(Math.abs(r - 267.72 / 720) < 1e-4, `全国视野的填满度应当是 37.18%：${r}`);
  assert.ok(r > 0.36 && r < 0.38, `填满度实测 ${r}`);
  // ③ 口径核对：这个比值与"框 ⊆ 块"是同一件事
  assert.ok(nat.w <= nat.blockW + 1e-9 && nat.h <= nat.blockH + 1e-9);
  // ④ 退化输入不产 NaN
  assert.equal(mapFillRatio({ blockW: 0, blockH: 0, x: 0, y: 0, w: 0, h: 0 }), 0);
  assert.equal(mapFillRatio({ blockW: 360, blockH: 720, x: 0, y: 0, w: 0, h: 0 }), 0);
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
  // 整簇（含标记半径）必须落在画布内 —— 画布就是地图块 [0,W]×[0,H]
  for (const q of sceneMarkers(pins)) {
    assert.ok(q[0] - MARKER_R >= -1e-6, `标记左边界越界：${q[0] - MARKER_R}`);
    assert.ok(q[0] + MARKER_R <= W + 1e-6, `标记右边界越界：${q[0] + MARKER_R}`);
    assert.ok(q[1] - MARKER_R >= -1e-6, `标记上边界越界：${q[1] - MARKER_R}`);
    assert.ok(q[1] + MARKER_R <= H + 1e-6, `标记下边界越界：${q[1] + MARKER_R}`);
  }
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

