/**
 * 动图的**平台侧**读取（本批新增）：确认多帧 → 按像素预算解帧 → 组装
 * `AnimatedDrawableDescriptor`，并把「帧数组」包装成一个**负责释放**的对象。
 *
 * ── 分层（与本项目既有约定一致）─────────────────────────────────────────────
 *   本文件只做「开文件 → 调 SDK → 组装 → 释放」这件事，**所有判定规则都在
 *   `core/anim.ts`**（有 Node 单测）。这条界线与 `data/exifReader.ts` 完全相同：
 *   平台层不可单测（要真机的 fileIo / ImageSource），所以它必须薄到"读一眼就能相信"。
 *
 * ── 两条官方路径，选 (b) `AnimatedDrawableDescriptor`（理由见报告 §3）────────
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
 *   于是释放路径可以做得短、同步、可枚举：本文件里**只有一个出口**会持有帧
 *   （`AnimFrames`），任何失败路径都由 `finally` 兜底（见 `loadAnimFrames`）。
 */
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AnimatedDrawableDescriptor, AnimationOptions } from '@kit.ArkUI';
import {
  isAnimatedCandidate, shouldDecodeFrames, framePixelBudget, frameDecodeSize, releaseAll,
  FrameLike, FrameSize
} from '../core/anim';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 把 catch 到的值转成一行可打印文本（与 pages/SwipePage.ets 的 errText 同款口径）。 */
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
 * 「这张已经确认**没有可播放的多帧**」的缓存，key = photoId（= URI）。
 *
 * 为什么必须有它：探测要开文件、读文件头（`getFrameCount()`），而
 * `core/anim.ts` 的后缀白名单会把**每一张静态 webp** 都送进来。没有缓存的话，
 * 用户每次滑回同一张静态 webp 都要重新探测一遍 —— 这正是工单点名的性能陷阱
 * （「不要对每张卡都调」）。
 *
 * 只缓存**否定结论**（`true` = 别再试了）：肯定结论不能缓存 —— 帧数组会在离开这张卡时
 * 被释放，缓存"它是动图"就得同时缓存帧（那就成了内存泄漏）。重新滑回来时再解一次，
 * 是**正确**的代价。
 *
 * 上限：条目数 = 候选（.gif/.webp）照片数，与相册规模同阶，且每项只有一个 bool。
 */
const confirmedStatic: Map<string, boolean> = new Map();

/**
 * 读一张照片的动图帧。**不抛错**：任何失败都返回 `undefined`，调用点据此显示静态图
 * （第一帧或原 URI）—— 即"动图解析失败 → 退回静态"，绝不白屏。
 *
 * 三道闸，按代价从低到高，**顺序不可换**（换了就白花钱）：
 *   1) 后缀白名单（纯字符串，见 `isAnimatedCandidate`）；
 *   2) 缓存（这张已确认没有多帧）；
 *   3) 开文件 + `getFrameCount()`（**权威判据**）→ `getImageInfo()` → `createPixelMapList()`。
 */
export async function loadAnimFrames(uri: string): Promise<AnimFrames | undefined> {
  if (!isAnimatedCandidate(uri)) { return undefined; }
  if (confirmedStatic.get(uri) === true) { return undefined; }

  let fd: number = -1;
  let src: image.ImageSource | undefined = undefined;
  // 已解出的帧。所有权在**成功构造 AnimFrames 的那一刻**转移（那之后把它置空，
  // 于是 finally 不会误释放已经交出去的帧）。任何别的路径都由 finally 释放。
  let maps: image.PixelMap[] = [];
  try {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    fd = file.fd;
    // SDK 注明 "If the operation fails, undefined is returned"，声明类型却没带 undefined，
    // 所以按运行期事实判一次（与 data/exifReader.ts 同款处理）。
    src = image.createImageSource(fd);
    if (src === undefined) {
      confirmedStatic.set(uri, true);
      return undefined;
    }
    // ── 权威判据：多帧才算动图 ────────────────────────────────────────────
    // 后缀命中的静态 gif / webp 在这里被挡掉（`shouldDecodeFrames` 要求 count > 1），
    // 并且做帧数上限保护（超上限退回静态第一帧，而不是把内存乘爆）。
    const count: number = await src.getFrameCount();
    if (!shouldDecodeFrames(count)) {
      confirmedStatic.set(uri, true);
      return undefined;
    }
    // ── 原图尺寸：只读文件头，不解码像素 ──────────────────────────────────
    const info: image.ImageInfo = await src.getImageInfo();
    const srcW: number = info.size.width;
    const srcH: number = info.size.height;
    // ── 方向：与静态路径保持一致，不一致就不播（见下）─────────────────────
    const orientation: string = await readOrientation(src);
    if (!isDisplayOrientationNormal(orientation)) {
      // 静态路径 `Image(uri)` 会按 EXIF/TIFF 方向自动摆正，而我们解出来的帧是**原始像素**。
      // 若不管，同一张照片会"静态时是正的、一播就躺下" —— 这是比"不播"严重得多的故障。
      // 所以这里选择**不播**（退回静态图，方向由框架摆正），而不是去映射旋转角：
      // 旋转只能表达 90/180/270，镜像（orientation 2/4/5/7）根本表达不了，
      // 映射一半反而会造出"有的转有的不转"的更坏形态。
      confirmedStatic.set(uri, true);
      hilog.info(DOMAIN, TAG, '%{public}s',
        `动图不播（方向 ${orientation} 需要静态路径摆正）: ${uri}`);
      return undefined;
    }
    // ── 解码尺寸：唯一的降采样杠杆 ────────────────────────────────────────
    // 刻意**不写** `sampleSize`：SDK 文档（`@ohos.multimedia.image.d.ts:3253`）写着
    // 「Sampling size of the thumbnail. The default value is 1. Currently, the value
    //   can only be 1.」—— 它在本 SDK 上不是降采样杠杆。写 0 或 2 只会让人误以为它在起作用。
    // 真正起作用的是 desiredSize，而它必须**自己算**（见 core/anim.ts 的 frameDecodeSize）。
    const budget: number = framePixelBudget(count);
    const target: FrameSize = frameDecodeSize(srcW, srcH, budget);
    const opts: image.DecodingOptions = {};
    if (target.width > 0 && target.height > 0) {
      const size: image.Size = { width: target.width, height: target.height };
      opts.desiredSize = size;
    }
    maps = await src.createPixelMapList(opts);
    if (maps === undefined || maps === null || maps.length === 0) {
      confirmedStatic.set(uri, true);
      return undefined;
    }
    // ── 每帧时长 ──────────────────────────────────────────────────────────
    // 拿不到不算失败：不传 frameDurations，交给 AnimationOptions.duration 语义。
    let durations: number[] = [];
    try {
      const dl: number[] = await src.getDelayTimeList();
      // 长度必须与帧数一致才用：SDK 说长度不一致时"按总时长摊"，那会让节奏整体变形，
      // 不如干脆不传（交给默认节奏），至少不会越播越偏。
      if (dl !== undefined && dl !== null && dl.length === maps.length) { durations = dl; }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '%{public}s', `动图帧时长读取失败（用默认节奏播）: ${errText(e)}`);
    }
    // iterations: -1 = 无限循环（GIF 的语义就是循环；默认值 1 会让它只播一遍就停在末帧）。
    const options: AnimationOptions = { iterations: -1, autoPlay: true };
    if (durations.length > 0) { options.frameDurations = durations; }
    const desc: AnimatedDrawableDescriptor = new AnimatedDrawableDescriptor(maps, options);
    // ── 成功：所有权转移，finally 不再释放 ────────────────────────────────
    const out: AnimFrames = new AnimFrames(desc, maps, srcW, srcH);
    maps = [];
    hilog.info(DOMAIN, TAG, '%{public}s',
      `动图已装载: ${uri} 帧数=${count} 原图=${srcW}x${srcH} 解码目标=${target.width}x${target.height} 预算=${budget}px/帧`);
    return out;
  } catch (e) {
    // 打不开（URI 失效/已删除）、不是支持的格式、内存不足、解码失败 —— 全部走静态退路。
    // 同时记进缓存：坏文件不该在用户每次滑回来时重新试一遍。
    confirmedStatic.set(uri, true);
    hilog.warn(DOMAIN, TAG, '%{public}s', `动图解析失败（退回静态图）: ${uri} ${errText(e)}`);
    return undefined;
  } finally {
    if (maps.length > 0) { releaseAll(maps); }
    if (src !== undefined) {
      // 与 data/exifReader.ts 同款：ImageSource.release() 只有 Promise 形态，先 await 再关 fd
      try { await src.release(); } catch (e) { /* 释放失败不改结论 */ }
    }
    if (fd >= 0) {
      try { fileIo.closeSync(fd); } catch (e) { /* 同上 */ }
    }
  }
}

/**
 * 读照片的方向标签（EXIF/TIFF Orientation 的字符串形式，如 `"1"` / `"Top-left"`）。
 * 读不到（没有该标签、或平台不支持）返回空串 —— 空串按"正常方向"处理，见下。
 */
async function readOrientation(src: image.ImageSource): Promise<string> {
  try {
    const props = await src.getImageProperties([image.PropertyKey.ORIENTATION]);
    const v: string | null | undefined = props[image.PropertyKey.ORIENTATION];
    if (v === undefined || v === null) { return ''; }
    return v;
  } catch (e) {
    // 方向读不出来（"没有这个标签"是常态）→ 按正常方向处理：
    // 绝大多数动图确实没有方向标签，为它放弃播放是本末倒置。
    return '';
  }
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
function isDisplayOrientationNormal(orientation: string): boolean {
  if (orientation === '') { return true; }
  if (orientation === '1') { return true; }
  if (orientation === 'Top-left' || orientation === 'TopLeft') { return true; }
  return false;
}
