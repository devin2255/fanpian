import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleSession, isSessionDone, currentPhotoId, advance,
  DEFAULT_SESSION_SIZE, SESSION_SIZE_CHOICES
} from './session.ts';

// 造 id 数组的小工具（测试里不写魔法长数组）
const ids = (prefix: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(`${prefix}${i}`); }
  return out;
};

const sorted = (a: string[]): string[] => a.slice().sort();

// ── 1. 确定性 ────────────────────────────────────────────────────────────────

test('同一入参 + 同种子两次抽样结果完全相同（默认 100 张，选项 20/50/100/200）', () => {
  const pool = ids('p', 200);
  const seen = ids('p', 50);            // 前 50 张历史会话里见过
  const a = sampleSession(pool, DEFAULT_SESSION_SIZE, seen, 20261008);
  const b = sampleSession(pool, DEFAULT_SESSION_SIZE, seen, 20261008);
  assert.deepEqual(a, b, '同种子必须给出同一队列，否则测试不可复现');
  assert.notEqual(a, b, '两次调用必须各自独立，不能返回同一个对象');
  assert.notEqual(a.queue, b.queue, '不能共享 queue 数组');
  assert.equal(a.queue.length, 100);
  // 产品口径：默认 100，可选 20/50/100/200（默认值必须是选项之一）
  assert.equal(DEFAULT_SESSION_SIZE, 100);
  assert.deepEqual(SESSION_SIZE_CHOICES, [20, 50, 100, 200]);
  assert.ok(SESSION_SIZE_CHOICES.indexOf(DEFAULT_SESSION_SIZE) >= 0);
});

// ── 2. 放回语义：已决策照片仍在抽中范围内 ──────────────────────────────────────

test('放回抽样：全池照片都已决策（已归档/已收藏/已上墙）时仍会被再次抽中', () => {
  // 产品原话要的就是这个：上一会话归档/收藏过的照片，本会话还能被抽中再次出现。
  const pool = ['archived-1', 'archived-2', 'faved-1', 'walled-1', 'archived-3'];
  const seen = pool.slice();            // 全部在历史会话里展示过（且已被决策）
  const all = sampleSession(pool, 5, seen, 7);
  assert.equal(all.queue.length, 5, '已决策照片不得被排除出抽样范围');
  assert.deepEqual(sorted(all.queue), sorted(pool));
  const some = sampleSession(pool, 2, seen, 7);
  assert.equal(some.queue.length, 2, '池子有货就必须抽满，不得因为"都见过"而返回空会话');
});

// ── 3. 同一会话内不重复 ─────────────────────────────────────────────────────

test('同一会话内不重复（size <= pool.length）', () => {
  const pool = ids('p', 30);
  const s = sampleSession(pool, 30, [], 42);
  assert.equal(s.queue.length, 30);
  assert.equal(new Set(s.queue).size, 30, '同一张照片在一次会话里只能出现一次');
  assert.deepEqual(sorted(s.queue), sorted(pool), '队列内容必须是池子的一个排列');
});

// ── 4/5. 优先级：未见过的优先 ────────────────────────────────────────────────

test('未见过的照片优先：池 10 张、其中 3 张未见过、抽 3 张 → 恰好是那 3 张', () => {
  const fresh = ['new-1', 'new-2', 'new-3'];
  const known = ids('old', 7);
  const pool = known.concat(fresh);
  const s = sampleSession(pool, 3, known, 12345);
  assert.deepEqual(sorted(s.queue), ['new-1', 'new-2', 'new-3']);
});

test('未见过的照片优先：新照片排满后才用已见过的补足，且补足的排在新照片之后', () => {
  const fresh = ['new-1', 'new-2', 'new-3'];
  const known = ids('old', 7);
  const pool = known.concat(fresh);
  const s = sampleSession(pool, 5, known, 999);
  assert.equal(s.queue.length, 5);
  assert.deepEqual(sorted(s.queue.slice(0, 3)), ['new-1', 'new-2', 'new-3'],
    '队首 3 张必须全是未见过的');
  const tail = s.queue.slice(3);
  for (let i = 0; i < tail.length; i++) {
    assert.ok(known.indexOf(tail[i]) >= 0, '补足位只能来自已见过的照片');
  }
  assert.equal(new Set(s.queue).size, 5, '补足后仍不得重复');
});

// ── 5'. 抽不满 ──────────────────────────────────────────────────────────────

test('size > pool.length 时抽全部（队列长度 = 去重后的池子大小）', () => {
  const pool = ['a', 'b', 'c'];
  const s = sampleSession(pool, 100, [], 5);
  assert.equal(s.queue.length, 3);
  assert.deepEqual(sorted(s.queue), ['a', 'b', 'c']);
  assert.equal(s.size, 100, 'size 保留请求值（实际张数以 queue.length 为准）');
  assert.equal(s.cursor, 0);
});

// ── 6. 边界 ─────────────────────────────────────────────────────────────────

test('size <= 0（含 NaN）返回空会话', () => {
  assert.deepEqual(sampleSession(['a', 'b'], 0, [], 1), { size: 0, queue: [], cursor: 0 });
  assert.deepEqual(sampleSession(['a', 'b'], -5, [], 1), { size: 0, queue: [], cursor: 0 });
  assert.deepEqual(sampleSession(['a', 'b'], NaN, [], 1), { size: 0, queue: [], cursor: 0 });
});

test('pool 为空时返回空队列并保留请求的 size（便于 UI 显示"池子空了"）', () => {
  const s = sampleSession([], 100, ['a'], 1);
  assert.equal(s.size, 100);
  assert.deepEqual(s.queue, []);
  assert.equal(s.cursor, 0);
  assert.equal(isSessionDone(s), true);
  assert.equal(currentPhotoId(s), '');
});

test('pool 内有重复 photoId 时先去重再抽（不把重复当两张）', () => {
  const pool = ['a', 'b', 'a', 'c', 'b', 'a'];
  const s = sampleSession(pool, 10, [], 3);
  assert.equal(s.queue.length, 3, '去重后池子只有 3 张');
  assert.deepEqual(sorted(s.queue), ['a', 'b', 'c']);
  const exact = sampleSession(pool, 3, [], 3);
  assert.equal(new Set(exact.queue).size, 3);
  assert.deepEqual(sorted(exact.queue), ['a', 'b', 'c']);
});

// ── 7. advance / currentPhotoId / isSessionDone ──────────────────────────────

test('按队列顺序前进，刷完前 isSessionDone 一直为 false', () => {
  const s0 = sampleSession(['a', 'b', 'c'], 3, [], 77);
  assert.equal(s0.cursor, 0);
  assert.equal(isSessionDone(s0), false);
  assert.equal(currentPhotoId(s0), s0.queue[0]);
  const s1 = advance(s0);
  assert.equal(s1.cursor, 1);
  assert.equal(currentPhotoId(s1), s0.queue[1]);
  assert.equal(isSessionDone(s1), false);
  const s2 = advance(s1);
  assert.equal(currentPhotoId(s2), s0.queue[2]);
  assert.equal(isSessionDone(s2), false, '刷最后一张时还没刷完');
  const s3 = advance(s2);
  assert.equal(s3.cursor, 3);
  assert.equal(isSessionDone(s3), true);
});

test('刷完后 currentPhotoId 返回空串', () => {
  let s = sampleSession(['a'], 1, [], 9);
  s = advance(s);
  assert.equal(isSessionDone(s), true);
  assert.equal(currentPhotoId(s), '', '刷完后没有"当前这张"');
});

test('刷完后再 advance 幂等（内容原样，但仍返回新对象）', () => {
  let s = sampleSession(['a', 'b'], 2, [], 11);
  s = advance(advance(s));
  assert.equal(isSessionDone(s), true);
  const again = advance(s);
  assert.deepEqual(again, s, '幂等：内容不得变化');
  assert.notEqual(again, s, '仍须返回新对象，不原地改');
  const third = advance(again);
  assert.deepEqual(third, again);
});

// ── 8. 不改入参 / 不共享数组 ─────────────────────────────────────────────────

test('不改入参与原状态：pool/seenIds 原样，advance 返回的新会话不共享 queue', () => {
  const pool = ['a', 'b', 'c', 'a'];
  const seen = ['a'];
  const poolCopy = pool.slice();
  const seenCopy = seen.slice();
  const s = sampleSession(pool, 2, seen, 42);
  assert.deepEqual(pool, poolCopy, 'pool 被原地改了');
  assert.deepEqual(seen, seenCopy, 'seenIds 被原地改了');

  const q = s.queue.slice();
  const n = advance(s);
  assert.equal(s.cursor, 0, 'advance 不得改动原会话');
  assert.deepEqual(s.queue, q, 'advance 不得改动原会话的队列');
  n.queue.push('zzz');
  assert.equal(s.queue.length, q.length, 'advance 返回的会话与原会话共享了 queue 数组');
});
