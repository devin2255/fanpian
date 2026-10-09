/**
 * 手动选地点（省 → 市 → 县）的**领域层**：把用户手选的地点写进地点索引，
 * 并回答「这张照片有没有可用地点」。
 *
 * ── 为什么**不另开一个文件**存手选地点 ──────────────────────────────────────
 *   手动地点与 EXIF 地点是**同一条记录的两个来源**，不是两份数据：同一个 photoId
 *   只可能有一个地点。分文件存会让「这张到底在哪」有两个答案，而两份答案迟早打架
 *  （典型形态：手选之后重建了索引，两处各说各话，谁也不知道该信哪个）。
 *   所以：**文件只有一个**（`locations.json`）、**条目类型只有一个**（`LocationEntry`）、
 *   **写入口只有一条**（`LocationIndex.load()` / `save()` 的读改写）。
 *   本类不碰 `fileIo`、不拼 JSON、不做原子写 —— 存储三规矩
 *  （UTF-8 解码 / `.tmp` + renameSync / 形状校验 + 分级告警）仍然只有
 *   `data/locationIndex.ets` 一处实现（照抄自 decisionStore）。
 *
 * ── 那为什么还要这个类（不把这些方法直接塞进 LocationIndex）─────────────────
 *   `LocationIndex` 的契约是「照片 → 拍摄时间 + 坐标」，而它在文件头明确把自己定义成
 *   **缓存**：删掉 locations.json 即可全量重建、没有 TTL/重试。手选地点比它强一档 ——
 *   那是**用户数据**，丢了不可再生（用户不会记得自己给哪张照片选过哪个县），
 *   所以它必须有一条「重建时不被覆盖」的规则，而那条规则（优先级）不该混进"缓存"的语义里。
 *   本类因此只做三件事：等索引稳定、写入手选地点、按优先级回答"有没有地点"。
 *
 * 优先级规则本身（手动 > EXIF）定义在 `core/placePick.ts` 的 `hasPlace` / `placeSource`，
 * 本类只做转调 —— 规则的**唯一定义处**在 core（可被 Node 单测直接覆盖），
 * 而"重建时不覆盖"的机制在 `locationIndex.doBuild`（两道防线）。
 */
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CountyHit } from '../core/areaData';
import { hasPlace, placeSource, PlaceSource } from '../core/placePick';
import { LocationEntry, LocationIndex } from './locationIndex';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/** 从一份索引里捞出某个 photoId 的条目。线性扫：索引是数组（LocationEntry[]），没有别的索引。 */
function findEntry(list: LocationEntry[], photoId: string): LocationEntry | undefined {
  for (let i = 0; i < list.length; i++) {
    if (list[i].photoId === photoId) { return list[i]; }
  }
  return undefined;
}

/** 坐标形状校验：有限数值，且不同时为 0（(0,0) = 没有坐标，见 LocationEntry 的字段注释）。 */
function validCoord(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) { return false; }
  return lng !== 0 || lat !== 0;
}

export class PlaceStore {
  private idx: LocationIndex;

  constructor(ctx: common.UIAbilityContext) { this.idx = new LocationIndex(ctx); }

  /**
   * 等索引稳定（返回时没有构建在跑），然后报出这张照片当前的地点条目。
   *
   * **上墙流程必须用这个，不要用同步的 load()**：构建期间 load() 拿到的是半成品索引，
   * 会把"这张的 EXIF 还没读到"误判成"没有 GPS"，于是给一张本来有 GPS 的照片弹选择器；
   * 而用户一旦选了，他的选择就以 manual 的身份**永久**压住那条 EXIF —— 代价不可逆。
   * `awaitIdle()` 的契约正是"返回时没有别的构建在跑"，所以它给的是稳定答案。
   *
   * 索引里没有这条（还没读到 / 构建失败）时返回 undefined，不抛错。
   */
  async entryAfterIdle(photoId: string): Promise<LocationEntry | undefined> {
    const list: LocationEntry[] = await this.idx.awaitIdle();
    return findEntry(list, photoId);
  }

  /** 此刻是否有一次索引构建在跑（只读快照，给 UI 决定要不要提示"正在读取地点"）。 */
  isBuilding(): boolean { return this.idx.isBuilding(); }

  /** 这张照片有没有可用地点（规则见 core/placePick.hasPlace：手动 > EXIF）。 */
  hasPlace(entry: LocationEntry | undefined): boolean { return hasPlace(entry); }

  /** 这条地点实际起作用的来源，只用于日志与真机核验。 */
  sourceOf(entry: LocationEntry | undefined): PlaceSource { return placeSource(entry); }

  /**
   * 记下用户手选的地点（省/市/县）并**立即**原子落盘。
   *
   * 三条语义，写清楚避免歧义：
   *   1) **坐标来自 CountyHit**（县级中心点，GCJ-02），字段名要换一次：
   *      `CountyHit.lng` → `LocationEntry.lon`。两处名字不同是既有事实（Entry 用的是 lon），
   *      这里显式转换并注明，不做"看起来一样"的隐式假设。
   *   2) **保留既有 takenAt**：拍摄时间是 EXIF 的事，手选地点只改地点，不该把时间清零
   *      （清零会让"这张是哪天拍的"永久丢失，而它本来已经在索引里了）。
   *   3) **manual = true**：这是"优先级最高、重建时不被覆盖"的唯一标记（见 LocationEntry）。
   *
   * 同步方法：内部 load → upsert → save 三步之间**没有 await**，所以它在事件循环里是
   * 原子的 —— 单线程下没有别的写者能插进这三步中间（这也是"读改写不会丢并发写入"的依据；
   * 与 doBuild 收尾那次全量写的次序无关性，见那里的注释）。
   *
   * @returns 是否真的写进去了。false = 参数不合法（photoId 空 / 坐标非法），**一个字节都没写**。
   */
  setManual(photoId: string, hit: CountyHit, now: number): boolean {
    if (photoId === undefined || photoId === null || photoId === '') {
      hilog.warn(DOMAIN, TAG, '%{public}s', '手选地点被丢弃：photoId 为空');
      return false;
    }
    if (!validCoord(hit.lng, hit.lat)) {
      // (0,0) 与 NaN 都在这里被挡住：手选地点**必须**带真坐标，否则它既落不了点、
      // 又会让 hasPlace 报"有地点"（manual 分支不看坐标），从此这张照片再也不会被问一次。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `手选地点被丢弃：坐标非法（lng=${hit.lng} lat=${hit.lat}，${hit.province}/${hit.city}/${hit.county}）`);
      return false;
    }

    const list: LocationEntry[] = this.idx.load();
    const old: LocationEntry | undefined = findEntry(list, photoId);
    const merged: LocationEntry = {
      photoId: photoId,
      lat: hit.lat,
      lon: hit.lng,                                    // CountyHit.lng → Entry.lon，见上
      takenAt: old === undefined ? 0 : old.takenAt,     // 保住拍摄时间，见上
      manual: true
    };
    if (old === undefined) {
      list.push(merged);
    } else {
      // 就地替换：条目的位置不变（列表顺序 = 原有条目在前、新读的在后，见 doBuild）。
      for (let i = 0; i < list.length; i++) {
        if (list[i].photoId === photoId) { list[i] = merged; break; }
      }
    }
    this.idx.save(list);
    // now 只是给日志用的时间戳（落盘的字段里没有"何时选的"：LocationEntry 的时间字段是
    // **拍摄时间**，把它写成"选择时间"会让 takenAt 的语义变混）。不落盘也如实打出来。
    hilog.info(DOMAIN, TAG, '%{public}s',
      `手选地点已记录：${hit.province}/${hit.city}/${hit.county} → ${hit.lat},${hit.lng}（t=${now}，索引 ${list.length} 条）`);
    return true;
  }
}
