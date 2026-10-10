import { common } from '@kit.AbilityKit';
import { buffer } from '@kit.ArkTS';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ClaimState, ClaimedPhoto, emptyClaimState, mergeBatch, claimStorePath } from '../core/claim';
import { errText } from '../core/atomicText';
import { writeTextAtomic } from './atomicWrite';
import { fileIo } from '@kit.CoreFileKit';

const DOMAIN = 0x0000;
const TAG = 'PhotoWall';

/**
 * 打开系统选图器。
 * @param preselectedUris 预选中的照片（通常是「已认领但尚未刷过」的那批）：
 *        传进去后它们会以**选中状态**呈现，用户点「完成」即可一键全部认领，
 *        不必逐张重新点选 —— 这是第三方应用能拿到的最接近「一键多选」的能力
 *        （「全选 / 推荐照片」属系统图库 UI 特权，SDK 未对第三方开放）。
 *        已刷过的照片**不要**放进来：它们不再是队列的一部分，出现只会干扰。
 * @returns 用户最终确认选中的照片 URI。用户取消选图器时的行为（resolve 空数组 vs reject）
 *        本项目仍在真机验收清单里待验，本函数**不**对其做任何假设或兜底。
 */
export async function pickPhotos(preselectedUris: string[]): Promise<string[]> {
  const picker = new photoAccessHelper.PhotoViewPicker();
  const opt: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  opt.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  opt.maxSelectNumber = 500;
  opt.isSearchSupported = true;   // 打开选图器内搜索，便于按内容/时间找照片
  // 只在非空时设置：undefined 与空数组语义不同，后者可能被当成「预选了 0 张」。
  if (preselectedUris.length > 0) {
    // 预选数不能超过上限，否则可能整批被拒
    opt.preselectedUris = preselectedUris.length > 500
      ? preselectedUris.slice(0, 500) : preselectedUris;
  }
  const result: photoAccessHelper.PhotoSelectResult = await picker.select(opt);
  return result.photoUris;
}

export class ClaimStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  /**
   * 读认领列表。
   *
   * **告警分级（本批新增，修的是 D1 最坏路径在真机上完全不可见这一点）**：
   *   · 文件不存在（首次运行）→ **静默**返回空状态。这是正常路径，不该刷告警；
   *   · 文件在但读/解析失败（JSON 语法错、UTF-8 解码错、短读越界、fileIo 报错）→ `hilog.warn` + e.message；
   *   · 顶层结构非法（不是对象 / photos 不是数组）→ `hilog.warn` + 实际类型；
   *   · 单条记录非法被跳过 → `hilog.warn` + 分类计数；
   *   · lastBatchId 存在但非法 → `hilog.warn` + 原值。
   * 为什么都是 warn 而不是 error：进程还能继续跑（功能降级：池子显示为空），
   * 与 decisionStore / sessionStore / locationIndex / metricsStore 四处既有分级保持一致；
   * 但**绝不能没有**——这一支返回的就是 `photos: []`，用户看到的是「还没有可刷的照片」，
   * 而真相是"239 张逐张授权来的 URI 读不出来了"。没有日志，这条最坏路径在真机上无迹可寻。
   *
   * 用两次 statSync 区分"文件不存在"与"解析失败"，写法与 decisionStore / locationIndex 一致。
   */
  load(): ClaimState {
    const path = claimStorePath(this.ctx.filesDir);
    // 第一次 statSync 只回答「文件在不在」：首次运行没有这个文件是**正常**的。
    let exists = false;
    try {
      fileIo.statSync(path);
      exists = true;
    } catch (e) {
      exists = false;
    }
    if (!exists) { return emptyClaimState(); }

    try {
      const st = fileIo.statSync(path);
      const buf = new ArrayBuffer(st.size);
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      let n: number = 0;
      try {
        n = fileIo.readSync(file.fd, buf);
      } finally {
        fileIo.closeSync(file);
      }
      // readSync 声明返回「实际读取字节数」；越界值只可能来自 SDK 违约，属于真异常。
      if (n < 0 || n > st.size) { throw new Error('readSync 返回值异常'); }
      // 只解码实际读到的字节：若文件在 stat 与 read 之间变小（短读），
      // buf 尾部是 NUL 填充，整段解码会让 JSON.parse 失败并静默退化为空状态。
      const bytes: Uint8Array = new Uint8Array(buf, 0, n);
      // save() 用 JSON.stringify 写出的是 UTF-8 字节，必须按 UTF-8 解码；
      // 按字节拼串等价于 Latin-1，会把非 ASCII 的 photoId 解成 mojibake。
      const text: string = buffer.from(bytes).toString('utf-8');
      const parsed = JSON.parse(text) as ClaimState;
      // Ruling 18：数据边界层校验，非法数据不得静默通过
      if (parsed === null || parsed === undefined || !Array.isArray(parsed.photos)) {
        // 这一支与下面 catch 的**后果完全相同**（photos: [] → 首页"还没有可刷的照片"），
        // 只是成因不同（写侧把结构写坏了 vs 文件整体读不出来），所以各留一行、都带实际类型。
        // 它在本次修复之前也是**静默**的，属于同一个缺陷族的第二个入口。
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `认领文件顶层结构非法（parsed 是 ${parsed === null ? 'null' : typeof parsed}，photos 不是数组），` +
          `已按空状态处理（页面会显示"还没有可刷的照片"）`);
        return emptyClaimState();
      }
      const valid: ClaimedPhoto[] = [];
      // 跳过计数分开：真机上"有 12 条非法"没法下手，得知道是整条为 null 还是 photoId 缺失
      //（后者通常意味着写侧改了字段名）。丢掉的每一条都是**用户逐张授权来的 URI**。
      let skipped = 0;
      let skippedNoId = 0;
      for (let i = 0; i < parsed.photos.length; i++) {
        const p = parsed.photos[i];
        if (p === null || p === undefined) { skipped = skipped + 1; continue; }
        if (typeof p.photoId !== 'string' || p.photoId === '') {
          skipped = skipped + 1;
          skippedNoId = skippedNoId + 1;
          continue;
        }
        valid.push({
          photoId: p.photoId,
          batchId: typeof p.batchId === 'number' && Number.isFinite(p.batchId) ? p.batchId : 0,
          claimedAt: typeof p.claimedAt === 'number' && Number.isFinite(p.claimedAt) ? p.claimedAt : 0,
          takenAt: typeof p.takenAt === 'number' && Number.isFinite(p.takenAt) ? p.takenAt : 0
        });
      }
      if (skipped > 0) {
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `认领文件中有 ${skipped} 条非法记录，已跳过（其中 ${skippedNoId} 条 photoId 缺失/非字符串，` +
          `${skipped - skippedNoId} 条整条为 null/undefined）——它们会从照片池里消失，需重新逐张授权`);
      }
      // 交叉校验：持久化的计数器可能损坏（0/负数），若不抬到已保留照片的最大 batchId，
      // 下一次 mergeBatch 会算出 lastBatchId + 1 而复用仍在使用的 batchId。
      let maxSeen: number = 0;
      for (let i = 0; i < valid.length; i++) {
        if (valid[i].batchId > maxSeen) { maxSeen = valid[i].batchId; }
      }
      // 「存在但非法」才告警：字段缺失按 0 处理是**正常**的兼容路径（不该刷告警），
      // 而"写着一个 -3 / NaN / 字符串"说明写侧写出过坏值 —— 那正是 D1 短写事故的指纹之一。
      const rawLastValid: boolean = typeof parsed.lastBatchId === 'number'
        && Number.isFinite(parsed.lastBatchId) && parsed.lastBatchId >= 0;
      if (!rawLastValid && parsed.lastBatchId !== undefined) {
        hilog.warn(DOMAIN, TAG, '%{public}s',
          `认领文件的 lastBatchId 非法（实际 ${JSON.stringify(parsed.lastBatchId)}），` +
          `已抬到已保留照片的最大 batchId ${maxSeen}，避免复用仍在使用的批次号`);
      }
      const rawLast: number = rawLastValid ? parsed.lastBatchId : 0;
      const lastBatchId: number = Math.max(Math.max(0, rawLast), maxSeen);
      return { photos: valid, lastBatchId: lastBatchId };
    } catch (e) {
      // 必须带 e：这一支的四种成因（JSON 语法错、编码错、短读越界、fileIo 报错）在日志里
      // 长得一模一样，只有 e.message 能分开 —— 而它正是"239 张已授权照片为什么全没了"的答案。
      // **绝不能**退回成裸 `return emptyClaimState();`：那样这条最坏路径在真机上完全不可见，
      // 用户只会看到首页"还没有可刷的照片"，并被迫重新逐张点选。
      hilog.warn(DOMAIN, TAG, '%{public}s',
        `认领文件存在但读取/解析失败，已按空状态处理（照片池会显示为空，需重新逐张授权）: ${errText(e)}`);
      return emptyClaimState();
    }
  }

  /**
   * 原子落盘：写 `.tmp` → **校验短写（按 UTF-8 字节数）** → 字节数完全相等才 rename 覆盖真身。
   * 实现见 core/atomicText.ts（纯逻辑）+ data/atomicWrite.ets（平台适配），本方法只是接线。
   *
   * 旧形态（本批修掉的 D1）是**直接对本文件 TRUNC 打开、丢弃 writeSync 的返回值**：
   * 一次短写就地把这份文件换成截断的坏文件，**真身没有任何回退余地** ——
   * 下次 load() 的 JSON.parse 抛错 →（旧代码）静默退空 → `photos: []` →
   * 首页显示"还没有可刷的照片" → 用户逐张授权来的几百个 URI 全部消失且不可恢复。
   *
   * 这里**保持"失败往上抛"的原契约**（本方法在本批之前就没有 try/catch：openSync 失败会
   * 直接抛给调用方）。唯一的调用点 ClaimPage.restock 把它包在 try/catch 里并显示消息给用户，
   * 所以抛错 = 用户看得见；而静默吞掉 = 用户以为认领成功了。
   */
  save(s: ClaimState): void {
    writeTextAtomic(claimStorePath(this.ctx.filesDir), JSON.stringify(s), '认领列表');
  }

  addBatch(uris: string[], now: number): ClaimState {
    const next = mergeBatch(this.load(), uris, now);
    this.save(next);
    return next;
  }

  count(): number {
    return this.load().photos.length;
  }
}
