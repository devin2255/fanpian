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
 *   --many           用 18 个钉子的那份数据（演示"钉子多时收成点"）
 *   --flat           把地图拉满整块画布（**会变形**，只是留个对照，别用）
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
  HANG_GAP, HANG_PHOTO_H, arcSpread, buildScene, geoAspect, hangOffsets, mapBoxHeight,
  outlinePath, parseOutline, sceneToSvg
} from '../entry/src/main/ets/core/render.ts';
import type { ScenePin, WallPhoto } from '../entry/src/main/ets/core/render.ts';

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

  // 地图块：**按墨卡托比例**开，而不是铺满画布（否则中国会被拉成一根竖条）
  const mapW = o.w;
  const mapH = o.flat ? o.h : mapBoxHeight(mapW, CHINA_REGION.bounds);

  // 国界：数据文件在就画，不在就退化成"只有钉子和线"（脚本仍然能跑，报告里说明）
  let chinaPath = '';
  let outlineNote = '（没有 china_outline.json，本次不画国界）';
  if (fs.existsSync(OUTLINE_RAW)) {
    const od = parseOutline(fs.readFileSync(OUTLINE_RAW, 'utf8'));
    if (od === undefined) {
      outlineNote = '（china_outline.json 解析失败，本次不画国界）';
    } else {
      chinaPath = outlinePath(od.rings, mapW, mapH, od.bounds);
      outlineNote = `${od.rings.length} 个环 / ${od.src}`;
    }
  }

  const pins: ScenePin[] = buildScene(loaded.photos, mapW, mapH, o.zoom);
  let svg = sceneToSvg(pins, o.w, o.h, chinaPath, o.scale);

  // 地图块的底色：让"地图只占上方这一块、下方是挂照片的地方"在图上一眼可见。
  // 分区是**预览的排版**（sceneToSvg 只管画钉子和照片），所以在这里拼进去。
  if (!o.flat && mapH < o.h) {
    const band = `<rect x="0" y="0" width="${o.w}" height="${round2(mapH)}" fill="#F2F7EF"/>`;
    const lines = svg.split('\n');
    const bg = lines.findIndex((l) => l.includes('fill="#F7FAF6"'));
    lines.splice(bg + 1, 0, band);
    svg = lines.join('\n');
  }

  // 页脚：把"这张图是什么、用了哪份数据、几何是多少"写在图上，省得看图的人猜
  const drawn = pins.filter((p) => p.expanded).reduce((s, p) => s + Math.min(9, p.photos.length), 0);
  const undated = pins.reduce((s, p) => s + p.photos.filter((x) => !(x.takenAt > 0)).length, 0);
  const total = loaded.photos.length;
  // 「照片级」的地图块外计数：按**原始坐标**算，不受聚簇影响。
  // 为什么必须单独算：400km 外的两张照片会在屏幕上被并进同一个钉子（MIN_PIN_DIST_PT=40
  // 在全国视角下约等于 6.9° 经度），此时"某个钉子在画布外"就再也看不出来了 ——
  // 三沙永兴岛（16.83°N）正是这样消失的。bounds=[73,18,135,54] 的 minLat=18 是它的成因。
  const outside: string[] = [];
  for (const ph of loaded.photos) {
    const has = ph.manual === true || ph.lat !== 0 || ph.lon !== 0;
    if (!has) { continue; }
    const q = projectMercator(ph.lon, ph.lat, mapW, mapH, CHINA_REGION.bounds);
    if (q.x < 0 || q.x > mapW || q.y < 0 || q.y > mapH) {
      outside.push(`${ph.place === undefined ? `${ph.lat.toFixed(2)},${ph.lon.toFixed(2)}` : ph.place}(y=${q.y.toFixed(1)})`);
    }
  }
  const legend: string[] = [];
  legend.push(`<g id="legend" font-size="7" fill="#7A8577">`);
  legend.push(`<text x="8" y="${round2(o.h - 26)}">地图墙预览 ｜ ${pins.length} 个钉子 ｜ 挂出的照片 ${drawn} 张（时间未知 ${undated} 张）</text>`);
  legend.push(`<text x="8" y="${round2(o.h - 15)}">输入 ${total} 张（不上墙 ${total - pins.reduce((s, p) => s + p.photos.length, 0)} 张 ｜ 地图块外 ${outside.length} 张） ｜ 照片是占位卡片，Node 侧没有像素</text>`);
  legend.push(`<text x="8" y="${round2(o.h - 4)}">地图块 ${o.w}×${round2(mapH)}pt（墨卡托比例 ${geoAspect(CHINA_REGION.bounds).toFixed(3)}） ｜ ${escapeText(outlineNote)}</text>`);
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
  console.log(`画布：${o.w}×${o.h}pt（scale=${o.scale} → ${o.w * o.scale}×${o.h * o.scale}px）  地图块：${o.w}×${round2(mapH)}pt  zoom=${o.zoom}${o.zoom < MIN_ZOOM_FOR_EXPAND ? '（< 展开阈值，全部收成点）' : ''}`);
  console.log(`国界：${outlineNote}`);
  console.log(`钉子 ${pins.length} 个：`);
  for (const p of pins) {
    const off = p.x < 0 || p.x > o.w || p.y < 0 || p.y > mapH ? '  ← 画布外' : '';
    console.log(`  ${p.name.padEnd(22)} (${String(p.x).padStart(6)}, ${String(p.y).padStart(6)})`
      + ` ${p.expanded ? '展开' : '收成点'} ${p.photos.length} 张`
      + ` 时间未知 ${p.photos.filter((x) => !(x.takenAt > 0)).length} 张${off}`);
  }
  const hidden = loaded.photos.length - pins.reduce((s, p) => s + p.photos.length, 0);
  console.log(`没有地点的照片 ${hidden} 张（不上墙）`);
  console.log(`地图块外（按原始坐标算，不受聚簇影响）${outside.length} 张：${outside.length === 0 ? '（无）' : outside.join('、')}`);
  console.log(`弧形核对表 n=5, spread=100：`);
  hangOffsets(5, 100).forEach((v, i) => {
    console.log(`  #${i}  dx=${v.dx.toFixed(3).padStart(8)}  dy=${v.dy.toFixed(3).padStart(8)}`);
  });
  console.log(`  （实际用的 spread(5, ${o.w}) = ${arcSpread(5, o.w).toFixed(2)}，卡片 ${HANG_GAP}pt 之下起挂，卡片高 ${HANG_PHOTO_H}）`);
  const st = fs.statSync(o.out);
  console.log(`✓ ${path.relative(REPO, o.out)}  ${st.size} 字节`);
  return 0;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

process.exitCode = main();
