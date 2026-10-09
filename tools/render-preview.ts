/**
 * 地图墙预览：把「照片挂在中国地图上」画成一张 SVG，好让人**先看见**再装到手机上。
 *
 * 用法（一个脚本必须能重现，默认值就是产出报告里那张图的那一组）：
 *
 *   node --experimental-strip-types tools/render-preview.ts
 *   node --experimental-strip-types tools/render-preview.ts --many
 *   node --experimental-strip-types tools/render-preview.ts <数据.json> [输出.svg]
 *
 *   node --experimental-strip-types tools/render-preview.ts \
 *        --data locations.json --decisions decisions.json --out tools/out/wall-preview.svg
 *
 * 参数：
 *   （位置参数）      数据文件；给了它就不用 --data
 *   --data=PATH      照片数据。两种形状都吃：
 *                      · `locations.json`（data/locationIndex 落盘的那个数组）——**设备导出的真数据**
 *                      · `{ "photos": [...] }`（手写的代表性数据，本仓库 tools/fixtures 下那两份）
 *   --decisions=PATH `decisions.json`（data/decisionStore 落盘的那个数组）；
 *                    给了它就只画 `state === "walled"` 的照片 —— 与设备上的墙一致。
 *   --out=PATH       输出 SVG（默认 tools/out/wall-preview.svg）
 *   --w=--h=         画布尺寸（pt，默认 360×720 —— 一台常见鸿蒙手机的 vp 尺寸）
 *   --zoom=          地图缩放（默认 1）。小于 placement.MIN_ZOOM_FOR_EXPAND 时全部收成点。
 *   --scale=         SVG 的像素放大倍数（默认 2；**只改 width/height，几何一点不变**）
 *   --footer=        底部图例条的高度（pt，默认 34）。卡片不许压到图例上 —— 这是**分区**的一部分。
 *   --many           用 18 个钉子的那份数据（演示"钉子多时收成点"）
 *   --flat           把地图框拉满整块画布（**会变形**，只是留个对照，别用）
 *
 * ── 画布分区是怎么定的（"地图铺满主体区"，与设备侧共用 core/render.mapFrame）────
 *   · **地图块** = 整块画布 `--w × --h`：地图是它的底色，照片浮在它上面。
 *     （老版本这里是"地图只占上方 37% 的一条"，`mapH = mapBoxHeight(宽)`。）
 *   · **地图框** = 地图块里那个**不变形**的矩形（`MapFrame`）：先按"填满高度"算宽度，
 *     宽度放不下就改成"填满宽度"，然后**居中**。360×720 时框是 360×267.72，居中在 y=226.14。
 *     为什么手机上是"填满宽度"而不是"填满高度"，见 `core/render.MapFrame` 的长注释
 *     （填满高度会把北京/上海/广州裁出画面）。
 *   · **挂载区** = `[地图框底, 画布高 − footer]`，即地图框之外剩下的部分全给照片。
 *     它是**剩余量**，不是常数：换一块画布（--w/--h/--footer）它自己跟着变。
 *   · 布局只在这个分区内做取舍：放不下就少挂几张、再不行就收成点（见 core/render.ts 的 planPin）。
 *
 * 输出断言（脚本自己会检查，不符合就非零退出）：
 *   · 文件写出且非空；· 没有 NaN/Infinity 坐标；· 有 <svg> 根元素。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAreaData } from '../entry/src/main/ets/core/areaData.ts';
import { CHINA_REGION, projectMercator } from '../entry/src/main/ets/core/projection.ts';
import { MIN_ZOOM_FOR_EXPAND } from '../entry/src/main/ets/core/placement.ts';
import {
  BLOCK_FILL, HANG_GAP, HANG_PHOTO_H, HANG_PHOTO_W, arcSpread, arcSpreadNeed, buildScene, geoAspect,
  hangBottom, hangOffsets, mapFrame, outlinePath, parseOutline, sceneToSvg, trajectoryOrder
} from '../entry/src/main/ets/core/render.ts';
import type { MapFrame, ScenePin, WallPhoto } from '../entry/src/main/ets/core/render.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const AREA_RAW = path.join(REPO, 'entry/src/main/resources/rawfile/china_areas.json');
const OUTLINE_RAW = path.join(REPO, 'entry/src/main/resources/rawfile/china_outline.json');

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
  flat: boolean;
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
    flat: false
  };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--many') {
      o.data = path.join(HERE, 'fixtures/wall-sample-many.json');
      o.out = path.join(HERE, 'out/wall-preview-many.svg');
      continue;
    }
    if (a === '--flat') { o.flat = true; continue; }
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

  // 地图块 = 整块画布（地图是主体区的底色）；地图框 = 块里那个**不变形**的矩形（居中）。
  // `--flat` 是刻意的**反例**：框 = 块（把中国拉满整块画布 → 变形）。
  const block: MapFrame = mapFrame(o.w, o.h, CHINA_REGION.bounds);
  const frame: MapFrame = o.flat
    ? { blockW: o.w, blockH: o.h, x: 0, y: 0, w: o.w, h: o.h }
    : block;

  // 国界：数据文件在就画，不在就退化成"只有钉子和线"（脚本仍然能跑，报告里说明）
  let chinaPath = '';
  let outlineNote = '（没有 china_outline.json，本次不画国界）';
  if (fs.existsSync(OUTLINE_RAW)) {
    const od = parseOutline(fs.readFileSync(OUTLINE_RAW, 'utf8'));
    if (od === undefined) {
      outlineNote = '（china_outline.json 解析失败，本次不画国界）';
    } else {
      chinaPath = outlinePath(od.rings, frame, od.bounds);
      outlineNote = `${od.rings.length} 个环 / ${od.src}`;
    }
  }

  const pins: ScenePin[] = buildScene(loaded.photos, frame, o.zoom, { canvasH: o.h, footer: o.footer });
  let svg = sceneToSvg(pins, o.w, o.h, chinaPath, o.scale);

  // 分区：地图框 / 挂载区。挂载区底 = h − footer（图例的地盘不许被卡片压住）。
  const hangBottomPt = hangBottom(frame, { canvasH: o.h, footer: o.footer });
  const frameBottom = frame.y + frame.h;
  const hangTop = frameBottom;

  // 地图框的**标注**：一条虚线框，让"框在主体区里的位置与大小"在图上一眼可见。
  // 它**不是地图的一部分**（`sceneToSvg` 不画它，设备侧也不画）—— 这是预览的排版标注，
  // 和下面那三行图例是同一类东西。所以底色只有一种（`BLOCK_FILL`，与设备一致），
  // "地图块 / 地图框"的区分靠这条虚线与图例里的数字，而不是靠两层颜色。
  if (!o.flat) {
    const mark = `<rect x="${round2(frame.x)}" y="${round2(frame.y)}" width="${round2(frame.w)}" `
      + `height="${round2(frame.h)}" fill="none" stroke="#9FBE97" stroke-width="0.6" `
      + `stroke-dasharray="5 4" opacity="0.85"/>`;
    const lines = svg.split('\n');
    const bg = lines.findIndex((l) => l.includes(`fill="${BLOCK_FILL}"`));
    lines.splice(bg + 1, 0, mark);
    svg = lines.join('\n');
  }

  // 页脚：把"这张图是什么、用了哪份数据、几何是多少"写在图上，省得看图的人猜
  const drawn = pins.reduce((s, p) => s + p.shown, 0);
  const undated = pins.reduce((s, p) => s + p.photos.filter((x) => !(x.takenAt > 0)).length, 0);
  const onWall = pins.reduce((s, p) => s + p.photos.length, 0);
  const total = loaded.photos.length;
  // 「照片级」的地图块外计数：按**原始坐标**算，不受聚簇影响。
  // 为什么必须单独算：400km 外的两张照片会在屏幕上被并进同一个钉子（MIN_PIN_DIST_PT=40
  // 在全国视角下约等于 6.9° 经度），此时"某个钉子在画布外"就再也看不出来了 ——
  // 三沙永兴岛（16.83°N）正是这样消失的。bounds=[73,18,135,54] 的 minLat=18 是它的成因。
  const outside: string[] = [];
  for (const ph of loaded.photos) {
    const has = ph.manual === true || ph.lat !== 0 || ph.lon !== 0;
    if (!has) { continue; }
    const q = projectMercator(ph.lon, ph.lat, frame.w, frame.h, CHINA_REGION.bounds);
    if (q.x < 0 || q.x > frame.w || q.y < 0 || q.y > frame.h) {
      outside.push(`${ph.place === undefined ? `${ph.lat.toFixed(2)},${ph.lon.toFixed(2)}` : ph.place}(y=${q.y.toFixed(1)})`);
    }
  }
  const track = trajectoryOrder(pins);
  const legend: string[] = [];
  legend.push(`<g id="legend" font-size="7" fill="#7A8577">`);
  legend.push(`<text x="8" y="${round2(o.h - 26)}">地图墙预览 ｜ ${pins.length} 个钉子 ｜ 轨迹 ${track.length} 点（按拍摄时间连线） ｜ 挂出 ${drawn} 张 / 上墙 ${onWall} 张（图例 ${o.footer}pt ｜ 时间未知 ${undated} 张）</text>`);
  legend.push(`<text x="8" y="${round2(o.h - 15)}">输入 ${total} 张（无地点不上墙 ${total - onWall} 张 ｜ 地图框外 ${outside.length} 张） ｜ 卡片 ${HANG_PHOTO_W}×${HANG_PHOTO_H}pt ｜ 照片是占位卡片，Node 侧没有像素</text>`);
  legend.push(`<text x="8" y="${round2(o.h - 4)}">地图块 0→${round2(o.h)}pt（底色） ｜ 地图框 ${round2(frame.w)}×${round2(frame.h)}pt@(${round2(frame.x)},${round2(frame.y)})（墨卡托 ${geoAspect(CHINA_REGION.bounds).toFixed(3)}） ｜ 挂载区 ${round2(hangTop)}→${round2(hangBottomPt)}pt ｜ ${escapeText(outlineNote)}</text>`);
  legend.push(`</g>`);
  svg = svg.replace('</svg>', legend.join('\n') + '\n</svg>');

  // 输出前的自检：SVG 里不许出现 NaN/Infinity（那会让整条 path 静默消失）
  if (svg.includes('NaN') || svg.includes('Infinity')) {
    console.error('✗ 产出的 SVG 里有 NaN/Infinity —— 拒绝写盘');
    return 1;
  }

  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, svg, 'utf8');

  // ── 控制台摘要（报告里的数字都来自这里） ──────────────────────────────────
  console.log(`数据：${loaded.source}`);
  console.log(`  读入 ${loaded.photos.length} 条${loaded.dropped > 0 ? `（丢弃 ${loaded.dropped} 条非法记录）` : ''}`);
  console.log(`画布：${o.w}×${o.h}pt（scale=${o.scale} → ${o.w * o.scale}×${o.h * o.scale}px）`);
  console.log(`分区：地图块 0→${round2(o.h)}pt（${round2(100)}%，地图是整块主体区的底色）`);
  console.log(`      地图框 ${round2(frame.w)}×${round2(frame.h)}pt 左上角 (${round2(frame.x)}, ${round2(frame.y)})`
    + ` —— 框宽高比 = 墨卡托 ${geoAspect(CHINA_REGION.bounds).toFixed(4)}（**不变形**）`);
  console.log(`        先按"填满高度"算宽 = ${round2(o.h)}×${geoAspect(CHINA_REGION.bounds).toFixed(4)} = ${round2(o.h * geoAspect(CHINA_REGION.bounds))}pt`
    + ` ${o.h * geoAspect(CHINA_REGION.bounds) > o.w ? `> 画布宽 ${o.w} → 改成"填满宽度"（否则会裁掉北京/上海/广州）` : '≤ 画布宽 → 填满高度成立'}`);
  console.log(`      挂载区 ${round2(hangTop)}→${round2(hangBottomPt)}pt（${round2(hangBottomPt - hangTop)}pt，${round2(((hangBottomPt - hangTop) / o.h) * 100)}%） ｜ 图例 ${o.footer}pt  zoom=${o.zoom}${o.zoom < MIN_ZOOM_FOR_EXPAND ? '（< 展开阈值，全部收成点）' : ''}`);
  console.log(`国界：${outlineNote}`);
  console.log(`卡片：${HANG_PHOTO_W}×${HANG_PHOTO_H}pt（挂线留白 ${HANG_GAP}pt）`);
  console.log(`轨迹：${track.length} 个钉子按拍摄时间连线${track.length < 2 ? '（少于 2 个钉子，不成线）' : ''}`);
  console.log(`钉子 ${pins.length} 个（轨迹序 = 时间正序，时间未知的排最后）：`);
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    const off = p.x < 0 || p.x > o.w || p.y < 0 || p.y > o.h ? '  ← 画布外' : '';
    const tail = p.shown > 0 && p.shown < p.photos.length ? `（还有 ${p.photos.length - p.shown} 张画成 +N）` : '';
    console.log(`  #${String(i).padStart(2)} ${p.name.padEnd(22)} (${String(p.x).padStart(6)}, ${String(p.y).padStart(6)})`
      + ` ${p.shown > 0 ? '展开' : '收成点'} ${String(p.shown).padStart(2)}/${String(p.photos.length).padStart(2)} 张`
      + ` 弦宽 ${p.spread.toFixed(2).padStart(6)}`
      + ` 时间未知 ${p.photos.filter((x) => !(x.takenAt > 0)).length} 张${tail}${off}`);
  }
  const hidden = loaded.photos.length - onWall;
  console.log(`没有地点的照片 ${hidden} 张（不上墙）`);
  console.log(`挂出 ${drawn} 张 / 上墙 ${onWall} 张（少挂的 ${onWall - drawn} 张画成「+N」，点开钉子仍能看到）`);
  console.log(`地图框外（按原始坐标算，不受聚簇影响）${outside.length} 张：${outside.length === 0 ? '（无）' : outside.join('、')}`);
  console.log(`弧形核对表 n=5, spread=100：`);
  hangOffsets(5, 100).forEach((v, i) => {
    console.log(`  #${i}  dx=${v.dx.toFixed(3).padStart(8)}  dy=${v.dy.toFixed(3).padStart(8)}`);
  });
  console.log(`  （实际用的 spread(5, ${o.w}) = ${arcSpread(5, o.w).toFixed(2)}；${arcSpreadNeed(5).toFixed(2)} 是"相邻卡片不压住"的下限）`);
  // 「一屏最多挂几张」：这是**几何事实**，不是配置 —— 空间上限与 MAX_HANG 的较小者
  let maxPerPin = 0;
  for (let n = 1; n <= 24; n++) {
    if (arcSpreadNeed(n) <= arcSpread(n, o.w) + 1e-9) { maxPerPin = n; } else { break; }
  }
  console.log(`一屏（每个钉子）最多挂 ${maxPerPin} 张 = min(空间上限 ${maxPerPin}, 设计硬上限 MAX_HANG)`);
  const st = fs.statSync(o.out);
  console.log(`✓ ${path.relative(REPO, o.out)}  ${st.size} 字节`);
  return 0;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

process.exitCode = main();
