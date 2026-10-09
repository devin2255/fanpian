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
  HANG_GAP, HANG_PHOTO_H, HANG_PHOTO_W, HANG_OVERLAP_EPS, HANG_SWEEP_RAD,
  arcSpread, arcSpreadNeed, buildScene, clampRect, dateLabel, geoAspect, hangOffsets, hangRects,
  mapBoxHeight, outlinePath, parseOutline, rectOverlapArea, sceneToSvg
} from './render.ts';
import type { CardRect, ScenePin, WallPhoto } from './render.ts';

const DATA_URL = new URL('../../resources/rawfile/china_areas.json', import.meta.url);
parseAreaData(fs.readFileSync(DATA_URL, 'utf8'));

const W = 360;
const H = 720;

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
    assert.ok(s <= W * 0.72 + 1e-9, `n=${n} 的弦宽超出了画布的安全区`);
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
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 1);
  assert.equal(pins[0].photos[0].photoId, 'b');
});

test('buildScene：manual 的地点即使坐标是 (0,0) 也算有地点（hasPlace 优先手动）', () => {
  const p: WallPhoto = { photoId: 'm', lat: 0, lon: 0, takenAt: 1700000000000, manual: true, place: '河北·石家庄·正定' };
  const pins = buildScene([p], W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, '河北·石家庄·正定');
});

test('buildScene：有 place 就直接用，不走反查（EXIF 坐标也不会盖掉手选名）', () => {
  // 坐标是上海人民广场，但用户说这张挂在正定 —— 以用户为准
  const p = ph('x', 31.2304, 121.4737, 1700000000000, '河北·石家庄·正定');
  const pins = buildScene([p], W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, '河北·石家庄·正定');
});

test('buildScene：没有 place 的 EXIF 条目用 nearestCounty 反查真实地名', () => {
  // 上海人民广场 31.2304,121.4737 → 应当是「上海·黄浦」一带（真实数据断言，见文件头）
  const pins = buildScene([ph('s', 31.2304, 121.4737, 1700000000000)], W, H, 1);
  assert.equal(pins.length, 1);
  assert.ok(pins[0].name.indexOf('上海') === 0, `反查到的地名不是上海：${pins[0].name}`);
});

test('buildScene：同一地名的多张照片归到一个钉子下', () => {
  const photos = [
    ph('a', 31.2304, 121.4737, 1700000000000),
    ph('b', 31.2310, 121.4740, 1700000100000),
    ph('c', 31.2290, 121.4730, 1700000200000)
  ];
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 3);
});

test('buildScene：重复传入同一张照片不会长出两个钉子', () => {
  const one = ph('dup', 31.2304, 121.4737, 1700000000000);
  const pins = buildScene([one, one], W, H, 1);
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
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  const lat = 38.0428;   // 三个值的中位数
  const lon = 114.5149;
  const exp = projectMercator(lon, lat, W, H, CHINA_REGION.bounds);
  assert.ok(Math.abs(pins[0].x - exp.x) < 0.01, `x 不是中位数投影：${pins[0].x} vs ${exp.x}`);
  assert.ok(Math.abs(pins[0].y - exp.y) < 0.01, `y 不是中位数投影：${pins[0].y} vs ${exp.y}`);
});

// ── buildScene：takenAt == 0 的照片（必须仍然在墙上） ────────────────────────

test('buildScene：takenAt=0 的照片仍然上墙，且排在组内最后', () => {
  const photos = [
    ph('nodate', 31.2304, 121.4737, 0),
    ph('late', 31.2304, 121.4737, 1700000200000),
    ph('early', 31.2304, 121.4737, 1700000000000)
  ];
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].photos.length, 3, '没有时间的照片被丢掉了');
  const ids = pins[0].photos.map((p: WallPhoto) => p.photoId);
  assert.deepEqual(ids, ['early', 'late', 'nodate']);
});

test('buildScene：全是 takenAt=0 时按 photoId 排序（可复现，与输入顺序无关）', () => {
  const a = ph('b', 31.2304, 121.4737, 0);
  const b = ph('a', 31.2304, 121.4737, 0);
  const forward = buildScene([a, b], W, H, 1)[0].photos.map((p: WallPhoto) => p.photoId);
  const backward = buildScene([b, a], W, H, 1)[0].photos.map((p: WallPhoto) => p.photoId);
  assert.deepEqual(forward, ['a', 'b']);
  assert.deepEqual(backward, ['a', 'b']);
});

// ── buildScene：展开态（阈值来自 placement.ts） ──────────────────────────────

test('buildScene：钉子 ≤3 时全部展开（每钉最多 9 张）', () => {
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304 + i * 0.001, 121.4737, 1700000000000 + i)); }
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].expanded, true);
  assert.equal(pins[0].photos.length, 12, 'ScenePin.photos 是全部照片，不受 MAX_HANG 截断');
  assert.ok(MAX_HANG === 9);
});

test('buildScene：zoom 小于阈值时全部按钉渲染（不展开）', () => {
  const photos = [ph('a', 31.2304, 121.4737, 1700000000000), ph('b', 31.2305, 121.4738, 1700000000001)];
  assert.equal(buildScene(photos, W, H, 0.2)[0].expanded, false);
  assert.equal(buildScene(photos, W, H, 1)[0].expanded, true);
});

test('buildScene：zoom 为 NaN / 0 / 负数时按 1 处理（不静默走进"错误展开"）', () => {
  const photos = [ph('a', 31.2304, 121.4737, 1700000000000), ph('b', 31.2305, 121.4738, 1700000000001)];
  for (const z of [Number.NaN, 0, -1]) {
    assert.equal(buildScene(photos, W, H, z)[0].expanded, true, `zoom=${z} 的处理与 zoom=1 不一致`);
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
  const pins = buildScene(photos, W, H, 1);
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
  const pins = buildScene(photos, W, H, 1);
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
  const pins = buildScene(photos, W, H, 1);
  assert.equal(pins.length, 1);
  const hk = projectMercator(114.1694, 22.3193, W, H, CHINA_REGION.bounds);
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
  const pins = buildScene(photos, W, H, 1);
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
  const one = JSON.stringify(buildScene(photos, W, H, 1));
  const two = JSON.stringify(buildScene([photos[3], photos[1], photos[2], photos[0]], W, H, 1));
  assert.equal(one, two);
});

test('buildScene：空输入 / 全无坐标 → 空场景（调用方据此显示空态）', () => {
  assert.deepEqual(buildScene([], W, H, 1), []);
  assert.deepEqual(buildScene([ph('a', 0, 0, 0)], W, H, 1), []);
});

test('buildScene：境外坐标不丢，得到一个坐标标签的钉子（M2 的世界地图才处理它）', () => {
  // 东京 35.6762,139.6503 → nearestCounty 判为境外（>800km）
  const pins = buildScene([ph('tokyo', 35.6762, 139.6503, 1700000000000)], W, H, 1);
  assert.equal(pins.length, 1);
  assert.ok(pins[0].name.indexOf('°N') > 0, `境外的钉子应带坐标标签：${pins[0].name}`);
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
  const d = outlinePath(o.rings, W, H, o.bounds);
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
  const d = outlinePath(rings, W, H, CHINA_REGION.bounds);
  assert.equal(d.split('M').length - 1, 2);
  assert.equal(outlinePath([], W, H, CHINA_REGION.bounds), '');
});

test('outlinePath：越界的 bounds 参数退回 CHINA_REGION.bounds（不产出 NaN）', () => {
  const d = outlinePath([[100, 30, 101, 30, 101, 29]], W, H, [1, 2, 3]);
  assert.ok(d.length > 0);
  assert.ok(!d.includes('NaN'));
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
  return buildScene(photos, W, H, 1);
}

test('sceneToSvg：产出结构完整的 SVG（含国界 path、钉子组、每个钉子的照片数）', () => {
  const pins = demoPins();
  const d = outlinePath(parseOutline(GOOD_OUTLINE)!.rings, W, H, CHINA_REGION.bounds);
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
  const svg = sceneToSvg(buildScene([p], W, H, 1), W, H, '');
  assert.ok(svg.includes('A&amp;B &lt;大厦&gt; &quot;x&quot;'));
  assert.ok(!svg.includes('<大厦>'));
});

test('sceneToSvg：没有国界数据时也能画（chinaPath 传空串）', () => {
  const svg = sceneToSvg(demoPins(), W, H, '');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(!svg.includes('<path d='));
  assert.ok(svg.includes('<g id="pins">'));
});

test('sceneToSvg：没有照片（空数组）也要产出合法 SVG —— 空态由图外的 UI 负责', () => {
  const svg = sceneToSvg([], W, H, '');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(svg.split('<g id="pin-').length - 1, 0);
});

test('sceneToSvg：挂出的张数由空间决定（MAX_HANG 只是上限），其余如实画成 +N', () => {
  // 12 张挂在同一个钉子上。老规则"超过 MAX_HANG 就画 MAX_HANG 张"在这块画布上从来没成立过：
  // 9 张需要的弦宽是 arcSpreadNeed(9) ≈ 353.7pt > 0.72×360 = 259.2pt —— **放不下**，
  // 硬画 9 张必然让两侧卡片互相压住（旧实现实测每钉 4 对重叠）。
  // 现在：挂几张由空间决定，MAX_HANG 只是上限；没挂出来的由「+N」如实报出。
  const photos: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { photos.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const pins = buildScene(photos, W, H, 1);
  const shown = pins[0].shown;
  assert.ok(shown > 0 && shown <= MAX_HANG, `挂出 ${shown} 张，超出了 [1, MAX_HANG]`);
  const svg = sceneToSvg(pins, W, H, '');
  assert.equal(svg.split('rx="2" fill="#').length - 1, shown);
  assert.ok(svg.includes(`>+${12 - shown}<`), '缺少 +N 角标');
  // 画布给到 720 宽时 9 张放得下 → MAX_HANG 这道上限确实生效
  const wide: WallPhoto[] = [];
  for (let i = 0; i < 12; i++) { wide.push(ph(`p${i}`, 31.2304, 104.0, 1700000000000 + i)); }
  const widePins = buildScene(wide, 720, 800, 1, { canvasH: 4000 });
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
  const pins = buildScene(photos, W, H, 1);
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
  const re = /<rect x="[-\d.]+" y="([\d.]+)" width="34" height="44" rx="2"/g;
  let m = re.exec(svg);
  let n = 0;
  while (m !== null) {
    const y = parseFloat(m[1]);
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

/** 真机尺寸：360×720 的 vp 画布，底部留 34pt 给图例。 */
const CANVAS_H = 720;
const FOOTER = 34;
const BOTTOM = CANVAS_H - FOOTER;
/** 地图块高（不变形的那个值）—— 钉子的投影范围。 */
const MAP_H = mapBoxHeight(W, CHINA_REGION.bounds);

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
  const pins = buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
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
  const pins = buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
  const cards = sceneCards(pins, W, BOTTOM);
  assert.equal(countOverlapPairs(cards), 0, `有 ${countOverlapPairs(cards)} 对卡片压在了一起`);
  assert.equal(HANG_OVERLAP_EPS, 1, '重叠判据变了 —— tools/wall-audit.ts 直接 import 它，要一起改');
});

test('布局：钳制只是兜底 —— 画出来的每张卡片都**没有**被挪动过，且弧的形状仍然成立', () => {
  const pins = buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
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
  // 经度 74.0 → 投影 x≈5.8pt，小于半张卡（17）+ 留白（4）= 21pt。喀什（75.99°E）在真机上正是这一类。
  const photos = [ph('k1', 39.47, 74.0, 1), ph('k2', 39.471, 74.001, 2), ph('k3', 39.469, 73.999, 3)];
  const pins = buildScene(photos, W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
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
  const pins = buildScene(photos, W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
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
    const pins = buildScene(photos, W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
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
  const a = JSON.stringify(buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER }));
  const b = JSON.stringify(buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER }));
  assert.equal(a, b);
});

test('布局：画布不比地图块高时，HangEnvelope 等于没给（退化成"地图下面没有余量"）', () => {
  const base = buildScene(denseScene(), W, MAP_H, 1);
  const lower = buildScene(denseScene(), W, MAP_H, 1, { canvasH: 100 });
  assert.equal(JSON.stringify(base), JSON.stringify(lower));
  // 页脚把挂载区吃到与地图块齐平 → 同样退化（不是"没有约束"，是"没有余量"）
  const noRoom = buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: CANVAS_H - MAP_H });
  assert.equal(JSON.stringify(base), JSON.stringify(noRoom));
  // 退化时也**不许**出画布（画布就是地图块）
  const cards = sceneCards(base, W, MAP_H);
  for (const r of cards) { assert.ok(r.y + r.h <= MAP_H + 1e-6, `退化时卡片越过了地图块底：${r.y + r.h}`); }
});

test('布局：画布越矮，挂出来的张数不会变多（挂载区底只会更紧）', () => {
  // 单向性：底边抬高只会让"放得下"更难，不会凭空多出一张。反过来（变大）不保证单调 ——
  // 一个钉子长高之后可能挡住后面的钉子，所以只钉这一侧。
  let prev = Number.POSITIVE_INFINITY;
  for (const bottom of [MAP_H + 420, MAP_H + 300, MAP_H + 200, MAP_H + 120, MAP_H]) {
    const pins = buildScene(denseScene(), W, MAP_H, 1, { canvasH: bottom, footer: 0 });
    const cards = sceneCards(pins, W, BOTTOM);
    assert.ok(cards.length <= prev, `挂载区底=${bottom} 时挂了 ${cards.length} 张，比更宽松的画布还多`);
    assert.equal(countOverlapPairs(cards), 0, `挂载区底=${bottom} 时出现重叠`);
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

test('arcSpreadNeed：单调递增；360 宽的画布上 8、9 张放不下（这就是"一屏最多 7 张"的成因）', () => {
  assert.equal(arcSpreadNeed(0), 0);
  assert.equal(arcSpreadNeed(1), 0);
  let prev = 0;
  for (let n = 2; n <= 12; n++) {
    const s = arcSpreadNeed(n);
    assert.ok(s > prev, `n=${n} 需要的最小弦宽没有比 n-1 大`);
    prev = s;
  }
  // 画布能给的最大弦宽是 0.72×360 = 259.2；7 张要 254.6（放得下），8 张要 303.9（放不下）
  assert.ok(arcSpreadNeed(7) <= arcSpread(7, W));
  assert.ok(arcSpreadNeed(8) > arcSpread(8, W));
  assert.ok(arcSpreadNeed(9) > arcSpread(9, W));
  assert.ok(Math.abs(arcSpread(8, W) - W * 0.72) < 1e-9, 'arcSpread 的上限变了');
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

test('布局：为了躲开邻居而收窄的弧仍然是弧（不是被压平的竖线或横线）', () => {
  const pins = buildScene(denseScene(), W, MAP_H, 1, { canvasH: CANVAS_H, footer: FOOTER });
  let narrowed = 0;
  for (const p of pins) {
    if (p.shown <= 1) { continue; }
    if (p.spread < arcSpread(p.shown, W) - 1e-9) { narrowed++; }
    const offs = hangOffsets(p.shown, p.spread);
    assert.ok(Math.abs(offs[0].dx - offs[p.shown - 1].dx) > 1, `${p.name} 的弧被压成了竖线`);
    assert.ok(offs[0].dy > 0 && offs[0].dy < offs[(p.shown - 1) / 2 | 0].dy + 1e-9, `${p.name} 的弧被压平了`);
  }
  assert.ok(narrowed > 0, '这个场景里居然没有一个钉子需要收窄 —— 那这条测试就没有判别力了');
});

