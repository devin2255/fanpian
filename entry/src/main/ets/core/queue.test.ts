import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDecision, applyDecision, buildQueue, DEFER_PROMOTE_AT, MAX_MEMORY_INJECT }
  from './queue.ts';
import type { Decision } from './queue.ts';

test('初始状态 unseen，deferCount 0', () => {
  const d = emptyDecision('p1');
  assert.equal(d.state, 'unseen');
  assert.equal(d.deferCount, 0);
});

test('右滑收藏 → faved', () => {
  const d = applyDecision(emptyDecision('p1'), 'fav', 100);
  assert.equal(d.state, 'faved');
  assert.equal(d.decidedAt, 100);
});

test('左滑归档 → archived（不是删除）', () => {
  assert.equal(applyDecision(emptyDecision('p1'), 'archive', 1).state, 'archived');
});

test('上墙 → walled', () => {
  assert.equal(applyDecision(emptyDecision('p1'), 'wall', 1).state, 'walled');
});

test('跳过 → 回到 unseen 且 deferCount +1', () => {
  const d = applyDecision(emptyDecision('p1'), 'skip', 1);
  assert.equal(d.state, 'unseen');
  assert.equal(d.deferCount, 1);
});

test('取消收藏 → 回到 unseen，deferCount 不变', () => {
  const faved = applyDecision(emptyDecision('p1'), 'fav', 1);
  const out = applyDecision(faved, 'unfav', 2);
  assert.equal(out.state, 'unseen');
  assert.equal(out.deferCount, 0);
});

test('摘墙 → 回到 faved（不是 unseen）', () => {
  const walled = applyDecision(emptyDecision('p1'), 'wall', 1);
  assert.equal(applyDecision(walled, 'unwall', 2).state, 'faved');
});

test('队列按拍摄时间倒序，已决策的不出现', () => {
  const all = [
    { photoId: 'old', takenAt: 100 },
    { photoId: 'new', takenAt: 300 },
    { photoId: 'mid', takenAt: 200 }
  ];
  const decisions = new Map<string, Decision>();
  decisions.set('mid', applyDecision(emptyDecision('mid'), 'archive', 1));
  const q = buildQueue(all, decisions, []);
  assert.deepEqual(q.map((x) => x.photoId), ['new', 'old']);
});

test('跳过 3 次以上的前插到队首之后、其余 pending 之前', () => {
  const all = [
    { photoId: 'a', takenAt: 100 },
    { photoId: 'b', takenAt: 300 },
    { photoId: 'c', takenAt: 200 },
    { photoId: 'd', takenAt: 150 }
  ];
  const decisions = new Map<string, Decision>();
  let a = emptyDecision('a');
  for (let i = 0; i < DEFER_PROMOTE_AT; i++) { a = applyDecision(a, 'skip', i); }
  decisions.set('a', a);
  let d = emptyDecision('d');
  for (let i = 0; i < DEFER_PROMOTE_AT; i++) { d = applyDecision(d, 'skip', i); }
  decisions.set('d', d);
  const q = buildQueue(all, decisions, []);
  // Ruling 4：pending 最新一张（b）在最前，被提升的按拍摄时间倒序紧跟其后（d=150, a=100），其余 pending 最后（c）。
  assert.deepEqual(q.map((x) => x.photoId), ['b', 'd', 'a', 'c']);
});

test('今日回忆插在队首之后，且不超过上限', () => {
  const all = [{ photoId: 'a', takenAt: 300 }];
  const mem = [{ photoId: 'm1', takenAt: 1 }, { photoId: 'm2', takenAt: 2 }];
  const q = buildQueue(all, new Map<string, Decision>(), mem);
  assert.equal(q.length, 3);
  assert.equal(q[0].photoId, 'a');
  assert.ok(q.some((x) => x.photoId === 'm1'));
});

test('今日回忆注入有上限（MAX_MEMORY_INJECT）', () => {
  const all = [{ photoId: 'a', takenAt: 300 }];
  const mem = [
    { photoId: 'm1', takenAt: 1 },
    { photoId: 'm2', takenAt: 2 },
    { photoId: 'm3', takenAt: 3 }
  ];
  const q = buildQueue(all, new Map<string, Decision>(), mem);
  assert.equal(q.length, 1 + MAX_MEMORY_INJECT);
  assert.deepEqual(q.map((x) => x.photoId), ['a', 'm1', 'm2']);
});
