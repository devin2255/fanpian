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
import { MAX_HANG, MIN_PIN_DIST_PT } from './placement.ts';
import {
  HANG_GAP, HANG_PHOTO_H, HANG_PHOTO_W, HANG_OVERLAP_EPS, HANG_SWEEP_RAD, MIN_VIEW_SPAN_DEG, TRACK_WIDTH,
  VIEW_PAD_RATIO, arcSpread, arcSpreadNeed, buildScene, clampRect, dateLabel, fitBounds, fitViewToCanvas,
  frameBounds, geoAspect, hangBottom, hangOffsets, hangRects, mapBoxHeight, mapFrame, normalizeBounds,
  outlinePath, parseOutline, pinTime, rectOverlapArea, sceneToSvg, trajectoryOrder, trajectoryPath, viewZoomOf
} from './render.ts';
import type { CardRect, MapFrame, ScenePin, WallPhoto } from './render.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
parseAreaData(fs.readFileSync(DATA_URL, 'utf8'));

const W = 360;
const H = 720;

/**
 * 各种测试用的地图框。
 *
 * `MapFrame` 把"地图块"和"不变形绘制框"分成两件事（见 core/render.ts 的长注释）：
 * 块是整块主体区（地图是它的底色），框是块里那个**不变形**、**居中**的矩形。
 * 于是 `ScenePin.x/y` 与 `hangRects` 的矩形都落在**块坐标**里 ——
 * 断言坐标时要带上框的平移（`atFrame` 就是干这个的）。
 */
/** 真机形状：主体区 360×720 → 框 360×267.72，居中在 y=226.14（x=0，因为宽度正好用满）。 */
const FRAME: MapFrame = mapFrame(W, H, CHINA_REGION.bounds);
/** "画布给得很宽"的那一档（720×800）：框宽 720、高 535.53，居中在 y=132.24。 */
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

// ── hangOffsets：弧形（本批最关键的一条"不是垂直"） ─────────────────────────

test('hangOffsets：n=5 确实是一条弧 —— 中间低、两侧高、左右对称', () => {
  const o = hangOffsets(5, 100);
  assert.equal(o.length, 5);
  // 严格对称
  assert.ok(Math.abs(o[0].dx + o[4].dx) < 1e-9);
  assert.ok(Math.abs(o[1].dx + o[3].dx) < 1e-9);
  assert.ok(Math.abs(o[2].dx) < 1e-9);
  // 中间的 dy 最大、两端最小 → 弧（若排成竖线，dy 会全部相等）
  assert.ok(o[2].dy > o[1].dy);
  assert.ok(o[1].dy > o[0].dy);
  assert.ok(Math.abs(o[0].dy - o[4].dy) < 1e-9);
  // 等半径：所有点都在以钉子为圆心的同一个圆上
  const r0 = Math.sqrt(o[0].dx * o[0].dx + o[0].dy * o[0].dy);
  for (let i = 0; i < 5; i++) {
    const r = Math.sqrt(o[i].dx * o[i].dx + o[i].dy * o[i].dy);
    assert.ok(Math.abs(r - r0) < 1e-9, `第 ${i} 张不在同一个圆上`);
  }
  // 弦宽就是 spread：最左到最右
  assert.ok(Math.abs((o[4].dx - o[0].dx) - 100) < 1e-9);
});

test('hangOffsets：dx 不是常数（垂直线会露馅）+ dy 恒为正（照片都在钉子下方）', () => {
  for (const n of [1, 2, 3, 9]) {
    const o = hangOffsets(n, 120);
    assert.equal(o.length, n);
    for (let i = 0; i < n; i++) { assert.ok(o[i].dy > 0, `n=${n} 第 ${i} 张的 dy 不为正`); }
    if (n > 1) {
      assert.ok(Math.abs(o[0].dx - o[n - 1].dx) > 1, `n=${n} 的 dx 几乎没变化，等于垂直排列`);
    }
  }
});

test('hangOffsets：单张挂在正下方（dx=0），张角不超过 ±HANG_SWEEP/2', () => {
  const one = hangOffsets(1, 100);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].dx) < 1e-12);
  const nine = hangOffsets(9, 100);
  const lim = Math.tan(HANG_SWEEP_RAD / 2);
  for (const o of nine) {
    assert.ok(Math.abs(o.dx / o.dy) < lim + 1e-9, '方位角超出了张角的一半');
  }
});

test('hangOffsets：非法输入返回空数组，不抛错', () => {
  assert.deepEqual(hangOffsets(0, 100), []);
  assert.deepEqual(hangOffsets(-3, 100), []);
  assert.deepEqual(hangOffsets(5, 0), []);
  assert.deepEqual(hangOffsets(5, -1), []);
  assert.deepEqual(hangOffsets(5, Number.NaN), []);
});

test('arcSpread：单调不减 + 受可用宽度钳制 + 单张不为 0', () => {
  const a = arcSpread(1, W);
  assert.ok(a > 0);
  let prev = 0;
  for (let n = 1; n <= 12; n++) {
    const s = arcSpread(n, W);
    assert.ok(s >= prev, `n=${n} 的弦宽比 n-1 还小`);
    assert.ok(s <= W * 0.80 + 1e-9, `n=${n} 的弦宽超出了画布的安全区`);
    prev = s;
  }
  // 可用宽度很小时也不会退化成 0（否则整条弧会变成一个点）
  assert.ok(arcSpread(9, 10) > 0);
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

test('buildScene：钉子 ≤3 时全部展开（每钉最多 9 张）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304 + i * 0.001, 121.4737, 1700000000000 + i)); }
  const pins = buildScene(photos, FRAME, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].expanded, true);
  assert.equal(pins[0].photos.length, 12, 'ScenePin.photos 是全部照片，不受 MAX_HANG 截断');
  assert.ok(MAX_HANG === 9);
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
      // ④ 比例匹配（除非撞到 ±84°/360° 的兜底钳制 —— 那种极端画布在下面单独测）
      const unlimited = geoAspect(ex) > 1e-6;
      if (unlimited) {
        const want = c[0] / c[1];
        const hit = Math.abs(geoAspect(ex) - want) < 1e-9;
        const clamped = ex[1] <= -84 + 1e-9 || ex[3] >= 84 - 1e-9 || (ex[2] - ex[0]) >= 360 - 1e-9;
        assert.ok(hit || clamped, `比例既没匹配也没撞钳制：${geoAspect(ex)} vs ${want}（框 ${b} 画布 ${c}）`);
      }
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
  // 极端画布：撑到 ±84° 的墨卡托安全边界就停 —— 此时**优先保证数据可见**，比例可以不对
  const thin = fitViewToCanvas(CHINA_REGION.bounds, 100, 2000);
  assert.ok(Math.abs(thin[1] - -84) < 1e-9 && Math.abs(thin[3] - 84) < 1e-9, `应当停在 ±84：${thin}`);
  assert.ok(thin[1] <= CHINA_REGION.bounds[1] && thin[3] >= CHINA_REGION.bounds[3], '撞钳制后数据仍须在框内');
  assert.ok(Number.isFinite(geoAspect(thin)) && geoAspect(thin) > 0);
  // 极端扁画布：经度撑到 360° 封顶
  const fat = fitViewToCanvas(CHINA_REGION.bounds, 2000, 100);
  assert.ok(fat[2] - fat[0] <= 360 + 1e-9, `经度跨度不许超过 360：${fat[2] - fat[0]}`);
  assert.ok(fat[0] <= CHINA_REGION.bounds[0] && fat[2] >= CHINA_REGION.bounds[2], '撞钳制后数据仍须在框内');
});

test('fitViewToCanvas：**不做中国范围钳制**（允许露出境外）—— 这是有意为之的取舍', () => {
  // 判断与理由写在 render.ts 的 fitViewToCanvas 注释里，这里是它的**行为级**钉死：
  // 黑龙江东部那种"南北长、东西窄"的数据（[130.5,45,133.5,53]，墨卡托比 0.2453 < 画布比
  // 0.5665 → 框被**高度**限制、左右留白）撑开经度后必然越过 maxLon = 135 —— 允许
  // （境外是底色，不是错图）。注意：不是所有东北角数据都走这一支（[126,45,134,53] 比画布
  // 还"宽"，它走的是撑纬度的另一支，见上面那条穷举测试）。
  const ne: number[] = [130.5, 45, 133.5, 53];
  const ex = fitViewToCanvas(ne, 376, 663.71);
  assert.ok(ex[2] > CHINA_REGION.bounds[2], `东北角撑开后应当越过 135°E：${ex[2]}`);
  assert.ok(Math.abs(geoAspect(ex) - 376 / 663.71) < 1e-12, '越界也必须保持比例匹配');
  assert.ok(ex[0] <= ne[0] && ex[2] >= ne[2] && ex[1] <= ne[1] && ex[3] >= ne[3], '数据仍须全部可见');
  // 反证：若"钳制到中国范围"，比例就必然对不上 —— 这就是不钳制的理由 1
  const clampedToChina: number[] = [Math.max(ex[0], CHINA_REGION.bounds[0]), Math.max(ex[1], CHINA_REGION.bounds[1]),
    Math.min(ex[2], CHINA_REGION.bounds[2]), Math.min(ex[3], CHINA_REGION.bounds[3])];
  assert.ok(Math.abs(geoAspect(clampedToChina) - 376 / 663.71) > 1e-6,
    '钳制回中国之后比例**必然**不再匹配 —— 所以"钳制"与"铺满"不可兼得');
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
  const pins = buildScene(photos, f, 1, { canvasH: DEV_BOX_H, footer: 26 });
  assert.ok(pins.length >= 1);
  for (let i = 0; i < pins.length; i++) {
    assert.ok(Number.isFinite(pins[i].x) && Number.isFinite(pins[i].y), `钉子坐标非有限：${pins[i].pinId}`);
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

test('hangBottom：画布 = 块时给块底；页脚把它压到框底以下就不再往下让', () => {
  const f = FRAME;
  const frameBottom = f.y + f.h;
  // 不给 env：画布就是块 → 挂载区底 = 块底
  assert.equal(hangBottom(f), f.blockH);
  // 给页脚：底 = 块底 − 页脚（但要 ≥ 框底，否则"下方没余量"时反而画不出来）
  assert.equal(hangBottom(f, { canvasH: f.blockH, footer: 34 }), f.blockH - 34);
  assert.equal(hangBottom(f, { canvasH: f.blockH, footer: f.blockH - frameBottom + 10 }), frameBottom);
  // 画布比块还矮 → 按块处理（不能比地图还矮）
  assert.equal(hangBottom(f, { canvasH: 100 }), f.blockH);
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
  // 展开的钉子要画出"线"（挂在钉子上，而不是只画一个点）
  assert.ok(svg.includes('<line '));
  // 每一张**挂出来**的照片都要有一个卡片矩形；没挂出来的（shown < photos.length）不画卡片
  const hung = pins.reduce((s: number, p: ScenePin) => s + p.shown, 0);
  const cards = svg.split('rx="2" fill="#').length - 1;
  assert.equal(cards, hung);
  // 钉点与地名在**单独一层**、画在所有卡片之上（否则邻钉的照片会盖住地名）
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

test('sceneToSvg：挂出的张数由空间决定（MAX_HANG 只是上限），其余如实画成 +N', () => {
  // 12 张挂在同一个钉子上。26×34 的卡片下 9 张需要的弦宽是 arcSpreadNeed(9) ≈ 271.6pt，
  // 而 360 宽的画布能给 0.80×360 = 288pt —— **放得下**，于是 MAX_HANG 这道硬上限真的生效。
  // （34×44 的时代 9 张要 353.7pt > 259.2pt，"一屏最多 7 张"就是这么来的。）
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const pins = buildScene(photos, FRAME, 1);
  const shown = pins[0].shown;
  assert.ok(shown > 0 && shown <= MAX_HANG, `挂出 ${shown} 张，超出了 [1, MAX_HANG]`);
  const svg = sceneToSvg(pins, W, H, '');
  assert.equal(svg.split('rx="2" fill="#').length - 1, shown);
  assert.ok(svg.includes(`>+${12 - shown}<`), '缺少 +N 角标');
  // 画布给到 720 宽时 9 张放得下 → MAX_HANG 这道上限确实生效
  const wide: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { wide.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const widePins = buildScene(wide, FRAME_WIDE, 1, { canvasH: 4000 });
  assert.equal(widePins[0].shown, MAX_HANG, '画布够大时没有挂满 MAX_HANG');
  const wideSvg = sceneToSvg(widePins, 720, 4000, '');
  assert.equal(wideSvg.split('rx="2" fill="#').length - 1, MAX_HANG);
  assert.ok(wideSvg.includes('>+3<'));
});

test('sceneToSvg：收起的钉子不画照片，只画点 + 张数（"钉子多时收成点"）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 2; k++) {
      photos.push(ph(`f${i}_${k}`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1700000000000 + k));
    }
  }
  const pins = buildScene(photos, FRAME, 1);
  const svg = sceneToSvg(pins, W, H, '');
  assert.equal(svg.split('rx="2" fill="#').length - 1, 0, '收起的钉子仍然画了照片');
  assert.equal(svg.split('<line ').length - 1, 0, '收起的钉子仍然画了线');
  assert.ok(svg.includes('·2'), '收起的钉子没有显示张数');
});

// ── 几何一致性：卡片不会挂在钉子上面 ───────────────────────────────────────

test('sceneToSvg：所有卡片的顶端都在钉子的 HANG_GAP 之下（照片不会跑到钉子上面）', () => {
  const pins = demoPins();
  const svg = sceneToSvg(pins, W, H, '');
  const pinY = new Map<string, number>();
  for (const p of pins) { pinY.set(p.name, p.y); }
  const re = /<rect x="[-\d.]+" y="([\d.]+)" width="(\d+)" height="(\d+)" rx="2"/g;
  let m = re.exec(svg);
  let n = 0;
  while (m !== null) {
    const y = parseFloat(m[1]);
    assert.equal(Number(m[2]), HANG_PHOTO_W, `卡片宽度不是 ${HANG_PHOTO_W}：${m[2]}`);
    assert.equal(Number(m[3]), HANG_PHOTO_H, `卡片高度不是 ${HANG_PHOTO_H}：${m[3]}`);
    let minPinY = Number.POSITIVE_INFINITY;
    pinY.forEach((v: number) => { if (v < minPinY) { minPinY = v; } });
    assert.ok(y >= minPinY + HANG_GAP - 0.01, `卡片 y=${y} 挂到了钉子上面（最低的钉子在 ${minPinY}）`);
    n++;
    m = re.exec(svg);
  }
  assert.ok(n > 0, '没有解析到任何卡片');
  assert.ok(HANG_PHOTO_H > HANG_PHOTO_W);
});

test('dateLabel：0 / 负数 / NaN 显示为"未知时间"，正常时间显示 UTC 日期', () => {
  assert.equal(dateLabel(0), '未知时间');
  assert.equal(dateLabel(-1), '未知时间');
  assert.equal(dateLabel(Number.NaN), '未知时间');
  assert.equal(dateLabel(Date.UTC(2026, 9, 8, 12, 0, 0)), '2026-10-08');
});

// ────────────────────────────────────────────────────────────────────────────
// 空间决定的布局（本批新增）
//
// 修的是什么：`computeLayout` 只看（钉数、每钉张数、zoom），**不知道画布多大**。
// 于是 360×720 的画布上 6 个钉子下的 24 张卡片会伸出右边界、还会互相压住
//（实测：2 张出画布、7 对重叠、交集 2245pt²）。这不是画法问题而是规则问题。
//
// 下面这一组断言全部是**可核对的几何事实**，判据与 `tools/wall-audit.ts` 用的是同一个
// `HANG_OVERLAP_EPS` / 同一个 `hangRects`：布局说"不重叠"，量出来也必须是不重叠。
// ────────────────────────────────────────────────────────────────────────────

/** 真机尺寸：360×720 的 vp 画布（= 地图块），底部留 34pt 给图例。 */
const CANVAS_H = 720;
const FOOTER = 34;
/**
 * 挂载区底。**与 buildScene 内部用的是同一个 `hangBottom`** —— 这个测试文件里
 * "布局说放得下、量出来也放得下"的全部效力都建立在这一点上：两边各算一遍就会漂移。
 */
const BOTTOM = hangBottom(FRAME, { canvasH: CANVAS_H, footer: FOOTER });
/** 地图框底（= 挂载区顶）。框是居中的，所以它不再是 267.72，而是 226.14 + 267.72 = 493.86。 */
const FRAME_BOTTOM = FRAME.y + FRAME.h;
/** 地图框高（不变形的那个值）—— 钉子投影的纵向范围。 */
const MAP_H = FRAME.h;

/**
 * 一批**真实地点**下的照片（逐个注明来源；坐标与 tools/fixtures/wall-sample.json 同源，
 * 但内联在这里 —— core 的单测不依赖 tools 目录）。
 * 形状刻意做成"东海岸密集 + 西部稀疏"，那正是把布局压垮的场景。
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

/** 场景里**挂出来**的全部卡片矩形（与绘制、与 wall-audit 用的是同一个 hangRects）。 */
function sceneCards(pins: ScenePin[], canvasW: number, bottom: number): CardRect[] {
  const out: CardRect[] = [];
  for (const p of pins) {
    const rs = hangRects(p.x, p.y, p.shown, p.spread, canvasW, bottom);
    for (const r of rs) { out.push(r); }
  }
  return out;
}

/** 两两重叠对数（判据与 tools/wall-audit.ts 完全相同）。 */
function countOverlapPairs(rects: CardRect[]): number {
  let n = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectOverlapArea(rects[i], rects[j]) > HANG_OVERLAP_EPS) { n++; }
    }
  }
  return n;
}

test('布局：密集场景（6 钉 24 张）没有一张照片出画布 —— 修的就是这个缺陷', () => {
  const pins = buildScene(denseScene(), FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
  const cards = sceneCards(pins, W, BOTTOM);
  assert.ok(cards.length > 0, '一张都没挂出来');
  for (const r of cards) {
    assert.ok(r.x >= -1e-6, `卡片左边界越界：${r.x}`);
    assert.ok(r.x + r.w <= W + 1e-6, `卡片右边界越界：${r.x + r.w} > ${W}`);
    assert.ok(r.y >= -1e-6, `卡片上边界越界：${r.y}`);
    assert.ok(r.y + r.h <= BOTTOM + 1e-6, `卡片下边界越界：${r.y + r.h} > ${BOTTOM}`);
  }
});

test('布局：密集场景里任意两张照片框都不重叠（判据 = HANG_OVERLAP_EPS）', () => {
  const pins = buildScene(denseScene(), FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
  const cards = sceneCards(pins, W, BOTTOM);
  assert.equal(countOverlapPairs(cards), 0, `有 ${countOverlapPairs(cards)} 对卡片压在了一起`);
  assert.equal(HANG_OVERLAP_EPS, 1, '重叠判据变了 —— tools/wall-audit.ts 直接 import 它，要一起改');
});

test('布局：钳制只是兜底 —— 画出来的每张卡片都**没有**被挪动过，且弧的形状仍然成立', () => {
  const pins = buildScene(denseScene(), FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
  let checked = 0;
  for (const p of pins) {
    if (p.shown <= 0) { continue; }
    const offs = hangOffsets(p.shown, p.spread);
    const rects = hangRects(p.x, p.y, p.shown, p.spread, W, BOTTOM);
    assert.equal(rects.length, p.shown);
    const radii: number[] = [];
    for (let k = 0; k < p.shown; k++) {
      // 弧的解析位置：顶端中点 = (px + dx, py + HANG_GAP + dy)。画出来的矩形必须与它逐点相同 ——
      // 差一点点就说明 clampRect 挪过它（那就等于"画了一条被钳扁的假弧"，本批要求宁可收成点）。
      assert.ok(Math.abs((rects[k].x + rects[k].w / 2) - (p.x + offs[k].dx)) < 1e-9,
        `${p.name} 第 ${k} 张卡片被水平钳动了`);
      assert.ok(Math.abs(rects[k].y - (p.y + HANG_GAP + offs[k].dy)) < 1e-9,
        `${p.name} 第 ${k} 张卡片被竖直钳动了`);
      radii.push(Math.sqrt(offs[k].dx * offs[k].dx + offs[k].dy * offs[k].dy));
      checked++;
    }
    if (p.shown > 1) {
      // 等半径（线一样长，像风铃）、dy 中间最大（是弧不是竖线）
      for (const r of radii) { assert.ok(Math.abs(r - radii[0]) < 1e-9, `${p.name} 的卡片不在同一个圆上`); }
      const mid = offs[(p.shown - 1) / 2 | 0].dy;
      assert.ok(mid >= offs[0].dy - 1e-9, `${p.name} 的弧中间没有比两端低`);
      assert.ok(Math.abs(offs[0].dx - offs[p.shown - 1].dx) > 1, `${p.name} 的 dx 是常数 = 排成竖线了`);
    }
  }
  assert.ok(checked >= 10, `只核对到 ${checked} 张卡片`);
});

test('布局：靠边到放不下一张卡片时收成点（宁可收成点，也不画被钳扁的弧）', () => {
  // 经度 74.0 → 投影 x≈5.8pt，小于半张卡（26/2 = 13）+ 留白（4）= 17pt。
  // 喀什（75.99°E）在真机上正是这一类。地图框是居中的，但横向 x 不变（框宽 = 块宽）。
  const photos = [ph('k1', 39.47, 74.0, 1), ph('k2', 39.471, 74.001, 2), ph('k3', 39.469, 73.999, 3)];
  const pins = buildScene(photos, FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
  assert.equal(pins.length, 1);
  assert.ok(pins[0].x < HANG_PHOTO_W / 2, `钉子没有贴边：x=${pins[0].x}`);
  // 意愿为真（1 个钉子 ≤3 → 全展开），但空间一票否决 → shown=0，画成点 + 张数
  assert.equal(pins[0].expanded, true);
  assert.equal(pins[0].shown, 0);
  assert.equal(sceneCards(pins, W, BOTTOM).length, 0);
  const svg = sceneToSvg(pins, W, CANVAS_H, '');
  assert.equal(svg.split('<line ').length - 1, 0);
  assert.equal(svg.split('rx="2" fill="#').length - 1, 0);
  assert.ok(svg.includes('·3'), '收成点后没有显示张数');
});

test('布局兜底：一个钉子下 20 张 —— 挂得下的挂、其余如实 +N（不缩框、不叠）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 20; i++) { photos.push(ph(`q${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const pins = buildScene(photos, FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
  assert.equal(pins.length, 1);
  const p = pins[0];
  assert.ok(p.shown >= 1 && p.shown <= MAX_HANG, `挂出 ${p.shown} 张`);
  assert.ok(p.shown < 20, '20 张全挂出来了？那一定重叠了 —— 先看下面的重叠断言');
  const cards = sceneCards(pins, W, BOTTOM);
  assert.equal(cards.length, p.shown);
  assert.equal(countOverlapPairs(cards), 0);
  // 卡片尺寸**没有**被缩小（缩小会让日期字号不可读，所以兜底策略是"少挂几张"）
  for (const r of cards) {
    assert.equal(r.w, HANG_PHOTO_W);
    assert.equal(r.h, HANG_PHOTO_H);
  }
  const svg = sceneToSvg(pins, W, CANVAS_H, '');
  assert.ok(svg.includes(`>+${20 - p.shown}<`), `缺少 +${20 - p.shown} 角标`);
});

test('布局：shown 不超上限，且 shown>0 必然蕴含 expanded（空间只能否决意愿，不能凭空展开）', () => {
  const scenes: WallPhoto[][] = [denseScene(), [], [ph('a', 0, 0, 0)]];
  // 钉子多（16 个）的那一份：设计规则本来就判"全部收成点"，空间层不许把它翻过来
  const many: WallPhoto[] = [];
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 3; k++) { many.push(ph(`f${i}_${k}`, 22 + (i % 4) * 6.0, 80 + i * 3.0, 1 + k)); }
  }
  scenes.push(many);
  for (const photos of scenes) {
    const pins = buildScene(photos, FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER });
    for (const p of pins) {
      const cap = p.photos.length < MAX_HANG ? p.photos.length : MAX_HANG;
      assert.ok(p.shown <= cap, `${p.name} 挂了 ${p.shown} 张，上限是 ${cap}`);
      assert.ok(p.shown >= 0);
      if (p.shown > 0) { assert.equal(p.expanded, true, `${p.name} 没被判定展开却挂了照片`); }
      if (!p.expanded) { assert.equal(p.shown, 0, `${p.name} 被判定收成点却挂了照片`); }
      assert.ok(p.spread >= 0);
      if (p.shown === 0) { assert.equal(p.spread, 0); }
    }
  }
});

test('布局：同一输入两次调用逐字节相同（布局没有隐藏的随机/顺序依赖）', () => {
  const a = JSON.stringify(buildScene(denseScene(), FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER }));
  const b = JSON.stringify(buildScene(denseScene(), FRAME, 1, { canvasH: CANVAS_H, footer: FOOTER }));
  assert.equal(a, b);
});

test('布局：画布不比地图块高时，HangEnvelope 等于没给（退化成"地图块下面没有余量"）', () => {
  const base = buildScene(denseScene(), FRAME, 1);
  // 画布高 = 块高 / 比块还矮 → 都按"画布就是地图块"处理，结果必须逐字节相同
  const same = buildScene(denseScene(), FRAME, 1, { canvasH: FRAME.blockH });
  assert.equal(JSON.stringify(base), JSON.stringify(same));
  const lower = buildScene(denseScene(), FRAME, 1, { canvasH: 100 });
  assert.equal(JSON.stringify(base), JSON.stringify(lower));
});

test('布局：页脚把挂载区吃到地图框底 —— 照片只在框内展开，一张都不越线', () => {
  // "地图下面没有余量"在新几何里是这样表达的：页脚 = 块底 − 框底
  const env = { canvasH: CANVAS_H, footer: CANVAS_H - FRAME_BOTTOM };
  assert.equal(hangBottom(FRAME, env), FRAME_BOTTOM, '页脚没有把挂载区底压到框底');
  const pins = buildScene(denseScene(), FRAME, 1, env);
  const cards = sceneCards(pins, W, FRAME_BOTTOM);
  assert.ok(cards.length > 0, '框内一张都挂不出来 —— 这条测试失去判别力');
  for (const r of cards) {
    assert.ok(r.y + r.h <= FRAME_BOTTOM + 1e-6, `卡片越过了地图框底：${r.y + r.h} > ${FRAME_BOTTOM}`);
    assert.ok(r.y >= -1e-6, `卡片跑到画布上面去了：${r.y}`);
  }
  // 余量更少时挂出来的张数不可能更多
  const roomy = sceneCards(buildScene(denseScene(), FRAME, 1), W, BOTTOM);
  assert.ok(cards.length <= roomy.length, `框内挂了 ${cards.length} 张，比有余量时（${roomy.length}）还多`);
});

test('布局：画布越矮，挂出来的张数不会变多（挂载区底只会更紧）', () => {
  // 单向性：底边抬高只会让"放得下"更难，不会凭空多出一张。反过来（变大）不保证单调 ——
  // 一个钉子长高之后可能挡住后面的钉子，所以只钉这一侧。
  let prev = Number.POSITIVE_INFINITY;
  for (const envH of [FRAME_BOTTOM + 420, FRAME_BOTTOM + 300, FRAME_BOTTOM + 200, FRAME_BOTTOM + 120, FRAME_BOTTOM]) {
    const env = { canvasH: envH, footer: 0 };
    const pins = buildScene(denseScene(), FRAME, 1, env);
    const cards = sceneCards(pins, W, hangBottom(FRAME, env));
    assert.ok(cards.length <= prev, `挂载区底=${envH} 时挂了 ${cards.length} 张，比更宽松的画布还多`);
    assert.equal(countOverlapPairs(cards), 0, `挂载区底=${envH} 时出现重叠`);
    prev = cards.length;
  }
});

/** 二分出"相邻卡片刚开始不重叠"的最小弦宽（只用于核对 arcSpreadNeed 是紧的）。 */
function trueMinSpread(n: number): number {
  let lo = 1;                        // 1pt 的弦宽：所有卡片叠在一起，必定重叠
  let hi = arcSpreadNeed(n);         // arcSpreadNeed(n)：上一条测试已证不重叠
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const rs = hangRects(5000, 400, n, mid, 100000, 100000);
    if (countOverlapPairs(rs) === 0) { hi = mid; } else { lo = mid; }
  }
  return hi;
}

test('arcSpreadNeed：按它给的弦宽排出来的卡片**真的**不重叠（穷举全部对，不重抄公式）', () => {
  for (let n = 2; n <= 9; n++) {
    const s = arcSpreadNeed(n);
    // 画布给得足够大且钉子放在中间 → 不触发钳制，量的就是弧本身的几何
    const rects = hangRects(5000, 400, n, s, 100000, 100000);
    assert.equal(rects.length, n);
    assert.equal(countOverlapPairs(rects), 0, `n=${n}：按 arcSpreadNeed 排出来仍然有重叠`);
    // 而且它是**紧的**：真正的最小弦宽最多只比它小 2%（那 2% 就是 HANG_CARD_CLEARANCE 那条发丝缝）
    const min = trueMinSpread(n);
    assert.ok(min <= s + 1e-9, `n=${n}：最小弦宽 ${min} 竟然大于 arcSpreadNeed=${s}`);
    assert.ok(s - min <= s * 0.02, `n=${n}：arcSpreadNeed=${s} 比真正需要的 ${min} 浪费了超过 2%`);
  }
});

test('arcSpreadNeed：单调递增；360 宽的画布上 9 张放得下、10 张放不下（"一屏最多 9 张"的成因）', () => {
  assert.equal(arcSpreadNeed(0), 0);
  assert.equal(arcSpreadNeed(1), 0);
  let prev = 0;
  for (let n = 2; n <= 12; n++) {
    const s = arcSpreadNeed(n);
    assert.ok(s > prev, `n=${n} 需要的最小弦宽没有比 n-1 大`);
    prev = s;
  }
  // 26×34 的卡片：画布能给的最大弦宽是 0.80×360 = 288；
  // 9 张要 ≈ 269.7（放得下）、10 张要 ≈ 308（放不下）→ 一屏最多 9 张，正好是 MAX_HANG。
  assert.ok(arcSpreadNeed(9) <= arcSpread(9, W) + 1e-9, '9 张现在放不下了 —— "一屏最多几张"要重新算');
  assert.ok(arcSpreadNeed(10) > arcSpread(10, W), '10 张竟然放得下 —— 那 MAX_HANG 就不再是紧的');
  assert.ok(Math.abs(arcSpread(10, W) - W * 0.80) < 1e-9, 'arcSpread 的上限变了');
  assert.equal(MAX_HANG, 9, 'MAX_HANG 变了 —— 上面的"一屏最多 9 张"要跟着改');
  // 9 张需要的弦宽（把实测值钉在一个窄区间里：改常数会让它动，动出区间就该重新算"一屏几张"）
  assert.ok(arcSpreadNeed(9) > 260 && arcSpreadNeed(9) < 288, `arcSpreadNeed(9) 的实测值是 ${arcSpreadNeed(9)}`);
  // 注：34×44 的旧卡宽下同一个公式给出 353.7pt —— 远超 0.72×360 = 259.2（当时的安全上限），
  // 所以那时"一屏最多 7 张"。缩到 26×34 才腾出第 8、9 张的位置（数字见 task-14 报告）。
});

test('clampRect：钳制本身是有效的，并且如实报出"被挪动过"', () => {
  const r: CardRect = { x: -5, y: 700, w: HANG_PHOTO_W, h: HANG_PHOTO_H };
  const c = clampRect(r, W, 720);
  assert.equal(c.moved, true);
  assert.equal(c.rect.x, 0);
  assert.equal(c.rect.y, 720 - HANG_PHOTO_H);
  const inside = clampRect({ x: 10, y: 10, w: HANG_PHOTO_W, h: HANG_PHOTO_H }, W, 720);
  assert.equal(inside.moved, false);
  // 画布比卡片还小：钳到左上角，并且**必须**报 moved（否则会画出一张出画布的卡片）
  const tiny = clampRect({ x: 50, y: 50, w: HANG_PHOTO_W, h: HANG_PHOTO_H }, 10, 10);
  assert.equal(tiny.moved, true);
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


test('布局：为了躲开邻居而收窄的弧仍然是弧（不是被压平的竖线或横线）', () => {
  // 为什么要**收紧**画布才测这条：26 宽之后卡片小了一圈，360×720 的宽松画布上
  // 密集场景里没有一个钉子的弧需要收窄（实测 narrowed=0）—— 那样这条测试就没有判别力了。
  // footer=160 → 挂载区底 560：紧到必须"用形状换位置"，但还没紧到全部收成点。
  const env = { canvasH: CANVAS_H, footer: 160 };
  const bottom = hangBottom(FRAME, env);
  assert.equal(bottom, 560, `挂载区底不是预期的 560：${bottom}`);
  const pins = buildScene(denseScene(), FRAME, 1, env);
  const cards = sceneCards(pins, W, bottom);
  assert.equal(countOverlapPairs(cards), 0, '收窄之后反而重叠了');
  for (const r of cards) {
    assert.ok(r.x >= -1e-6 && r.x + r.w <= W + 1e-6, `卡片横向越界：${r.x}..${r.x + r.w}`);
    assert.ok(r.y + r.h <= bottom + 1e-6, `卡片越过挂载区底：${r.y + r.h}`);
  }
  let narrowed = 0;
  let checked = 0;
  for (const p of pins) {
    if (p.shown <= 1) { continue; }
    if (p.spread < arcSpread(p.shown, W) - 1e-9) { narrowed++; }
    const offs = hangOffsets(p.shown, p.spread);
    // 收窄之后依然必须是**弧**：dx 不是常数（不是竖线）、dy 中间最大（不是横线）、等半径
    assert.ok(Math.abs(offs[0].dx - offs[p.shown - 1].dx) > 1, `${p.name} 的弧被压成了竖线`);
    assert.ok(offs[0].dy > 0, `${p.name} 有卡片跑到钉子上面`);
    assert.ok(offs[0].dy < offs[(p.shown - 1) / 2 | 0].dy + 1e-9, `${p.name} 的弧被压平了`);
    const r0 = Math.sqrt(offs[0].dx * offs[0].dx + offs[0].dy * offs[0].dy);
    for (const o of offs) {
      assert.ok(Math.abs(Math.sqrt(o.dx * o.dx + o.dy * o.dy) - r0) < 1e-9, `${p.name} 的卡片不在同一个圆上`);
    }
    checked++;
  }
  assert.ok(checked >= 3, `只核对到 ${checked} 个展开的钉子`);
  assert.ok(narrowed > 0, '这个场景里居然没有一个钉子需要收窄 —— 那这条测试就没有判别力了');
});

