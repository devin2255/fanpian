/**
 * 刷卡页「照片缩放 / 平移」的**纯逻辑**：缩放上下限与 clamp、Contain 显示尺寸、平移边界。
 *
 * ── 为什么单独一个 core 模块（而不是塞进既有 core/render.ts）────────────────
 *   `render.ts` 里的"缩放"是**地图视野跨度**模型（`viewZoomRange` / `zoomViewAt`：
 *   经纬度跨度、钉数阈值、`MIN_ZOOMED_VIEW_SPAN_DEG`），回答的是"地图现在显示多大范围"；
 *   本文件回答的是"**一张照片**在卡片里放大到几倍、能平移到哪"。
 *   两者的变更理由、输入量纲、边界来源完全不同 —— 合成一个模块只会让
 *   "改照片缩放的手滑改了地图视野"。而且 `render.ts` 已被 27 个用例锁着、本批不许改动。
 *
 * ── 不 import 任何 `@kit.*` ─────────────────────────────────────────────────
 *   纯数学，Node 单测直接跑（`node --experimental-strip-types --test core/zoom.test.ts`）。
 */

/** 一个尺寸（宽高，单位随调用方 —— 本文件只做比例运算，见 `containSize`）。 */
export interface ZoomSize {
  width: number;
  height: number;
}

/** 相对「居中」的平移量（vp）。`x > 0` = 照片向右移。 */
export interface PanOffset {
  x: number;
  y: number;
}

/**
 * 缩放下限 = 1×（**不缩小**）。理由：
 *   "图片支持放大"是用户的原话，没有"缩小"的诉求；若允许缩到 1 以下，
 *   Contain 之下的照片会缩到卡片中间一小块，用户会以为"照片坏了"，
 *   而且这个状态没有任何用途（想看全图，1× 的 Contain 已经就是全图）。
 *   所以下限恒为 1，捏合缩小到 1 就"顶住"。
 */
export const SCALE_MIN: number = 1;

/**
 * 缩放上限 = 4×。理由（三个约束的交点）：
 *   1) **可读性**：手机上 4× 已经能把一张 1200 万像素照片的字/细节看到很清楚；
 *      再往上（8×）看到的全是插值出来的色块 —— 而我们的帧/图是**降采样**解码过的，
 *      放大只会更糊，"放大"的边际收益迅速归零；
 *   2) **可操作性**：Contain 之下照片通常只占卡片的一部分，
 *      放大 4× 后要看到边角只需要平移不到一个卡宽的距离，一指就能到位；
 *   3) **与判据的一致性**：`core/anim.ts` 的单帧像素上限是 1024×1024，
 *      在 3x 屏上约等于一个卡片大小 —— 4× 是这个量级下"还能看"的上界。
 */
export const SCALE_MAX: number = 4;

/**
 * 「算不算已放大」的容差。缩放是浮点连乘出来的（`scaleAtPinchStart * e.scale`），
 * 即使手指原样张合也会得到 1.0000001 或 0.9999998 这种值。
 * 没有容差的话，`isZoomed` 会把"其实还是 1×"误判成放大态 →
 * **翻页手势被静默改成平移**（用户想上滑下一张，卡片却不动）——
 * 这是本批最容易在真机上才暴露的退化，所以容差是必须的，不是保险。
 * 0.01（1%）远小于任何有意为之的放大，又远大于浮点误差。
 */
export const ZOOM_EPS: number = 0.01;

/**
 * 把任意输入夹进 `[SCALE_MIN, SCALE_MAX]`。
 * 非有限值（NaN / ±Infinity）→ `SCALE_MIN`：这是**唯一安全**的取值 ——
 * 一个 NaN 的 scale 会让 `.scale({x: NaN})` 渲染出不可预期的结果（实测各平台行为不一），
 * 而且它一旦进入 `isZoomed` 就会把翻页手势永久变成平移（NaN 的比较恒为 false，
 * 那个方向的失败更隐蔽）。宁可回到 1×，也不要带着 NaN 往下走。
 */
export function clampScale(s: number): number {
  if (!Number.isFinite(s)) { return SCALE_MIN; }
  if (s < SCALE_MIN) { return SCALE_MIN; }
  if (s > SCALE_MAX) { return SCALE_MAX; }
  return s;
}

/**
 * 当前是否处于「放大态」。它决定**一指拖动是平移照片还是翻页**（手势模式开关），
 * 所以判据必须带容差（见 `ZOOM_EPS`）。
 * 非有限值一律 `false`（= 当作 1×，翻页可用）：这是"不把用户锁死"的方向。
 */
export function isZoomed(s: number): boolean {
  if (!Number.isFinite(s)) { return false; }
  return s > SCALE_MIN + ZOOM_EPS;
}

/**
 * `ImageFit.Contain` 之下照片在盒子里的**显示尺寸**。
 *
 * 语义：等比缩放到**刚好装进**盒子（可以放大到顶满，这是 Contain 的定义），
 * 两条边都不超出盒子；照片比盒子"宽"时宽度顶满、上下留边，反之高度顶满、左右留边。
 *
 * ── 输入的单位可以混用（px 与 vp），这是**刻意**的 ───────────────────────────
 *   本函数只用到两个**比例**：`srcW/srcH` 与 `boxW/boxH`。
 *   所以"原图 px 尺寸"与"卡片 vp 尺寸"混着传进来是**安全**的 ——
 *   调用点因此不必去做 px↔vp 换算（那需要一个 density 值，而它在卡片这一层拿不到）。
 *   这一点是设计约束，不是巧合：改动本函数时**不要**引入任何绝对单位运算。
 *
 * 退化输入（任一 ≤ 0 或非有限）→ `{0, 0}`，含义是"算不出显示尺寸"。
 * 调用点据此**禁用平移**（而不是用盒子尺寸顶替 —— 那会让照片被推出去露出底色）。
 */
export function containSize(srcW: number, srcH: number, boxW: number, boxH: number): ZoomSize {
  const bad: ZoomSize = { width: 0, height: 0 };
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) { return bad; }
  if (!Number.isFinite(boxW) || !Number.isFinite(boxH)) { return bad; }
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) { return bad; }
  const srcR: number = srcW / srcH;
  const boxR: number = boxW / boxH;
  if (srcR > boxR) {
    // 照片比盒子更"宽" → 宽度顶满，高度按比例（上下留边）
    return { width: boxW, height: boxW / srcR };
  }
  // 照片比盒子更"高/方" → 高度顶满，宽度按比例（左右留边）
  return { width: boxH * srcR, height: boxH };
}

/**
 * 单轴的平移上界：只有内容被放大到**超出**盒子时才有可平移的余量，否则只能是 0。
 * `max = max(0, (content * scale - box) / 2)` —— 除以 2 是因为内容居中，
 * 往两边各能推出 (超出量 / 2)。
 */
function clampAxis(t: number, content: number, box: number, scale: number): number {
  if (!Number.isFinite(t)) { return 0; }
  if (!Number.isFinite(content) || !Number.isFinite(box)) { return 0; }
  if (content <= 0 || box <= 0) { return 0; }
  const max: number = (content * scale - box) / 2;
  if (max <= 0) { return 0; }
  if (t < -max) { return -max; }
  if (t > max) { return max; }
  return t;
}

/**
 * 把平移量夹到"照片仍然盖满卡片"的范围内。
 *
 * 为什么要它（这是"放大后能不能拖"这件事的关键）：
 *   放大后照片比卡片大，但**不能无限拖** —— 拖过头就会在卡片里露出照片之外的底色，
 *   那与"卡片上出现一块空白"是同一类观感故障。上界由 `(显示尺寸 × scale − 卡片) / 2`
 *   精确给出，所以"拖到边缘就顶住"是**算出来的**，不是试出来的。
 *
 * 三条性质（单测钉住）：
 *   1) `scale == 1`（或内容本来就不超出盒子）→ 恒返回 `{0, 0}`：
 *      **这是缩放复位能自动清掉平移的机制**，也是"1× 时不可能拖出底色"的保证；
 *   2) 幂等：`clampOffset(clampOffset(t)) === clampOffset(t)`；
 *   3) `scale` 非法/内容尺寸算不出（`{0,0}`）→ 返回 `{0, 0}`（禁用平移，方向同 `containSize`）。
 */
export function clampOffset(
  tx: number, ty: number,
  contentW: number, contentH: number,
  boxW: number, boxH: number,
  scale: number
): PanOffset {
  const s: number = clampScale(scale);
  return {
    x: clampAxis(tx, contentW, boxW, s),
    y: clampAxis(ty, contentH, boxH, s)
  };
}

/**
 * `Image.onComplete` 报的「实际绘制内容尺寸」能用吗？
 *
 * 用它之前必须验一次**量纲**，这是本函数存在的唯一理由，而它对应一个真实的坑：
 * `componentWidth/componentHeight` 明确是 vp，`contentWidth/contentHeight` 的文档
 * 只说"the picture that is actually drawn"，**没有写单位**。而它最终要和卡片盒子
 * （`onAreaChange` 量到的 vp）一起算平移余量 —— 若它其实是 px（3x 屏就是 3 倍），
 * 平移余量会大出一个密度倍数：**一拖就把照片推出卡片、露出底色**。
 *
 * 判据是 Contain 的**不变量**：绘制内容一定**装得进**组件（两条边都不超出）。
 * 超出即说明它不同量纲（或不是 Contain 的结果），此时必须弃用它。
 * 容差 0.5vp 是给平台取整留的（"正好铺满"那一支会相等，浮点相等不该被误判）。
 *
 * 四个退化条件也一并挡掉：非有限、≤ 0、盒子未知（w/h 为 0 时无法判量纲，宁可不用）。
 */
function isDrawnSizeUsable(drawnW: number, drawnH: number, boxW: number, boxH: number): boolean {
  if (!Number.isFinite(drawnW) || !Number.isFinite(drawnH)) { return false; }
  if (!Number.isFinite(boxW) || !Number.isFinite(boxH)) { return false; }
  if (drawnW <= 0 || drawnH <= 0) { return false; }
  if (boxW <= 0 || boxH <= 0) { return false; }
  const EPS: number = 0.5;
  return drawnW <= boxW + EPS && drawnH <= boxH + EPS;
}

/**
 * 算出照片**实际绘制尺寸**（平移边界的唯一输入）。三级判定链，从"最忠实"到"最保守"：
 *
 *   1) **框架报的绘制尺寸**（`onComplete` 的 `contentWidth/contentHeight`）——
 *      最忠实：EXIF 旋转、非常规比例、平台自己的 Contain 取整，全都被它算完了。
 *      但它没有文档化的单位（见 `isDrawnSizeUsable`），所以要过一次量纲验证。
 *   2) **自己按固有尺寸算 Contain**（`containSize`）——
 *      动图走这一支（SDK：`onComplete` 对 AnimatedDrawableDescriptor 不触发），
 *      静态图的绘制尺寸不可用时也走这一支。
 *   3) **算不出** → `{0, 0}`：调用点据此**禁用平移**（`clampOffset` 对 {0,0} 恒返回 0）。
 *      这是刻意的保守方向：宁可"放大后不能拖"，也绝不"能拖但一拖就露底色"。
 *
 * 输入单位可以混用（固有尺寸是 px、盒子是 vp），理由见 `containSize` 的说明 ——
 * 本函数只把它们交给同样只做比例运算的 `containSize`。
 */
export function resolveContentSize(
  drawnW: number, drawnH: number,
  srcW: number, srcH: number,
  boxW: number, boxH: number
): ZoomSize {
  if (isDrawnSizeUsable(drawnW, drawnH, boxW, boxH)) {
    return { width: drawnW, height: drawnH };
  }
  return containSize(srcW, srcH, boxW, boxH);
}
