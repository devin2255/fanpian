import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { ClaimState, ClaimedPhoto, emptyClaimState, mergeBatch } from '../core/claim';
import { fileIo } from '@kit.CoreFileKit';

export function claimStorePath(filesDir: string): string {
  return `${filesDir}/claimed_photos.json`;
}

export async function pickPhotos(): Promise<string[]> {
  const picker = new photoAccessHelper.PhotoViewPicker();
  const opt: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  opt.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  opt.maxSelectNumber = 500;
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
      try {
        fileIo.readSync(file.fd, buf);
      } finally {
        fileIo.closeSync(file);
      }
      const bytes = new Uint8Array(buf);
      let text = '';
      for (let i = 0; i < bytes.length; i++) { text += String.fromCharCode(bytes[i]); }
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
      const lastBatchId = typeof parsed.lastBatchId === 'number' && Number.isFinite(parsed.lastBatchId)
        ? parsed.lastBatchId : 0;
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
