// 注意：本文件是纯逻辑，禁止 import @kit.*（否则 Node 无法加载，单测跑不起来）
export interface ClaimedPhoto {
  photoId: string;
  batchId: number;
  claimedAt: number;
  takenAt: number;   // EXIF 拍摄时间，认领时为 0，Task 9 回填
}

export interface ClaimState {
  photos: ClaimedPhoto[];
  lastBatchId: number;
}

export function emptyClaimState(): ClaimState {
  return { photos: [], lastBatchId: 0 };
}

export function mergeBatch(state: ClaimState, uris: string[], now: number): ClaimState {
  const batchId = state.lastBatchId + 1;
  const seen: Set<string> = new Set();
  for (let i = 0; i < state.photos.length; i++) {
    seen.add(state.photos[i].photoId);
  }
  const photos: ClaimedPhoto[] = state.photos.slice();
  for (let i = 0; i < uris.length; i++) {
    const u = uris[i];
    if (u === '' || seen.has(u)) { continue; }
    seen.add(u);
    photos.push({ photoId: u, batchId: batchId, claimedAt: now, takenAt: 0 });
  }
  return { photos: photos, lastBatchId: batchId };
}

export function claimStorePath(filesDir: string): string {
  return `${filesDir}/claimed_photos.json`;
}

/** takenAt 为 0（未读 EXIF）的排到最后 */
export function sortByTakenDesc(photos: ClaimedPhoto[]): ClaimedPhoto[] {
  const withTime = photos.filter((p: ClaimedPhoto) => p.takenAt > 0);
  const noTime = photos.filter((p: ClaimedPhoto) => p.takenAt <= 0);
  withTime.sort((a: ClaimedPhoto, b: ClaimedPhoto) => b.takenAt - a.takenAt);
  return withTime.concat(noTime);
}
