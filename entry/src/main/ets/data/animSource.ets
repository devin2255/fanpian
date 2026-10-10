/**
 * 动图的**平台侧**读取：把 SDK（`fileIo` / `image` / `AnimatedDrawableDescriptor`）
 * 适配成 `core/anim.ts::AnimIo` 端口，再把 core 给出的帧组装成一个**负责释放**的对象。
 *
 * ── 分层（与本项目既有约定一致）─────────────────────────────────────────────
 *   本文件**只有**「开文件 → 调 SDK → 组装 → 释放」这件事。**所有判定规则都在
 *   `core/anim.ts`**（有 Node 单测），包括最关键的那一条 ——「哪次失败算**确定的**
 *   没有多帧、可以记成永久结论」。这条界线与 `data/exifReader.ts` 完全相同：
 *   平台层不可单测（要真机的 fileIo / ImageSource），所以它必须薄到"读一眼就能相信"。
 *
 *   ⚠️ 本批（缺陷 D3）把流水线**整个搬进了 core**，只留下这一层适配。理由不是洁癖：
 *   负缓存写在哪一支里，是一个**必须在 Node 上跑得出来**的事实 —— 旧实现把它写在
 *   本文件的 catch / 各分支里（共 5 处），于是"瞬时失败被记成永久结论"这件事
 *   没有任何可执行的证据。现在写点唯一（`core/anim.ts::decodeAnim` 里那一行 if），
 *   而"第一次抛、第二次仍然能装载"这条断言用假 `AnimIo` 就能真跑一遍。
 *
 * ── 两条官方路径，选 (b) `AnimatedDrawableDescriptor` ───────────────────────
 *   (a) `ImageAnimator` + `ImageFrameInfo[]`；
 *   (b) `AnimatedDrawableDescriptor(frames, options)` → `Image(descriptor)`。
 *   决定性的一条（`@ohos.arkui.drawableDescriptor.d.ts:528-531`）：
 *   **(b) 自带「绑定组件不可见时自动暂停播放」**，(a) 没有这条文档保证
 *   （它的播放状态要靠 `state(AnimationStatus.Running)` 自己驱动）。
 *   其余理由：两条路都要 `createPixelMapList()`（内存画像完全一样），
 *   而 (b) 不改动 `Image` 组件本身 —— `objectFit` / `borderRadius` / 缩放平移的渲染路径
 *   全部沿用既有实现，无需重新验证。
 *
 * ── 帧数组的释放（本任务最容易泄漏的地方）──────────────────────────────────
 *   SDK 明确写了（`@ohos.multimedia.image.d.ts:5856-5859`）：
 *   「Release occurs when an ArkTS object relinquishes control over its associated native object.
 *    The memory occupied by the native object is reclaimed **only after all managing ArkTS
 *    objects have relinquished their control**.」
 *   → 所以**当场 `release()` 是安全的**：渲染管线自己持有的那份引用会让 native 内存
 *   继续存活到它自己放手为止，不会出现"帧被抽走 → Image 渲染已释放内存"。
 *   于是释放路径可以做得短、同步、可枚举：**core 的 `finally` 兜住一切失败路径**，
 *   本文件只有两条自己持有帧的路径（见 `loadAnimFrames` 的两处 releaseAll）。
 */
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AnimatedDrawableDescriptor, AnimationOptions } from '@kit.ArkUI';
import {
  decodeAnim, releaseAll, normalizeOrientation,
  FrameLike, FrameSize, AnimIo, AnimSourceHandle, AnimDecoded, AnimDecodeResult,
  ANIM_STATIC_FEW_FRAMES, ANIM_STATIC_ORIENTATION, ANIM_NO_HANDLE, ANIM_EMPTY_FRAMES, ANIM_FAILED
} from '../core/anim';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 把 catch 到的值转成一行可打印文本（与 core/anim.ts 的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/**
 * 一次动图加载的**所有权对象**。它存在的唯一理由：帧数组必须有一个明确的、
 * 可枚举的释放出口 —— 谁拿到 `AnimFrames`，谁就负责在离开这张卡时调 `release()`。
 *
 * `release()` **幂等**：换卡、卸载、异步竞态三条路径都可能调到同一个对象，
 * 重复释放必须是无害的（第二次直接返回 0，不再碰已经放手过的 PixelMap）。
 * 这一点是有意的设计，不是防御性代码 —— 它让"多调一次"从"潜在崩溃"降级成"无操作"。
 */
export class AnimFrames {
  readonly descriptor: AnimatedDrawableDescriptor;
  /** 原图（第一帧）宽高，px。用于算 Contain 显示尺寸 → 平移边界（见 core/zoom.ts）。 */
  readonly srcW: number;
  readonly srcH: number;
  private frames: FrameLike[];
  private released: boolean = false;

  constructor(descriptor: AnimatedDrawableDescriptor, frames: FrameLike[], srcW: number, srcH: number) {
    this.descriptor = descriptor;
    this.frames = frames;
    this.srcW = srcW;
    this.srcH = srcH;
  }

  /** 释放帧并放弃引用。返回本次真正放手的帧数（重复调用返回 0，便于真机日志核对）。 */
  release(): number {
    if (this.released) { return 0; }
    this.released = true;
    const n: number = releaseAll(this.frames);
    this.frames = [];
    return n;
  }
}

/**
 * 「这张已经**确定**没有可播放的多帧」的缓存，key = photoId（= URI）。
 *
 * 为什么必须有它：探测要开文件、读文件头（`getFrameCount()`），而
 * `core/anim.ts` 的后缀白名单会把**每一张静态 webp** 都送进来。没有缓存的话，
 * 用户每次滑回同一张静态 webp 都要重新探测一遍 —— 这正是工单点名的性能陷阱
 * （「不要对每张卡都调」）。
 *
 * ── 只缓存**确定性结论**（本批缺陷 D3 的修法）────────────────────────────────
 *   写入点**唯一**：`core/anim.ts::decodeAnim` 里 `if (isStaticConclusion(outcome))`。
 *   保留的两支（文件头里的事实，重试一万次也是同一个答案）：
 *     · `ANIM_STATIC_FEW_FRAMES` —— `getFrameCount()` 成功且帧数不在 2..240；
 *     · `ANIM_STATIC_ORIENTATION` —— 成功拿到方向、判定需要静态路径摆正。
 *   **去掉**的三支（全是**没探到**，瞬时）：
 *     · `ANIM_NO_HANDLE` —— 平台给不出 ImageSource 句柄；
 *     · `ANIM_EMPTY_FRAMES` —— `createPixelMapList` 返回空。**这是本缺陷的要害**：
 *       SDK 明说它"一次解出全部帧 … can lead to significant memory usage"，
 *       所以它的头号成因就是**内存压力**（解码器 OOM / fd 耗尽 / 文件被占用）；
 *     · `ANIM_FAILED` —— 任何抛错（OOM / fd 耗尽 / 文件被占用 / 格式不支持）。
 *   代价（**明确付**，与 `data/movingPhotoSource.ets` 开头那段论证同一取舍）：
 *   **坏文件每次滑回来会重试一次**（开一次文件 + 读一次文件头）。
 *   与"永久错误的结论"相比，这个代价必须付：后者用户**没有重试入口**，
 *   而日志只打过一行、与"第一次就没播"完全同形，无法区分。
 *
 *   肯定结论**依然不能**缓存 —— 帧数组会在离开这张卡时被释放，缓存"它是动图"
 *   就得同时缓存帧（那就成了内存泄漏）。重新滑回来时再解一次，是**正确**的代价。
 *
 * 上限：条目数 = **被确认静态**的候选（.gif/.webp）照片数，与相册规模同阶，每项一个 bool。
 */
const confirmedStatic: Map<string, boolean> = new Map();

// ── 平台端口实现：把 SDK 调用翻译成 core 的 `AnimIo` ─────────────────────────

/** 环境方向标签的读取；**不抛**（读不到 = 没有该标签 = 正常方向）。 */
async function readOrientation(src: image.ImageSource): Promise<string> {
  try {
    const props = await src.getImageProperties([image.PropertyKey.ORIENTATION]);
    return normalizeOrientation(props[image.PropertyKey.ORIENTATION]);
  } catch (e) {
    // 方向读不出来（"没有这个标签"是常态）→ 按正常方向处理：
    // 绝大多数动图确实没有方向标签，为它放弃播放是本末倒置。
    return '';
  }
}

/** `image.ImageSource` 的适配。方法名与 SDK 一一对应，语义逐个相同。 */
class SdkAnimHandle implements AnimSourceHandle<image.PixelMap> {
  private src: image.ImageSource;
  private fd: number;

  constructor(src: image.ImageSource, fd: number) {
    this.src = src;
    this.fd = fd;
  }

  async getFrameCount(): Promise<number> {
    return await this.src.getFrameCount();
  }

  async getImageSize(): Promise<FrameSize> {
    // 只读文件头，不解码像素。
    const info: image.ImageInfo = await this.src.getImageInfo();
    const s: FrameSize = { width: info.size.width, height: info.size.height };
    return s;
  }

  async getOrientation(): Promise<string> {
    return await readOrientation(this.src);
  }

  async createPixelMapList(target: FrameSize): Promise<image.PixelMap[]> {
    // ⚠️ 刻意**不写** `sampleSize`：SDK 文档（`@ohos.multimedia.image.d.ts:3253`）写着
    // 「Sampling size of the thumbnail. The default value is 1. Currently, the value
    //   can only be 1.」—— 它在本 SDK 上不是降采样杠杆。写 0 或 2 只会让人误以为它在起作用。
    // 真正起作用的是 desiredSize，而它由 core 的 frameDecodeSize 算好传进来。
    const opts: image.DecodingOptions = {};
    if (target.width > 0 && target.height > 0) {
      const size: image.Size = { width: target.width, height: target.height };
      opts.desiredSize = size;
    }
    const maps: image.PixelMap[] = await this.src.createPixelMapList(opts);
    // SDK 的声明类型没带 undefined/null，但运行期会回 undefined（与 createImageSource 同款）。
    // **空数组 = 一帧都没解出来**，core 按 `ANIM_EMPTY_FRAMES`（没探到）处理 —— 不写负缓存。
    if (maps === undefined || maps === null) { return []; }
    return maps;
  }

  async getDelayTimeList(): Promise<number[]> {
    try {
      const dl: number[] = await this.src.getDelayTimeList();
      if (dl === undefined || dl === null) { return []; }
      return dl;
    } catch (e) {
      // 拿不到不算失败：core 会因为长度不匹配而不用它，退化成默认节奏。
      hilog.warn(DOMAIN, TAG, '%{public}s', `动图帧时长读取失败（用默认节奏播）: ${errText(e)}`);
      return [];
    }
  }

  /** 释放句柄。**按契约不抛**（core 在 finally 里调它，抛了会盖掉真正的失败原因）。 */
  async close(): Promise<void> {
    // 与 data/exifReader.ts 同款：ImageSource.release() 只有 Promise 形态，先 await 再关 fd。
    try { await this.src.release(); } catch (e) { /* 释放失败不改结论 */ }
    try { fileIo.closeSync(this.fd); } catch (e) { /* 同上 */ }
  }
}

/** 平台端口：`AnimIo` 的**唯一真实现**。 */
class SdkAnimIo implements AnimIo<image.PixelMap> {
  async open(uri: string): Promise<AnimSourceHandle<image.PixelMap> | undefined> {
    // 打不开（URI 失效/已删除/fd 耗尽）→ 直接抛给 core，它按 `ANIM_FAILED`（没探到）处理。
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const fd: number = file.fd;
    let src: image.ImageSource | undefined = undefined;
    try {
      // SDK 注明 "If the operation fails, undefined is returned"，声明类型却没带 undefined，
      // 所以按运行期事实判一次（与 data/exifReader.ts 同款处理）。
      src = image.createImageSource(fd);
    } catch (e) {
      // 句柄没建起来 = 这次探测到此为止，fd 必须在这里关掉（否则每失败一次漏一个 fd）。
      this.closeFd(fd);
      throw new Error(errText(e));
    }
    if (src === undefined) {
      // 句柄给不出来 = **没探到** → 返回 undefined（core 记 `ANIM_NO_HANDLE`，**不写负缓存**）。
      this.closeFd(fd);
      return undefined;
    }
    return new SdkAnimHandle(src, fd);
  }

  private closeFd(fd: number): void {
    try { fileIo.closeSync(fd); } catch (e) { /* 关不掉不影响结论 */ }
  }
}

/** 端口实例（无状态，可以全局共用一个）。 */
const SDK_IO: SdkAnimIo = new SdkAnimIo();

/**
 * 把 core 给出的**结局码**翻成日志。**这一层只做翻译** —— "哪次失败算确定"的判据
 * 不在这里（见 `core/anim.ts::isStaticConclusion`），否则就又有了第二个真相来源，
 * 而 D3 正是这么来的。
 *
 * ⚠️ 关键的一条：三种"没探到"的结局都要在日志里写明**会不会重试**。
 * D3 之所以难查，正是因为"永久写进负缓存"与"第一次就没播"的日志**完全同形**；
 * 现在每一次失败尝试都会各打一行，数一下行数就知道重试有没有发生。
 */
function logMiss(uri: string, r: AnimDecodeResult<image.PixelMap>): void {
  if (r.outcome === ANIM_STATIC_FEW_FRAMES) {
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动图探测：确认无多帧（${r.detail}）→ 已记负缓存，此后不再探测: ${uri}`);
    return;
  }
  if (r.outcome === ANIM_STATIC_ORIENTATION) {
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动图不播（方向 ${r.detail} 需要静态路径摆正）→ 已记负缓存: ${uri}`);
    return;
  }
  if (r.outcome === ANIM_NO_HANDLE) {
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `动图解析：平台给不出句柄（瞬时）→ **未记负缓存**，下次滑回这张会重试: ${uri}`);
    return;
  }
  if (r.outcome === ANIM_EMPTY_FRAMES) {
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `动图解析：一帧都没解出来（内存压力/解码器资源不足，瞬时）→ **未记负缓存**，下次滑回这张会重试: ${uri} ${r.detail}`);
    return;
  }
  if (r.outcome === ANIM_FAILED) {
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `动图解析失败（退回静态图，瞬时）→ **未记负缓存**，下次滑回这张会重试: ${uri} ${r.detail}`);
    return;
  }
  // 其余两种（连后缀白名单都没过 / 负缓存命中）连文件都没开，**静默**：
  // 那是**绝大多数**照片的路径，打日志会把真机日志淹掉。
}

/**
 * 读一张照片的动图帧。**不抛错**：任何失败都返回 `undefined`，调用点据此显示静态图
 * （第一帧或原 URI）—— 即"动图解析失败 → 退回静态"，绝不白屏。
 *
 * 判定（后缀白名单 → 负缓存 → 帧数 → 尺寸 → 方向 → 解帧 → 时长）**全在 core**，
 * 本函数只做三件事：调它、把结局翻成日志、把帧组装成 descriptor + 所有权对象。
 */
export async function loadAnimFrames(uri: string): Promise<AnimFrames | undefined> {
  const r: AnimDecodeResult<image.PixelMap> = await decodeAnim(uri, SDK_IO, confirmedStatic);
  if (r.decoded === undefined) {
    logMiss(uri, r);
    return undefined;
  }
  const d: AnimDecoded<image.PixelMap> = r.decoded;
  // iterations: -1 = 无限循环（GIF 的语义就是循环；默认值 1 会让它只播一遍就停在末帧）。
  const options: AnimationOptions = { iterations: -1, autoPlay: true };
  if (d.durations.length > 0) { options.frameDurations = d.durations; }
  try {
    const desc: AnimatedDrawableDescriptor = new AnimatedDrawableDescriptor(d.frames, options);
    // ── 成功：所有权转移给 AnimFrames，此后由持有者的 release() 负责 ──────
    const out: AnimFrames = new AnimFrames(desc, d.frames, d.srcW, d.srcH);
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动图已装载: ${uri} 帧数=${d.frameCount} 原图=${d.srcW}x${d.srcH} 解码目标=${d.targetW}x${d.targetH} 预算=${d.budget}px/帧`);
    return out;
  } catch (e) {
    // 组装 descriptor 失败：帧的所有权**还没有**交出去（AnimFrames 没构造出来），
    // 必须在这里释放 —— 这是本文件两条自己持有帧的路径之一（另一条是 core 的 finally）。
    const n: number = releaseAll(d.frames);
    hilog.warn(DOMAIN, TAG, '%{public}s',
      `动图组装 descriptor 失败（退回静态图，已释放 ${n} 帧）: ${uri} ${errText(e)}`);
    return undefined;
  }
}

/**
 * 只清缓存（**仅供真机排障用**，产品路径不调用）。返回清掉的条目数。
 * 真机上如果出现"某一批照片全都没有动图"，先用它排除"负缓存被写脏"这个可能。
 */
export function clearAnimStaticCache(): number {
  const n: number = confirmedStatic.size;
  confirmedStatic.clear();
  return n;
}
