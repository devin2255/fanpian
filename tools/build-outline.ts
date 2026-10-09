/**
 * 从 Natural Earth 的 Admin 0（国家）数据里抽出**中国轮廓**，简化后产出
 * `entry/src/main/resources/rawfile/china_outline.json`。
 *
 * 用法：
 *   node --experimental-strip-types tools/build-outline.ts                 # 默认 10m / 容差 0.15pt（= 入库口径）
 *   node --experimental-strip-types tools/build-outline.ts --src=50m       # 换数据源：环数会变，要配 --expect-rings
 *   node --experimental-strip-types tools/build-outline.ts --tol=0.5 --report
 *   node --experimental-strip-types tools/build-outline.ts --compare        # 两份源 × 若干容差 的对照表
 *   node --experimental-strip-types tools/build-outline.ts --expect-rings=N # 显式承认"数据源换了、环数变了"
 *
 * ── 选哪些要素（**规则由数据自己的字段决定，不是我挑的**） ──────────────────────
 *   · `properties.SOVEREIGNT === 'China'`  → 中国本土 + 香港 + 澳门
 *     （Natural Earth 把两个特别行政区单列成要素，但 sovereignty 字段写的是 China）
 *   · `properties.ADMIN === 'Taiwan'`      → 台湾（数据源把它单列为 Taiwan；
 *     控制器明确要求"含台湾"，所以**显式**加进来并在此说明，不做隐式处理）
 *   · `ADMIN` 含 'Spratly' / 'Paracel'     → 南海诸岛（"数据里有就保留"）
 * 每个环（外环 + 内环）都保留，**不按面积删任何要素**；只有"简化后点太少、画不出一个面"
 * 的环才会被丢掉，丢了几条会在报告里数出来。
 *
 * ── 怎么简化 ────────────────────────────────────────────────────────────────
 *   Douglas–Peucker，**在投影后的画布空间里**做（不是经纬度空间）。
 *   为什么：经纬度空间里"1° 经度"和"1° 纬度"的屏幕长度差 1/cos(lat) 倍（墨卡托），
 *   同一个经纬度容差在南方和北方代表的像素误差能差一倍；而画地图时唯一重要的是
 *   **屏幕上的偏差**。容差默认 0.15pt = 360pt 宽的中国地图上 1 倍图的 0.15px（约 1/7 像素），
 *   所以简化后的轮廓与原数据**在屏幕上看不出差别**，点数却掉到源数据的 19.4%。
 *
 *   ── **为什么默认必须是 0.15：默认值就是入库口径**（这条踩过坑，别改大） ─────────
 *   0.15 是入库数据使用的容差（见 `china_outline.json` 的 `v` 字段 `ne10m-dp0.15-2dec`
 *   —— 那个字段就是"这份数据是用哪个容差产出来的"的机器可读记录）。
 *   改成更大会静默降精度（2959→2131 点、37637→27367 字节）而所有自检仍然通过 ——
 *   那正是这个默认值必须与入库口径一致的原因：下一个人照着 usage 敲一条默认命令，
 *   就会在**没有任何提示**的情况下把入库轮廓的精度降掉 28%（自检只问"能不能解析、
 *   bounds 是否一致、有没有 NaN"，这些在降精度后照样通过）。
 *   注意容差是**保真度**参数、不是**完整性**参数：0.15 和 0.35 产出的环数都是 96，
 *   改它不会丢任何地理要素（见 main() 里"数据环数"那一条自检）。
 *
 * ── 坐标系/边界（**最容易搞错、也最容易让地图和钉子错位的地方**） ─────────────
 *   输出的 `bounds` 必须与 `core/projection.ts` 的 `CHINA_REGION.bounds` **完全一致**：
 *   钉子用 `CHINA_REGION.bounds` 投影、轮廓用文件里的 `bounds` 投影，两者一旦不同，
 *   国界和照片就会各画各的（而且都不会报错）。本脚本直接 import 那个常量，不另写字面量；
 *   `render.test.ts` 里也有一条断言钉住"文件里的 bounds == CHINA_REGION.bounds"。
 *   代价：`bounds` 的 minLat = 18，南海诸岛（8~11°N）投影后落在**地图块下方**（y > mapH）。
 *   数据保留它们（按要求），绘制时由**显示方裁剪到地图块**，见预览与 WallPage 的说明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHINA_REGION, projectMercator } from '../entry/src/main/ets/core/projection.ts';
import { mapBoxHeight, mapFrame, parseOutline, outlinePath } from '../entry/src/main/ets/core/render.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RAW = path.join(HERE, 'raw');
const OUT = path.join(REPO, 'entry/src/main/resources/rawfile/china_outline.json');

/** 轮廓的参考画布：与预览/设备同尺寸，简化容差在这个空间里量。 */
const REF_W = 360;
const REF_H = mapBoxHeight(REF_W, CHINA_REGION.bounds);

/**
 * 入库数据里的**环数**（实测 `china_outline.json` 的 `rings.length` = 96：
 * China 70 + Hong Kong 4 + Macao 2 + Taiwan 8 + Spratly 12）。
 * 同一个数字也被 `render.test.ts` 的「china_outline.json：…环数不变」钉着 ——
 * 那条测试守的是**已入库的文件**，这条断言守的是**本脚本刚产出的文件**，两者互为补充。
 *
 * 这是**完整性**判据，与容差、与视野都无关：
 *   · 与容差无关：0.15 与 0.35 产出的环数都是 96（容差只决定每条环留下几个点）；
 *   · 与视野无关：即便放大到"视野里只剩 1 个省"，`rings.length` 也还是 96 ——
 *     "看得见几条"是绘制层的**视口剔除**，不是数据少了环。
 * 所以断言这个数字，才能真的抓住"抽取规则写错、丢了台湾/南海诸岛"这类事故。
 *
 * 换数据源（`--src=50m`）或升级 Natural Earth 版本会**合法地**改变这个数字，
 * 那时必须用 `--expect-rings=N` 显式承认新口径 —— 默认值故意是**精确相等**而不是
 * ">= 下限"：多出环同样意味着抽取规则变了（例如某条规则被放宽、要素被选重），
 * 而"无声地换一份数据和入库版本不同"正是本脚本要防的事。**失败即非零退出**。
 */
const EXPECTED_RINGS = 96;

type Ring = number[];   // 扁平 [lon,lat,lon,lat,…]
interface Pt { x: number; y: number }

interface Opts { src: string; tol: number; write: boolean; compare: boolean; rings: number }
interface Picked { label: string; rings: Ring[]; pts: number }

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Opts {
  // `tol` 的默认值 = **入库数据用的容差**（0.15，见文件头"为什么默认必须是 0.15"）。
  // 不要为了"文件小一点"把它调大：那会静默降精度（2959→2131 点）而自检照样通过。
  const o: Opts = { src: '10m', tol: 0.15, write: true, compare: false, rings: EXPECTED_RINGS };
  for (const a of argv) {
    if (a === '--report') { o.write = false; continue; }
    if (a === '--compare') { o.compare = true; continue; }
    const eq = a.indexOf('=');
    const key = eq < 0 ? a : a.substring(0, eq);
    const val = eq < 0 ? '' : a.substring(eq + 1);
    if (key === '--src') { o.src = val; continue; }
    if (key === '--tol') { o.tol = Number(val); continue; }
    if (key === '--expect-rings') { o.rings = Number(val); continue; }
    throw new Error(`未知参数：${a}`);
  }
  if (!Number.isInteger(o.rings) || o.rings <= 0) {
    throw new Error(`--expect-rings 需要正整数，收到 "${o.rings}"`);
  }
  return o;
}

// ── 读取与筛选 ──────────────────────────────────────────────────────────────

interface NeFeature { properties: Record<string, unknown>; geometry: Record<string, unknown> }

function readFeatures(src: string): NeFeature[] {
  const f = path.join(RAW, `ne_${src}_admin_0_countries.geojson`);
  if (!fs.existsSync(f)) { throw new Error(`找不到 ${f}（Natural Earth 原始数据不入库，见 .gitignore）`); }
  const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { features: NeFeature[] };
  return j.features;
}

/** 把一个要素的几何拆成扁平环序列（Polygon → 1 个环组；MultiPolygon → 多个）。 */
function ringsOf(geom: Record<string, unknown>): Ring[] {
  const out: Ring[] = [];
  const type = geom['type'];
  const co = geom['coordinates'];
  const flat = (arr: unknown): Ring => {
    const r: Ring = [];
    for (const p of arr as unknown[][]) {
      r.push(Number(p[0]), Number(p[1]));
    }
    return r;
  };
  if (type === 'Polygon') {
    for (const r of co as unknown[]) { out.push(flat(r)); }
  } else if (type === 'MultiPolygon') {
    for (const poly of co as unknown[]) {
      for (const r of poly as unknown[]) { out.push(flat(r)); }
    }
  }
  return out;
}

/** 按数据自己的字段挑要素（见文件头）。 */
function pick(features: NeFeature[]): Picked[] {
  const out: Picked[] = [];
  const push = (label: string, groups: Picked[]): void => { for (const g of groups) { out.push(g); } };
  const of = (ft: NeFeature): Picked => {
    const p = ft['properties'];
    const rings = ringsOf(ft['geometry']);
    let pts = 0;
    for (const r of rings) { pts += r.length / 2; }
    return { label: String(p['ADMIN']) + (p['ADMIN'] === p['NAME'] ? '' : ` (${String(p['NAME'])})`), rings: rings, pts: pts };
  };
  // 1) 主权是中国（含港澳）
  for (const ft of features) {
    if (ft['properties']['SOVEREIGNT'] === 'China') { out.push(of(ft)); }
  }
  // 2) 台湾（数据源单列；控制器要求含台湾）
  for (const ft of features) {
    if (ft['properties']['ADMIN'] === 'Taiwan') { out.push(of(ft)); }
  }
  // 3) 南海诸岛
  for (const ft of features) {
    const admin = String(ft['properties']['ADMIN']);
    if (admin.includes('Spratly') || admin.includes('Paracel')) { out.push(of(ft)); }
  }
  return out;
}

// ── 简化 ────────────────────────────────────────────────────────────────────

/** 点到线段的垂距（投影空间，pt）。 */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) { return Math.hypot(p.x - a.x, p.y - a.y); }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < 0) { t = 0; }
  if (t > 1) { t = 1; }
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

interface DpResult { keep: boolean[]; maxDev: number }

/** Douglas–Peucker：返回每点是否保留，以及被丢掉的点到结果折线的最大偏差（pt）。 */
function douglasPeucker(pts: Pt[], tol: number): DpResult {
  const n = pts.length;
  const keep: boolean[] = [];
  for (let i = 0; i < n; i++) { keep.push(false); }
  keep[0] = true;
  keep[n - 1] = true;
  const stack: number[][] = [[0, n - 1]];
  while (stack.length > 0) {
    const seg = stack.pop() as number[];
    const a = seg[0];
    const b = seg[1];
    if (b <= a + 1) { continue; }
    let worst = -1;
    let worstD = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worstD > tol && worst > 0) {
      keep[worst] = true;
      stack.push([a, worst]);
      stack.push([worst, b]);
    }
  }
  // 实测最大偏差：把被丢掉的点量到"保留下来的点连成的折线"上
  let maxDev = 0;
  let prev = 0;
  for (let i = 1; i < n; i++) {
    if (!keep[i]) { continue; }
    for (let j = prev + 1; j < i; j++) {
      const d = segDist(pts[j], pts[prev], pts[i]);
      if (d > maxDev) { maxDev = d; }
    }
    prev = i;
  }
  return { keep: keep, maxDev: maxDev };
}

interface Simplified { rings: Ring[]; dropped: number; maxDev: number; pts: number; tiny: number; droppedPts: number[] }

/** 把一个环转成扁平经纬度序列，去掉相邻重复点。`dec` = 保留几位小数（0 = 不四舍五入）。 */
function ringOf(r: Ring, dec: number): Ring {
  const out: Ring = [];
  const f = dec > 0 ? Math.pow(10, dec) : 0;
  let px = Number.NaN;
  let py = Number.NaN;
  for (let i = 0; i + 1 < r.length; i += 2) {
    const lon = f > 0 ? Math.round(r[i] * f) / f : r[i];
    const lat = f > 0 ? Math.round(r[i + 1] * f) / f : r[i + 1];
    if (lon === px && lat === py) { continue; }
    px = lon;
    py = lat;
    out.push(lon, lat);
  }
  return out;
}

/** 扁平序列里有多少个**互不相同**的顶点。 */
function distinctPoints(flat: Ring): number {
  const seen = new Set<string>();
  for (let i = 0; i + 1 < flat.length; i += 2) { seen.add(`${flat[i]},${flat[i + 1]}`); }
  return seen.size;
}

/**
 * 全部环 → 简化后的扁平经纬度环。
 * 每个环先投影到参考画布、在**投影空间**里做 DP，再把保留下来的点转回经纬度并保留 2 位小数。
 * 2 位小数够不够：0.01° 经度 = 0.01/62×360 = 0.058pt，0.01° 纬度 = 0.01/36×267.72 = 0.074pt
 * —— 都远小于 1 个像素，所以"存 2 位小数"这一步的误差可以忽略，而它省掉约 1/5 的体积。
 */
function simplify(rings: Ring[], tol: number): Simplified {
  const out: Ring[] = [];
  let dropped = 0;
  let maxDev = 0;
  let pts = 0;
  let keptTiny = 0;
  const droppedPts: number[] = [];
  for (const r of rings) {
    if (r.length < 8) { dropped++; droppedPts.push(r.length / 2); continue; }
    const proj: Pt[] = [];
    for (let i = 0; i + 1 < r.length; i += 2) {
      const q = projectMercator(r[i], r[i + 1], REF_W, REF_H, CHINA_REGION.bounds);
      proj.push({ x: q.x, y: q.y });
    }
    // 环的首尾通常重合：去掉尾部重复点做 DP，最后再补回来，避免端点处退化
    const closed = Math.abs(proj[0].x - proj[proj.length - 1].x) < 1e-12
      && Math.abs(proj[0].y - proj[proj.length - 1].y) < 1e-12;
    const seq = closed ? proj.slice(0, proj.length - 1) : proj;
    if (seq.length < 3) { dropped++; continue; }
    // 闭环：以"最远的两个点"为锚切开，DP 才不会被起点/终点这条退化基线骗到
    let i0 = 0;
    let i1 = 0;
    let far = -1;
    for (let i = 1; i < seq.length; i++) {
      const d = (seq[i].x - seq[0].x) * (seq[i].x - seq[0].x) + (seq[i].y - seq[0].y) * (seq[i].y - seq[0].y);
      if (d > far) { far = d; i1 = i; }
    }
    far = -1;
    for (let i = 0; i < seq.length; i++) {
      const d = (seq[i].x - seq[i1].x) * (seq[i].x - seq[i1].x) + (seq[i].y - seq[i1].y) * (seq[i].y - seq[i1].y);
      if (d > far) { far = d; i0 = i; }
    }
    const lo = Math.min(i0, i1);
    const hi = Math.max(i0, i1);
    const partA = seq.slice(lo, hi + 1);
    const partB = seq.slice(hi).concat(seq.slice(0, lo + 1));
    const keepA = douglasPeucker(partA, tol);
    const keepB = douglasPeucker(partB, tol);
    maxDev = Math.max(maxDev, keepA.maxDev, keepB.maxDev);
    const keptIdx: number[] = [];
    for (let i = 0; i < partA.length; i++) { if (keepA.keep[i]) { keptIdx.push(lo + i); } }
    for (let i = 1; i < partB.length - 1; i++) {
      if (keepB.keep[i]) { keptIdx.push((hi + i) % seq.length); }
    }
    let flat: Ring = [];
    let px = Number.NaN;
    let py = Number.NaN;
    for (const idx of keptIdx) {
      // 投影坐标转回经纬度：直接用**原始经纬度**（不是反投影），避免投影往返的额外误差
      const srcIdx = idx * 2;
      const lon = Math.round(r[srcIdx] * 100) / 100;
      const lat = Math.round(r[srcIdx + 1] * 100) / 100;
      if (lon === px && lat === py) { continue; }
      px = lon;
      py = lat;
      flat.push(lon, lat);
    }
    // 小岛兜底：简化后画不出一个面（少于 3 个不同顶点）时，**原样保留这个环**而不是丢掉它。
    // 一个只有 4~6 个点的小岛本来就没什么可简化的，留着它的代价是几个点（全部加起来 < 1KB），
    // 而丢掉它就是"自行删了一个地理要素" —— 控制器明确要求不要那么做。
    if (flat.length < 6) {
      flat = ringOf(r, 2);
      keptTiny++;
    }
    // 2 位小数都占不满一个面的极小球（南海里 300m 量级的礁）：**不四舍五入**、按源数据原样保留。
    // 屏幕上它本来就是一个点（0.003° = 0.017pt），但数据是完整的 —— "不删要素"说的是数据。
    if (distinctPoints(flat) < 3) {
      flat = ringOf(r, 0);
      keptTiny++;
    }
    // 补上闭合点（首尾相同），让 SVG 的 Z 与"环"的语义一致
    if (flat.length >= 6 && (flat[0] !== flat[flat.length - 2] || flat[1] !== flat[flat.length - 1])) {
      flat.push(flat[0], flat[1]);
    }
    // 到这里还画不出一个面：源数据里就是一个"退化成一个点"的环（连 3 个不同顶点都没有）
    if (flat.length < 8) { dropped++; droppedPts.push(r.length / 2); continue; }
    out.push(flat);
    pts += flat.length / 2;
  }
  return { rings: out, dropped: dropped, maxDev: maxDev, pts: pts, tiny: keptTiny, droppedPts: droppedPts };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

interface Built { text: string; rings: number; pts: number; bytes: number; dropped: number; maxDev: number; srcPts: number; tiny: number; droppedPts: number[] }

function build(src: string, tol: number): Built {
  const features = readFeatures(src);
  const picked = pick(features);
  const all: Ring[] = [];
  let srcPts = 0;
  for (const g of picked) {
    for (const r of g.rings) { all.push(r); }
    srcPts += g.pts;
  }
  const s = simplify(all, tol);
  const data = {
    v: `ne${src}-dp${tol}-2dec`,
    src: `Natural Earth 1:${src} Admin 0 – Countries (ne_${src}_admin_0_countries.geojson)`,
    license: 'Public Domain (Natural Earth, naturalearthdata.com)',
    bounds: CHINA_REGION.bounds,
    rings: s.rings
  };
  const text = JSON.stringify(data);
  return {
    text: text, rings: s.rings.length, pts: s.pts, bytes: Buffer.byteLength(text, 'utf8'),
    dropped: s.dropped, maxDev: s.maxDev, srcPts: srcPts, tiny: s.tiny, droppedPts: s.droppedPts
  };
}

function report(src: string, tol: number, b: Built, picked: Picked[]): void {
  console.log(`源：ne_${src}_admin_0_countries.geojson  容差 ${tol}pt（参考画布 ${REF_W}×${REF_H.toFixed(2)}pt）`);
  for (const g of picked) {
    console.log(`  选中 ${g.label.padEnd(26)} 环 ${String(g.rings.length).padStart(3)}  点 ${g.pts}`);
  }
  console.log(`  源点数合计 ${b.srcPts} → 简化后 ${b.pts} 点（${(100 * b.pts / b.srcPts).toFixed(1)}%）`);
  console.log(`  环：${b.rings} 条保留（其中 ${b.tiny} 条是小岛，简化后不足 3 个顶点 → 原样保留，不删要素）`);
  if (b.dropped > 0) {
    console.log(`      ${b.dropped} 条丢弃：源数据里就只有 ${b.droppedPts.join("/")} 个点，连 0.01° 网格都占不满`);
  } else {
    console.log('      没有丢弃任何环（源数据里的每一条都保留下来了）');
  }
  console.log(`  实测最大偏差 ${b.maxDev.toFixed(4)}pt（容差 ${tol}pt，1 倍图上 ${(b.maxDev).toFixed(2)}px）`);
  console.log(`  字节数 ${b.bytes}（${(b.bytes / 1024).toFixed(1)} KB）  上限 200KB → ${b.bytes <= 200 * 1024 ? '通过 ✓' : '超了 ✗'}`);
}

function main(): number {
  const o = parseArgs(process.argv.slice(2));

  if (o.compare) {
    // 对照表：两份源 × 若干容差。用来回答"50m 够不够、要不要上 10m"。
    console.log('源        容差   点数     环    丢弃  最大偏差   字节     KB');
    for (const src of ['50m', '10m']) {
      const features = readFeatures(src);
      const picked = pick(features);
      for (const tol of [0.05, 0.1, 0.15, 0.2, 0.35]) {
        const b = build(src, tol);
        console.log(`${src.padEnd(8)} ${String(tol).padEnd(6)} ${String(b.pts).padStart(6)} ${String(b.rings).padStart(5)}`
          + ` ${String(b.dropped).padStart(5)} ${b.maxDev.toFixed(3).padStart(8)} ${String(b.bytes).padStart(7)}`
          + ` ${(b.bytes / 1024).toFixed(1).padStart(7)}`);
      }
    }
    return 0;
  }

  const features = readFeatures(o.src);
  const picked = pick(features);
  const b = build(o.src, o.tol);
  report(o.src, o.tol, b, picked);

  if (!o.write) { return 0; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, b.text, 'utf8');
  const st = fs.statSync(OUT);
  console.log(`✓ ${path.relative(REPO, OUT)}  ${st.size} 字节`);

  // 落盘后的**自检**：用渲染方的同一个解析器与同一个 path 生成器跑一遍。
  // 为什么必须走这一步：JSON 写对了但 parseOutline 判它不合法（例如某个环点数不足），
  // 症状是"地图不见了"—— 那是这个项目里最难查的一类静默失败。
  const od = parseOutline(fs.readFileSync(OUT, 'utf8'));
  if (od === undefined) {
    console.error('✗ 落盘的文件过不了 parseOutline —— 拒绝收工');
    return 1;
  }
  const sameBounds = od.bounds.length === 4 && od.bounds[0] === CHINA_REGION.bounds[0]
    && od.bounds[1] === CHINA_REGION.bounds[1] && od.bounds[2] === CHINA_REGION.bounds[2]
    && od.bounds[3] === CHINA_REGION.bounds[3];
  if (!sameBounds) {
    console.error(`✗ bounds ${JSON.stringify(od.bounds)} 与 CHINA_REGION.bounds ${JSON.stringify(CHINA_REGION.bounds)} 不一致`
      + ' —— 国界会与照片错位，拒绝收工');
    return 1;
  }
  // `outlinePath` 现在收一个 `MapFrame`（bounds 长在框上，见 render.ts 的 `MapFrame`）。
  // 这里用 `mapFrame(REF_W, REF_H, od.bounds)` 重建**整块参考画布**：
  // `REF_H` 本来就是 `mapBoxHeight(REF_W, CHINA_REGION.bounds)`，而 `od.bounds` 已被上面
  // 钉死等于 `CHINA_REGION.bounds` —— 所以这个框的不变形比例与画布**恰好**一致，
  // 算出来就是 `x = 2.8e-14, y = 0, w = REF_W(−5.7e-14), h = REF_H`（浮点尾差，`r2` 之后为 0），
  // 即"框 == 整块画布"，与旧调用 `outlinePath(rings, REF_W, REF_H, od.bounds)` **逐字节等价**。
  // 唯一差别是新实现多了"整条环落在块外 → 不产出子路径"的视口剔除（96 条 → 77 条），
  // 这是 render.ts 侧有意为之，下面 main() 里的视口统计数的就是这件事。
  const d = outlinePath(od.rings, mapFrame(REF_W, REF_H, od.bounds));
  if (d.length === 0 || d.includes('NaN') || d.includes('Infinity')) {
    console.error('✗ outlinePath 产出的 d 为空或含 NaN —— 拒绝收工');
    return 1;
  }

  // ── 自检的两个数字：**它们不是一回事，谁也不能顶替谁** ────────────────────────
  //   · dataRings = 落盘文件里**真实存在**的环数（`od.rings.length`）
  //       = **完整性**判据。与视野无关：放大到视野里只剩一个省，它照样是 96；
  //         与容差也无关：0.15 和 0.35 产出的都是 96（容差只决定每条环留几个点）。
  //   · subpaths  = 拿"整块参考画布"当视野时**画得出来**的子路径数
  //       = 视口剔除的**结果**。视野一变它就变 → 它**不能**当完整性判据。
  // 上一版只报 subpaths（96 条环 → 77 条），于是自检**没有校验它声称校验的东西**：
  //   96→77 明明是视口剔除的功劳，看上去却像"数据里只有 77 条"；反过来，若抽取规则
  //   写错、真丢了台湾(8 环)和南海诸岛(12 环)这 20 条环，只要剩下的环恰好都落在视野内，
  //   这个数字**一模一样**，自检照样绿着通过 —— 丢掉的环永远不会被发现。
  // 所以完整性必须断言 dataRings，而且断言失败就**非零退出**（自检的全部意义）。
  const dataRings = od.rings.length;
  const subpaths = d.split('M').length - 1;
  console.log(`  自检：parseOutline ✓  bounds 与 CHINA_REGION 一致 ✓  outlinePath ${d.length} 字符`);
  console.log(`  数据环数 ${dataRings}（落盘文件的 od.rings.length ← **完整性判据**，期望 ${o.rings}）`);
  console.log(`  视野内子路径数 ${subpaths}（${REF_W}×${REF_H.toFixed(2)}pt 整块画布、视口剔除**之后**，只作参考）`);
  if (dataRings !== o.rings) {
    console.error(`✗ 数据环数 ${dataRings} ≠ 期望 ${o.rings}（差 ${dataRings - o.rings} 条）—— 落盘数据丢了或多了环，拒绝收工`);
    console.error('  按要素数一遍，看是哪一组出的问题（台湾 8 环、南海诸岛 12 环是必须有的）：');
    for (const g of picked) { console.error(`    ${g.label}  源环 ${g.rings.length}`); }
    console.error('  有意换了数据源/升级了 Natural Earth 版本 → 确认无误后用 --expect-rings=N 显式承认新口径；');
    console.error('  否则就是抽取规则（SOVEREIGNT / ADMIN）写错了。');
    return 1;
  }
  if (subpaths < 1 || subpaths > dataRings) {
    console.error(`✗ 视野内子路径数 ${subpaths} 不合理（应为 1..${dataRings}）—— outlinePath 有问题，拒绝收工`);
    return 1;
  }

  // 视口核对：**上面那个 subpaths 是怎么来的**（= 哪些环被剔除掉了）。
  // 为什么必须数出来：bounds 的 minLat = 18，而南海诸岛在 8~11.4°N，
  // 它们投影后在地图块**下方**（y > mapH）。数据按要求完整保留（dataRings 里一条不少），
  // 绘制层只是**不画**视野外的东西 —— 这也是"完整性"与"看得见"必须分开报的原因。
  // 判定条件与 `outlinePath` 里的剔除条件完全一致（整条环的包围盒落在块外 → 跳过）。
  let inside = 0;
  let outside = 0;
  let straddle = 0;
  for (const ring of od.rings) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const q = projectMercator(ring[i], ring[i + 1], REF_W, REF_H, od.bounds);
      if (q.x < minX) { minX = q.x; }
      if (q.x > maxX) { maxX = q.x; }
      if (q.y < minY) { minY = q.y; }
      if (q.y > maxY) { maxY = q.y; }
    }
    const wholly = maxX < 0 || minX > REF_W || maxY < 0 || minY > REF_H;
    const crosses = !wholly && (minX < 0 || maxX > REF_W || minY < 0 || maxY > REF_H);
    if (wholly) { outside++; } else if (crosses) { straddle++; } else { inside++; }
  }
  console.log(`  视口：${inside} 条环完整落在地图块 ${REF_W}×${REF_H.toFixed(2)}pt 内`
    + ` ｜ ${outside} 条整体在块外（8~11.4°N 的南海诸岛，数据保留、绘制时跳过）`
    + ` ｜ ${straddle} 条跨界`);
  console.log(`  ${inside} + ${straddle} = ${inside + straddle} 条可见（跨界的也算画出来）`
    + `，${dataRings} − ${outside} = ${dataRings - outside} 条 —— 与上面的 ${subpaths} 条子路径对应`);
  return 0;
}

process.exitCode = main();
