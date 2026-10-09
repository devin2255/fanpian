import { common } from '@kit.AbilityKit';
import { buffer } from '@kit.ArkTS';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { ClaimState, ClaimedPhoto, emptyClaimState, mergeBatch, claimStorePath } from '../core/claim';
import { fileIo } from '@kit.CoreFileKit';

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

  load(): ClaimState {
    try {
      const path = claimStorePath(this.ctx.filesDir);
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
        return emptyClaimState();
      }
      const valid: ClaimedPhoto[] = [];
      for (let i = 0; i < parsed.photos.length; i++) {
        const p = parsed.photos[i];
        if (p === null || p === undefined) { continue; }
        if (typeof p.photoId !== 'string' || p.photoId === '') { continue; }
        valid.push({
          photoId: p.photoId,
          batchId: typeof p.batchId === 'number' && Number.isFinite(p.batchId) ? p.batchId : 0,
          claimedAt: typeof p.claimedAt === 'number' && Number.isFinite(p.claimedAt) ? p.claimedAt : 0,
          takenAt: typeof p.takenAt === 'number' && Number.isFinite(p.takenAt) ? p.takenAt : 0
        });
      }
      // 交叉校验：持久化的计数器可能损坏（0/负数），若不抬到已保留照片的最大 batchId，
      // 下一次 mergeBatch 会算出 lastBatchId + 1 而复用仍在使用的 batchId。
      let maxSeen: number = 0;
      for (let i = 0; i < valid.length; i++) {
        if (valid[i].batchId > maxSeen) { maxSeen = valid[i].batchId; }
      }
      const rawLast: number = typeof parsed.lastBatchId === 'number' && Number.isFinite(parsed.lastBatchId)
        ? parsed.lastBatchId : 0;
      const lastBatchId: number = Math.max(Math.max(0, rawLast), maxSeen);
      return { photos: valid, lastBatchId: lastBatchId };
    } catch (e) {
      return emptyClaimState();
    }
  }

  save(s: ClaimState): void {
    const file = fileIo.openSync(claimStorePath(this.ctx.filesDir),
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(s));
    } finally {
      fileIo.closeSync(file);
    }
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
