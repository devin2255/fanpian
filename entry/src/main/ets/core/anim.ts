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

// ── 装载流水线：判定留在这里，平台调用从外面注入 ──────────────────────────────
//
// ── 这一段为什么必须存在（本批缺陷 D3 的修法）─────────────────────────────────
//   缺陷形态：`data/animSource.ets` 的 `catch`（内存不足 / 解码失败）与
//   `createPixelMapList` 返回空这两支**也**写了永久负缓存 `confirmedStatic`。
//   而 `createPixelMapList` 的官方 NOTE 是「一次解出全部帧 … can lead to significant
//   memory usage」—— 它的头号成因就是**内存压力**（解码器 OOM / fd 耗尽 / 文件被占用），
//   全是瞬时的。于是"刷到一张大 GIF、恰逢内存吃紧"会把这张图永久钉成静态图，
//   用户没有任何重试入口，而日志只打过一行、与"第一次就没播"完全同形。
//
//   修法 = **只对确定性结论写负缓存**。但"哪次失败算确定"这件事写在平台层里就
//   **无法被单测证明**（`fileIo` / `image` 在 Node 上不存在）。所以这里把流水线整个
//   搬进 core，平台能力经 `AnimIo` 注入：`data/animSource.ets` 只剩一层薄适配
//   （SDK 调用 + 日志 + 组装 descriptor），而"第一次抛错、第二次成功"这条断言
//   可以用假 `AnimIo` 在 Node 上**真跑一遍**。
//
// ── 负缓存的两支保留 / 三支去掉（逐条对应本文件里的写入点）───────────────────
//   保留（**确定性结论**：这张确实没有可播放的多帧）：
//     · `ANIM_STATIC_FEW_FRAMES` —— `getFrameCount()` 成功返回且 `<= 1`（或超帧数上限）；
//     · `ANIM_STATIC_ORIENTATION` —— 成功拿到方向、判定需要静态路径摆正。
//   去掉（**没探到**：瞬时/环境，下次滑回来必须再试一次）：
//     · `ANIM_NO_HANDLE` —— 平台给不出 ImageSource 句柄；
//     · `ANIM_EMPTY_FRAMES` —— `createPixelMapList` 返回空（内存压力的头号形态）；
//     · `ANIM_FAILED` —— 任何抛错（OOM / fd 耗尽 / 文件被占用 / 格式不支持）。
//   代价（与 `data/movingPhotoSource.ets` 的开头论证同取舍）：坏文件每次滑回来会重试一次。
//   这是**故意**付的：宁可多开一次文件，也不要一个永久错误的结论。

/** 连后缀白名单都没过（连文件都不开）。 */
export const ANIM_NOT_CANDIDATE: string = 'not-candidate';
/** 负缓存命中：这张之前已经**确定**没有可播放的多帧。 */
export const ANIM_CACHED_STATIC: string = 'cached-static';
/** **确定性结论**：`getFrameCount()` 成功，但不是 2..MAX_ANIM_FRAMES。 */
export const ANIM_STATIC_FEW_FRAMES: string = 'static-few-frames';
/** **确定性结论**：方向需要静态路径摆正，播出来会躺下。 */
export const ANIM_STATIC_ORIENTATION: string = 'static-orientation';
/** **没探到**：平台给不出 ImageSource 句柄。 */
export const ANIM_NO_HANDLE: string = 'no-handle';
/** **没探到**：`createPixelMapList` 返回空（内存压力 / 解码器资源不足）。 */
export const ANIM_EMPTY_FRAMES: string = 'empty-frames';
/** **没探到**：任何抛错（OOM / fd 耗尽 / 文件被占用 / 格式不支持）。 */
export const ANIM_FAILED: string = 'failed';
/** 成功解出可播放的多帧。 */
export const ANIM_READY: string = 'ready';

/**
 * 这个结局是不是**确定性结论**（这张确实没有可播放的多帧）？
 *
 * **这是负缓存的唯一判据** —— 调用点不许再自己写一份分支，否则"哪次失败算确定"
 * 就有了两个真相来源，而 D3 正是这么来的（平台层的 catch 里写了一个隐式的答案）。
 */
export function isStaticConclusion(outcome: string): boolean {
  return outcome === ANIM_STATIC_FEW_FRAMES || outcome === ANIM_STATIC_ORIENTATION;
}

/**
 * 一个**已打开**的图片源句柄。方法名与 SDK `image.ImageSource` 的对应关系是刻意的
 * （语义逐个相同），但类型刻意不引用它 —— core 不得 import `@kit.*`。
 *
 * `TFrame` 是**帧的具体类型**：真实现里是 `image.PixelMap`（组装 descriptor 时必须这个类型），
 * 单测里是一个假帧。core 只要求它满足 `FrameLike`（够用来释放），别的一概不问。
 */
export interface AnimSourceHandle<TFrame extends FrameLike> {
  /** SDK `ImageSource.getFrameCount()`。**权威判据的输入**。可能抛。 */
  getFrameCount(): Promise<number>;
  /** SDK `ImageSource.getImageInfo().size`（只读文件头，不解码像素）。可能抛。 */
  getImageSize(): Promise<FrameSize>;
  /** 方向标签（EXIF/TIFF Orientation 的字符串形式；读不到返回空串）。**不抛**。 */
  getOrientation(): Promise<string>;
  /** SDK `ImageSource.createPixelMapList(opts)`。**空数组 = 一帧都没解出来**。可能抛。 */
  createPixelMapList(target: FrameSize): Promise<TFrame[]>;
  /** SDK `ImageSource.getDelayTimeList()`。拿不到返回空数组（不抛）。 */
  getDelayTimeList(): Promise<number[]>;
  /** 释放句柄（`ImageSource.release()` + `closeSync(fd)`）。**必须不抛、幂等**。 */
  close(): Promise<void>;
}

/**
 * 平台端口：`data/animSource.ets` 是它唯一的**真实现**，单测注入假实现。
 * 只开文件、只给句柄 —— 句柄的生命周期由 `decodeAnim` 的 `finally` 统一兜底。
 */
export interface AnimIo<TFrame extends FrameLike> {
  /** 打开一张照片。返回 undefined = 平台给不出句柄。**可能抛**（打不开 / OOM）。 */
  open(uri: string): Promise<AnimSourceHandle<TFrame> | undefined>;
}

/** 解好的帧与元数据（**还没有 descriptor**：平台对象由平台层拿到这个之后才组装）。 */
export interface AnimDecoded<TFrame extends FrameLike> {
  /** 解出来的全部帧。**所有权交给调用者**。 */
  frames: TFrame[];
  /** 每帧时长；长度与 `frames` 不一致时为空数组（交给默认节奏，见 data/animSource 的说明）。 */
  durations: number[];
  srcW: number;
  srcH: number;
  frameCount: number;
  /** 实际喂给 `desiredSize` 的目标尺寸（真机核验"有没有按 desiredSize 解"的证据）。 */
  targetW: number;
  targetH: number;
  /** 这一帧的像素预算（`framePixelBudget(count)` 的结果，进日志）。 */
  budget: number;
}

/** 一次装载尝试的结果：产物 + 结局码 + 只用于日志的补充文本。 */
export interface AnimDecodeResult<TFrame extends FrameLike> {
  decoded: AnimDecoded<TFrame> | undefined;
  outcome: string;
  detail: string;
}

/** 把 catch 到的值转成一行可打印文本（与平台层的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/** 结局结果的小工厂（避免在每个 return 点重复三行字面量）。 */
function outcomeOf<TFrame extends FrameLike>(
  decoded: AnimDecoded<TFrame> | undefined, outcome: string, detail: string
): AnimDecodeResult<TFrame> {
  return { decoded: decoded, outcome: outcome, detail: detail };
}

/**
 * 读一张照片的动图帧。**不抛错**：任何失败都返回 `decoded: undefined`，
 * 调用点据此显示静态图（第一帧或原 URI）—— 即"解析失败 → 退回静态"，绝不白屏。
 *
 * 三道闸，按代价从低到高，**顺序不可换**（换了就白花钱）：
 *   1) 后缀白名单（纯字符串，见 `isAnimatedCandidate`）；
 *   2) 负缓存（这张已**确定**没有多帧）；
 *   3) 开文件 + `getFrameCount()`（**权威判据**）→ `getImageSize()` → `createPixelMapList()`。
 *
 * `staticCache` 由调用点持有（core 保持无状态）。
 *
 * ── D3 的修法就是**下面这一行 if** ────────────────────────────────────────────
 *   全函数只有**一个**负缓存写点，判据是 `isStaticConclusion(outcome)`。
 *   改之前有**五个**写点散在平台层的 try/catch/各分支里，"哪次失败算确定"因此
 *   有了一个隐式的、无法被单测的答案 —— 其中三支（给不出句柄 / 一帧都没解出来 /
 *   抛错）记的都是**瞬时**失败（内存压力是 `createPixelMapList` 的头号成因），
 *   于是"刷到一张大 GIF、恰逢内存吃紧"会把这张图**永久**钉成静态图。
 */
export async function decodeAnim<TFrame extends FrameLike>(
  uri: string, io: AnimIo<TFrame>, staticCache: Map<string, boolean>
): Promise<AnimDecodeResult<TFrame>> {
  if (!isAnimatedCandidate(uri)) { return outcomeOf(undefined, ANIM_NOT_CANDIDATE, ''); }
  if (staticCache.get(uri) === true) { return outcomeOf(undefined, ANIM_CACHED_STATIC, ''); }
  const r: AnimDecodeResult<TFrame> = await runDecode(uri, io);
  // **负缓存的唯一写点**：只有确定性结论才写；"没探到"一律不写，下次滑回来会重试。
  if (isStaticConclusion(r.outcome)) { staticCache.set(uri, true); }
  return r;
}

/**
 * 真正干活的那一半：开文件 → 读元数据 → 解帧。**不碰负缓存**（写点唯一，见 `decodeAnim`）。
 * 与 `decodeAnim` 拆开的理由只有一条：让"要不要记成永久结论"成为一个**看得见的**、
 * 只有一处的判据，而不是散在各分支里的五个写入。
 */
async function runDecode<TFrame extends FrameLike>(
  uri: string, io: AnimIo<TFrame>
): Promise<AnimDecodeResult<TFrame>> {
  let handle: AnimSourceHandle<TFrame> | undefined = undefined;
  // 已解出的帧。所有权在**成功构造 AnimDecoded 的那一刻**转移（那之后把它置空，
  // 于是 finally 不会误释放已经交出去的帧）。任何别的路径都由 finally 释放。
  let frames: TFrame[] = [];
  try {
    handle = await io.open(uri);
    if (handle === undefined) {
      // 平台给不出句柄：**没探到**（与下面的 catch 同一口径），绝不写负缓存。
      return outcomeOf(undefined, ANIM_NO_HANDLE, '');
    }
    // ── 权威判据：多帧才算动图 ────────────────────────────────────────────
    // 后缀命中的静态 gif / webp 在这里被挡掉（`shouldDecodeFrames` 要求 count > 1），
    // 并且做帧数上限保护（超上限退回静态第一帧，而不是把内存乘爆）。
    // 这是**确定性结论**（帧数是文件头里的事实）。
    const count: number = await handle.getFrameCount();
    if (!shouldDecodeFrames(count)) {
      return outcomeOf(undefined, ANIM_STATIC_FEW_FRAMES, `帧数=${count}`);
    }
    // ── 原图尺寸：只读文件头，不解码像素 ──────────────────────────────────
    const info: FrameSize = await handle.getImageSize();
    // ── 方向：与静态路径保持一致，不一致就不播（见下）─────────────────────
    const orientation: string = await handle.getOrientation();
    if (!isDisplayOrientationNormal(orientation)) {
      // 静态路径 `Image(uri)` 会按 EXIF/TIFF 方向自动摆正，而我们解出来的帧是**原始像素**。
      // 若不管，同一张照片会"静态时是正的、一播就躺下" —— 这是比"不播"严重得多的故障。
      // 所以这里选择**不播**（退回静态图，方向由框架摆正），而不是去映射旋转角：
      // 旋转只能表达 90/180/270，镜像（orientation 2/4/5/7）根本表达不了，
      // 映射一半反而会造出"有的转有的不转"的更坏形态。
      // 这是**确定性结论**（方向是文件里的事实）。
      return outcomeOf(undefined, ANIM_STATIC_ORIENTATION, orientation);
    }
    // ── 解码尺寸：唯一的降采样杠杆 ────────────────────────────────────────
    // 刻意**不写** `sampleSize`：SDK 文档（`@ohos.multimedia.image.d.ts:3253`）写着
    // 「Sampling size of the thumbnail. The default value is 1. Currently, the value
    //   can only be 1.」—— 它在本 SDK 上不是降采样杠杆。写 0 或 2 只会让人误以为它在起作用。
    // 真正起作用的是 desiredSize，而它必须**自己算**（见 frameDecodeSize）。
    const budget: number = framePixelBudget(count);
    const target: FrameSize = frameDecodeSize(info.width, info.height, budget);
    frames = await handle.createPixelMapList(target);
    if (frames === undefined || frames === null || frames.length === 0) {
      // **没探到**：SDK 明说本函数"一次解出全部帧"，内存压力是它的头号成因。
      // 这一支**不写负缓存**（D3 去掉的第二支）—— 下次滑回来重试一次。
      return outcomeOf(undefined, ANIM_EMPTY_FRAMES, `原图=${info.width}x${info.height}`);
    }
    // ── 每帧时长 ──────────────────────────────────────────────────────────
    // 拿不到不算失败：不传 frameDurations，交给 AnimationOptions.duration 语义。
    let durations: number[] = [];
    const dl: number[] = await handle.getDelayTimeList();
    // 长度必须与帧数一致才用：SDK 说长度不一致时"按总时长摊"，那会让节奏整体变形，
    // 不如干脆不传（交给默认节奏），至少不会越播越偏。
    if (dl !== undefined && dl !== null && dl.length === frames.length) { durations = dl; }
    const decoded: AnimDecoded<TFrame> = {
      frames: frames,
      durations: durations,
      srcW: info.width,
      srcH: info.height,
      frameCount: count,
      targetW: target.width,
      targetH: target.height,
      budget: budget
    };
    // ── 成功：所有权转移，finally 不再释放 ────────────────────────────────
    frames = [];
    return outcomeOf(decoded, ANIM_READY, '');
  } catch (e) {
    // 打不开（URI 失效/已删除）、不是支持的格式、**内存不足**、解码失败 —— 全部走静态退路。
    // ⚠️ 这一支**不写负缓存**（D3 去掉的第一支，也是本缺陷的原始形态）：
    //    这一支里占绝大多数的是**瞬时**失败（解码器 OOM / fd 耗尽 / 文件被占用），
    //    把它记成"这张不是动图"就是一个**不会自愈的静默降级**。
    //    代价是坏文件每次滑回来重试一次 —— 与 data/movingPhotoSource.ets 的开头同取舍。
    return outcomeOf(undefined, ANIM_FAILED, errText(e));
  } finally {
    if (frames.length > 0) { releaseAll(frames); }
    if (handle !== undefined) {
      // close() 按契约不抛；真抛了也不改结论（释放失败不该盖掉真正的失败原因）。
      try { await handle.close(); } catch (e) { /* 释放失败不改结论 */ }
    }
  }
}

/**
 * 读照片的方向标签（EXIF/TIFF Orientation 的字符串形式，如 `"1"` / `"Top-left"`）。
 * 读不到（没有该标签、或平台不支持）返回空串 —— 空串按"正常方向"处理，见下。
 *
 * 平台无关，所以它留在 core：单测能直接钉住"读不到 = 正常方向"这条取舍。
 */
export function normalizeOrientation(v: string | null | undefined): string {
  if (v === undefined || v === null) { return ''; }
  return v;
}

/**
 * 这个方向标签是不是「无需摆正」。
 *
 * 判据刻意取**宽**（只有明确表示"要转/要翻"的值才算不正常）：
 * 平台回传的形态不止一种（数字 `"1"`、也可能是 `"Top-left"` 这类文本），
 * 与其穷举，不如只挡明确异常的几个 —— 判错的代价是"这张不播"（退回静态、方向正确），
 * 比反过来（照播但躺下）轻得多。
 *
 * 空串 = 没有该标签 = 正常（绝大多数动图走这一支）。
 */
export function isDisplayOrientationNormal(orientation: string): boolean {
  if (orientation === '') { return true; }
  if (orientation === '1') { return true; }
  if (orientation === 'Top-left' || orientation === 'TopLeft') { return true; }
  return false;
}
