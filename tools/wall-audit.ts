/**
 * 地图墙**验收度量**：直接读 render-preview.ts 产出的 SVG，数出可核对的数字。
 *
 * 用法：
 *   node --experimental-strip-types tools/wall-audit.ts tools/out/wall-preview.svg
 *   node --experimental-strip-types tools/wall-audit.ts tools/out/wall-preview.svg --json
 *
 * ── 为什么是「读 SVG」而不是「再算一遍几何」 ──────────────────────────────────
 * 这个脚本刻意**不复用 render.ts 的任何布局函数**，只做两件事：正则抽出 SVG 里的
 * 照片卡片矩形、用平面几何判定它们之间的关系。理由：
 *   · 如果它复用同一份布局代码，"布局算错了"和"度量算错了"会一起错，度量就失去了判别力；
 *   · SVG 正是**人眼看到的那张图**（控制器就是打开它看的）——度量与观感对的是同一个对象。
 * 它唯一"相信" render.ts 的地方是卡片的画法：外层矩形 `rx="2"` 就是一张照片
 *（内层白边是 `rx="1.4"`，据此区分）。这条约定写在 render.ts 的 photoCardSvg 里。
 *
 * ── 度量定义（报告里逐条引用） ──────────────────────────────────────────────
 *   · 出画布框数：卡片矩形与画布 [0,w]×[0,h] 的差集面积 > EPS 的卡片数。
 *     （"边界刚好贴边"不算出界；EPS 吸收浮点与 2 位小数取整的误差。）
 *   · 两两重叠对数：**任意两张卡片的矩形相交**即算一对，交集面积 > EPS_AREA 才计数。
 *     EPS_AREA = 1 pt²（约一张卡片面积的 0.07%）—— 小于它的相交在 2 倍图上不到 1px，
 *     肉眼不可见；用 0 容忍会把浮点噪声当成缺陷报出来。
 *   · 重叠面积占比：所有相交对的交集面积之和 ÷（卡片数 × 单卡面积）。
 *   · 空间利用：画布面积、卡片覆盖面积、地图块高、挂载区高、空白占比。
 */

import fs from 'node:fs';
import path from 'node:path';
import { HANG_OVERLAP_EPS } from '../entry/src/main/ets/core/render.ts';

/** 一张卡片的矩形（pt，画布坐标系）。 */
interface Card { x: number; y: number; w: number; h: number; id: string }
type CardRect = Card;

interface Params {
  file: string;
  json: boolean;
}

function parseArgs(argv: string[]): Params {
  const p: Params = { file: '', json: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--json') { p.json = true; continue; }
    positional.push(a);
  }
  if (positional.length > 0) { p.file = positional[0]; }
  return p;
}

// ── 从 SVG 里抽卡片 ─────────────────────────────────────────────────────────

/** 卡片矩形的正则：render.photoCardSvg 的外层矩形（rx="2"，fill 是 6 位十六进制）。 */
const CARD_RE = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="2" fill="#[0-9A-Fa-f]{6}"/g;

/** 画布尺寸：<svg … width="720" height="1440" … viewBox="0 0 360 720">。 */
function readCanvas(svg: string): { w: number; h: number; scale: number } {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const wh = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  const w = vb === null ? 0 : parseFloat(vb[1]);
  const h = vb === null ? 0 : parseFloat(vb[2]);
  const sw = wh === null ? w : parseFloat(wh[1]);
  const scale = w > 0 ? sw / w : 1;
  return { w, h, scale };
}

function readCards(svg: string): Card[] {
  const out: Card[] = [];
  let m = CARD_RE.exec(svg);
  let i = 0;
  while (m !== null) {
    out.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), w: parseFloat(m[3]), h: parseFloat(m[4]), id: `#${i}` });
    i++;
    m = CARD_RE.exec(svg);
  }
  return out;
}

// ── 几何 ────────────────────────────────────────────────────────────────────

const EPS = 0.05;                      // pt：小于它的越界算贴边
const EPS_AREA = HANG_OVERLAP_EPS;     // pt²：**与布局判据同一个常量**，见 render.ts 的注释

function overlapArea(a: Card, b: Card): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) { return 0; }
  return ox * oy;
}

/** 卡片伸到画布外的面积（pt²）。 */
function outsideArea(c: Card, w: number, h: number): number {
  const ix = Math.min(c.x + c.w, w) - Math.max(c.x, 0);
  const iy = Math.min(c.y + c.h, h) - Math.max(c.y, 0);
  const inside = ix > 0 && iy > 0 ? ix * iy : 0;
  return c.w * c.h - inside;
}

/**
 * 卡片的**并集覆盖面积**（pt²）——精确值，不是采样估计。
 *
 * 算法（矩形并集的经典扫描法，O(n² log n)，n ≤ 几十，够快）：
 *   1. 取所有卡片的左右边界（钳进画布）去重排序 → 切成若干竖直窄条；
 *   2. 每条窄条内，把覆盖它的卡片投影成 y 区间、合并重叠区间 → 得到这条窄条的 y 覆盖长；
 *   3. 窄条宽 × y 覆盖长 求和。
 * 不用网格采样：采样的边界格子会整格计入，误差可达几十 pt²，就**没法拿它跟"卡片总面积"
 * 放在一起核对了**（采样值甚至可能大于总和，那看着像 bug）。
 */
function unionArea(cards: CardRect[], w: number, h: number): number {
  const xs: number[] = [];
  for (const c of cards) {
    const l = Math.max(0, c.x);
    const r = Math.min(w, c.x + c.w);
    if (r > l) { xs.push(l, r); }
  }
  xs.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const v of xs) { if (uniq.length === 0 || v - uniq[uniq.length - 1] > 1e-9) { uniq.push(v); } }
  let total = 0;
  for (let i = 0; i + 1 < uniq.length; i++) {
    const x0 = uniq[i];
    const x1 = uniq[i + 1];
    const mid = (x0 + x1) / 2;
    const spans: number[][] = [];
    for (const c of cards) {
      if (c.x <= mid && mid <= c.x + c.w) {
        spans.push([Math.max(0, c.y), Math.min(h, c.y + c.h)]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let yLen = 0;
    let curS = 0;
    let curE = -1;
    for (const s of spans) {
      if (s[1] <= s[0]) { continue; }
      if (s[0] > curE) {
        if (curE > curS) { yLen += curE - curS; }
        curS = s[0];
        curE = s[1];
      } else if (s[1] > curE) {
        curE = s[1];
      }
    }
    if (curE > curS) { yLen += curE - curS; }
    total += (x1 - x0) * yLen;
  }
  return total;
}

/** r 落在 [y0,y1] 内的部分的高度（用于分区覆盖统计）。 */
function bandOverlap(r: CardRect, y0: number, y1: number, w: number): number {
  const ix = Math.min(r.x + r.w, w) - Math.max(r.x, 0);
  const iy = Math.min(r.y + r.h, y1) - Math.max(r.y, y0);
  if (ix <= 0 || iy <= 0) { return 0; }
  return ix * iy;
}

/** 只保留 y ∈ [y0,y1] 的那一段（把卡片裁到分区里），用于分区覆盖的精确并集。 */
function clipBand(cards: CardRect[], y0: number, y1: number, w: number): CardRect[] {
  const out: CardRect[] = [];
  for (const c of cards) {
    const top = Math.max(c.y, y0);
    const bot = Math.min(c.y + c.h, y1);
    if (bot > top) { out.push({ x: c.x, y: top, w: c.w, h: bot - top, id: c.id }); }
  }
  return out;
}

/**
 * 某一条横带 `y ∈ [y0,y1]` 内的卡片并集覆盖面积（pt²）。
 *
 * 为什么不直接把 `y0,y1` 传给 `unionArea`：那个函数的 `h` 是**绝对**画布高（它按 `[0,h]` 钳制），
 * 而地图框在 task-14 之后**不再从 y=0 开始**（它居中在块里，y=226.14）。
 * 直接把 `h=mapH` 传进去会让 y 区间倒挂、整条带被算成 0（一个不会报错的静默错误，
 * 第一版就撞上了：地图框内覆盖 0% / 挂载区内覆盖 0%）。所以先把这一段**搬到原点**再量。
 */
function bandUnion(cards: CardRect[], y0: number, y1: number, w: number): number {
  if (!(y1 > y0)) { return 0; }
  return unionArea(clipBand(cards, y0, y1, w).map((c) => ({ x: c.x, y: c.y - y0, w: c.w, h: c.h, id: c.id })), w, y1 - y0);
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function main(): number {
  const p = parseArgs(process.argv.slice(2));
  if (p.file.length === 0) {
    console.error('用法：node --experimental-strip-types tools/wall-audit.ts <预览.svg> [--json]');
    return 2;
  }
  if (!fs.existsSync(p.file)) {
    console.error(`找不到 ${p.file} —— 先跑 tools/render-preview.ts`);
    return 2;
  }
  const svg = fs.readFileSync(p.file, 'utf8');
  const canvas = readCanvas(svg);
  const cards = readCards(svg);

  // 分区：从**图例**里读（预览写的是「地图块 0→720pt」与「地图框 360×267.72pt@(0,226.14)」）。
  // 为什么不再靠底色矩形区分：task-14 之后地图块（整块主体区）与地图框是**同一个底色**
  //（设备侧也一样），靠两种颜色去区分会让"预览与真机同色"这条性质失效。
  // 图例是预览自己写的、带单位的一行文本，比颜色更稳。
  const frameMatch = /地图框 ([\d.]+)×([\d.]+)pt@\((-?[\d.]+),(-?[\d.]+)\)/.exec(svg);
  const frame = frameMatch === null
    ? { x: 0, y: 0, w: canvas.w, h: canvas.h }
    : { x: parseFloat(frameMatch[3]), y: parseFloat(frameMatch[4]), w: parseFloat(frameMatch[1]), h: parseFloat(frameMatch[2]) };
  const mapH = frame.h;
  const mapY = frame.y;
  const blockMatch = /地图块 0→([\d.]+)pt/.exec(svg);
  const blockH = blockMatch === null ? canvas.h : parseFloat(blockMatch[1]);
  const mapHShown = mapH;
  // 挂载区底：从图例里读（预览写的是 "挂载区 a→b pt"）
  const hangMatch = /挂载区 [\d.]+→([\d.]+)pt/.exec(svg);
  const hangBottom = hangMatch === null ? canvas.h : parseFloat(hangMatch[1]);

  // 出画布
  const outside: Card[] = [];
  for (const c of cards) { if (outsideArea(c, canvas.w, canvas.h) > EPS) { outside.push(c); } }

  // 两两重叠
  const pairs: { a: Card; b: Card; area: number }[] = [];
  let maxSubEps = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = overlapArea(cards[i], cards[j]);
      if (a > EPS_AREA) { pairs.push({ a: cards[i], b: cards[j], area: a }); }
      else if (a > maxSubEps) { maxSubEps = a; }
    }
  }
  const overlaps = pairs.reduce((s, q) => s + q.area, 0);

  // 空间利用（并集面积是精确值，见 unionArea 的注释）
  const cardArea = cards.reduce((s, c) => s + c.w * c.h, 0);
  const boardArea = canvas.w * canvas.h;
  const frameTop = mapY;
  const frameBottom = mapY + mapH;
  const hangH = hangBottom - frameBottom;
  const mapArea = canvas.w * mapH;
  const hangArea = canvas.w * (hangH > 0 ? hangH : 0);
  const covered = unionArea(cards, canvas.w, canvas.h);
  const coveredMap = bandUnion(cards, frameTop, frameBottom, canvas.w);
  const coveredHang = bandUnion(cards, frameBottom, hangBottom, canvas.w);
  let cardInHang = 0;
  for (const c of cards) { cardInHang += bandOverlap(c, frameBottom, hangBottom, canvas.w); }

  // 钉点与 +N 角标（用于报告"收成点"的数量）
  const dots = svg.split('<circle ').length - 1;
  const plusN = (svg.match(/>\+\d+</g) || []).length;
  const lines = svg.split('<line ').length - 1;
  // 轨迹折线：预览把它画在 <g id="trajectory"> 里的一条 path
  const trackMatch = /<g id="trajectory">\s*<path d="([^"]*)"/.exec(svg);
  const trackPts = trackMatch === null ? 0 : (trackMatch[1].match(/[ML]/g) || []).length;

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const c of cards) {
    if (c.y < minY) { minY = c.y; }
    if (c.y + c.h > maxY) { maxY = c.y + c.h; }
    if (c.x < minX) { minX = c.x; }
    if (c.x + c.w > maxX) { maxX = c.x + c.w; }
  }

  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const pct = (v: number, base: number): number => (base > 0 ? r2((v / base) * 100) : 0);
  const out = {
    file: path.relative(process.cwd(), p.file),
    canvas: { w: canvas.w, h: canvas.h, px: `${canvas.w * canvas.scale}x${canvas.h * canvas.scale}` },
    partition: {
      blockH: r2(blockH),
      mapX: r2(frame.x),
      mapY: r2(mapY),
      mapW: r2(frame.w),
      mapH: r2(mapHShown),
      mapPct: pct(mapHShown, canvas.h),
      hangTop: r2(frameBottom),
      hangBottom: r2(hangBottom),
      hangH: r2(hangBottom - frameBottom),
      hangPct: pct(hangBottom - frameBottom, canvas.h)
    },
    cards: cards.length,
    trackPoints: trackPts,
    cardOut: outside.length,
    cardOutDetail: outside.map((c) => `${c.id} x=${r2(c.x)} y=${r2(c.y)} 右=${r2(c.x + c.w)} 下=${r2(c.y + c.h)}`),
    overlapPairs: pairs.length,
    overlapThreshold: EPS_AREA,
    maxOverlapBelowThreshold: r2(maxSubEps),
    overlapArea: r2(overlaps),
    overlapDetail: pairs.slice(0, 20).map((q) => `${q.a.id}×${q.b.id} ${r2(q.area)}pt²`),
    lines,
    dots: dots / 2,
    plusN,
    cardArea: r2(cardArea),
    cardAreaPct: pct(cardArea, boardArea),
    coveredArea: r2(covered),
    coveredPct: pct(covered, boardArea),
    blankPct: r2(100 - pct(covered, boardArea)),
    mapCoveredPct: pct(coveredMap, mapArea),
    hangCoveredPct: pct(coveredHang, hangArea),
    cardInHangPct: pct(cardInHang, cardArea),
    cardSpanX: cards.length === 0 ? null : [r2(minX), r2(maxX)],
    cardSpanY: cards.length === 0 ? null : [r2(minY), r2(maxY)]
  };

  if (p.json) {
    console.log(JSON.stringify(out, null, 2));
    return out.cardOut === 0 && out.overlapPairs === 0 ? 0 : 1;
  }

  console.log(`文件：${out.file}（画布 ${out.canvas.w}×${out.canvas.h}pt → ${out.canvas.px}px）`);
  console.log(`分区：地图块 0→${out.partition.blockH}pt（地图是整块主体区的底色）`
    + ` ｜ 地图框 ${out.partition.mapW}×${out.partition.mapH}pt@(${out.partition.mapX},${out.partition.mapY})（${out.partition.mapPct}%）`
    + ` ｜ 挂载区 ${out.partition.hangTop}→${out.partition.hangBottom}pt（${out.partition.hangH}pt，${out.partition.hangPct}%）`);
  console.log(`照片卡片 ${out.cards} 张 ｜ 挂线 ${out.lines} 条 ｜ 轨迹 ${out.trackPoints} 点 ｜ 钉点 ${out.dots} 个 ｜ +N 角标 ${out.plusN} 个`);
  if (out.cardSpanY !== null && out.cardSpanX !== null) {
    console.log(`  卡片横向跨度 x ∈ [${out.cardSpanX[0]}, ${out.cardSpanX[1]}] ｜ 纵向跨度 y ∈ [${out.cardSpanY[0]}, ${out.cardSpanY[1]}]`);
  }
  console.log(`出画布的照片框：${out.cardOut} 张` + (out.cardOut === 0 ? '  ✓' : '  ✗'));
  for (const d of out.cardOutDetail) { console.log(`    ${d}`); }
  console.log(`两两重叠：${out.overlapPairs} 对（判据：交集面积 > ${out.overlapThreshold}pt²），交集面积合计 ${out.overlapArea}pt²`
    + (out.overlapPairs === 0 ? '  ✓' : '  ✗'));
  if (out.overlapPairs === 0) {
    console.log(`  阈值以下的残余最大相交 ${out.maxOverlapBelowThreshold}pt²（约 ${r2(out.maxOverlapBelowThreshold / (34 * 44) * 10000) / 100}% 张卡片，2 倍图上 < 1px）`);
  }
  for (const d of out.overlapDetail) { console.log(`    ${d}`); }
  console.log(`空间利用：卡片总面积 ${out.cardArea}pt²（占整块画布 ${out.cardAreaPct}%）`);
  console.log(`  并集覆盖 ${out.coveredArea}pt²（整块画布 ${out.coveredPct}%，空白 ${out.blankPct}%）`);
  console.log(`  其中地图块内覆盖 ${out.mapCoveredPct}%、挂载区内覆盖 ${out.hangCoveredPct}%`
    + ` ｜ 卡片面积的 ${out.cardInHangPct}% 落在挂载区（其余压在地图上，是"照片挂在钉子上"的必然）`);
  return out.cardOut === 0 && out.overlapPairs === 0 ? 0 : 1;
}

process.exitCode = main();
