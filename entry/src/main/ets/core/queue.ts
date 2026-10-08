// 刷照片的决策状态机与队列（spec §5.1 / §8）。
// 四个状态对应四种手势；三个刻意的取舍：
//   1. 左滑是「归档」不是删除——防误删的犹豫会毁掉滑动的手感；
//   2. 下滑「跳过」必须重新入队（unseen + deferCount+1），让「我不确定」成为合法答案；
//   3. 跳过 DEFER_PROMOTE_AT 次的照片插到队前——「这张你躲了三次了，今天给个说法」。
//   4. 摘墙回到 faved 而不是 unseen——从墙上取下来它还是你的收藏，不该重新问一遍。
export type DecisionState = 'unseen' | 'archived' | 'faved' | 'walled';

export type Action = 'archive' | 'fav' | 'wall' | 'unfav' | 'unwall' | 'skip';

export interface Decision {
  photoId: string;
  state: DecisionState;
  decidedAt: number;
  deferCount: number;
}

export interface QueueInput { photoId: string; takenAt: number }

export const DEFER_PROMOTE_AT = 3;
export const MAX_MEMORY_INJECT = 2;

export function emptyDecision(photoId: string): Decision {
  return { photoId: photoId, state: 'unseen', decidedAt: 0, deferCount: 0 };
}

export function applyDecision(d: Decision, action: Action, now: number): Decision {
  if (action === 'archive') {
    return { photoId: d.photoId, state: 'archived', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'fav') {
    return { photoId: d.photoId, state: 'faved', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'wall') {
    return { photoId: d.photoId, state: 'walled', decidedAt: now, deferCount: d.deferCount };
  }
  if (action === 'unfav' || action === 'unwall') {
    const back: DecisionState = action === 'unwall' ? 'faved' : 'unseen';
    return { photoId: d.photoId, state: back, decidedAt: now, deferCount: d.deferCount };
  }
  // skip：重新入队
  return { photoId: d.photoId, state: 'unseen', decidedAt: now, deferCount: d.deferCount + 1 };
}

// 顺序：pending 最新一张 → 被提升的（跳过多次的）→ 今日回忆（最多 MAX_MEMORY_INJECT 张）→ 其余 pending。
export function buildQueue(
  all: QueueInput[], decisions: Map<string, Decision>, todayMemories: QueueInput[]
): QueueInput[] {
  const pending: QueueInput[] = [];
  const promoted: QueueInput[] = [];

  for (let i = 0; i < all.length; i++) {
    const item = all[i];
    const d = decisions.get(item.photoId);
    if (d === undefined) {
      pending.push(item);
      continue;
    }
    if (d.state !== 'unseen') { continue; }
    if (d.deferCount >= DEFER_PROMOTE_AT) { promoted.push(item); } else { pending.push(item); }
  }

  pending.sort((a: QueueInput, b: QueueInput) => b.takenAt - a.takenAt);
  promoted.sort((a: QueueInput, b: QueueInput) => b.takenAt - a.takenAt);

  const out: QueueInput[] = [];
  const head = pending.length > 0 ? [pending[0]] : [];
  for (let i = 0; i < head.length; i++) { out.push(head[i]); }
  for (let i = 0; i < promoted.length; i++) { out.push(promoted[i]); }
  const memN = Math.min(todayMemories.length, MAX_MEMORY_INJECT);
  for (let i = 0; i < memN; i++) { out.push(todayMemories[i]); }
  for (let i = 1; i < pending.length; i++) { out.push(pending[i]); }
  return out;
}
