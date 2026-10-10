/**
 * 动图（多帧图片）的**纯逻辑**：疑似判据、帧数上限、每帧解码尺寸预算、帧数组释放。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────────────
 * 刷卡页要「支持动图」，而这件事有三个**判定**必须与平台调用分开，才能被单测锁住：
 *   1) 哪些 URI 值得去探测帧数（后缀白名单）—— 探测要开文件、读文件头，不能对每张卡都做；
 *   2) 几张帧以内才允许整段解帧 —— SDK 明确警告 `createPixelMapList` 会**一次解出全部帧**；
 *   3) 解帧的目标尺寸 —— 只有它能把「一张 1080p 的 50 帧 GIF」从几百 MB 压回可承受的量级。
 *
 * ── 本文件不 import 任何 `@kit.*` ───────────────────────────────────────────
 * 只依赖语言内建，所以 Node 单测可以直接跑它
 * （`node --experimental-strip-types --test core/anim.test.ts`）。
 * 平台侧（`fileIo` / `image` / `AnimatedDrawableDescriptor`）全部在 `data/animSource.ets`。
 *
 * ── 关键平台事实（本次实读 SDK，见报告 §1）──────────────────────────────────
 *   · `image.d.ts:388`：动图**默认不播**，且播放依赖组件可见性（不可见即停）。
 *   · `@ohos.multimedia.image.d.ts:3253`：`DecodingOptions.sampleSize`
 *     「Currently, the value can only be **1**」—— 它在本 SDK 上**不是**降采样杠杆。
 *   · 真正的降采样杠杆是 `DecodingOptions.desiredSize`（`:3284`），
 *     所以目标尺寸必须**由我们自己算**，这就是 `frameDecodeSize` 存在的原因。
 */

/** 一张解码后帧的尺寸（像素）。`width <= 0` 表示「不知道原图尺寸、给不出目标尺寸」。 */
export interface FrameSize {
  width: number;
  height: number;
}

/**
 * 释放语义的最小结构契约：`PixelMap.release()` 是 `Promise<void>`
 * （`@ohos.multimedia.image.d.ts:5868`），所以这里照抄它的形状。
 *
 * 刻意用**结构类型**而不是 `image.PixelMap`：core 不得 import `@kit.*`
 * （那条路径会让 Node 单测跑不起来）。`PixelMap` 结构相容，所以调用点直接传即可。
 */
export interface FrameLike {
  release(): Promise<void>;
}

/**
 * 「疑似动图」的后缀白名单。**这是最便宜的一道闸**：它不解码、不开文件，
 * 纯字符串判断，用于在**任何 I/O 之前**把绝大多数照片排除掉。
 *
 * ── 为什么是 gif / webp 这两个（而不是把 png/heif 也放进来）──────────────
 *   · `gif`：动图的主要格式，必须收；
 *   · `webp`：动图 webp（表情包/短片段）同样常见，且 SDK 把 GIF/WebP 并列当成
 *     「dynamic images」（`createPixelMapList` 的说明里就是这么写的）；
 *   · **PNG 刻意不收**：`image.d.ts:372` 明确写着 **APNG 不受支持** ——
 *     收进来只会让每一张静态 PNG 都多读一次文件头，换不到任何可播放的动图；
 *   · `heif/heic` 同样不收：动画 HEIF 罕见，而这两个后缀在真实相册里占比很高，
 *     收进来等于把探测成本摊到大量普通照片上。
 *   · 代价（写进报告，不藏）：**静态 webp 会多做一次文件头探测**。
 *     这是可接受的：一次 `getFrameCount()` 只读文件头，且结论被缓存（见下）。
 *
 * 判据顺序刻意与"权威判据"分开：本函数只是**筛选**，
 * 「到底是不是动图」的权威判据永远是 `getFrameCount() > 1`（见 `shouldDecodeFrames`）。
 */
export const ANIM_EXTENSIONS: string[] = ['gif', 'webp'];

/**
 * 最多允许整段解帧的帧数。超过它就走**静态退路**（显示第一帧），不是报错。
 *
 * 依据（SDK `createPixelMapList` 的 NOTE）：该函数**一次解出全部帧**
 * （「This function decodes all frames at once ... can lead to significant memory usage」）。
 * 于是帧数直接乘在内存上：240 帧 × 每帧 1 Mpx × 4 字节 ≈ 960 MB，必然 OOM。
 * 240 这个值配合下面的总预算，把最坏情况钉在约 12 Mpx（≈48 MB RGBA）以内。
 *
 * 另一个事实：真实的长动图多半是"录屏/长片段"导出，用户要的是"看它在动"，
 * 而不是逐帧研究 —— 静态第一帧是**优雅降级**，比 OOM 崩溃好得多。
 */
export const MAX_ANIM_FRAMES: number = 240;

/**
 * 一次动图**全部帧加起来**的像素预算（12 Mpx ≈ 48 MB RGBA_8888）。
 *
 * 这个数是被"手机上还能活"倒推出来的：RGBA_8888 每像素 4 字节，
 * 12 Mpx × 4 B = 48 MB，加解码器自身的缓冲仍在单进程可承受范围。
 * 它由 `framePixelBudget` 摊到每一帧上，所以**帧数越多、每帧越小**。
 */
export const ANIM_TOTAL_PIXEL_BUDGET: number = 12000000;

/** 单帧像素**下限**（160×160）。摊到比这还小就没有观看价值了 —— 宁可多占内存也不给马赛克。 */
export const ANIM_MIN_FRAME_PIXELS: number = 25600;

/** 单帧像素**上限**（1024×1024 ≈ 卡片在 3x 屏上的实际像素量），帧数很少时不必超过它。 */
export const ANIM_MAX_FRAME_PIXELS: number = 1048576;

/**
 * 这个 URI **疑似**动图吗？（后缀白名单）
 *
 * 处理的三件真实形态（都不是编造的，是"相册 URI 不带干净后缀"的常见来源）：
 *   1) **大小写**：`IMG_001.GIF` —— 后缀判断必须小写化，否则漏掉一半；
 *   2) **query / fragment**：媒体 URI 可以带 `?networkid=...`、`#frag`，
 *      直接对整串取后缀会得到 `gif?networkid=1` 这种假后缀 → 必须先把它们切掉；
 *   3) **没有后缀**：`file://media/Photo/12/xxx` —— 返回 `false`（**这是刻意的**）。
 *
 * ── 关于第 3 条的取舍（必须写明白）────────────────────────────────────────
 *   本函数是"快速筛选"，权威判据是 `getFrameCount()`。若对**所有**照片都调
 *   `getFrameCount()`（才能真正兜住"没有后缀的动图"），代价是每一张卡都要开文件、
 *   读文件头 —— 而刷卡页的核心体验是"翻得快"，这个代价换不来足够的收益。
 *   所以残留缺口是：**后缀不可识别的多帧图会显示第一帧**。
 *   这是**优雅降级**（静态图照常显示，不白屏、不报错），不是功能缺失。
 *
 * 契约（单测逐条钉住）：空串 / 无点 / 点在首位（`.gif` 是隐藏文件名，不是后缀）/
 * 点在末位（`a.`）→ 一律 `false`；`a.gif` / `a.GIF` / `a.gif?x=1` → `true`。
 */
export function isAnimatedCandidate(uri: string): boolean {
  if (typeof uri !== 'string' || uri === '') { return false; }
  let path: string = uri;
  const q: number = path.indexOf('?');
  if (q >= 0) { path = path.substring(0, q); }
  const h: number = path.indexOf('#');
  if (h >= 0) { path = path.substring(0, h); }
  // 只看**最后一段路径**的最后一个点：目录名里带点（`/v1.2/a.jpg`）不能当后缀。
  const slash: number = path.lastIndexOf('/');
  const name: string = slash >= 0 ? path.substring(slash + 1) : path;
  const dot: number = name.lastIndexOf('.');
  // dot <= 0：没有点（`a`），或点在首位（`.gif` —— 那是隐藏文件的名字，没有后缀）。
  if (dot <= 0) { return false; }
  const ext: string = name.substring(dot + 1).toLowerCase();
  if (ext === '') { return false; }
  for (let i = 0; i < ANIM_EXTENSIONS.length; i++) {
    if (ext === ANIM_EXTENSIONS[i]) { return true; }
  }
  return false;
}

/**
 * 帧数是否落在「值得整段解帧」的区间里。**这是"到底是不是动图"的权威判据**。
 *
 * 两个条件缺一不可：
 *   · `count > 1` —— 静态图的 `getFrameCount()` 恒为 1；
 *     这正是"不能只看文件名后缀"的落点：`screenshot_xxx.gif` 也可以是一张静态 GIF。
 *   · `count <= MAX_ANIM_FRAMES` —— 超过就退回静态第一帧（理由见该常量的说明）。
 *
 * 非有限值（NaN / Infinity，来自坏文件或坏 API）一律 `false`：宁可当静态图，也不拿它去乘内存。
 */
export function shouldDecodeFrames(frameCount: number): boolean {
  if (!Number.isFinite(frameCount)) { return false; }
  return frameCount > 1 && frameCount <= MAX_ANIM_FRAMES;
}

/**
 * 把总预算摊到每一帧：`总预算 / 帧数`，再夹在 `[下限, 上限]` 之间。
 *
 * 两个夹子的作用各不相同，都不是装饰：
 *   · **下限**：帧数极大时（240 帧）摊出来是 50000 px/帧 ≈ 224×224。
 *     不设下限的话，一张 500 帧的图会被摊成 24×24 —— 那不叫降级，叫马赛克。
 *     设了下限，总内存可能略超总预算（240 × 25600 = 6.1 Mpx，仍在同一量级），这是**有意的**取舍。
 *   · **上限**：帧数很少时（2 帧）摊出来是 6 Mpx/帧 = 2500×2500，
 *     比卡片实际需要大一个数量级，纯属浪费 —— 卡在 1024×1024。
 *
 * 非法帧数（NaN / ≤ 0）返回下限：调用点本来就不该走到这里，给它一个"最小的能用值"
 * 比返回 0（会让 `frameDecodeSize` 退化）更有用。
 */
export function framePixelBudget(frameCount: number): number {
  if (!Number.isFinite(frameCount) || frameCount <= 0) { return ANIM_MIN_FRAME_PIXELS; }
  const per: number = ANIM_TOTAL_PIXEL_BUDGET / frameCount;
  if (per < ANIM_MIN_FRAME_PIXELS) { return ANIM_MIN_FRAME_PIXELS; }
  if (per > ANIM_MAX_FRAME_PIXELS) { return ANIM_MAX_FRAME_PIXELS; }
  return Math.floor(per);
}

/**
 * 按像素预算算**解码目标尺寸**（喂给 `DecodingOptions.desiredSize`）。
 *
 * 这是本批唯一能真正降低动图内存的杠杆 —— `sampleSize` 在本 SDK 上只能为 1
 * （见文件头）。语义三条：
 *   1) **保持宽高比**：desiredSize 的文档只说"stretched or scaled to the specified size"，
 *      宽度比若被写坏会把动图拉变形；自己按比例算就不依赖它的内部取舍；
 *   2) **不放大**：原图已经小于预算时原样返回 —— 放大只会更糊、更占内存；
 *   3) **退化输入返回 `{0, 0}`**，含义是「给不出目标尺寸」（原图宽高未知/非法）。
 *      调用点据此**不传 desiredSize**（让它按原图解），而不是传一个 0×0（那是非法参数）。
 *
 * 边界：极小预算下 `floor` 可能得 0 → 强制为 1（`0` 是非法尺寸，会让解码报 401/62980115）。
 * 单测逐条钉住：比例保持、不放大、下限 1、退化输入。
 */
export function frameDecodeSize(srcW: number, srcH: number, budgetPx: number): FrameSize {
  const bad: FrameSize = { width: 0, height: 0 };
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) { return bad; }
  if (srcW <= 0 || srcH <= 0) { return bad; }
  if (!Number.isFinite(budgetPx) || budgetPx <= 0) { return bad; }
  const srcPixels: number = srcW * srcH;
  if (srcPixels <= budgetPx) {
    // 不放大：原图就够小，原样解（desiredSize = 原尺寸 等价于"不缩放"）
    return { width: Math.floor(srcW), height: Math.floor(srcH) };
  }
  const f: number = Math.sqrt(budgetPx / srcPixels);
  const w: number = Math.floor(srcW * f);
  const h: number = Math.floor(srcH * f);
  return { width: w < 1 ? 1 : w, height: h < 1 ? 1 : h };
}

/**
 * 释放一批帧，返回**成功发起释放**的帧数（用于日志与真机核验）。
 *
 * ── 为什么这个函数值得存在（而不是在调用点写个 for 循环）────────────────────
 *   它是本任务**最容易出泄漏**的地方，而它恰好可以做成纯函数并单测：
 *   三条必须成立的性质，用假对象就能钉住，不需要真机：
 *     1) **单帧失败不阻断其余帧** —— 漏一帧只是漏一点内存，中断整批会把大头留下；
 *     2) **`release()` 抛同步异常**（已释放过的 PixelMap 会这样）不影响后续帧；
 *     3) **`release()` 返回的 Promise 被拒绝**也不产生未处理的 rejection
 *        （未处理的 rejection 在真机上会打一堆错日志，甚至触发未捕获异常处理）。
 *   真机上"释放有没有真的发生"无法用单测证明（要 Profiler），但**释放的编排**可以。
 *
 * 不 await：`PixelMap.release()` 的 NOTE 明确写了
 * 「memory ... is reclaimed **only after all managing ArkTS objects have relinquished their control**」
 * —— 即释放是"我放手"，native 内存由所有持有者共同决定何时回收。
 * 所以这里同步放开引用、不为每个 Promise 加一次 await 往返（帧数可达数百）。
 */
export function releaseAll(frames: FrameLike[]): number {
  if (frames === undefined || frames === null) { return 0; }
  let n: number = 0;
  for (let i = 0; i < frames.length; i++) {
    const f: FrameLike = frames[i];
    if (f === undefined || f === null) { continue; }
    try {
      const p: Promise<void> = f.release();
      if (p !== undefined && p !== null) {
        // 吞掉拒绝：释放失败不该冒泡成未处理 rejection（理由见上第 3 条）
        p.catch((): void => {});
      }
      n = n + 1;
    } catch (e) {
      // 单帧失败不影响其余帧（理由见上第 1 条）
    }
  }
  return n;
}
