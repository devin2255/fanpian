/**
 * 从 Natural Earth 的 Admin 1（省级）数据里抽出**中国全部的省级边界**，简化后产出
 * `entry/src/main/resources/rawfile/china_provinces.json`。
 *
 * 用法：
 *   node --experimental-strip-types tools/build-provinces.ts                  # 默认 10m / 容差 0.08pt（= 入库口径）
 *   node --experimental-strip-types tools/build-provinces.ts --report         # 只报数，不写盘
 *   node --experimental-strip-types tools/build-provinces.ts --compare        # 若干容差 × 两份源的对照表（选容差用）
 *   node --experimental-strip-types tools/build-provinces.ts --tol=0.1
 *
 * ⚠️ **默认容差就是入库口径**（与 `build-outline.ts` 同一条教训）：0.08 是入库数据用的容差，
 * 它记录在产物的 `v` 字段里（`ne10m-admin1-dp0.08-2dec`）。改成更大会**静默降精度**，
 * 而本脚本的自检（能不能解析、省数对不对、有没有 NaN）在降精度后照样通过。
 *
 * ── 为什么需要这份数据（用户的第二条反馈）──────────────────────────────────────
 *   「还有地图至少要有省级划分的边界线 现在整个地图都是一片」。
 *   `china_outline.json` 只有**国界**：内陆没有线，放大到上海/北京/天津那一档时
 *   屏幕上就是一整片同一个颜色 —— 用户看到的就是那个。
 *
 * ── 这份工具有意与 `build-outline.ts` 长得一样（它是范本）──────────────────────
 *   同样的"参考画布 + 投影空间 Douglas–Peucker + 2 位小数 + 落盘后自检"流水线。
 *   DP 的代码在这里是**另写的一份**，不是 import 过来的：`build-outline.ts` 是另一个
 *   agent 正在动的文件（本批开工时它刚有一个在途提交 `2aa6071`），为了不给它制造
 *   冲突而没去改它的导出。两个脚本都是一次性的数据构建器、不参与运行时，
 *   重复的是一段稳定的经典算法（DP 自 1973 年没变过）。**将来若要合并，
 *   把 `segDist` / `douglasPeucker` / `ringOf` / `distinctPoints` 抽成
 *   `tools/geo-simplify.ts` 让两边 import 即可，行为不需要改。**
 *
 * ── 选哪些要素（**规则由数据自己的字段决定，不是按 name 猜**）──────────────────
 *   先读了数据看有哪些字段（admin_1 里**没有** `sovereignt`，那只是 admin_0 的字段；
 *   可用的分组字段是 `admin` / `geonunit` / `gu_a3` / `type_en`）。然后：
 *
 *   ① **大陆 31 个省级**：`properties.admin === 'China' && properties.geonunit === 'China'`
 *      → 实测**正好 31 条**（22 省 + 5 自治区 + 4 直辖市），93 环、53214 个源点。
 *      这条规则顺带排除了 `admin === 'China'` 但 `geonunit === 'Paracel Islands'` 的那条
 *      （西沙群岛）—— 它是 Natural Earth 单列的一个 geounit，**不是省级单位**；
 *      它的岛礁形状已经由国界那一层（`china_outline.json` 的南海诸岛 12 环）画出来了。
 *
 *   ② **台湾 / 香港 / 澳门**：它们在 admin_1 里是**被拆到县市级**的
 *      （台湾 21 个县市、香港 18 个区、澳门 1 条），所以**不能**直接拿 admin_1 的
 *      要素当"省级"用 —— 那会把台湾画成 21 块、香港画成 18 块，与"省级划分"不是一回事。
 *      而这三个恰恰是**省级 = 国家级**的单位：它们是中国的 34 个省级行政区里的 3 个，
 *      其省级边界**就是**它的全境轮廓。那份轮廓已经作为**独立的 admin_0 要素**
 *      存在（`SOVEREIGNT === 'China'` 的 Hong Kong / Macao，以及 `ADMIN === 'Taiwan'`），
 *      也正是 `build-outline.ts` 已经画在墙上的东西（国界那一层的 4 + 2 + 8 环）。
 *      所以这里从 **admin_0** 取它们的三份全境轮廓，省数因此是 **31 + 3 = 34**
 *      —— 与"中国有 34 个省级行政区"这个事实对上，而且每条都能在数据里指出来。
 *      代价：香港/澳门/台湾的线会与国界那一层**重合**（同一批坐标画两遍）。
 *      视觉上完全一致（同色同宽），换来的是"这份文件自己就含 34 个省级"这件事成立，
 *      以及 `--expect-provinces=34` 这个可以机械核对的口径。
 *
 *   ③ **不做任何按名字的挑选**：没有 `'北京'` / `'Tibet'` 这样的字面量，也没有
 *      `name_zh` 匹配（那是另一个语言的字段，改了名就静默失效）。
 *
 * ── 怎么简化（与国界同一条流水线，只是容差更小）────────────────────────────────
 *   Douglas–Peucker，**在投影后的画布空间里**做（不是经纬度空间）。参考画布与国界一致：
 *   360 × `mapBoxHeight(360, CHINA_REGION.bounds)` = 360 × 267.72pt（整个中国铺满 360pt 宽）。
 *
 *   **为什么容差要比国界的 0.15pt 小，以及为什么最终是 0.08pt**（这是本文件唯一要判断的参数）：
 *   国界是**在整块中国都看得见**的时候看的（360pt 宽的画面），而省界是用户在
 *   **放大 9.5 倍**（真机诊断行：`放大 9.5×`）之后看的。容差是在参考画布上量的，
 *   屏幕上的误差 = 参考容差 × 放大倍数。实测（`--compare`，10m 源）：
 *
 *     容差    点数     环   最大偏差   **9.5× 下的屏幕误差**   字节     KB     ≤150KB
 *     0.02   26520   107    0.020          0.19pt            334603  326.8     ✗
 *     0.05   15906   107    0.050          0.47pt            200862  196.2     ✗
 *     0.06   14239   107    0.060          0.57pt            179880  175.7     ✗
 *     0.07   12941   107    0.070          0.67pt            163564  159.7     ✗
 *   **0.08   11840   107    0.080          0.76pt            149688  146.2     ✓ ← 入库**
 *     0.1    10240   107    0.100          0.95pt            129538  126.5     ✓
 *     0.15    7766   107    0.150          1.42pt             98352   96.0     ✓
 *
 *   选择 **0.08**（= 在 150KB 上限内能做到的**最小**容差，也就是最好保真度）：
 *     · 0.15（国界用的那个）在 9.5 倍下是 **1.42pt** —— 一条 0.4pt 的细线偏 1.4pt，看得出"线在抖"；
 *     · 0.08 在 9.5 倍下是 **0.76pt** —— 亚像素量级（3 倍屏上 2.3px），线是稳的；
 *     · 再往下（0.07）就 **159.7KB 超上限**了 —— 那是硬约束，所以这是"上限内最好的那一档"。
 *   留了 3.7KB 余量（149688 / 153600 字节）。余量薄是**故意的**：本脚本有一条
 *   "超过 150KB 就非零退出"的硬断言，所以将来 Natural Earth 更新导致它涨上去时，
 *   是**大声失败**（要求显式重选容差），不是悄悄变胖。
 *
 *   **为什么是 10m 而不是 50m**（这一步不是偏好，是实测）：同样 34 个省级单位，
 *   10m 有 **107 条环**、50m 只有 **49 条** —— 少掉的 58 条全是小岛/岛礁（舟山、万山、
 *   南海诸岛那些）。这正是 `china_outline.json` 上已经吃过一次的亏（50m 的中国只有 19 环、
 *   10m 有 96 环）。50m 确实能在 0.02pt 下把误差压到 0.19pt 且只占 95.6KB，
 *   但代价是**永久丢掉 58 条地理要素**，而容差随时可以调 —— 用要素换精度是不划算的。
 *
 *   2 位小数：0.01° 经度 = 0.01/62×360 = 0.058pt（参考画布）。在 9.5 倍下是 0.55pt ——
 *   与 0.08pt 的 DP 容差同一量级，所以**这里不能再省到 1 位**（1 位小数 = 5.5pt，肉眼可见的台阶）。
 *
 * ── 坐标系/边界 ──────────────────────────────────────────────────────────────
 *   输出的 `bounds` 与 `core/projection.ts` 的 `CHINA_REGION.bounds` **完全一致**
 *   （直接 import 那个常量，不另写字面量）。它只是**元信息**：投影用的是 `frame.bounds`
 *   （见 `core/render.ts` 的 `OutlineData.bounds` 与 `outlinePath`）。存同一个值是为了
 *   让"这份数据覆盖哪儿"这件事在文件里可读，并与国界文件保持同一口径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHINA_REGION, projectMercator } from '../entry/src/main/ets/core/projection.ts';
import { mapBoxHeight, mapFrame, parseOutline, outlinePath } from '../entry/src/main/ets/core/render.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RAW = path.join(HERE, 'raw');
const OUT = path.join(REPO, 'entry/src/main/resources/rawfile/china_provinces.json');

/** 参考画布：与 `build-outline.ts` **同一个**尺寸，容差数字才可比。 */
const REF_W = 360;
const REF_H = mapBoxHeight(REF_W, CHINA_REGION.bounds);

/**
 * 入库数据里的**省级单位数**。34 = 中国的省级行政区总数（23 省 + 5 自治区 + 4 直辖市
 * + 2 特别行政区；台湾按省计）。其中：
 *   · 31 条来自 admin_1（`admin === 'China' && geonunit === 'China'`）；
 *   · 3 条（台湾/香港/澳门）来自 admin_0 的对应要素（见文件头 ②）。
 *
 * 这是**完整性**判据，与容差无关、与视野无关：容差只决定每条环留几个点，
 * 放大到"视野里只剩一个省"也不会改变它。断言精确相等（不是 >= 下限），
 * 因为**多出来**同样意味着抽取规则变了（比如误把西沙群岛、或台湾的 21 个县市算进来）。
 * 失败即非零退出。
 */
const EXPECTED_PROVINCES = 34;

type Ring = number[];   // 扁平 [lon,lat,lon,lat,…]
interface Pt { x: number; y: number }

interface Opts { src: string; tol: number; write: boolean; compare: boolean; expect: number }
interface Picked { label: string; group: string; rings: Ring[]; pts: number }

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Opts {
  // 默认容差 = **入库数据用的容差**（0.08，见文件头"为什么最终是 0.08pt"那张表）。
  const o: Opts = { src: '10m', tol: 0.08, write: true, compare: false, expect: EXPECTED_PROVINCES };
  for (const a of argv) {
    if (a === '--report') { o.write = false; continue; }
    if (a === '--compare') { o.compare = true; continue; }
    const eq = a.indexOf('=');
    const key = eq < 0 ? a : a.substring(0, eq);
    const val = eq < 0 ? '' : a.substring(eq + 1);
    if (key === '--src') { o.src = val; continue; }
    if (key === '--tol') { o.tol = Number(val); continue; }
    if (key === '--expect-provinces') { o.expect = Number(val); continue; }
    throw new Error(`未知参数：${a}`);
  }
  if (!Number.isInteger(o.expect) || o.expect <= 0) {
    throw new Error(`--expect-provinces 需要正整数，收到 "${o.expect}"`);
  }
  return o;
}

// ── 读取与筛选 ──────────────────────────────────────────────────────────────

interface NeFeature { properties: Record<string, unknown>; geometry: Record<string, unknown> }

function readFeatures(file: string): NeFeature[] {
  const f = path.join(RAW, file);
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
    for (const p of arr as unknown[][]) { r.push(Number(p[0]), Number(p[1])); }
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

function ptsOf(rings: Ring[]): number {
  let n = 0;
  for (const r of rings) { n += r.length / 2; }
  return n;
}

/**
 * 按数据自己的字段挑要素（见文件头 ①②）。
 *
 * 为什么把"大陆"与"台港澳"分成两组返回：它们的**数据来源不同**（admin_1 / admin_0），
 * 来源不同就意味着"如果哪天少了一组"这种事故必须能被单独看见 —— 报告里分组打印，
 * 自检里分组断言。合成一个列表就分不出"31 少了一条"和"3 少了一条"。
 */
function pick(a1: NeFeature[], a0: NeFeature[]): Picked[] {
  const out: Picked[] = [];
  /**
   * 取一个要素的**日志标签**（只进报告与错误信息，**不进产物**）。
   *
   * ⚠️ 有两处实测出来的坑，都不是"顺手写一下"能避开的：
   *   1. **两份源的大小写不一样**：admin_1 是小写（`name` / `name_zh`），
   *      admin_0 是大写（`NAME` / `NAME_ZH`）。只认一种会让报告里全是 `undefined` ——
   *      也就是"出问题时最需要读的那几行恰好读不了"（这个 bug 真踩到了，见提交信息）。
   *   2. **admin_0 的 `NAME_ZH` 不能用**：Natural Earth 给台湾的 `NAME_ZH` 是
   *      "中华民国" —— 一个与本项目立场不符、且与"中国 34 个省级行政区之一"这个
   *      抽取口径直接冲突的字符串。所以 **admin_0 的三个要素只用英文 `ADMIN`/`NAME` 当标签**，
   *      中文名一律不取上游的翻译。
   *
   * 更要紧的是：**标签只用于打印，抽取规则一个字都不看名字**（见文件头 ③）。
   * 所以就算标签难看，产出的 107 条环也不受任何影响。
   */
  const nameOf = (p: Record<string, unknown>, useZh: boolean): string => {
    const zh = p['name_zh'] !== undefined ? p['name_zh'] : p['NAME_ZH'];
    const raw = p['name'] !== undefined ? p['name'] : (p['NAME'] !== undefined ? p['NAME'] : p['ADMIN']);
    const v = useZh && zh !== undefined && zh !== null ? zh : raw;
    return v === undefined || v === null ? '(无名)' : String(v);
  };
  const of = (ft: NeFeature, group: string, useZh: boolean): Picked => {
    const p = ft['properties'];
    const rings = ringsOf(ft['geometry']);
    return { label: nameOf(p, useZh), group: group, rings: rings, pts: ptsOf(rings) };
  };

  // ① 大陆 31 个省级：admin = China 且 geonunit = China
  //    （`geonunit === 'China'` 这一条排除了 geonunit === 'Paracel Islands' 的西沙群岛）
  //    这一组的 `name_zh` 是干净的中文省名（北京市 / 河北省 / 新疆维吾尔自治区），可以用。
  for (const ft of a1) {
    const p = ft['properties'];
    if (p['admin'] === 'China' && p['geonunit'] === 'China') { out.push(of(ft, 'admin1', true)); }
  }
  // ② 台湾：admin_0 里 ADMIN === 'Taiwan'（与 build-outline.ts 同一条规则）。标签用英文，见 nameOf。
  for (const ft of a0) {
    if (ft['properties']['ADMIN'] === 'Taiwan') { out.push(of(ft, 'admin0', false)); }
  }
  // ③ 香港 / 澳门：admin_0 里 SOVEREIGNT === 'China' 且 ADMIN 是这两个
  //    （admin_1 把它们拆成了 18 个区 / 1 个市，那是**省级以下**的划分，见文件头 ②）
  for (const ft of a0) {
    const p = ft['properties'];
    const admin = String(p['ADMIN']);
    if (p['SOVEREIGNT'] !== 'China') { continue; }
    if (admin.includes('Hong Kong') || admin.includes('Macao') || admin.includes('Macau')) {
      out.push(of(ft, 'admin0', false));
    }
  }
  return out;
}

// ── 简化（与 build-outline.ts 同一算法；见文件头"有意另写一份"的说明）──────────

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

interface Simplified { rings: Ring[]; dropped: number; maxDev: number; pts: number; tiny: number; droppedPts: number[] }

/**
 * 全部环 → 简化后的扁平经纬度环。
 * 每个环先投影到参考画布、在**投影空间**里做 DP，再把保留下来的点转回经纬度并保留 2 位小数。
 *
 * **不按面积删任何环**（与国界同一条规矩）：简化后画不出一个面的小环**原样保留**。
 * 省级数据里的岛礁很多（舟山、万山、南海诸岛），删掉它们就是"自行删了地理要素"。
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
      const srcIdx = idx * 2;
      const lon = Math.round(r[srcIdx] * 100) / 100;
      const lat = Math.round(r[srcIdx + 1] * 100) / 100;
      if (lon === px && lat === py) { continue; }
      px = lon;
      py = lat;
      flat.push(lon, lat);
    }
    // 小岛兜底：简化后画不出一个面（少于 3 个不同顶点）时原样保留，不删要素
    if (flat.length < 6) {
      flat = ringOf(r, 2);
      keptTiny++;
    }
    if (distinctPoints(flat) < 3) {
      flat = ringOf(r, 0);
      keptTiny++;
    }
    if (flat.length >= 6 && (flat[0] !== flat[flat.length - 2] || flat[1] !== flat[flat.length - 1])) {
      flat.push(flat[0], flat[1]);
    }
    if (flat.length < 8) { dropped++; droppedPts.push(r.length / 2); continue; }
    out.push(flat);
    pts += flat.length / 2;
  }
  return { rings: out, dropped: dropped, maxDev: maxDev, pts: pts, tiny: keptTiny, droppedPts: droppedPts };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

interface Built {
  text: string; rings: number; pts: number; bytes: number;
  dropped: number; maxDev: number; srcPts: number; tiny: number; droppedPts: number[];
}

function build(src: string, tol: number): Built {
  const a1 = readFeatures(`ne_${src}_admin_1_states_provinces.geojson`);
  const a0 = readFeatures(`ne_${src}_admin_0_countries.geojson`);
  const picked = pick(a1, a0);
  const all: Ring[] = [];
  let srcPts = 0;
  for (const g of picked) {
    for (const r of g.rings) { all.push(r); }
    srcPts += g.pts;
  }
  const s = simplify(all, tol);
  const data = {
    v: `ne${src}-admin1-dp${tol}-2dec`,
    src: `Natural Earth 1:${src} Admin 1 – States/Provinces (ne_${src}_admin_1_states_provinces.geojson)`
      + ` ＋ Admin 0 – Countries（台港澳的全境轮廓）`,
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
  console.log(`源：ne_${src}_admin_1_states_provinces.geojson ＋ ne_${src}_admin_0_countries.geojson`
    + `  容差 ${tol}pt（参考画布 ${REF_W}×${REF_H.toFixed(2)}pt）`);
  const g1 = picked.filter((p) => p.group === 'admin1');
  const g0 = picked.filter((p) => p.group === 'admin0');
  console.log(`  ① 大陆省级（admin=China ∧ geonunit=China）：${g1.length} 个，`
    + `环 ${g1.reduce((s, g) => s + g.rings.length, 0)}，点 ${g1.reduce((s, g) => s + g.pts, 0)}`);
  console.log(`  ② 台港澳（来自 admin_0，其省级边界 = 全境轮廓）：${g0.length} 个 —— `
    + g0.map((g) => `${g.label}(${g.rings.length}环)`).join(' '));
  console.log(`  省级单位合计 ${picked.length}（期望 ${EXPECTED_PROVINCES}）`);
  console.log(`  源点数合计 ${b.srcPts} → 简化后 ${b.pts} 点（${(100 * b.pts / b.srcPts).toFixed(1)}%）`);
  console.log(`  环：${b.rings} 条保留（其中 ${b.tiny} 条是小岛/岛礁，简化后不足 3 个顶点 → 原样保留，不删要素）`);
  if (b.dropped > 0) {
    console.log(`      ${b.dropped} 条丢弃：源数据里就只有 ${b.droppedPts.join('/')} 个点，连 0.01° 网格都占不满`);
  } else {
    console.log('      没有丢弃任何环（源数据里的每一条都保留下来了）');
  }
  console.log(`  实测最大偏差 ${b.maxDev.toFixed(4)}pt（容差 ${tol}pt）`
    + ` → 在**放大 9.5 倍**的屏幕上 ${(b.maxDev * 9.5).toFixed(3)}pt（1 倍图上 ${(b.maxDev * 9.5).toFixed(2)}px）`);
  console.log(`  字节数 ${b.bytes}（${(b.bytes / 1024).toFixed(1)} KB）  上限 150KB → ${b.bytes <= 150 * 1024 ? '通过 ✓' : '超了 ✗'}`);
}

function main(): number {
  const o = parseArgs(process.argv.slice(2));

  if (o.compare) {
    console.log('源     容差    省级  点数     环    丢弃  最大偏差   9.5×下   字节     KB    ≤150KB');
    for (const src of ['50m', '10m']) {
      for (const tol of [0.02, 0.03, 0.05, 0.1, 0.15]) {
        const a1 = readFeatures(`ne_${src}_admin_1_states_provinces.geojson`);
        const a0 = readFeatures(`ne_${src}_admin_0_countries.geojson`);
        const picked = pick(a1, a0);
        const b = build(src, tol);
        console.log(`${src.padEnd(6)} ${String(tol).padEnd(7)} ${String(picked.length).padStart(4)}`
          + ` ${String(b.pts).padStart(7)} ${String(b.rings).padStart(5)} ${String(b.dropped).padStart(5)}`
          + ` ${b.maxDev.toFixed(3).padStart(8)} ${(b.maxDev * 9.5).toFixed(2).padStart(7)}`
          + ` ${String(b.bytes).padStart(7)} ${(b.bytes / 1024).toFixed(1).padStart(7)}`
          + ` ${b.bytes <= 150 * 1024 ? '✓' : '✗'}`);
      }
    }
    return 0;
  }

  const a1 = readFeatures(`ne_${o.src}_admin_1_states_provinces.geojson`);
  const a0 = readFeatures(`ne_${o.src}_admin_0_countries.geojson`);
  const picked = pick(a1, a0);
  const b = build(o.src, o.tol);
  report(o.src, o.tol, b, picked);

  // 省级数自检：**先查这个**，因为它是"抽取规则写对了没有"的唯一判据。
  // 放在写盘之前 —— 规则错了就不该污染入库文件。
  if (picked.length !== o.expect) {
    console.error(`✗ 省级单位数 ${picked.length} ≠ 期望 ${o.expect}（差 ${picked.length - o.expect} 个）—— 拒绝收工`);
    console.error('  分组数一遍，看是哪一组出的问题（大陆应当 31、台港澳应当 3）：');
    console.error(`    admin_1（admin=China ∧ geonunit=China）：${picked.filter((p) => p.group === 'admin1').length}`);
    console.error(`    admin_0（台湾/香港/澳门）：${picked.filter((p) => p.group === 'admin0').length}`
      + ` —— ${picked.filter((p) => p.group === 'admin0').map((p) => p.label).join('、')}`);
    console.error('  有意换了数据源/升级了 Natural Earth 版本 → 确认无误后用 --expect-provinces=N 显式承认新口径；');
    console.error('  否则就是抽取规则（admin / geonunit / ADMIN / SOVEREIGNT）写错了。');
    return 1;
  }

  if (!o.write) { return 0; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, b.text, 'utf8');
  const st = fs.statSync(OUT);
  console.log(`✓ ${path.relative(REPO, OUT)}  ${st.size} 字节`);

  // 落盘后的自检：用**渲染方的同一个解析器与同一个 path 生成器**跑一遍。
  // 为什么必须走这一步：JSON 写对了但 parseOutline 判它不合法（例如某个环点数不足），
  // 症状是"省界不见了"—— 静默失败里最难查的一类。
  const od = parseOutline(fs.readFileSync(OUT, 'utf8'));
  if (od === undefined) {
    console.error('✗ 落盘的文件过不了 parseOutline —— 拒绝收工');
    return 1;
  }
  const sameBounds = od.bounds.length === 4 && od.bounds[0] === CHINA_REGION.bounds[0]
    && od.bounds[1] === CHINA_REGION.bounds[1] && od.bounds[2] === CHINA_REGION.bounds[2]
    && od.bounds[3] === CHINA_REGION.bounds[3];
  if (!sameBounds) {
    console.error(`✗ bounds ${JSON.stringify(od.bounds)} 与 CHINA_REGION.bounds ${JSON.stringify(CHINA_REGION.bounds)} 不一致`);
    return 1;
  }
  const d = outlinePath(od.rings, mapFrame(REF_W, REF_H, od.bounds));
  if (d.length === 0 || d.includes('NaN') || d.includes('Infinity')) {
    console.error('✗ outlinePath 产出的 d 为空或含 NaN —— 拒绝收工');
    return 1;
  }
  const dataRings = od.rings.length;
  const subpaths = d.split('M').length - 1;
  console.log(`  自检：parseOutline ✓  bounds 与 CHINA_REGION 一致 ✓  outlinePath ${d.length} 字符`);
  console.log(`  数据环数 ${dataRings}（落盘文件的 od.rings.length ← **完整性判据**，期望 ${b.rings}）`);
  console.log(`  视野内子路径数 ${subpaths}（${REF_W}×${REF_H.toFixed(2)}pt 整块画布、视口剔除**之后**，只作参考）`);
  if (dataRings !== b.rings) {
    console.error(`✗ 数据环数 ${dataRings} ≠ 刚算出来的 ${b.rings} —— 落盘/解析丢了环，拒绝收工`);
    return 1;
  }
  if (subpaths < 1 || subpaths > dataRings) {
    console.error(`✗ 视野内子路径数 ${subpaths} 不合理（应为 1..${dataRings}）—— outlinePath 有问题，拒绝收工`);
    return 1;
  }
  if (st.size > 150 * 1024) {
    console.error(`✗ 文件 ${st.size} 字节超过 150KB 上限 —— 拒绝收工（降容差会让它更大，要改的是抽取口径）`);
    return 1;
  }
  // 国界那一层的环数：省界的**上限参照**。省界比国界多出的是"内陆的分省线"，
  // 少了的那些是台湾/香港/澳门 —— 它们的线由国界那一层的独立要素画（见文件头 ②）。
  console.log(`  （对照）国界那一层的数据环数见 china_outline.json（96 条）：`
    + ` 台港澳的轮廓在那边**已经画了**，本文件再含一份是为了让"省级 34"这件事自洽`);
  return 0;
}

process.exitCode = main();
