/**
 * 动态照片（拍摄的 Live Photo）的**平台侧**读取（本任务新增）：
 * `getAssets(uri)` → `PhotoAsset` → `PhotoSubtype` 判据 → `requestMovingPhoto`
 * → **`MovingPhoto` 对象**（直接喂给 `MovingPhotoView`，本文件**不落盘任何 MP4/JPEG**）。
 *
 * ── 分层（与本项目既有约定一致）─────────────────────────────────────────────
 *   本文件只做「查库 → 调 SDK → 包装所有权 → 释放」，**所有判定规则都在
 *   `core/movingPhoto.ts`**（有 Node 单测）。这条界线与 `data/animSource.ets`、
 *   `data/exifReader.ts` 完全相同：平台层不可单测（要真机的相册库与 MediaAssetManager），
 *   所以它必须薄到"读一眼就能相信"。
 *
 * ── 为什么直接把 `MovingPhoto` 喂给组件，而不是自己落盘 MP4 再 `loadMovingPhoto` ──
 *   真机探针给了两条都"能用"的路（探针报告 §0）：
 *     (a) 官方路线：`requestMovingPhoto` 回调拿到的 `MovingPhoto` **直接**给 `MovingPhotoView`；
 *     (b) 退路：`requestContent(VIDEO_RESOURCE)` 落盘真 MP4（实测 6640836 字节、`ftyp@4`=`mp42`）
 *         + `loadMovingPhoto(context, imageUri, videoUri)`。
 *   本实现走 (a)，三条理由：
 *     1) (a) 少一次 6.6MB 的写盘 + 再读盘，长按起播的延迟只由组件自己的准备时间决定；
 *     2) (b) 需要自己管两个沙箱文件的**生命周期**（谁删、什么时候删、并发同名冲突），
 *        而这些文件一旦漏删就是**永久占用户存储**（沙箱里不会自己消失）—— 本任务不引入这类状态；
 *     3) (b) 的播放结果在探针里**没有对照组**（C1 负对照没跑成，见任务说明），
 *        而 (a) 是探针里"喂真 MP4 就播"的同一批候选之一。
 *   ⚠ 如实登记：(a) 本身也**没有被那次实验证明**"官方对象形态正确"（探针的 C2 对照
 *     连空的 image URI 都能播 ⇒ 那次"成功"只证明了"有真 MP4 就会播"）。
 *     所以本文件只是**按官方路线实现**，能不能播**必须真机验**（见报告 §8）。
 *
 * ── 缓存策略（与 animSource 的差别是**刻意的**，别照抄那边）────────────────────
 *   只缓存**确定性的否定结论**（`subtype !== 3`）：
 *     · 肯定结论**不能**缓存 —— 缓存"它是动态照片"就得同时缓存 `MovingPhoto` 对象，
 *       而对象的释放出口在渲染它的组件那一层（ui/CardStack.ets），缓存会让所有权出现两个主人；
 *     · **查询失败 / 命中 0 条 / 请求超时都不写缓存**（这一点与 animSource 不同）：
 *       那里的失败几乎都是"文件坏了"（确定性的），而这里的失败可能是
 *       **选图器的永久授权还没生效 / IPC 抖动**（瞬时的）。把瞬时失败记成
 *       "这张不是动态照片"，用户会永远看不到那张的角标 —— 一个不会自愈的静默降级。
 *   代价：坏照片每次滑回来都会重试一次查库。这个代价是**故意**付的（宁可多查一次库，
 *   也不要一个永久错误的结论）。
 */

import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { dataSharePredicates } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { isMovingPhotoSubtype } from '../core/movingPhoto';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/**
 * 入参一律收 **`common.Context`**（而不是 `common.UIAbilityContext`）：SDK 自己就是
 * `getPhotoAccessHelper(context: Context)` / `requestMovingPhoto(context: Context, …)`
 *（`@ohos.file.photoAccessHelper.d.ts:48/671`），而调用点能拿到的"宿主 Context"
 * 正是这个更宽的类型。收窄成 UIAbilityContext 会逼着调用点写一个 `as` 断言 ——
 * 断言在"取不到宿主"时不会报错，只会把 undefined 一路带到 SDK 里，
 * 变成一条语焉不详的失败（见 ui/CardStack.ets::ensureMotionForCurrent 的显式处理）。
 */

/**
 * `requestMovingPhoto` 的**回调等待上限**（ms）。
 *
 * 为什么需要一个上限：这条 API 的返回值是"请求 ID"，真正的对象从 `onDataPrepared` 回调来
 * —— 一旦回调不来（权限、IPC、平台内部失败），一个没有上限的 Promise 会**永远 pending**，
 * 它连同它闭包里的 asset 一起被挂住，而且调用点再也无法得知"这次探测结束了没"。
 * 有上限之后最坏情况退化成"这张没有角标"（与"不是动态照片"表现一致，不白屏、不卡刷卡）。
 *
 * 5000 的依据：探针里真机实测这条回调**很快**（它给的最长等待是 8s，是"万一"的兜底，
 * 不是实测值）；5000 对"后台预取"这个用途足够宽裕，又不会让一次失败拖到用户都翻走了。
 */
export const MOTION_REQUEST_TIMEOUT_MS: number = 5000;

/** 把 catch 到的值转成一行可打印文本（与 data/animSource.ets 的 errText 同款口径）。 */
function errText(e: Object): string {
  if (e instanceof Error) { return e.message; }
  return JSON.stringify(e);
}

/**
 * 一次动态照片加载的**所有权对象**。它存在的唯一理由与 `AnimFrames` 相同：
 * "谁持有这张的动态照片"必须是一个**可枚举**的事实。
 *
 * ⚠ 必读：`MovingPhoto` **没有 `release()` API**（SDK 只给了 `requestContent` / `getUri`），
 * 所以这里的 `release()` **不是**"把 native 内存还回去"，它做的是：
 *   · 把 `released` 置真（**幂等**）—— 让"这份句柄已经交还给平台"成为代码里读得到的状态；
 *   · 让持有者（`ui/CardStack.ets` 的 `motionOwner`）**放弃引用**，于是这个对象、
 *     以及它内部持有的媒体库资源，都随 ArkTS 对象一起失去全部强引用。
 * 真正让底层资源回收的是平台自己（与 `PixelMap` 的引用语义同理：
 * "memory is reclaimed only after all managing ArkTS objects have relinquished their control"）。
 * `release()` 返回布尔而不是 void，是为了让真机日志能回答"这次到底是**哪一次**
 * 调用真正放手了" —— 重复调用返回 false，日志里一眼能看出有没有重复释放。
 */
export class MotionHandle {
  /** 交给 `MovingPhotoView({ movingPhoto: ... })` 的那个对象（本任务的核心产物）。 */
  readonly movingPhoto: photoAccessHelper.MovingPhoto;
  /** 来源 URI（= 队列里的 photoId），只用于日志与断言，不参与任何判定。 */
  readonly uri: string;
  private released: boolean = false;

  constructor(movingPhoto: photoAccessHelper.MovingPhoto, uri: string) {
    this.movingPhoto = movingPhoto;
    this.uri = uri;
  }

  /** 放手这份句柄。返回 true = **本次**调用真正放手了；false = 之前已经放手过（幂等）。 */
  release(): boolean {
    if (this.released) { return false; }
    this.released = true;
    return true;
  }

  /** 这份句柄是否已经放手（调用点用它断言"不会再用一个已释放的对象"）。 */
  isReleased(): boolean {
    return this.released;
  }
}

/**
 * 「这张**确定**不是动态照片」的缓存，key = photoId（= URI）。
 * 只放**确定**的否定结论（见文件头的缓存策略），所以它的每一条都对应一次成功的查库。
 * 上限：条目数 = 用户刷过的静态照片数，每项只有一个 bool —— 与 `animSource` 的
 * `confirmedStatic` 同一量级，不设淘汰。
 */
const confirmedNoMotion: Map<string, boolean> = new Map();

/**
 * 读一张照片的动态照片对象。**不抛错**：任何失败都返回 `undefined`，
 * 调用点据此"没有角标、长按什么都不做"（退路是静态图，不是白屏、不是崩）。
 *
 * 三步，按代价从低到高，**顺序不可换**（换了就白花钱）：
 *   1) 负缓存（这张已确定不是动态照片）；
 *   2) `getAssets(uri)` 查库 + `PhotoKeys.PHOTO_SUBTYPE` 判据（**不解码、不请求视频**）；
 *   3) 只有确定是动态照片才 `requestMovingPhoto`（这一步才真正让平台准备对象）。
 *
 * 实测依据（真机探针）：
 *   · `getAssets` 的 `.d.ts` 标着 `@permission ohos.permission.READ_IMAGEVIDEO`，
 *     但**选图器的永久授权可以替代它**（本 App 不声明该权限，声明会导致安装失败）；
 *   · `equalTo(PhotoKeys.URI, uri)` + `fetchColumns: []` 能取到 `PhotoAsset`，
 *     且 `get(PHOTO_SUBTYPE)` 与选图器角标**逐张一致**（探针 C-5/C-6）；
 *   · `FetchResult.close()` 之后拿到的 `PhotoAsset` **仍然可以**喂给
 *     `requestMovingPhoto`（探针 R1 正是这个顺序：先 close、后请求，回调拿到对象 ✅）。
 */
export async function loadMotion(
  ctx: common.Context, uri: string
): Promise<MotionHandle | undefined> {
  if (uri === '') { return undefined; }
  if (confirmedNoMotion.get(uri) === true) { return undefined; }
  const asset: photoAccessHelper.PhotoAsset | undefined = await findAsset(ctx, uri);
  if (asset === undefined) {
    // 查不到（没有授权 / 已被删除 / 查库异常）：**不写负缓存**，也不报错。
    // 表现与"不是动态照片"一致（没有角标），但下次滑回来还会再问一次库。
    return undefined;
  }
  let raw: photoAccessHelper.MemberType | undefined = undefined;
  try {
    // `subtype` 是 SDK 明说"不必写进 fetchColumns 也能取"的四个成员之一（另三个是
    // uri / media_type / display_name），所以上面 `fetchColumns: []` 是对的。
    raw = asset.get(photoAccessHelper.PhotoKeys.PHOTO_SUBTYPE);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '%{public}s', `读照片 subtype 失败（按"不是动态照片"处理）: ${uri} ${errText(e)}`);
    return undefined;
  }
  if (!isMovingPhotoSubtype(raw)) {
    // 确定性结论：写缓存，这张以后不再查库（绝大多数照片走这一支）。
    confirmedNoMotion.set(uri, true);
    return undefined;
  }
  const mp: photoAccessHelper.MovingPhoto | undefined = await requestMotionObject(ctx, asset);
  if (mp === undefined) {
    // 是动态照片，但这次**没取到对象**（超时/回传空/抛错）：不写负缓存（见文件头），
    // 于是下次滑回来会重试。代价是重试，收益是"不会因为一次抖动就永久失去角标"。
    return undefined;
  }
  let gotUri: string = '';
  try {
    gotUri = mp.getUri();
  } catch (e) {
    gotUri = '';
  }
  hilog.info(DOMAIN, TAG, '%{public}s',
    `动态照片已就绪: ${uri}（MovingPhoto.getUri=${gotUri === '' ? '(取不到)' : gotUri}）`);
  return new MotionHandle(mp, uri);
}

/**
 * 按 URI 查一个 `PhotoAsset`。
 *
 * 与探针**逐字同款**的调用形态（`dataSharePredicates` + `fetchColumns: []` + `close()`）——
 * 这条形态是**真机实测过**的，不要"顺手优化"成别的写法（例如自己拼 SQL 或换 fetchColumns）。
 * `close()` 放在 finally：不 close 会漏一个游标/资源；而 close 之后再使用 `PhotoAsset`
 * 是被探针验证过的（见 `loadMotion` 的说明）。
 */
async function findAsset(
  ctx: common.Context, uri: string
): Promise<photoAccessHelper.PhotoAsset | undefined> {
  try {
    const helper = photoAccessHelper.getPhotoAccessHelper(ctx);
    const pred = new dataSharePredicates.DataSharePredicates();
    pred.equalTo(photoAccessHelper.PhotoKeys.URI, uri);
    const res: photoAccessHelper.FetchResult<photoAccessHelper.PhotoAsset> =
      await helper.getAssets({ fetchColumns: [], predicates: pred });
    try {
      const cnt: number = res.getCount();
      if (cnt <= 0) {
        // 命中 0 条：探针对这一支的注释是"永久授权未生效？"—— 属于**瞬时/环境**问题，
        // 所以这里只返回 undefined，绝不写负缓存（见文件头）。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `查库命中 0 条（选图器永久授权可能尚未生效）: ${uri}`);
        return undefined;
      }
      return await res.getFirstObject();
    } finally {
      try { res.close(); } catch (e) { /* 关不掉不影响结论 */ }
    }
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '%{public}s', `getAssets 失败（这张没有角标）: ${uri} ${errText(e)}`);
    return undefined;
  }
}

/**
 * 请求 `MovingPhoto` 对象（`onDataPrepared` 回调 → Promise）。
 *
 * 三个刻意的选择：
 *   · `DeliveryMode.FAST_MODE`：探针里**唯一实测过**的取值（探针 2 拿真 MP4、探针 3 播，
 *     用的都是它）。探针报告 R6 登记了"FAST_MODE 是否影响视频轨可用性"未验证，
 *     但"实测能播的配置"优先于"文档看起来更好的配置" —— 要换成 `HIGH_QUALITY_MODE`
 *     必须先真机复测（见报告 §8 的"可选对照"）。
 *     已知代价：FAST_MODE 的回传质量可能较低，影响的是**播放画面本身的清晰度**，
 *     不影响卡片默认显示的那张静态图（后者走 `Image(item.thumbUri)` 读原文件）。
 *   · **超时**：见 `MOTION_REQUEST_TIMEOUT_MS`。
 *   · `settled` 闸门：回调、超时、`.catch` 三条路都可能先到，只有第一条算数 ——
 *     没有它就会出现"超时先 resolve 了 undefined，随后回调又 resolve 一个对象"
 *     （Promise 只认第一次，但那条日志会把人骗死）。
 */
function requestMotionObject(
  ctx: common.Context, asset: photoAccessHelper.PhotoAsset
): Promise<photoAccessHelper.MovingPhoto | undefined> {
  return new Promise<photoAccessHelper.MovingPhoto | undefined>(
    (resolve: (v: photoAccessHelper.MovingPhoto | undefined) => void): void => {
      let settled: boolean = false;
      const timer: number = setTimeout((): void => {
        if (settled) { return; }
        settled = true;
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `requestMovingPhoto 回调 ${MOTION_REQUEST_TIMEOUT_MS}ms 未到（这张没有角标）: ${asset.uri}`);
        resolve(undefined);
      }, MOTION_REQUEST_TIMEOUT_MS);
      const handler: photoAccessHelper.MediaAssetDataHandler<photoAccessHelper.MovingPhoto> = {
        onDataPrepared: (data: photoAccessHelper.MovingPhoto, map?: Map<string, string>): void => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          // 文档：请求失败时 data 是 undefined（签名里没写，所以这里按运行期事实判一次，
          // 与 data/exifReader.ts 对 createImageSource 的处理同款）。
          if (data === undefined || data === null) {
            hilog.warn(DOMAIN, TAG, '%{public}s',
              `requestMovingPhoto 回传空对象（失败，且**没有错误码可打**）: ${asset.uri}`);
            resolve(undefined);
            return;
          }
          resolve(data);
        }
      };
      const opts: photoAccessHelper.RequestOptions = {
        deliveryMode: photoAccessHelper.DeliveryMode.FAST_MODE
      };
      try {
        photoAccessHelper.MediaAssetManager.requestMovingPhoto(ctx, asset, opts, handler)
          .then((reqId: string): void => {
            hilog.info(DOMAIN, TAG, '%{public}s',
              `requestMovingPhoto 已受理 reqId=${reqId}（等 onDataPrepared）: ${asset.uri}`);
          })
          .catch((e: Object): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            hilog.warn(DOMAIN, TAG, '%{public}s',
              `requestMovingPhoto 抛错（这张没有角标）: ${asset.uri} ${errText(e)}`);
            resolve(undefined);
          });
      } catch (e) {
        // 同步抛（参数非法等）：同上，走"没有角标"的退路。
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          hilog.warn(DOMAIN, TAG, '%{public}s',
            `requestMovingPhoto 同步失败（这张没有角标）: ${asset.uri} ${errText(e)}`);
          resolve(undefined);
        }
      }
    });
}

/**
 * 只清缓存（**仅供真机排障用**，产品路径不调用）。
 * 真机上如果出现"某一批照片全都没有角标"，先用它排除"负缓存被写脏"这个可能；
 * 它不碰任何句柄，也不改变已加载对象的所有权。
 */
export function clearMotionCache(): number {
  const n: number = confirmedNoMotion.size;
  confirmedNoMotion.clear();
  return n;
}
